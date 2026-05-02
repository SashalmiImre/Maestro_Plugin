---
tags: [referencia]
---

# Szószedet

## Platform & Keretrendszer

| Fogalom | Leírás |
|---------|--------|
| **UXP** | Unified Extensibility Platform — Adobe plugin rendszer |
| **ExtendScript** | InDesign scripting nyelv (CEP bridge-en keresztül futtatva) |
| **Spectrum Web Components** | Adobe design system — `@swc-uxp-wrappers/*` |
| **Appwrite** | Open-source Backend-as-a-Service (Database, Realtime, Storage, Teams) |

## Architektúra fogalmak

| Fogalom | Leírás |
|---------|--------|
| **DataContext** | Központi React Context — kiadványok, cikkek, validációk kezelése |
| **MaestroEvent** | Window-alapú `CustomEvent` eseménybusz (laza csatolás) |
| **RecoveryManager** | Kapcsolat-helyreállítás orchestrator (health check → reconnect → refresh) |
| **EndpointManager** | Dual-proxy failover kezelő singleton |
| **LockManager** | Dokumentumzárolás kezelő (DB szintű, informatív — a valódi zár az `.idlk`) |
| **DocumentMonitor** | InDesign dokumentum életciklus figyelő (`afterSave`, `afterOpen`, `afterClose`) |
| **WorkflowEngine** | Cikk állapotátmenet végrehajtó (`executeTransition`, `lockDocument`, `unlockDocument`) |
| **StateComplianceValidator** | Állapotátmenet-validáció koordinátor |

## Minták & Technikák

| Fogalom | Leírás |
|---------|--------|
| **Write-through API** | Komponens → DB írás → optimista helyi frissítés szerver válasszal |
| **`applyArticleUpdate()`** | Külső írók számára — szerver választ alkalmaz helyi állapotra DB hívás nélkül |
| **`$updatedAt` elavulás-védelem** | Frissebb helyi adat nem felülíródik régebbi szerveradattal |
| **registerTask** | Aszinkron koordinációs minta — `documentClosed` előtti feladatok bevárása |
| **`maestroSkipMonitor`** | Flag — programozott mentés ne triggerelj DocumentMonitor visszacsatolást |
| **cookieFallback** | `localStorage`-ban tárolt session (UXP cookie limitáció miatt) |
| **Fetch generáció-számláló** | Elavult fetch eredmények eldobása párhuzamos hívások esetén |
| **Ghost Socket védelem** | Socket generáció-számláló — régi socket close event-jei ignorálva |
| **`useOrgRole(orgId)`** | Központi callerOrgRole hook (active-org / owner-org / pub-org variánsok) — [[Komponensek/useOrgRole]] |
| **`getDatabases()` / `getFunctions()`** | [[Komponensek/AuthContext]] modul-szintű singleton — DataProvider-en KÍVÜLI használathoz |
| **`workflowLatestUpdatedAtRef`** | Globális `$updatedAt` Map a workflow Realtime out-of-order védelemhez ([[Komponensek/DataContext]]) |

## Útvonalkezelés

| Fogalom | Leírás |
|---------|--------|
| **Kanonikus útvonal** | Platform-független formátum: `/ShareName/relative/path` |
| **MOUNT_PREFIX** | `/Volumes` (macOS) vagy `C:/Volumes` (Windows) |
| **`toCanonicalPath()`** | Natív → DB formátum konverzió |
| **`toNativePath()`** | DB → natív formátum konverzió |

## Workflow & Bővítmények

