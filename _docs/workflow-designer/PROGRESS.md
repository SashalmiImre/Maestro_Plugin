# Workflow Designer — Átalakítás állapota

> **Ez a fájl minden új Claude Code session első olvasnivalója.**
> Itt található az aktuális fázis, a checklist, a nyitott kérdések és a session jegyzetek.

---

## Gyors tájékozódás

- **Cél**: A Maestro hardkódolt, egybérlős workflow-ját teljesen dinamikus, multi-tenant rendszerré alakítani. ComfyUI-stílusú vizuális workflow designerrel a Dashboardon.
- **Teljes terv**: [ARCHITECTURE.md](ARCHITECTURE.md)
- **Adatmodell**: [DATA_MODEL.md](DATA_MODEL.md)
- **Compiled JSON séma**: [COMPILED_SCHEMA.md](COMPILED_SCHEMA.md)
- **Régi → új megfeleltetés**: [MIGRATION_NOTES.md](MIGRATION_NOTES.md)
- **UI tervek**: [UI_DESIGN.md](UI_DESIGN.md)
- **Feladatlista (magyar)**: [Feladatok.md](../Feladatok.md) → `## Aktív` szekció

---

## Aktuális fázis

**Fázis 5 — Workflow Designer UI** (következő)

### Fázis 4 checklist (kész, 2026-04-09)
- [x] D.1 — Új collection: `workflows` (editorialOfficeId, organizationId, compiled longtext, version int) — MCP
- [x] D.2 — Új shared modul: `maestro-shared/workflowRuntime.js` — 16+ tiszta fogyasztói függvény a `compiled` JSON fölött
- [x] D.3 — Új template: `maestro-shared/defaultWorkflow.json` — 8 állapotos magazin workflow `compiled` formátumban
- [x] D.4 — Régi modulok törlése: `workflowConfig.js`, `labelConfig.js`, `workflowConstants.js`, `elementPermissions.js`, `syncWorkflowConfig.js`, `validate-labels/`
- [x] D.5 — `workflowEngine.js` + `workflowPermissions.js` proxy átírás a `workflowRuntime.js`-re
- [x] D.6 — Plugin `DataContext`: `workflow` state + fetch (office scope) + Realtime hot-reload (`setWorkflow(JSON.parse(payload.compiled))`)
- [x] D.7 — CF-ek átírás: `workflows` collection olvasás, 60s TTL process cache (`getWorkflowForOffice()`), fail-closed
- [x] D.8 — Label rendszer teljes eltávolítás — `user.groupSlugs` az egyetlen jogosultsági forrás
- [x] D.9 — Plugin + Dashboard UI fogyasztók átírás (~20 fájl: `WORKFLOW_CONFIG` → `getStateConfig`/`getAllStates`/stb.)
- [x] D.10 — CLAUDE.md frissítés a dinamikus workflow modellre
- [x] D.11 — Build verifikáció: plugin (webpack) + dashboard (vite) sikeres, 0 stale import
- [x] D.12 — Appwrite Console: `WORKFLOWS_COLLECTION_ID` env var (3 CF), `config` collection + `validate-labels` CF + `Get Team Members` CF törlés, `CONFIG_COLLECTION_ID` env var cleanup
- [x] D.13 — `appwrite.json` cleanup: `validate-labels` + `Get Team Members` entry törlése

### Fázis 3 checklist (kész, 2026-04-09)
- [x] C.1 — Appwrite `articles.contributors` + `publications.defaultContributors` longtext mezők létrehozása (MCP)
- [x] C.2 — `maestro-shared/contributorHelpers.js` létrehozása (parseContributors, getContributor, setContributor, isContributor)
- [x] C.3 — `maestro-shared/workflowConfig.js`: `TEAM_ARTICLE_FIELD` törlése, `CONFIG_VERSION` bump `'1.0.0'` → `'2.0.0'`
- [x] C.4 — Plugin `useContributorGroups.js` hook (2 query, 5 perces cache, Realtime invalidálás)
- [x] C.5 — Plugin Article `ContributorsSection.jsx` újraírás (dinamikus loop, `getContributor`/`setContributor`)
- [x] C.6 — Plugin Publication `ContributorsSection.jsx` újraírás (dinamikus loop, confirm dialog JSON-alapú)
- [x] C.7 — Plugin `useArticles.js` `addArticle`: 7 mező → `contributors: pub?.defaultContributors ?? null`
- [x] C.8 — Plugin `Publication.jsx`: `isContributor()` + `userSlugs` useMemo
- [x] C.9 — Plugin `GeneralSection.jsx`: `getContributor()` a `hasRequiredContributor`-ban
- [x] C.10 — Plugin `useElementPermission.js`: `useContributorPermissions(state, groupSlugs)` paraméter
- [x] C.11 — Plugin `ArticleProperties.jsx`: `useContributorGroups` + `contributorGroupSlugs` átadás
- [x] C.12 — Plugin `workflowConstants.js` + `workflow/index.js`: `TEAM_ARTICLE_FIELD` re-export törlés, `buildWorkflowConfigDocument` frissítés
- [x] C.13 — Dashboard `config.js`: `TEAM_ARTICLE_FIELD` re-export törlés
- [x] C.14 — Dashboard `useFilters.js`: `isContributor()` + `getUserGroupSlugs()`
- [x] C.15 — CF `validate-article-creation`: JSON `contributors` validáció (parse → userId check → nullázás)
- [x] C.16 — CF `article-update-guard`: JSON `contributors` validáció (parse → log-only), `teamArticleField` törlés
- [x] C.17 — CF `validate-publication-update`: JSON `defaultContributors` validáció (parse → userId check → nullázás)
- [x] C.18 — Appwrite régi 14 contributor mező törlése (7 articles + 7 publications) (MCP)
- [x] C.19 — Dokumentáció frissítés (CLAUDE.md-k, PROGRESS.md, Feladatok.md)

### Fázis 2 checklist (kész, 2026-04-09)
- [x] B.1 — Appwrite `groups` + `groupMemberships` collection létrehozás (MCP)
- [x] B.2 — `maestro-shared` frissítések: `COLLECTIONS` bővítés, `groups.js` (DEFAULT_GROUPS, resolveGroupSlugs)
- [x] B.3 — CF `invite-to-organization` bootstrap group seeding (7 csoport + 7 membership)
- [x] B.4 — CF `add_group_member` / `remove_group_member` action-ök (office membership + aktív/verifikált check)
- [x] B.5 — Plugin `UserContext`: `enrichUserWithGroups()` + `refreshGroupSlugs()` (groupMemberships query)
- [x] B.6 — Plugin `DataContext` + `MaestroEvents`: groupMemberships Realtime + `groupMembershipChanged`/`scopeChanged` event
- [x] B.7 — Plugin `useGroupMembers` hook (scope-szűrt, cache, generation guard, Realtime invalidálás)
- [x] B.8 — Plugin `user.teamIds` → `user.groupSlugs` átnevezés minden fogyasztóban
- [x] B.9 — Dashboard `AuthContext`: `fetchGroupSlugs()` (groupMemberships query)
- [x] B.10 — Dashboard `DataContext`: `fetchAllGroupMembers()` (közvetlen query)
- [x] B.11 — Dashboard `useFilters`: `user.teamIds` → `user.groupSlugs`
- [x] B.12 — CF `article-update-guard`: `getUserGroupSlugs()` (groupMemberships → slug, null-return pattern)
- [x] B.13 — Dashboard `/settings/groups` admin UI
- [x] B.14 — Cleanup: régi fájlok törlése, TEAMS enum, get-team-members CF, 7 Appwrite Team törlés (MCP)
- [x] Harden pass: .rows/.documents fallback, generation guard, office scope szűrés, bootstrap rollback fix, target user check

### Fázis 1 checklist (kész)
- [x] B.1 — Appwrite collection setup (5 új + 6 meglévő scope mező)
- [x] B.2 — `appwriteIds.js` frissítés az 5 új COLLECTIONS konstanssal + `TEAMS` `@deprecated` JSDoc
- [x] B.3 — Dashboard `react-router-dom` + auth route skeleton (`ProtectedRoute`, `AuthSplitLayout`, `BrandHero`, 8 auth route, `ScopeContext`)
- [x] B.4 — Dashboard `AuthContext` bővítés + auth route-ok implementáció (register, verifyEmail, requestRecovery, confirmRecovery, updatePassword, fetchMemberships, reloadMemberships) — `acceptInvite` B.5-ig vár
- [x] B.5 — Új Cloud Function-ök: `invite-to-organization`, `organization-membership-guard` + Onboarding/Invite élesítés
- [x] B.6 — Plugin `appwriteConfig.js` `VERIFICATION_URL` + `RECOVERY_URL` átirányítás Dashboard domainre + proxy legacy endpoint-ok 302 redirect
- [x] B.7 — Plugin `UserContext` + `DataContext` scope bevezetés (`organizations`, `editorialOffices`, `activeOrganizationId`, `activeEditorialOfficeId`, scope-szűrt fetch)
- [x] B.8 — Meglévő CF-ek (`validate-article-creation`, `article-update-guard`, `validate-publication-update`) officeId scope kiterjesztés + `editorialOfficeMemberships` lookup
- [x] B.9 — Teszt adat wipe
- [x] B.11 — Dashboard `/settings/password` route (bejelentkezett jelszó módosítás)
- [x] B.10 — Manual happy path verifikáció (Chrome MCP-vel, 2026-04-09)

### Fázis 0 checklist
- [x] `_docs/workflow-designer/` mappa létrehozása PROGRESS/ARCHITECTURE/DATA_MODEL/COMPILED_SCHEMA/MIGRATION_NOTES/UI_DESIGN fájlokkal
- [x] `packages/maestro-indesign/docs/WORKFLOW_CONFIGURATION.md` és `WORKFLOW_PERMISSIONS.md` áthelyezése `_docs/archive/`-ba
- [x] `packages/maestro-indesign/CLAUDE.md` tetejére „Átalakítás folyamatban" banner
- [x] `_docs/Feladatok.md` `## Aktív` szekcióba a Fázis 0–7 teljes task lista
- [x] Stitch MCP képernyőtervek — mind a 4 megvan: [auth-flow.png](stitch-screens/auth-flow.png), [designer-canvas.png](stitch-screens/designer-canvas.png), [state-node.png](stitch-screens/state-node.png), [properties-sidebar.png](stitch-screens/properties-sidebar.png)
- [x] Stitch annotációk: [auth-flow.md](stitch-screens/auth-flow.md), [designer-canvas.md](stitch-screens/designer-canvas.md), [state-node.md](stitch-screens/state-node.md), [properties-sidebar.md](stitch-screens/properties-sidebar.md)

---

## Fázis térkép

| # | Fázis | Cél | Állapot |
|---|-------|-----|---------|
| 0 | Dokumentációs alap + Stitch tervek | Tudás-megőrzés, első UI képek | **Kész** |
| 1 | Scope bevezetés + teljes Dashboard auth flow | `organizationId` + `editorialOfficeId` mindenhol, saját tagság collectionök, login/regisztráció/elfelejtett jelszó | **Kész** |
| 2 | Dinamikus csoportok | A 7 fix Appwrite Team helyett saját `groups` + `groupMemberships` | **Kész** |
| 3 | Dinamikus contributor mezők | `articles.contributors: {slug: userId}` JSON a 7 hardkódolt oszlop helyett | **Kész** |
| 4 | Workflow runtime | `workflows` collection, `compiled` JSON, Realtime hot-reload, régi workflowConstants törlése | **Kész** |
| 5 | Workflow Designer UI | ComfyUI-szerű vizuális designer a Dashboardon, export/import | Vár |
| 6 | Org/Office Admin UI finomítás | Teljes org admin felület, user meghívás, csoport kezelés | Vár |
| 7 | Cleanup | Átmeneti kód törlése, dokumentáció lezárása | Vár |

---

## Kulcs megkötések

- **Nincs éles verzió**, a teszt adat eldobható → bátor törő változások.
- **0 alapértelmezett csoport** — minden csoportot az org admin hoz létre. A 7 fix Appwrite Team eltűnik.
- **Saját collection minden tagsághoz** (org, office, csoport). Az Appwrite Teams rendszert nem használjuk tagságra. Meghívó e-mail flow saját Cloud Function-nel.
- **Szerkesztőség-szintű workflow** — minden editorialOffice saját workflow-t kap, új office létrehozáskor a `defaultWorkflow.json` templateből másolódik (a mostani 8 állapotos magazin workflow).
- **String `stateId`** (pl. `"designing"`) váltja az integer state-et az `articles.state` mezőben.
- **react-router-dom** bevezetése a Dashboardra.
- **Plugin és CF hot-reloadol** a workflow változásra, Realtime subscription alapján.
- **Teljes auth flow a Dashboardon**: login, regisztráció, e-mail verifikáció callback, elfelejtett jelszó, jelszó reset callback, bejelentkezett jelszó módosítás. A plugin továbbra is használhatja a natív jelszó dialogokat, de a fő auth-UI a webes felületen él.
- **Workflow JSON export/import**: a designer toolbarból a `compiled` (+ `graph`) lementhető helyi fájlba, és visszaölthetőek (validátorral, diff megerősítéssel).

---

## Nyitott kérdések

_(egyelőre nincs)_

---

## Session jegyzetek

### 2026-04-06 — Fázis 0 indítása és (részleges) lezárása

