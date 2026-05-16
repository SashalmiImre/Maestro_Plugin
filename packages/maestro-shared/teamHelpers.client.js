/**
 * @file teamHelpers.client.js
 * @description Kliens-oldali Team ACL helperek a tenant-érintő `tables.createRow`
 * (plugin) / `databases.createDocument` (dashboard) hívásokra. ADR 0014
 * (`withCreator` defense-in-depth) frontend megfelelője.
 *
 * Server-side analóg:
 *   packages/maestro-server/functions/invite-to-organization/src/teamHelpers.js
 *
 * API IDENTIKUS a server-side helper-rel (azonos nevek, azonos viselkedés) —
 * a két oldal együtt grep-elhető, és minden audit ugyanazt a kanonikus mintát követi.
 *
 * `appwrite` web SDK a `peerDependency` (`maestro-shared/package.json`); mind
 * a plugin, mind a dashboard `appwrite@^24.1.1`-et bundlel, így a peer-dep nem
 * okoz duplikációt. A CF (`node-appwrite`) NEM importálja ezt a modult —
 * server-side külön `teamHelpers.js` él.
 *
 * Fail-closed minden helper: hiányzó / nem-string / whitespace-only scope-id
 * vagy userId → throw. NEM csendben `team:office_undefined` vagy `user:  `.
 * A trim-stable check szimmetrikus mind a 3 input-mezőre (organizationId /
 * editorialOfficeId / userId).
 */

import { Permission, Role } from 'appwrite';

/** Per-org Appwrite Team ID — `org_${organizationId}`. */
export function buildOrgTeamId(organizationId) {
    const trimmed = typeof organizationId === 'string' ? organizationId.trim() : '';
    if (!trimmed || trimmed !== organizationId) {
        throw new Error('buildOrgTeamId: organizationId required (non-empty, non-whitespace, no leading/trailing space)');
    }
    return `org_${organizationId}`;
}

/** Per-office Appwrite Team ID — `office_${editorialOfficeId}`. */
export function buildOfficeTeamId(editorialOfficeId) {
    const trimmed = typeof editorialOfficeId === 'string' ? editorialOfficeId.trim() : '';
    if (!trimmed || trimmed !== editorialOfficeId) {
        throw new Error('buildOfficeTeamId: editorialOfficeId required (non-empty, non-whitespace, no leading/trailing space)');
    }
    return `office_${editorialOfficeId}`;
}

/** Org-scope ACL — `read(team:org_${orgId})`. Realtime push + REST listDocuments szűrve. */
export function buildOrgAclPerms(organizationId) {
    return [Permission.read(Role.team(buildOrgTeamId(organizationId)))];
}

/** Office-scope ACL — `read(team:office_${officeId})`. */
export function buildOfficeAclPerms(editorialOfficeId) {
    return [Permission.read(Role.team(buildOfficeTeamId(editorialOfficeId)))];
}

/**
 * Defense-in-depth wrapper: explicit `Permission.read(user)` pótlása az alap
 * team-ACL-hez. ADR 0014 3. réteg kanonikus mintája.
 *
 * Frontend write-on funkcionálisan redundáns (a user már team-tag a session
 * teljes idejére), de a kanonikus minta szerint **kötelező**: jövőbeli
 * edge-case-ek (admin-API-key flow, delegált create, race) ellen védelem.
 * A server-side megfelelője ugyanezt csinálja a creator-NEM-még-team-tag
 * race-ablakra a bootstrap / acceptInvite action-ökben.
 *
 * @param {string[]} perms — alap ACL (pl. `buildOfficeAclPerms(officeId)` eredménye)
 * @param {string} userId — a creator Appwrite user `$id` (non-empty, trim-stable)
 * @returns {string[]} — kombinált perm-array
 */
export function withCreator(perms, userId) {
    const trimmed = typeof userId === 'string' ? userId.trim() : '';
    if (!trimmed || trimmed !== userId) {
        throw new Error('withCreator: userId required (non-empty, non-whitespace, no leading/trailing space)');
    }
    return [...perms, Permission.read(Role.user(userId))];
}
