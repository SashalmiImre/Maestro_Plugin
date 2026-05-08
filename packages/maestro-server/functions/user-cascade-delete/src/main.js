const sdk = require('node-appwrite');

/**
 * Appwrite Function: User Cascade Delete (Phase 1)
 *
 * Trigger: `users.*.delete` event — amikor egy user törlődik az Appwrite-ban
 * (akár admin-dashboard-ról, akár API-n keresztül), automatikusan kitakarítjuk
 * a denormalizált membership rekordokat ÉS az Appwrite Team-membership-eket.
 *
 * **Háttér** (iteration-guardian hardening review 2026-05-09 + Codex tanácsadás):
 * - Az Appwrite admin user-delete NEM cascade-eli a saját `organizationMemberships`
 *   / `editorialOfficeMemberships` / `groupMemberships` táblákat → orphan rekordok
 * - Az Appwrite Team membership-ek (ADR 0003 tenant-scope) sincs garantálva, hogy
 *   automatikusan kaszkádolódnak — explicit cleanup szükséges, különben Realtime
 *   leak / ACL inkonzisztencia
 * - A user az org egyetlen owner-je lehet → cascade után az org owner nélkül marad;
 *   utólag már nem tudjuk megakadályozni (post-delete event), de **logoljuk**
 *   prominensen, hogy admin figyelmébe jusson
 *
 * **Phase 1 scope (ez a CF)**:
 * 1. Membership cleanup: `organizationMemberships`, `editorialOfficeMemberships`,
 *    `groupMemberships` — minden rekord, ahol `userId === deletedUserId`
 * 2. Team membership cleanup: `org_${orgId}` és `office_${officeId}` team-ekből
 *    a user eltávolítása (ADR 0003 tenant-scope leak-zárás)
 * 3. Last-owner detection: ha a user volt az utolsó owner valamelyik orgban,
 *    `error()` log-szinten figyelmeztet (admin attention; az org status='orphaned'
 *    schema-bővítés külön Phase 1.5 commit)
 *
 * **Phase 2 scope (NEM ez a CF)**:
 * - `organizationInviteHistory` audit-trail collection (acceptInvite snapshot before delete)
 * - Backstop orphan-sweeper cron (race-condition handler post-event)
 *
 * **Best-effort semantika**: per-collection / per-team try/catch, statisztikát
 * loggolunk. Hibák nem propagálnak a többi cleanup-ágra.
 *
 * Trigger: `users.*.delete`
 * Runtime: Node.js 18.0+
 *
 * Szükséges env varok:
 * - DATABASE_ID
 * - ORGANIZATION_MEMBERSHIPS_COLLECTION_ID
 * - EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID
 * - GROUP_MEMBERSHIPS_COLLECTION_ID
 * - APPWRITE_API_KEY (a function execution dynamic key fallback-jal)
 */

const BATCH_LIMIT = 100;

// ── Team ID builders (duplikált a teamHelpers.js-ből; Appwrite CF-enként
// külön node_modules van, shared modul-importot itt nem támogat) ─────────
function buildOrgTeamId(organizationId) { return `org_${organizationId}`; }
function buildOfficeTeamId(officeId) { return `office_${officeId}`; }

// ── Helper: lapozott listDocuments ──────────────────────────────────────
async function listAllDocuments(databases, databaseId, collectionId, userId) {
    const all = [];
    let cursor = null;
    while (true) {
        const queries = [
            sdk.Query.equal('userId', userId),
            sdk.Query.limit(BATCH_LIMIT)
        ];
        if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
        const result = await databases.listDocuments(databaseId, collectionId, queries);
        all.push(...result.documents);
        if (result.documents.length < BATCH_LIMIT) break;
        cursor = result.documents[result.documents.length - 1].$id;
    }
    return all;
}

