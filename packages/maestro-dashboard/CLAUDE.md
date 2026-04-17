# CLAUDE.md — Maestro Web Dashboard

> A plugin-oldali részletes architektúrát ld. `../maestro-indesign/CLAUDE.md` és `../maestro-indesign/docs/`.

---

## Parancsok

- **Dev szerver**: `npm run dev` — Vite dev szerver HMR-rel
- **Build**: `npm run build` — Production build → `dist/`
- **Preview**: `npm run preview` — Build-elt verzió lokális előnézete
- **Deploy**: `./deploy.sh` — Build + SCP feltöltés `maestro.emago.hu`-ra

---

## Technológiai Stack

| Réteg         | Technológia                                     |
| ------------- | ----------------------------------------------- |
| **UI**        | React 18                                        |
| **Backend**   | Appwrite Cloud (közvetlen, proxy nélkül)        |
| **Realtime**  | Appwrite Web SDK `client.subscribe()` (natív WS)|
| **Bundler**   | Vite                                            |
| **Stílusok**  | CSS (globális, `css/styles.css`)                |
| **Shared**    | `@shared` alias → `../maestro-shared`           |

### Különbségek a plugin-hez képest

| Szempont        | Plugin (InDesign)                      | Dashboard (Web)                                   |
| --------------- | -------------------------------------- | ------------------------------------------------- |
| **Környezet**   | Adobe UXP                              | Böngésző                                          |
| **Auth**        | localStorage cookieFallback + proxy    | Natív böngésző cookie-k                           |
| **Realtime**    | Proxy auth bridge (WS)                 | Közvetlen Appwrite WS                             |
| **Endpoint**    | Dual-proxy failover                    | `cloud.appwrite.io/v1` (közvetlen)                |
| **Adatkezelés** | Read-write (cikk CRUD, workflow, lock) | Read-write (kiadvány/layout/határidő CRUD, workflow designer) |
| **Bundler**     | Webpack 5                              | Vite                                              |

> **Megjegyzés**: Fázis 4 (2026-04-10) óta a Dashboard **teljes kiadványkezelési CRUD-ot** nyújt (Publications, Layouts, Deadlines, Contributors, Workflow Designer). A Plugin Fázis 5-ben kerül kiadvány-szintű read-only módba — onnantól csak az `isActivated=true` kiadványokat látja, a kiadvány beállítások kizárólag a Dashboard-on szerkeszthetők.

---

## Kódstílus & Konvenciók

A plugin `CLAUDE.md`-ben leírt konvenciók érvényesek itt is:
- **Komment nyelv**: Magyar
- **Import sorrend**: vendor → context/hooks → config/constants → utils → components
- **Boolean elnevezés**: `is`, `has`, `can`, `should` prefixek
- **Logger**: A dashboardon `console.*` elfogadott (nincs UXP logger)

---

## Architektúra

### Context Hierarchia

```
RootLayout (createBrowserRouter)
└── AuthProvider                  ← user, login, logout, session check, memberships
    └── ScopeProvider             ← activeOrganizationId, activeEditorialOfficeId (localStorage)
        ├── Public auth routes    (login, register, verify, forgot/reset, invite, onboarding)
        └── ProtectedRoute
            ├── Settings routes   (password, groups, organization, editorial-office)
            ├── DashboardLayoutWithProviders
            │   └── ToastProvider
            │       └── DataProvider   ← publications, articles, layouts, deadlines, workflow(s), Realtime + write-through
            │           └── ModalProvider  ← openModal/closeModal stack
            │               └── DashboardLayout
            │                   ├── TableViewRoute (/)
            │                   └── LayoutViewRoute (/layout)
            └── WorkflowDesignerWithProviders
                └── ToastProvider
                    └── DataProvider
                        └── WorkflowDesignerPage (/admin/office/:officeId/workflow)
```

A routing `react-router-dom` `createBrowserRouter`-en (data router) alapul — a `useBlocker`
hookhoz szükséges (pl. `SettingsPasswordRoute`, `WorkflowDesignerPage` dirty-state guard).

### Villódzás-mentes Renderelés

A korábbi vanilla JS verzió `innerHTML` cserével renderelt → minden Realtime eseménynél az egész tábla/layout villogott. A React VDOM + célzott optimalizációk megoldják:

