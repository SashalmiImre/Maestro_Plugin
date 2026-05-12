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
 * - `org_${organizationId}_admins` — Q1 ACL (E blokk, 2026-05-09 follow-up).
 *                                 CSAK az `owner` és `admin` role-ú tagokat
 *                                 tartalmazza. Az `organizationInvites` és
 *                                 `organizationInviteHistory` doc-szintű
 *                                 ACL-je erre a team-re mutat (privacy).
 * - `office_${editorialOfficeId}` — minden szerkesztőséghez 1 team, tagjai az
 *                                    `editorialOfficeMemberships` alapján.
 *
 * ACL tag-ek a dokumentumokon (Q1 ACL utáni állapot):
 * - `groups` / `groupMemberships`           → `read("team:office_${officeId}")`
 * - `organizationInvites`                   → `read("team:org_${orgId}_admins")`
 * - `organizationInviteHistory`             → `read("team:org_${orgId}_admins")`
 *
 * Minden művelet idempotens (a CF best-effort rollback-el kompatibilis).
 */

const sdk = require('node-appwrite');

// ── Team ID builders ────────────────────────────────────────────────────────

function buildOrgTeamId(organizationId) {
    return `org_${organizationId}`;
}

/**
 * Q1 ACL (E blokk, 2026-05-09 follow-up) — admin-team ID generátor.
 * CSAK az owner+admin tagokat tartalmazza, és az `organizationInvites` +
 * `organizationInviteHistory` ACL-je erre szűkül.
 */
function buildOrgAdminTeamId(organizationId) {
    return `org_${organizationId}_admins`;
}

function buildOfficeTeamId(editorialOfficeId) {
    return `office_${editorialOfficeId}`;
}

// ── ACL permissions builders ────────────────────────────────────────────────

/**
 * Szervezeti scope-ú dokumentumok ACL-je (pl. `organizationInvites` Q1 ELŐTT —
 * jelenleg legacy backfill-utáni doc-okra mutat, az új doc-okon a
 * `buildOrgAdminAclPerms` használandó). Írás-joga továbbra is kizárólag az
 * API key-vel rendelkező CF-eké marad (collection-szintű ACL), itt csak a
 * Realtime push + REST olvasási hozzáférést szűkítjük a team tagjaira.
 */
function buildOrgAclPerms(organizationId) {
    return [sdk.Permission.read(sdk.Role.team(buildOrgTeamId(organizationId)))];
}

/**
 * Q1 ACL (E blokk) — admin-team-szűkített read perm.
 * Az `organizationInvites` és `organizationInviteHistory` collection write-path-ja
 * ezt használja; CSAK az `org_${id}_admins` team tagjai (owner+admin) kapnak
 * read jogot a doc-okra, azaz Realtime push + REST list/get is szűkül.
 */
function buildOrgAdminAclPerms(organizationId) {
    return [sdk.Permission.read(sdk.Role.team(buildOrgAdminTeamId(organizationId)))];
}

/**
 * Szerkesztőségi scope-ú dokumentumok ACL-je (pl. `groups`, `groupMemberships`).
 */
function buildOfficeAclPerms(editorialOfficeId) {
    return [sdk.Permission.read(sdk.Role.team(buildOfficeTeamId(editorialOfficeId)))];
}

/**
 * Defense-in-depth wrapper: a callerId-re explicit `Permission.read(user)` perm
 * pótlása az alap ACL-hez (S.7 stop-time MAJOR 2026-05-12 fix).
 *
 * **Indok**: a `bootstrap_organization` és `acceptOrganizationInvite` action-ök
 * a doc-ot a `createDocument` 5. paraméterén át team-szintű ACL-lel
 * `read(team:org_${orgId})` látják el. A creator (vagy meghívott elfogadó) a
 * `createDocument` időpontban MÉG NEM team-tag — az `ensureTeamMembership`
 * vagy a team létrehozása csak később fut. Emiatt a creator a saját doc-ját
 * NEM látja, amíg a team-tagság lefut.
 *
 * A `Permission.read(user(callerId))` Role azonnal hat (independent of
 * team-membership timing), így a creator a doc-ot rögtön látja. A team-szintű
 * read a többi tagra továbbra is alkalmazódik (defense-in-depth, redundáns
 * de korrekt).
 *
 * @param {string[]} perms — alap ACL (pl. `buildOrgAclPerms(orgId)` eredménye)
 * @param {string} callerId — Appwrite user ID, akinek azonnali read jogot adunk
 * @returns {string[]} — kombinált perm-array
 */
function withCreator(perms, callerId) {
    // Codex verifying review NIT (2026-05-12): explicit guard — különben
    // `user:undefined`/`user:null` permission string-et adna ki (érvénytelen
    // ACL, Appwrite 400-zal szállna el a `createDocument`-en).
    if (!callerId || typeof callerId !== 'string') {
        throw new Error('withCreator: callerId required (non-empty string)');
    }
    return [...perms, sdk.Permission.read(sdk.Role.user(callerId))];
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
    buildOrgAdminTeamId,
    buildOfficeTeamId,
    buildOrgAclPerms,
    buildOrgAdminAclPerms,
    buildOfficeAclPerms,
    buildWorkflowAclPerms,
    buildExtensionAclPerms,
    withCreator,
    ensureTeam,
    ensureTeamMembership,
    removeTeamMembership,
    deleteTeamIfExists
};
