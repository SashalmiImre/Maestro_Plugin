---
adr: 12
status: Accepted
date: 2026-05-10
tags: [adr, döntés, server, permission, acl, member, removal, cascade]
related: [[0003-tenant-team-acl]] [[0008-permission-system-and-workflow-driven-groups]] [[0009-membership-user-identity-denormalization]]
---

# ADR 0012 — Admin-kick: tag-eltávolítás a szervezet beállításokból

## Kontextus

A szervezet beállítások „Felhasználók" tabján eddig csak meghívás és role-csere volt elérhető — eltávolítás (kick) nem. A felhasználói igény: az owner / admin tudjon eltávolítani egy taget a szervezetből (cascade cleanup), de a fiókja ne sérüljön (önálló self-service flow → ADR 0013).

A meglévő infrastruktúra már 90%-ban kész:
- `org.member.remove` slug **definiálva van** a [[Komponensek/PermissionTaxonomy]]-ban (`packages/maestro-shared/permissions.js`, line 41), és **nem** szerepel az `ADMIN_EXCLUDED_ORG_SLUGS`-ban → admin is kapja default-ban.
- `leaveOrganization` action (`actions/offices.js:50`) STRICT team-cleanup mintáját reuse-oljuk: per-office team + org team + `org_${orgId}_admins` team eltávolítás a DB delete ELŐTT, hogy a Realtime ghost-ACL-access-t megelőzzük.
- `changeOrganizationMemberRole` action (`actions/orgs.js:727`) 8 védelmi réteg mintáját reuse-oljuk a guardokra (self-block, permission, owner-touch, last-owner, membership lookup, idempotens, update).
- A meglévő `user-cascade-delete` event-driven CF a self-service account-delete flow-ban majd takarít — itt nem releváns (admin-kick csak az adott orgra hat).

Egy Codex co-reflection (CLAUDE.md "BLOCKER ELŐTT" + stop-time gate) az implementáció előtt 3 BLOCKER + 5 MAJOR + 3 MINOR + 2 DESIGN-Q-t talált. A BLOCKER-ek a Phase 2 self-service flow-t érintik (ADR 0013); a MAJOR-okat az Phase 1 admin-kick flow-ba beépítettük.

## Döntés

**Új CF action `remove_organization_member`** (helye: `actions/orgs.js`, közvetlenül a `changeOrganizationMemberRole` után). Védelmi rétegek sorrendben:

1. **Payload validation** — `{ organizationId, targetUserId }` kötelező string.
2. **Self-block** — `callerId === targetUserId` → 403 `cannot_remove_self` `{ hint: 'use_leave_organization' }`. Self-removal a self-service flow-n keresztül (ADR 0013).
3. **Permission check** — `userHasOrgPermission('org.member.remove', organizationId)`. Owner és admin egyaránt megkapja default-ban (`ADMIN_EXCLUDED_ORG_SLUGS` csak `org.delete` és `org.rename`).
4. **Membership lookup** — `organizationMemberships` `(organizationId, targetUserId)` → 404 `membership_not_found`.
5. **Owner-touch guard** (Q3, MAJOR) — ha `target.role === 'owner'` ÉS `caller.role !== 'owner'` → 403 `requires_owner_for_owner_removal`. Admin nem törölhet owner-t, owner viszont igen (csak last-owner guard véd ellene).
6. **Last-owner guard** — ha `target.role === 'owner'` ÉS csak 1 owner van az org-ban → 409 `cannot_remove_last_owner` `{ hint: 'transfer_ownership_first' }`.
7. **STRICT team cleanup** (Q5/Q6, MAJOR) — DB delete ELŐTT a `removeTeamMembership`-eket sorba futtatjuk a target-userre:
   - Per-office: `office_${officeId}` (az org alá tartozó minden office-ra)
   - `org_${organizationId}` team
   - `org_${organizationId}_admins` team (admin/owner role-úakon eltávolít, member-en idempotens no-op)
   - Hiba → 500 `team_cleanup_failed`, DB érintetlen, retry biztonságos.
8. **Cascade DB delete** (paginált, infinite-loop guard a `leaveOrganization` mintáját követve):
   - `editorialOfficeMemberships` (org-szűrt + targetUser)
   - `groupMemberships` (org-szűrt + targetUser)
   - `organizationMemberships` doc törlés (a fő rekord, utolsóként)
9. **Response** — `{ success, action: 'removed', organizationId, targetUserId, removed: { officeMemberships, groupMemberships }, teamCleanup }`.

**Frontend (`UsersTab.jsx`)**:
- Új `handleRemoveMember(member)` handler — a member-row-on (Tag és Admin szekciók) "Eltávolítás" gomb.
- A gomb nem jelenik meg: (a) self-row-on, (b) owner-row-on ha caller admin (UX-szintű előszűrés a backend owner-touch guard-ja előtt), (c) ha a caller member (nem isOrgAdmin).
- `useConfirm({ verificationExpected: member.userEmail })` email-typed verification — a meglévő `ConfirmDialog` strict `===` egyenlősége elegendő (a `member.userEmail` denormalizált a [[0009-membership-user-identity-denormalization]] alapján, és pontosan azt mutatjuk a UI-on).
- `userEmail` fallback (Codex MINOR): legacy/null-denormalizált rekordnál a confirmation a `member.userId`-re esik vissza, vagy a gomb disabled state-tel jelez egyértelmű hibát (operator backfill-igényt).
- Sikeres CF call → `onMembersRefresh()` (mint a `handleRoleChange`-ben).
- Új AuthContext method `removeOrganizationMember(organizationId, targetUserId)` — `callInviteFunction('remove_organization_member', ...)`.

