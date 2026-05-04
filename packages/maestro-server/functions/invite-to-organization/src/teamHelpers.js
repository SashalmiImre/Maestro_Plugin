/**
 * Tenant scope Appwrite Teams helperek — Feladat #60 (2026-04-19).
 *
 * Célja: a `groups`, `groupMemberships`, `organizationInvites` collection
 * dokumentumait per-tenant Team ACL-lel védeni, hogy a raw WS Realtime
 * payload ne szivárogjon át más szervezet/szerkesztőség kliensére.
 *
 * Team ID konvenciók:
 * - `org_${organizationId}`    — minden szervezethez 1 team, tagjai az
 *                                 `organizationMemberships` collection alapján.
 * - `office_${editorialOfficeId}` — minden szerkesztőséghez 1 team, tagjai az
 *                                    `editorialOfficeMemberships` alapján.
 *
 * ACL tag-ek a dokumentumokon:
 * - `groups` / `groupMemberships`   → `read("team:office_${officeId}")`
 * - `organizationInvites`           → `read("team:org_${orgId}")`
 *
 * Minden művelet idempotens (a CF best-effort rollback-el kompatibilis).
 */

const sdk = require('node-appwrite');

// ── Team ID builders ────────────────────────────────────────────────────────

function buildOrgTeamId(organizationId) {
    return `org_${organizationId}`;
}

function buildOfficeTeamId(editorialOfficeId) {
    return `office_${editorialOfficeId}`;
}

// ── ACL permissions builders ────────────────────────────────────────────────

/**
 * Szervezeti scope-ú dokumentumok ACL-je (pl. `organizationInvites`).
 * Írás-joga továbbra is kizárólag az API key-vel rendelkező CF-eké marad
 * (collection-szintű ACL), itt csak a Realtime push + REST olvasási hozzáférést
 * szűkítjük a team tagjaira.
 */
function buildOrgAclPerms(organizationId) {
    return [sdk.Permission.read(sdk.Role.team(buildOrgTeamId(organizationId)))];
}

/**
 * Szerkesztőségi scope-ú dokumentumok ACL-je (pl. `groups`, `groupMemberships`).
 */
function buildOfficeAclPerms(editorialOfficeId) {
    return [sdk.Permission.read(sdk.Role.team(buildOfficeTeamId(editorialOfficeId)))];
}

/**
 * 3-way visibility scope-pal védett dokumentum ACL — közös helper a
 * workflow-k és workflow extension-ök számára (Feladat #80, ADR 0006/0007).
 *
 * - `editorial_office` → `read("team:office_${officeId}")`
 * - `organization`     → `read("team:org_${orgId}")`
 * - `public`           → `read("users")` (minden authentikált felhasználó)
 *
 * Az írás-joga minden scope-on a CF API key-jé (collection-szintű ACL).
 * A tulajdonos-ellenőrzést a CF action-ök végzik (`createdBy === callerId`),
 * nem ACL-alapon — különben a duplikáló/archiváló CF flow-k nem működnének
 * (az API key felülírja a per-user write ACL-t, de a read szűrő aktív marad
 * a kliens SDK + Realtime push oldalon).
 *
 * `rowSecurity: true` kötelező az érintett collection-ön (workflows ÉS
 * workflowExtensions), különben a collection-szintű `read("users")`
 * felülírja a doc-szintű ACL-t (lásd Fázis 2 Team ACL deploy checklist,
 * 60. feladat).
 *
 * Belső helper — a publikus wrapper-ek (`buildWorkflowAclPerms` /
 * `buildExtensionAclPerms`) hardcode-olják a `who` címet, hogy a hibaüzenet
 * stack trace-ben látsszon, melyik public API-ról propagált. NEM exportálva
 * (YAGNI — egyetlen ad-hoc hívóhely sincs a wrapper-eken kívül).
 *
 * @param {string} who - debug-cím a hibaüzenethez (csak belső használatra)
 * @param {string} visibility - 'editorial_office' | 'organization' | 'public'
 * @param {string} organizationId
 * @param {string} editorialOfficeId
 * @returns {string[]} Appwrite permission string-ek
 */
function buildVisibilityAclPerms(who, visibility, organizationId, editorialOfficeId) {
    if (visibility === 'public') {
        return [sdk.Permission.read(sdk.Role.users())];
    }
    if (visibility === 'organization') {
        if (!organizationId) {
            throw new Error(`${who}: organizationId required for organization visibility`);
        }
        return [sdk.Permission.read(sdk.Role.team(buildOrgTeamId(organizationId)))];
    }
    // editorial_office (default) vagy ismeretlen legacy érték
    if (!editorialOfficeId) {
        throw new Error(`${who}: editorialOfficeId required for editorial_office visibility`);
    }
    return [sdk.Permission.read(sdk.Role.team(buildOfficeTeamId(editorialOfficeId)))];
}

/**
 * Workflow dokumentum ACL — Feladat #80 (2026-04-20). A
 * `buildVisibilityAclPerms` thin wrapper-je, a hibaüzenetekben
 * `buildWorkflowAclPerms` cím marad.
 */
