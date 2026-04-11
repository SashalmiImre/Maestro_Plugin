---
aliases: [TODO, Tasks, Teendők]
tags: [feladatok]
---

# Feladatok

> Ide gyűjtsd a fejlesztési ötleteket, bugokat, teendőket. A Claude Code is olvassa — megbeszéljük, majd kipipáljuk.

## Aktív

### 🎨 Dashboard Redesign — Modal UI, Breadcrumb fejléc, Kiadványkezelés áthelyezés

> A Dashboard teljes UI átalakítása: modal-alapú beállítási ablakok, breadcrumb navigáció a sidebar helyett, kiadványkezelés áthelyezése a pluginból a dashboardra, többszörös workflow támogatás, publikáció aktiválási rendszer.

#### Fázis 1 — Modal rendszer infrastruktúra ✅ (2026-04-10)

- [x] `Modal.jsx` komponens: portál-alapú (createPortal → body), lekerekített kártya, backdrop blur, `size` prop (sm/md/lg/xl), ESC (csak topmost modal) + focus trap + scroll lock (globális számláló), `requestAnimationFrame` fókusz
- [x] `ModalContext.jsx`: modal stack kezelés — `openModal(element, props)` / `closeModal()` / `closeModalById()`, növekvő z-index (BASE=1000, +10/réteg), monoton ID számláló
- [x] `ConfirmDialog.jsx` (dashboard): content-only megerősítő dialógus `verificationExpected` prop-pal (név begépelés), `useConfirm()` Promise-alapú hook (ModalContext-en keresztül nyit, nested modal safe)
- [x] `Tabs.jsx` komponens: vízszintes fülsáv, controlled `activeTab`, ARIA role-ok — beállítás modalok belső navigációjához
- [x] Modal + ConfirmDialog + Tabs CSS stílusok a `css/styles.css`-ben
- [x] Harden pass: ESC cascade fix, scroll lock fix, ConfirmDialog double-wrap refaktor, focus trap edge case

#### Fázis 2 — Fejléc átalakítás (Breadcrumb navigáció) ✅ (2026-04-10)

- [x] `BreadcrumbDropdown.jsx`: újrafelhasználható dropdown — click-re nyílik, „Beállítások" menüpont tetején + divider + ABC rendezett opciók (memoizált), `usePopoverClose` hook
- [x] `UserAvatar.jsx`: kör alakú 2 betűs monogram a `user.name`-ből, kattintásra dropdown menü, `popup-item/divider` közös CSS osztályok
- [x] `BreadcrumbHeader.jsx`: **Bal**: logó → Szervezet dropdown → Szerkesztőség dropdown → Publikáció dropdown; **Jobb**: nézet váltó + cikkszám + szűrő gomb + UserAvatar
- [x] `DashboardLayout.jsx` refaktor: `BreadcrumbHeader`, scope-váltás data refresh (cancellation guard + üres state reset), `switchPublication(null)` kezelés DataContext-ben
- [x] `usePopoverClose.js` hook: közös outside-click + ESC bezáró logika (BreadcrumbDropdown + UserAvatar)
- [x] `DashboardHeader.jsx` + `Sidebar.jsx` + `ContentHeader.jsx` törlése, CSS takarítás
- [ ] Beállítás route-ok átalakítása modalokra: `OrganizationAdminRoute` → `OrganizationSettingsModal`, `EditorialOfficeAdminRoute` → `EditorialOfficeSettingsModal` (Fázis 4-ben)

#### Fázis 3 — DB séma változások ✅ (2026-04-10)

- [x] `publications` collection: új `workflowId` string mező (opcionális, size 36) + index
- [x] `publications` collection: új `isActivated` boolean mező (default: `false`) + index
- [x] `publications` collection: új `activatedAt` datetime mező (opcionális)
- [x] `workflows` collection: `name` string mező — **már létezett** (required, size 255, a bootstrap CF seed-eli)
- [x] ~~Migráció~~: fejlesztési fázis, adat dobható — nem szükséges

#### Fázis 4 — Kiadványkezelés a Dashboardon ✅ (2026-04-10)

- [x] Dashboard `DataContext.jsx` bővítés: `createPublication`, `updatePublication`, `deletePublication` write-through metódusok (plugin DataContext mintájára) *(2026-04-10 kész — `withScope()` helper + optimista update + `$updatedAt` staleness guard)*
- [x] Dashboard `DataContext.jsx` bővítés: `createLayout`, `updateLayout`, `deleteLayout` + `createDeadline`, `updateDeadline`, `deleteDeadline` write-through metódusok *(2026-04-10 kész — `deleteLayout(id, reassignToId)` kaszkádol érintett cikkek `layoutId`-ját, `workflows[]` plural state + Realtime szinkron)*
- [x] `CreatePublicationModal.jsx`: név, rootPath (szöveg), fedés start/end, workflowId dropdown → mentés + auto „A" layout létrehozás *(2026-04-10 kész — `isActivated: false` default, workflow dropdown 1-workflow esetén disabled, layout fail non-blocking warning)*
- [x] `PublicationSettingsModal.jsx` — **Általános** fül: név, fedés (start/end), rootPath (r/o), excludeWeekends, workflowId dropdown *(2026-04-10 kész — blur-save minta, Realtime prop-sync useEffects, workflow váltás toast visszajelzéssel)*
- [x] `PublicationSettingsModal.jsx` — **Layoutok** fül: port a plugin `LayoutsSection.jsx`-ből (CRUD, auto A-Z elnevezés) *(2026-04-10 kész — `getNextLayoutName`, 8 rotáló DEFAULT_COLORS, reassign dropdown törléskor, min 1 layout enforce)*
- [x] `PublicationSettingsModal.jsx` — **Határidők** fül: port a plugin `DeadlinesSection.jsx`-ből (oldalszám-tartomány + dátum/idő, validáció: átfedés, fedés, formátum) *(2026-04-10 kész — `@shared/deadlineValidator.js` import, 300ms debounced full-list validáció, invalid field piros keret)*
- [x] `PublicationSettingsModal.jsx` — **Közreműködők** fül: port a plugin `ContributorsSection.jsx`-ből (csoport-alapú dropdown-ok, bulk update ajánlás) *(2026-04-10 kész — Dashboard `useContributorGroups` hook, smart update ajánlat null-contributor cikkekre)*
- [x] Breadcrumb publikáció dropdown: „Új kiadvány" menüpont (→ `CreatePublicationModal`) *(2026-04-10 kész — `BreadcrumbDropdown` bővült `onCreate` prop-pal + divider, `BreadcrumbHeader` wireing `openModal`-lal)*
- [x] Deadline validációs logika áthelyezése `maestro-shared`-be (formátum, átfedés, fedés ellenőrzés) — vagy Dashboard saját hook *(2026-04-10 kész — `packages/maestro-shared/deadlineValidator.js` statikus helperek: `isValidDate`, `isValidTime`, `validateDeadlines`, `buildDatetime`, `getDateFromDatetime`, `getTimeFromDatetime`, plugin `DeadlineValidator.js` delegál rá)*
- [x] Harden pass: 3 iterációs Codex review — publikációk/határidők `$updatedAt` staleness guard, `workflow` derived `useMemo` + fail-closed stale `workflowId`, `excludeWeekends ?? true` default, DeadlinesTab dead-code simplify, GeneralTab `invalid-input` osztályok, CreatePublicationModal auto-workflow-pick effect
- [ ] **Verifikáció**: Dashboard-on publikáció létrehozás/szerkesztés/törlés, Realtime szinkron a pluginban