**Audit-trail**: Phase 1-ből szándékosan kihagyva (Codex DESIGN-Q D1). A felhasználói igény nem említette, a meglévő Appwrite execution log + a `user-cascade-delete` log elegendő ops-szintű forensics-hoz. Future-work follow-up [[Feladatok]]-ban: ha tenant-visible audit-trail kell, az `organizationInviteHistory`-szerű collection bővíthető `removed_by_admin` finalStatus-szal.

## Alternatívák

| Opció | Mellette | Ellene |
|---|---|---|
| **A — Soft-delete (`archivedAt` mező a membership-re)** | Reverzibilis (admin "vissza-húzhatja"). | A `groupMemberships` és `editorialOfficeMemberships` ACL-t nem soft-delete-eli → ghost access. Komplex schema bővítés. |
| **B — Hard-delete cascade STRICT team-cleanup-pal** ← **választott** | A `leaveOrganization` mintáját 1:1 reuse-olja. Konzisztens ACL state. Ha tévedés: új meghívás 1 kattintás. | Irreverzibilis (a tag csoport-tagságai elvesznek). |
| **C — Soft-delete + scheduled hard-delete (7 napos retention)** | Compromise: short-window recovery. | Plusz scheduled CF + extra schema. Az igény nem kéri. |

A **B** választott — minimális komplexitás, konzisztens a meglévő `leaveOrganization` és `delete_organization` mintákkal.

## Következmények

### Pozitív
- Owner és admin caller eltávolíthat tagokat egy ACL-konzisztens flow-n — Realtime push azonnal megszűnik a cleanup után.
- Az `org.member.remove` slug aktiválódik a permission rendszerben (eddig csak definiálva volt, használat nélkül).
- A meglévő mintát követi (`leaveOrganization` STRICT, `changeOrganizationMemberRole` 8-réteg) — kis kognitív teher a code-review-nak.

### Negatív / Kockázat
- A target-user `groupMemberships` rekordjai elvesznek — soft-delete-tel reverzibilis lehetne, de a Realtime ghost-ACL-access kockázat felülmúlja.
- Owner-on-owner kick: az audit-rekord hiánya azt jelenti, hogy egy másik owner kicsapásánál csak az Appwrite execution log marad meg (admin attention bonyolultabb forensics-hez). Phase 3 follow-up.

### Migration / Rollback
- **Schema**: nincs új mező / collection — csak új CF action.
- **Rollback**: a frontend "Eltávolítás" gomb hide flag-elhető a `callerRole` ellenőrzésen kívül. A CF action-ben egy 410 `feature_disabled` early-return is használható, ha kell.

## Codex review fix-ek

A pre-implementation review (2026-05-10) **3 BLOCKER + 5 MAJOR + 3 MINOR + 2 DESIGN-Q** alapján:

| Codex jelzés | Súly | Beépítés |
|---|---|---|
| Q3 owner-touch shape preserve | MAJOR | Lépés 5 — admin nem érint owner-t, owner igen (last-owner véd) |
| Q5 STRICT removeTeamMembership before DB delete | MAJOR | Lépés 7 — a `leaveOrganization` mintát követjük |
| Q6 `org_${orgId}_admins` team cleanup admin-kick-en | MAJOR | Lépés 7 — bekerült a strict cleanup-ba |
| Q4 email case-sensitivity verification | MINOR | A `member.userEmail` denormalizáltból olvas, strict-eq elegendő (ld. dialog UX) |
| Q7 orphan-guard cache-reuse | MINOR | `permissionContext.orgStatusByOrg` használat, ha az action belsőleg újra olvassa az org-status-t |
| `userEmail` fallback legacy null-on | MINOR | Frontend `member.userEmail` null-check + button disabled |
| D1 audit-trail | DESIGN-Q | Phase 1-ből kihagyva, [[Feladatok]] follow-up |

A 3 BLOCKER mind az ADR 0013-hoz tartozik (self-service flow), itt nem érintett.

## Kapcsolódó

- ADR: [[0008-permission-system-and-workflow-driven-groups]] (slug taxonómia)
- ADR: [[0009-membership-user-identity-denormalization]] (`userEmail` denormalizáció — verification source)
- ADR: [[0003-tenant-team-acl]] (per-tenant Appwrite Team-ek)
- ADR: [[0013-self-service-account-management]] (kapcsolódó self-service flow)
- Komponens: [[Komponensek/PermissionTaxonomy]]
- Sablon-action: `change_organization_member_role` (orgs.js:727), `leaveOrganization` (offices.js:50)
