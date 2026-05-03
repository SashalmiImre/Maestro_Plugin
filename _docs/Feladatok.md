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
- [ ] **A.7.3** **`permissions.js` shared/CF inline duplikáció single-source build-step** (B.0.2 follow-up, A.7.1 minta): a [packages/maestro-shared/permissions.js](packages/maestro-shared/permissions.js) ESM modul slug-katalógusa (`ORG_SCOPE_PERMISSION_SLUGS`, `OFFICE_SCOPE_PERMISSION_SLUGS`, `PERMISSION_GROUPS`, `DEFAULT_PERMISSION_SETS`, `validatePermissionSetSlugs`, `clientHasPermission`) és a [packages/maestro-server/functions/invite-to-organization/src/permissions.js](packages/maestro-server/functions/invite-to-organization/src/permissions.js) CommonJS inline duplikációja drift-rizikót jelent (új slug, default set változás). Megoldás: új `scripts/build-cf-permissions.mjs` ESM → CJS textuális transzformációval, a shared modul kanonikus marad; a CF `permissions.js` egy új `_generated_permissionsCatalog.js`-t require-ol, az async helperek (`userHasPermission`/`userHasOrgPermission`/`buildPermissionSnapshot`) változatlanok maradnak. Yarn scriptek `build:cf-permissions` + `check:cf-permissions` (drift-detect). Post-transform token-guard 4 ESM-szintaxisra (export/import-from/dynamic import/top-level await), fail-closed throw. Triggerelje, mielőtt új slug-ot adunk a shared modulhoz.

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

#### B.1 Adatmodell

- [ ] **B.1.1** `bootstrap_workflow_extension_schema` CF.
- [ ] **B.1.2** ACL helper: `buildWorkflowAclPerms()` általánosítás vagy új `buildExtensionAclPerms()` (ADR 0006/0003 minta).

#### B.2 Shared kontraktus

- [ ] **B.2.1** `packages/maestro-shared/extensionContract.js`: JSON I/O séma (`validator` + `command` kind), slug validátor, `MAESTRO_EXTENSION_GLOBAL_NAME = 'maestroExtension'`.

#### B.3 Szerver CF

- [ ] **B.3.1** `create_workflow_extension`, `update_workflow_extension`, `archive_workflow_extension` CF action.
- [ ] **B.3.2** Kontraktus-validáció: ExtendScript szintaxis-pre-parse + dummy `maestroExtension({})` futtatás (vagy csak shape-check).
- [ ] **B.3.3** Snapshot bővítés: `activate_publication` CF — `compiledWorkflowSnapshot` mellé `compiledExtensionSnapshot` mentés.

#### B.4 Plugin runtime

- [ ] **B.4.1** Új modul: `packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js` — cache + `ext.<slug>` resolver + dispatch.
- [ ] **B.4.2** `workflowEngine.executeTransition` és `validationRunner` integráció: `ext.` prefix → extension hívás.
- [ ] **B.4.3** Realtime: `workflowExtensions` collection változások → cache invalidálás ([[Komponensek/RealtimeBus]]).
- [ ] **B.4.4** ExtendScript exec: a meglévő `app.doScript` runtime-on JSON I/O.

#### B.5 Dashboard UI

- [ ] **B.5.1** Új tab: "Bővítmények" (`WorkflowExtensionsTab.jsx`) — lista, létrehozás, archiválás.
- [ ] **B.5.2** Egyszerű textarea editor: `name`, `slug`, `kind`, `scope` (csak `article`), `code` mezők.
- [ ] **B.5.3** Workflow Designer integráció: a `validations` és `commands` választható listájában megjelennek az `ext.<slug>`-ek a beépítettek mellett.

#### B.6 Smoke teszt

- [ ] **B.6.1** End-to-end: extension létrehozás → workflow hivatkozás → publikáció aktiválás → plugin futtatás → eredmény.
- [ ] **B.6.2** Snapshot-védelem: aktivált publikáció alól az extension módosítás ne fusson le (a snapshot-ban rögzített kód fut).

---

### C. Dashboard UI redesign (Editorial OS)

> Az A blokk mátrix UI-jai (A.4) **már Editorial OS dark v2 stílusban** épülnek — a teljes redesign ezután iterál a maradékra. Stitch projekt: `1419785137701042796`.

#### C.0 Tervi tisztázás

- [ ] **C.0.1** Sorrend: A blokk után induljon, vagy paralel önálló track-en (C.1 Stitch-iteráció előrehozható már most)?
- [ ] **C.0.2** Light theme: dark v2-ből generálás (`apply_design_system`) elfogadható-e minden screenre, vagy van olyan ami külön kéz-finomítást kér?
- [ ] **C.0.3** Kétnyelvű UI (i18n) felkészülés: ezt a track-et az UI redesign keretében vagy külön blokként vezessük? *(Javaslat: külön blokk, nem ezé a fázisé — string-extraction + locale-rendszer kétnyelvűsítés önálló refactor.)*

#### C.1 Stitch screen-iteráció

- [ ] **C.1.1** Table View v2 regenerálás: relatív idő (`Ma 09:00`, `Holnap 12:00`) + subtitle + ikonos HUD + magyar nav + 5 valós sidebar item + state badge soft glow.
- [ ] **C.1.2** Publication Settings modal: timeline vizualizáció hozzáadása, warning tile láthatóbb.
- [ ] **C.1.3** Flatplan: layout kódok javítása (egybetűs `A`, `B`, `C`, `D` — nem "Section A/B/C" tab); spread-kártyák kerettelenebbek.
- [ ] **C.1.4** Workflow Designer: 7 állapot generálás (5 helyett); minimap és edge label-ek megtartása.
- [ ] **C.1.5** Hiányzó screenek: Login flow, Workflow Library Panel ([[Komponensek/WorkflowLibrary]] már LIVE — csak vizuál), Org Settings (Groups Matrix), Create Publication modal.
- [ ] **C.1.6** Light theme variáns generálás dark v2 alapról (`apply_design_system`).

#### C.2 Implementáció

- [ ] **C.2.1** Editorial OS design system kódba emelése: CSS tokenek, komponens-típusok ([[packages/maestro-dashboard/design-system|design-system.md]]).
- [ ] **C.2.2** Table View v2 implementáció.
- [ ] **C.2.3** Publication Settings timeline implementáció.
- [ ] **C.2.4** Flatplan layout kódok javítás.
- [ ] **C.2.5** Workflow Designer canvas finomítás (node accent ring, soft glow, edge label).
- [ ] **C.2.6** Hiányzó screenek implementáció (Login, Org Settings Groups Matrix, Create Publication modal).
- [ ] **C.2.7** Light theme support kódszinten.

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