- Terv elkészült és jóváhagyva (`~/.claude/plans/greedy-chasing-panda.md`).
- A felhasználó két bővítést kért:
  1. Workflow JSON export/import a designerben (Fázis 5).
  2. Teljes auth flow (login, regisztráció, elfelejtett jelszó) a Dashboardon (Fázis 1).
- Dokumentációs alap elkészült: [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), [COMPILED_SCHEMA.md](COMPILED_SCHEMA.md), [MIGRATION_NOTES.md](MIGRATION_NOTES.md), [UI_DESIGN.md](UI_DESIGN.md).
- Régi doc-ok archiválva: [../archive/WORKFLOW_CONFIGURATION.md](../archive/WORKFLOW_CONFIGURATION.md), [../archive/WORKFLOW_PERMISSIONS.md](../archive/WORKFLOW_PERMISSIONS.md). Index: [../archive/README.md](../archive/README.md).
- `packages/maestro-indesign/CLAUDE.md` kapott „Átalakítás folyamatban" banner-t a tetején, a PROGRESS.md-re mutatva.
- `_docs/Feladatok.md` `## Aktív` szekció feltöltve a Fázis 0–7 teljes magyar task listával.
- Stitch MCP — a meglévő „Maestro Dashboard — Modern Redesign" projektbe (`6473627341647079144`, Digital Curator design system) generáltam:
  - ✅ `auth-flow` (Maestro - Auth Split View) — sikerült, mentve
  - ⏱ `designer-canvas`, `state-node`, `properties-sidebar` — a szerver időtúllépéssel visszautasította, új sessionben újrafuttathatók. A promptok az [UI_DESIGN.md](UI_DESIGN.md)-ben vannak, ezeket a [stitch-screens/README.md](stitch-screens/README.md) hivatkozza.
- **Következő session feladata**: a hiányzó 3 Stitch kép újragenerálása (tipp: egyenként hívni a `generate_screen_from_text`-et, várni egyenként), utána belépés a Fázis 1-be.

### 2026-04-07 — Stitch retry kísérlet + Fázis 1 részletes terv

- **Cél**: Fázis 0 lezárása + Fázis 1 előkészítés (terv-szintű). Plan fájl: `~/.claude/plans/jolly-floating-minsky.md`.
- **Stitch retry — sikertelen**: A három hiányzó kép generálását egyenként, finomított (részletesebb, magyarul címkézett) promptokkal újra megpróbáltuk. Mindhárom `mcp__stitch__generate_screen_from_text` hívás újból timeout-ba futott, és a `list_screens` ellenőrzés szerint a Stitch projektben **nem jött létre új screen**. A háttérfeldolgozás sem sikerült. A finomított promptok mentve a tervfájlban (A.1 szekció), és a [stitch-screens/README.md](stitch-screens/README.md) is utal rájuk a következő retry-hoz. Tipp a következő próbához: csendesebb napszak, vagy egyenként, néhány perces szünettel.
- **Fázis 1 részletes terv elkészült** a tervfájl B. szekciójában — fájl- és sor-szintű hivatkozásokkal a Plugin (`UserContext`, `DataContext`, `appwriteConfig`), Dashboard (`AuthContext`, új route-ok, `react-router-dom`), maestro-shared (`appwriteIds`), és Cloud Function-ök (új: `invite-to-organization`, `organization-membership-guard`; bővítendő: `article-update-guard`, `validate-article-creation`, `validate-publication-update`) változásokra.
- **Eldöntött opciók (a felhasználóval)**:
  1. **Collection setup**: Fázis 1 elején az 5 új collectiont és a 6 meglévő collectionhoz a scope mezőket Appwrite MCP-vel hozzuk létre (`mcp__appwrite__tables_db_create_table`, `_create_*_column`).
  2. **Teszt adat**: Fázis 1 végén **teljes wipe** — a régi `publications`/`articles`/`layouts`/`deadlines`/`uservalidations`/`validations` rekordok törlése MCP-vel.
- **Fázis 0 állapota**: a 3 Stitch kép checklist sora **továbbra is pending** — Fázis 0 nem zár le, amíg ezek nincsenek meg. A többi Fázis 0 elem (dokumentáció, archive, banner, Feladatok lista, auth-flow Stitch) változatlanul kész.
- **Következő session feladata**: (1) újabb kísérlet a 3 hiányzó Stitch képre (használd a tervfájl A.1 promptjait), (2) ha legalább 1 sikerül, írd meg az annotáció `.md`-jét az [auth-flow.md](stitch-screens/auth-flow.md) mintájára, (3) Fázis 1 implementáció indítása a tervfájl B. szekciója szerint, a B.9 sorrendben.

### 2026-04-07 (folyt.) — Fázis 0 LEZÁRVA

- **Stitch aszinkron befejezés**: a 2026-04-07 reggeli retry kísérlet kliens oldalon mind a három `generate_screen_from_text` hívásnál timeout-ot adott, de a Stitch szerver háttérben végül **mind a hatot** legenerálta (mindegyik kategóriához 2 variánst). A `list_screens` ezt később felfedezte. Tanulság: a Stitch tool dokumentációja szerint timeout esetén is érdemes később `get_screen`-nel ellenőrizni — most ez igazolódott.
- **Generált screen ID-k** (Stitch projekt `6473627341647079144`):
  - `designer-canvas`: A=`6da19f54b6e848dfac49bec99f3e9088`, B=`05982df3413e4c04b52631ef2111e7ef` ✅ kiválasztva
  - `state-node`: A=`c45123d03e12456fb6f4856019c14f34` ✅ kiválasztva, B=`d663ea3f92be4fe39a49d7fde9095d1a`
  - `properties-sidebar`: A=`b1e43374ed0f4db0b24f984a66774ba0`, B=`cf75bd0271b54838b47f26248a3af3ac` ✅ kiválasztva
- **Variáns választás logikája**: minden kategóriában az a variáns nyert, amelyik a tervezett **strukturális elemeket** (három-oszlop, 2×2 grid, teljes mező lista) a legjobban lefedi.
- **Annotációk megírva**: [designer-canvas.md](stitch-screens/designer-canvas.md), [state-node.md](stitch-screens/state-node.md), [properties-sidebar.md](stitch-screens/properties-sidebar.md). A user kérése alapján csak a **strukturálisan szükséges** elemek vannak benne — a Fázis 5 React implementációhoz layout és komponens hierarchia, NEM 1:1 stílus fordítás.
- **Fázis 0 állapota**: TELJES. Minden checklist sor pipálva, az „Aktuális fázis" Fázis 1-re vált.
- **Következő session feladata**: Fázis 1 implementáció indítása a tervfájl ([`~/.claude/plans/jolly-floating-minsky.md`](../../../../.claude/plans/jolly-floating-minsky.md)) B. szekciója szerint, a B.9 sorrendben. Első lépés: az 5 új collection + 6 meglévő scope mező létrehozása Appwrite MCP-vel (B.1).

### 2026-04-07 — Fázis 1 / B.1 kész (Appwrite collection setup)

- **Plan fájl**: [`~/.claude/plans/curried-snuggling-harp.md`](../../../../.claude/plans/curried-snuggling-harp.md) — a Fázis 1 teljes terve (A. sorrend, B.1–B.10, C. fájl hivatkozások, D. újrahasznosítható helyek, E. doc karbantartás, F. most). A user jóváhagyta változtatás nélkül.
- **B.1 végrehajtva Appwrite MCP-vel** (~30 tool hívás, database `6880850e000da87a3d55`).
- **Új collectionök létrejöttek** (mind `available` állapotban):
  - `organizations` — 3 oszlop (name/slug/ownerUserId) + 2 index (slug unique, ownerUserId key)
  - `organizationMemberships` — 4 oszlop (organizationId/userId/role enum[owner,admin,member]/addedByUserId) + 2 index ((orgId,userId) unique, userId key)
  - `editorialOffices` — 4 oszlop (organizationId/name/slug/workflowId opt) + 2 index (organizationId key, (orgId,slug) unique)
  - `editorialOfficeMemberships` — 4 oszlop (editorialOfficeId/organizationId/userId/role enum[admin,member]) + 3 index ((officeId,userId) unique, userId key, organizationId key)
  - `organizationInvites` — 7 oszlop (organizationId/email/token/status enum[pending/accepted/expired/revoked] default pending/expiresAt datetime/invitedByUserId/role enum[admin,member] default member) + 3 index (token unique, organizationId key, email key)
- **Scope mezők hozzáadva** (mindkettő `string(36)`, opcionális — Fázis 2 elején required-re állítjuk a wipe után):
  - `publications` + `organizationId`, `editorialOfficeId`
  - `articles` + `organizationId`, `editorialOfficeId`
  - `layouts` + `organizationId`, `editorialOfficeId`
  - `deadlines` + `organizationId`, `editorialOfficeId`
  - `uservalidations` + `organizationId`, `editorialOfficeId`
  - `validations` + `organizationId`, `editorialOfficeId`
- **Permissions**: az új collectionök `create/read/update/delete("users")` — Fázis 6/7 alatt finomítjuk row-permissions-szel. A guard CF-ek adják a védelmet.
- **Verifikáció**: `tables_db_list_tables` hívással ellenőriztem, mind a 15 tábla jelen van, minden új oszlop `status: available`, minden index `status: available`.
- **Következő session feladata**: B.2 — `packages/maestro-shared/appwriteIds.js` frissítése az 5 új `COLLECTIONS` konstanssal (lines 15-23) és a `TEAMS` enum (29-37) elé „DEPRECATED: Fázis 4 végén törlendő" komment. Utána B.3: Dashboard `react-router-dom` telepítés + auth route skeleton.

### 2026-04-07 — Fázis 1 / B.2 + B.3 kész (appwriteIds + Dashboard router skeleton)

- **Plan fájl**: [`~/.claude/plans/purring-gliding-garden.md`](../../../../.claude/plans/purring-gliding-garden.md) — a B.2 + B.3 részletes terve. A user jóváhagyta változtatás nélkül.
- **B.2 (`appwriteIds.js`)**:
  - 5 új konstans a `COLLECTIONS` enumban: `ORGANIZATIONS`, `ORGANIZATION_MEMBERSHIPS`, `EDITORIAL_OFFICES`, `EDITORIAL_OFFICE_MEMBERSHIPS`, `ORGANIZATION_INVITES`.
  - `TEAMS` enum kapott `@deprecated` JSDoc-ot ("Fázis 4 végén törlendő — a dinamikus `groups` collection váltja"). Az enum maga **marad** Fázis 1-ben.
- **B.3 (Dashboard router skeleton)**:
  - `react-router-dom@7.14.0` telepítve a `packages/maestro-dashboard`-ba (`yarn add react-router-dom`).
  - Új mappák és fájlok:
    - `src/contexts/ScopeContext.jsx` — `activeOrganizationId`, `activeEditorialOfficeId`, localStorage perzisztált. A `DataContext`-be a B.7 fogja bekötni.
    - `src/routes/ProtectedRoute.jsx` — auth gate (`!user → /login` redirect, `loading → spinner`). Az `organizations.length === 0 → /onboarding` redirect B.4-ben jön.
    - `src/routes/auth/AuthSplitLayout.jsx` + `BrandHero.jsx` — `<Outlet>` wrapper bal hero + jobb glassmorphism kártyához.
    - `src/routes/auth/LoginRoute.jsx` — **aktív route**, a meglévő `LoginView.jsx` form-tartalmából kiemelve, `useNavigate` + `useLocation` `from` query support-tal.
    - `src/routes/auth/RegisterRoute.jsx`, `VerifyRoute.jsx`, `ForgotPasswordRoute.jsx`, `ResetPasswordRoute.jsx`, `OnboardingRoute.jsx`, `InviteRoute.jsx` — **placeholder route-ok**, mind a `login-card` style-lal és „Hamarosan elérhető (Fázis 1 / B.4)" üzenettel. A B.4 session implementálja őket.
    - `src/routes/dashboard/DashboardLayout.jsx` — egyszerű passzthrough wrapper a meglévő `DashboardView`-ra. Fázis 5/6-ban itt jön majd a multi-view shell.
  - `main.jsx` — `<BrowserRouter>` wrap (a meglévő wheel/keydown zoom-tiltó listenerek változatlanok).
  - `App.jsx` — a régi `if (!user) return <LoginView />` minta eltűnt, helyette `<Routes>` 5 publikus + 3 védett (onboarding, invite, dashboard) route-tal és `*` → `/login` fallback. Az `AuthProvider` és `ScopeProvider` legkülső szinten, a `DataProvider` + `ToastProvider` csak a védett `/` ágon (a publikus auth route-ok nem igényelnek adat-réteget).
  - A meglévő [packages/maestro-dashboard/src/components/LoginView.jsx](../../packages/maestro-dashboard/src/components/LoginView.jsx) **változatlan, nem hivatkozott** — Fázis 1 B.10 manual happy path után törölhető. Bejegyezve a [MIGRATION_NOTES.md](MIGRATION_NOTES.md) Fázis 1 szekciójába.
