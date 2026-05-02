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
  - `CreatePublicationModal.handleSubmit` → `createPublication` workflowId NÉLKÜL + `assign_workflow_to_publication` post-create lépésben (best-effort: ha a workflow hozzárendelés bukik, a kiadvány már létrejött, warning toast).
  - `AuthContext.activatePublication` + `assignWorkflowToPublication` callback-ek hozzáadva. `callInviteFunction` propagálja a teljes response-t (`response`) és a kulcsmezőket (`slugs`, `errors`, `unknownSlugs`) az error-ra.
  - **Lokális state patch a CF success után** ([DataContext.applyPublicationPatchLocal](packages/maestro-dashboard/src/contexts/DataContext.jsx)): a 3 hívási hely (`activate`, `workflowSelect`, `createModal`) CF response után `setPublications`-t patchel a kulcsmezőkkel (`workflowId`, `isActivated`, `activatedAt`), hogy a UI ne kelljen várjon a Realtime push-ra. Codex stop-time review KRITIKUS: e nélkül a `success` toast után rövid ideig a régi state látszott a dropdownban / aktiválás-gombnál.
  - **Stale-Realtime védelem** (Codex 2. stop-time review KRITIKUS): a CF actionök mostantól visszaadják a fresh dokumentumot (`response.publication`) az autoritatív `$updatedAt`-tel; a hívóhelyek ezzel patchelnek. `applyPublicationPatchLocal` fallback-ként `new Date().toISOString()`-et tesz a `$updatedAt`-be, ha a hívó csak részleges patchet ad — különben a `isStaleUpdate` ellenőrzés false-t adott volna a CF előtti, késleltetett Realtime push-ra, és a régi state visszaíródna.

#### A.2 — Megnyitva tartott (átkerül A.4-be)
- **`useContributorGroups` refaktor**: a `DEFAULT_ORDER` (`packages/maestro-dashboard/src/hooks/useContributorGroups.js`, `packages/maestro-indesign/src/data/hooks/useContributorGroups.js`) jelenleg a `DEFAULT_GROUPS` slug-rendezést használja — A.4 frontend feladatban átállítjuk a `compiled.requiredGroupSlugs[]` index-rendezésére, és a hook a `groups` collection-ből olvassa a `description`/`color`/`isContributorGroup`/`isLeaderGroup` mezőket.
- **`EditorialOfficeGroupsTab.DEFAULT_GROUP_SLUGS`**: a régi default-group-protected UI-flag már nem szükséges (A.2.7-ben a `delete_group` blocker-set váltotta ki) — A.4 takarítja.
- **Permission gate az `activate_publication`-ön**: jelenleg csak office membership; a B. blokk (permission sets) bekötése után `userHasPermission('publication.activate', editorialOfficeId)` guard kerül elé.
- **TOCTOU `expectedUpdatedAt` opt-in**: a Dashboard `GeneralTab` átadja a fresh `$updatedAt`-et; a Plugin-oldali aktiváló (Fázis 6 után) szintén át kell vegye.
- **CompiledValidator drift**: az inline másolat a `packages/maestro-server/.../main.js`-ben és a `packages/maestro-shared/compiledValidator.js` szinkronizálandó. CI-szintű AST-equality teszt → A.6 / Phase 2.

#### A.3 Szerver — Permission sets (új réteg)

