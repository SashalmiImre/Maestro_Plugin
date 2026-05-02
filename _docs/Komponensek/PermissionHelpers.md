---
tags: [komponens, jogosultság, permission, server, shared]
aliases: [PermissionHelpers, permissions.js, userHasPermission helper, userHasOrgPermission helper]
---

# PermissionHelpers — `permissions.js` modul

> **Státusz**: Implemented (A.3.5 + A.3.6 retrofit + 2026-05-03 harden, deploy-ready). Server-side rész kész; kliens-oldali integráció A.4 (Dashboard) + A.5 (Plugin) hatáskör.
>
> **2026-05-03 harden Critical fix**: új `isStillOfficeMember()` helper export, és a `buildPermissionSnapshot` member-path elején `editorialOfficeMemberships` defense-in-depth cross-check. Két privilege-eszkalációs felület lezárva (rogue `groupMembership` write + kilépett creator ownership).

## Cél

Az [[Döntések/0008-permission-system-and-workflow-driven-groups|ADR 0008]] B blokk (`permissionSets` réteg) jogosultsági ellenőrzéseinek központi helye. Két forrás-fájl, közös API:

- **Shared (ESM, kliens + szerver)**: [packages/maestro-shared/permissions.js](packages/maestro-shared/permissions.js) — slug-konstansok, sync helperek, default permission set-ek.
- **Server-only (CommonJS)**: [packages/maestro-server/functions/invite-to-organization/src/permissions.js](packages/maestro-server/functions/invite-to-organization/src/permissions.js) — async DB lookup, snapshot build, per-request cache.

A drift kockázat (két forrás manuális szinkronja) [[Hibaelhárítás|hibaelhárítási bejegyzés]] alá fog tartozni Phase 2-ben (A.7.1: AST-equality CI test vagy single-source bundle).

## Slug-katalógus

A 38 slug részleteit a [[PermissionTaxonomy]] tartalmazza. Itt csak a kódbeli reprezentáció:

| Konstans | Tartalom | Hol |
|---|---|---|
| `OFFICE_SCOPE_PERMISSION_SLUGS` (Array) + `OFFICE_SCOPE_PERMISSION_SLUG_SET` (Set) | 33 slug — `office.*`, `group.*`, `permissionSet.*`, `extension.*`, `publication.*`, `workflow.*`, `workflow.<sub>.*` | shared + CF inline |
| `ORG_SCOPE_PERMISSION_SLUGS` + `ORG_SCOPE_PERMISSION_SLUG_SET` | 5 slug — `org.*` prefix | shared + CF inline |
| `ALL_PERMISSION_SLUG_SET` | 38 slug uniója | shared |
| `PERMISSION_GROUPS` | 8 logikai csoport — UI mátrix renderhez | shared |
| `DEFAULT_PERMISSION_SETS` | 3 default set: `owner_base` (33), `admin_base` (33), `member_base` (3 slug) | shared + CF inline |
| `ADMIN_EXCLUDED_ORG_SLUGS` | `Set(['org.delete', 'org.rename'])` — `admin` org-role NEM kapja | shared + CF inline |

## Sync helperek (kliens + szerver)

| Helper | Funkció |
|---|---|
| `isOfficeScopeSlug(slug)` | Boolean — slug a 33 office-scope egyike |
| `isOrgScopeSlug(slug)` | Boolean — slug az 5 org-scope egyike |
| `isKnownPermissionSlug(slug)` | Boolean — slug a 38 ismert egyike |
| `assertSlugScope(slug, expectedScope)` | Throw-ol ha ismeretlen vagy rossz scope |
| `validatePermissionSetSlugs(slugs[])` | `{valid, errors[]}` — 400 `org_scope_slug_not_allowed`, `unknown_slug`, `duplicate_slug` |
| `clientHasPermission(userPermissions, slug)` | Boolean — kliens-oldali Set-lookup. **NEM helyettesíti a server-side guardot** |

## Async helperek (server-only)

| Helper | Funkció |
|---|---|
| `lookupOrgIdFromOffice(databases, env, officeId)` | `office.organizationId` lookup |
| `isStillOfficeMember(databases, env, userId, officeId)` | **A.3.6 harden 2026-05-03**: defense-in-depth `editorialOfficeMemberships` lookup. Fail-closed boolean (env-hiány / DB-hiba → `false`). Single-source-of-truth a 3 hívóhelyen: `buildPermissionSnapshot` member-path, `archive_workflow`/`restore_workflow` ownership-fallback, `update_workflow_metadata` visibility-ág. |
| `getOrgRole(databases, env, userId, orgId, orgRoleByOrg?)` | User org-role (`'owner' \| 'admin' \| 'member' \| null`). **Cache-kulcs: `${userId}::${orgId}`** (Codex Critical fix: cross-user leak elkerülése). **Hibára NEM cache-el** (Codex P2 fix: tranziens DB hiba ne fagyassza le a request engedélyezését). |
| `buildPermissionSnapshot(databases, env, user, officeId, orgRoleByOrg?)` | Egyszer számol per office: `{userId, editorialOfficeId, organizationId, orgRole, permissionSlugs: Set<string>, hasGlobalAdminLabel}`. 1) Office → orgId, 2) user org-role, 3) **owner/admin shortcut** → 33 slug halmaz, 4) **`isStillOfficeMember` cross-check (rogue `groupMembership` lezárás, A.3.6 harden 2026-05-03)**, 5) member-path → `groupMemberships` × `groupPermissionSets` × `permissionSets` (`Query.isNull('archivedAt')` szűrt). |
| `userHasPermission(databases, env, user, slug, officeId, snapshotsByOffice?, orgRoleByOrg?)` | Office-scope ellenőrzés. **Throw `org.*` slugra**. **Cache-kulcs: `${userId}::${officeId}`** (Codex Critical fix). |
| `userHasOrgPermission(databases, env, user, slug, orgId, orgRoleByOrg?)` | Org-scope ellenőrzés. **Throw NEM `org.*`-ra**. Owner → mind az 5; admin → 3 (kivéve `org.delete`/`org.rename`). |
| `createPermissionContext()` | `{ snapshotsByOffice: Map, orgRoleByOrg: Map }` per-request scaffold. A CF entry-pointja az elején hívja. **Request-snapshot consistency**: a memoizált snapshot a CF-call teljes lifecycle-ja alatt él — egy mid-request permission-változás NEM látszik a request belül (szándékos). |