async function deleteDocs(databases, databaseId, collectionId, docs, log, error) {
    let deleted = 0;
    let failed = 0;
    for (const doc of docs) {
        try {
            await databases.deleteDocument(databaseId, collectionId, doc.$id);
            deleted++;
        } catch (err) {
            failed++;
            error(`[UserCascade] ${collectionId}/${doc.$id} delete bukott: ${err.message}`);
        }
    }
    return { found: docs.length, deleted, failed };
}

async function removeUserFromTeam(teams, teamId, userId, log, error) {
    let memberships;
    try {
        memberships = await teams.listMemberships(teamId, [
            sdk.Query.equal('userId', userId),
            sdk.Query.limit(10)
        ]);
    } catch (err) {
        if (err?.code === 404) return { found: 0, deleted: 0, failed: 0, skipped: 'team_not_found' };
        error(`[UserCascade] team ${teamId} listMemberships bukott: ${err.message}`);
        return { found: 0, deleted: 0, failed: 1, error: err.message };
    }

    const list = memberships?.memberships || [];
    if (list.length === 0) return { found: 0, deleted: 0, failed: 0, skipped: 'not_a_member' };

    let deleted = 0;
    let failed = 0;
    for (const m of list) {
        try {
            await teams.deleteMembership(teamId, m.$id);
            deleted++;
        } catch (err) {
            if (err?.code === 404) continue;
            failed++;
            error(`[UserCascade] team ${teamId}/${m.$id} delete bukott: ${err.message}`);
        }
    }
    return { found: list.length, deleted, failed };
}