| Technika                   | Fájl                | Hatás                                            |
| -------------------------- | ------------------- | ------------------------------------------------ |
| `React.memo(ArticleRow)`  | `ArticleRow.jsx`    | Sor csak akkor renderel újra, ha adata változott |
| `React.memo(PageSlot)`    | `PageSlot.jsx`      | `<img>` nem töltődik újra, ha URL nem változik  |
| `useMemo` filteredArticles | `ArticleTable.jsx`  | Szűrés/rendezés csak ha articles/filters változik|
| `useMemo` validationIndex  | `ArticleTable.jsx`  | Validáció indexelés csak ha validations változik |
| `key={article.$id}`       | `ArticleTable.jsx`  | Stabil React kulcs → DOM node megmarad           |
| `key={pageNum}`            | `LayoutView.jsx`    | Stabil kulcs → thumbnail `<img>` megmarad        |
| CSS custom property zoom   | `LayoutView.jsx`    | Zoom re-render nélkül (`--page-width`)           |

### Adatfolyam

```
Appwrite REST (init)  ───→  DataContext state (useState)
                                  ↓
Appwrite Realtime WS  ───→  setArticles(prev => ...) updater
                                  ↓
                            React VDOM diff
                                  ↓
                          Csak a változott <tr> / <PageSlot> frissül
```

**Realtime handler jellemzők:**
- `$updatedAt` elavulás-védelem (stale WS üzenetek eldobása) — publications, articles, layouts, deadlines, validations ágakra egyaránt
- `activePublicationIdRef` — ref-ből olvasás a stabil subscription-höz
- Csak az aktív kiadvány eseményei kerülnek feldolgozásra
- Scope-szűrt: `payload.editorialOfficeId === activeEditorialOfficeIdRef.current` ellenőrzés minden nem-delete eseménynél

---

## Kiadványkezelés (Fázis 4)

A Dashboard Redesign Fázis 4 (2026-04-10) bevezette a teljes kiadvány CRUD-ot: létrehozás, beállítás-szerkesztés, layoutok, határidők és közreműködők kezelése. A plugin `PublicationProperties` komponensei Fázis 5-ig párhuzamosan működnek, onnantól a plugin kiadvány-szinten read-only lesz.

**Belépési pontok** (mindkettő a `BreadcrumbHeader`-ből):
- `CreatePublicationModal` — új kiadvány létrehozása (név, opcionális gyökérmappa, coverage, workflow), automatikusan létrehoz egy „A" layout-ot. Az új kiadvány `isActivated=false` — Fázis 5 aktiválja a pluginban. A `rootPath` opcionális (task 31): ha üres, a kulcs kimarad a payload-ból és az Appwrite attribútum default null; a natív útvonalat a Plugin állítja be később (task 34).
- `PublicationSettingsModal` — 4 fülés container (`Általános` / `Layoutok` / `Határidők` / `Közreműködők`) meglévő kiadvány szerkesztésére. A modal stale prop helyett a `publications[]` listából húzza a legfrissebb állapotot `publicationId` alapján.

**Validáció**:
- Mező-szintű validáció blur-on (`invalid-input` CSS osztály + `.form-error` szöveg).
- Határidő lista validáció a `@shared/deadlineValidator.js` `validateDeadlines()`-szel (átfedés, lefedettség, tartományok) — 300ms debounce, hiba/warning kártyák.
- Fájlnév és cross-platform útvonal validáció a plugin oldalon marad (`isValidFileName`, `pathUtils`).

**Cascading Delete**:
- `deleteLayout(id, reassignToId?)` — másodlagos `useConfirm` dialógus ajánlja fel a layout alá rendelt cikkek átrendelését. `reassignToId=null` esetén a cikkek `layoutId` mezője `null`-ra áll, amit `Promise.all` futtat párhuzamosan.
- Minimum 1 layout megkötés: utolsó layout törlése toast-tal tiltva.

**Contributors (dinamikus)**:
- `useContributorGroups(workflow, publication)` hook lekéri a `compiled.contributorGroups`-ből származó csoportokat és a hozzájuk tartozó felhasználókat (5 perces cache, scope-szűrt).
- A `publication.defaultContributors` JSON mező dropdown-onként szerkeszthető, mentés `updatePublication`-nel.
- Smart update: ha vannak cikkek, ahol a kérdéses contributor slug `null`, a hook felajánlja a batch update-et (`useConfirm` → cikk frissítés).