#### Fázis 5 — Publikáció aktiválás ✅ (2026-04-10)

- [x] `GeneralTab.jsx` „Aktiválás" szekció (Általános tab alján): validáció (deadline fedés teljes + nincs átfedés + workflowId kitöltve) → ConfirmDialog (részletes magyarázattal a nem módosítható paraméterekről) → `isActivated: true`, `activatedAt: now()`
- [x] Aktiválás után: workflowId dropdown disabled (tooltip: „Workflow aktiválás után nem módosítható.")
- [x] `maestro-shared/publicationActivation.js`: `validatePublicationActivation(publication, deadlines)` → `{ isValid, errors[] }` — thin wrapper a `validateDeadlines` köré + workflowId ellenőrzés
- [x] Plugin `DataContext.jsx`: `fetchData` publications query + `Query.equal('isActivated', true)`, Realtime handler `isActivated` szűrés (nem aktivált pub eltávolítása, deaktiválás kezelése)
- [x] `validate-publication-update` CF bővítés: `isActivated === true` esetén deadline lekérés + inline `validatePublicationActivation` → invalid esetén revert (`isActivated: false`, `activatedAt: null`). Inline helper (`validateDeadlinesInline`, `validatePublicationActivationInline`) a maestro-shared másolataként. Új env var: `DEADLINES_COLLECTION_ID` (Appwrite Console-on kézzel hozzáadandó).
- Megjegyzés: A szerver-oldali `workflowId` immutability **Fázis 6** hatáskör — a post-event CF nem látja a pre-update állapotot, ezért a cikkek létezése alapján (`articles.length > 0 && isActivated`) fogjuk kikényszeríteni. Fázis 5-ben a Dashboard UI disabled dropdown + tooltip véd a normál használat ellen.

#### Fázis 6 — Workflow zárolás cikkek mellett ✅ (2026-04-11)

- [x] `PublicationSettingsModal.jsx` (GeneralTab): ha a publikációhoz tartozik cikk (`articles.some(a => a.publicationId === pub.$id)`) → workflowId dropdown disabled + tooltip "A kiadványhoz már tartoznak cikkek — a workflow nem módosítható." Az `isActivated` prioritást kap a tooltip prioritásban.
- [x] `article-update-guard` CF: `getWorkflowForPublication(parentPublication)` helper — elsődleges a `publication.workflowId` szerinti lookup cross-tenant scope check-kel (`doc.editorialOfficeId === parent.editorialOfficeId`). **Fail-closed**: ha `workflowId` explicit megadva, de 404 / scope mismatch / parse error → `null` (cikk update blokkolva). Legacy office-first fallback kizárólag akkor aktiválódik, ha `publication.workflowId === null` (pre-Fázis 7 rekordok). A cache Map-alapú (`wf:${id}` vagy `office:${id}` kulccsal, 60s TTL, FIFO eviction CACHE_MAX_ENTRIES=32-től). Ez egyben Fázis 7 (többszörös workflow) előkészítés is.
- [x] `validate-publication-update` CF bővítés: új §6 — `isActivated=true` + van cikk + (workflowId null VAGY workflow doc office mismatch) → deaktiválás (`isActivated=false, activatedAt=null`). 404 workflow doc → csak logolás (admin-döntés tisztelete). Új env var-ok: `ARTICLES_COLLECTION_ID`, `WORKFLOWS_COLLECTION_ID` (Appwrite Console-on kézzel hozzáadandó).
- Megjegyzés: A pre-update snapshot nélküli CF nem tudja megkülönböztetni az office-on belüli workflow cserét (A → B, mindkettő ugyanabban az office-ban). Ezt a Dashboard UI disabled dropdown fedi. Valódi immutabilitás `activatedWorkflowId` séma-mezővel lenne — Fázis 6.1 ha production use case indokolja.

#### Fázis 7 — Többszörös workflow támogatás

- [x] Workflow Designer route bővítés: workflow lista/választó az office-on belül, „Új workflow" gomb, rename input a toolbar-ban, route: `/admin/office/:officeId/workflow/:workflowId`, régi `/admin/office/:officeId/workflow` URL redirect-el az első workflow-ra (`WorkflowDesignerRedirect.jsx`) *(2026-04-11)*
- [x] Dashboard `DataContext.jsx`: `workflows` (többes szám) state az office összes workflow-jával (publication settings dropdown-hoz), `fetchWorkflows()` metódus *(2026-03 — Fázis 4 keretében előre meg lett csinálva)*
- [x] Plugin `DataContext.jsx`: `workflows[]` plural state + három külön useMemo (parse cache docId-alapján, `activeWorkflowId` külön memo a publikáció-váltás szűk deps-ével, derived `workflow`) a `publication.workflowId` alapján. **Fail-closed**: ha nincs `activeWorkflowId` vagy a cache nem tartalmazza az ID-t → `null` (nincs `workflows[0]` fallback, nincs legacy fallback — konzisztens adatok elvárva). Realtime handler merge-öli a workflows[]-t (create/update/delete), `workflowChanged` event külön useEffect-ben `prevWorkflowRef`-fel a derived identitás változására *(2026-04-11, harden pass)*
- [x] `invite-to-organization` CF: új `create_workflow` action (office-hoz új workflow, owner/admin only, `DEFAULT_WORKFLOW` klónozás, név unique check); `update_workflow` bővítés opcionális `workflowId` + `name` paraméterrel (rename + stabil multi-workflow targeting, scope check: `workflowDoc.editorialOfficeId === editorialOfficeId`) *(2026-04-11)*

#### Fázis 8 — Törlés névmegerősítéssel (kaszkád)

- [x] `OrganizationSettingsModal` + `EditorialOfficeSettingsModal`: `OrganizationAdminRoute` / `EditorialOfficeAdminRoute` portja modal-ra (wrapper → `publication-settings-modal`, `closeModal + navigate` kombináció a workflow / groups linkeknél). A BreadcrumbHeader org/office dropdown „Beállítások" menüpontja már ezeket nyitja meg — a régi `/settings/organization` és `/settings/editorial-office` route-ok és a hozzájuk tartozó fájlok törölve. *(2026-04-11)*
- [x] `OrganizationSettingsModal`: piros „Veszélyes zóna" szekció `owner` role-nak → `ConfirmDialog` `verificationExpected={org.name}` (szervezet nevének pontos begépelése, kis- és nagybetű érzékeny) → `deleteOrganization()` + toast + `reloadMemberships()` → `ScopeContext` auto-pick *(2026-04-11)*
- [x] `EditorialOfficeSettingsModal`: piros „Veszélyes zóna" szekció `owner`/`admin` role-nak → `ConfirmDialog` `verificationExpected={office.name}` → `deleteEditorialOffice()` + toast + `reloadMemberships()` *(2026-04-11)*
- [x] `PublicationSettingsModal` / `GeneralTab`: piros „Veszélyes zóna" szekció `owner`/`admin` role-nak (ideiglenes jogosultság-szűrés, UI jog rendszer később felülírja) → `ConfirmDialog` `verificationExpected={publication.name}` → `deletePublication()` + toast + `closeModal()` (a DB `publications.delete` event a `cascade-delete` CF-et triggereli automatikusan) *(2026-04-11)*
- [x] `AuthContext`: `deleteOrganization(organizationId)` + `deleteEditorialOffice(editorialOfficeId)` wrapper-ek (`callInviteFunction` helper-en át), `orgMemberships` state expozíció a `GeneralTab` role check-hez *(2026-04-11)*
- [x] CF `delete_organization` action (owner-only): lapozott, fail-closed kaszkád törlés — minden alárendelt office-ra `cascadeDeleteOffice` helper (publications doc-onkénti `deleteDocument` → `cascade-delete` CF event kaszkád; workflows, groups, groupMemberships, officeMemberships parallel `deleteByQuery`), majd organizationInvites, **az org doc**, végül organizationMemberships. A memberships az org doc UTÁN törlődnek, hogy a caller owner-sége megmaradjon a kritikus ponton (különben egy félúton elhasalt delete árva, újra-törölhetetlen szervezetet hagyna). Új env var: `PUBLICATIONS_COLLECTION_ID` (scope-olva a delete ágakra, így a meglévő invite/workflow flow-k nem törnek le, ha az env var még hiányzik). *(2026-04-11, harden pass: lapozás + fail-closed + memberships reorder)*
- [x] CF `delete_editorial_office` action (owner/admin-only): fail-closed kaszkád a `cascadeDeleteOffice` helper-rel (publications → `cascade-delete` CF, workflows, groups, groupMemberships, editorialOfficeMemberships), majd az office doc. Bármely részleges gyerek cleanup → `cascade_failed` error + nem törli a szülőt. *(2026-04-11, harden pass)*
- [x] Dashboard `DataContext.jsx`: aktív publikáció törlésekor az `activePublicationId` és a derived state (articles/layouts/deadlines/validations) null-ázása. Szimmetrikusan **két helyen** fut: (1) a Realtime `publications.delete` handlerben (távoli törlés / másik kliens) és (2) a `deletePublication` optimista CRUD úton (Realtime disconnect alatt is megvédi a UI-t az árva doc állapottól). *(2026-04-11, harden pass + verifikációs kör)*
- [ ] **Verifikáció**: minden szinten törlés → az alatta lévő összes adat eltűnik, plugin is tükrözi (end-to-end MCP Chrome DevTools + Appwrite MCP smoke test — függőben, a `PUBLICATIONS_COLLECTION_ID` env var beállítása után az Appwrite Console-on)

#### Fázis 9 — Plugin egyszerűsítés

- [x] Plugin `DataContext.jsx`: `createPublication`/`updatePublication`/`deletePublication` + layout/deadline write-through metódusok + Context value kulcsok eltávolítása; a Realtime layouts handler új `MaestroEvent.layoutChanged` dispatchet kapott, hogy a Dashboard-oldali layout CRUD triggerelje a plugin `useOverlapValidation` újraszámítását *(2026-04-11)*
- [x] `usePublications.js` / `useLayouts.js` / `useDeadlines.js` hook fájlok törlése — a Plugin a DataContext-et közvetlenül olvassa *(2026-04-11)*
- [x] `PublicationListToolbar.jsx` „+" gomb eltávolítása *(2026-04-10 — Fázis 5 harden pass keretében előrehozva: a plugin-oldali create gomb elvezetne egy nem aktivált, tehát a plugin számára láthatatlan rekordhoz; csak a belépési pont lett letiltva, a `createPublication` API Fázis 9-ben került törlésre)*
- [x] `PublicationProperties/` teljes mappa törlése (GeneralSection, LayoutsSection, DeadlinesSection, ContributorsSection) *(2026-04-11)*
- [x] `Publication.jsx`: csak olvasható mód — nincs rename/delete handler, a properties dupla kattintás helyett a publikáció fejléc és a hover toolbar új „Megnyitás a Dashboardon" (`sp-icon-link-out`) ikonja nyitja a Dashboardot JWT auto-loginnal *(2026-04-11)*
- [x] `Workspace.jsx`: properties nézet csak cikkekre (`selectedType` mező törlése), `handleOpenDashboard(pubId?)` refaktor opcionális paraméterrel — `?pub=<id>` query + `#jwt=<token>` fragment, prop drill `PublicationList` → `Publication` útvonalon *(2026-04-11)*
- [x] `PropertiesPanel.jsx`: publication ág törlése, csak `ArticleProperties`-t renderel *(2026-04-11)*
- [x] CLAUDE.md frissítés: Architektúra DataContext Write-through szekció (szűk hatókör + Realtime layoutChanged dispatch) + DataContext API referencia (Olvas-csak szekció a publikáció/layout/határidő collection-ökhöz) *(2026-04-11)*
- [x] Harden pass: (1) `publicationCoverageChanged` új dispatcher a publications Realtime `.update` handlerben (`{ publication }` payload, `latestPublicationsRef` alapú Strict Mode-safe check a `setPublications` előtt) — Dashboard-oldali coverage szűkítés most triggereli az overlap újraszámítást a pluginban; (2) `useOverlapValidation` per-publikáció 250 ms `setTimeout` debounce + override accumulation Map-pel a `layoutChanged` storm (bulk Dashboard CRUD) ellen + empty-sibling early-return + unmount cleanup; (3) `PublicationList.jsx` új empty state aktivált kiadvány hiányában (Dashboard CTA); (4) `Publication.jsx` hover toolbar billentyűzet-a11y (`isFocused` state + `sp-action-button` `slot="icon"` minta, dead `sp-body` wrapper törlés); (5) `DeadlineValidator.js` törlés (orphan a DeadlinesSection törlés után) + üres `PublicationProperties/` mappa + 4 árva `STORAGE_KEYS.SECTION_PUBLICATION_*` konstans takarítás; (6) doc sync (EVENT_ARCHITECTURE payload + URGENCY/VALIDATION/README/CLAUDE.md) *(2026-04-11, Codex baseline + adversarial + verifying review, simplify pass kritikus payload contract bug fix-szel)*
- [ ] **Verifikáció**: plugin-ban nincs pub CRUD, Realtime szinkron működik, dashboard link elérhető (build + dead-code grep + funkcionális smoke test)
- [ ] **Follow-up (külön task)**: `article-update-guard` CF kiterjesztése — a permission block jelenleg csak `stateChanged` mezőt védi, de a jogosultság-visszavonás fail-closed biztosításához minden cikk-update mezőre (startPage/endPage/contributors/name/...) futnia kell. Scope: [packages/maestro-server/functions/article-update-guard/src/main.js:365-390](packages/maestro-server/functions/article-update-guard/src/main.js). Eredet: Fázis 9 harden pass Design Question — user döntés 2026-04-11.

## Kész

### 🎯 Workflow Designer + Multi-tenant átalakítás

> A Maestro egybérlős, hardkódolt workflow-jának teljes átalakítása dinamikus, multi-tenant rendszerré ComfyUI-stílusú vizuális designerrel a Dashboardon. Teljes terv: [workflow-designer/ARCHITECTURE.md](workflow-designer/ARCHITECTURE.md). State tracker: [workflow-designer/PROGRESS.md](workflow-designer/PROGRESS.md).

#### Fázis 0 — Dokumentációs alap + Stitch UI tervek

- [x] `_docs/workflow-designer/` mappa létrehozása PROGRESS/ARCHITECTURE/DATA_MODEL/COMPILED_SCHEMA/MIGRATION_NOTES/UI_DESIGN fájlokkal
- [x] Régi workflow dokumentumok (`WORKFLOW_CONFIGURATION.md`, `WORKFLOW_PERMISSIONS.md`) áthelyezése `_docs/archive/`-ba
- [x] `packages/maestro-indesign/CLAUDE.md` tetejére „Átalakítás folyamatban" banner
- [x] `_docs/Feladatok.md` `## Aktív` szekcióba a Fázis 0–7 teljes task lista
- [x] `auth-flow` Stitch kép mentve: [workflow-designer/stitch-screens/auth-flow.png](workflow-designer/stitch-screens/auth-flow.png) + annotáció
- [x] `designer-canvas` Stitch kép mentve: [workflow-designer/stitch-screens/designer-canvas.png](workflow-designer/stitch-screens/designer-canvas.png) + annotáció
- [x] `state-node` Stitch kép mentve: [workflow-designer/stitch-screens/state-node.png](workflow-designer/stitch-screens/state-node.png) + annotáció
- [x] `properties-sidebar` Stitch kép mentve: [workflow-designer/stitch-screens/properties-sidebar.png](workflow-designer/stitch-screens/properties-sidebar.png) + annotáció

#### Fázis 1 — Scope bevezetés + teljes auth flow a Dashboardon

- [x] Új collectionök: `organizations`, `organizationMemberships`, `editorialOffices`, `editorialOfficeMemberships`, `organizationInvites`
- [x] Scope mezők (`organizationId`, `editorialOfficeId`) hozzáadása a `publications`, `articles`, `layouts`, `deadlines`, `uservalidations`, `validations` collectionökhöz
- [x] `appwriteIds.js` frissítés az új collection ID-kkal (a régi `TEAMS` enum egyelőre marad, `@deprecated` JSDoc-kal)
- [x] Új Cloud Function: `invite-to-organization` — token generálás (e-mail küldés Fázis 6-ra halasztva), `bootstrap_organization` + `create` + `accept` action egy CF-ben, ACL-alapú védelem *(B.5 kész + biztonsági javítás)*
- [x] ~~Új Cloud Function: `organization-membership-guard`~~ — **TÖRÖLVE** *(B.5 adversarial review után): a sentinel pattern kliens-forgeable volt, helyette ACL lockdown (5 tenant collection `read("users")` only) + `bootstrap_organization` action a `invite-to-organization` CF-ben.*
- [x] Meglévő CF-ek (article-update-guard, validate-article-creation, validate-publication-update) officeId scope átvétele *(B.8 kész — `hasOfficeMembership` helper + `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID` env var mindhárom guardban; article-update-guard state revert, validate-article-creation delete cross-tenant esetén, validate-publication-update delete create-nél + log-only update-nél. Legacy null scope → skip + warning log.)*
- [x] Dashboard: `react-router-dom` telepítés (v7.14.0)
- [x] Dashboard route `/login` — bejelentkezés (LoginRoute.jsx, az AuthSplitLayout brand részével)
- [x] Dashboard route `/register` — regisztráció (név, e-mail, jelszó) + `account.createVerification(DASHBOARD_URL/verify)` *(B.4 kész)*
- [x] Dashboard route `/verify?userId=&secret=` — e-mail verifikáció callback + átirányítás `/login?verified=1`-re *(B.4 kész)*
- [x] Dashboard route `/onboarding` — első belépés: új org létrehozása (org név + office név → automatikus workflow seed) vagy meghívó token bevitel *(B.5 kész — 4-collection write `createOrganization` + invite accept ág; `workflowId: null` Fázis 4-ig)*
- [x] Dashboard route `/invite?token=` — meghívó elfogadás (token validáció, user bejelentkezve vagy regisztrációra redirect) *(B.5 kész — token tárolás InviteRoute, acceptInvite() OnboardingRoute-on)*
- [x] Dashboard route `/forgot-password` — `account.createRecovery(email, DASHBOARD_URL/reset-password)` *(B.4 kész)*
- [x] Dashboard route `/reset-password?userId=&secret=` — új jelszó form, `account.updateRecovery()` *(B.4 kész)*
- [x] Dashboard route `/settings/password` — bejelentkezett jelszó módosítás `account.updatePassword()` *(2026-04-09 kész — `SettingsPasswordRoute.jsx` a védett + `AuthSplitLayout` ágban, `DashboardHeader` "Jelszó módosítása" link)*
- [x] Plugin `appwriteConfig.js` `VERIFICATION_URL` + `RECOVERY_URL` átállítása Dashboard domainre *(B.6 kész — a két URL a `DASHBOARD_URL`-ből származik, Webpack DefinePlugin `process.env.DASHBOARD_URL` inject)*
- [x] Proxy régi reset oldalának megszüntetése vagy Dashboard redirect *(B.6 kész — `GET /verify` + `GET /reset-password` 302 redirect Dashboardra, `POST /reset-password` 410 Gone, HTML helperek + `node-appwrite` dependency törölve)*
- [x] Plugin `UserContext` + Dashboard `AuthContext` új state-ek: `organizations`, `editorialOffices`, `activeOrganizationId`, `activeEditorialOfficeId` *(B.4: Dashboard `AuthContext` kész; B.7 (2026-04-08): Plugin `UserContext` megkapta a `fetchMemberships` + `organizations`/`editorialOffices`/`membershipsError`/`reloadMemberships` state-et, új `ScopeContext.jsx` auto-pick + stale validációval, Main.jsx `ScopeProvider` wrap + `ScopedWorkspace` + `ScopeMissingPlaceholder`)*
- [x] Plugin + Dashboard `DataContext`: minden lekérdezésbe `Query.equal('editorialOfficeId', activeOfficeId)` szűrés *(B.7 (2026-04-08) Plugin oldal: publications/articles/layouts/deadlines/uservalidations fetch scope-szűrt, Realtime payload-szűrés a `.delete` kivételével, write-through `withScope()` helper inject organizationId+editorialOfficeId a `createPublication/Article/Layout/Deadline/Validation` payloadba, office-váltás side effect nullázza az `activePublicationId`-t; Dashboard oldal a B.4-ben már készen volt)*
- [x] Teszt adat törlése, új user regisztrációval indulás *(B.9 kész — 2026-04-08: 6 data collection wipe-olva MCP-vel (publications 4, articles 139, layouts 16, deadlines 10, uservalidations 13, validations 3 = 185 row), articlemessages üres volt, thumbnails bucket 147 → 0 (146 casc\u00e1d CF + 1 orphan manuális). Minden 0, friss regisztrációra kész.)*
- [x] **Verifikáció**: regisztráció → e-mail verifikáció → onboarding → org + office létrejön → üres workspace. Elfelejtett jelszó flow. Meghívó flow két user között. Plugin bejelentkezés. *(B.10 kész — Chrome MCP automatizált tesztelés, 2026-04-09. OnboardingRoute `.auth-link-button` összefolyás javítva.)*

#### Fázis 2 — Dinamikus csoportok (groups, groupMemberships)

- [x] Új collection-ök: `groups` (slug, name, editorialOfficeId, organizationId, description, createdByUserId) + `groupMemberships` (groupId, userId, editorialOfficeId, organizationId, role, addedByUserId, userName, userEmail denormalizált)
- [x] Új shared modul: `packages/maestro-shared/groups.js` — `DEFAULT_GROUPS` (7 alapértelmezett csoport), `resolveGroupSlugs()` helper
- [x] CF `invite-to-organization` bővítés: `bootstrap_organization` action 7 group + 7 groupMembership seeding, `add_group_member` action (office membership + aktív/verifikált user check), `remove_group_member` action — mindhárom idempotens
- [x] Plugin `UserContext`: `enrichUserWithGroups()` + `refreshGroupSlugs()` — `groupMemberships` + `groups` query, `scopeChanged`/`groupMembershipChanged` MaestroEvent listener, `sameGroupSlugs()` Set-alapú összehasonlítás
- [x] Plugin `DataContext`: `groupMemberships` collection Realtime csatorna (office scope szűréssel), `groupMembershipChanged` MaestroEvent dispatch
- [x] Plugin `ScopeContext`: `setActiveOffice()` → `scopeChanged` MaestroEvent dispatch
- [x] Új hook: `useGroupMembers(groupSlug)` + `useAllGroupMembers()` — scope-szűrt, 5 perces cache, generation guard, Realtime invalidálás. Kiváltja `useTeamMembers` + `useAllTeamMembers`-t (törölve).
- [x] `user.teamIds` → `user.groupSlugs` átnevezés: `workflowPermissions.js`, `elementPermissions.js`, `useElementPermission.js`, `Publication.jsx`, `PropertiesPanel.jsx`, `ContributorsSection.jsx` (×2), `ValidationSection.jsx`, `ArticleTable.jsx`, `useArticles.js`, `useFilters.js`
- [x] Dashboard `AuthContext`: `fetchGroupSlugs()` (`groupMemberships` query, `resolveGroupSlugs`)
- [x] Dashboard `DataContext`: `fetchAllGroupMembers()` (közvetlen `groupMemberships` query, denormalizált userName)
- [x] Dashboard `/settings/groups` admin UI: csoporttagok listázása, hozzáadás/eltávolítás CF action-ökön keresztül
- [x] CF `article-update-guard`: `getUserGroupSlugs()` (groupMemberships → slug feloldás), `null`-return pattern transient DB hibákra (fail-open + error log a false denial elkerüléséért)
- [x] Cleanup: `useTeamMembers.js` + `useAllTeamMembers.js` törölve, `teamMembershipChanged` event törölve, `TEAMS` enum + `GET_TEAM_MEMBERS_FUNCTION_ID` törölve, `teams` SDK import + instance törölve, Appwrite Console: 7 Team + `get-team-members` CF törölve MCP-vel
- [x] Harden pass: `.rows`/`.documents` fallback (`tables.listRows` kompatibilitás), generation guard (`useGroupMembers` stale response védelem), office scope szűrés (DataContext Realtime), bootstrap rollback officeMembership ID fix, target user office membership + aktív/verifikált check (`add_group_member`), `getUserGroupSlugs` null-return pattern
- [x] Dokumentáció: Plugin + Server CLAUDE.md frissítve a group-alapú architektúrára

#### Fázis 3 — Dinamikus contributor mezők ✅ (2026-04-09)

- [x] `articles` schema: új `contributors` longtext (JSON), a 7 régi `*Id` mező törlése
- [x] `publications` schema: új `defaultContributors` longtext (JSON), a 7 régi `default*Id` mező törlése
- [x] `TEAM_ARTICLE_FIELD` mapping törlése — a kulcs a csoport `slug`-ja
- [x] `ContributorsSection.jsx` (plugin): fix JSX helyett loop a `useContributorGroups()` hook alapján, dinamikus dropdown rendering
- [x] `canEditContributorDropdown`: közvetlen `groupSlug` paraméter (változatlan — már Fázis 2-ben készen volt)
- [x] `validate-article-creation` és `article-update-guard` és `validate-publication-update`: `contributors`/`defaultContributors` JSON parse → kulcs iterálás → userId validáció → nullázás/logolás
- [x] Új shared modul: `maestro-shared/contributorHelpers.js` (parseContributors, getContributor, setContributor, isContributor)
- [x] Dashboard `useFilters.js`: `isContributor()` + `getUserGroupSlugs()`
- [x] Harden pass: 6 hibás relative import → bare specifier (`"maestro-shared/..."`), Dashboard `getUserGroupSlugs()` early return javítás (capability label-ek kihagyódtak `groupSlugs` falsy esetén)
- [x] **Verifikáció**: kód-áttekintés + DB séma ellenőrzés (2026-04-09) — addArticle JSON forwarding, ContributorsSection dinamikus loop, CF-ek JSON parse/validáció, régi 7 mező törölve az articles + publications sémából

#### Fázis 4 — Workflow runtime (workflows collection, `compiled`) ✅

- [x] Új collection: `workflows` — minden új office auto kap egy dokumentumot a `defaultWorkflow.json` template másolataként
- [x] Új shared modul: [packages/maestro-shared/workflowRuntime.js](../packages/maestro-shared/workflowRuntime.js) — 16+ fogyasztói helper a `compiled` JSON fölött
- [x] Új template: [packages/maestro-shared/defaultWorkflow.json](../packages/maestro-shared/defaultWorkflow.json) — 8 állapotos magazin workflow `compiled` formátumban
- [x] **TÖRÖLT**: `workflowConfig.js`, `labelConfig.js`, `workflowConstants.js`, `elementPermissions.js`, `syncWorkflowConfig.js`, `validate-labels/`
- [x] `workflowEngine.js` és `workflowPermissions.js` proxy a `workflowRuntime.js`-re
- [x] Plugin `DataContext` workflow state + fetch + Realtime hot-reload
- [x] CF-ek átírás: `workflows` collection olvasás, 60s TTL process cache, fail-closed
- [x] Label rendszer eltávolítás — `user.groupSlugs` az egyetlen jogosultsági forrás
- [x] Plugin + Dashboard UI fogyasztók átírás (~20 fájl)
- [x] CLAUDE.md frissítés a dinamikus modellre
- [x] Build verifikáció: plugin (webpack) + dashboard (vite) sikeres, 0 stale import
- [x] **Appwrite Console tennivalók** (MCP-vel): `WORKFLOWS_COLLECTION_ID` env var hozzáadás (3 CF), `config` collection + `validate-labels` CF + `Get Team Members` CF törlés, `appwrite.json` cleanup *(2026-04-09)*

#### Fázis 5 — Workflow Designer UI (Dashboardon) ✅ (2026-04-09)

- [x] Függőségek: `@xyflow/react` (MIT, React Flow v12)
- [x] Új mappa: `packages/maestro-dashboard/src/features/workflowDesigner/` (20 új fájl)
- [x] `WorkflowDesignerPage.jsx` — konténer, betölt + ment `workflows` dokumentumot, DnD, save flow, Realtime awareness
- [x] `WorkflowCanvas.jsx` — xyflow-alapú canvas (ReactFlow + MiniMap + Controls + Background)
- [x] `nodes/StateNode.jsx` — custom state node komponens (szín sáv, label, slug, duration, validátor/command badge, initial/terminal ikonok)
- [x] `edges/TransitionEdge.jsx` — custom edge (label + irány nyíl, szín kódolás direction szerint)
- [x] `NodePalette.jsx` — bal oldali palette drag-n-drop-pal (HTML5 DnD, 6 szín)
- [x] `PropertiesSidebar.jsx` — jobb oldali panel, kiválasztott elem tulajdonságai (state/transition/workflow)
- [x] ~~`GroupsPanel.jsx`~~ — placeholder tab a `WorkflowPropertiesEditor`-ban (tényleges CRUD → Fázis 6)
- [x] ~~`ElementPermissionsEditor.jsx`~~ — placeholder tab (tényleges grid → Fázis 6)
- [x] ~~`CapabilitiesEditor.jsx`~~ — placeholder tab (tényleges szerkesztő → Fázis 6)
- [x] `compiler.js` — `compiledToGraph()` + `graphToCompiled()` + `extractGraphData()` kétirányú konverzió, auto-layout
- [x] `validator.js` — 7 szabályos pre-save validáció (1 initial, unique ID, regex, valid refs, no forward from terminal, unique pairs, empty allowedGroups)
- [x] `exportImport.js` — workflow JSON export/import logika (`maestro_workflow_export` sentinel, metadata diff)
- [x] `ImportDialog.jsx` — fájlfeltöltés, séma validáció, diff megjelenítés (structural + ACL/metadata), megerősítés dialog
- [x] Export gomb: aktuális canvas állapot exportja JSON fájlba
- [x] Import flow: JSON feltöltés → validator → diff megjelenítés → megerősítés → graph state felülírás → isDirty
- [x] Route refaktor: `DashboardLayout.jsx` shell + `<Outlet />`, `TableViewRoute` + `LayoutViewRoute` child route-ok, `/admin/office/:officeId/workflow` designer route
- [x] Jelenlegi view-switch (`table`/`layout`) a `/` alatti gyerek route-okká konvertálva (`ContentHeader` `<Link>` gombok)
- [x] CF `invite-to-organization` bővítés: `update_workflow` action (auth + optimistic concurrency + version bump)
- [x] Unsaved changes guard (`useBlocker` + `beforeunload`), Realtime awareness (remote version warning), state ID rename védelem
- [x] Harden pass: 8 javítás (6 MUST FIX + 2 SHOULD FIX), 5 noise elutasítva, 3 DESIGN QUESTION dokumentálva
- [x] **Verifikáció**: dashboard vite build 267 modul, 0 hiba. Fájlstruktúra, route-ok, canvas renderelés, DnD, szerkesztés, save/export/import flow, Realtime awareness kód-szinten kész.

#### Fázis 6 — Org/Office Admin UI finomítás

- [x] `OrganizationAdminRoute.jsx` — org név szerkesztés, meghívó flow (token link + vágólap), függő meghívók lista, tagok lista (névfeloldás groupMemberships-ből), szerkesztőségek lista (workflow designer link). CF `update_organization` action + email normalizálás. Admin gate (owner/admin only: szerkesztés, meghívó, pending invites). Harden pass: 6 javítás + simplify cleanup. *(2026-04-10)*
- [x] `EditorialOfficeAdminRoute.jsx` — office áttekintés (név, slug, szervezet), user×csoport toggle mátrix (GroupBadge), csoportösszesítés (tagszám, link GroupsRoute-ra), workflow designer link. Route: `/settings/editorial-office`. Harden pass: toggle race (globális badge tiltás), fetch generáció-számláló (scope-váltás race), targeted org-member query (1 doc), `hasWorkflow` boolean, targeted `reloadGroupMemberships()`, toggle scope guard. *(2026-04-10)*
- [x] Meghívó form bővítés: opcionális üzenet textarea (`inviteMessage` state + `AuthContext.createInvite` 4. param) — inline form enhancement, nem modal *(2026-04-10)*
- [x] Plugin WorkspaceHeader org+office választó dropdown: `Workspace.jsx` scope prop-ok (`useScope` + `useUser`), `WorkspaceHeader.jsx` feltételes `CustomDropdown` (org >1 / office >1), ScopeContext auto-pick cascading, disabled during properties view *(2026-04-10)*
- [x] `/settings/password` session hygiene: sikeres jelszócsere után `listSessions()` → „Más eszközök kijelentkeztetése (N aktív)" gomb → szelektív `deleteSession()` (Promise.allSettled + re-fetch) *(2026-04-10)*
- [x] `/settings/password` dirty form navigáció warning: `useBlocker` + `beforeunload` + blocker dialog (inline style), auth redirect exclusion *(2026-04-10)*
- [x] Harden pass: MUST FIX (scope switch disabled, Promise.allSettled partial failure), SHOULD FIX (beforeunload returnValue, blocker auth exclusion), simplify (redundáns useCallback), verification (session cleanup optimista false positive) *(2026-04-10)*
- [x] **Verifikáció**: Chrome MCP automatizált tesztelés (2026-04-10). OrganizationAdminRoute, EditorialOfficeAdminRoute, SettingsPasswordRoute, build verifikáció. Bugfixek: Dashboard ScopeContext auto-pick, `organizationInvites` ACL, user név fallback, `BrowserRouter` → `createBrowserRouter`

#### Fázis 7 — Cleanup

- [x] `grep` ellenőrzés: 0 találat a következőkre: `CAPABILITY_LABELS`, `STATE_PERMISSIONS`, `ARTICLE_ELEMENT_PERMISSIONS`, `LEADER_TEAMS`, `workflowConstants`, `elementPermissions`, `syncWorkflowConfig`, `labelConfig`, `workflowConfig` (js/jsx importok) *(Fázis 4-ben kész)*
- [x] `appwriteIds.js`: `TEAMS` enum törlése *(Fázis 2-ben kész)*
- [x] `appwriteIds.js`: `CONFIG` collection ID törlése *(Fázis 4-ben kész)*
- [x] Appwrite Console: régi 7 Appwrite Team + `get-team-members` CF törlése *(Fázis 2-ben MCP-vel kész)*
- [x] Appwrite Console: `config` collection manuális törlése *(korábban törölve, 2026-04-09 verifikálva MCP-vel)*
- [x] Appwrite Console: `validate-labels` CF disable/törlése *(korábban törölve, 2026-04-09 verifikálva MCP-vel; `appwrite.json` entry is törölve)*
- [x] `packages/maestro-indesign/CLAUDE.md` teljes frissítése a végső architektúrával, „Átalakítás folyamatban" banner törlése *(2026-04-10)*
- [x] `_docs/workflow-designer/PROGRESS.md` lezárás *(2026-04-10)*
- [x] `_docs/Feladatok.md` kész feladatok kipipálása *(2026-04-10)*

---

### Appwrite Cloud Function-ök — Szerver-oldali üzleti logika

> A kliens-oldali (InDesign plugin / Dashboard) kód jelenleg "becsületalapú" — a jogosultságokat, zárolást és adatintegritást csak a UI ellenőrzi. Közvetlen API hívással ezek megkerülhetők. Az alábbi Cloud Function-ök szerver-oldalon is kikényszerítik a szabályokat.

#### Kritikus — Biztonsági kockázat

- [x] **`validate-workflow-transition`** + **`validate-article-update`** → Összevonva: **`article-update-guard`** Cloud Function. A `config` collection `workflow_config` dokumentumából olvassa a konstansokat (STATE_PERMISSIONS, VALID_TRANSITIONS, TEAM_ARTICLE_FIELD, CAPABILITY_LABELS). A `previousState` mező az articles collection-ben biztosítja az előző állapot ismeretét. `modifiedByClientId = 'server-guard'` sentinel védi a végtelen ciklus ellen.

- [x] **`validate-article-creation`** — Cikk létrehozás szerver-oldali validáció. publicationId ellenőrzés (404 → törlés), state validáció, contributor user létezés ellenőrzés, filePath formátum.

#### Fontos — Adatintegritás

- [x] **`validate-article-update`** — Összevonva az `article-update-guard`-dal (ld. fent).

- [x] **`validate-publication-update`** — Kiadvány módosítás szerver-oldali validáció. Default contributor ID-k ellenőrzése, rootPath kanonikus formátum figyelése.

- [x] **`cascade-delete` bővítés** — MÁR KÉSZ: A `cascade-delete/src/main.js` `deleteThumbnails()` függvénye (94-129. sor) már törli a Storage fájlokat. A publication ág az article törlés re-triggerelésén keresztül kezeli.

#### Alacsony prioritás — Karbantartás

- [x] **`cleanup-orphaned-locks`** — Árva zárolások időszakos takarítása. Schedule: naponta 3:00 UTC. 24h-nál régebbi vagy nem létező owner-ű lockokat feloldja.

- [x] **`migrate-legacy-paths`** — Régi formátumú útvonalak egyszeri batch migrációja. DRY_RUN=true alapértelmezett. Path konverziós logika portolva pathUtils.js-ből.

- [x] **`cleanup-orphaned-thumbnails`** — Árva thumbnail fájlok időszakos takarítása. Schedule: hetente vasárnap 4:00 UTC. Storage ↔ DB összehasonlítás, orphaned fájlok törlése.
- [x] Előfizettem az Appwrite-ra de lett egy új szervezetem. Ebbe az új szervezetbe kellene áthelyezni MCP-vel a másikból a maestro projektet. Állítólag át lehet helyezni, de vigyázni kell mert van egy bug, hogy ha a régi szervezetből kitörlődik a projekt, akkor az újból is eltűnik. Nem tudom, hogy ez van e már javítva. Ha ez megvan, akkor a label-ek elgépelésének megelőzésére tervezett funkció is implementálható.
- [x] Appwrite SDK frissítés 21.5.0 → 24.1.1 (major breaking change). InDesign plugin: appwrite 21.5.0→24.1.1, Dashboard: 16.0.2→24.1.1, Proxy: node-appwrite 22.1.2→23.1.0. Kritikus: realtimeClient.js activeChannels→activeSubscriptions migráció. Összes API hívás object params stílusra átírva.
- [x] A @Maestro Web Dashboard/src/components/LayoutView.jsx-ben a nagyítás százalékos kijelzésének úgy kellene számítódni, hogy az eredeti kép pixelszáma és a megjelenítés pixelszáma közti százalékos arány legyen. Jelenleg azt veszi 100%-nak, ha az adott képernyőméreten a megadott oldalpár-oszlopszám kifér a képernyőre. A kiegészítő információknak is ezen a méreten kellene alap méreten látszódniuk ami 24pt-os lenne.
- [x] A webes felületen olyan, mintha a validátorok eredményeit saját magának generálja a weboldal, pedig az adatbázisból kellene kiolvasnia az egyes cikkekhez tartozó validátor eredményeket.
- [x] Ha be vagyok jelentkezve a webes felületre de a pluginból is szeretnék a @Maestro InDesign Plugin/src/ui/features/workspace/WorkspaceHeader.jsx#98-109 gombbal bejelentkezni, akkor a weben felugrik a bejelentkezés ablak, de nem enged belépni akkor sem, ha helyes bejelentkezési adatokat adok is meg. Valószínűleg az a baj, hogy már van egy aktív session. Lehet az, hogy ezt is vizsgáljuk?
- [x] Teljes kiadvány archiválása a @Maestro InDesign Plugin/src/core/commands/handlers/archiving.js commanddal, PDF írással amennyiben az összes cikk eljutott az archív state-re. Azt is figyelni kell, hogy a kiadvány összes oldala le legyen fedve, nyilván addig nem tudunk archiválni, amíg nincs meg az összes cikk. Ehhez egy UI-ba illeszkedő gombot kell elhelyezni. Szerintem a @Maestro InDesign Plugin/src/ui/features/workspace/WorkspaceHeader.jsx lenne a megfelelő, de csak akkor jelenjen meg ha az előbbi feltételek teljesülnek.
- [x] Csak a tervezőszerkesztők és a művészeti vezetők tudjanak PDF-et írni a commandsávban lévő gomb segítségével
- [x] Ha egy publikáció törlésre kerül, akkor az adatbázisban nem törlődnek a hozzá kapcsolódó, deadline, layout bejegyzések. — Refaktorálva: `cascade-delete` Cloud Function (`maestro-server/functions/cascade-delete/src/main.js`) mind az article mind a publication deletion eventekre
- [x] WorkspaceHeader szűrők menüpont elrejtése properties panel nézetben (`isPropertiesView` prop + feltételes renderelés)
- [x] MAESTRO lock felirat villanás javítása: optimistic update a `DocumentMonitor.verifyDocumentInBackground()`-ban — a SYSTEM lock azonnal megjelenik a helyi state-ben a DB hívás előtt
- [x] Thumbnail validáció: hiányzó és elavult oldalkép figyelmeztetés (`DatabaseIntegrityValidator.checkThumbnailStaleness()`, `documentClosed` + `documentSaved` triggerek, `VALIDATION_SOURCES.THUMBNAIL`)
- [x] Placeholder cikkek a webes felületen is. A kimarad checkboxnak a többi state checkbox mellé kell kerülnie, a helykitöltők mutatásának a saját cikkeim checkbox mellé kell kerülni úgy, ahogy a @Maestro InDesign Plugin/src/ui/features/workspace/FilterBar.jsx-ben van.
- [x] A @Maestro Web Dashboard/index.html-en kellene a fejlécbe egy layout választó dropdown és az abban kiválasztott layutot kirajzolni úgy, hogy ha az adott layouthoz nem tartozik oldal akkor az alap layout oldalát rajzolja, ha tartozik hozzá oldal, akkor pedig értelemszerűen azt.
- [x] A @Maestro Web Dashboard/index.html-en meg kellene oldani, hogy a UI-elemeket ne lehessen nagyítani, kicsinyíteni, természetesen az elrendezés nézetben az oldalakat igen.
- [x] Weben az elrendezés nézetben a zoom sávja együtt mozog az oldalakkal ha scrollozunk.