| Fogalom | Leírás |
|---------|--------|
| **WorkflowLibraryPanel** | Közös workflow-könyvtár modal (breadcrumb chip + publikáció-hozzárendelés) — [[Komponensek/WorkflowLibrary]] |
| **WorkflowExtension** | DB-tárolt ExtendScript validátor / parancs (Proposed) — [[Komponensek/WorkflowExtension]] |
| **`WORKFLOW_STATE_COLORS`** | Közös szín-paletta + `nextAvailableColor()` helper — [[Komponensek/WorkflowStateColors]] |
| **`visibility` enum (3-state)** | `editorial_office` / `organization` / `public` — workflow scope ([[Döntések/0006-workflow-lifecycle-scope]]) |
| **`compiledWorkflowSnapshot`** | Aktivált publikáció snapshot mező — futó workflow immutable védelem |
| **`archivedAt`** | Soft-delete mező — 7 napos retention, `cleanup-archived-workflows` napi cron |
| **`buildWorkflowAclPerms()`** | Doc-szintű ACL helper a `workflows` collection-höz (Fázis 2 minta kiterjesztése) |
| **`ext.<slug>` prefix** | Workflow JSON `validations` / `commands` listájában custom extension hivatkozás |

## Jogosultsági rendszer (Partially-Implemented — [[Döntések/0008-permission-system-and-workflow-driven-groups]])

