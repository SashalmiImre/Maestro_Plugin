---
aliases: [TODO, Tasks, Teendők]
tags: [feladatok]
---

# Feladatok

> Ide gyűjtsd a fejlesztési ötleteket, bugokat, teendőket. A Claude Code is olvassa — megbeszéljük, majd kipipáljuk.

> **Forrás**: a [[Tervek]] alapján 2026-05-01-én lebontva. Három fő blokk (A → B → C), a sorrend a függőségeket követi. Minden blokk élén `*.0 Tervi tisztázás` szekció — ezeket a kérdéseket implementáció ELŐTT el kell dönteni.

> **Eldöntött tervi alapelvek (2026-05-01):**
> - **Nincs éles verzió, nincs visszafelé-kompatibilitás követelmény, nincs adatmigráció.** Minden meglévő dev-adat dobható.
> - **Felhasználó-csoport modell**: a `groups` collection ([[Döntések/0002-fazis2-dynamic-groups|ADR 0002]]) **megmarad**, de a definíció-forrás áttolódik a `bootstrap_organization`-ról a **workflow**-ra. A workflow `compiled.requiredGroupSlugs[]` mezőben definiálja a slug-jait; aktiváláskor / hozzárendeléskor a hiányzó slug-ok **autoseed-elődnek** üresen.
> - **`permissionSets` mint új ortogonális réteg** a `groups` mellé (m:n via `groupPermissionSets`). UI label "jogosultság-csoport", kódbeli azonosító `permissionSet`.
> - **Névkonvenció**: magyar UI label + angol kódbeli azonosító (mai gyakorlat). A távlati i18n-felkészülés (kétnyelvű UI) külön track.
> - **Permission granularitás**: coarse — 38 slug, 8 logikai csoportba szervezve ([[Komponensek/PermissionTaxonomy]]). Egy slug több CF-action-t fed le.
> - **`compiled.statePermissions` slug-alapú marad** — ortogonális a `permissionSets`-hez. A két réteg AND-elődik a guardokban.
> - **Slug immutable**: csak a `label`, `description`, `color`, `isContributorGroup`, `isLeaderGroup` szerkeszthető, a `slug` az ID — workflow-hivatkozás stabilitása.
> - **`bootstrap_organization` nem seedel csoportokat** — workflow-driven autoseed. (Permission set default seed marad — az nem workflow-driven.)
> - **Aktivált pub csoport-kiürülés**: warning + notification (snapshot védi a runtime-ot).

## Aktív

### A. Jogosultsági rendszer + felhasználó-csoport refactor

> Cél: **(1)** a workflow-driven felhasználó-csoport modell bevezetése (paradigmaváltás ADR 0002-höz képest); **(2)** új `permissionSets` réteg dashboard- és workflow-műveleti jogosultságokhoz. A két fél egy ADR-ben (0008) rögzítve.

#### A.0 Tervi tisztázás (BLOKKOLÓ)

**Eldöntve (2026-05-01):**
- ✅ A.0.1 — `groups` (= felhasználó-csoport) marad, mellé új `permissionSets` (= jogosultság-csoport), m:n.
- ✅ A.0.2 — Workflow-driven autoseed: a workflow `compiled.requiredGroupSlugs[]`-ban definiálja a slug-jait, hozzárendeléskor / aktiváláskor a hiányzók autoseed-elődnek.
- ✅ A.0.3 — Magyar UI label + angol kódbeli azonosító. Távlati: kétnyelvű UI (i18n felkészülés külön track).
- ✅ A.0.4 — Coarse 38 slug granularitás, 8 logikai csoportba ([[Komponensek/PermissionTaxonomy]]).
- ✅ A.0.5 — `compiled.statePermissions` slug-alapú marad (snapshot-kompatibilis).

**Eldöntve (2026-05-01, "nincs éles verzió, nincs kompatibilitás"):**
- ✅ A.0.6 — Slug immutable (csak `label`, `description`, `color`, `isContributorGroup`, `isLeaderGroup` szerkeszthető). Csoport-merge / slug-átnevezés Phase 2.
- ✅ A.0.7 — Warning + notification a csoport-kiürülésre (snapshot védi a runtime-ot).
- ✅ A.0.8 — `bootstrap_organization` (a) opció: nem seedel csoportokat. Permission set default seed marad (A.3.2).

#### A.1 Adatmodell és taxonómia

