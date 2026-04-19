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

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    buildOrgTeamId,
    buildOfficeTeamId,
    buildOrgAclPerms,
    buildOfficeAclPerms,
    ensureTeam,
    ensureTeamMembership,
    deleteTeamIfExists
};