| Fogalom | Leírás |
|---------|--------|
| **Felhasználó-csoport** | Szerkesztőség-szintű csoport (`groups` collection, [[Döntések/0002-fazis2-dynamic-groups|ADR 0002]]) — workflow-driven slug, autoseed-elődik hozzárendeléskor / aktiváláskor |
| **Jogosultság-csoport** (permission set) | `permissionSets` collection — coarse permission slug-ok logikai csoportja, m:n kapcsolat felhasználó-csoportokhoz |
| **Permission slug** | `<resource>.<action>` formátumú azonosító (pl. `workflow.state.edit`) — egy CF-action-szerű művelet engedélyezésére. Két scope: 5 org-scope (`org.*` — kizárólag `organizationMemberships.role`-ból) + 33 office-scope (`permissionSets`-en át). Részletes lista: [[Komponensek/PermissionTaxonomy]] |
| **`requiredGroupSlugs[]`** | Workflow `compiled` JSON top-level mezője — a workflow által hivatkozott összes felhasználó-csoport kanonikus listája `{slug, label, description, color, isContributorGroup, isLeaderGroup}` formában. A többi slug-mező (`transitions.allowedGroups`, `commands.allowedGroups`, `elementPermissions.*.*.groups`, `leaderGroups`, `statePermissions.*`, `contributorGroups`, `capabilities.*`) ennek subset-je |
| **Autoseed (csoport)** | Hozzárendeléskor / aktiváláskor a hiányzó `requiredGroupSlugs[]` elemekre üres `groups` doc létrehozás (idempotens) — a `slug` + `label` + `description` + `color` + `isContributorGroup` + `isLeaderGroup` mezők átvételével |
| **Slug immutable** | A `groups.slug` ID-szerű — csak a `label`, `description`, `color`, `isContributorGroup`, `isLeaderGroup` szerkeszthetőek (workflow-hivatkozás stabilitása) |
| **`userHasPermission()`** / **`userHasOrgPermission()`** | Két shared helper (`packages/maestro-shared/permissions.js`). Office-scope (33 slug): admin label → `organizationMemberships.role` → **`editorialOfficeMemberships` defense-in-depth cross-check (A.3.6 harden, 2026-05-03)** → permission set lookup. Org-scope (5 slug): admin label → `organizationMemberships.role` only (member-nek nincs `org.*` slug-ja). |
| **`isStillOfficeMember()`** | Shared helper a `permissions.js`-ben — single-source-of-truth a defense-in-depth `editorialOfficeMemberships` lookup-okra. Fail-closed boolean (env-hiány / DB-hiba esetén `false`). 3 helyen használt: `buildPermissionSnapshot` member-path eleje, `archive_workflow`/`restore_workflow` ownership-fallback, `update_workflow_metadata` visibility-ág. |
| **`insufficient_permission` (403)** | Új error reason a permission rendszer retrofit-jéhez (A.3.6, 2026-05-02). Mezők: `slug` (a kért permission-slug), `scope` (`'office'` / `'org'`), opcionális `requiresOwnership: true`, `field: 'visibility'`. A régi `insufficient_role` reason a retrofit-elt action-ökön elvesztette érvényességét. Frontend toast-mapping átállás A.4 hatáskör. |
| **`workflow.share` slug** | A workflow visibility-mező változtatás kanonikus engedélye (`workflow.share` az ADR 38-as taxonómiájában). Két kapun keresztül érvényesül: (a) `update_workflow_metadata` 5-pre lépés (visibility-mezős update), (b) `create_workflow` 2.5 lépés (ha non-default `visibility`-vel hozzák létre). Ownership-fallback: `createdBy === callerId` + még office-tag. |
| **Request-snapshot consistency** | A `permissionContext` per-request memoizációja egy CF-call belsejében konzisztens nézetet ad: az `userHasPermission()` egy snapshot-ot épít a request kezdetén, és minden további hívás ezt használja. Ha mid-request a user permission-je változik, a CF a kezdő-állapot szerint dönt végig — szándékos elv, nem bypass-ra javítandó. |
| **Kilépett creator privilege-eszkaláció** | A `createdBy === callerId` ownership-fallback (`workflow.share` / `workflow.archive`) elvi kockázata: egy kilépett user a workflow-jára örökre jogosult lenne, ha nincs membership-check. A `isStillOfficeMember()` helper ezt minden ownership-ágon ellenőrzi (A.3.6 harden Critical fix, 2026-05-03). |
| **`groupPermissionSets`** | M:n junction collection — `groupId` ↔ `permissionSetId` |
| **`empty_required_groups` (409)** | Aktiválás-blokkoló error, ha valamely `requiredGroupSlugs` slug-ban nincs tag |
| **`group_in_use` (409)** | Csoport-törlés / archiválás blokkoló error — workflows / activePublications snapshot / publications.defaultContributors / articles.contributors hivatkozásokkal |
| **`activate_publication` CF action** | Szinkron aktiváló — auth gate (office-membership) + TOCTOU (`expectedUpdatedAt`) + deadline-fedés + autoseed + min. 1 tag-check minden slug-on + atomic update `compiledWorkflowSnapshot` + `server-guard` sentinel a post-event guard skip-jéhez. Idempotens: snapshot string-egyezésnél `already_activated` early return. |
| **`assign_workflow_to_publication` CF action** | Szinkron workflow-rendelő — autoseed + 3-way visibility scope match + aktivált pub workflow-cseréje 409 `publication_active_workflow_locked`. |
| **`server-guard` sentinel** | `modifiedByClientId: 'server-guard'` mező a publikáció update-en — a `validate-publication-update` post-event CF skip-pel reagál (nem revertel, nem írja át a snapshot-ot). Az aktiváló CF csak akkor ír, ha minden pre-aktiválási check zöld. |
| **`PARSE_ERROR` sentinel (CF)** | `contributorJsonReferencesSlug` fail-closed jelzés sérült contributors JSON esetén — a `delete_group`/`archive_group` blocker-listára `parseError: true` flaggel teszi a doc-ot, különben adatvesztés. |
| **`applyPublicationPatchLocal()`** | [[Komponensek/DataContext]] helper — CF response.publication-t lokális state-re patcheli az `isStaleUpdate` szemantikával + `$updatedAt` autoritatív fallback. Megelőzi a Realtime-pong sorrend "régi state visszaírás"-t a `success` toast után. |
| **`autoseed warnings[]`** | A `seedGroupsFromWorkflow` non-fatal anomáliák listája: `group_slug_collision` (eltérő flag-ek a meglévő doc-on), `group_archived_blocking_autoseed` (slug archivált csoporthoz tartozik), `group_metadata_schema_missing` (`bootstrap_groups_schema` még nem futott). UI: [[Komponensek/AuthContext|showAutoseedWarnings]] toast helper. |