- [x] **A.1.1** Dashboard jogosultság-opciók véglegesítése — [[Komponensek/PermissionTaxonomy]] atomic note (1–7 logikai csoport, 32 slug a `dashboard`-jellegű műveletekhez). Részletes finomítás iteratívan ott történik.
- [x] **A.1.2** Workflow jogosultság-opciók véglegesítése — [[Komponensek/PermissionTaxonomy]] 8. csoport (workflow-tartalom, 6 slug). A `compiled.statePermissions` szemantikája változatlan: forrás-state-ből kimozgatás engedélyezése (lásd `canUserMoveArticle` runtime helper).
- [x] **A.1.3** Új collection: `permissionSets` (`name`, `slug`, `description`, `permissions[]`, `editorialOfficeId`, `organizationId`, `archivedAt`, `createdByUserId`). Doc-szintű ACL ([[Döntések/0003-tenant-team-acl]] minta). **Nincs külön `scope` mező** — a slug-konvenció (`<resource>.<action>`) maga kódolja a logikai csoportot; egy permission set vegyesen tartalmazhat dashboard- és workflow-műveleti slug-okat. → `bootstrap_permission_sets_schema` CF action ([packages/maestro-server/functions/invite-to-organization/src/main.js](packages/maestro-server/functions/invite-to-organization/src/main.js)).
- [x] **A.1.4** Új collection: `groupPermissionSets` (m:n junction) — `groupId`, `permissionSetId`, `editorialOfficeId`, `organizationId`. Realtime granularitás miatt külön collection. → ugyanaz a `bootstrap_permission_sets_schema` CF action hozza létre.
- [x] **A.1.5** Workflow `compiled` JSON új top-level mező: `requiredGroupSlugs[]` — `{slug, label, description, color, isContributorGroup, isLeaderGroup}` objektum-array. A workflow összes többi slug-mezőjének (`transitions.allowedGroups`, `commands.allowedGroups`, `elementPermissions.*.*.groups`, `leaderGroups`, `statePermissions.*`, `contributorGroups`, `capabilities.*`) kanonikus uniója; a `compiled.contributorGroups[]` és `leaderGroups[]` automatikusan generálódnak a flag-ekből. Részletes formális leírás: [[workflow-designer/COMPILED_SCHEMA#requiredGroupSlugs]]. → [packages/maestro-dashboard/src/features/workflowDesigner/compiler.js](packages/maestro-dashboard/src/features/workflowDesigner/compiler.js) + mindkét `defaultWorkflow.json` (shared + server inline).
- [x] **A.1.9** **Hard contract (séma-szintű invariáns)**: a workflow Designer compiler / mentés-time validáció kötelezően ellenőrzi, hogy a workflow **összes** slug-hivatkozó mezőjének (`transitions[].allowedGroups`, `commands[*].allowedGroups`, `elementPermissions.*.*.groups`, `leaderGroups`, `statePermissions.*`, `contributorGroups[].slug`, `capabilities.*`) minden slug-ja szerepel a `requiredGroupSlugs[].slug` halmazban — különben **`unknown_group_slug` error** mentés előtt. Ez nem A.2 finomítás, hanem **adatmodell-szintű invariáns**, amit minden CF write-path és a kliens-oldali compiler is enforce-ol. → kliens-oldali enforcement: [packages/maestro-shared/compiledValidator.js](packages/maestro-shared/compiledValidator.js) + becsatornázva a [WorkflowDesignerPage.jsx](packages/maestro-dashboard/src/features/workflowDesigner/WorkflowDesignerPage.jsx) save flow-ba (a meglévő graph-validátor után). Szerver-oldali enforcement A.2.1 hatáskör — ugyanezt a shared modult fogja hívni a CF write-path.
- [x] **A.1.6** ADR írása: [[Döntések/0008-permission-system-and-workflow-driven-groups]] — Proposed státuszban (2026-05-01). Megvalósítás után Accepted-re vált.
- [x] **A.1.7** [[Szószedet]] bővítés: új "Jogosultsági rendszer" szekció — "felhasználó-csoport", "jogosultság-csoport", "permission slug", "`requiredGroupSlugs[]`", "autoseed", "slug immutable", "`userHasPermission()`", "`groupPermissionSets`", "`empty_required_groups`", "`group_in_use`".
- [x] **A.1.8** [[Komponensek/WorkflowLibrary]] és [[Csomagok/dashboard-workflow-designer]] frissítés: új `requiredGroupSlugs` mező és autoseed flow leírása + `userHasPermission()` jövőbeli integráció említése.

#### A.2 Szerver — Workflow-driven groups (paradigmaváltás)

- [x] **A.2.1** A.1.9 hard contract szerver-oldali enforcement-je: `update_workflow` + `create_workflow` + `duplicate_workflow` CF action `unknown_group_slug` 400 error-t ad, ha a workflow összes slug-mezőjének uniója nem subset-je a `requiredGroupSlugs[].slug`-nak. Inline `validateCompiledSlugsInline` helper a `packages/maestro-server/functions/invite-to-organization/src/main.js`-ben (CommonJS másolat a [packages/maestro-shared/compiledValidator.js](packages/maestro-shared/compiledValidator.js)-ből — drift-rizikó kommentben jelölve, Phase 2: AST-equality CI teszt).
- [x] **A.2.2** Új `activate_publication` HTTP CF action ([packages/maestro-server/functions/invite-to-organization/src/main.js](packages/maestro-server/functions/invite-to-organization/src/main.js)): pre-aktiválási validáció (workflowId + deadline-fedés) + autoseed minden hiányzó `requiredGroupSlugs` slug-ra `groups` doc (üresen — `slug` + `name`(=label) + `description` + `color` + `isContributorGroup` + `isLeaderGroup` a workflow-ból) + minden slug-ra legalább 1 `groupMembership` check → ha nincs, **409 `empty_required_groups`** + lista. Atomic update `isActivated: true, activatedAt, compiledWorkflowSnapshot, modifiedByClientId: 'server-guard'` (sentinel a post-event `validate-publication-update` skip-jéhez). Opcionális `expectedUpdatedAt` paraméter optimistic concurrency-hez (TOCTOU védelem).
- [x] **A.2.3** Új `assign_workflow_to_publication` HTTP CF action: a hozzárendelés pillanatában is autoseed (`seedGroupsFromWorkflow` helper, idempotens; nem követeli meg a min. 1 tagot — az csak aktiválásnál). `publication_active_workflow_locked` 409 ha aktív pub-on más workflow-ra próbálnak váltani.
- [x] **A.2.4** Snapshot: az `activate_publication` `compiledWorkflowSnapshot`-ja a workflow teljes `compiled` JSON-ját rögzíti — a `requiredGroupSlugs[]` mezővel együtt (A.1.5 óta a `compiled` része). A futó pub immune marad workflow-változásra.
- [x] **A.2.5** `remove_group_member` CF kibővítés: a removal után scan-eli, hogy a csoport üres lett-e + a slug bármely aktív pub `compiledWorkflowSnapshot.requiredGroupSlugs[]`-ben szerepel-e. Ha igen, `warnings: [{ code: 'empty_required_group', slug, affectedPublications }]` mező a response-ban. A művelet engedett (snapshot védi a runtime-ot), best-effort scan (nem blokkol hibára).
- [x] **A.2.6** `update_group_metadata` CF action (`rename_group` aliasként megmarad): `slug` immutable — csak `label` (DB: `name`), `description`, `color`, `isContributorGroup`, `isLeaderGroup` szerkeszthető. Schema-safe fallback: ha az új mezők hiányoznak, csak `name`-update legacy-ként sikerül; vegyes payload + hiányzó schema → 422 `schema_missing` + `bootstrap_groups_schema` hint. Új `bootstrap_groups_schema` action a séma-bővítéshez (`description`, `color`, `isContributorGroup`, `isLeaderGroup`, `archivedAt` + `office_slug_unique` index — a unique index az autoseed duplikátum-védelméhez kötelező, Codex review).
- [x] **A.2.7** Új `archive_group` / `restore_group` action (soft-delete `archivedAt`-tal). `delete_group` és `archive_group` ugyanazt a blocker-set-et használja: blokk, ha bármely **nem-archivált workflow** `requiredGroupSlugs[]` (és minden többi slug-mező — `workflowReferencesSlug` kibővítve) tartalmazza, **VAGY** bármely **aktív publikáció `compiledWorkflowSnapshot`** hivatkozza, **VAGY** `articles.contributors` / `publications.defaultContributors` JSON-mező kulcsként tartalmazza → 409 `group_in_use` + workflows/activePublications/publications/articles listák. Az org-szintű scan (3-way scope a `visibility=organization` workflow-k miatt) a `groups.organizationId` keretén belül marad. **Bootstrap-vákuum**: az autoseed `document_already_exists` skip CSAK akkor véd duplikátumtól, ha az `office_slug_unique` index létezik — a `bootstrap_groups_schema`-t fail-closed elv nélkül futtatni kell az új deploy után (Codex review).
- [x] **A.2.8** `bootstrap_organization` és `create_editorial_office` refactor: a 7-csoport default seedelés (`DEFAULT_GROUPS` const) **kivéve**. Új org/office 0 felhasználó-csoporttal indul; az autoseed flow (A.2.2 / A.2.3) hozza létre a slug-okat aktiváláskor / hozzárendeléskor. `groupsSeeded: false` a response-ban. (Permission set default seed marad — A.3.2.) `packages/maestro-shared/groups.js` `DEFAULT_GROUPS` konstans deprecated kommenttel megtartva (legacy UI-ordering hint a `useContributorGroups`-hoz; a teljes eltávolítás A.4 hatáskör).
- [x] **A.2.9** Dashboard frontend: minden workflow-érintő publikáció-mutáció átkötve a CF actionökre — direkt `databases.updateDocument` megkerülné az autoseedet. (Codex stop-time review KRITIKUS):
  - `GeneralTab.handleActivateClick` → `activate_publication` (`empty_required_groups` 409 / `concurrent_modification` / `invalid_deadlines` UI üzenetek).
  - `GeneralTab.handleWorkflowSelect` → `assign_workflow_to_publication` (autoseed Realtime push-on át mutatja az új csoportokat; `publication_active_workflow_locked` és `workflow_scope_mismatch` UI üzenetek).
  - `CreatePublicationModal.handleSubmit` → új `create_publication_with_workflow` atomic CF action (A.2.10). **Codex stop-time review** (4. iter) jelezte, hogy a két lépéses create+assign kliens-oldali tranziens ablakot teremtett (createPub → assign között a publikáció workflowId nélkül látható Realtime-on át, más tab/derived state csendben null-workflow-val futna). A megoldás: szerver-oldali atomicity — egyetlen CF call, ami a publikáció create-jét + autoseedet egy tranzakcióban végzi (rollback `deleteDocument`-tel ha az autoseed bukik). A layout-create az atomic CF UTÁN, best-effort.
  - `AuthContext.activatePublication` + `assignWorkflowToPublication` callback-ek hozzáadva. `callInviteFunction` propagálja a teljes response-t (`response`) és a kulcsmezőket (`slugs`, `errors`, `unknownSlugs`) az error-ra.
  - **Lokális state patch a CF success után** ([DataContext.applyPublicationPatchLocal](packages/maestro-dashboard/src/contexts/DataContext.jsx)): a 3 hívási hely (`activate`, `workflowSelect`, `createModal`) CF response után `setPublications`-t patchel a kulcsmezőkkel (`workflowId`, `isActivated`, `activatedAt`), hogy a UI ne kelljen várjon a Realtime push-ra. Codex stop-time review KRITIKUS: e nélkül a `success` toast után rövid ideig a régi state látszott a dropdownban / aktiválás-gombnál.
  - **Stale-Realtime védelem** (Codex 2. stop-time review KRITIKUS): a CF actionök mostantól visszaadják a fresh dokumentumot (`response.publication`) az autoritatív `$updatedAt`-tel; a hívóhelyek ezzel patchelnek. `applyPublicationPatchLocal` fallback-ként `new Date().toISOString()`-et tesz a `$updatedAt`-be, ha a hívó csak részleges patchet ad — különben a `isStaleUpdate` ellenőrzés false-t adott volna a CF előtti, késleltetett Realtime push-ra, és a régi state visszaíródna.

#### A.3 Szerver — Permission sets (új réteg)

- [x] **A.3.1** `bootstrap_permission_sets_schema` schema bootstrap CF (A.1.3-ban implementálva — két új collection idempotens létrehozással, `documentSecurity: true`, action-szintű env var guard).
- [x] **A.3.2** `bootstrap_organization` ÉS `create_editorial_office` kibővítés: a kanonikus 3 default permission set seedelése — `owner_base` (Tulajdonos alap, 33 office-scope slug), `admin_base` (Adminisztrátor alap, 33 office-scope slug — tartalom-azonos `owner_base`-szel), `member_base` (Tag alap, 3 slug — `publication.create`, `publication.activate`, `workflow.duplicate`). Új `seedDefaultPermissionSets` helper a [main.js](packages/maestro-server/functions/invite-to-organization/src/main.js)-ben — best-effort failover (Codex review), `permissionSetsSeeded` count + `permissionSetSeedErrors[]` a response-ban. A 5 `org.*` slug NEM kerül permission set-be — azokat a `userHasOrgPermission()` az `organizationMemberships.role`-ból dönti. Csoport-mapping nincs (csoportok workflow-driven autoseed-elnek).
- [x] **A.3.3** `create_permission_set`, `update_permission_set`, `archive_permission_set`, `restore_permission_set` CF action. **Validáció**: a `permissions[]` minden slug-ja office-scope (NEM `org.*`-prefixű) — különben **400 `org_scope_slug_not_allowed`** + a tiltott slug-ok listája. Slug immutable (mint a `groups`); selective update; archive/restore reverzibilis (Codex (b) opció: junction docs intaktan maradnak, archived set-eket a `userHasPermission()` skip-eli). Auth jelenleg org owner/admin — A.3.6 retrofit alatt `userHasPermission('permissionSet.*')`-re cserélődik.
- [x] **A.3.4** `assign_permission_set_to_group`, `unassign_permission_set_from_group` CF action. Cross-office check (400 `office_mismatch`), idempotens (`group_set_unique` index → `already_assigned`/`already_unassigned`). Best-effort warning archivált permission set hozzárendelésekor.
- [x] **A.3.5** `maestro-shared/permissions.js` (ESM, kliens-oldali) + `packages/maestro-server/functions/invite-to-organization/src/permissions.js` (CommonJS, server-only async lookup). **Két helper a két scope-ra**: (a) `userHasPermission(databases, env, user, slug, officeId, snapshotsByOffice?, orgRoleByOrg?)` — office-scope (33 slug): admin label → `organizationMemberships.role === 'owner'`/`admin` → permission set lookup (`groupMemberships` × `groupPermissionSets` × `permissionSets.permissions[]`, `archivedAt === null` szűrt). Throw `org.*` slugra. (b) `userHasOrgPermission(databases, env, user, slug, orgId, orgRoleByOrg?)` — org-scope (5 slug): admin label → `organizationMemberships.role`. Throw NEM `org.*`-ra. Plus: `buildPermissionSnapshot()` (egyszer számol per office), `validatePermissionSetSlugs()` (defense-in-depth), `createPermissionContext()` (per-request scaffold). Drift-rizikó kommentelve (CF inline duplikáció, Phase 2 / A.7.1: AST-equality CI test).
- [x] **A.3.6** Meglévő CF-ek refactor: a megfelelő scope-helperrel guard. 29 hívás, **24 office-scope** + **3 org-scope** + **2 dual-check** (`create_publication_with_workflow` mindkét slug). Új `403 insufficient_permission` reason `{slug, scope, requiresOwnership?}` mezőkkel. **2 BREAKING**: (a) `update_organization` admin elveszti (`org.rename` owner-only); (b) frontend toast-ok generic-be esnek vissza, amíg az A.4 nem áll át. **Codex final review fix-ek**: (1) `callerUser.labels` betöltés `x-appwrite-user-labels` header-ből (különben a globális admin shortcut halott kód), (2) `workflow.share` slug bekötve a `update_workflow_metadata` visibility-ágon ÉS a `create_workflow` non-default visibility-jánál (Codex sign-off ship-blocker fix), (3) `not_workflow_owner` reason cserélve `insufficient_permission`-re a contract-egységesítéshez. **Szándékos kivételek**: `create_editorial_office` (még nincs officeId), `bootstrap_*_schema`/`backfill_tenant_acl` (owner-only schema), `accept`/`decline_invite`/`leave_organization`/`list_my_invites` (saját önkezelő). A meglévő `update-article` state-permission változatlan (workflow-runtime).
- [x] **A.3.7** Cache stratégia — server-side rész implementálva: **per-request memoizáció** a `createPermissionContext()`-tel (`{ snapshotsByOffice: Map, orgRoleByOrg: Map }`). A CF entry-pointja az A.3.6 retrofit során fogja hívni. **Kliens-oldali office-scope cache** + Realtime invalidáció A.4 (Dashboard) és A.5 (Plugin) hatáskör — `user.permissions: Set<string>` snapshot.

#### A.4 Dashboard UI (Editorial OS dark v2 stílusban — lásd C blokk)

- [x] **A.4.1** + **A.4.5** + **A.4.2** Felhasználó-csoportok tab refactor — az `EditorialOfficeGroupsTab.jsx` átalakítva `GroupRow.jsx`-szel: kibontható szerkesztő (label/description/color/isContributorGroup/isLeaderGroup, slug immutable), permission set assign multi-select, csoport detail panel (workflow-hivatkozások listája + üres-csoport warning + parse-error worst-case jelzés), archive/restore/delete + confirm-dialog. Default-group védelem eltávolítva (CF a forrás). 9 új AuthContext callback (`updateGroupMetadata`, `archiveGroup`/`restoreGroup`, `assignPermissionSetToGroup`/`unassignPermissionSetFromGroup` + permission set CRUD).
- [x] **A.4.3** + **A.4.4** Új tab "Jogosultság-csoportok" — `PermissionSetsTab.jsx` (lista, létrehozás, archive/restore, csoport-hozzárendelés-számláló) + `PermissionSetEditor.jsx` (modal, 8 logikai csoport-fa + 38 checkbox, "Mind be / Mind ki" csoport-toggle, org-scope szekció disabled + tooltip, slug immutable szerkesztéskor + auto-suggest létrehozáskor, `expectedUpdatedAt` TOCTOU guard, legacy `org.*` slug warning + szűrés mentésnél).
- [x] **A.4.6** Workflow Designer `requiredGroupSlugs[]` szerkesztő — új `RequiredGroupSlugsField.jsx` (sor-szintű slug+label+color+isContributor+isLeader+description). `WorkflowPropertiesEditor.jsx` átírva: a régi külön `leaderGroups` MultiSelect + read-only `contributorGroups` listázás eltávolítva — a flag-ek a sorokban vannak. `WorkflowDesignerPage.availableGroups` source-csere: `metadata.requiredGroupSlugs[].map(g => g.slug)` (nem `metadata.contributorGroups`). `compiler.js`: a `metadata.leaderGroups` backwards-compat overwrite ág megszűnt — a kanonikus `metadata.requiredGroupSlugs[]` zsírosan megy a save-en. `isReadOnly` flag átadva a workflow-szintű editor-ba (state/transition editor-ok read-only UX kibővítése külön task).
- [x] **A.4.7** Realtime — `useTenantRealtimeRefresh.js` `CHANNELS` 5-re bővítve: `groups`, `groupMemberships`, `organizationInvites`, `permissionSets`, `groupPermissionSets`. A meglévő scope-szűrés (`payload.editorialOfficeId === scopeId`) változatlan. Plus `useContributorGroups.js` saját Realtime listener-t kapott a `groups` és `groupMemberships`-re — más tab / másik user változása azonnal tükröződik a contributor dropdown-okban.
- [x] **A.4.8** Aktiválás-flow modal — új `EmptyRequiredGroupsDialog.jsx`. A `GeneralTab.handleActivateClick` `empty_required_groups` 409 ágában modal jelenik meg (slug → label feloldás a workflow `compiled.requiredGroupSlugs[]`-ből), "Tagok hozzáadása" CTA közvetlenül megnyitja az `EditorialOfficeSettingsModal`-t a `groups` tab-on (modal-stack-en át, parent settings modal megmarad). A többi reason (`concurrent_modification`, `invalid_deadlines`) toast-ban marad.
- [x] **A.4.9** `useContributorGroups` refaktor — `DEFAULT_GROUPS` import eltávolítva. Új opcionális `orderingSlugs` paraméter: a publikáció `compiledWorkflowSnapshot.requiredGroupSlugs[]` index-rendezése (fallback `$createdAt` ascending). Metadata: `description`, `color`, `isContributorGroup`, `isLeaderGroup`, `archivedAt`. Cache: 5-perces TTL eltűnt — Realtime invalidálja. `ContributorsTab.jsx` szűr: csak `isContributorGroup === true` csoportok ajánlhatóak, de a meglévő `defaultContributors[slug]` hozzárendelések (akár archived, akár legacy nem-contributor) láthatóak maradnak "archivált" / "nem-contributor" badge-dzsel, hogy a felhasználó el tudja távolítani őket. Reconnect-time WS resync külön task (`realtimeBus` jelenleg nem kezeli a disconnect-window alatt elveszett event-eket).

#### A.5 Plugin — runtime integráció

- [x] **A.5.1** [[Komponensek/UserContext|UserContext]] `enrichUserWithGroups()` bővítése: `permissionSets` betöltés + `user.permissions` array kiszámítása. → új `enrichUserWithPermissions(userData, officeId, previousPermissions)` Provider-szintű helper + 5 modul-szintű async lookup ([UserContext.jsx](packages/maestro-indesign/src/core/contexts/UserContext.jsx)). **Tri-state `user.permissions: string[] | null`** (loading=null). A server `buildPermissionSnapshot` lépéseit replikálja: label admin → orgRole owner/admin shortcut → office cross-check → `groupMemberships × groupPermissionSets × permissionSets` paginált+chunked. **Drift-rizikó (A.7.1)** kommentelve. Hibakezelés: a belső lookupok DB-hiba esetén dobnak; `enrichUserWithPermissions` catch-ágon `previousPermissions ?? null` fallback (Codex közbenső review ship-blocker fix).
- [x] **A.5.2** `useElementPermission` és társai: `groupSlugs` (megmarad — workflow-runtime) + `user.permissions` (új réteg) együtt értékelve. → új `useUserPermission(slug)` és `useUserPermissions(slugs)` hookok ([useElementPermission.js](packages/maestro-indesign/src/data/hooks/useElementPermission.js)) a shared `clientHasPermission`-re alapozva. Tri-state `loading: true` ha `user.permissions === null`. A meglévő workflow-runtime hookok változatlanok — feature-ready API, UI-bekötés (NICE-TO-HAVE) nincs konkrét fogyasztóval.
- [x] **A.5.3** Realtime: dashboard-on csoport → permission-set csere → plugin újraértékelés. → új MaestroEvent `permissionSetsChanged` ([maestroEvents.js](packages/maestro-indesign/src/core/config/maestroEvents.js)). UserContext új Realtime subscribe a `permissionSets` + `groupPermissionSets` csatornákra (200ms debounce, scope-szűrt). A `groupMembershipChanged` és `scopeChanged` MaestroEvent listenerek mostantól `refreshGroupSlugs` mellett `refreshPermissions`-t is hívnak. Recovery (`dataRefreshRequested`) a `hydrateUserWithMemberships`-en keresztül paralel újraszámolja mindkét réteget.
- [x] **A.5.4** Plugin `useContributorGroups` refaktor ([useContributorGroups.js](packages/maestro-indesign/src/data/hooks/useContributorGroups.js)): mint A.4.9, plugin oldalon — `compiledWorkflowSnapshot.requiredGroupSlugs[]` index-rendezés + metadata a `groups` collection-ből. `DEFAULT_GROUPS` import eltávolítása. + Realtime subscribe a `groups` és `groupMemberships` csatornákra (100ms debounce); 5p TTL eltűnt; metadata mezők (`description`, `color`, `isContributorGroup`, `isLeaderGroup`, `archivedAt`); archivált csoportok megmaradnak; `dataRefreshRequested` (recovery) a Plugin dual-proxy reconnect ablakát fedi le. Hívóhelyek: [ArticleProperties.jsx](packages/maestro-indesign/src/ui/features/articles/ArticleProperties/ArticleProperties.jsx) és [ContributorsSection.jsx](packages/maestro-indesign/src/ui/features/articles/ArticleProperties/ContributorsSection.jsx) `orderingSlugs = workflow?.requiredGroupSlugs?.map(g => g.slug)`-szel hívják. ContributorsSection mostantól csak `isContributorGroup === true && !archivedAt` csoportokra ad dropdown-t; a meglévő `article.contributors[slug]` legacy / archivált / ismeretlen slug-ok megőrződnek `(legacy)` / `(archivált)` / `(ismeretlen)` badge-dzsel.
- [x] **A.5.5** TOCTOU `expectedUpdatedAt` opt-in a Plugin-oldali aktiváló-ban — **N/A**. A Plugin nem hív `activate_publication` CF-et: csak `isActivated=true` publikációkat lát ([DataContext.jsx](packages/maestro-indesign/src/core/contexts/DataContext.jsx) `Query.equal('isActivated', true)`), az aktiválás a Dashboard `GeneralTab` hatásköre (A.2.9-ben már kész). Ha jövőbeli (Fázis 6+) plugin flow aktivál, a Dashboard-mintát kell követni.

#### A.6 Smoke teszt

- [ ] **A.6.1** Manuális 2-tab smoke: workflow létrehozás új slug-okkal → kiadvány hozzárendelés → autoseed verifikálás → tag-hozzáadás → aktiválás → plugin Realtime.
- [ ] **A.6.2** Aktivált pub közbeni tag-eltávolítás: a snapshot védi a runtime-ot; UI warning + notification.
- [ ] **A.6.3** Adversarial: backend-bypass (kliens nem tud átírni állapotot ha hiányzik a jogosultság), `rowSecurity: true` cross-tenant izoláció. `slug` immutable enforcement (DevTools-ból se módosítható).

#### A.7 — Phase 2 / halasztott tételek

- [x] **A.7.1** CompiledValidator drift megoldva (2026-05-03, single-source build-step refactor). A [packages/maestro-shared/compiledValidator.js](packages/maestro-shared/compiledValidator.js) (ESM) marad a kanonikus forrás; a [scripts/build-cf-validator.mjs](scripts/build-cf-validator.mjs) generátor ESM → CommonJS textuális transzformációval generálja a [packages/maestro-server/functions/invite-to-organization/src/helpers/_generated_compiledValidator.js](packages/maestro-server/functions/invite-to-organization/src/helpers/_generated_compiledValidator.js)-t (committed, banner-rel). A wrapper [helpers/compiledValidator.js](packages/maestro-server/functions/invite-to-organization/src/helpers/compiledValidator.js) re-export-ot ad; a [main.js](packages/maestro-server/functions/invite-to-organization/src/main.js) 3 hívása `validateCompiledSlugsInline` → `validateCompiledSlugs` átnevezve. Yarn scriptek: `build:cf-validator` (regenerál) és `check:cf-validator` (drift-detect, exit 1 mismatch-re). Post-transform token-guard a generátorban: ha a forrásba `import`/`export`/dynamic `import()`/top-level `await` kerül, a generálás fail-closed dob.
- [ ] **A.7.2** **Plugin `useUserPermission` "deny on loading" API revizit** (Codex adversarial review #1, halasztott design question): a `useUserPermission(slug)` jelenleg `{ allowed: boolean, loading: boolean }`-t ad, és `clientHasPermission(null, slug) === false` miatt a hidratálatlan állapot effektíve "denied"-ként jelenik meg. Amikor egy plugin oldali UI tényleg permission-set guardot kíván (B blokk vagy későbbi fázis), érdemes átállni `{ status: 'loading' | 'allowed' | 'denied' }` enum return-re — egyértelmű state, és a fogyasztó nem felejtheti el a `loading` flag-et. → [packages/maestro-indesign/src/data/hooks/useElementPermission.js](packages/maestro-indesign/src/data/hooks/useElementPermission.js) `useUserPermission` és `useUserPermissions`. Triggerelje az első valódi UI consumer (jelenleg 0).
- [ ] **A.7.4** **Schema bootstrap drift-detection** (Codex adversarial B.1 2026-05-04 Medium, halasztott cross-cutting refactor): a `bootstrap_workflow_schema`, `bootstrap_publication_schema`, `bootstrap_groups_schema`, `bootstrap_permission_sets_schema`, `bootstrap_workflow_extension_schema` action-ök a 409 / "already exists" választ jelenleg `skipped`-re fordítják, de NEM ellenőrzik, hogy a meglévő attribute / index shape-je (size, default, enum elements, type, attrs-array) megegyezik-e az elvárttal. Egy korábbi részleges-bukás vagy manuális Console-edit silent drift-et okozhat: a replay `success: true`-t ad, miközben a séma divergens. **Megoldás**: a 409 ágban `databases.getAttribute(...)` / `getIndexes(...)` lookup → shape-ekvivalencia check → eltérésre `schema_drift_detected` 500 + `expected` / `actual` payload (NEM `skipped`). A 5 action közös pattern-je egyetlen helper-be (`assertAttributeMatches`, `assertIndexMatches`) emelhető a [helpers/](packages/maestro-server/functions/invite-to-organization/src/helpers/) alá. **Nem akut**: a meglévő minta és a "nincs migráció" alapelv mellett dev-env drift dobható; production-szintű deploy hardening előtt érdemes triggerelni.

- [ ] **A.7.3** **`permissions.js` shared/CF inline duplikáció single-source build-step** (B.0.2 follow-up, A.7.1 minta): a [packages/maestro-shared/permissions.js](packages/maestro-shared/permissions.js) ESM modul slug-katalógusa (`ORG_SCOPE_PERMISSION_SLUGS`, `OFFICE_SCOPE_PERMISSION_SLUGS`, `PERMISSION_GROUPS`, `DEFAULT_PERMISSION_SETS`, `validatePermissionSetSlugs`, `clientHasPermission`) és a [packages/maestro-server/functions/invite-to-organization/src/permissions.js](packages/maestro-server/functions/invite-to-organization/src/permissions.js) CommonJS inline duplikációja drift-rizikót jelent (új slug, default set változás). Megoldás: új `scripts/build-cf-permissions.mjs` ESM → CJS textuális transzformációval, a shared modul kanonikus marad; a CF `permissions.js` egy új `_generated_permissionsCatalog.js`-t require-ol, az async helperek (`userHasPermission`/`userHasOrgPermission`/`buildPermissionSnapshot`) változatlanok maradnak. Yarn scriptek `build:cf-permissions` + `check:cf-permissions` (drift-detect). Post-transform token-guard 4 ESM-szintaxisra (export/import-from/dynamic import/top-level await), fail-closed throw. Triggerelje, mielőtt új slug-ot adunk a shared modulhoz.

- [ ] **A.7.5** **`extensionContract.js` shared/CF inline duplikáció single-source build-step** (B.2.1 follow-up, B.3 előfeltétel, A.7.1/A.7.3 minta — Codex adversarial review B.2.1 2026-05-04 high finding): a [packages/maestro-shared/extensionContract.js](packages/maestro-shared/extensionContract.js) ESM modul (`EXTENSION_KIND_VALUES`, `EXTENSION_SCOPE_VALUES`, `EXTENSION_SCOPE_DEFAULT`, `EXTENSION_SLUG_REGEX`, `EXTENSION_SLUG_MAX_LENGTH`, `EXTENSION_NAME_MAX_LENGTH`, `validateExtensionSlug`, `isExtensionRef`, `parseExtensionRef`, `MAESTRO_EXTENSION_GLOBAL_NAME`, `EXTENSION_REF_PREFIX`) jelenleg ESM-only, a CF stack (`actions/schemas.js`, `helpers/constants.js`) pedig CommonJS — emiatt a B.3 új CRUD action-jeinek (`create/update/archive_workflow_extension`) az enum/regex/méret-konstansokat és a `validateExtensionSlug`-ot **újra duplikálnia kell**. A jelen állapot egyenértékű a `permissions.js` drift-rizikójával (ld. A.7.3). Megoldás: új `scripts/build-cf-extension-contract.mjs` ESM → CJS textuális transzformációval, a shared modul kanonikus marad; a CF a `helpers/_generated_extensionContract.js`-t require-olja. Yarn scriptek `build:cf-extension-contract` + `check:cf-extension-contract` (drift-detect, exit 1 mismatch-re). Post-transform token-guard 4 ESM-szintaxisra (export/import-from/dynamic import/top-level await), fail-closed throw — A.7.1 minta. **Triggerelje a B.3 indítása előtt** (vagy ekkor együtt), különben a B.3 inline duplikációval indul drift-kommenttel (ami elfogadható átmenet, de A.7.5-re escalálódik).

---

### B. Workflow Extensions ([[Döntések/0007-workflow-extensions|ADR 0007]] Phase 0)

> Az A blokk után indítható. Az extension-CRUD permission az új rendszerbe kerüljön (B.0.2).

#### B.0 Tervi tisztázás

**Eldöntve (2026-05-03, Codex review):**

- [x] **B.0.1 — `paramSchema` mező halasztva Phase 1+-ba.** A `workflowExtensions` collection Phase 0-ban NEM kap `paramSchema` mezőt — a Designer textarea editort kínál, az ExtendScript `code` maga kódolja a logikáját. **Codex egy szélesebb körű scope-szűkítésre is figyelmeztetett (B.0.4)**: a Phase 0 nemcsak a `paramSchema`-t, hanem a teljes per-workflow extension-paraméterezést sem támogatja (`ValidationListField`/`CommandListField` nem szerkeszt extension-`options`-t, a Plugin runtime sem továbbít user-szerkesztett options-t). MVP-ben az extension `code`-ja önálló, kötött I/O kontraktusú logika; az `options` argumentum extension-eknek üres / nem továbbított.
- [x] **B.0.2 — Extension-CRUD a permission-fában (NEM admin-only flag).** A három slug (`extension.create / extension.edit / extension.archive`) már része a 33 office-scope slug-katalógusnak ([packages/maestro-shared/permissions.js:84-87](packages/maestro-shared/permissions.js)) és a `owner_base` + `admin_base` default permission set-nek ([permissions.js:222](packages/maestro-shared/permissions.js), [permissions.js:228](packages/maestro-shared/permissions.js)); a `member_base` set **szándékosan** NEM kapja meg, mert az extension-kód CRUD magasabb trust-szintű office-művelet ([[Komponensek/PermissionTaxonomy#5. Bővítmények — extension.*]] már így dokumentált). A B.3 új CF action-jei (`create/update/archive_workflow_extension`) `userHasPermission(databases, env, user, 'extension.create', officeId)` guardot fognak hívni. **Egy doc-frissítés maradt**: az [[Döntések/0007-workflow-extensions|ADR 0007]] Phase 0 szekciójában az "Admin-only CRUD a Workflow Designer egy új tabján" → "Permission-based CRUD (`extension.*` office-scope slug-okkal)"; a Phase 1+ "Jogosultsági integráció" pont törölve / "már Phase 0-ban kész A.3 retrofit-ben" megjegyzéssel. Külön track (NEM B.0): a `permissions.js` shared/CF inline duplikációra single-source build-step kell az A.7.1 mintára — új feladat-pont az [[Feladatok#A.7]] alatt: **A.7.3** (`scripts/build-cf-permissions.mjs`).
- [x] **B.0.3 — CF action-bontás (inkrementális, C opció).** A `main.js` 6964 sor / 36 action handler szétbontása 7-8 `actions/*.js` modulra B előtt és közben, **commit-családonként deploy-tesztelve**. Codex (C) opciót preferálta a regressziós kockázat lokalizálásáért. A modul-térkép változatlan (ld. lent), a B.3 új `actions/extensions.js`-e az új struktúrába illeszkedik.
- [x] **B.0.4 — Phase 0 hatókör-szűkítés rögzítése (Codex flag, KRITIKUS).** A workflow extension Phase 0 MVP-ben **nincs per-workflow paraméter-átadás**: az ExtendScript `code` önálló logikát kódol; a Designer `ValidationListField` visszacsatolásnál el is dobja az ismeretlen `options` mezőt ([ValidationListField.jsx:36-40](packages/maestro-dashboard/src/features/workflowDesigner/fields/ValidationListField.jsx)); a `CommandListField` csak `{ id, allowedGroups }` alakot kezel ([CommandListField.jsx:16-18](packages/maestro-dashboard/src/features/workflowDesigner/fields/CommandListField.jsx)); a Plugin command runtime csak `cmd.id`-t propagál ([PropertiesPanel.jsx:37-44](packages/maestro-indesign/src/ui/features/workspace/PropertiesPanel/PropertiesPanel.jsx), [commands/index.js:28-39](packages/maestro-indesign/src/core/commands/index.js)). A futtatott `options` argumentum extension-eknek MVP-ben üres / nincs továbbítva. Phase 1+ kibővítés (paramSchema + Designer szerkesztő + plugin options-átadás) az [[Döntések/0007-workflow-extensions|ADR 0007]] Phase 1+ szekciójába rögzítendő.

**B.0.3 részletes terv (inkrementális split)**:

  1. **B.0.3.0 — előfeltétel** (KRITIKUS, Codex flag): a `main.js`-ben élő központi utilok (`VALID_ACTIONS`, `fail()`, `slugifyName()`, `sanitizeString()`, `HUN_ACCENT_MAP`, `EMAIL_REGEX`, `SLUG_REGEX`, `SLUG_MAX_LENGTH`, `NAME_MAX_LENGTH`, `INVITE_VALIDITY_DAYS`, `TOKEN_BYTES`, `DEFAULT_WORKFLOW`) kiszervezése `helpers/util.js` (vagy `helpers/sanitize.js` + `helpers/actionRegistry.js` bontásban) modulba. Enélkül az új `actions/*.js` modulok visszaimportálnák a `main.js`-ből, és CommonJS ciklikus require fél-inicializált exportot adna. Önálló commit, mechanikus refactor + smoke.
  2. **B.0.3.a-h** — action-családonként szétbontás, mindegyik egy commit + deploy + smoke. Sorrend: schemas → orgs → invites → groups → permissionSets → workflows → offices → publications. Az `actions/extensions.js` (új) a B.3 hozza, az új struktúrában indulva.
  3. **Action-router** a `main.js`-ben: `const actionHandlers = { 'create_workflow': workflows.createWorkflow, ... };` map + lookup → `await actionHandlers[action]({ databases, env, log, error, payload, callerId, callerUser, permissionContext })`.
  4. **Modul-térkép** (változatlan a Codex review után):
      - `actions/orgs.js` — `bootstrap_organization`, `create_organization`, `update_organization`, `delete_organization`
      - `actions/invites.js` — `create`, `accept`, `decline_invite`, `list_my_invites`
      - `actions/groups.js` — `add/remove_group_member`, `create/update_group_metadata`/`rename_group`, `archive/restore/delete_group`
      - `actions/permissionSets.js` — 6 action (`create/update/archive/restore_permission_set`, `assign/unassign_permission_set_to_group`)
      - `actions/workflows.js` — 7 action (`create/update/update_metadata/archive/restore/delete/duplicate_workflow`)
      - `actions/offices.js` — `create/update/delete_editorial_office`, `leave_organization`
      - `actions/publications.js` — `create_publication_with_workflow`, `assign_workflow_to_publication`, `activate_publication`
      - `actions/schemas.js` — 4 `bootstrap_*_schema` + `backfill_tenant_acl`
      - `actions/extensions.js` — **B.3 új extension-CRUD action-ök** (új mappa)
  5. **Tilos import-irány**: `main.js` → `actions/*` → `helpers/*` → `permissions.js` / `teamHelpers.js`. Visszafelé NEM (Codex flag: CommonJS ciklikus require fél-inicializált exportot ad).
  6. **Becsült végső állapot**: `main.js` ~300-400 sor (env init + `permissionContext` + action-router), `actions/*` 7-8 modul × 500-1000 sor, `helpers/*` változatlan + új `helpers/util.js`. Komment-anyag teljesen megőrzött.
  7. **Párhuzamosíthatóság**: B.0.3.0 + B.0.3.a-h független B.1-B.5-től (csak action-fájl elhelyezést érint). Indítható **párhuzamosan** B.1+B.2+B.4-gyel. Csak B.3 függ tőle (a new `actions/extensions.js` megjelenése).

**B.0.3 KÉSZ (2026-05-04, 14 commit, push-elve `feature/maestro-redesign`)**: a teljes inkrementális split + dispatch table végrehajtva. `main.js` 6964 → 560 sor (-91.9%). 8 új `actions/*.js` modul (~6630 sor összesen) + új `helpers/util.js` (B.0.3.0 előfeltétel, 120 sor). Az `ACTION_HANDLERS` dispatch table (`main.js`) az `alias-okkal együtt fedi a `VALID_ACTIONS` set teljes halmazát; a require-load-time drift-check (`main.js` cold start fail-fast) szigorúan érvényesíti a kétirányú konzisztenciát. Minden lépés Codex review-val (commit-családonként); a `deleteWorkflow` `public` visibility cross-org publication scan preexisting bug-ja fix-elve a B.0.3.f follow-up commit-ban (3-way visibility switch + `editorial_office` fallback). A teljes branch-en külön Codex harden 3-way review (`/codex:review` + Claude subagent CLEAN; adversarial 55+ perc-en cancelled diff-méret miatt) — egy P2 finding (`unknown visibility` fallback `editorial_office` → SZŰKEBB scan, fail-closed jelentés cross-org delete-blocker számára kiderült) javítva: fallback `'public'`-re (legszélesebb scan). A B.3 új `actions/extensions.js` az új struktúrába illeszkedik.

#### B.1 Adatmodell

- [x] **B.1.1** `bootstrap_workflow_extension_schema` CF action (2026-05-04). Owner-only idempotens schema-create az új `workflowExtensions` collection-re (`documentSecurity: true`, doc-szintű team ACL). Attribútumok (10 db): `name`, `slug`, `kind` (enum: `validator|command`), `scope` (enum: **csak `article` Phase 0-ban**, default `article`), `code` (~1 MB), `visibility` (enum 3-way), `archivedAt` (nullable), `editorialOfficeId`, `organizationId`, `createdByUserId`. **`paramSchema` SZÁNDÉKOSAN kimaradt** (B.0.1 Phase 1+ halasztás); a `scope` enum is fail-closed `['article']`-re szűkítve a Codex adversarial review (B.1 2026-05-04 Medium fix) nyomán — a Phase 1+ `publication` scope egy `updateEnumAttribute`-tal kerül be (a `bootstrap_workflow_schema` `public` visibility late-add mintája), így a B.3 CRUD action-nek nem kell explicit guardot adnia. Indexek: `office_slug_unique`, `office_idx`, `org_idx`. Új env var `WORKFLOW_EXTENSIONS_COLLECTION_ID` Phase 0-ban action-szintű guard alatt. → [packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js](packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js) `bootstrapWorkflowExtensionSchema`. Új enum-konstansok ([helpers/constants.js](packages/maestro-server/functions/invite-to-organization/src/helpers/constants.js)): `EXTENSION_KIND_VALUES`, `EXTENSION_SCOPE_VALUES`, `EXTENSION_SCOPE_DEFAULT`. **Deploy után**: Console-on `rowSecurity: true` flag bekapcsolása a `workflowExtensions` collection-ön (különben a doc-szintű ACL nem érvényesül).
- [x] **B.1.2** ACL helper: új `buildExtensionAclPerms(visibility, organizationId, editorialOfficeId)` a [packages/maestro-server/functions/invite-to-organization/src/teamHelpers.js](packages/maestro-server/functions/invite-to-organization/src/teamHelpers.js)-ben (2026-05-04). Belső `buildVisibilityAclPerms(who, ...)` helper-re delegál; a `buildWorkflowAclPerms` is ezt hívja DRY-an, az API változatlan a meglévő hívóhelyekre. 3-way visibility (ADR 0006/0003 minta): `editorial_office` → office team, `organization` → org team, `public` → `users()` role. A `who` paraméter a hibaüzenet stack trace-ébe teszi a hívó helper-nevet.

#### B.2 Shared kontraktus

- [x] **B.2.1** `packages/maestro-shared/extensionContract.js` (2026-05-04). Slim Phase 0 kontraktus-modul: konstansok (`MAESTRO_EXTENSION_GLOBAL_NAME='maestroExtension'`, `EXTENSION_REF_PREFIX='ext.'`, `EXTENSION_KIND_VALUES`, `EXTENSION_SCOPE_VALUES`, `EXTENSION_SCOPE_DEFAULT`, `EXTENSION_SLUG_REGEX`, `EXTENSION_SLUG_MAX_LENGTH=64`, `EXTENSION_NAME_MAX_LENGTH=100`); `validateExtensionSlug(slug)` whitespace-érzékeny single-slug error-akkumulátor (`invalid_slug_type`/`empty_slug`/`slug_too_long`/`slug_format_invalid` code-ok); `parseExtensionRef(ref)` kanonikus parser + `isExtensionRef(ref)` boolean projekciója (string-only). JSON I/O szerződés táblázatos JSDoc-formában dokumentálva (validator/command kind input/output shape). **Publikus felület**: a [packages/maestro-shared/package.json](packages/maestro-shared/package.json) `exports` blokkjába **két key** regisztrálva — `./extensionContract` (kanonikus, suffix nélküli, a meglévő `permissions`/`workflowRuntime`/stb. mintáját követi) ÉS `./extensionContract.js` (`.js` suffix-szel, a repo-konvenciót — `from "maestro-shared/permissions.js"` — Node.js direct import-on is támogatja). A duplikálás oka: a meglévő bejegyzések csak suffix nélküli key-ekkel, a fogyasztói kód viszont `.js` suffix-szel importál — a bundler (webpack/vite) figyelmen kívül hagyja a `exports`-t és fájlrendszerről resolve-ol, de Node.js direct import (CF B.3, build-step generátorok, test runner-ek) `ERR_PACKAGE_PATH_NOT_EXPORTED`-tel elhasalna; a fogyasztói formát fail-fast-ban tartani fontos. (Codex stop-time review 2026-05-04 első fix az `./extensionContract` key + második fix a `.js` suffix-os formára — a meglévő modulok analóg drift-je külön cleanup task scope-ban.) **Codex tervi roast (2026-05-04)** szándékosan kihagyatta a `validateValidatorOutput`/`validateCommandOutput` shape-checkereket — azok B.4 plugin runtime hatáskör (első valódi consumer ott jön). **Phase 0 hatókör-szűkítés (B.0.4)** a fájl-headerben rögzítve: per-workflow `options` MVP-ben üres / nem továbbított. **Drift-rizikó** explicit `SYNC WITH:` jelzéssel három server-fájlra (helpers/constants.js enum-duplikáció, actions/schemas.js 64/100 méret-hardcode, helpers/util.js slug-regex/maxlength tükör) — Phase 2 single-source build-step **A.7.5**-ben rögzítve (B.3 előfeltétel, A.7.1/A.7.3 minta). **Codex harden pass CLEAN**: bázis review nincs bug, adversarial 1 high finding (ESM/CJS drift) → A.7.5-be follow-up, simplify pass 3 cleanup (comment-attribúciók, validator redundáns disjunkt, parseExtensionRef inline-ja `isExtensionRef`-fel duplikált slice helyett); verifikáló Codex CLEAN.

#### B.3 Szerver CF

- [x] **B.3.1** `create_workflow_extension`, `update_workflow_extension`, `archive_workflow_extension` CF action (2026-05-04). Új modul [actions/extensions.js](packages/maestro-server/functions/invite-to-organization/src/actions/extensions.js). `restore_workflow_extension` SZÁNDÉKOSAN kimaradt (Codex tervi review scope-drift védelmében — Phase 1+ fogja eldönteni). Phase 0 visibility csak `editorial_office` (`unsupported_visibility` 400 non-defaultra), `extension.share` slug nincs (privilege-eszkalációs felület lezárva). `slug` immutable a többi domain-objektum mintáját követve. `office_slug_unique` index → 409 `extension_slug_taken`. `expectedUpdatedAt` TOCTOU guard. **Auth-sorrend (Codex P1#3 fix)**: fetch → auth → TOCTOU → idempotens early-return → update — különben a 409 `actual: $updatedAt` existence/timestamp oracle lenne unauthenticated callernek. **Implicit restore kettős auth (Codex P1#2 fix)**: `update_workflow_extension` `archivedAt: null` payload mellett `extension.archive` slug is szükséges (különben az `extension.edit`-jogosult, de archive-jogtalan user megkerülné a permission split-et). `WORKFLOW_EXTENSIONS_COLLECTION_ID` env var globális fail-fast-ba emelve ([main.js](packages/maestro-server/functions/invite-to-organization/src/main.js)).
- [x] **B.3.2** Kontraktus-validáció: `acorn` ECMA3 pre-parse (új `^8.16.0` dep) + AST-szintű FunctionDeclaration check (Codex P1#1 fix — regex shape-check önmagában nem elég, egy stringbe ágyazott `"function maestroExtension"` substring átengedte volna). A `Program.body` tetején pontosan **EGY** top-level `FunctionDeclaration` `id.name === 'maestroExtension'`-szel kötelező (`missing_maestro_extension_function` / `duplicate_maestro_extension_function`). Per-extension hard cap `EXTENSION_CODE_MAX_LENGTH=256 KB` (a schema 1 MB ceiling 1/4-e — Codex tervi review szigorúbb operatív cap). Smoke-tesztek: ES5 `let` ECMA3 alatt korrektül megbukik (`syntax_error` line/column-mal), nested function / var assignment / string-embedded mind 400.
- [x] **B.3.3** Snapshot bővítés: `activate_publication` CF — `compiledWorkflowSnapshot` mellé `compiledExtensionSnapshot` mentés (2026-05-04). Új helper [helpers/extensionSnapshot.js](packages/maestro-server/functions/invite-to-organization/src/helpers/extensionSnapshot.js) — `extractExtensionRefs` (workflow `compiled` JSON `validations[]` + `commands[]` scan `ext.<slug>` hivatkozásokra, mind string mind `{validator|id, options}` object alakra), `fetchExtensionsForOffice` (paginált office-szűrt + `archivedAt === null` szűrés), `buildExtensionSnapshot` (fail-fast 422 `missing_extension_references` + `extension_kind_mismatch` invariáns: `validations[]` slug → `kind=validator`, `commands[]` slug → `kind=command` + aggregate méret-cap `EXTENSION_SNAPSHOT_MAX_BYTES=800 KB` deterministic JSON serializálás slug-key sortolásban). `bootstrap_publication_schema` action kibővítve a 2-es snapshot mezős loop-pal ([actions/schemas.js](packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js)). Az `activate_publication` új sorrend: parse → buildExtensionSnapshot → idempotens early-return (workflow snapshot ÉS extension snapshot egyezést is figyelembe veszi — egy extension `code` változás újra-aktiválást triggerel) → autoseed → empty check → atomic update mind a 2 snapshot mezővel + SERVER_GUARD sentinel. **Snapshot immutability + direkt API tilalom** ([validate-publication-update/src/main.js](packages/maestro-server/functions/validate-publication-update/src/main.js)): §5c-A direkt API aktiváció (kliens `isActivated` payload + nem-SERVER_GUARD) → fail-closed deaktiválás + minden snapshot null (Codex P1#4 fix — a presence-only check nem elég, mert egy meglévő nem-üres snapshottal stale állapotot lehetne zárolni); §5c-B legacy aktivált pub `compiledExtensionSnapshot` null → fail-closed deaktiválás (első update-jénél); §6b kibővítve `compiledExtensionSnapshot`-ra is (a snapshot-mező kliens-write → deaktiválás + minden snapshot null).

#### B.4 Plugin runtime

- [x] **B.4.1 + B.4.4** Új modul [packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js](packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js) (2026-05-05). `buildExtensionRegistry(snapshot)` parsolja a publikáció `compiledExtensionSnapshot`-ját `Map<slug, {name, kind, scope, code}>`-ba; a kétszintű fail-closed (top-level JSON / nem-objekt → üres Map; per-entry shape skip + logWarn) explicit JSDoc-ban dokumentált. `resolveExtension(registry, slug, expectedKind)` `unknown_slug` / `kind_mismatch` / `no_registry` strukturált error-okkal. `executeExtensionScript(code, input)` (B.4.4) — hex-encoded JSON input + ExtendScript sablon kézi JSON-szerializerrel **host-szintű `{ ok, value | error }` envelope**-ot ad: a user-kód SOSEM érintkezik a wrapperrel, így nincs `__ext_error` sentinel-collision (Codex tervi review Critical fix, 2026-05-05). Az input-parse `JSON.parse`, NEM `eval` (Codex High fix). `dispatchExtensionValidator` / `dispatchExtensionCommand` strict shape-check (`_checkValidatorShape` / `_checkCommandShape`) — a kontraktus-szegő válasz (nem-string `errors[]` elem, nem-bool `isValid` / `success`, nem-string `error` / `message` ha jelen) explicit `[ext.<slug>] invalid_output_shape: ...` hibát ad, NEM csúszik át sikeresként (Codex follow-up Medium fix). **Phase 0 hatókör (B.0.4)**: `options` szándékosan NEM kerül a `maestroExtension(input)`-be — sem validator-, sem command-input-ba; a JSON I/O `{ article }` ill. `{ article, publicationRoot }`.
- [x] **B.4.2** Engine + runner + commands integráció (2026-05-05). [WorkflowEngine.validateTransition](packages/maestro-indesign/src/core/utils/workflow/workflowEngine.js)/`executeTransition` 5./6. paraméterre `extensionRegistry = null` (visszafelé kompatibilis); a `validate(...)` `ctx.extensions` mezőn propagálja. [StateComplianceValidator](packages/maestro-indesign/src/core/utils/validators/StateComplianceValidator.js) switch-be `default` ág: `isExtensionRef(validatorName)` → `_checkExtensionValidator(slug, article, ctx.extensions, results)` → `dispatchExtensionValidator()`. [core/commands/index.js](packages/maestro-indesign/src/core/commands/index.js) `executeCommand` korai `isExtensionRef(commandId)` ág → `dispatchExtensionCommand(context.extensions, ref.slug, { article: context.item, publicationRoot: context.publication?.rootPath ?? null })`; a built-in `COMMAND_REGISTRY` ágat nem érinti. UI bekötés: [ArticleProperties.jsx](packages/maestro-indesign/src/ui/features/articles/ArticleProperties/ArticleProperties.jsx) + [PropertiesPanel.jsx](packages/maestro-indesign/src/ui/features/workspace/PropertiesPanel/PropertiesPanel.jsx) `useMemo(() => buildExtensionRegistry(activePublication?.compiledExtensionSnapshot), [$id, snapshot])` — snapshot-preferáló identitás-deps. PropertiesPanel `commands` memo extension-label override-ja a registry `name` mezőjéből (a `commandRegistry.js` csak built-in slugokat ismer, fallback a slug-ra).
- [x] **B.4.3** Realtime `workflowExtensions` channel + `MaestroEvent.workflowExtensionsChanged` (2026-05-05). [DataContext.jsx](packages/maestro-indesign/src/core/contexts/DataContext.jsx) channel-listához hozzáadva; handler ág **csak debug log + event dispatch** — runtime cache invalidálás NINCS. **Snapshot-only stratégia** (Codex tervi review CLEAN): a Plugin csak `isActivated === true` publikációt lát, és azon a `compiledExtensionSnapshot` immutable + kanonikus (`validate-publication-update` CF §5c-A guardja deaktiválja a snapshot nélkül direktben aktivált pubot, §5c-B legacy fail-closed). Az event Phase 0-ban consumer nélküli — jövőbeli Designer plugin tab vagy non-snapshot fallback számára él. Új `COLLECTIONS.WORKFLOW_EXTENSIONS = 'workflowExtensions'` ([appwriteIds.js](packages/maestro-shared/appwriteIds.js)) + új `MaestroEvent.workflowExtensionsChanged` ([maestroEvents.js](packages/maestro-indesign/src/core/config/maestroEvents.js)).
- [x] **B.4.4** ExtendScript exec — `executeExtensionScript` az `extensionRegistry.js`-ben, ld. **B.4.1 + B.4.4** fenti pontnál.

**B.4 KÉSZ (2026-05-05)**: a teljes Plugin runtime regisztry + dispatch lánc kódba állítva, Codex tervi + záró + follow-up review CLEAN. Két shape-check helper `_checkValidatorShape` / `_checkCommandShape` strict invariáns-szal védi a kontraktus-szegő válaszokat (Codex follow-up Medium fix). DataContext bővítés: `activePublication` derived state expose-olva a Provider value-ban (a registry build inputja az UI-ban); a Realtime channel snapshot-only stratégia mellett no-op runtime, de a kapu nyitva későbbi consumerek számára. WorkflowEngine API-bővítés visszafelé kompatibilis (5./6. paraméter `extensionRegistry = null`); az egyetlen call-site (ArticleProperties) átadja a registry-t. **Megmaradt**: B.5 Dashboard UI (Bővítmények tab + Workflow Designer integráció) + B.6 smoke teszt.

#### B.5 Dashboard UI

- [x] **B.5.1** Új tab: "Bővítmények" ([packages/maestro-dashboard/src/components/organization/WorkflowExtensionsTab.jsx](packages/maestro-dashboard/src/components/organization/WorkflowExtensionsTab.jsx)) — lista, létrehozás, archiválás (2026-05-05). 4. tab az [EditorialOfficeSettingsModal](packages/maestro-dashboard/src/components/organization/EditorialOfficeSettingsModal.jsx)-ban (Codex tervi roast 1-es pont — NEM a Workflow Designerbe; modal-stack és draft-vesztés elkerülése). Archived toggle (mint a permission set-eknél), `isOrgAdmin` UI gate a "+" gombra (Codex 4-es pont). **Implicit restore explicit gombbal** (Codex tervi review fix): a server `update_workflow_extension archivedAt: null` action dupla auth-ot kér (`extension.edit` + `extension.archive`) — UI explicit "Visszaállítás" gomb, NEM az editor save mellékhatása. Helper `collectExtensionSlugsFromCompiled(compiled)` átfut `validations[stateName].{onEntry,requiredToEnter,requiredToExit}` (string vagy `{validator}` alak) + `commands[stateName][].id`-n; `buildWorkflowReferencesBySlug(workflows)` → `Map<slug, [workflowName...]>` az archive-confirm warning-hoz. **Codex stop-time M3 fix**: `unparseable[]` lista a JSON parse-fail workflow-knak — info-banner az Tab tetején, hogy a "0 workflow hivatkozik rá" badge ne legyen silent under-report malformed compiled-on. AuthContext 4 új CRUD wrapper: `createWorkflowExtension`, `updateWorkflowExtension`, `archiveWorkflowExtension`, `restoreWorkflowExtension` (utóbbi az `update_workflow_extension`-t hívja `archivedAt: null` payload-dal). [useTenantRealtimeRefresh](packages/maestro-dashboard/src/hooks/useTenantRealtimeRefresh.js) `OFFICE_CHANNELS` 5→7 elemre nőtt: új `WORKFLOW_EXTENSIONS` + `WORKFLOWS` channel (Codex stop-time M1 fix — workflow-hivatkozás badge-ek frissessége másik tab változásai esetén).
- [x] **B.5.2** Egyszerű textarea editor ([packages/maestro-dashboard/src/components/organization/WorkflowExtensionEditor.jsx](packages/maestro-dashboard/src/components/organization/WorkflowExtensionEditor.jsx)) — `name`, `slug`, `kind` (radio chip: validator/command), `code` mezők (2026-05-05). Phase 0: `scope` és `visibility` UI-ban NEM jelenik meg (server-side enum-fail-closed `'article'` / `'editorial_office'`). **Slug immutable szerkesztéskor** (a többi domain-objektum mintáját követi); auto-slug a name-ből csak új létrehozáskor + `slugTouched=false` esetén. **Default code template a `kind`-nak megfelelően** — kötelező top-level `function maestroExtension(input)` deklaráció + JSON I/O kontraktus kommentben (`extensionContract.js`). `handleKindChange` a template-cserét csak akkor futtatja, ha `code === defaultCodeTemplate(régi kind)` — különben a user munkája megőrzött. **Server parse-error → textarea fókusz/scroll a hibás sorra** (Codex tervi roast blind spot fix): `parseErrorLine` state + useEffect `setSelectionRange + scrollTop`. `errorMessage()` mapping az `invalid_extension_code` server `errors[]`-é tükrözi a line/column info-t. **Codex stop-time M2 fix**: `isDirty` create mode-ban a `code !== defaultCodeTemplate(kind)` check-kel — különben a Submit gomb az első renderből aktív lett volna a non-empty default template miatt. **Codex F-fix**: kind chip tooltip pontosítva edit módban (a `disabled={isEdit}` melletti félrevezető szöveg javítva). `EXTENSION_CODE_MAX_LENGTH = 256 KB` operatív cap (a server `helpers/constants.js`-szel betűre egyező). CSS új blokk: [editorial-office-settings.css](packages/maestro-dashboard/css/features/editorial-office-settings.css) `.workflow-extension-editor*` osztályok (monospace textarea, line-numbers nélkül; CodeMirror Phase 0-ban szándékosan kihagyva — Codex 2-es pont overengineering watch).
- [x] **B.5.3** Workflow Designer integráció: az [ValidationListField](packages/maestro-dashboard/src/features/workflowDesigner/fields/ValidationListField.jsx) és [CommandListField](packages/maestro-dashboard/src/features/workflowDesigner/fields/CommandListField.jsx) a built-in registry mellé az office workflow extension-eket is `ext.<slug>` chip-ként rendereli (2026-05-05). **Single-source props-drilling** (Codex tervi roast 3-as pont): a [WorkflowDesignerPage](packages/maestro-dashboard/src/features/workflowDesigner/WorkflowDesignerPage.jsx) szintjén lapozott fetch (`Query.cursorAfter` + `PAGE_SIZE=100` + `HARD_LIMIT=1000` — Codex stop-time M1 fix a 100-as silent truncate ellen) + Realtime feliratkozás a `WORKFLOW_EXTENSIONS` collection-channelre, scope-szűrő a `payload.editorialOfficeId === workflowOwnerOfficeId`-en. `designerExtensions` lapos `[{$id, slug, name, kind, archivedAt}]` props-on át `PropertiesSidebar` → `StatePropertiesEditor` → 3×`ValidationListField` + `CommandListField`. **Codex stop-time M2 fix**: a Realtime delete-ágat a scope-filter ELŐTT futtatjuk (az Appwrite delete payload szűkített mezőkészlettel jöhet — phantom extension a state-ben). **Stale ref read-only chip** (Codex tervi roast 5-ös pont): a `value`-ban megőrzött `ext.<slug>`-re ami archived/missing, a chip ⚠ jelzéssel marad látható, csak X-szel eltávolítható (különben silent kompromittálódna a workflow megérthetősége). Új CSS chip variánsok: [workflowDesigner.css](packages/maestro-dashboard/src/features/workflowDesigner/workflowDesigner.css) `.designer-chip--extension` (dashed border), `.designer-chip--stale` (warning szín, read-only), `.designer-field__command-name--extension` / `--stale`.

**B.5 KÉSZ (2026-05-05)**: Codex tervi roast (6 pont + blind spot-ok) implementáció előtt, B.5.1+2 Codex stop-time review CLEAN (3 Medium fix javítva: workflows channel, isDirty template, unparseable warning, kind tooltip), B.5.3 Codex stop-time review CLEAN (2 Medium fix javítva: lapozott fetch, delete-ág scope-szűrés). Vite dev szerver build OK, syntax-error nincs (login route hibátlanul renderel). **A.7 lista nem érintett** (a permissions.js / extensionContract.js single-source build-step külön track, A.7.5). A B.6 smoke teszt önálló feladat.

#### B.6 Smoke teszt

> Protokoll + automatizált logikai invariáns: [B6-smoke-test.md](B6-smoke-test.md). Hibrid approach (Codex 2026-05-05): manuális end-to-end checklist + `node scripts/b6-snapshot-invariant.mjs` (31 assert a snapshot-only invariánsra, Codex follow-up review CLEAN — ship verdict 2026-05-05).

- [ ] **B.6.1** End-to-end: extension létrehozás → workflow hivatkozás → publikáció aktiválás → plugin futtatás → eredmény. (Manuális, InDesign + Dashboard + Appwrite — a felhasználó futtatja saját InDesign hoston.)
- [x] **B.6.2** Snapshot-védelem: aktivált publikáció alól az extension módosítás ne fusson le (a snapshot-ban rögzített kód fut). (Kódszintű bizonyítás + automatizált logikai invariáns 2026-05-05 kész — `scripts/b6-snapshot-invariant.mjs` 31/31 OK; a manuális live ellenőrzés opcionális.)

---

### C. Dashboard UI redesign (Editorial OS)

> Az A blokk mátrix UI-jai (A.4) **már Editorial OS dark v2 stílusban** épülnek — a teljes redesign ezután iterál a maradékra. Stitch projekt: `1419785137701042796`.

#### C.0 Tervi tisztázás

**Eldöntve (2026-05-05, Codex review):**

- [x] **C.0.1 — Paralel track, de szigorú gating-gel.** A C.1 (Stitch screen-iteráció + spec finomítás) már most indítható az A/B blokkal párhuzamosan, mert kód-független és a design-tokenek az A.4-en már megerősítettek (`packages/maestro-dashboard/css/tokens.css` dark v2 + light blokk LIVE, `useTheme` hook + `<html data-theme>` bootstrap LIVE). **Kötés**: a C.1 alatt csak Stitch export / annotáció / `_docs/` változás mehet — `packages/maestro-dashboard/css/*` és shared JSX módosítás TILOS, amíg a C.2 nem indul. A **C.2 implementáció** csak [[#A.6 Smoke teszt]] és [[#B.6 Smoke teszt]] manuális GO után indulhat post-smoke `main`-ről, hogy a snapshot/permission regressziók javítása ne keveredjen a UI kódváltásokkal. Commit-rendezés: (1) A.6/B.6 fix-ek külön commitokban, (2) C.1 spec-only branch, (3) "Design-contract sync" commit (`design-system.md` + `CLAUDE.md` ↔ `tokens.css` align — Codex doc/code drift flag), (4) C.2 screen-szintű implementáció commitokkal, (5) light-theme kódfix nem szóródik szét, külön C.2.7 commitokba kerül.
- [x] **C.0.2 — `apply_design_system` baseline minden screenre + screenenkénti kéz-finomítás kötelező.** A baseline screen-ek (Table View, Settings, Auth flow) tisztán tokenes komponenseken futnak (`SegmentedToggle`, `Breadcrumb dropdown`, `Avatar`, `Modal backdrop` — ez utóbbi már LIGHT-AWARE a `tokens.css:160-163`-ban), ott az auto-generálás várhatóan elégséges. **Code-level finomítást igénylő pontok** (Codex review konkrét findingek):
    - **Workflow Designer canvas** ([[packages/maestro-dashboard/src/features/workflowDesigner/WorkflowCanvas.jsx]] sor 91, 102): React Flow `Background dot color="#333"` és `MiniMap maskColor="rgba(0,0,0,0.6)"` hardcoded — third-party `props`-ok nem CSS-tokenből élnek, light témán ronda lesz. Megoldás: komponens-szintű override prop a `tokens.css` `--canvas-dot-color` / `--canvas-mask-color` tokenekkel.
    - **Workflow Designer transition edge** ([[packages/maestro-dashboard/src/features/workflowDesigner/edges/TransitionEdge.jsx]] sor 17-19, 46): `DIRECTION_COLORS` (zöld/narancs/piros) és `selected stroke '#3b82f6'` hardcoded — tokenize előbb, theme-eld utána.
    - **Visibility chip család** ([[packages/maestro-dashboard/css/components/badge.css:71-86]], [[packages/maestro-dashboard/css/features/publication-settings.css:237-265]], [[packages/maestro-dashboard/src/features/workflowDesigner/workflowDesigner.css:217-231]]): ugyanaz a lila/kék paletta 3 helyen másolva — auto-generálás "lokális színfoltokra" essen szét, nem unified theme. Tokenize → theme-eld.
    - **Flatplan spread-kártyák cover-emphasis** ([[packages/maestro-dashboard/css/features/flatplan.css]] 200-215): hangsúly/geometria-probléma (No-Line + cover spread kiemelés) — feature-level override, nem palette-szintű.
    - **State badge soft glow premise részben hibás** (Codex korrekció): a Workflow Designer node-badge-ekben jelenleg sincs glow (csak flat fill), a glow a Table View `state-dot`-ban él ([[packages/maestro-dashboard/css/features/article-table.css:119-126]]) — light témán a drop-shadow-glow-t inkább border-szín-ringre kell cserélni.
    - **Heurisztika `[data-theme="light"]` vs komponens-override**: szemantikai szerepváltozás (background/text/border/shadow/backdrop/accent) → token-szintű light blokk; third-party prop → komponens-override; ismétlődő hardcode 2-3 helyen → előbb tokenize, aztán theme-eld; hangsúly/geometria-probléma → feature-szintű override.
- [x] **C.0.3 — Külön blokk (D blokk, jövőbeli), `t()` wrapper bevezetése a C.2-ben over-engineering.** A 2026-05-01 alapelv ("magyar UI label + angol kódbeli azonosító, kétnyelvű UI külön track") megerősítve. Indok: i18next/react-intl bevezetés + locale-engine + key-stratégia + interpoláció/plural/date-format policy + meglévő szétszórt stringek migrációja **orthogonális** a vizuális redesign-hoz, magas regressziós kockázattal. **Alacsony-költségű felkészülés a C.2-ben (Codex javaslat, elfogadva)**: a C.2-ben **újragyúrt screen-eken** (Table View, Publication Settings, Flatplan, Workflow Designer, Login, Org Settings, Create Publication) a user-facing copy menjen file-local `LABELS` / `COPY` objektumba (NEM inline JSX-stringként). Ez nem i18n, csak copy-hygiene előkészület — a D blokk indulásakor a `LABELS` objektum kulcsai a `t()` keyspace alapja. **Cross-app `t()`-infrastruktúra TILOS C.2-ben** — az csak a D blokk hatáskör.

**Feloldatlan / új follow-up (Codex flag):**

- [x] **C.0.4 — Design-contract sync** (2026-05-05, Codex doc/code drift fix). (a) [design-system.md](packages/maestro-dashboard/design-system.md) Modal szekció backdrop-érték `var(--modal-backdrop)` token-referenciára cserélve + új "Theming — dark / light" szekció a `[data-theme="light"]` overrides-ról (theme-aware token kategóriák tábla, új token bevezetés szabálya, third-party prop override pattern). (b) [CLAUDE.md](packages/maestro-dashboard/CLAUDE.md) `tokens.css` sora a tényleges (`:root` dark + `[data-theme="light"]` light + `useTheme` hook) leírásra cserélve. (c) Az `Elevation/shadow tokenek` és `ConfirmDialog.btn-danger tokenizálás` TODO-k változatlanok — ezek nem drift, hanem ismert hiányok, külön scope.

#### C.1 Stitch screen-iteráció

> **Gating** (C.0.1 alapján): paralel track, csak Stitch export / annotáció / `_docs/` változás mehet — kód módosítás (CSS / JSX) TILOS, amíg a C.2 nem indul (A.6 + B.6 manuális smoke GO után).



- [x] **C.1.1** Table View v2 regenerálás (2026-05-05, 3 passz CLEAN, screen `23728cb8c6de442cb63dc017e961d652`): relatív idő (Ma 18:00, Holnap 12:00, Péntek 10:00), subtitle, ikonos HUD + MŰVELETEK + 3 kijelölve, magyar nav 5 sidebar item, state badge soft glow `box-shadow: 0 0 0 1px [color]38, 0 8px 20px [color]2e` + `.status-glow { filter: drop-shadow(0 0 4px currentColor); }`, kanonikus 7-elemű state set, "Csak saját" sentence-case.
- [x] **C.1.2** Publication Settings modal (2026-05-05, 1 passz CLEAN, screen `a422b3d999b34ee582ed47d607b67430`): timeline vizualizáció a Határidők tabra (ÜTEMEZÉSI ÁTTEKINTÉS horizontal track + datetime tickek), full-width warning banner (Ütemezési hiányosság + Módosítás CTA, warning-tinted bg + ikon), Hungarian datetime format, autoseed semantika.
- [x] **C.1.3** Flatplan (2026-05-05, 3 passz CLEAN, screen `9095baeab00444e890997df9fe891bef`): single letter A/B/C/D layout codes (default seed; **felhasználói visszajelzés**: a layout név user-editable, lehet többkarakteres is — pl. `L01_Main`, `Borító`), spread-kártyák kerettelenebbek (ghost border `rgba(66,71,84,0.05)`), cover spread emphasis (BORÍTÓ pozícionális marker accent blue + KÉSZ state badge top-right elkülönítve), Hungarian copy "X. oldal" / "X/Y oldal · Z% készültség" progress bar, kanonikus 7-elemű state set (TERVEZET / FOLYAMATBAN / LEKTORÁLÁS / JÓVÁHAGYVA / TÖRDELÉS).
- [x] **C.1.4** Workflow Designer (2026-05-05, 1 passz CLEAN, Codex 7-state szigorú prompt, screen `7cccbaeb594142f1930574cc034ea08a`): mind a 7 kanonikus state node a canvas-en (Tervezet → Folyamatban → Lektorálás → Jóváhagyva → Tördelés → Kész fő spine + Késő side branch), per-state szín-kategóriák (`#ddb7ff`/`#3b82f6`/`#facc15`/`#2dd4bf`/`#fb923c`/`#ffb4ab`/`#4ade80`), 7-blob minimap, edge label-ek Hungarian (Indítás / Beküldés / Elfogadva / Várakozik), selected node accent ring, Hungarian palette (ÁLLAPOTOK / SZEREPLŐK / VALIDÁCIÓK), properties sidebar 3 tab (TULAJDONSÁGOK / ÁTMENETEK / JOGOSULTSÁG) + Állapot törlése danger.
- [x] **C.1.5** Hiányzó screenek (2026-05-05, 4 új screen + 1 mobile bonus felhasználói paralel iterációból):
    - **Workflow Library Panel** (1 passz CLEAN, `f7e5d18ed242471e98f7502583a933f0`): breadcrumb header, scope SegmentedToggle, Aktív/Archivált tabs, search, 3 dense workflow card + Új workflow létrehozása empty card, AKTUÁLIS/SAJÁT/IDEGEN contextual badge-ek, action footer Mégse + Workflow kiválasztása.
    - **Create Publication modal desktop** (1 passz CLEAN, `9beb312f4d3e4705a48b028c150428c1`): Név + Gyökérmappa (helper opcionális) + Kezdő/Záró dátum + Workflow dropdown sample, autoseed helper tile ("automatikusan létrehozza a szükséges felhasználó-csoportokat — autoseed"), Mégse/Létrehozás action footer.
    - **Create Publication modal mobile** (felhasználói paralel iteráció a Stitch UI-ban, `ed89f02216334c408a616aca014571f7`). **Scope**: ez a screen NEM a C.2 desktop implementáció hatóköre — egy jövőbeli **mobile dashboard track** (D blokk vagy később, külön blokként vezetendő) része. A C.2.6 alpont kizárólag a desktop modalra vonatkozik.
    - **Org Settings (Csoportok)** (1 passz CLEAN, `3bb96031ef1d4ed7be9381d13c6c4240`): 4 tab (Általános / Csoportok active / Permission set-ek / **Bővítmények**), expandable group rows + immutable slug chip + KÖZREMŰKÖDŐ/VEZETŐ flags + tag count, Lektor expanded showing LEÍRÁS / SZÍNKÓD picker / Saját közreműködő toggle / PERMISSION SET-EK chips ("Tag alap" + "Lektor extra"), right detail panel HASZNÁLT WORKFLOW-K + TAGOK (3) avatarokkal, Mentés/Mégse footer.
    - **Login flow** (1 passz CLEAN, `7aa70471d440478299b7d5cbe136c3ed`): two-column auth split layout, Maestro logotype + Editorial OS hero (`#adc6ff`) + magyar subtitle "A nyomdai szerkesztőség operációs rendszere — cikkek, layoutok, workflow-k egy helyen." + abstract editorial silhouettes ambient + © Emago 2026 · v24, jobb oldal glass card Bejelentkezés / E-mail / Jelszó eye-toggle / Maradjon bejelentkezve + Elfelejtett jelszó? / primary gradient gomb / VAGY / Regisztráció link.
- [x] **C.1.6** Light theme variáns demo (2026-05-05, 1 passz CLEAN, screen `b4936dbf4a734e499c3d75ca2e12eccd` Login light + `assets/9dbd9db9bfa24864b7c3ac00cc0509d4` light DESIGN_SYSTEM asset Stitch-ben): a Codex C.0.2 finding bizonyítása — a baseline screen-en (Login) szemantikai token mapping (`bg-base #111319 → #ffffff`, `accent #adc6ff → #0969da` saturated, glassmorphism → subtle elevated white card, modal-backdrop `0.55 → 0.40`) működik egy passzal. **Code-level finomítások viszont a C.2.7.a-e-ben élesednek** (Codex C.0.2 risk-flag-ek: WorkflowCanvas hardcode-ok, TransitionEdge színek, visibility chip dedup, state-dot glow, Flatplan cover-emphasis). A többi screen (Table View, Publication Settings, Flatplan, Workflow Designer, Workflow Library, Create Publication, Org Settings) light variánsa NEM Stitch-en, hanem a C.2.7-ben kódszinten épül a `tokens.css` `[data-theme="light"]` blokkra.

#### C.2 Implementáció

> **Gating** (C.0.1 alapján): csak [[#A.6 Smoke teszt]] és [[#B.6 Smoke teszt]] manuális GO után indulhat post-smoke `main`-ről. A C.0.4 design-contract sync előfeltétel.
>
> **Copy-hygiene szabály** (C.0.3 alapján): minden újragyúrt screen-en a user-facing copy file-local `LABELS` / `COPY` objektumban él, NEM inline JSX-stringként. Ez nem i18n, hanem előkészület a D blokkhoz. Cross-app `t()`-infrastruktúra TILOS — D blokk hatáskör.

> **Sorrendi rebalance** (Codex tervi roast 1. pont, 2026-05-06): a C.2.7 NEM marad utolsó tömbként — szétszórva kerül a screen-task-okba, hogy minden screen azonnal light-aware legyen, ne maradjanak rejtett hardcode-ok a "kész" screen-eken. Új mapping: `7a + 7b + 7c → C.2.5` (Workflow Designer commit-család), `7d → C.2.2` (Table View v2 commit-család), `7e → C.2.4` (Flatplan commit-család). A `C.2.7` heading megmarad mint összesítő referencia.
>
> **Gating violation tudatos vállalás** (Codex tervi roast 2. pont, 2026-05-06): a C.2 implementáció szigorú értelemben az A.6 + B.6 manuális GO előtt nem indítható — a C.0.1 explicit tiltja. A felhasználó kifejezett kérése (2026-05-06) felülírja, **doc-only commitokra szűkítve a kockázatot, amíg a smoke teszt GO megérkezik**: a C.2.1 doc-only volt; a C.2.2–C.2.6 implementáció commit-családokat post-smoke `main`-ről újrarendezzük (rebase), HA az A.6/B.6 közben fut.

- [x] **C.2.1** (2026-05-06, Codex tervi roast 8 kérdés CLEAN) Copy-hygiene szabály bevezetése a [design-system.md](packages/maestro-dashboard/design-system.md)-ben (új „Copy-hygiene (C.0.3 előkészület)" szekció: mintázat, hatókör, konvenció — file-local `LABELS` / `COPY` objektum, NEM cross-app `t()`) + [CLAUDE.md](packages/maestro-dashboard/CLAUDE.md) `Kódstílus & Konvenciók` lista bővítése pointerre. **A token-rendszer és a Theming szekció már LIVE** (`tokens.css` `:root` dark + `[data-theme="light"]` light overrides, C.0.4 sync), tehát a C.2.1 Codex-tisztított hatóköre: copy-hygiene adoption + selective shared primitives/docs. **A primitív extraction-ok inkrementálisan jönnek** a C.2.2–C.2.6 commit-családokban, ahol a Stitch screen-ek konkrét reuse igényt mutatnak (Codex 7. pont: „incrementally per commit family"). **Cross-app `t()` infrastruktúra TILOS — D blokk hatáskör** (Codex 8. pont overengineering watch).
- [x] **C.2.2** (2026-05-06, Codex tervi roast verdikt: „feltételes igen" hatókör-szűkítésre) Table View v2 — **explicit regresszióminimalizáló scope-cut** + **C.2.7.d** beolvasztva. A Stitch v2 chrome-enrichment-eket (HUD, sidebar, relatív idő, subtitle) **tudatosan kihagyjuk**, mert új feature-eket / új state managementet jelentenének, NEM puszta vizuális finomítást:
    - **Implementálva**: **C.2.7.d** state-dot light theme override ([article-table.css:128-136](packages/maestro-dashboard/css/features/article-table.css)) — `[data-theme="light"] .state-dot { filter: none; box-shadow: 0 0 0 1.5px rgb(from currentColor r g b / 0.35); }`. A dark `filter: drop-shadow(0 0 4px currentColor)` érintetlen (Codex tervi roast 3. kérdés: csak light-theme korrekció, dark v2 soft glow formula későbbre). A `rgb(from currentColor r g b / 0.35)` modern CSS Color syntax browser-target compatible (Chrome 119+/Safari 16.4+/Firefox 128+).
    - **Scope-cut (tudatos kihagyás, Codex tervi roast 1. kérdés)**:
        - ❌ **Sidebar nav 5-elemmel** — új layout structure, új context state, scope-felfedezés átírása. Súlyos regresszió-rizikó. Mit jelentenének az 5 elemek? Nincs konkrét scope-leírás a Stitch screen-ben. → **D blokk vagy önálló feature commit-család**.
        - ❌ **Bulk-action floating HUD** ("MŰVELETEK + 3 kijelölve") — új multi-select state management, új DataContext mutator-ok (bulk-update/delete), új modal-szerű HUD komponens. Új feature, NEM redesign. → **D blokk vagy önálló feature commit-család**.
        - ❌ **Relatív idő oszlop** ("Ma 18:00", "Holnap 12:00") — új DataContext field vagy derived state, új deadline-formatter, érinti a `useUrgency` hookot. Új feature, NEM redesign. → **D blokk vagy önálló feature commit-család**.
        - ❌ **Subtitle a cikknév alatt** — tisztázatlan scope, mit tartalmazna. Ha a state-szöveg vagy lock-info, az MÁR LIVE a `state-label` + `lock badge`-en. → **Tisztázás után, D blokk**.
        - ❌ **„Csak saját" sentence-case** — a meglévő „Csak a saját cikkeim" bővebb forma egyértelműbb. Copy-only delta, NEM redesign.
    - **Megőrzött viselkedés** (Codex tervi roast 4. pont — regresszió-flag): `ArticleRow.jsx` + `ArticleTable.jsx` + `useUrgency` (urgency `bgStyle`) + `useFilters` (`showOnlyMine`, `showPlaceholders`, `statusFilter`, localStorage perzisztencia) + placeholder rows érintetlen. Vite build CLEAN.
- [x] **C.2.3** (2026-05-06, Codex review CLEAN: 0 P0/P1, 9 P2 mind intentional choice) Publication Settings timeline implementáció. Fájlok: [DeadlinesTab.jsx](packages/maestro-dashboard/src/components/publications/DeadlinesTab.jsx) `LABELS` objektum (copy-hygiene) + `formatDeadlineShort` magyar hónap-rövidítés helper + `timelineTicks` `useMemo` (`(startPage - coverageStart) / span * 100%` clamp [0,1]) + új `<section className="deadline-timeline">` JSX a return tetejére (header + track + tickek vagy empty state) + új `<div className="validation-banner validation-banner--warning" role="status">` JSX (full-width banner csak ha `errors.length === 0 && warnings.length > 0`); a meglévő `validation-card-warning` blokk eltávolítva (banner helyettesíti). [publication-settings.css](packages/maestro-dashboard/css/features/publication-settings.css) új `.validation-banner*` blokk (warning-tinted bg + ikon + uppercase title + list) + új `.deadline-timeline*` blokk (header, title, coverage label, track 64px height, ::before pseudo gradient track-vonal, tick stem 10×10px circle, tick-label 2-soros). **P2 jövőbeli polish (Codex)**: 1-page coverage minden tick 0%-on (intentional), tick collision 2+ deadline azonos startPage-en (cosmetic edge), tick label `100%`-on track jobb szélén túlnyúlhat (nincs `overflow: hidden`), warning banner nyúlik 5+ warning-nál (nincs `max-height`). Vite build CLEAN.
- [x] **C.2.4** (2026-05-06, Codex review: 0 P0, **1 P1 fix javítva**, 5 P2 confirmed) Flatplan layout kódok javítás **+ C.2.7.e** beolvasztva. **Codex P1 fix**: a cover-detektálás `index === 0` heurisztika hibás `coverageStart !== 1` esetén (pl. 8. oldaltól induló coverage-en a 8-as spread is „Borító"-t kapna) — átírva `spread.leftNum === null && spread.rightNum === 1` szigorú szabályra. **Multi-character layout név MÁR LIVE** (a `LayoutsTab.jsx` `<input type="text">` szabad text — single letter A/B/C/D auto-seedet a `getNextLayoutName` ad, a felhasználó ezt szabadon átírhatja `L01_Main`, `Borító` formára). Implementált deltaák:
    - **Spread ghost border** ([flatplan.css `.spread`](packages/maestro-dashboard/css/features/flatplan.css)): `border: 1px solid var(--border-muted)` + `border-radius: var(--radius-md)` + `overflow: hidden` — a `--border-muted` token dark `rgba(66,71,84,0.05)` / light `rgba(31,35,40,0.06)` automatikusan light-aware.
    - **Cover spread emphasis** ([LayoutView.jsx:570-595](packages/maestro-dashboard/src/components/LayoutView.jsx) `index === 0` detektálás + `spread--cover` className + `<span className="spread__cover-marker">Borító</span>` JSX): új `.spread--cover` accent-solid 30% ring + 1px box-shadow (border-color 15%); új `.spread__cover-marker` `accent-solid` solid bg + uppercase 10px white text, top-left abszolút pozíció `pointer-events: none`. **C.2.7.e (light override)**: a `--accent-solid` light-on `#0969da` automatikusan kontrasztos — feature-level light override NEM szükséges.
    - **Scope-cut** (Stitch screen elemek, ami D blokkba mennek):
        - ❌ **„KÉSZ" state badge top-right** — új komponens-feature, mit jelez (utolsó oldal állapota? cover-specific completion?). Tisztázatlan scope. → D blokk.
        - ❌ **„X. oldal" / „X/Y oldal · Z% készültség" progress bar** — új feature (DataContext-ből derived progress, új CSS), nem redesign. → D blokk.
        - ❌ **Hungarian copy „X. oldal" prefix a `page-number`-en** — a `clamp(...28px...)` typography megváltozna, refactor a `.page-info` szintjén. → D blokk vagy tipográfia-skála codifikálás után.
    - Vite build CLEAN.
- [x] **C.2.5** (2026-05-06, Codex review CLEAN: 0 P0/P1, 3 P2 fix javítva + 2 spontán finding fix) Workflow Designer canvas tokenizálás **+ C.2.7.a + C.2.7.b + C.2.7.c** beolvasztva. **A "node accent ring + soft glow + edge label" — Codex pontosítás**: ezek MIND már LIVE voltak a `state-node--selected` 2px box-shadow `--accent-solid` ring + `transition-edge__label` JSX render-en át; a "soft glow" a Table View `state-dot`-ban él, NEM a Workflow Designer node-ban (ez a C.2.2 + 7d hatóköre). A C.2.5 implementáció szigorúan a 7a/7b/7c tokenizálásra szűkült.
    - **C.2.7.a — WorkflowCanvas tokenizálás** (Codex C.0.2 finding fix): új `--canvas-dot-color` (dark `#333`, light `#d0d7de`) + `--canvas-mask-color` (dark `rgba(0,0,0,0.6)`, light `rgba(31,35,40,0.20)`) tokenek a `tokens.css`-ben, JSX prop átadás a [WorkflowCanvas.jsx](packages/maestro-dashboard/src/features/workflowDesigner/WorkflowCanvas.jsx)-ben új [`useCssTokens`](packages/maestro-dashboard/src/hooks/useCssToken.js) hookkal (`getComputedStyle` + `MutationObserver` `data-theme` attribútumra reaktív frissítés). Spontán fix: a `defaultEdgeOptions.markerEnd.color = '#888'` hardcode is tokenizálva (`--edge-marker` dark `#888`, light `#6e7781`).
    - **C.2.7.b — TransitionEdge tokenizálás** (Codex C.0.2 finding fix): új `--edge-forward` (dark `#4ade80`, light `#1a7f37`) + `--edge-backward` (dark `#fb923c`, light `#9a6700`) + `--edge-reset` (dark `#f87171`, light `#cf222e`) + `--edge-selected` (dark `#3b82f6`, light `#0969da`) tokenek; [TransitionEdge.jsx](packages/maestro-dashboard/src/features/workflowDesigner/edges/TransitionEdge.jsx) `useCssTokens` ternary-láncolat. Spontán fix: a `--edge-color` custom property dead write (CSS-ben nincs fogyasztó) eltávolítva.
    - **C.2.7.c — Visibility chip család tokenizálás** (Codex 6. pont, NEM rename): új `--vis-public-{bg|text|border}`, `--vis-organization-{bg|text|border}`, `--vis-office-{bg|text|border}` tokenek dark + light variánssal. 3 helyen (`badge.css` `.badge--{public|organization|editorial_office}`, `publication-settings.css` `.publication-workflow-picker__chip.is-*`, `workflowDesigner.css` `.workflow-designer-toolbar__scope-chip.is-*`) a hardcoded színek lecserélve tokenekre. **A class-átnevezést tudatosan kihagytuk** — Codex tervi roast 6. pont „NE rename" (felesleges churn). Codex Q8 review fix: `--vis-office-border` light variáns `rgb(from var(--text-primary) r g b / 0.12)` finomabb ghost border (a régi feature-local karakter), dark-on `var(--outline-variant)` (a régi `badge.css` + `publication-settings.css` karakter).
    - **`useCssToken` / `useCssTokens` hook** ([packages/maestro-dashboard/src/hooks/useCssToken.js](packages/maestro-dashboard/src/hooks/useCssToken.js)): SSR-safe `typeof document === 'undefined'` guard, `MutationObserver` cleanup unmount-kor + dep-váltáskor (Codex Q1/Q2 confirm). A `tokenNames.join(',')` dep stabil primitív, inline array-jel is működik. `WorkflowCanvas` 1× hookhívás, `TransitionEdge` per-edge hívás (50 edge ≈ 50 observer, de ritka theme-váltásra fut, nem render-költség — Codex Q4 OK).
    - Vite build CLEAN.
- [x] **C.2.6** (2026-05-06) Hiányzó screenek implementáció. A Create Publication mobile screen (Stitch artifact `ed89f02216334c408a616aca014571f7`) NEM C.2 hatóköre — jövőbeli mobile dashboard track (D blokk).
    - [x] **C.2.6.login** (2026-05-06, Codex review CLEAN: 1 P1 fix + 7 P2 confirmed) Login screen v2 implementáció. Fájlok: [auth.css](packages/maestro-dashboard/css/layouts/auth.css) `.login-container` flex-row two-column desktop + mobile column responsive `@media (max-width: 960px)` + `(max-width: 640px)`, új `.auth-hero*` osztályok (brand + ambient CSS-only + Editorial OS hero + © Emago footer), új `.form-input-with-toggle` + `.form-input-toggle` az eye-toggle-hoz, legacy `.login-brand` deprecated megőrzött (törlendő C.2 záró cleanup-ban — Codex P2 #5); [BrandHero.jsx](packages/maestro-dashboard/src/routes/auth/BrandHero.jsx) v2 (file-local `COPY` objektum copy-hygiene, NEM SVG asset / illustration pipeline — Codex 8. pont overengineering watch); [LoginRoute.jsx](packages/maestro-dashboard/src/routes/auth/LoginRoute.jsx) v2 (file-local `LABELS` objektum + eye-toggle inline SVG NEM ikon-könyvtár — Codex 8. pont; auth-tabs MEGŐRZÖTT a Register/Forgot/Reset/Verify route-ok konzisztenciájáért — Codex 5. pont scope-cut; "Maradjon bejelentkezve" KIHAGYVA no-op feature — Codex 8. pont); LoginView.jsx (legacy 84 sor) **TÖRÖLVE** (router `LoginRoute`-ot használ — Codex 5. pont). **Light theme automatikusan working** (Codex P2 #8 confirm) — minden token-alapú (`bg-base`, `accent`, `glass-edge`, `modal-backdrop`). Codex P1 fix: `tabIndex={-1}` eltávolítva az eye-toggle-ról (keyboard a11y). Vite build CLEAN.
    - [x] **C.2.6.orgsettings** (2026-05-06) **Scope-cut** — a Stitch screen `3bb96031...` az Org Settings 4 tab + GroupRow expandable + slug chip + KÖZREMŰKÖDŐ/VEZETŐ flag-ek + permission set chip + workflow refs panel layoutot validálta. Ez MIND már LIVE az aktuális kódban (A.4 commit-családból: [EditorialOfficeGroupsTab.jsx](packages/maestro-dashboard/src/components/organization/EditorialOfficeGroupsTab.jsx), [GroupRow.jsx](packages/maestro-dashboard/src/components/organization/GroupRow.jsx), [PermissionSetsTab.jsx](packages/maestro-dashboard/src/components/organization/PermissionSetsTab.jsx), [WorkflowExtensionsTab.jsx](packages/maestro-dashboard/src/components/organization/WorkflowExtensionsTab.jsx)). Strukturális delta nincs. Inline copy-hygiene refactor a meglévő screenekre **D blokk hatókör** (a C.0.3 alapelv: csak a C.2-ben **újragyúrt** screenek kapnak `LABELS` block-ot).
    - [x] **C.2.6.createpub** (2026-05-06, Codex review CLEAN: 0 P0, 1 P1 fix, 6 P2 confirmed) Create Publication modal desktop v2. Fájl: [CreatePublicationModal.jsx](packages/maestro-dashboard/src/components/publications/CreatePublicationModal.jsx) `COPY` objektum + új `<div className="form-info-tile" role="note">` JSX a workflow select alá (autoseed semantika magyarázása); [publication-settings.css](packages/maestro-dashboard/css/features/publication-settings.css) új `.form-info-tile*` blokk (accent-subtle bg + accent border + ikon + uppercase title + body). Codex P2 #4: jelenleg single-use, **NEM emeljük közös primitívvé** (incremental rule, 2+ használatra wait). A többi screen-mező (név, gyökérmappa, fedés, hétvégék, workflow dropdown) MAR LIVE volt — csak az autoseed info-tile a delta. Vite build CLEAN.
- [x] **C.2.7** (2026-05-06, Codex tervi roast 1. pont sorrendi rebalance) Light theme kódszintű finomítások — beolvasztva a screen-task-okba, hogy minden screen azonnal light-aware legyen. Mapping:
    - **C.2.7.a** WorkflowCanvas hardcode-ok tokenizálása → **C.2.5**.
    - **C.2.7.b** TransitionEdge színek tokenizálás → **C.2.5**.
    - **C.2.7.c** Visibility chip család dedup (NE rename) → **C.2.5**.
    - **C.2.7.d** State badge glow → outline ring light → **C.2.2**.
    - **C.2.7.e** Flatplan cover-emphasis → **C.2.4**.

### D. Meghívási flow stabilizálás — follow-up (2026-05-09 session után)

> **2026-05-09 SESSION-2 LEZÁRÁS** ([[Naplók/2026-05-09]]): a teljes A → B → C → D fázis **élesben**. 4 CF deploy + 1 új CF (`orphan-sweeper`) + schema-bővítés + 1 új collection (`organizationInviteHistory`) + frontend deploy + MAJOR fix az `expired` audit-gap-re. Lezáró Codex review: YELLOW (B.8 → Phase 1.5 szűkített scope; C+D külön review). **2 follow-up halasztva** külön session-re: **Q1 ACL refactor** (admin-team) és **Phase 1.6 globális orphan-guard** (3 status-blind CF). Részletes deploy summary: [[#D — Deploy roadmap (2026-05-09 session-zárás)]].

> Cél: a 2026-05-08 → 2026-05-09 session 18 commit + 11 CF deploy után fennmaradó adat-konzisztencia, automatizálás, audit-trail és fejlesztői workflow kérdések rendezése. Az ÉLES flow (invite-küldés + accept + verify + login + auto-trigger acceptInvite + runtime user-deletion → /login) **stabil**, ezek a follow-upok a robusztusság/governance/DX fronton dolgoznak.

> **Session-záró állapot**: 18 commit főágon (`7fac5b8` → `da54129`), 11 Appwrite CF deploy a `invite-to-organization` (élesben: `69fe698eb5cce9519275`) és `user-cascade-delete` (élesben: `69fe79421d1f3f3738ea`) function-ökre, dashboard frontend `./deploy.sh`-val cPanel-re kihelyezve. Memory: [[meghivasi-flow-redesign]] (vault-pointer rövidített). Részletek: [[Naplók/2026-05-08]] / [[Naplók/2026-05-09]] (új daily note kell).

> **Forrás**: ezek a deferred TODO-k a session során halasztva lettek, mert vagy különálló scope (Phase 2/1.5 Codex tervezésből), vagy alacsony prio relatív a immediate fix-ekhez (Hardening backlog B-E), vagy DX-szint (MCP setup), vagy tervi alapelv (Codex co-reflection).

#### D.0 Meta — Codex co-reflection alapelv

**Tervi szabály (kötelező a továbbiakban a backend/auth/permission/Realtime témákra)**:

Minden BLOCKER és architektúra-szintű döntés ELŐTT és UTÁN konzultáljunk a Codex-szel (`codex:codex-rescue` subagent), különösen:
- Új Cloud Function vagy meglévő CF jelentős átalakítása (lifecycle, race-condition, idempotencia)
- Permission-rendszer (`permissions.js`, slug-bővítés, ACL módosítás)
- Realtime + auth-state interakció (subscribe-flow, debounce, fail-closed)
- Új collection vagy schema-változás
- Stop-time review-ok systematikus végigvitele (a session-zárás előtt MINDIG futtassuk a Codex stop-time-ot)

**Why**: a 2026-05-09 session 11 Codex stop-time iterációja minden alkalommal valós kockázatot tárt fel — TOCTOU race, customMessage drift, stale session conflict, list pagination regresszió, runtime user-deletion path, register session order, 409 detection. A „magamtól írom + push" pattern pontatlanabb 1-2 nagyságrenddel.

**How to apply**:
1. BLOCKER észlelés → Codex review az implementáció ELŐTT (mi a helyes architecture?)
2. Implementáció → Codex review a code-on (van-e edge case / regresszió?)
3. Stop-time gate → Codex stop-time review (visszamaradó issue?)
4. Mindhárom körre rövid (8-15 mondatos) válasz; NEM mély fix-implementáció subagent-ből

**Mit ne**: minden trivial UX-tweak vagy single-line bugfix elé NEM kell Codex. A szabály a backend-architektúra + adat-konzisztencia + auth-flow szintjén él.

#### D.1 DevOps / MCP setup (BLOKKOLÓ a következő session-elején)

A 2026-05-09 session ~80%-ban kapacitásvesztés volt a deploy-mechanizmus félreértésén:
- Tévesen hittem, hogy Railway = dashboard auto-deploy git push-ra
- Valójában: **Railway = `maestro-proxy` only** (`gallant-balance` service); **dashboard cPanel-en** (`maestro.emago.hu`), manual `./deploy.sh`
- 13 frontend commit közül egyik sem volt élesben, amíg a user nem futtatta a `deploy.sh`-t

Megelőzés:

- [x] **D.1.1** Railway MCP setup — **doc** ([[Komponensek/SessionPreflight#Railway MCP setup]]). User-szintű install: `claude mcp add Railway npx @railway/mcp-server`. Auth: a Railway CLI (4.30.5 telepítve) tokent használ. Új session-elején: `railway link` (project: `successful-mindfulness`, service: `gallant-balance`). Tools: `deploy`, `service list`, `logs`, `status`, `variables`.

- [ ] **D.1.2** Dashboard auto-deploy webhook (cPanel). A `deploy.sh` egy SSH/SCP script — ezt GitHub Actions-szel automatizálni lehet (push-on-main → workflow → SSH-deploy). Bemenet: `secrets.SSH_PRIVATE_KEY` + `secrets.REMOTE_HOST`. Példa workflow: `npm run build` → `appleboy/scp-action`. **Why**: a session-szintű forget-to-deploy cost megszűnik, minden push immediately megy. **Trade-off**: SSH key in GitHub secrets (nem ideal — alternative: deploy-key-only user a cPanel-en, restricted-shell). **Scope**: ~30 perc setup + 1-2 iteráció a SSH-konfigon. Külön session.

- [x] **D.1.3** Session-elején infra-check rule — **doc** ([[Komponensek/SessionPreflight]]). `CLAUDE.md` Fejlesztési alapszabályok szekcióba is bekötve, [[Munkafolyamat]] hivatkozással. Minden új coding-session első 5 percében: deploy script-ek (`cat packages/*/package.json | jq .scripts`), deploy-konfig fájlok (`find ... railway* / *.toml / deploy.sh`), célhost megértése (`cat *deploy.sh`). **Soha** ne feltételezz „auto-deploy on git push"-t ellenőrzés nélkül.

#### D.2 user-cascade-delete Phase 1.5 — last-owner enforcement

A current Phase 1 (`69fe79421d1f3f3738ea` deploy) a last-owner deletion-t **csak loggolja** (`error()` szinten figyelmeztet). Tényleges enforcement nincs:

- [x] **D.2.1** `organizations.status` enum + `status_idx` schema — **kód kész** (`bootstrap_organization_status_schema` action a `actions/schemas.js`-ben). Deploy hátra: D-roadmap 1. lépés.
- [x] **D.2.2** `user-cascade-delete` orphan-marker writer — **kód kész** (`functions/user-cascade-delete/src/main.js`, opcionális `ORGANIZATIONS_COLLECTION_ID` env). Codex MAJOR fix: env hiányt `verificationFailures.push`-tel jelzi (5xx → admin-attention). Deploy hátra: D-roadmap 4. lépés.
- [x] **D.2.3** ProtectedRoute orphan-block UI — **kód kész** (`routes/ProtectedRoute.jsx` + új `routes/OrganizationOrphanedView.jsx`). NEM filtereljük az `AuthContext.organizations`-t (Codex Q3 review): az org látható, csak az aktív org-ra blokkoljuk a dashboardot. Deploy hátra: D-roadmap 5. lépés (cPanel `./deploy.sh`).
- [x] **D.2.4** `userHasOrgPermission()` orphan-guard — **kód kész** (`permissions.js` `getOrgStatus()` + `'lookup_failed'` sentinel — Codex MAJOR fix). 6 hívási hely 7-paraméteresre frissítve. Deploy hátra: D-roadmap 4. lépés (`invite-to-organization` CF redeploy).
- [x] **D.2.5** Schema backfill — **kód kész** (`backfill_organization_status` action, paginated, dryRun). Deploy hátra: D-roadmap 2. lépés.
- [x] **D.2.5b** `transfer_orphaned_org_ownership` recovery action — **kód kész** (`actions/orgs.js`, globális admin label guard, NEM `userHasOrgPermission`). Codex MINOR fix: explicit "egyszeri recovery action" contract. Deploy hátra: D-roadmap 4. lépés.

**Why**: data-integrity. Egy owner nélküli org árva: a tagok nem tudnak permission set-et szerkeszteni, új user-t hívni, stb. A jelenlegi state silent-broken.

**Codex tanácsadás**: ezt a Phase 1.5-öt (NEM Phase 2-vel összevonva) javasolta.

#### D.3 user-cascade-delete Phase 2 — audit-trail collection

Az `acceptInvite` 7fac5b8-os fix óta a sikeres meghívás-elfogadás `deleteDocument`-tel törli az invite-rekordot (BLOCKER 2 unique-index ütközés-elkerülés). Mellékhatás: az audit-trail elveszett:
- „Ki hívta meg X-et 6 hónapja, milyen role-lal?" → rekonstruálhatatlan (Resend webhook-log 30 nap)
- „Mikor accept-elte X a meghívást?" → membership `$createdAt` közelít, de nem expliciten tartalmazza

- [x] **D.3.1** `organizationInviteHistory` collection schema — **kód kész** (`bootstrap_organization_invite_history_schema` action a `actions/schemas.js`-ben, 19 attributum + `org_email_finalAt` index). Console-szintű collection-create + `rowSecurity: true` hátra: D-roadmap 6–7. lépés.
- [x] **D.3.2** `_archiveInvite(ctx, invite, finalStatus, finalReason, finalUserId)` helper — **kód kész** (`actions/invites.js`). Codex MINOR fix: deterministic doc ID `${invite.$id}__${finalStatus}` az idempotenciához (retry-on `document_already_exists` skip). Hívva 4 destruktív ágon: `acceptInvite` 3 helyen (main/idempotens/race-winner) + `declineInvite`. **Defer (Phase 2)**: `expireInvite` opportunista expire 3 ponton (`_createInviteCore` lejárt-expire, `acceptInvite` opportunista expire, `listMyInvites` opportunista expire) — alacsony prio, az archive ott metadata-only.
- [x] **D.3.3** GDPR token kezelés — **megoldva** (Codex tervi review): `tokenHash` mező SHA-256 hex (NEM raw token), nullable. Incident-korreláció lehetséges (egy konkrét tokenes report → hash → lookup), újrahasznosítás nem.
- [ ] **D.3.4** Retention policy — **deferred** (default forever, admin-kérésre törölhető a Console-ról). Phase 2: cron-alapú TTL ha kell.
- [ ] **D.3.5** Frontend "Történet" tab a UsersTab-en — **deferred** (Phase 2). A history rekordok mostantól keletkeznek, de a UI nem listázza még őket.

#### D.4 Backstop orphan-sweeper cron

A `user-cascade-delete` event-driven CF nem védett a race ellen:
- User-delete + concurrent acceptInvite → membership létrejön a user-doc törlésével párhuzamosan, és a CF event utáni cleanup nem találja
- Web-platform race: a Appwrite users.delete event sometimes előbb fut, mint az utolsó in-flight membership-create

- [x] **D.4.1** `orphan-sweeper` CF — **kód kész** (`packages/maestro-server/functions/orphan-sweeper/`, ~200 sor). Scope: 3 membership collection scan (org/office/group), `usersApi.get(userId)` 404 = orphan → delete, 1h grace window (`Query.lessThan('$createdAt', cutoffIso)`) a `user-cascade-delete` event-driven CF-fel való harc elkerüléshez. **Appwrite Teams listing kihagyva**: a Teams API `listMemberships` inkonzisztens cross-tenant scope-ban — defer Phase 2. Schedule `0 3 * * *`. Deploy hátra: D-roadmap 9–11. lépés.
- [x] **D.4.2** Throttling — **kód kész**: `MAX_USER_CHECKS_PER_RUN=500` cap egy futáson, `userExistsCache` Map a duplikált `usersApi.get`-re. Codex MAJOR-2 fix: per-futás cache dokumentált, perzisztált deduplikáció Phase 2-be.
- [x] **D.4.3** Resend admin alert — **kód kész** (best-effort, opcionális env var-ok `RESEND_API_KEY` + `ADMIN_NOTIFICATION_EMAIL`). >50 orphan-t talál egy futás → HTML riport e-mail.

#### D.5 Hardening backlog (deferred B–E iteration-guardian roast-ból)

Iteration-guardian 2026-05-09 hardening review (lásd memory `meghivasi-flow-redesign`) deferred 4 kockázat:

- [ ] **D.5.1 (B) Atomic TOCTOU lock** — **deferred** (Codex tervi review: első botspam incidentig, jelenlegi pre-claim ~30ms race window alacsony kockázat). `(inviteId, secondsBucket)` unique-index lock collection `inviteSendLocks`.

- [x] **D.5.2 (C) sendCount audit-mező** — **kód kész**. `sendOneInviteEmail()` returnje `{ success, sendCount? }`-szel bővül (Codex MAJOR fix: csak akkor `sendCount` ha bookkeeping `bookkept`). `_maybeAutoSendInviteEmail` returnje string → `{ status, sendCount? }` objektum (breaking, két hívási hely frissítve). `createInvite` / `createBatchInvites` / `sendInviteEmail` action-response propagálja. Deploy hátra: D-roadmap 4. lépés (`invite-to-organization` CF redeploy).

- [ ] **D.5.3 (D) Race-test integration suite** — **deferred** (Codex tervi review: eseti futtatás, NEM CI minden PR-on, költséges).

- [x] **D.5.4 (E) Frontend `deliveryStatus: 'cooldown'` UX-feedback** — **kód kész** (push-able, csak Dashboard cPanel `./deploy.sh`). `InviteModal.jsx` `deliverySummary()` helper (sent/failed/cooldown/default + tooltip). `UsersTab.jsx` `errorMessage(reason, retryAfterSec)` 2-paraméteres signature, `handleResendInvite()` `err.response.retryAfterSec` propagálja, dinamikus „várj még N másodpercet" üzenet (Codex MINOR fix: `typeof === 'number'` a `retryAfterSec === 0` boundary-ra).

#### D.6 Investigation: duplicate users a UsersTab UX-ban

User report 2026-05-09 ~02:10: „kidobta a usert a loginra, de maradt még egy a két ugyanolyan user-ből". MCP-vel ellenőrizve:
- Appwrite users: 3 user (Sashalmi Imre `centralmediacsoport.hu`, Csintalan Vilma, Nemes András). NINCS duplikátum email-en.
- `organizationMemberships` for Central Médiacsoport (`69fbae2b5272be7d27b3`): 2 row:
    - Sashalmi Imre owner (centralmediacsoport.hu, `688084b8001c3a63a316`)
    - Sasi member (`sashalmi.imre@gmail.com`, `69fe79e00022f3f9b2f6`)

**Hipotézis**: a user a UsersTab-on 2 különböző Sashalmi-fiókot lát (sajáttal + a teszt-Sasi-val) és ezt „2 ugyanolyan user"-nek értelmezi. NEM valódi duplikátum, csak névbeli hasonlóság (két különböző email).

- [x] **D.6.1** UsersTab UI clarity — **kód kész** (push-able, csak Dashboard cPanel `./deploy.sh`). `duplicateDisplayNames` Set memo a `members` + `userNameMap` deps-en, dupla név → kötelező e-mail-megjelenítés (`resolved.email` vagy self-fallback `user.email`). Egyedi név → eredeti viselkedés (csak ha mindkét adat ismert).

- [ ] **D.6.2** A test-account `69fe79e00022f3f9b2f6` (Sasi/`sashalmi.imre@gmail.com`) **user döntés** (maradhat vagy törölhető). Ha törlik, az új `user-cascade-delete` v4 (`69fe79421d1f3f3738ea`) most már működő endpoint-pal cleanup-ol.

#### D.7 Lessons learned — session-szintű refleksiók

- **Infrastructure-modell**: a session-elején NEM ellenőriztem a deploy-mechanizmust → 80% kapacitás-veszteség. Megelőzés D.1.3.
- **Codex stop-time gate**: 11 stop-time iteráció mind valós kockázatot tárt fel. Megerősíti a D.0-as alapelvet.
- **MCP-deploy mintája bevált**: `functions_create_deployment` → `functions_get_deployment` polling → `functions_list_executions` debug → automatizált 10 deploy egy session-ben siker. A Railway MCP ugyanezt fogja adni a proxy-ra (D.1.1).
- **Endpoint-default mismatch (`fra.cloud.appwrite.io` vs `cloud.appwrite.io`)** — a `cascade-delete` és `invite-to-organization` mintáját kellett volna copy-paste-elni, NEM ad-hoc default-ot kreálni. **Új CF-templét** írunk a Komponensek-be: [[Komponensek/CFTemplate]].

#### D — Deploy roadmap (2026-05-09 session-zárás)

> **Session-állapot**: A teljes A → B → C → D fázis **élesben**. 4 CF deploy + 1 új CF + schema-bővítés (1 enum + 19 attr + 2 index) + 1 új collection + 7 env var + 1 frontend deploy + 1 MAJOR fix az `expired` audit-gap-re. **2 follow-up KÜLÖN session-re halasztva**: Q1 ACL refactor, Phase 1.6 globális orphan-guard.

**Deploy summary (élesben)**:

| Lépés | Mit | Eredmény |
|---|---|---|
| **A** Frontend deploy | `./deploy.sh` (D.5.4 cooldown UX + D.6.1 UsersTab clarity + D.2.3 OrganizationOrphanedView) | ✅ `maestro.emago.hu` élő |
| **B.4** invite-to-organization redeploy (D blokk kód) | deployment `69ff125d9595a2e3c7b1` | ✅ READY |
| **B.2** `organizations.status` enum + `status_idx` | direkt MCP DB API (CF action `requireOwnerAnywhere` `x-appwrite-user-id` header API-blokkolása miatt) | ✅ AVAILABLE |
| **B.3** Backfill | 1 org (`Central Médiacsoport`) `null → active` | ✅ 1 doc |
| **B.5** user-cascade-delete redeploy + `ORGANIZATIONS_COLLECTION_ID` env var | deployment `69ff1868816fc6290961` | ✅ READY |
| **B.6** | A frontend deploy lefedte | ⏭️ SKIP |
| **B.7** Smoke | destruktív (test-user létrehozás) auto-mode-ban kihagyva | ⏭️ SKIP |
| **B.8** Codex stop-time | YELLOW (Phase 1.5 szűkített scope, 3 CF status-blind) | ✅ |
| **MAJOR fix** D.3 expired audit-gap | `_archiveInvite()` 4 helyen (`createCore`, `acceptInvite`, `listMyInvites`, `declineInvite`) | ✅ kód + 3rd deploy `69ff1a08944163d68780` |
| **C.1** `organizationInviteHistory` collection | rowSecurity:true, 19 attribute + `org_email_finalAt` index | ✅ AVAILABLE |
| **C.2** env var `ORGANIZATION_INVITE_HISTORY_COLLECTION_ID` | beállítva `invite-to-organization`-on | ✅ |
| **C.4** Smoke | destruktív (test-invite flow) auto-mode-ban kihagyva | ⏭️ SKIP |
| **D.1-D.4** orphan-sweeper CF | schedule `0 3 * * *`, timeout 300s, 6 env var, `commands: "npm install"` | ✅ deploy `69ff1d0dbee722295db5` READY |
| **D.5** Manuális első futás | `success:true, elapsedMs:296, totalOrphaned:0` | ✅ |

**Megjegyzés**: a Phase 1.5 jelenlegi szűkített scope-ja **nem regresszió** — a tenant-flow (invite, role-change, org-mgmt) lezárt, és az "egyéb" CF-ekben írható publikáció / cikk adatok az orphaned org-on data-loss-szempontból kevésbé kritikusak (a session resolveolható transfer-flow-val).

**Memóriapont** (új session-nek): a `_maybeAutoSendInviteEmail` return-type breaking change string → `{status, sendCount?}` objektum (D.5.2). Új permission helper signature: `userHasOrgPermission(databases, env, user, slug, orgId, orgRoleByOrg, orgStatusByOrg)` — 7 paraméter. A `_archiveInvite()` 4 új ágat lefed (`expired` finalStatus): `auto_expire_on_recreate`, `auto_expire_on_accept_attempt`, `auto_expire_on_list`, `auto_expire_on_decline_attempt`.

---

### E. Q1 ACL refactor — admin-team (külön session, 2026-05-09 follow-up)

> **2026-05-09 SESSION-3 LEZÁRÁS — KÓDOLDAL KÉSZ ([[Naplók/2026-05-09]])**: Codex pre-review (Pattern A választott) + 5 sync hook + 2 collection ACL switch + `backfill_admin_team_acl` action (idempotens, dryRun, **reconcile** mintával — stale removal) + frontend "Meghívási történet" szekció (Pattern A render). Codex stop-time review: 1 BLOCKER (`teamsApi` ctx-destructuring) + 2 MAJOR (frontend pendingInvites catch, backfill pagination/Query.equal) javítva. **Harden Fázis 1+2** plusz 1 BLOCKER (acceptInvite admin-team részleges siker → idempotens-ágon retry) + 4 MAJOR/MINOR fix. Backend: `invite-to-organization` CF redeploy hátra (H szekció). Frontend: cPanel deploy hátra (H szekció).

> **Cél**: a `organizationInviteHistory` és `organizationInvites` collection-ök ACL-jét `team:org_${orgId}` (org-wide read) → `team:org_${orgId}_admins` (csak owner+admin) refactor. A user Q1 explicit kérése (2026-05-09 session-2): "csak az lássa a kiküldött meghívókat aki tud is meghívót küldeni". Ez `org.member.invite` permission slug = owner+admin (`ADMIN_EXCLUDED_ORG_SLUGS` NEM tartalmazza).

> **Why**: jelenleg a `team:org_${orgId}` minden org-tagnak read-et ad → minden member látja az invite-tartalmat (e-mail, customMessage, inviter identity). NEM új exposure (a pending invite-ok is org-wide), de a `organizationInviteHistory` tartós + token-hashed → privacy-adósság, hosszabb ideig fennmaradó leak.

#### Pre-session checklist (KÖTELEZŐ)

1. **SessionPreflight** ([[Komponensek/SessionPreflight]]) — 5 perc infra-check: deploy mechanizmus, Appwrite endpoint, MCP elérhetőség.
2. **D.0 Codex co-reflection alapelv**: minden BLOCKER/architektúra-szintű döntés ELŐTT (pre-review) és UTÁN (stop-time) Codex review (`codex:codex-rescue` subagent).
3. **Olvasd el**: `_docs/Naplók/2026-05-09.md` Session-2 + a Codex Pattern A terv ezen szekció `Codex tervi forrás` blokkjában.
4. **Worktree**: `claude/friendly-cartwright-16770c` (vagy `main`, ha azóta merge-elve van).

#### Codex tervi forrás (2026-05-09 session-2)

A 2026-05-09 session-2 explicit Codex review-ját kértük a Q1 ACL implementációra. Codex Pattern A javaslatot adott (forrás: a session-ben Codex Q1 ACL terv agent eredménye, archived a memóriában `d-blokk-deploy-roadmap.md`):

**Választott megközelítés**: Pattern A — új Appwrite Team `org_${orgId}_admins`, ami csak az owner + admin role-ú tagokat tartalmazza. A 2 collection (invites + inviteHistory) doc-szintű ACL-jét erre a team-re állítjuk át.

**Sequencing (Codex):**
1. Admin-team ID + ACL builders (`teamHelpers.js`)
2. 5 sync hook patch
3. 2 collection ACL switch (write-path)
4. Backfill action (`backfill_admin_team_acl`) — `backfill_tenant_acl` minta
5. Frontend `Történet` tab + `org.member.invite` permission guard

#### Implementáció (részletes lépések)

##### E.1 `teamHelpers.js` admin-team builder

Új helper-ek a [packages/maestro-server/functions/invite-to-organization/src/teamHelpers.js](packages/maestro-server/functions/invite-to-organization/src/teamHelpers.js)-ben:

```js
// Admin-team ID generátor
const adminTeamId = (orgId) => `org_${orgId}_admins`;

// Admin-team doc-szintű ACL builder
function buildOrgAdminAclPerms(organizationId) {
    return [Permission.read(`team:org_${organizationId}_admins`)];
}
```

A meglévő generic primitivek **reuse** (NE találj fel új mutáció-mechanikát): `ensureTeam`, `ensureTeamMembership`, `removeTeamMembership`, `deleteTeamIfExists` (sorok 25-49 + 128-204 a `teamHelpers.js`-ben).

##### E.2 Sync hook patches (5 hely)

| Action | Fájl | Mit kell tenni |
|---|---|---|
| `bootstrap_organization` | `actions/orgs.js:192-233` | Owner DB-membership UTÁN `ensureTeam(adminTeamId)` + `ensureTeamMembership(adminTeamId, ownerId)`. |
| `accept_invite` | `actions/invites.js:821-850` | A meglévő org-team add UTÁN: **CSAK ha `invite.role === 'admin'`** → `ensureTeamMembership(adminTeamId, callerId)`. |
| `change_organization_member_role` | `actions/orgs.js:853-903` | Role-mutáció UTÁN: ha `newRole ∈ {owner, admin}` → `ensureTeamMembership`; ha `newRole === 'member'` → `removeTeamMembership` (strict, mielőtt új admin-only doc írásra kerül sor). |
| `leave_organization` | `actions/offices.js:154-175` mintáját követve | Admin-team removal **STRICT** (DB-delete ELŐTT, mint a meglévő org-team eltávolítás). Hiba esetén: `500 admin_team_cleanup_failed`. |
| `delete_organization` | `actions/orgs.js:654-659` | Org-team törlés UTÁN: `deleteTeamIfExists(adminTeamId)` cascade. |

**Race-tudatos sorrendezés** (Codex): demote (admin → member) esetén az admin-team removal **a soron írott invite/history doc ELŐTT** kell történjen, hogy a just-demoted user ne kapjon Realtime push-t admin-only doc-ról. A meglévő `leave_organization` minta ezt strict module: team eltávolítás → DB cleanup.

##### E.3 2 collection ACL switch (write-path)

| Hely | Mit | Hova |
|---|---|---|
| `organizationInvites.createDocument` | `actions/invites.js:254-273` | `buildOrgAclPerms(orgId)` → `buildOrgAdminAclPerms(orgId)`. |
| `organizationInviteHistory.createDocument` (`_archiveInvite()`) | `actions/invites.js:111-117` | `buildOrgAclPerms(orgId)` → `buildOrgAdminAclPerms(orgId)`. |

##### E.4 Backfill action `backfill_admin_team_acl`

Új CF action a `actions/schemas.js` alá (vagy új `actions/admin-team-acl.js`). Pattern: a meglévő `backfill_tenant_acl` (`schemas.js:893-899`, `953-977`) mintáját követi:

- Payload: `{ organizationId, dryRun? }` (ha mind hiány: `{ scope: 'all' }` opcionális, de Codex SCOPED-ot javasolt — per-tenant, nem project-wide).
- Caller: org owner (a `requireOwnerAnywhere` mintára, vagy specifikus per-org owner check).
- Lépések (sorrendben — KÖTELEZŐ):
  1. **Admin-team ensure** — `ensureTeam(adminTeamId)`. Hiba → azonnal `500 admin_team_create_failed`, **mielőtt** ACL-rewrite indulna.
  2. **Tagság-szinkron** — listázza a `organizationMemberships`-et az orgon belül, owner+admin role-úakat hozzáadja.
  3. **ACL rewrite invites** — meglévő `organizationInvites` doc-okra `buildOrgAdminAclPerms(orgId)`.
  4. **ACL rewrite inviteHistory** — meglévő `organizationInviteHistory` doc-okra `buildOrgAdminAclPerms(orgId)`.
- Idempotens: 409 `already_exists` → skip.
- `dryRun: true` opcionális.

##### E.5 Frontend `Történet` tab + permission guard

A [packages/maestro-dashboard/src/components/organization/UsersTab.jsx](packages/maestro-dashboard/src/components/organization/UsersTab.jsx) bővítése:

- Új tab "Történet" a meglévő tab-sor mellett (a "Felhasználók" + "Függő meghívók" mellé).
- A tab CSAK akkor renderel, ha a frontend `userHasOrgPermission('org.member.invite', orgId)` true.
- A tab tartalma: read-only listája az `organizationInviteHistory` rekordoknak (paginated, per-org).
- Realtime: a member számára NINCS WS push (admin-team ACL), így a memberek NEM látják az új history-eseményeket.

**Frontend permission helper**: már létezik a `clientHasPermission()` shared helper (lásd `packages/maestro-shared/permissions.js`). Használd, NE találj fel újat.

#### Codex review pontok (kötelező a deploy ELŐTT és UTÁN)

1. **Race-felület**: az 5 sync hook közül az `accept_invite` és `change_organization_member_role` is potenciálisan írhat — race-condition vizsgálat. Codex válasz a session-2-ben: **a "team-first, ACL-rewrite-second" rule** (Pattern A 5. pont) bounded race-window-t ad; az irreducible in-flight race a server-side permission check-en bukik el.
2. **Idempotens minta**: minden `ensureTeamMembership` 409 → skip (mint a `backfill_tenant_acl`-ban).
3. **Hard prerequisite**: az admin-team `ensureTeam` hibája azonnal `500 admin_team_create_failed`-del leáll, **mielőtt** bármelyik invite ACL-t átírná (Codex `backfill_tenant_acl` review minta).
4. **Single-owner edge case**: egy org csak 1 owner + 0 admin tagsággal — az admin-team csak 1-tagú lesz. **OK** (Codex válasz a session-2-ben): a meglévő bootstrap egy team-et 1 owner taggal sikeresen kezel.

#### Smoke teszt (kézi UI-flow)

A backend deploy + frontend deploy UTÁN:

1. Test-org létrehozás 2 admin (owner + admin) + 1 member tagsággal.
2. Invite küldés admin-tól → `organizationInvites` rekord ACL-je `team:org_X_admins`.
3. Member belépés a Console-ra (vagy Dashboard) → **NEM látja** a pending invite-okat (Realtime push elmarad).
4. Admin belépés → **látja**.
5. Invite accept → `organizationInviteHistory` rekord létrejön ACL-lel `team:org_X_admins`.
6. Member NEM látja a history-t. Admin igen.
7. **Demote teszt**: admin → member role-change → admin-team-ből kikerül, a soron érkező új invite/history NEM látható számára.

#### Post-deploy

1. **Codex stop-time review** kifejezetten a race-window-ra (admin-leakage demote-vs-write párhuzam).
2. Backfill action futtatás — a meglévő `Central Médiacsoport`-on (és bármely más orgon) `dryRun: true` ELŐSZÖR, aztán éles.

#### Commit + deploy útmutató

Egy commit (vagy 2 — backend + frontend külön): `feat(d-blokk-q1-acl): admin-team refactor (2 collection + 5 sync hook + backfill action + frontend Történet tab)`.

CF deploy: `invite-to-organization` redeploy (4. ezen a napon).
Frontend deploy: `./deploy.sh` ismét.

---

### F. Phase 1.6 — globális orphan-guard (külön session, 2026-05-09 follow-up)

> **2026-05-09 SESSION-3 LEZÁRÁS — KÓDOLDAL KÉSZ ([[Naplók/2026-05-09]])**: Codex pre-review (3 kérdés: inline duplikáció, lock-only fast-path SKIP, validate-publication-update C opció) + 2 CF integráció (`set-publication-root-path` + `update-article`) inline `getOrgStatus()`/`isOrgWriteBlocked()` helperrel + frontend toast-mapping (Plugin `Publication.jsx` cfReason ág + Dashboard `inviteFunctionErrorMessages.js` + Plugin `workflowEngine.js` `_handleCFError` `orgOrphaned: true` flag). A `validate-publication-update` SCOPE-OUT (csak audit-log, NEM enforce — pre-update snapshot nélkül teljes mező-revert nem biztonságos). Codex stop-time: 1 MAJOR best-effort (TOCTOU race-window — Phase 1.5 mintával koherens) + 2 MINOR (1 fix: audit-log; 1 Phase 2 follow-up). Backend: 2 CF redeploy hátra + `ORGANIZATIONS_COLLECTION_ID` env var (H szekció). Frontend: Plugin UXP rebuild + Dashboard cPanel deploy hátra (H szekció).

> **Cél**: a `set-publication-root-path`, `update-article`, `validate-publication-update` 3 CF-be `getOrgStatus()` + `isOrgWriteBlocked()` orphan-guard integrálása. Ezzel teljessé válik a "orphaned org safe to leave overnight" invariáns.

> **Why**: Codex B.8 stop-time review (2026-05-09 session-2) BLOCKER-rést talált: a Phase 1.5 fail-closed orphan-guard CSAK az `invite-to-organization` action-ökön él. 3 CF status-blind, ezeken keresztül továbbra is írhatóak az orphaned org-hoz tartozó publikáció + cikk adatok.

#### Pre-session checklist (KÖTELEZŐ)

1. **SessionPreflight** ([[Komponensek/SessionPreflight]]) — 5 perc.
2. **D.0 Codex co-reflection** — pre-review + stop-time.
3. **Olvasd el**: `_docs/Naplók/2026-05-09.md` Session-2 "Codex B.8 stop-time" — pontos sorok és érvek.
4. **Worktree**: `claude/friendly-cartwright-16770c` (vagy `main`).

#### Codex tervi forrás

Codex B.8 stop-time review (2026-05-09 session-2) konkrét fájlsor-hivatkozásai:

- `packages/maestro-server/functions/set-publication-root-path/src/main.js:185` — inline org owner/admin role-check, `getOrgStatus()` nélkül.
- `packages/maestro-server/functions/update-article/src/main.js:415` — csak office/group membership, status-blind.
- `packages/maestro-server/functions/validate-publication-update/src/main.js:314` — update path scope-check skip lookup-hibára.

Codex elmondta: ezekben a write-path-okban **nem alkalmazandó** a teljes `userHasOrgPermission()` helper (mert az 5 org-scope slug specifikus), HANEM egy **szigorúbban szűkített** orphan-guard: `getOrgStatus()` lookup → `isOrgWriteBlocked(status)` → fail-closed 403.

#### Implementáció (részletes lépések)

##### F.1 Közös orphan-guard helper (single-source)

Új helper az [packages/maestro-shared/permissions.js](packages/maestro-shared/permissions.js)-ben (vagy új `packages/maestro-shared/orphanGuard.js`):

```js
async function assertNotOrphanedOrg(databases, env, organizationId) {
    const status = await getOrgStatus(databases, env, organizationId);
    if (isOrgWriteBlocked(status)) {
        return { ok: false, status: 'orphaned', reason: 'org_orphaned_write_blocked' };
    }
    return { ok: true };
}
```

A `getOrgStatus()` és `isOrgWriteBlocked()` MÁR létezik az `invite-to-organization` `permissions.js`-ben. Egységes shared modulba költöztetni (single-source-of-truth).

**Codex tervi pont**: a 3 CF MIND CommonJS, a shared modul ESM. A.7.1 mintát követve egy új generator script (`scripts/build-cf-orphan-guard.mjs`) generálná a CF-be. **DE**: ha túl nehéz, akkor egyenesen másoljuk inline-ban a 3 CF-be (a Phase 1.5 mintájához hasonlóan, ami szintén inline duplikál a `permissions.js`-en).

**Codex review kérdés a session elején**: single-source generator script vs. inline duplikáció? Egy 5-soros helper-re az inline pragmatikus.

##### F.2 CF integráció (3 hely)

###### F.2.1 `set-publication-root-path/main.js:185` (caller jogosultság-check UTÁN)

Az inline `org owner/admin` role-check (sor 185) UTÁN, DE a DB write ELŐTT:

```js
const orphanCheck = await assertNotOrphanedOrg(databases, env, pub.organizationId);
if (!orphanCheck.ok) {
    return fail(res, 403, 'org_orphaned_write_blocked');
}
```

###### F.2.2 `update-article/main.js:415` (office-membership lookup UTÁN)

A `freshDoc.organizationId` (vagy `parentPublication.organizationId`, ha eltér) on:

```js
const orphanCheck = await assertNotOrphanedOrg(databases, env, freshDoc.organizationId);
if (!orphanCheck.ok) {
    return res.json({
        success: false,
        permissionDenied: true,
        reason: 'org_orphaned_write_blocked'
    });
}
```

###### F.2.3 `validate-publication-update/main.js:314` (update path scope-check UTÁN)

Update path: ha `payload` nem érintette a `isActivated`-ot ÉS az update fail-closed scope-check skipped lookup-hibára, **plusz** orphan-check. Ha orphan → CF revert (a CF post-event, ezért NEM 403 — hanem revert).

A revert lehetőségek: `databases.updateDocument(payload._id, freshDocSnapshot)` — visszaállítjuk a fresh doc-ra. **Codex review** szükséges a session elején a revert-pattern-re (a meglévő guard a `validate-publication-update` CF-ben már revert mintákat használ — `corrections` objektum).

**Megjegyzés**: a `validate-publication-update` CF post-event trigger, NEM kliens-hívás. Az orphan-guard itt CSAK akkor szükséges, ha a kliens a Dashboard collection-ACL-t megkerülve közvetlen DB-hívást csinál (pl. Console-ról). A jelenlegi Dashboard write-path az `update-article` CF-en megy → ott már lefedett. **Codex review kérdés**: szükséges-e a guard a `validate-publication-update`-ben?

##### F.3 Új env var (3 CF mind)

Mind a 3 CF-en `ORGANIZATIONS_COLLECTION_ID = "organizations"` env var beállítás (mint a `user-cascade-delete`-en).

##### F.4 Hibakód egységesítés

`403 org_orphaned_write_blocked` mind a 3 CF-en. A frontend toast-mapping-ben (lásd [packages/maestro-dashboard/src/utils/inviteFunctionErrorMessages.js](packages/maestro-dashboard/src/utils/inviteFunctionErrorMessages.js)) bővíteni a magyar copy-val:

> "A szervezet jelenleg árva állapotban van — várd meg az új tulajdonos kijelölését, mielőtt módosítanál."

##### F.5 Backwards compat

A `null` status legacy `active`-ként kezelődik (mint az `invite-to-organization`-ban — `permissions.js:353`, `383`). Tehát a 60+ legacy org NEM lockolódik le, csak a `'orphaned'` és `'archived'` status orgok.

##### F.6 3 CF redeploy

Mind a 3 CF kódot újradeploy-olni az MCP `functions_create_deployment`-tel (mint a Phase 1.5-ben). `commands: "npm install"` ellenőrizni mindegyiken (ha még nincs).

#### Codex review pontok (kötelező)

1. **Performance**: `getOrgStatus()` per-request DB lookup. Cache-elhető process-szinten? (A Phase 1.5-ben `permissionContext.orgStatusByOrg` Map-et használ — a 3 CF-en is alkalmazható?)
2. **Hibakezelés**: `getOrgStatus()` `'lookup_failed'` sentinel → fail-closed (mint Phase 1.5).
3. **`validate-publication-update` post-event**: revert-pattern szükséges? Vagy a kliens-side guard (a 2 másik CF) elegendő?
4. **`update-article` lock fast-path**: a sor 415 tartalmaz egy lock-only fast-path bypass-t (csak `lockType`/`lockOwnerId` payload-ra). Az orphan-guard itt is fusson, vagy lock-only-ra skip?

#### Smoke teszt

Backend deploy UTÁN:

1. Test-org `status='orphaned'`-be állítás (manual `tables_db_update_row`).
2. Próbálj a UI-ból: rootPath-set, article-update, publication-update műveletet.
3. Várt: 403 `org_orphaned_write_blocked` mind a 3 esetben.
4. Test-org vissza `active`-ra → minden írás újra OK.

#### Commit + deploy

Egy commit: `feat(d-blokk-phase-1-6): globális orphan-guard 3 CF (set-publication-root-path + update-article + validate-publication-update)`.

3 CF deploy. Codex stop-time review.

---

### G. D.3 race compare-and-swap (külön session, 2026-05-09 follow-up)

> **2026-05-09 SESSION-3 LEZÁRÁS — KÓDOLDAL KÉSZ ([[Naplók/2026-05-09]])**: Codex pre-review (4 kérdés) → **Konstrukció C** választva (invite-szintű terminal-claim doc-ID, NEM `(inviteId, finalStatus)` postfix-szel). Új return-jelzéses helper signature (`{ status: 'created' | 'already_exists' | 'env_missing' | 'error', existingFinalStatus?, error? }`), 4 fő hívási hely sorrend-cserélve (ELŐSZÖR archive, ha `created` → status update; `already_exists` → SKIP / 409 `already_terminated`). Codex stop-time: 1 MAJOR (`_createInviteCore` re-read fix — race-loser után ha még pending, 409 `invite_state_race_retry`) + 2 MINOR (direct `invite.$id` doc-ID, kontraktus-komment) javítva. **Harden Fázis 1+2** plusz Quality #1 simplify: `_archiveAndUpdateExpiredInvite` wrapper a 4 opportunista expire-ágon (claim-then-update minta egy helyen). Backend: `invite-to-organization` CF redeploy hátra (H szekció — együtt E blokkal).

> **Cél**: a `_archiveInvite()` deterministicus ID `(inviteId, finalStatus)` szintű idempotenciája NEM véd egy `accepted` vs `expired` race ellen. Compare-and-swap (CAS) pattern szükséges, hogy egy invite csak EGY terminál állapotba kerülhessen.

> **Why**: Codex C+D stop-time review (2026-05-09 session-2) follow-up. A `_archiveInvite()` 4 ágon fut, plusz a `acceptInvite` és `declineInvite` terminális (DB delete vagy status update). Párhuzamos `expired` ÉS `accepted` ág → KÉT history rekord (eltérő doc-ID `inviteId__expired` vs `inviteId__accepted`). Audit-konzisztencia szempontból: egy invite egy terminál állapotban végez.

#### Pre-session checklist (KÖTELEZŐ)

1. **SessionPreflight** — 5 perc.
2. **D.0 Codex co-reflection** — KÖTELEZŐ a session ELEJÉN: pattern-választás Codex pre-review-val.
3. **Olvasd el**: `_docs/Naplók/2026-05-09.md` Session-2 + Codex C+D stop-time eredmény (a `(inviteId, finalStatus)` idempotencia limit).

#### Probléma

Appwrite-ben **nincs natív transactional compare-and-swap** (CAS). A `pending → accepted` átmenet `delete + create` a memberships-en (a unique-index miatt — [[Döntések/0010-meghivasi-flow-redesign]] BLOCKER 2 fix). Az `expired` átmenet egy `update status='expired'`. A két ág párhuzamosan futhat ugyanarra az invite-ra.

#### Codex Pattern-választás (session-eleji feladat)

A session **első lépése**: Codex agent (`codex:codex-rescue`) tervi review a 3 lehetséges konstrukciónak — **NE implementálj a Codex válasz előtt**.

##### Konstrukció A: Single-source terminál transition CF action

Új CF action `transition_invite(inviteId, fromStatus, toStatus)`:
1. `getDocument` + check `status === fromStatus`
2. `_archiveInvite()` history archive ELŐSZÖR
3. Ha `_archiveInvite()` `409 document_already_exists` → race-vesztes, abortál `409 already_terminated`
4. Ha sikeres archive → status update / delete

**Pro**: idempotens visszafelé (retry biztonságos).
**Con**: új CF action, 4 hívási hely refactor.

##### Konstrukció B: Status-versioning column + unique index

Új mező az `organizationInvites`-en: `terminalStatus` enum (`null | accepted | declined | expired`). Új unique index `(inviteId, terminalStatus)`.

A status-write csak akkor megy, ha `Query.isNull('terminalStatus')` — ha másik már átment, 409.

**Pro**: schema-szintű atomic CAS.
**Con**: schema-bővítés (új mező + index), teljes flow refactor.

##### Konstrukció C: Helper-szintű idempotencia + archive ID-collision

Ha `_archiveInvite()` `document_already_exists` 409-et ad → a status-write CSAK akkor megy, ha az archive sikeres volt. A 4 hívási helyet refaktoráljuk úgy, hogy az archive eredményét felhasználjuk a status-update gating-jéhez.

**Pro**: legkisebb komplexitás, NEM kell új mező/CF action.
**Con**: subtle race a deterministic ID counter-hoz (Appwrite-szintű atomic uniqueness garancia kell).

#### Codex review (kötelező a session elején)

Adj a Codex-nek a 3 konstrukciót, és kérjed meg:
1. Melyik a legkisebb komplexitás × race-felület × Appwrite eventual consistency model-je?
2. Performance impact: minden status-write +1 DB call?
3. Idempotens retry: ha a CF közben elfagy (timeout), a retry biztonságos-e?
4. Schema-bővítés (Konstrukció B) költsége: új attr + index + backfill, vs. helper refactor (C)?

A Codex válasz alapján válassz egyet, ÉS commit a választást a Feladatok.md-be (audit-trail).

#### Implementáció (a választott konstrukció szerint)

A Codex válasz után részletes terv. **NE implementálj** előbb.

#### Smoke teszt (race-test)

Race-test (k6 vagy custom Node-script):
- 2-2 párhuzamos `acceptInvite` + opportunista `auto_expire_on_list` ugyanarra a token-re.
- Várt: pontosan **1** history rekord per invite.
- Az invite végállapot: vagy `accepted` vagy `expired`, NEM mindkettő.

#### Commit + deploy

Egy commit (Konstrukció A vagy C): `feat(d-blokk-d3-race-cas): terminál átmenet CAS — KONSTRUKCIÓ X`.
Konstrukció B esetén: schema-bővítés MIGRATION-commit külön + flow-refactor commit külön.

CF redeploy. Codex stop-time review.

---

### Halasztott follow-up — összefoglaló (E + F + G)

| Pont | Cél | Kockázat | Becsült idő | Status |
|---|---|---|---|---|
| **E. Q1 ACL refactor** | admin-team `org_${orgId}_admins`, 2 collection ACL switch | Privacy-adósság | 1-2 óra | ✅ KÓD KÉSZ (2026-05-09 SESSION-3) |
| **F. Phase 1.6** | globális orphan-guard 3 status-blind CF-en | "Orphaned safe overnight" invariáns | 1-2 óra | ✅ KÓD KÉSZ (2026-05-09 SESSION-3) |
| **G. D.3 race CAS** | terminál átmenet compare-and-swap | Audit-konzisztencia (KÉT history rekord per race) | 1-3 óra (Codex pattern-választás függő) | ✅ KÓD KÉSZ (2026-05-09 SESSION-3 — Konstrukció C) |

**Sorrend (javasolt)**: F → E → G. Az F a kritikusabb (data-integrity), az E privacy, a G audit-edge-case. **Implementáció sorrend (2026-05-09 session-3 alkalmazta)**: F → E → G egy commit-ban + Harden Fázis 1-7.

**AI-agent utasítás minden 3 pontra**: KÖTELEZŐ a Codex co-reflection alapelv (D.0). Backend deploy ELŐTT pre-review, UTÁN stop-time review. NE implementálj Codex válasz nélkül.

---

### H. Deploy roadmap (F+E+G + Harden, 2026-05-09 session-3 zárás)

> **Cél**: a session-3 (F+E+G + Harden Fázis 1-7) **kódoldali kész** — a Backend CF redeploy + frontend deploy + backfill futtatás + smoke teszt egy következő session feladata. Az implementáció lokális commitra készül a `claude/friendly-cartwright-16770c` branchen, **NINCS** push, NINCS deploy. A H szekció pontos lépéslistát ad a következő session indulására.

> **Session-záró állapot (2026-05-09 session-3)**: 1 lokális commit a `claude/friendly-cartwright-16770c` branchen (`feat(efg-blokk-harden): F+E+G + Harden pass`), 17 fájl ~970/95 sor. Az F+E+G eredeti commit (`6f3dba7`) soft-reset után amalgamálva a Harden javításokkal egyetlen commit-ban. Codex review futások: 1 baseline + 1 adversarial + 1 verifikáló + 1 mini-verifikáló (Harden BLOCKER fix után) — összesen 4 stop-time + 3 pre-review (F.0, E.0, G.0) ezen a session-en.

#### Pre-session checklist (KÖTELEZŐ a következő session elején)

1. **SessionPreflight** ([[Komponensek/SessionPreflight]]) — 5 perc infra-check: deploy mechanizmus, Appwrite endpoint, Railway MCP elérhetőség.
2. **D.0 Codex co-reflection alapelv**: a deploy ELŐTT és UTÁN egy-egy gyors Codex stop-time review-t kérek (a session-3 7 review-ja után még a deploy-szempontú race-eket átvizsgálni: schema-bootstrap után collection-state, env-var dependencia, CF deploy sorrendje).
3. **Worktree**: `claude/friendly-cartwright-16770c` (vagy `main`, ha addig merge-elve van).
4. **Olvasd el**: [[Naplók/2026-05-09]] session-3 + ezen H szekció.

#### H.1 — Backend CF deploy (4 db)

A 4 érintett CF-et MCP-vel (`functions_create_deployment`) deployolni — a session-2 D-blokk minta szerint.

| Sorrend | CF | Forrás | Deploy függőség |
|---|---|---|---|
| 1 | `invite-to-organization` | `packages/maestro-server/functions/invite-to-organization/` | Új `backfill_admin_team_acl` action regisztrált a `main.js`-ben |
| 2 | `set-publication-root-path` | `packages/maestro-server/functions/set-publication-root-path/` | Új `ORGANIZATIONS_COLLECTION_ID` env var (H.3) |
| 3 | `update-article` | `packages/maestro-server/functions/update-article/` | Új `ORGANIZATIONS_COLLECTION_ID` env var (H.3) |
| 4 | `validate-publication-update` | `packages/maestro-server/functions/validate-publication-update/` | Új `ORGANIZATIONS_COLLECTION_ID` env var (H.3) — opcionális, csak audit-loghoz |

**Megjegyzés**: a 4-es csak audit-log céljából használja az env var-t (Phase 1.6 NEM enforce); a 2-es és 3-as **fail-closed** ha az env hiányzik (`lookup_failed` sentinel).

#### H.2 — Console / DB előkészület

- **`organizationInviteHistory.rowSecurity = true`** — ellenőrizni, hogy a `bootstrap_organization_invite_history_schema` action ezt már beállította-e (ha nem, kézi Console-művelet kell).
- **Schema check**: a `bootstrap_organization_status_schema` (D.2.1) és `bootstrap_organization_invite_history_schema` (D.3.1) action-ek korábbi session-ben futottak. Ha a status-mező vagy a history-collection hiányzik, először ezeket futtatni.

#### H.3 — Új env var

A 2 (vagy 4) F-blokk CF-en `ORGANIZATIONS_COLLECTION_ID = "organizations"` env var beállítás (a `user-cascade-delete` mintára). Hiánya esetén `getOrgStatus()` `'lookup_failed'`-et ad → fail-closed 403.

#### H.4 — Backfill manuális futtatás

A `backfill_admin_team_acl` action minden meglévő orgon **dryRun: true** ELŐSZÖR, aztán éles futtatás:

1. Listázni az orgokat a `Central Médiacsoport` és minden további `organizations` rekord.
2. Per-org: `executions.create({ functionId: 'invite-to-organization', body: '{"action":"backfill_admin_team_acl","organizationId":"<id>","dryRun":true}' })` — owner-only.
3. Stat ellenőrzés: `adminTeam.created`, `adminTeam.memberships`, `adminTeam.staleRemoved`, `acl.invites`, `acl.inviteHistory`, `errors.length === 0`.
4. Ha clean → `dryRun: false` futtatás per-org.

**Reconcile**: a `staleRemoved` mező a Harden Fázis 1+2 **MUST FIX** eredménye — a Console-ról/közvetlen DB-write-tal demote-olt admin-tagok automatikus eltávolítása az admin-team-ből (privacy invariáns).

#### H.5 — Frontend deploy (2 célon)

1. **Dashboard** (`maestro-dashboard`):
   - cPanel `./deploy.sh` ([[Komponensek/SessionPreflight#Dashboard deploy]]).
   - Érintett fájlok: `OrganizationSettingsModal.jsx`, `UsersTab.jsx`, `inviteFunctionErrorMessages.js`, `appwriteIds.js`.
2. **Plugin** (`maestro-indesign`):
   - InDesign UXP rebuild + plugin újra-betöltés.
   - Érintett fájlok: `Publication.jsx` (`cfReason` ág), `workflowEngine.js` (`_handleCFError` `orgOrphaned: true` flag).

#### H.6 — Smoke teszt (E2E)

A 4 CF + frontend deploy UTÁN:

1. **F blokk**: test-org `status='orphaned'`-be állítás (Console DB tables_db_update_row). Próbáld a UI-ból: rootPath-set, article-update, publication-update. Várt: 403 `org_orphaned_write_blocked` mind a 3 esetben. Reset `active`-ra → minden írás OK.
2. **E blokk**: test-org 2 admin (owner + admin) + 1 member tagsággal. Invite küldés admin-tól → `organizationInvites` ACL `team:org_X_admins`. Member belépés → NEM látja a pending invite-okat (Realtime push elmarad). Admin → látja. Invite accept → `organizationInviteHistory` ACL `team:org_X_admins`. Member NEM látja a history-t. Admin igen.
3. **G blokk**: race-test (k6 vagy custom Node-script): 2-2 párhuzamos `acceptInvite` + opportunista `auto_expire_on_list` ugyanarra a token-re. Várt: pontosan **1** history rekord per invite. Az invite végállapot: vagy `accepted` vagy `expired`, NEM mindkettő.
4. **Harden**: demote-test — admin role-change → admin-team-ből kikerül. Új invite → ex-admin NEM látja.

#### H.7 — Codex stop-time deploy review

A live state után 1 Codex `codex:codex-rescue` stop-time review az élő rendszerre: van-e production-szintű regresszió, race-window, env-var dependencia drift.

#### H.8 — Commit + push

1. `git push origin claude/friendly-cartwright-16770c` (eddig csak lokális).
2. PR a `main`-re (vagy direkt merge ha solo-dev).
3. Memory pointer + vault-memó frissítés a session-záráshoz ([[meghivasi-flow-redesign]] mintára).

---

### Phase 2 follow-upok (új session-elhelyzés, NEM blokkoló)

A 2026-05-09 session-3 (F+E+G + Harden) NEM zárta le a teljes kockázat-felületet. Session-4 (auto-mode + Codex pre-review + stop-time review) az alábbi 8 tételt **kódoldalon implementálta** (ld. [[Naplók/2026-05-09#Session-4 (este) — Phase 2 follow-upok kódoldali implementáció]]); a maradék F.8 + E.6 streaming-refactor Phase 2.x deferred. A G.4 + G.5 + F.8 DESIGN-szintű döntései az [[Döntések/0011-cas-gate-and-orphan-guard-invariants]] ADR-ben rögzítve.

#### F. blokk Phase 2

- **F.7 [KÉSZ]** — `useArticles.js` raw `org_orphaned_write_blocked` szöveg cfReason-mapping. Új `OrphanedOrgError extends Error` osztály a Plugin [errorUtils.js](../packages/maestro-indesign/src/core/utils/errorUtils.js)-ben (consistent CFError minta a `PermissionDeniedError`-ral). 5 hívóhely átkapcsolt `instanceof` mintára.
- **F.8 [DEFERRED → ADR 0011]** — TOCTOU race-window strict invariáns ACL-szinten. ADR 0011 elvet a strict ACL-szintű invariánst (Phase 3 trigger: élesben race-corrupcio incident); az app-szintű best-effort guard + F.9 cache + Konstrukció C invite-szintű CAS-gate elegendő.
- **F.9 [KÉSZ]** — Hot-path orphan-guard cache (`maestro-shared/orphanGuard.js`-ben module-szintű 30s TTL). `clearOrgStatusCache(orgId?)` helper. A 2 hot-path CF process-szintű — recovery flow → 30s-os késleltetés.

#### G. blokk Phase 2

- **G.2 [KÉSZ]** — `_archiveInvite()` 504 timeout recovery probe. Az `error` ágon `getDocument(deterministicId)` → `status: 'created', recovered: true` (idempotent) vagy `'already_exists', existingFinalStatus, recovered: true` (race-loser). A `deterministicId` a try-blokkon kívül helyezve, hogy a catch-ben hozzáférhető legyen.
- **G.3 [KÉSZ]** — `organizationInviteHistory` env-required CAS-üzemmódban. Új helper `_assertCasGateConfigured(ctx)` action-eleji guard (500 `service_misconfigured` ha env hiányzik). 4 hívóhelyen (acceptInvite, declineInvite, createInvite, createBatchInvites) az ELSŐ DB-mutáció ELŐTT.
- **G.4 [DÖNTÖTT → ADR 0011]** — Hard-fail CAS-gate `env_missing` esetén (G.3 implementációval). Az `error` ág NEM hard-fail (G.2 recovery probe konvertálja idempotent/race-loser-re).
- **G.5 [DÖNTÖTT → ADR 0011]** — State-of-record authoritative; race-loser audit-veszteség elfogadható ha state korrekt (membership $createdAt + denormalizált `acceptedByUserId` reconstrukcióhoz). Phase 3 trigger: ha compliance regulátor explicit event-log-ot kér.

#### E. blokk Phase 2

- **E.6 [RÉSZBEN KÉSZ]** — `paginateByQuery` `maxRunMs` + `fromCursor` + `incomplete` támogatás a `helpers/pagination.js`-ben. A `backfill_admin_team_acl` action checkpoint-pattern integrációja (`payload.fromInviteCursor` + `nextCursor` return) Phase 2.x deferred — kódoldalon a `paginateByQuery` ready, a hívó action-on alkalmazni külön task.
- **E.7 [KÉSZ]** — `OrphanedOrgError extends Error` shared osztály (F.7-tel közös). `_handleCFError` `instanceof CFError` mintára átállítva (a `cfReason` szöveg-egyezés helyett).

#### Code quality / shared infrastructure

- **H.1 (Phase 2) [KÉSZ]** — `helpers/pagination.js` extract a [packages/maestro-server/functions/invite-to-organization/src/helpers/pagination.js](../packages/maestro-server/functions/invite-to-organization/src/helpers/pagination.js)-ben. 3 inline cursor-loop lecserélve (4. — `teamsApi.listMemberships` — másik API).
- **H.2 (Phase 2) [KÉSZ]** — `scripts/build-cf-orphan-guard.mjs` single-source generator. Canonical [packages/maestro-shared/orphanGuard.js](../packages/maestro-shared/orphanGuard.js); generated `_generated_orphanGuard.js` 2 CF-en. Yarn script-ek: `build:cf-orphan-guard` + `check:cf-orphan-guard`.

**AI-agent utasítás Phase 2 ütemezéshez**: ezek a tételek NEM blokkolóak, ütemezhetők egyenként vagy témablokkonként. Minden Phase 2 fix előtt KÖTELEZŐ Codex co-reflection (D.0). NE implementálj kettőnél többet egyszerre — a Phase 1-2 közti határt explicit kommit-üzenetben jelölni kell.

#### Phase 2.x deferred

- **F.8** strict ACL-szintű invariáns (ADR 0011 — Phase 3 trigger: élesben race-corrupcio incident).
- **E.6 hívó action-integráció** — `backfill_admin_team_acl` `payload.fromInviteCursor` + `nextCursor` return + a hívó (admin) iteratív retry-pattern. A `paginateByQuery` ready (`maxRunMs` + `fromCursor` + `incomplete`).

#### Phase 2 Harden Ph3 follow-upok (2026-05-09 session-5)

A `5ce596e` Phase 2 commit-on a `/harden` skill 4 fix-et ALKALMAZOTT a Codex baseline + adversarial review-k alapján (ld. [[Naplók/2026-05-09#Session-5 (Harden pass a Phase 2 commit-on, deploy ELŐTT)]] és [[Döntések/0011-cas-gate-and-orphan-guard-invariants]] Harden Ph3 szakaszok). A javítások deploy ELŐTT alkalmazódtak — KÉSZ.

**Halasztott Phase 3 follow-upok**:
- **CI generator drift** (Codex SHOULD): pre-commit hook (husky/lefthook) + GitHub Actions PR-validator a `check:cf-orphan-guard` + `check:cf-validator` script-ekre. Trigger: ha generator-out-of-sync deploy bug történik. (Phase 3, process-szintű.)
- **Audit completeness** (Codex DESIGN): a G.5 race-loser audit-loss formálisan pótolható lenne egy "race-attempt-log" collection-nel (mind a két ágat append-only logolja). Trigger: külső compliance-regulátor explicit event-log követelménye (jelenleg nincs). A jelenlegi membership-rekord-alapú reconstruction (G.5) elegendő.
- **Cursor invalidation** (Codex DESIGN): a `paginateByQuery(fromCursor)` opaque cursor-t használ — ha az adott cursor-doc törlődik a futások között, undefined behavior. Trigger: élesben checkpoint-resume bukik. Mitigation: monotonic sort key + explicit `>` filter — Phase 2.x checkpoint-pattern implementációkor merge-elendő.
- **CAS-gate config-check vs auth precedence** (Codex DESIGN): az `_assertCasGateConfigured()` az auth ELŐTT fut → unauthorized hívók info-disclosure-t kaphatnak a config-misconfig state-ről. A jelenlegi sorrend a fail-closed elv miatt elfogadható (NEM mehet semmilyen DB-mutáció a CAS-gate hiánya alatt). Trigger: ha info-disclosure security audit ezt explicit ki-jelzi.

---

## Kész — hivatkozások

A korábbi nagy Feladatok.md (lezárva 2026-05-01) érett tartalma a vault kanonikus formáira költözött:

- **Workflow lifecycle & scope** (#80–86): [[Döntések/0006-workflow-lifecycle-scope]]
- **Workflow extensions** (terv): [[Döntések/0007-workflow-extensions]]
- **Dashboard finomítás** (#23–41, A–F): kódban él
- **Design review** (#42–79, G, I): [[packages/maestro-dashboard/design-system|design-system.md]]
- **Harden follow-upok** (#89–104, K, L): [[Komponensek/AuthContext]] + [[Komponensek/DataContext]] + [[Komponensek/useOrgRole]] + [[Fejlesztési szabályok#Dashboard-specifikus szabályok]]
- **Bugfixek** (#97–99, M): [[Hibaelhárítás]] (Office nélküli szervezetre váltás után stale publikáció / workflow state)
- **UI review** (#N-01): [[Komponensek/WorkflowLibrary]]
- **Korábbi modul-harden** (#1–17): kódban él
- **Manuális smoke teszt** (#18–22): [[Munkafolyamat#Manuális smoke teszt checklist]]
- **Megnyitva tartott kérdések** (#87, #88): [[Döntések/0006-workflow-lifecycle-scope]] → "Megnyitva tartott kérdések" szekció

→ Részletek a 2026-05-01 napló-bejegyzésben: [[Naplók/2026-05-01]]