- [ ] **A.3.1** `bootstrap_permission_sets_schema` schema bootstrap CF.
- [ ] **A.3.2** `bootstrap_organization` kibővítés: a kanonikus 3 default permission set seedelése — `owner_base` (Tulajdonos alap, 33 office-scope slug), `admin_base` (Adminisztrátor alap, 33 office-scope slug — tartalom-azonos `owner_base`-szel), `member_base` (Tag alap, 3 slug — `publication.create`, `publication.activate`, `workflow.duplicate`). A 5 `org.*` slug NEM kerül permission set-be — azokat a `userHasOrgPermission()` az `organizationMemberships.role`-ból dönti. Részletek: [[Komponensek/PermissionTaxonomy#Default permission set-ek]]. Csoport-mapping nincs (csoportok workflow-driven autoseed-elnek).
- [ ] **A.3.3** `create_permission_set`, `update_permission_set`, `archive_permission_set` CF action. **Validáció**: a `permissions[]` minden slug-ja office-scope (NEM `org.*`-prefixű) — különben **400 `org_scope_slug_not_allowed`** + a tiltott slug-ok listája.
- [ ] **A.3.4** `assign_permission_set_to_group`, `unassign_permission_set_from_group` CF action.
- [ ] **A.3.5** `maestro-shared/permissions.js`: két helper a két scope-ra. (a) `userHasPermission(user, permissionSlug, editorialOfficeId)` — **office-scope (33 slug)**: admin label → `organizationMemberships.role === 'owner'`/`admin` (mindkettő igaz a 33 office-scope slug-ra) → permission set lookup (`groupSlugs` × `groupPermissionSets` × `permissionSets.permissions[]`). Ha `org.*` slug érkezik → throw error. (b) `userHasOrgPermission(user, orgPermissionSlug, organizationId)` — **org-scope (5 slug)**: admin label → `organizationMemberships.role === 'owner'` → minden 5 slug, `admin` → 3 slug (kivéve `org.delete`, `org.rename`). Member-nek nincs org-scope slug-ja. Ha NEM `org.*` slug érkezik → throw error.
- [ ] **A.3.6** Meglévő CF-ek refactor: a megfelelő scope-helperrel guard. **Office-scope** action `userHasPermission()` (`create_workflow`, `archive_workflow`, `duplicate_workflow`, `create_office`, `invite_user_to_office` stb.); **Org-scope** action `userHasOrgPermission()` (`rename_organization`, `delete_organization`, `invite_user_to_org`, `remove_user_from_org`, `change_user_org_role`). A meglévő `update-article` state-permission marad változatlan (workflow-runtime).
- [ ] **A.3.7** Cache stratégia implementáció: (a) **Per-request memoizáció** minden CF entry-pointnál — egyszer számol `permissionSnapshot`-ot (`{userId, editorialOfficeId, orgRole, permissionSlugs: Set<string>}`); (b) **Office-scope cache** a [[Komponensek/UserContext]] (Plugin) + [[Komponensek/AuthContext]] (Dashboard) `enrichUserWithGroups()`-ban a `user.permissions: Set<string>` snapshot. Realtime-invalidáció a [[Komponensek/RealtimeBus|realtimeBus]]-on át: `groupMemberships`, `groupPermissionSets`, `permissionSets.permissions[]`, `organizationMemberships` változás esetén újraszámol. A kliens-oldali guard (pl. `useElementPermission`) a cache-ből dönt; a server-side CF guard a végső authority.

#### A.4 Dashboard UI (Editorial OS dark v2 stílusban — lásd C blokk)

- [ ] **A.4.1** Új tab vagy oldal: **"Felhasználó-csoportok"** (`EditorialOfficeSettingsModal` / `UserGroupsTab.jsx`) — lista, tagok, `label`/`description`/`color`/`isContributorGroup`/`isLeaderGroup` szerkesztése (a `slug` immutable!), törlés (`group_in_use` validációval).
- [ ] **A.4.2** Felhasználó-csoport detail panel: workflow-hivatkozások listája ("ezt a csoportot az alábbi workflow-k használják") + figyelmeztetés "üres csoport" állapotra.
- [ ] **A.4.3** Új tab: **"Jogosultság-csoportok"** (`PermissionSetsTab.jsx`) — listázás, létrehozás, archiválás.
- [ ] **A.4.4** Permission set szerkesztő (modal vagy oldal): 8 logikai csoport-fa + 38 checkbox-opció ([[Komponensek/PermissionTaxonomy]]).
- [ ] **A.4.5** `EditorialOfficeGroupsTab` bővítés: csoporthoz `permissionSet` hozzárendelés (multi-select).
- [ ] **A.4.6** Workflow Designer új tab/szekció: **"Felhasználó-csoportok"** — a workflow `requiredGroupSlugs[]` szerkesztése (`slug` + `label` + `description` + `color` + `isContributorGroup` + `isLeaderGroup`). A többi slug-mező (state-ek, transition-ök, element-engedélyek) választói erre a listára épülnek; mentéskor `unknown_group_slug` validáció.
- [ ] **A.4.7** Realtime: `permissionSets` + `groupPermissionSets` + `groups` (frissített) feliratkozás a [[Komponensek/RealtimeBus|realtimeBus]]-on át, [[Komponensek/DataContext|DataContext]] cache.
- [ ] **A.4.8** Aktiválás-flow UI: ha `empty_required_groups` 409 → modal a hiányzó csoportokkal + "Tagok hozzáadása" CTA.

#### A.5 Plugin — runtime integráció

- [ ] **A.5.1** [[Komponensek/UserContext|UserContext]] `enrichUserWithGroups()` bővítése: `permissionSets` betöltés + `user.permissions` array kiszámítása.
- [ ] **A.5.2** `useElementPermission` és társai: `groupSlugs` (megmarad — workflow-runtime) + `user.permissions` (új réteg) együtt értékelve.
- [ ] **A.5.3** Realtime: dashboard-on csoport → permission-set csere → plugin újraértékelés.

#### A.6 Smoke teszt

- [ ] **A.6.1** Manuális 2-tab smoke: workflow létrehozás új slug-okkal → kiadvány hozzárendelés → autoseed verifikálás → tag-hozzáadás → aktiválás → plugin Realtime.
- [ ] **A.6.2** Aktivált pub közbeni tag-eltávolítás: a snapshot védi a runtime-ot; UI warning + notification.
- [ ] **A.6.3** Adversarial: backend-bypass (kliens nem tud átírni állapotot ha hiányzik a jogosultság), `rowSecurity: true` cross-tenant izoláció. `slug` immutable enforcement (DevTools-ból se módosítható).

---

### B. Workflow Extensions ([[Döntések/0007-workflow-extensions|ADR 0007]] Phase 0)

> Az A blokk után indítható. Az extension-CRUD permission az új rendszerbe kerüljön (B.0.2).

#### B.0 Tervi tisztázás

- [ ] **B.0.1** `paramSchema` mező Phase 0-ban legyen, vagy halasszuk Phase 1+-be? *(Javasolt: halasztani — textarea + konstans paraméterek elég MVP-hez.)*
- [ ] **B.0.2** Extension-CRUD jogosultsága: Phase 0-tól az új permission-fába kerüljön (NEM admin-only flag)? *(Javasolt: igen, hogy később ne kelljen visszanyúlni — A blokk után ez triviálisan beillik.)*

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
