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

// ── Helper: listDocuments + cascade-delete pattern ──────────────────────
// 2026-05-09 (CF execution log debug): a korábbi cursorAfter-es paginálás
// `request cannot have request body` hibával bukott. A `cascade-delete`
// CF-fel azonos pattern-t alkalmazzuk: listDocuments egy batch-re,
// majd minden iterációnál újra listDocuments (deleted docs eltűnnek a
// következő list eredményből, így természetes lapozást kapunk).
//
// FONTOS: a felhasználói scope-ban ritkán van >100 membership egy típusból,
// ezért egyetlen list-call elég gyakorlatban; a függvény mégis lapozott,
// hogy outlier-eseteket is kezeljen.
async function listAllByUserId(databases, databaseId, collectionId, userId) {
    const result = await databases.listDocuments(
        databaseId,
        collectionId,
        [
            sdk.Query.equal('userId', userId),
            sdk.Query.limit(BATCH_LIMIT)
        ]
    );
    return result.documents;
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

    // 2026-05-09 (CF execution log debug): az endpoint default-ot a working
    // CF-ek mintájára `https://cloud.appwrite.io/v1`-re igazítom (a `fra.`
    // regionális variáns nem támogatja az összes REST route-ot a node-appwrite
    // SDK-számára → "request cannot have request body" hiba).
    const client = new sdk.Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || req.headers?.['x-appwrite-project'])
        .setKey(apiKey);
    const databases = new sdk.Databases(client);
    const teams = new sdk.Teams(client);

    log(`[UserCascade] Start cascade for userId=${userId}`);

    const stats = {
        userId,
        // Codex stop-time #2 (2026-05-09): a Pass 1 list-failure-öket és a
        // Pass 4 verification-failure-öket EXPLICIT követjük. Ha a list
        // bukik, üres tömbbel mennénk tovább, és HTTP 200-zal nyugtáznánk,
        // miközben semmilyen cleanup nem történt — orphan rekordok
        // permanensek maradnak. Ezért a `listFailures` és `verificationFailures`
        // is hozzáadódik a `totalFailed` számhoz a 500-as ágon.
        listFailures: [],
        verificationFailures: [],
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

    try { orgMems = await listAllByUserId(databases, databaseId, orgMemsCol, userId); }
    catch (err) {
        error(`[UserCascade] orgMemberships list bukott: ${err.message}`);
        stats.listFailures.push({ collection: 'organizationMemberships', error: err.message });
    }

    try { officeMems = await listAllByUserId(databases, databaseId, officeMemsCol, userId); }
    catch (err) {
        error(`[UserCascade] officeMemberships list bukott: ${err.message}`);
        stats.listFailures.push({ collection: 'editorialOfficeMemberships', error: err.message });
    }

    try { groupMems = await listAllByUserId(databases, databaseId, groupMemsCol, userId); }
    catch (err) {
        error(`[UserCascade] groupMemberships list bukott: ${err.message}`);
        stats.listFailures.push({ collection: 'groupMemberships', error: err.message });
    }

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
    //
    // Codex stop-time #2 (2026-05-09): a check kivétele NEM cleanup-failure
    // (a delete megtörtént), DE verification-gap — admin nem tudja, hogy
    // az org owner nélkül maradt-e. A `verificationFailures`-be tesszük,
    // és a totalFailed-be is beleszámoljuk → HTTP 500 + admin figyelem.
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
            stats.verificationFailures.push({ check: 'last_owner', organizationId: orgId, error: err.message });
        }
    }

    // Codex stop-time review (2026-05-09): a partial failure-öket NEM
    // szabad `success: true`-val visszaadni — különben az Appwrite execution
    // log szerint minden OK, miközben orphan rekord maradt. Az admin a 5xx
    // status-t látja a function executions list-en, és tud reagálni
    // (manual MCP cleanup vagy a Phase 2 backstop orphan-sweeper cron).
    //
    // Codex stop-time #2 (2026-05-09): a `listFailures` (Pass 1) és
    // `verificationFailures` (Pass 4) is hozzáadódik a totalFailed-hez —
    // mert egy bukott listázás cleanup-bypass-t jelent (orphan permanens
    // marad, üres tömbből 0 delete = nem cleanup), egy bukott verifikáció
    // pedig admin-attention-igénylő gap (org owner nélkül maradhatott).
    const totalFailed =
        (stats.organizationMemberships.failed || 0) +
        (stats.editorialOfficeMemberships.failed || 0) +
        (stats.groupMemberships.failed || 0) +
        (stats.orgTeams.failed || 0) +
        (stats.officeTeams.failed || 0) +
        stats.listFailures.length +
        stats.verificationFailures.length;

    if (totalFailed > 0) {
        error(`[UserCascade] PARTIAL FAILURE — userId=${userId}, totalFailed=${totalFailed}, stats=${JSON.stringify(stats)}`);
        return res.json(
            { success: false, action: 'user_cascade_delete', partial: true, totalFailed, ...stats },
            500
        );
    }

    log(`[UserCascade] Done userId=${userId}: ${JSON.stringify(stats)}`);

    return res.json({ success: true, action: 'user_cascade_delete', ...stats });
};