function buildWorkflowAclPerms(visibility, organizationId, editorialOfficeId) {
    return buildVisibilityAclPerms('buildWorkflowAclPerms', visibility, organizationId, editorialOfficeId);
}

/**
 * Workflow extension dokumentum ACL — B.1.2 (ADR 0007 Phase 0). A
 * `buildVisibilityAclPerms` thin wrapper-je. A workflow-kkal IDENTIKUS
 * 3-way scope szemantika; külön helper a hívóhelyi olvashatóság miatt
 * (`actions/extensions.js` ezt fogja használni a B.3 CRUD action-ökben).
 */
function buildExtensionAclPerms(visibility, organizationId, editorialOfficeId) {
    return buildVisibilityAclPerms('buildExtensionAclPerms', visibility, organizationId, editorialOfficeId);
}

// ── Idempotens Team műveletek ───────────────────────────────────────────────

/**
 * Idempotens team create. Ha már létezik (409), skip.
 *
 * @param {sdk.Teams} teams - initialized Teams SDK client.
 * @param {string} teamId - custom team ID (pl. `org_abc123`).
 * @param {string} teamName - human-readable name (nem kell egyedi).
 * @returns {Promise<{created: boolean}>}
 */
async function ensureTeam(teams, teamId, teamName) {
    try {
        await teams.create(teamId, teamName);
        return { created: true };
    } catch (err) {
        if (err?.code === 409 || err?.type === 'team_already_exists') {
            return { created: false };
        }
        throw err;
    }
}

/**
 * Idempotens team membership create. Direkt userId-vel adja hozzá a usert
 * (nem magic URL invite flow) — a `email` paraméter nincs kitöltve, ezért
 * Appwrite nem küld invitáló emailt.
 *
 * Ha a team nem létezik (404) vagy a user már tag (409), skip-el.
 *
 * @param {sdk.Teams} teams - initialized Teams SDK client.
 * @param {string} teamId - meglévő team custom ID.
 * @param {string} userId - user `$id` (meglévő Auth user).
 * @param {string[]} roles - team szerepkörök (alap: `['member']`).
 * @returns {Promise<{added: boolean, skipped?: string}>}
 */
async function ensureTeamMembership(teams, teamId, userId, roles = ['member']) {
    try {
        await teams.createMembership(
            teamId,
            roles,
            undefined,  // email
            userId,     // userId — direkt add
            undefined,  // phone
            undefined,  // url (email magic link — nem releváns)
            undefined   // name
        );
        return { added: true };
    } catch (err) {
        if (err?.code === 409) return { added: false, skipped: 'already_member' };
        if (err?.code === 404) return { added: false, skipped: 'team_not_found' };
        throw err;
    }
}

/**
 * Idempotens team törlés. Ha nem létezik (404), skip. Appwrite a team-mel
 * együtt törli az összes tagsági rekordot is.
 *
 * @param {sdk.Teams} teams - initialized Teams SDK client.
 * @param {string} teamId - custom team ID.
 * @returns {Promise<{deleted: boolean}>}
 */
async function deleteTeamIfExists(teams, teamId) {
    try {
        await teams.delete(teamId);
        return { deleted: true };
    } catch (err) {
        if (err?.code === 404) return { deleted: false };
        throw err;
    }
}

/**
 * Idempotens egy-user team membership eltávolítás. Listázza a team
 * tagságait `userId` szűrővel, majd törli a megtalált membership doc-okat
 * (általában 1 db). 404 (team nem létezik) → skip.
 *
 * Használata: `leave_organization` action — a user kilép, a tagsági doc
 * marad a (másik) tag-okra, de a team-ből őt magát eltávolítjuk, hogy a
 * tenant-scope ACL push ne menjen rá többet.
 *
 * @param {sdk.Teams} teams - initialized Teams SDK client.
 * @param {string} teamId - custom team ID.
 * @param {string} userId - user `$id`.
 * @returns {Promise<{removed: number, skipped?: string}>}
 */
async function removeTeamMembership(teams, teamId, userId) {
    const sdk = require('node-appwrite');
    let memberships;
    try {
        memberships = await teams.listMemberships(teamId, [
            sdk.Query.equal('userId', userId),
            sdk.Query.limit(10)
        ]);
    } catch (err) {
        if (err?.code === 404) return { removed: 0, skipped: 'team_not_found' };
        throw err;
    }

    if (!memberships?.memberships?.length) {
        return { removed: 0, skipped: 'not_a_member' };
    }

    let removed = 0;
    for (const m of memberships.memberships) {
        try {
            await teams.deleteMembership(teamId, m.$id);
            removed++;
        } catch (err) {
            if (err?.code === 404) continue;
            throw err;
        }
    }
    return { removed };
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    buildOrgTeamId,
    buildOfficeTeamId,
    buildOrgAclPerms,
    buildOfficeAclPerms,
    buildWorkflowAclPerms,
    buildExtensionAclPerms,
    ensureTeam,
    ensureTeamMembership,
    removeTeamMembership,
    deleteTeamIfExists
};