module.exports = async ({ req, res, log, error }) => {
    const event = req.headers?.['x-appwrite-event'] || '';

    if (!event.startsWith('users.') || !event.endsWith('.delete')) {
        log(`[UserCascade] Skipping non-user-delete event: ${event}`);
        return res.json({ success: true, skipped: true, event });
    }

    const eventParts = event.split('.');
    if (eventParts.length < 3) {
        error(`[UserCascade] Invalid event format: ${event}`);
        return res.json({ success: false, reason: 'invalid_event_format', event }, 400);
    }
    const userId = eventParts[1];
    if (!userId) {
        error(`[UserCascade] Missing userId in event: ${event}`);
        return res.json({ success: false, reason: 'missing_user_id', event }, 400);
    }

    const databaseId = process.env.DATABASE_ID;
    const orgMemsCol = process.env.ORGANIZATION_MEMBERSHIPS_COLLECTION_ID;
    const officeMemsCol = process.env.EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID;
    const groupMemsCol = process.env.GROUP_MEMBERSHIPS_COLLECTION_ID;
    const apiKey = req.headers?.['x-appwrite-key'] || process.env.APPWRITE_API_KEY;

    const missing = [];
    if (!databaseId) missing.push('DATABASE_ID');
    if (!orgMemsCol) missing.push('ORGANIZATION_MEMBERSHIPS_COLLECTION_ID');
    if (!officeMemsCol) missing.push('EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID');
    if (!groupMemsCol) missing.push('GROUP_MEMBERSHIPS_COLLECTION_ID');
    if (!apiKey) missing.push('APPWRITE_API_KEY');
    if (missing.length > 0) {
        error(`[UserCascade] Missing env vars: ${missing.join(', ')}`);
        return res.json({ success: false, reason: 'misconfigured', missing }, 500);
    }

    const client = new sdk.Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://fra.cloud.appwrite.io/v1')
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || req.headers?.['x-appwrite-project'])
        .setKey(apiKey);
    const databases = new sdk.Databases(client);
    const teams = new sdk.Teams(client);

    log(`[UserCascade] Start cascade for userId=${userId}`);

    const stats = {
        userId,
        organizationMemberships: { found: 0, deleted: 0, failed: 0 },
        editorialOfficeMemberships: { found: 0, deleted: 0, failed: 0 },
        groupMemberships: { found: 0, deleted: 0, failed: 0 },
        orgTeams: { processed: 0, deleted: 0, failed: 0 },
        officeTeams: { processed: 0, deleted: 0, failed: 0 },
        lastOwnerOrgs: []
    };

    // ── Pass 1: List (cache org/office IDs + ownership) ─────────────────
    let orgMems = [];
    let officeMems = [];
    let groupMems = [];

    try { orgMems = await listAllDocuments(databases, databaseId, orgMemsCol, userId); }
    catch (err) { error(`[UserCascade] orgMemberships list bukott: ${err.message}`); }

    try { officeMems = await listAllDocuments(databases, databaseId, officeMemsCol, userId); }
    catch (err) { error(`[UserCascade] officeMemberships list bukott: ${err.message}`); }

    try { groupMems = await listAllDocuments(databases, databaseId, groupMemsCol, userId); }
    catch (err) { error(`[UserCascade] groupMemberships list bukott: ${err.message}`); }

    const orgIds = new Set(orgMems.map(m => m.organizationId).filter(Boolean));
    const officeIds = new Set(officeMems.map(m => m.editorialOfficeId).filter(Boolean));
    const ownedOrgIds = orgMems.filter(m => m.role === 'owner').map(m => m.organizationId).filter(Boolean);

    log(`[UserCascade] Pass 1 — userId=${userId}: ${orgMems.length} org, ${officeMems.length} office, ${groupMems.length} group memberships; ${ownedOrgIds.length} owned orgs (${ownedOrgIds.join(', ') || 'none'})`);

    // ── Pass 2: Delete membership docs ──────────────────────────────────
    stats.organizationMemberships = await deleteDocs(databases, databaseId, orgMemsCol, orgMems, log, error);
    stats.editorialOfficeMemberships = await deleteDocs(databases, databaseId, officeMemsCol, officeMems, log, error);
    stats.groupMemberships = await deleteDocs(databases, databaseId, groupMemsCol, groupMems, log, error);

    // ── Pass 3: Team membership cleanup (ADR 0003 tenant scope) ────────
    for (const orgId of orgIds) {
        const teamId = buildOrgTeamId(orgId);
        try {
            const r = await removeUserFromTeam(teams, teamId, userId, log, error);
            stats.orgTeams.processed++;
            stats.orgTeams.deleted += r.deleted || 0;
            stats.orgTeams.failed += r.failed || 0;
        } catch (err) {
            stats.orgTeams.failed++;
            error(`[UserCascade] team ${teamId} cleanup dobott: ${err.message}`);
        }
    }
    for (const officeId of officeIds) {
        const teamId = buildOfficeTeamId(officeId);
        try {
            const r = await removeUserFromTeam(teams, teamId, userId, log, error);
            stats.officeTeams.processed++;
            stats.officeTeams.deleted += r.deleted || 0;
            stats.officeTeams.failed += r.failed || 0;
        } catch (err) {
            stats.officeTeams.failed++;
            error(`[UserCascade] team ${teamId} cleanup dobott: ${err.message}`);
        }
    }

    // ── Pass 4: Last-owner detection ────────────────────────────────────
    // Az `organizationMemberships` már törölve van; megnézzük orgenként,
    // hogy maradt-e legalább 1 owner. Ha nem → admin attention!
    for (const orgId of ownedOrgIds) {
        try {
            const remainingOwners = await databases.listDocuments(databaseId, orgMemsCol, [
                sdk.Query.equal('organizationId', orgId),
                sdk.Query.equal('role', 'owner'),
                sdk.Query.limit(1)
            ]);
            if (remainingOwners.total === 0) {
                stats.lastOwnerOrgs.push(orgId);
                error(`[UserCascade] ⚠️ LAST OWNER törölve — org=${orgId} most owner nélkül maradt (admin figyelmébe!)`);
            }
        } catch (err) {
            error(`[UserCascade] last-owner check dobott (org=${orgId}): ${err.message}`);
        }
    }

    log(`[UserCascade] Done userId=${userId}: ${JSON.stringify(stats)}`);

    return res.json({ success: true, action: 'user_cascade_delete', ...stats });
};