## Per-request memoizáció

A CF entry-pointja egyszer létrehozza a contextet, és minden `userHasPermission()` / `userHasOrgPermission()` hívás kapja paraméterként. Egy office-ra max 1 snapshot build (≤4 lookup), egy org-ra max 1 role lookup. Cross-request állapot **nincs** (új CF call → új Map).

**Cache-kulcs minta**: `${userId}::${scopeId}` (Codex baseline review Critical fix). Multi-user CF flow-ban (jövőbeli target-user validáció) más user snapshot-jának öröklése auth leak-et okozna.

## Snapshot build pagination

Codex baseline review P1 fix: az összes lapozott `select()`-ben explicit szerepel a `$id`, hogy a `cursorAfter()` ne fusson undefined-ra. A chunkolás 100-as blokkokra (`APPWRITE_QUERY_EQUAL_LIMIT = 100`) — egy user worst-case 1000+ csoportban / set-ben fan-out. Reálisan 5-10 csoport.

## Defense-in-depth

- A `buildPermissionSnapshot` member-pathon csak office-scope slug-ot vesz a Set-be (`OFFICE_SCOPE_PERMISSION_SLUG_SET.has(slug)` check) — DevTools / direkt DB write ellen véd.
- `permissionSets.permissions[]` write-time validáció: `validatePermissionSetSlugs()` 400 `org_scope_slug_not_allowed` az `org.*`-ra (CF write-path + UI guard).
- **`editorialOfficeMemberships` cross-check (A.3.6 harden 2026-05-03)**: az `isStillOfficeMember()` helper a member-path elején ellenőrzi, hogy a user tagja-e az office-nak. Egy out-of-band DB-write (Appwrite Console / direkt API key script / kompromittált backup-restore) létrehozhat rogue `groupMembership` rekordot anélkül, hogy a user `editorialOfficeMemberships`-tag lenne — a helper ezt a privilege-eszkalációs felületet zárja le.
- **Kilépett creator membership-check**: a `workflow.share` és `workflow.archive` action-ök `createdBy === callerId` ownership-fallback-jét most az `isStillOfficeMember()` is gate-eli — egy kilépett user a workflow-jára nem maradhat jogosult.

## Default permission set seed

Az új org / új office bootstrap automatikusan seedeli a 3 default set-et: [main.js](packages/maestro-server/functions/invite-to-organization/src/main.js) `seedDefaultPermissionSets` helper. Best-effort failover (Codex review): hiba esetén `permissionSetSeedErrors` a response-ban, az org-bootstrap NEM rollback-el (org-role override-val az owner/admin amúgy is teljes CRUD-ot kap).

## Hibakódok

| Kód | Mikor | Status |
|---|---|---|
| `missing_fields` | `permissions[]` nem ad-ott vagy nem array | 400 |
| `invalid_field_type` | `permissions` nem array | 400 |
| `invalid_slug` | szerinti slug regex nem passzol | 400 |
| `org_scope_slug_not_allowed` | `org.*` slug a `permissions[]`-ben | 400 |
| `invalid_permissions` | egyéb `validatePermissionSetSlugs` hiba | 400 |
| `permission_set_slug_taken` | `office_slug_unique` index ütközés | 409 |
| `permission_set_not_found` | `getDocument` 404 | 404 |
| `slug_immutable` | `update_permission_set` `slug` payloadban | 400 |
| `concurrent_modification` | TOCTOU `expectedUpdatedAt` mismatch | 409 |
| `schema_missing` | `permissionSets.archivedAt` mező hiányzik | 422 |
| `office_mismatch` | `assign_permission_set_to_group` cross-office | 400 |
| `assignment_state_unknown` | 409 + verifikáló lookup üres (race) | 200 success, kliens újraindítja |

## Kapcsolódó

- ADR: [[Döntések/0008-permission-system-and-workflow-driven-groups]]
- Tervek: [[Tervek#Jogosultsági rendszer]]
- Komponensek: [[PermissionTaxonomy]] (slug-katalógus), [[UserContext]] (Plugin A.5 client cache), [[AuthContext]] (Dashboard A.4 client cache), [[useOrgRole]] (legacy 3-role hook)
- Csomagok: [[Csomagok/dashboard-workflow-designer]]