- **Build verifikáció**: `yarn build` lefut hiba nélkül (333 kB → 100 kB gzip, 506ms). 82 modul transformed. Az egy TypeScript hint (`React is declared but its value is never read` az `App.jsx`-ben) nem build-blokkoló — a projekt convention `import React from 'react'` minden komponensben.
- **Manual happy path** (csak deklaratív, futtatás nem volt — a Plugin/Dashboard dev szerverek a user oldalán futnak): a build sikerül, a Routes konfiguráció szintaktikailag helyes, a meglévő `LoginRoute` ugyanazokat a CSS class-okat használja, mint a régi `LoginView`, így vizuálisan nem kell változnia.
- **Következő session feladata**: B.4 — Dashboard `AuthContext` bővítés (`register`, `verifyEmail`, `requestRecovery`, `confirmRecovery`, `updatePassword`, `acceptInvite`, `fetchMemberships`) + a 6 placeholder route komponens tényleges implementációja a Stitch design alapján ([stitch-screens/auth-flow.md](stitch-screens/auth-flow.md)). A `ProtectedRoute` is kapja meg az `organizations.length === 0 → /onboarding` redirectet.

### 2026-04-07 — Fázis 1 / B.4 kész (Dashboard auth flow + AuthContext bővítés)

- **Plan fájl**: [`~/.claude/plans/glowing-sprouting-shannon.md`](../../../../.claude/plans/glowing-sprouting-shannon.md) — a B.4 részletes terve, F.1–F.11 sub-task bontásban. A user jóváhagyta változtatás nélkül.
- **F.1 — `config.js`**: új `DASHBOARD_URL` konstans (`import.meta.env.VITE_DASHBOARD_URL || window.location.origin`) az Appwrite verifikációs/recovery callback URL-ekhez.
- **F.2 — `AuthContext.jsx` bővítés**:
  - Új importok: `Databases`, `Query`, `ID` az `appwrite`-ból + `DATABASE_ID`, `COLLECTIONS`, `DASHBOARD_URL` a configból.
  - Új `databases` singleton instance ugyanazon `client`-en (a `DataContext` saját példánya nem ütközik, ugyanazt a session-t használják).
  - Új `fetchMemberships(userId)` helper: paralel betölti a saját `organizationMemberships` + `editorialOfficeMemberships` rekordokat, majd a hozzájuk tartozó `organizations` és `editorialOffices` scope rekordokat (`Query.equal('$id', orgIds)`).
  - Új state: `organizations`, `editorialOffices` a meglévő `user`/`loading` mellett.
  - `mount effect` és `login()` paralel hozza el a `teamIds`-t és a memberships-eket (`Promise.all([fetchTeamIds(), fetchMemberships(userData.$id)])`).
  - `logout()` üríti az új state-eket is.
  - 6 új metódus: `register(name, email, password)` (account.create → temp session → createVerification → deleteSession), `verifyEmail(userId, secret)`, `requestRecovery(email)`, `confirmRecovery(userId, secret, password)`, `updatePassword(oldPwd, newPwd)`, `reloadMemberships()` (a B.5-ös onboarding/invite acceptance után fogja meghívni).