**Workflow snapshot aktiváláskor (#36–#39)**:
- A `publications.compiledWorkflowSnapshot` string mező (JSON) a publikáció aktiválásakor rögzíti a workflow `compiled` pillanatképét. A schema-t a `bootstrap_publication_schema` CF action hozza létre (server, `invite-to-organization` CF, owner-only, idempotens).
- Írás: a `validate-publication-update` CF §5a kizárólag aktiválási payload-on (`payload.isActivated` érintett) vagy snapshot-hiányos aktív publikáción backfill-ként. Normál szerkesztés (név, coverage) NEM írja újra a snapshot-ot — a workflow Dashboard-oldali módosításai nem szivárognak át futó publikációra.
- Immutability: §6b guard — ha a payload közvetlenül érinti a `compiledWorkflowSnapshot` mezőt SERVER_GUARD nélkül, a CF deaktiválja a publikációt és null-ra billenti a mezőt, kényszerítve az új aktiválást (újabb §5a snapshot írást).
- **WorkflowDesignerPage guard banner (#39)**: a `useData()`-ból olvasott `publications[]` alapján `snapshotUsageCount` memo számolja az `isActivated=true` + `workflowId === workflowDocId` + nem-üres `compiledWorkflowSnapshot` mezőjű publikációkat. Ha > 0, egy narancs informatív banner (`.workflow-designer-snapshot-info`) jelenik meg a `remoteVersionWarning` alatt — nem blokkol mentést, csak tájékoztat: a változás csak új aktiválásoknál érvényesül. Legacy (snapshot nélküli) aktív publikációk nem számítanak bele (azok a `workflowId` cache-re fallback-elnek a Pluginban).

---

## Projektstruktúra

```
maestro-dashboard/
├── CLAUDE.md                     ← Ez a fájl
├── index.html                    ← Vite entry point (<div id="root">)
├── package.json                  ← React, Vite, react-router-dom, Appwrite deps
├── vite.config.js                ← @shared alias konfig
├── deploy.sh                     ← Build + SCP deploy (maestro.emago.hu)
│
├── css/
│   └── styles.css                ← Globális stílusok (dark theme, responsive, modal/tabs/forms)
│
├── src/
│   ├── main.jsx                  ← ReactDOM.createRoot + RouterProvider
│   ├── App.jsx                   ← createBrowserRouter + provider kompozíció
│   ├── config.js                 ← Re-exportok @shared-ból + dashboard konstansok
│   │
│   ├── contexts/
│   │   ├── AuthContext.jsx       ← user, login(), logout(), register(), memberships
│   │   ├── ScopeContext.jsx      ← activeOrganizationId/officeId (localStorage, auto-pick, stale guard)
│   │   ├── DataContext.jsx       ← publications/articles/layouts/deadlines/workflow(s) + Realtime + write-through
│   │   ├── ToastContext.jsx      ← showToast(message, type, duration)
│   │   └── ModalContext.jsx      ← openModal/closeModal stack, size + title prop
│   │
│   ├── hooks/
│   │   ├── useFilters.js         ← Szűrő állapot (localStorage perzisztált)
│   │   ├── useUrgency.js         ← Sürgősség batch-számítás (5 perces timer)
│   │   ├── useContributorGroups.js ← Contributor csoportok + tagok (5 perces cache, scope-szűrt)
│   │   └── usePopoverClose.js    ← Outside-click / Escape popover bezárás
│   │
│   ├── routes/                   ← React Router route komponensek
│   │   ├── ProtectedRoute.jsx    ← Auth gate (redirect /login, onboarding check)
│   │   ├── auth/                 ← Login, Register, Verify, Forgot/Reset, Onboarding, Invite
│   │   │   └── AuthSplitLayout.jsx ← Közös kétoszlopos auth layout
│   │   ├── settings/             ← Password, Groups, OrganizationAdmin, EditorialOfficeAdmin
│   │   └── dashboard/            ← DashboardLayout, TableViewRoute, LayoutViewRoute
│   │
│   ├── features/
│   │   └── workflowDesigner/     ← Workflow Designer full-screen page (dirty-state guard)
│   │
│   └── components/
│       ├── LoginView.jsx         ← (legacy – auth route-okra migrálva)
│       ├── BreadcrumbHeader.jsx  ← Scope/publication dropdown fejléc + onSettings
│       ├── BreadcrumbDropdown.jsx ← Reusable dropdown („Beállítások" + ABC rendezett elemek)
│       ├── Modal.jsx             ← Közös modal shell (size, title, ESC/overlay close)
│       ├── Tabs.jsx              ← Vízszintes tab váltó
│       ├── ConfirmDialog.jsx     ← useConfirm() Promise-alapú dialógus
│       ├── UserAvatar.jsx        ← Inicialé avatar
│       ├── ValidationIcons.jsx   ← Error/warning ikonok
│       ├── FilterBar.jsx         ← Státusz checkboxok, kimarad, saját cikkek
│       ├── ArticleTable.jsx      ← Tábla nézet (rendezés, urgency, validáció)
│       ├── ArticleRow.jsx        ← ★ React.memo egyetlen sor
│       ├── LayoutView.jsx        ← Flatplan nézet (zoom, spreadek)
│       ├── PageSlot.jsx          ← ★ React.memo egyetlen oldal-slot
│       ├── publications/         ← Fázis 4 kiadvány CRUD modal-ok
│       │   ├── CreatePublicationModal.jsx  ← Új kiadvány (név, rootPath opcionális, coverage, workflow, auto „A" layout)
│       │   ├── PublicationSettingsModal.jsx ← Kiadvány beállítások container (4 tab)
│       │   ├── GeneralTab.jsx              ← Név, coverage, rootPath (r/o), excludeWeekends, workflow
│       │   ├── LayoutsTab.jsx              ← Layout CRUD, auto-naming, cascading delete
│       │   ├── DeadlinesTab.jsx            ← Határidő CRUD, validáció (maestro-shared/deadlineValidator)
│       │   └── ContributorsTab.jsx         ← Default contributors per contributorGroup (smart update)
│       └── organization/         ← Szervezet / szerkesztőség beállítás modal-ok (#26, #27)
│           ├── OrganizationSettingsModal.jsx ← Container (Általános / Felhasználók tab), localStorage perzisztencia
│           ├── GeneralTab.jsx              ← Név szerkesztés, szerkesztőségek + „+ Új", DangerZone kaszkád számokkal
│           ├── UsersTab.jsx                ← Invite flow, függő meghívók, tagok szerepkör szerint csoportosítva
│           ├── CreateEditorialOfficeModal.jsx ← Új szerkesztőség (név + opcionális workflow klón org-szintről)
│           ├── EditorialOfficeSettingsModal.jsx ← Szerkesztőség beállítások shell (3 tab: Általános / Csoportok / Workflow)
│           ├── EditorialOfficeGeneralTab.jsx    ← (#28) név rename, „Új kiadvány", DangerZone
│           ├── EditorialOfficeGroupsTab.jsx     ← (#29) csoport CRUD + tag×csoport mátrix
│           └── EditorialOfficeWorkflowTab.jsx   ← (#30) workflow CRUD + visibility dropdown (2-way: organization/editorial_office)
│
├── shared -> ../maestro-shared   ← Symlink a közös csomagra
└── dist/                         ← Vite build output (gitignore-olt)
```

---

## Context API-k

### AuthContext
- `user` — aktuális felhasználó objektum (vagy `null`)
- `loading` — session ellenőrzés folyamatban
- `login(email, password)` / `logout()` / `register(name, email, password)`
- `organizations`, `editorialOffices`, `membershipsError`, `reloadMemberships()` — a user által elérhető scope-ok (`organizationMemberships` + `editorialOfficeMemberships` query). A `reloadMemberships()` `true`/`false`-t ad vissza (sikeres reload vs. hiba; hiba esetén a `membershipsError` state is beállítódik). CRUD-típusú hívók (új office, szervezet átnevezés/törlés) a bool alapján döntenek a scope váltás / success toast megjelenítéséről.

### ScopeContext
- `activeOrganizationId`, `activeEditorialOfficeId` — localStorage-ben perzisztált multi-tenant scope (kulcsok: `maestro.dashboard.activeOrganizationId` / `maestro.dashboard.activeEditorialOfficeId`).
- `setActiveOrganization(id)`, `setActiveOffice(id)` — írás + auto-pick első elérhetőre, stale ID védelem a memberships változására.

### DataContext
- **Adat tömbök**: `publications`, `articles`, `layouts`, `deadlines`, `validations`.
- **Workflow**: `workflows` (office összes workflow-ja), `workflow` (a kiválasztott kiadványhoz rendelt compiled JSON — derived `useMemo`, fail-closed stale `workflowId`-ra). Realtime hot-reload a `workflows` collection csatornán.
- **Aktív kiadvány**: `activePublicationId`, `switchPublication(id)` — párhuzamos fetch (articles + layouts + deadlines + validations).
- **Állapot**: `isLoading`, `storage` (Appwrite Storage — thumbnail URL-ek).
- **Helper**: `fetchPublications()`, `fetchWorkflow()`, `fetchAllGroupMembers()` (5 perces cache, scope-szűrt), `getMemberName(userId)`.
- **Write-through — Kiadványok**: `createPublication(data)`, `updatePublication(id, data)`, `deletePublication(id)`.
- **Write-through — Layoutok**: `createLayout(data)`, `updateLayout(id, data)`, `deleteLayout(id, reassignToId?)` — a cascading delete automatikusan átrendelheti az érintett cikkeket (`reassignToId=null` esetén `articleId.layoutId = null`).
- **Write-through — Határidők**: `createDeadline(data)`, `updateDeadline(id, data)`, `deleteDeadline(id)`.
- **Write-through — Cikkek**: `updateArticle(id, data)` (a cikk CRUD többi része a plugin-ban marad Fázis 4 után is).
- **Scope injection**: `withScope(data)` helper automatikusan hozzáadja az `organizationId + editorialOfficeId` mezőket minden create payload-hoz (refből olvasva — ha nincs aktív scope, a helper dob). Az `update*` metódusok NEM kapnak scope injection-t (a CF guard-ok scope immutability-t enforce-olnak).
- **$updatedAt elavulás-védelem**: Minden optimista update + Realtime handler összeveti a helyi `$updatedAt`-et a bejövő payload-dal — frissebb helyi adat nem felülíródik régebbi szerver válasszal.

### ModalContext
- `openModal(element, { size, title, onBeforeClose })` — stack-alapú, több modal egymásra nyitható (pl. CreatePublicationModal fölé ConfirmDialog).
- `closeModal()` — a legfelső modal zárása; `onBeforeClose` aszinkron guard-ot kaphat (pl. dirty state megerősítő).
- **Scope-váltás auto-close**: a teljes modal stack automatikusan bezáródik, ha az aktív szervezet vagy szerkesztőség ID megváltozik. A `CreateEditorialOfficeModal` sikeres `switchScopeOnSuccess` flow szándékosan erre támaszkodik — a parent `OrganizationSettingsModal` is eltűnik az új office-ra váltáskor.

### ToastContext
- `showToast(message, type, duration)` — toast értesítés (`success` / `error` / `warning` / `info`).

---

## Shared Csomag (`maestro-shared`)

A `@shared` Vite alias a `../maestro-shared` mappára mutat. Minden export ESM. Tartalom:

| Fájl                    | Export                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `appwriteIds.js`        | `APPWRITE_PROJECT_ID`, `DATABASE_ID`, `COLLECTIONS`, `BUCKETS`                       |
| `constants.js`          | `LOCK_TYPE`, `VALIDATION_TYPES`, `MARKERS`, `MOUNT_PREFIX`                           |
| `defaultWorkflow.json`  | 8 állapotos alapértelmezett compiled workflow (seeding + fallback)                  |
| `workflowRuntime.js`    | 16+ tiszta függvény: `getStateConfig`, `getAvailableTransitions`, `canUserMoveArticle`, `canEditElement`, `getInitialState`, … (mindig `compiled` paramétert kap) |
| `commandRegistry.js`    | Command ID → label mapping (Workflow Designer számára)                              |
| `contributorHelpers.js` | `parseContributors`, `getContributor`, `setContributor`, `isContributor`            |
| `groups.js`             | `DEFAULT_GROUPS` (7 alapértelmezett csoport), `resolveGroupSlugs()` helper          |
| `deadlineValidator.js`  | `isValidDate`, `isValidTime`, `isValidDatetime`, `buildDatetime`, `getDateFromDatetime`, `getTimeFromDatetime`, `validateDeadlines` — statikus helper + teljes lista validáció (plugin `DeadlineValidator` is delegálja) |
| `urgency.js`            | `fetchHolidays`, `calculateUrgencyRatio`, `getUrgencyBackground` (workflow paramétert kap) |
| `pageGapUtils.js`       | Placeholder sorok generálása lefedetlen oldalakhoz (workflow paramétert kap)        |
| `validatorRegistry.js`  | Validátor ID → human-readable név mapping (Workflow Designer számára)              |

---

## Deploy

**Cél szerver**: `emagohu@emago.hu:~/maestro.emago.hu`
**URL**: `https://maestro.emago.hu/`

A `deploy.sh` automatikusan:
1. `npm run build` (Vite production)
2. Törli a szerveren a régi fájlokat (`js/`, `css/`, `shared/`, `assets/`)
3. Feltölti a `dist/index.html` + `dist/assets/` mappát

A `shared/` többé nem kell külön — Vite bebundolja a build-be.