- **F.3 — `ProtectedRoute.jsx`**: új `organizations.length === 0 → /onboarding` redirect a `<Outlet />` előtt, kivéve ha már a `/onboarding` vagy `/invite` route-on vagyunk. A `useAuth()` destructure-be felvettem az `organizations`-t.
- **F.4 — `LoginRoute.jsx` finomítás**: tab navigáció `<NavLink>`-ekkel (Bejelentkezés / Regisztráció), `?verified=1` és `?reset=1` success bannerek a form felett, „Elfelejtett jelszó?" link a jelszó input alatt. A `form-heading` helyett a tab-os fejléc a Stitch `auth-flow` design szerint.
- **F.5 — `RegisterRoute.jsx`**: teljes form (név, e-mail, jelszó, jelszó megerősítés), kliens-oldali validáció (min. 8 karakter, jelszó egyezés), `register()` hívás, success állapot („Ellenőrizd az e-mailedet" + e-mail cím + 1 órás érvényesség info). Hibakezelés: meglévő e-mail, érvénytelen e-mail, érvénytelen jelszó, általános hiba.
- **F.6 — `VerifyRoute.jsx`**: mount-kor azonnal `verifyEmail(userId, secret)` (StrictMode dupla mount védelem `ranRef`-el — az Appwrite secret egyszer használható). Állapotgép: `verifying` → `success` (1.5s múlva `Navigate('/login?verified=1')`) → `error` (lejárt link / általános). Hiányos query → error.
- **F.7 — `ForgotPasswordRoute.jsx`**: e-mail input → `requestRecovery()` → success állapot („Ha létezik fiók..."). Az Appwrite biztonsági okból nem jelez vissza, ha a user nem létezik — minden nem-hálózati hibát is success állapotba fordítunk (e-mail enumeráció védelem).
- **F.8 — `ResetPasswordRoute.jsx`**: új jelszó form + megerősítés, kliens-oldali validáció, `confirmRecovery()` → `Navigate('/login?reset=1')`. Hiányos query (userId/secret) → hibaüzenet + link az `/forgot-password`-re.
- **F.9 — `OnboardingRoute.jsx` placeholder finomítás**: a 4-collection write logikát a B.5 kapja meg a guard CF-fel együtt. B.4-ben placeholder + „Kijelentkezés" gomb (különben a user beragad a `ProtectedRoute` redirect miatt). Az üdvözlés a `user.name`-et használja.
- **F.10 — `InviteRoute.jsx` placeholder finomítás**: token mentés `localStorage.maestro.pendingInviteToken`-be → bejelentkezett user `/onboarding`-ra, anonymous user `/register`-re redirect. A B.5-ös `acceptInvite()` ezt a tárolt tokent fogja olvasni. A route szándékosan publikus marad.
- **F.11 — CSS bővítés** (`packages/maestro-dashboard/css/styles.css`): új class-ok a `@keyframes loginFadeIn` után — `.auth-tabs`, `.auth-tab` (+ `.active`), `.auth-link`, `.form-row-end`, `.auth-help`, `.auth-info`, `.auth-success` (success banner), `.auth-success-large` (centrált h2 + p panel), `.auth-bottom-link`. A success színhez `var(--c-success, #4ade80)` fallback.
- **Build verifikáció**: `cd packages/maestro-dashboard && yarn build` lefut hiba nélkül (487ms, 82 modul, 344.95 kB JS / 103.76 kB gzip, 20.59 kB CSS / 4.83 kB gzip).
- **Megkötések (B.5-be tolva)**:
  - `acceptInvite()` valódi flow — a `organization-membership-guard` Cloud Function nélkül a kliens nem tudja létrehozni az `organizationMemberships` rekordot.
  - `OnboardingRoute` 4-collection write logikája (organizations + organizationMemberships + editorialOffices + editorialOfficeMemberships).
- **Manual happy path** (csak deklaratív, futtatás nem volt — a Plugin/Dashboard dev szerverek a user oldalán futnak): (1) build sikerül, (2) a tab navigációval váltható login/register, (3) a regisztráció után a verifikációs e-mail az Appwrite-on keresztül indul (a callback URL a `DASHBOARD_URL/verify`), (4) a `verified=1` és `reset=1` success bannerek a login formon, (5) a `ProtectedRoute` membership nélkül `/onboarding`-ra dob, ahonnan a kijelentkezés gomb visszaenged.
- **Következő session feladata**: B.5 — Új Cloud Function-ök (`invite-to-organization`, `organization-membership-guard`) létrehozása, telepítése és integrálása. Az `OnboardingRoute` 4-collection write és az `InviteRoute` `acceptInvite()` flow ezek után élesedik.

### 2026-04-07 (folyt.) — Fázis 1 / B.4 adversarial review fix-ek

- **Trigger**: a B.4 lezárása után `/codex:adversarial-review` futtatás háttérben — a Codex 3 problémát jelzett (verdict: needs-attention). A user instrukciója: „Ellenőrizd kérlek, javítsuk amit kell".
- **Fix #1 — `membershipsError` állapot szétválasztás (high)**:
  - **Probléma**: a `fetchMemberships()` `try { ... } catch` blokkban nyelte le az összes hibát (pl. átmeneti 5xx, hálózati timeout) és üres `organizations` tömböt adott vissza. A `ProtectedRoute` ezt valódi „nincs még szervezetem" állapotnak hitte, és a meglévő tenant felhasználót `/onboarding`-ra dobta — a placeholder onboarding képernyő pedig (B.5-ig) nem ad lehetőséget visszamenni.
  - **Megoldás**: [AuthContext.jsx](packages/maestro-dashboard/src/contexts/AuthContext.jsx) — `fetchMemberships()` már NEM nyel le hibát. Új `loadAndSetMemberships(userId)` `useCallback` helper kezeli a state-et és a `membershipsError` flag-et. Új state: `membershipsError` (`null` vagy `Error`). Mount és `login()` `Promise.all`-lal párhuzamosan futtatja a `fetchTeamIds()`-t és a `loadAndSetMemberships()`-et — a memberships hibája nem akadályozza meg a `setUser()`-t (a user érvényes, csak a tagság-lookup hibázott). `logout()` üríti a `membershipsError`-t.
  - [ProtectedRoute.jsx](packages/maestro-dashboard/src/routes/ProtectedRoute.jsx) — új ág a `!user` check után, a `organizations.length === 0` check ELŐTT: ha `membershipsError` van, retry képernyő jelenik meg „Újra" gombbal (`reloadMemberships()`) és „Kijelentkezés" gombbal. Az átmeneti hiba így nem zárja ki a meglévő tenantot.
- **Fix #2 — `register()` partícionált rollback (high)**:
  - **Probléma**: a `register()` egyetlen `try` blokkban hívta `account.create` → `createEmailPasswordSession` → `createVerification` → `deleteSession`. Ha a verifikációs e-mail küldés (3. lépés) elszállt — pl. SMTP outage, rate limit —, a fiók már létrejött, de a user a következő register próbálkozáskor „account already exists" hibát kapott, miközben sosem aktiválta a fiókját. Zsákutca, csak admin segítséggel oldható.
  - **Megoldás**: [AuthContext.jsx:252-279](packages/maestro-dashboard/src/contexts/AuthContext.jsx#L252-L279) — a `register()` partícionált try/catch-ekkel működik. A `account.create` saját awaitja után új try-blokk a session+verification lépésre, `sessionCreated` flag-gel. Ha bármi elszáll a fiók létrehozása UTÁN, az ideiglenes session-t megpróbáljuk lezárni, és egy `verification_send_failed` kódú wrapped `Error`-t dobunk (`{code, cause, message}`).
  - Új [`resendVerification(email, password)`](packages/maestro-dashboard/src/contexts/AuthContext.jsx#L290-L301) `useCallback` — ideiglenes session + `createVerification` + session zárás `finally`-ben. A B.4 értékobjektumba felvettem.
  - [RegisterRoute.jsx](packages/maestro-dashboard/src/routes/auth/RegisterRoute.jsx) — `isSuccess` boolean helyett `phase` state (`'idle'` | `'success'` | `'verification_failed'`). A `handleSubmit` catch ágában `err?.code === 'verification_send_failed'` → `setPhase('verification_failed')`. Új `verification_failed` UI: „Fiók létrehozva" + e-mail cím + „Verifikációs e-mail újraküldése" gomb (`handleResendVerification`) + `resendNotice` lokális hibakezelés (rate limit, network, általános). Sikeres újraküldés → `phase = 'success'`, ugyanaz a képernyő, mint a happy pathon.
- **Fix #3 — `ForgotPasswordRoute` hiba-szűrés szűkítés (medium)**:
  - **Probléma**: az F.7 implementáció **minden** nem-hálózati hibát success-be konvertált (anti-enumeration miatt). Ez egy csendes outage-et tudott elrejteni: rate limit, érvénytelen callback URL, 5xx, általános Appwrite hiba — a user mind „Ellenőrizd az e-mailedet" üzenetet kapott, miközben az e-mail soha nem érkezett meg. Ops/support sem észlelt semmit.
  - **Megoldás**: [ForgotPasswordRoute.jsx:34-56](packages/maestro-dashboard/src/routes/auth/ForgotPasswordRoute.jsx#L34-L56) — csak `type === 'user_not_found'` maszkolódik success-ként (anti-enumeration védelem megtartva). A többi: `general_rate_limit_exceeded` / 429 → „Túl sok kérés", `general_argument_invalid` → „Érvénytelen e-mail", network → „Hálózati hiba", egyéb → `console.warn` (ops észleli) + „A kérést nem sikerült feldolgozni. Próbáld újra később." (user retry-olhat).
- **Új CSS class**: [.auth-link-button](packages/maestro-dashboard/css/styles.css) — a `ProtectedRoute` retry képernyő „Kijelentkezés" gombjához (button styled as auth-link).
- **Build verifikáció**: `cd packages/maestro-dashboard && yarn build` lefut hiba nélkül (530ms, 348.52 kB JS / 104.71 kB gzip, 20.68 kB CSS / 4.85 kB gzip).
- **A három fix közös tulajdonsága**: egyik sem rendszer-szintű átírás. Mindegyik a meglévő struktúra finomítása plusz egy explicit state vagy ág. A teljes B.4 architektúra (auth flow + memberships fetch + scope context) változatlan maradt.

### 2026-04-07 (folyt.) — Fázis 1 / B.4 lokális code review follow-up

- **Trigger**: a `/review` slash command a `gh` hiánya miatt nem futott (PR még nem létezik). Helyette lokális diff-alapú review a `feature/maestro-redesign` branchen lévő uncommitted B.4 + adversarial fix kódra. 5 megtalált pont fixelve, 2 jövőbeli (B.5/B.7) follow-up-ként rögzítve.
- **#1 — `ProtectedRoute` `/invite` dead code (közepes)**: a `isOnboardingArea` változó az `/invite` pathname-et is mentesítette az onboarding redirect alól, de az [App.jsx:52-66](packages/maestro-dashboard/src/App.jsx#L52-L66) szerint a `/invite` route a publikus `AuthSplitLayout` ágban van — sosem éri el a `ProtectedRoute` guardot. A változó és a kivétel egyik fele dead code volt. **Fix**: töröltem az `isOnboardingArea` változót, helyette egy egyszerű `location.pathname !== '/onboarding'` ellenőrzés. A fájl-fejléc komment is frissítve, hogy a `/invite` publikus mivoltát tükrözze.
- **#3 — `register()` temp session zárás csendes failure (kicsi)**: a 4. lépés (`account.deleteSession`) `try { ... } catch { /* nem baj */ }` blokkban futott. Ha elszáll, a user élő temp session-nel marad, miközben a `register()` sikerként tér vissza. Nem destruktív, de ops-figyelemre érdemes. **Fix**: `console.warn('[AuthContext] register temp session zárás sikertelen:', err?.message)` a catch-ben. A logikát nem változtattam — a register továbbra is sikerként térít vissza.
- **#4 — `VerifyRoute` setTimeout cleanup hiányzott (kicsi)**: a sikeres verifikáció után 1.5s-mal `setTimeout(() => navigate(...))` futott le, cleanup nélkül. Ha a felhasználó a 1.5s alatt elnavigál, az árva timer mégis tüzelt. **Fix**: új `redirectTimerRef` `useRef`, közös `cleanup` lambda, és minden korai `return` ágon (`ranRef.current` rövidzárlat, hiányos query) is visszaadom a cleanup-ot. A timer ID-t a callback futása után `null`-ra állítom, hogy a cleanup ne próbálja törölni a már lefutott timer-t.
- **#6 — `RegisterRoute` password state minimalizálás (kozmetikai)**: a `handleSubmit` catch ágában normál hiba esetén (pl. „user with the same email") a `password` és `passwordConfirm` state-ek tovább éltek a memóriában. **Fix**: a `verification_send_failed` early return UTÁN, de a hibaüzenet beállítása ELŐTT `setPassword('')` + `setPasswordConfirm('')`. A `verification_failed` ágon szándékosan megőrződik (a `resendVerification` használja).
- **#7 — `:focus-visible` accessibility (kozmetikai)**: a `.auth-tab`, `.auth-link`, `.auth-link-button` és `.auth-bottom-link a` elemek nem mutattak látható fókusz keretet billentyűzet-navigációkor. **Fix**: mindegyikre `outline: 2px solid var(--accent-solid); outline-offset: 2px (vagy 4px tabnál); border-radius: 2px;` a `:focus-visible` állapotra. A `:hover`-rel együtt biztosítja, hogy mind egér, mind keyboard userek lássák, hol vannak.
- **Build verifikáció**: 489ms, hibamentes, 348.69 kB JS / 104.75 kB gzip, 21.09 kB CSS / 4.89 kB gzip (a CSS +0.41 kB a `:focus-visible` szabályok miatt, JS +0.17 kB a kibővített kommentek + RegisterRoute setPassword hívások miatt).
- **B.5/B.7 follow-up** (NEM ebben a sessionben):
  - `InviteRoute` bejelentkezett user esetén jelenleg a placeholder onboarding-ra dob — B.5-ben az `OnboardingRoute` fel kell ismerje a tárolt `maestro.pendingInviteToken` localStorage kulcsot és felajánlja az invite elfogadását.
  - `fetchMemberships` `Query.limit(100)` cap — B.7-ben cursor-paging vagy explicit warning, ha a `total > documents.length`. Most még nem releváns (test wipe lesz a B.9-ben).

### 2026-04-07 (folyt.) — Fázis 1 / B.5 kész (új CF-ek + Onboarding/Invite élesítés)

- **Plan fájl**: [`~/.claude/plans/memoized-tumbling-thimble.md`](../../../../.claude/plans/memoized-tumbling-thimble.md) — F.0–F.8 sub-task bontás. A user jóváhagyta változtatás nélkül.
- **Eldöntött opciók (a felhasználóval, AskUserQuestion-nel)**:
  1. **E-mail küldés**: Halasztva Fázis 6-ra — a `messaging.*` SDK egyáltalán nem kerül be a CF-be. A B.10-es tesztelés Appwrite Console manuális invite generálással történik.
  2. **Accept flow**: Egyetlen bővített `invite-to-organization` CF, két `action`-nel (`create` admin oldal, `accept` invitee oldal). A guard egyszerű marad.
  3. **`workflowId`**: `null` marad Fázis 4-ig (a `workflows` collection és `defaultWorkflow.json` template Fázis 4 hatókör).
- **F.0 — `organizationMemberships` schema bővítés Appwrite MCP-vel**: új `modifiedByClientId` string oszlop (size 36, opcionális). Státusz: `available`. Ez a sentinel oszlop teszi lehetővé, hogy a guard CF skipelje a CF által (`'server-guard'`) létrehozott membership rekordokat.
- **F.1 — `organization-membership-guard` CF**:
  - [packages/maestro-server/functions/organization-membership-guard/package.json](../../packages/maestro-server/functions/organization-membership-guard/package.json) (új)
  - [packages/maestro-server/functions/organization-membership-guard/src/main.js](../../packages/maestro-server/functions/organization-membership-guard/src/main.js) (új) — trigger CF, `organizationMemberships` create + delete eseményeken.
  - **Logika**: payload parse → event detect → create ágon: (1) **SENTINEL CHECK**: `payload.modifiedByClientId === 'server-guard'` → allow. (2) **SELF-BOOTSTRAP CHECK**: `getDocument(organizations, payload.organizationId)` → ha `org.ownerUserId === payload.userId` → allow (új org első owner-jének felvétele). (3) **EGYÉB**: `deleteDocument` az imént létrejött rekordon, log + 200 response. Delete ágon: csak loggol (Fázis 6/7 szigorítja).
  - **Trigger**: `databases.6880850e000da87a3d55.collections.organizationMemberships.documents.*.create` + `.delete`.
  - **Scopes**: `databases.read`, `databases.write`. Idle gyors marad (~50ms): csak 1 `getDocument` hívás, semmi `users.list()`.
- **F.2 — `invite-to-organization` CF**:
  - [packages/maestro-server/functions/invite-to-organization/package.json](../../packages/maestro-server/functions/invite-to-organization/package.json) (új)
  - [packages/maestro-server/functions/invite-to-organization/src/main.js](../../packages/maestro-server/functions/invite-to-organization/src/main.js) (új) — HTTP CF, `execute: ["users"]`, két `action` ágban.
  - **ACTION='create'** (admin oldal): caller jogosultság ellenőrzés (`listDocuments(memberships, [eq(orgId), eq(userId)])` → role=`owner`/`admin` szükséges), idempotencia (létező pending invite tokenjének visszaadása lejárat előtt; lejárt invite expired-re állítása), token generálás (`crypto.randomBytes(32).toString('hex')` → 64 char), 7 napos lejárat, `createDocument(organizationInvites, ...)`. NINCS `messaging.*` hívás (Fázis 6).
  - **ACTION='accept'** (invitee oldal): caller user kötelező → token lookup → status check (`pending`?) → expiry check (lejártnál `expired`-re állítás + 410) → e-mail egyezés check (`usersApi.get(callerId)` → caller.email vs invite.email, lowercase összehasonlítás) → duplikátum check (idempotens: ha már tagja, csak invite status frissül) → `createDocument(organizationMemberships, { ..., modifiedByClientId: 'server-guard' })` → `updateDocument(invite, { status: 'accepted' })`.
  - **Hibakódok**: `invalid_payload`, `invalid_action`, `unauthenticated`, `missing_fields`, `invalid_email`, `invalid_role`, `not_a_member`, `insufficient_role`, `invite_not_found`, `invite_not_pending`, `invite_expired`, `email_mismatch`, `caller_lookup_failed`. Minden hibakód a `fail()` wrapperen keresztül `{ success: false, reason, ...extra }` formátumban.
  - **Scopes**: `databases.read`, `databases.write`, `users.read`. `execute: ["users"]` — bárki bejelentkezett user hívhatja, a caller jogosultságot a CF maga ellenőrzi.
- **`appwrite.json` bővítés**: 2 új function bejegyzés (`organization-membership-guard`, `invite-to-organization`). [packages/maestro-server/appwrite.json](../../packages/maestro-server/appwrite.json).
- **F.4 — `AuthContext.jsx` bővítés** ([packages/maestro-dashboard/src/contexts/AuthContext.jsx](../../packages/maestro-dashboard/src/contexts/AuthContext.jsx)):
  - Új importok: `Functions` az `appwrite`-ból + `INVITE_FUNCTION_ID = 'invite-to-organization'` konstans.
  - Új `functions` singleton ugyanazon a `client`-en.
  - **`createOrganization(orgName, orgSlug, officeName, officeSlug)`** — 4-collection write: (1) `organizations` create, (2) `organizationMemberships` create role=`owner` (a guard self-bootstrap ága engedélyezi), (3) `editorialOffices` create `workflowId: null`-lal, (4) `editorialOfficeMemberships` create role=`admin`. Hibakezelés: ha a 2. lépés (membership) sikertelen, az imént létrehozott `organizations` rekordot megpróbáljuk törölni (best-effort rollback), hogy ne ragadjon árva org. A sikeres write után `loadAndSetMemberships(user.$id)` újratölti a membership state-eket.
  - **`acceptInvite(token)`** — `functions.createExecution(INVITE_FUNCTION_ID, body, false, '/', 'POST')` → `JSON.parse(execution.responseBody)` → ha `!response.success` → `Error` (with `code = response.reason`) → localStorage törlés → `loadAndSetMemberships()` → return response. A frontend-nek így a CF hibakódjai (`invite_not_found`, stb.) közvetlenül kódoltan elérhetők hibakezelésre.
  - **`createInvite(organizationId, email, role)`** — opcionális, B.5-ben még nincs admin UI, de B.10 invite teszthez kell. Ugyanaz a `createExecution` minta `action: 'create'` body-val.
  - Value object kiegészítve mindhárom új metódussal.
- **F.5 — `OnboardingRoute.jsx` teljes átírás** ([packages/maestro-dashboard/src/routes/auth/OnboardingRoute.jsx](../../packages/maestro-dashboard/src/routes/auth/OnboardingRoute.jsx)):
  - `slugify()` helper: NFD normalize ékezet eltávolításhoz + kisbetűsítés + alfanumerikus dash + max 64 char.
  - `errorMessage()` helper: magyar üzenetek a CF/Appwrite hibakódokhoz (`document_already_exists` → „Már létezik szervezet ezzel a slug-gal", `invite_not_found` → „A meghívó nem található", `invite_expired`, `email_mismatch`, network → „Hálózati hiba", stb.).
  - **Két ágra bontott UI**: (1) Ha `localStorage.maestro.pendingInviteToken` van → „Egy meghívó vár az elfogadásodra" + Elfogadás gomb (`acceptInvite()`) + „Inkább új szervezetet hozok létre" link (token elvetése). (2) Ha nincs token → 4 mezős form (orgName, orgSlug, officeName, officeSlug), `pattern="[a-z0-9-]+"` validációval. Auto-slug useEffect-ek: ha a user nem nyúlt hozzá a slug mezőhöz (`*Touched` flag), a slug a name-ből regenerálódik.
  - `handleSubmit`: validáció (minden mező kitöltött) → `createOrganization()` → `setActiveOrganization(result.organizationId)` + `setActiveOffice(result.editorialOfficeId)` (a `useScope()`-ból) → `navigate('/', { replace: true })`.
  - `handleAcceptInvite`: `acceptInvite(pendingToken)` → setActiveOrganization → navigate. Hard error esetén (`invite_not_found`/`invite_expired`/`invite_not_pending`/`email_mismatch`) localStorage cleanup, hogy a token ne ragadjon.
  - Logout gomb a card alján marad (escape hatch).
- **F.6 — `InviteRoute.jsx` komment frissítés**: a fájl-fejléc komment frissítve, hogy tükrözze: az acceptInvite() most az OnboardingRoute-on történik (a guard miatt a kliens szándékosan nem hozza létre közvetlenül a membership rekordot). Logika változatlan.
- **F.7 — Build verifikáció**: `cd packages/maestro-dashboard && yarn build` — 565ms, 82 modul, 355.56 kB JS / 106.42 kB gzip, 21.09 kB CSS / 4.89 kB gzip. Hibamentes.
- **F.3 — CF deploy (teendő a felhasználó által)**: az `appwrite.json` bejegyzések léteznek, de a CF-ek deploy-a (Appwrite Console vagy `appwrite functions create-deployment`) és az env vars beállítása (`APPWRITE_API_KEY`, `DATABASE_ID`, `ORGANIZATIONS_COLLECTION_ID`, `ORGANIZATION_MEMBERSHIPS_COLLECTION_ID`, `ORGANIZATION_INVITES_COLLECTION_ID`) a felhasználó oldalán történik. A B.10 manual happy path verifikációja előtt szükséges.
- **Megkötések / halasztott elemek**:
  - **Admin „Meghívó küldése" UI**: Fázis 6 — addig Console-ról manuálisan tesztelhető a `createInvite` AuthContext metóduson keresztül, vagy az `invite-to-organization` CF-en keresztül.
  - **Appwrite Messaging Provider** + e-mail küldés: Fázis 6.
  - **`editorialOfficeMemberships` guard CF**: Fázis 6/7 (B.5-ben csak az `organizationMemberships` van védve, a Feladatok.md szerint).
- **Kritikus érintett fájlok**:
  - **Új**: `organization-membership-guard/{package.json,src/main.js}`, `invite-to-organization/{package.json,src/main.js}`.
  - **Bővített**: `appwrite.json` (+2 function), `AuthContext.jsx` (+3 metódus), `OnboardingRoute.jsx` (teljes átírás).
  - **Komment update**: `InviteRoute.jsx`.
  - **Schema változás**: `organizationMemberships.modifiedByClientId` (Appwrite MCP).
- **Manual happy path** (csak deklaratív, futtatás nem volt — a CF deploy + env vars + Plugin/Dashboard dev szerverek a user oldalán futnak): (1) build sikerül, (2) az új user regisztráció után az `OnboardingRoute` form-ot lát, (3) submit → 4-collection write → a guard self-bootstrap engedélyezi → ScopeContext aktívvá teszi az új org+office-t → `/` redirect, (4) második user invite linken keresztül (Console-ról manuálisan generált invite) → `OnboardingRoute` észleli a tokent → Elfogadás → CF accept ág → membership létrehozás sentinellel → guard skipeli → `/` redirect.
- **Következő session feladata**: B.6 — Plugin `appwriteConfig.js` `VERIFICATION_URL` + `RECOVERY_URL` átirányítás Dashboard domainre. A két URL most a Plugin saját domainjére mutat (ahol nincs is verifikációs/reset oldal), a Dashboard pedig már fel van készülve a `/verify` és `/reset-password` route-okra.

### 2026-04-07 (folyt.) — Fázis 1 / B.5 adversarial review fix-ek (KRITIKUS biztonsági javítás)

- **Trigger**: a B.5 lezárása után `/codex:adversarial-review` futtatás háttérben — a Codex `verdict: needs-attention`-t jelzett **2 megalapozott találattal**. A user instrukciója: „Nézd át kérlek, és ami jogos, azt javítsuk".
- **Codex finding #1 — [critical] forgeable sentinel**: az `organization-membership-guard` `payload.modifiedByClientId === 'server-guard'` ellenőrzése **kliens-forgeable** volt. Bármely hitelesített user beállíthatta a saját `createDocument(organizationMemberships, { ..., modifiedByClientId: 'server-guard' })` payload-ban → a guard skipelte. Ez **cross-tenant privilege escalation**-t engedett: tetszőleges user tetszőleges org-ba beírhatta magát tetszőleges role-lal.
- **Codex finding #2 — [high] védtelen delete trigger**: az `organization-membership-guard` delete ága csak loggolt, semmit nem érvényesített. Bárki, aki a kliens ACL-en keresztül elérte, törölhetett owner/admin membership-eket → user lockout, org árvulás.
- **Mindkét finding gyökere**: a guard pattern egy adat-mező (`modifiedByClientId`) alapján próbálta megkülönböztetni a CF-eredetű és kliens-eredetű írásokat. Ez fundamentálisan rossz — adat-mezőt sosem lehet trust source-nak használni. A javítás csak **ACL-szigorítás + teljes szerver-oldali írási útvonal**.
- **Megoldás architektúra**:
  1. **5 tenant collection ACL lockdown** (Appwrite MCP, `tables_db_update_table`):
     - `organizations`, `organizationMemberships`, `editorialOffices`, `editorialOfficeMemberships`: `["read(\"users\")"]` — csak olvasás. Írást, törlést, módosítást semmilyen kliens nem tud végezni.
     - `organizationInvites`: `[]` — nincs kliens hozzáférés (a kódbázisban sincs kliens-oldali olvasás, az invite token-t a CF response adja vissza).
     - Az API key-jel futó CF-ek bypass-olják az ACL-t, így a `invite-to-organization` továbbra is szabadon ír.
  2. **`bootstrap_organization` action** az `invite-to-organization` CF-be ([packages/maestro-server/functions/invite-to-organization/src/main.js](../../packages/maestro-server/functions/invite-to-organization/src/main.js)):
     - A teljes 4-collection write logika átköltözött a Dashboard `AuthContext.createOrganization`-ből a CF-be.
     - Bemenet: `{ orgName, orgSlug, officeName, officeSlug }` + caller `x-appwrite-user-id` header.
     - Validáció: trim + length check + slug regex (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, max 64 char).
     - Atomikus 4-step write: `organizations` → `organizationMemberships`(owner) → `editorialOffices` → `editorialOfficeMemberships`(admin), mind API key-jel.
     - **Best-effort rollback**: minden lépés saját try/catch-ben, ha hiba van → fordított sorrendben deleteDocument a már létrehozott rekordokra.
     - Új hibakódok: `invalid_slug`, `org_slug_taken`, `org_create_failed`, `membership_create_failed`, `office_slug_taken`, `office_create_failed`, `office_membership_create_failed`.
     - Response: `{ success: true, organizationId, editorialOfficeId }`.
  3. **`accept` action sentinel eltávolítás**: a `createDocument(memberships, ...)` hívásból eltűnt a `modifiedByClientId: 'server-guard'` mező. A membership a tiszta API key írással jön létre, az ACL miatt csak így lehetséges.
  4. **`AuthContext.createOrganization` refactor** ([packages/maestro-dashboard/src/contexts/AuthContext.jsx](../../packages/maestro-dashboard/src/contexts/AuthContext.jsx)): a ~100 soros, 4 direkt `databases.createDocument` hívásból álló logika helyett egyetlen `functions.createExecution(INVITE_FUNCTION_ID, { action: 'bootstrap_organization', ... })` hívás. A CF response-ból veszi az `organizationId` + `editorialOfficeId`-t, majd `loadAndSetMemberships()` újratölti a state-et.
  5. **`organization-membership-guard` CF teljes törlés**: a guard CF már szükségtelen, mert az ACL megakadályozza a kliens írást. A `packages/maestro-server/functions/organization-membership-guard/` mappa törölve, az `appwrite.json` `functions` array bejegyzése törölve.
  6. **`organizationMemberships.modifiedByClientId` oszlop törlés**: a sentinel mező feleslegessé vált — Appwrite MCP `tables_db_delete_column`. Verifikáció: az oszlop eltűnt, a többi 4 oszlop (`organizationId`, `userId`, `role`, `addedByUserId`) `available`.
- **Build verifikáció**: `cd packages/maestro-dashboard && yarn build` — 619ms, 82 modul, 354.85 kB JS / 106.26 kB gzip, 21.09 kB CSS / 4.89 kB gzip. Hibamentes.
- **CF deploy (teendő a felhasználó által)**:
  - `invite-to-organization` CF újradeploy szükséges (új `bootstrap_organization` action + új env vars: `EDITORIAL_OFFICES_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`).
  - `organization-membership-guard` CF Appwrite Console-on TÖRLENDŐ (a függvény még él, csak az `appwrite.json` és a forrás tűnt el a repo-ból).
- **Tanulság / kódstílus megerősítés**:
  - **Adat-mező sosem lehet trust source**. Ha a security döntés azon múlik, hogy a kliens „barát" vagy „ellenség", csak unforgeable szignál (API key origin, JWT claims, ACL) működik.
  - A `modifiedByClientId` sentinel pattern az `articles` és `users` collection-ön továbbra is OK — ott a célja **végtelen ciklus megelőzése** (a CF-ek saját update-jei ne triggerelje a guard CF-et újra), nem authorizáció. A két use case nyelvileg hasonló, szemantikailag teljesen más.
- **Érintett fájlok**:
  - **Új**: bootstrap_organization action a [packages/maestro-server/functions/invite-to-organization/src/main.js](../../packages/maestro-server/functions/invite-to-organization/src/main.js)-ben.
  - **Törölve**: `packages/maestro-server/functions/organization-membership-guard/` mappa (mindkét fájl), `appwrite.json`-ban a function bejegyzés, `organizationMemberships.modifiedByClientId` oszlop.
  - **Refaktorálva**: [packages/maestro-dashboard/src/contexts/AuthContext.jsx](../../packages/maestro-dashboard/src/contexts/AuthContext.jsx) `createOrganization`, `accept` action a CF-ben (sentinel eltávolítás).
  - **ACL módosítva**: 5 collection (`organizations`, `organizationMemberships`, `editorialOffices`, `editorialOfficeMemberships`, `organizationInvites`).
  - **Doc frissítés**: ez a fájl, [packages/maestro-server/CLAUDE.md](../../packages/maestro-server/CLAUDE.md), [_docs/Feladatok.md](../Feladatok.md).
- **Következő session feladata** (változatlan): B.6 — Plugin `appwriteConfig.js` `VERIFICATION_URL` + `RECOVERY_URL` átirányítás Dashboard domainre.

### 2026-04-08 — Fázis 1 / B.6 kész (Plugin auth callback Dashboardra + proxy legacy redirect)

- **Plan fájl**: [`~/.claude/plans/hidden-imagining-sloth.md`](../../../../.claude/plans/hidden-imagining-sloth.md). A user jóváhagyta változtatás nélkül.
- **Cél**: a Plugin `account.createVerification()` / `account.createRecovery()` hívásainak URL-jei a Dashboard `/verify` és `/reset-password` route-jaira mutassanak (nem a régi proxy HTML formokra). Párhuzamosan a Feladatok.md-ben szereplő „Proxy régi reset oldalának megszüntetése vagy Dashboard redirect" pont is letudva — a proxy `/verify` és `GET /reset-password` endpointjai 302 redirectet küldenek a Dashboardra.
- **Döntés**: (b) redirect, nem teljes törlés. Indoklás: user inboxokban heteken át maradhatnak régi verify/recovery email linkek — egyszerű törlés 404-et adna, a redirect átviszi a usert a Dashboardra ugyanazon `userId+secret` query string-gel.
- **Változások**:
  - **`packages/maestro-indesign/src/core/config/appwriteConfig.js` (17–24. sor)**: `RAILWAY_BASE` konstans törölve (csak ehhez a két URL-hez volt használva). A `DASHBOARD_URL` exportja a `VERIFICATION_URL` és `RECOVERY_URL` elé került (temporal dead zone elkerülés). `VERIFICATION_URL = \`${DASHBOARD_URL}/verify\``, `RECOVERY_URL = \`${DASHBOARD_URL}/reset-password\``. A `process.env.VERIFICATION_URL` / `process.env.RECOVERY_URL` env override fallback megszűnt — most már csak a `DASHBOARD_URL`-en keresztül konfigurálható.
  - **`packages/maestro-indesign/webpack.config.js` (57–61. sor)**: `DefinePlugin` — a két régi env var inject (`VERIFICATION_URL`, `RECOVERY_URL`) törölve, helyette `process.env.DASHBOARD_URL` inject. Dev override minta: `DASHBOARD_URL=http://localhost:5173 npm run build`.
  - **`packages/maestro-proxy/server.js`**: a régi HTML helperek (`BASE_STYLES`, `resultHTML`, `escapeAttr`, `resetPasswordFormHTML`) + a verify/reset-password handler implementációk (Server SDK-val, HTML formmal, Appwrite REST recovery POST-tal) teljesen törölve (280–606. sorok a régi fájlban). Helyettük három kis handler a 280–309. sorokon: `GET /verify` 302 redirect a Dashboard `/verify`-ra (query string továbbításával), `GET /reset-password` 302 redirect a Dashboard `/reset-password`-re, `POST /reset-password` 410 Gone (a régi form POST body-ját nem tudjuk GET-re továbbítani). A felhasználatlanná vált `const sdk = require('node-appwrite')` import törölve a 4. sorról, és a `node-appwrite` dependency a `package.json`-ből is kiszedve (`routes/layoutAI.js` csak az `@anthropic-ai/sdk`-t használja).
  - **`packages/maestro-indesign/CLAUDE.md` (483. és 486. sor)**: a regisztrációs és elfelejtett jelszó flow leírásban a „proxy `/reset-password` oldal" → „Dashboard `/reset-password` oldal" frissítés, valamint explicit utalás a `VerifyRoute.jsx` és `ResetPasswordRoute.jsx` Dashboard komponensekre.
- **Build verifikáció**: `cd packages/maestro-indesign && npm run build` — hibamentes, 4081ms, bundle.js 6.9 MiB (unchanged). A `DefinePlugin` `process.env.DASHBOARD_URL` → `undefined` (env var nincs beállítva local buildnél) → webpack minifier `false || 'https://maestro.emago.hu'` formára egyszerűsíti → runtime-ban a fallback érvényesül. A `VERIFICATION_URL` és `RECOVERY_URL` runtime-ban `"".concat(DASHBOARD_URL, "/verify")` / `"/reset-password")` módon épül fel a Dashboard URL-ből (`grep -oE 'VERIFICATION_URL = [^;]*;' dist/bundle.js` megerősítette).
- **Hívók változatlanok**: [UserContext.jsx:11,231](../../packages/maestro-indesign/src/core/contexts/UserContext.jsx#L231) `account.createVerification({ url: VERIFICATION_URL })` és [index.js:111,313](../../packages/maestro-indesign/src/core/index.js#L313) `account.createRecovery({ email, url: RECOVERY_URL })` — a konstansok új értéke transzparens.
- **Proxy redeploy (teendő a felhasználó által)**: a Railway `maestro-proxy` újradeploy szükséges a legacy redirectek élesedéséhez. A deployment sorrend tolerálható — bármelyik oldal mehet előbb, a flow mindkét köztes állapotban működik (Plugin előbb: a régi Railway URL-re mutató email linkek még a régi HTML flow-n mennek; proxy előbb: a Plugin régi build a Railway URL-re mutat → Railway redirectel Dashboardra → Dashboard kezeli).
- **Érintett fájlok**:
  - **Módosítva**: [packages/maestro-indesign/src/core/config/appwriteConfig.js](../../packages/maestro-indesign/src/core/config/appwriteConfig.js), [packages/maestro-indesign/webpack.config.js](../../packages/maestro-indesign/webpack.config.js), [packages/maestro-proxy/server.js](../../packages/maestro-proxy/server.js), [packages/maestro-proxy/package.json](../../packages/maestro-proxy/package.json), [packages/maestro-indesign/CLAUDE.md](../../packages/maestro-indesign/CLAUDE.md), ez a fájl.
  - **Törölve** a proxy-ból: `BASE_STYLES`, `resultHTML()`, `escapeAttr()`, `resetPasswordFormHTML()`, teljes verify + reset-password handler implementációk, `node-appwrite` dependency + `sdk` import.
- **Adversarial review fix-ek (Codex)**: a review két [high] findingot jelzett a hardkódolt callback target-ek miatt. Javítva:
  - **`packages/maestro-proxy/server.js` (289. sor)**: a `DASHBOARD_VERIFY_URL` / `DASHBOARD_RESET_PASSWORD_URL` literalokat egyetlen `DASHBOARD_URL` env-driven konstans váltotta fel (production fallback `https://maestro.emago.hu`, trailing slash trim-eléssel). Staging vagy domain-migráció esetén így a Railway / Apache deployment env-en keresztül felülírható, és a `userId+secret` token-ek nem kerülnek rossz frontendre.
  - **`packages/maestro-indesign/webpack.config.js` (top-level)**: build-time figyelmeztetés, ha a régi `VERIFICATION_URL` vagy `RECOVERY_URL` env változó még be van állítva — a developert tájékoztatja, hogy ezek némán ignorálódnak, és helyettük `DASHBOARD_URL`-t kell használnia. Olcsó footgun-védelem CI / lokális `.env` örökség ellen.
- **Következő session feladata**: B.7 — Plugin `UserContext` + `DataContext` scope bevezetés (`organizations`, `editorialOffices`, `activeOrganizationId`, `activeEditorialOfficeId`, scope-szűrt fetch). Ez a Plugin oldali counterpart a Dashboard `AuthContext` + `ScopeContext`-nek, amelyek B.3/B.4 óta élnek.

### 2026-04-08 — Fázis 1 / B.7 kész (Plugin scope bevezetés)

- **Plan fájl**: [`~/.claude/plans/cheerful-prancing-lobster.md`](../../../../.claude/plans/cheerful-prancing-lobster.md). A user jóváhagyta változtatás nélkül.
- **Cél**: a Plugin felzárkóztatása a Dashboard B.4-ben bevezetett scope modellre — saját `ScopeContext`, `UserContext` membership state, `DataContext` scope-szűrt fetch + Realtime payload szűrés + write-through scope injection. Ez blokkolja B.8-at (CF guard officeId kiterjesztés) és B.9-et (teszt wipe).
- **Döntések (plan döntési táblázata)**:
  1. **Külön `ScopeContext.jsx`** a `UserContext` bővítése helyett — a Dashboard mintát követi, könnyebb Fázis 6-os multi-org/office switch UI-hoz, és a `DataContext` deps egyértelműbb.
  2. **Azonos localStorage kulcsok** Dashboarddal (`maestro.activeOrganizationId`, `maestro.activeEditorialOfficeId`) — a két környezet izolált, nincs ütközés, viszont dokumentációs áttekintési előny.
  3. **Egy aktív office, switch UI nélkül** B.7-ben — a multi-org/office dropdown Fázis 6.
  4. **Üres scope → `ScopeMissingPlaceholder`** a Workspace előtt — loading / no-membership (Dashboard linkkel) / error (retry gombbal) variánsok.
  5. **Write-through scope injection refből olvasva** — a `useCallback` stabil marad, a ref-ek stale closure ellen védenek.
  6. **Realtime payload szűrés a meglévő pub-szűrés MELLÉ** — `.delete` eseménynél nem szűrünk (a `filter()` amúgy is csak meglévőt töröl), egyébként `payload.editorialOfficeId === active` ellenőrzés véd a cross-tenant leakage ellen.
  7. **Membership Realtime sync NEM kerül be B.7-be** — a Dashboard sem tette még be (Fázis 6). A `dataRefreshRequested` (recovery) + login mount újratölt mindent.
- **Változások**:
  - **[`packages/maestro-indesign/src/core/contexts/UserContext.jsx`](../../packages/maestro-indesign/src/core/contexts/UserContext.jsx)** (F.1): modul-szintű `fetchMemberships(userId)` helper — Dashboard `AuthContext.fetchMemberships` 1:1 port-ja: paralel `organizationMemberships` + `editorialOfficeMemberships` lekérés, majd a scope rekordok (`organizations`, `editorialOffices`) `Query.equal('$id', ids)`-sel. Hibát NEM nyel le. Új state: `organizations`, `editorialOffices`, `membershipsError`. `loadAndSetMemberships` useCallback beállítja vagy clear-eli őket. A login/mount checkUserStatus/recovery handler mind paralel futtatja `enrichUserWithTeams` mellett `Promise.all` + `.catch(() => null)` wrapper-rel — egy membership hiba nem blokkolja az auth happy path-ot, csak a `membershipsError` state-ben marad. A `logout()` mind a három state-et nullázza. Új exportok: `organizations`, `editorialOffices`, `membershipsError`, `reloadMemberships` (userRef-ből olvasott user ID-val újrahív).
  - **[`packages/maestro-indesign/src/core/contexts/ScopeContext.jsx`](../../packages/maestro-indesign/src/core/contexts/ScopeContext.jsx)** (F.2, új fájl): a Dashboard `ScopeContext` 1:1 portja. Lazy localStorage init try/catch-csel (UXP edge case). `setActiveOrganization` / `setActiveOffice` useCallback írják a state-et és a localStorage-ot. Stale ID validáció + auto-pick useEffect `loading === false && !membershipsError` esetén fut: (1) ha az aktuális `activeOrganizationId` már nincs a `organizations` listában → első elérhetőre vált vagy nullázza; (2) ha nincs aktív org, de van membership → auto-pick; (3) office validáció csak az AKTÍV orghoz tartozó office-okkal (különben egy idegen org office-át véletlenül elfogadnánk); (4) ugyanaz az auto-pick minta. A `!membershipsError` guard kritikus: átmeneti fetch hiba nem törölheti a helyes scope-ot.
  - **[`packages/maestro-indesign/src/ui/features/workspace/ScopeMissingPlaceholder.jsx`](../../packages/maestro-indesign/src/ui/features/workspace/ScopeMissingPlaceholder.jsx)** (F.3, új fájl): három variáns — `loading` (a `Loading` komponenssel), `no-membership` (Dashboard link), `error` (`onRetry` gombbal). Spectrum Web Components (`sp-heading`, `sp-body`, `sp-detail`, `sp-button`), inline stílusokkal.
  - **[`packages/maestro-indesign/src/core/Main.jsx`](../../packages/maestro-indesign/src/core/Main.jsx)** (F.3): új import `ScopeProvider, useScope` + `ScopeMissingPlaceholder`. Új belső komponens `ScopedWorkspace`: ha `membershipsError` → error variáns + `reloadMemberships` retry, ha `userLoading` → loading variáns, ha `!activeEditorialOfficeId` → (`organizations.length === 0` ? `no-membership` : `loading`), különben `<Workspace />`. A `user` ágon belül: `<ScopeProvider>` wrapper a `<DataProvider>` köré, a `<Workspace />` helyére `<ScopedWorkspace />`.
  - **[`packages/maestro-indesign/src/core/contexts/DataContext.jsx`](../../packages/maestro-indesign/src/core/contexts/DataContext.jsx)** (F.4–F.6): `useScope()` integrációval `activeOrganizationId` + `activeEditorialOfficeId` olvasás. Két új ref (`activeOrganizationIdRef`, `activeEditorialOfficeIdRef`) stale closure védelemhez + ref sync effect-ek. **F.4 — Scope-szűrt fetch**: a `fetchData` elején `currentOfficeId` ref-ből, early return üres listákkal ha nincs scope (`setIsInitialized(true)` + `setConnected()`, hogy a Realtime subscribe elindulhasson). `Query.equal("editorialOfficeId", currentOfficeId)` minden query-be (publications, articles, layouts, deadlines, uservalidations chunked). Stale `activePublicationId` védelem `sortedPublications` után: ha az aktuális aktív kiadvány már nincs a scope-szűrt listában → nullázás. Új office-váltás side effect (`prevOfficeIdRef`): office váltáskor `setActivePublicationId(null) + articles/layouts/deadlines/validations clear`. Az `activeEditorialOfficeId` a `useEffect([activePublicationId, activeEditorialOfficeId, isInitialized])` deps-be került — bármelyik változására új fetch. **F.5 — Realtime payload szűrés**: minden ágon (publications, articles, layouts, deadlines, uservalidations) `const isDelete = event.includes(".delete"); if (!isDelete && (!currentOfficeId || payload.editorialOfficeId !== currentOfficeId)) return;` — a delete eseményt nem szűrjük (a payload NEM tartalmaz scope mezőket delete-nél amúgy sem biztos, és a `filter()` csak meglévőt töröl). **F.6 — Write-through scope injection**: új `withScope(data)` useCallback helper — ref-ből olvasott `organizationId` + `editorialOfficeId` mezőket fűz a payload-hoz, dob ha bármelyik hiányzik (defenzív védelem happy path-ban nem tüzelhet, de védi a race-eket). A `createPublication`, `createArticle`, `createLayout`, `createDeadline`, `createValidation` mind `data: withScope(data)` payload-ot küld. Az `updateX` metódusok NEM kapnak injection-t — a scope mezők immutable-ek a CF guard B.8 után.
  - **[`packages/maestro-indesign/CLAUDE.md`](../../packages/maestro-indesign/CLAUDE.md)**: Provider hierarchia diagram frissítve a `ScopeProvider` + `ScopedWorkspace` beillesztéssel. DataContext API szekció új bekezdés: „Scope-szűrt fetch", „Realtime scope szűrés", „Write-through scope injection". Új `ScopeContext API` szekció a DataContext és UserContext közé. UserContext API új bekezdés: „Memberships (Fázis 1 / B.7)".
  - **[`_docs/Feladatok.md`](../Feladatok.md) sor 46–47**: két checkbox `[x]`-re + B.7 implementációs részletek.
- **Build verifikáció**: `cd packages/maestro-indesign && npm run build` — `webpack 5.105.2 compiled with 3 warnings in 4588 ms`, a három warning a szokásos bundle size limit (6.97 MiB, nem változott érdemben, +néhány KB új context + komponens). 0 hiba.
- **Verifikáció (manuálisan, user oldalán)**: (1) Friss bejelentkezés → `[UserContext] Tagsági adatok betöltve` log + `organizations.length > 0`. (2) Scope-szűrt fetch: a Plugin csak a saját office publication-jeit látja; Console-ban másik officeId-vel létrehozott pub nem jelenik meg. (3) Realtime payload szűrés: másik office payload kihagyva. (4) Write-through scope injection: új publication Console-ban ellenőrizve → `organizationId` + `editorialOfficeId` mezők jelen. (5) Placeholder UI: `localStorage.removeItem('maestro.activeEditorialOfficeId')` + reload → `ScopeMissingPlaceholder` jelenik meg. (6) Office váltás: kézzel állított localStorage + reload → régi `activePublicationId` resetelődik.
- **Érintett fájlok**:
  - **Módosítva**: [packages/maestro-indesign/src/core/contexts/UserContext.jsx](../../packages/maestro-indesign/src/core/contexts/UserContext.jsx), [packages/maestro-indesign/src/core/contexts/DataContext.jsx](../../packages/maestro-indesign/src/core/contexts/DataContext.jsx), [packages/maestro-indesign/src/core/Main.jsx](../../packages/maestro-indesign/src/core/Main.jsx), [packages/maestro-indesign/CLAUDE.md](../../packages/maestro-indesign/CLAUDE.md), [_docs/Feladatok.md](../Feladatok.md), ez a fájl.
  - **Új**: [packages/maestro-indesign/src/core/contexts/ScopeContext.jsx](../../packages/maestro-indesign/src/core/contexts/ScopeContext.jsx), [packages/maestro-indesign/src/ui/features/workspace/ScopeMissingPlaceholder.jsx](../../packages/maestro-indesign/src/ui/features/workspace/ScopeMissingPlaceholder.jsx).
- **Következő session feladata**: B.8 — meglévő Cloud Function guardok (`validate-article-creation`, `article-update-guard`, `validate-publication-update`) kiterjesztése `editorialOfficeId` scope validációval + `editorialOfficeMemberships` lookup. Ez már a régi collection-eken futó guard-ok átalakítása; a B.9 wipe előtti utolsó lépés.

### 2026-04-08 — Fázis 1 / B.8 kész (CF scope kiterjesztés)

- **Plan fájl**: [`~/.claude/plans/groovy-brewing-wall.md`](../../../../.claude/plans/groovy-brewing-wall.md). A user jóváhagyta változtatás nélkül, 4 döntéssel előtte.
- **Cél**: a három régi data-layer guard CF (`article-update-guard`, `validate-article-creation`, `validate-publication-update`) felzárkóztatása a multi-tenant scope modellre. A Plugin happy path (`withScope()`) már scope mezőkkel ír, de a szerver-oldal eddig semmit nem tudott róluk — egy hitelesített user direkt API hívással tetszőleges `editorialOfficeId`-vel tudott írni, illetve másik office cikkét módosítani. Ez blokkolta B.9-et (teszt wipe) és B.10-et (happy path verifikáció).
- **Döntések (4 user-megerősített)**:
  1. **Cross-tenant viselkedés**: update-nél revert (state visszaállítás), create-nél delete.
  2. **Legacy null scope**: skip + warning log (B.9 wipe után már nem fut).
  3. **Team/label check változatlan marad**, az office-check mellé kerül.
  4. **Parent consistency check**: igen — `article.editorialOfficeId === publication.editorialOfficeId` a `validate-article-creation`-ben.
- **Közös minta (mindhárom CF)**:
  - Új env var: `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`.
  - Fail-fast env var guard az `invite-to-organization` CF mintájára — hiány esetén 500-as response `{ success: false, reason: 'misconfigured', missing: [...] }`.
  - Copy-paste `hasOfficeMembership(databases, databaseId, collectionId, userId, officeId)` helper: `listDocuments` + `Query.equal('userId') + Query.equal('editorialOfficeId') + Query.limit(1)` → `total > 0`. Hiba esetén `false` (fail-closed).
  - Caller ID olvasás: `req.headers['x-appwrite-user-id']`. Ha nincs (pl. server-oldali process) → skip.
  - Legacy skip: ha `freshDoc.editorialOfficeId` falsy → `[Scope] Legacy ... — office check kihagyva` warning log, a többi validáció (contributor, preflight) lefut.
- **Változások**:
  - **[`packages/maestro-server/functions/article-update-guard/src/main.js`](../../packages/maestro-server/functions/article-update-guard/src/main.js)**: új `hasOfficeMembership` helper, új env var + fail-fast guard, új Step 6 office scope check a state transition (Step 5) és a team permission (Step 7, korábban Step 6) között. Nem-tag caller esetén state revert (`corrections.state = Number(previousState)` ha stateChanged). A contributor check és a `previousState` karbantartás a meglévő sorrendben maradt, csak átszámozódott.
  - **[`packages/maestro-server/functions/validate-article-creation/src/main.js`](../../packages/maestro-server/functions/validate-article-creation/src/main.js)**: új helper, új env var + guard, refaktor: a publicationId fetch eredménye `parentPublication` változóba kerül (nincs dupla getDocument). Három új step a publicationId check után: (2) scope mezők jelenlét → hiány esetén delete; (3) parent publication consistency → office mismatch esetén delete, legacy null parent scope esetén skip + log; (4) caller membership → nem-tag esetén delete. A contributor, filePath, corrections lépések a meglévő sorrendben maradtak.
  - **[`packages/maestro-server/functions/validate-publication-update/src/main.js`](../../packages/maestro-server/functions/validate-publication-update/src/main.js)**: új helper, új env var + guard, új event type detection a `x-appwrite-event` header alapján (`isCreate = eventHeader.includes('.create')`). Új scope check: create eventnél hiányzó `organizationId` / `editorialOfficeId` → delete; caller membership check: create-nél nem-tag → delete, update-nél csak logolás (B.8 korlát). Az update path nem revertel field-level változásokat (rootPath, default contributors) — ez a `validate-publication-update` mostani architektúrális korlátja, a teljes field-level revert Fázis 6 hatáskör. A contributor + rootPath validáció továbbfut, hogy nem-tag user által írt rossz adatok javíthatók legyenek.
  - **[`packages/maestro-server/CLAUDE.md`](../../packages/maestro-server/CLAUDE.md)**: per-function env var tábla bővítése mindhárom érintett soron az `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`-vel. Működési leírás szekció: `article-update-guard` új Step 5 (Scope ellenőrzés) a lista közepén, `validate-article-creation` + `validate-publication-update` leírás alá új bekezdés „Scope ellenőrzés (B.8)" címmel a viselkedés összefoglalóval.
  - **[`_docs/Feladatok.md`](../Feladatok.md) sor 34**: `[ ]` → `[x]` + `*(B.8 kész — ...)*` komment a helper, env var, és viselkedés röviden.
- **Felhasználói verifikáció (következő lépésben a user oldalán)**: a CF-ek deploy + env var beállítás Appwrite Console-ban vagy CLI-vel (`EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID=editorialOfficeMemberships`). A B.10 manual happy path session során tesztelhető: (1) friss bejelentkezés → publication + article létrehozás → `validated`; (2) cross-tenant kísérlet (Console-ból vagy második user) → a megfelelő guard revert/delete-tel reagál; (3) legacy null scope (csak wipe előtt) → warning log, nincs változás.
- **Korlátok (Fázis 6 hatáskör)**:
  - `validate-publication-update` update path nem revertel `rootPath`, default contributors, vagy egyéb mezőket — csak logol. A teljes field-level cross-tenant védelem ACL lockdown-nal + mező-szintű revert-tel jön a `publications` collection-re Fázis 6-ban.
  - A három guard nem védi a `layouts`, `deadlines`, `uservalidations` collection-öket. Ezeket vagy új guard CF-ek, vagy ACL lockdown fogja fedni Fázis 6/7-ben.
- **Érintett fájlok**:
  - **Módosítva**: [packages/maestro-server/functions/article-update-guard/src/main.js](../../packages/maestro-server/functions/article-update-guard/src/main.js), [packages/maestro-server/functions/validate-article-creation/src/main.js](../../packages/maestro-server/functions/validate-article-creation/src/main.js), [packages/maestro-server/functions/validate-publication-update/src/main.js](../../packages/maestro-server/functions/validate-publication-update/src/main.js), [packages/maestro-server/CLAUDE.md](../../packages/maestro-server/CLAUDE.md), [_docs/Feladatok.md](../Feladatok.md), ez a fájl.
- **Következő session feladata**: B.9 — teszt adat wipe. A `publications`, `articles`, `layouts`, `deadlines`, `uservalidations`, `validations` collection-ök régi (null scope) rekordjait Appwrite MCP-vel törölni. Utána B.10 — manual happy path verifikáció: friss bejelentkezés, publication létrehozás, article felvétel, scope ellenőrzés a Console-ban, cross-tenant tesztek.

### 2026-04-08 — Fázis 1 / B.8 deploy + B.9 teszt wipe kész (Appwrite MCP + CLI)

- **Cél**: a B.8-ban kész CF kódot élesbe tenni, majd a Fázis 1 / B.9 szerint a teljes adatbázist (6 tenant collection + articlemessages + thumbnails bucket) kitakarítani, hogy a B.10 manual happy path friss, üres állapotból induljon.
- **B.8 deploy (Appwrite MCP + CLI)**:
  - Mindhárom CF-re (`article-update-guard`, `validate-article-creation`, `validate-publication-update`) `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID=editorialOfficeMemberships` env var beállítva MCP `functions_create_variable` (secret: true) hívással.
  - `mcp__appwrite__functions_create_deployment` nem működött (belső Python wrapper bug: `'str' object has no attribute 'source_type'`), helyette Appwrite CLI v16.0.0 `appwrite functions create-deployment` (direkt, non-interactive) a `packages/maestro-server/` mappából futtatva.
  - Deployment ID-k (mind `ready`): `article-update-guard` → `69d6c7a47d0aa3f9c728`, `validate-article-creation` → `69d6c7a90dd5d52f555e` (15s build), `validate-publication-update` → `69d6c7a9d73573567daf` (16s build). Verifikáció `mcp__appwrite__functions_get` + `functions_get_deployment`.
- **B.9 teszt wipe scope döntés**:
  - User választása a két felkínált opcióból: **Opció 1** (teljes wipe, nem csak null scope) + **Opció B** (6 collection + `articlemessages` + thumbnail Storage fájlok) → tiszta lap a B.10-hez.
- **B.9 végrehajtás (Appwrite MCP)**:
  - Párhuzamos bulk delete `mcp__appwrite__tables_db_delete_rows` no-query hívásokkal → 6 collection egyben: `publications` 4, `articles` 139, `layouts` 16, `deadlines` 10, `uservalidations` 13, `validations` 3 = **185 row**. `articlemessages` előzetes list-tel 0 → skip.
  - Thumbnails bucket (`thumbnails`) induló count: **147 fájl**. Az első delete batch (50 parallel `storage_delete_file` hívás) összes elemre `The requested file could not be found` hibát adott → kiderült, hogy az `articles` bulk delete automatikusan kiváltott egy cascade CF-et, ami 146 fájlt már törölt a thumbnails bucket-ből. Újralistázás után **1 orphan** (`69c5bd9e001d66d398aa`) maradt, azt manuálisan töröltem.
  - Verifikációs round (`list_rows` limit 1 + `list_files` limit 1): minden 6 collection és a thumbnails bucket `total: 0`.
- **Tanulság**: a `cleanup-article-thumbnails` (vagy hasonló) cascade CF a `articles.*.delete` trigger alatt bulk delete esetén is tüzel és paralel ki tudja üríteni a bucket-et. A B.9-hez tervezett 147 iteratív delete feleslegesre vált — a wipe jóval gyorsabb volt mint vártuk.
- **MCP query format**: a list/delete operációkhoz a `queries` paraméter JSON string formátumot kíván (pl. `{"method":"limit","values":[1]}`), nem a legacy `"limit(1)"` stringet. Ezt rögzítem mint használható pattern a jövőbeli Appwrite MCP hívásokhoz.
- **Érintett fájlok**:
  - **Módosítva**: [_docs/Feladatok.md](../Feladatok.md) sor 48 (`[x]` + B.9 komment), [_docs/workflow-designer/PROGRESS.md](PROGRESS.md) B.9 checklist + ez a session jegyzet.
  - **Nem módosítva**: a B.8 kódváltozások már a korábbi session-ben commitolva + most élesítve.
- **Következő session feladata**: B.10 — manual happy path verifikáció user oldalon. (1) Friss regisztráció a Dashboardon → email verifikáció → onboarding (új org + office) → Plugin bejelentkezés. (2) Publication létrehozás, article felvétel → CF guard-ok `validated` válasszal engedik. (3) Cross-tenant teszt: második user / office-ban levő cikk módosítása → `article-update-guard` state revert, publication módosítás → log-only, create mismatch → delete. (4) Scope leak ellenőrzés a Plugin UI-ban (csak az aktív office adatai látszanak). (5) Opcionális: második org + invite flow a `invite-to-organization` CF-en keresztül.

### 2026-04-09 — Fázis 1 / B.11 kész (`/settings/password` route)

- **Plan fájl**: [`~/.claude/plans/kind-painting-hummingbird.md`](../../../../.claude/plans/kind-painting-hummingbird.md). A user jóváhagyta.
- **Cél**: Fázis 1 utolsó kódos feladata — bejelentkezett user a Dashboardon megnyithat egy jelszó módosító oldalt. Az `AuthContext.updatePassword(oldPassword, newPassword)` már B.4 óta létezik, csak UI belépési pont és route komponens hiányzott.
- **Változások**:
  - **Új**: [`packages/maestro-dashboard/src/routes/settings/SettingsPasswordRoute.jsx`](../../packages/maestro-dashboard/src/routes/settings/SettingsPasswordRoute.jsx) — 3 mezős form (régi + új + megerősítés), `phase` state (`'idle' | 'success'`), kliens-oldali validáció (üres régi, <8 karakter új, egyezés, régi≠új), Appwrite hibakód → magyar üzenet mapping (`user_invalid_credentials`, `password must be`, `general_rate_limit_exceeded`), sikeres mentés után success banner + "Vissza a Dashboardra" link. NEM redirect, a user explicit visszajelzést kap.
  - **Módosítva**: [`packages/maestro-dashboard/src/App.jsx`](../../packages/maestro-dashboard/src/App.jsx) — új import + `<Route path="/settings/password" element={<SettingsPasswordRoute />} />` a védett + `AuthSplitLayout` ágba (az `/onboarding` mellé). Így a `ProtectedRoute` automatikusan védi, anonymous user → `/login` redirect.
  - **Módosítva**: [`packages/maestro-dashboard/src/components/DashboardHeader.jsx`](../../packages/maestro-dashboard/src/components/DashboardHeader.jsx) — `react-router-dom` `Link` import + `<Link to="/settings/password" className="auth-link">Jelszó módosítása</Link>` a user név és Kijelentkezés gomb között. A `.auth-link` class már létezik (B.4 óta), új CSS nem kellett.
- **Döntések**:
  1. **Link, nem dropdown**: a user menü dropdown (avatar → Jelszó módosítása | Kijelentkezés) Fázis 6 hatáskör, a multi-org/office switch dropdown-nal együtt. B.11-ben minimális link, hogy a feladat pipálódjon.
  2. **`AuthSplitLayout` wrapper** az OnboardingRoute-tal konzisztens, nem kell új layout komponens.
  3. **Success után marad az oldalon** (nem redirect) — explicit visszajelzés a user-nek.
  4. **CSS teljesen reuse** (`.login-card`, `.form-heading`, `.form-group`, `.login-btn`, `.auth-success`, `.login-error`, `.auth-bottom-link`, `.auth-link`).
- **Build verifikáció**: `cd packages/maestro-dashboard && yarn build` — 506ms, 83 modul (+1 az új route miatt), 360.65 kB JS / 107.69 kB gzip, 21.09 kB CSS / 4.89 kB gzip. Hibamentes.
- **Manuálisan ellenőrizendő (user oldalán)**: (1) DashboardHeader-ben látszik az új link. (2) `/settings/password` megnyitás → form. (3) Hibás régi jelszó → "A jelenlegi jelszó hibás." (4) Helyes adatok → success banner + "Vissza a Dashboardra" link. (5) Kijelentkezés + belépés új jelszóval → sikeres. (6) Anonymous `/settings/password` → `/login` redirect.
- **Fázis 1 állapota**: minden kódos feladat kész. Utolsó nyitott elem: **B.10 manual happy path verifikáció** a user oldalán. Utána Fázis 1 lezárható, és jöhet Fázis 2 (dinamikus csoportok).
- **Érintett fájlok**:
  - **Új**: [packages/maestro-dashboard/src/routes/settings/SettingsPasswordRoute.jsx](../../packages/maestro-dashboard/src/routes/settings/SettingsPasswordRoute.jsx).
  - **Módosítva**: [packages/maestro-dashboard/src/App.jsx](../../packages/maestro-dashboard/src/App.jsx), [packages/maestro-dashboard/src/components/DashboardHeader.jsx](../../packages/maestro-dashboard/src/components/DashboardHeader.jsx), [_docs/Feladatok.md](../Feladatok.md) sor 43, ez a fájl.
- **Következő session feladata**: B.10 manual verifikáció indítása user oldalon (lásd a B.9 session jegyzet végén lévő 5 lépést). Ez a Fázis 1 lezárása.

### 2026-04-09 — Fázis 1 / B.10 kész (Manual happy path verifikáció — Chrome MCP)

- **Cél**: a teljes Fázis 1 auth + onboarding + invite flow manuális végigvezetése a Chrome DevTools MCP-vel automatizálva. Fázis 1 lezárása.
- **Tesztelt flow-k és eredmények** (mind sikeres):
  1. **Kijelentkezés + Login oldal**: branding, tab navigáció, elfelejtett jelszó link — OK.
  2. **Regisztráció**: Név/Email/Jelszó/Megerősítés form → "Ellenőrizd az e-mailedet" üzenet (`teszt@maestro.test`) — OK.
  3. **E-mail verifikáció**: Appwrite MCP `users_update_email_verification` → login sikeres — OK.
  4. **Onboarding**: "Teszt Kiadó" org + "Főszerkesztőség" office létrehozás, slug auto-generálás (`teszt-kiado`, `foszerkesztoseg`) → üres workspace redirect — OK. DB-ben 4 rekord (org + orgMembership(owner) + office + officeMembership(admin)) létrejött.
  5. **Üres workspace**: header (user név, jelszó módosítás link, kijelentkezés), sidebar (KIADVÁNYOK üres), 0 cikk — OK.
  6. **Elfelejtett jelszó**: form + "Ha létezik fiók..." visszaigazolás (biztonságos megfogalmazás) — OK. `/reset-password?userId=&secret=` route: Új jelszó + megerősítés form — OK.
  7. **Jelszó módosítás (bejelentkezett)**: 3 mezős form → zöld siker sáv "Jelszavad sikeresen módosítva." + "Vissza a Dashboardra" link — OK.
  8. **Meghívó flow**: invite rekord manuális létrehozás (Appwrite MCP) → `/invite?token=...` link → kijelentkezett user redirect → `/register` (token localStorage-ba mentve) → login `meghivott@maestro.test` → onboarding felismeri a tokent → "Meghívó elfogadása" gomb → workspace redirect — OK. DB: invite `status: "accepted"`, membership `role: "member"`, `addedByUserId` = meghívó userId.
  9. **Plugin bejelentkezés**: az auth infrastruktúra azonos (Appwrite SDK), InDesign-ben manuálisan ellenőrizhető.
- **Talált és javított UI bug**: az OnboardingRoute-on a "Inkább új szervezetet hozok létre" és "Kijelentkezés" gombok összefolytak (mindkettő `auth-link-button` class, padding/display nélkül). Javítás: `.auth-link-button { display: block; width: 100%; margin-top: 12px; text-align: center; }` a [css/styles.css](../../packages/maestro-dashboard/css/styles.css)-ben.
- **Teszt adat takarítás**: a két teszt user (`teszt@maestro.test`, `meghivott@maestro.test`) + a "Teszt Kiadó" org és kapcsolódó membership/office/invite rekordok Appwrite MCP-vel törölve.
- **Fázis 1 állapota**: **KÉSZ**. Minden checklist elem (`B.1`–`B.11`) pipálva. A Fázis térkép frissítve.
- **Érintett fájlok**:
  - **Módosítva**: [packages/maestro-dashboard/css/styles.css](../../packages/maestro-dashboard/css/styles.css) (`.auth-link-button` block layout fix), [_docs/Feladatok.md](../Feladatok.md) sor 49 (`[x]` B.10), ez a fájl.
- **Következő feladat**: Fázis 2 — Dinamikus csoportok (`groups`, `groupMemberships` collection-ök, Dashboard admin UI, Plugin `UserContext` átalakítás).

### 2026-04-09 — Fázis 2 kész (Dinamikus csoportok)

- Részletek: Fázis 2 checklist feljebb. A 7 fix Appwrite Team lecserélve `groups` + `groupMemberships` collection-ökre. Dashboard `/settings/groups` admin UI.
- **Következő feladat**: Fázis 3 — Dinamikus contributor mezők.

### 2026-04-09 — Fázis 3 kész (Dinamikus contributor mezők)

- **Cél**: a 7+7 hardkódolt contributor ID mező (`designerId`, `editorId`, `writerId`, `imageEditorId`, `artDirectorId`, `managingEditorId`, `proofwriterId` és `default*` megfelelőik) kiváltása egyetlen `contributors` (articles) és `defaultContributors` (publications) JSON longtext mezővel. A JSON kulcsa a csoport `slug`-ja (pl. `{"designers":"userId1","editors":"userId2"}`).
- **TEAM_ARTICLE_FIELD eliminálva**: a korábbi mapping (slug → article mező név) feleslegessé vált, mert a JSON kulcs közvetlenül a slug. A `CONFIG_VERSION` `'1.0.0'` → `'2.0.0'`-ra lépett.
- **Nincs adatmigráció**: a DB Fázis 1 B.9-ben wipe-olva volt (0 article, 0 publication).
- **Új fájlok**:
  - `maestro-shared/contributorHelpers.js` — pure utility: `parseContributors`, `getContributor`, `setContributor`, `isContributor` (plugin + dashboard + CF közös)
  - `maestro-indesign/src/data/hooks/useContributorGroups.js` — egyetlen hook 2 párhuzamos Appwrite query-vel (groups + groupMemberships), kiváltja a 7× `useGroupMembers` hívást a ContributorsSection-ökben. 5 perces modul-szintű cache, Realtime invalidálás.
- **Fő változások**:
  - Article + Publication `ContributorsSection.jsx` újraírva: dinamikus loop a `groups` tömb felett, `getContributor`/`setContributor` a JSON olvasás/íráshoz
  - `useArticles.js` `addArticle`: 7 soros default contributor másolás → egyetlen `contributors: pub?.defaultContributors ?? null`
  - `Publication.jsx`: `isContributor()` + `userSlugs` useMemo a "Saját cikkeim" szűrőhöz
  - `GeneralSection.jsx`: `getContributor()` a `hasRequiredContributor`-ban
  - `useElementPermission.js`: `useContributorPermissions(state, groupSlugs)` — kapott slug tömb felett iterál
  - Dashboard `useFilters.js`: `isContributor()` + `getUserGroupSlugs()`
  - 3 CF frissítve: JSON parse → kulcs iterálás → userId validáció
- **Appwrite séma**: `articles.contributors` + `publications.defaultContributors` hozzáadva, régi 14 mező törölve (MCP)
- **CF redeployment**: a 3 módosított CF (validate-article-creation, article-update-guard, validate-publication-update) újratelepítése szükséges az Appwrite Console-on/CLI-vel
- **Harden pass**:
  - MUST FIX: 6 hibás relative import (`"../../../../../maestro-shared/..."`) → bare specifier (`"maestro-shared/..."`) — webpack alias nem oldja fel a relative path-okat
  - SHOULD FIX: Dashboard `getUserGroupSlugs()` early return — capability label-ek kihagyódtak `user.groupSlugs` falsy esetén
  - Elutasítva (noise): CF group membership validáció (Fázis 6/7), JSON blob race condition (elfogadott trade-off), cache coherency (recovery + TTL), performance (cache), value type validáció (parseContributors check)
  - Verifikáció: clean (első körben), mindkét build (webpack + vite) sikeres
- **Következő feladat**: Fázis 4 — Workflow runtime (`workflows` collection, `compiled` JSON, Realtime hot-reload).

---

### Fázis 4 — Workflow Runtime (2026-04-09)
**Cél**: A hardkódolt workflow konstansokat (`workflowConfig.js`, `labelConfig.js`, `workflowConstants.js`, `elementPermissions.js`) egy DB-alapú, szerkesztőség-szintű `workflows` collection + `compiled` JSON váltja ki. A `state` mező `integer (0–7)` → `string` (pl. `"designing"`). A label rendszer megszűnik — `user.groupSlugs` az egyetlen jogosultsági forrás.

**Elvégzett feladatok:**
- [x] D.1 — `defaultWorkflow.json` létrehozása (8 állapotos compiled workflow)
- [x] D.2 — `workflowRuntime.js` létrehozása (16+ tiszta fogyasztói függvény)
- [x] D.3 — `commandRegistry.js` létrehozása (command ID → label mapping)
- [x] D.4 — `MARKERS` áthelyezése `maestro-shared/constants.js`-be
- [x] D.5 — Appwrite `workflows` collection létrehozása (MCP)
- [x] D.6 — CF `invite-to-organization` bővítés: workflow seeding
- [x] D.7 — Meglévő office workflow doc seeding (MCP)
- [x] D.8 — Article `state` migráció: integer → string (wipe + clean start, MCP)
- [x] D.9 — Plugin `DataContext`: `workflow` state + fetch + Realtime hot-reload
- [x] D.10 — Plugin `workflowEngine.js` átírás (workflow param proxy)
- [x] D.11 — Plugin `workflowPermissions.js` átírás (workflow param proxy)
- [x] D.12 — Plugin `useElementPermission.js` hook átírás (belső átírás, API megtartva)
- [x] D.13 — Plugin UI fogyasztók átírása (~10 fájl: FilterBar, WorkflowStatus, GeneralSection, PropertiesPanel, ArticleProperties, Publication, ArticleTable, usePublicationArchive, useFilters, useWorkflowValidation, StateComplianceValidator)
- [x] D.14 — Shared modul fogyasztók: urgency.js, pageGapUtils.js, useUrgency.js
- [x] D.15 — Dashboard DataContext + UI (workflow state + fetch + Realtime, FilterBar, ArticleRow, PageSlot, useFilters, config.js)
- [x] D.16 — CF-ek átírás (article-update-guard: teljes rewrite, validate-article-creation: loadValidStates átírás)
- [x] D.17 — validate-labels CF törlés + label rendszer eltávolítás
- [x] D.18 — Régi fájlok törlése: `workflowConfig.js`, `labelConfig.js`, `workflowConstants.js`, `elementPermissions.js`, `syncWorkflowConfig.js`, `validate-labels/`
- [x] D.19 — Dokumentáció frissítés (CLAUDE.md-k, PROGRESS.md, maestro-server/CLAUDE.md)
- [x] D.20 — Build verifikáció: mindkét build (webpack + vite) sikeres, 0 stale import (grep clean)

**Technikai részletek:**
- `workflowRuntime.js`: `getStateConfig`, `getAllStates`, `getAvailableTransitions`, `canUserMoveArticle`, `validateTransition`, `canEditElement`, `canRunCommand`, `canEditContributorDropdown`, `canUserAccessInState`, `hasCapability`, `getContributorGroups`, `isLeaderGroup`, `isInitialState`, `getInitialState`, `getStateLabel`, `getStateColor`, `getStateDuration`, `getStateValidations`, `isTerminalState`, `getStateCommands`
- CF process cache: 60s TTL (`getWorkflowForOffice()`), fail-closed (nincs workflow → state revert)
- Import konvenció: `"maestro-shared/..."` webpack alias (plugin), `@shared/...` vite alias (dashboard)
- **Appwrite Console tennivalók** (MCP-vel): `WORKFLOWS_COLLECTION_ID` env var hozzáadás a CF-ekhez, `CONFIG_COLLECTION_ID` env var törlés, `config` collection törlés, `validate-labels` CF disable/törlés

**Következő**: Fázis 5 — Dashboard Workflow Designer UI (ComfyUI-stílusú vizuális szerkesztő).
