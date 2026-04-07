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

**Fázis 1 — Scope bevezetés + teljes Dashboard auth flow** (folyamatban)

### Fázis 1 checklist (folyamatos)
- [x] B.1 — Appwrite collection setup (5 új + 6 meglévő scope mező)
- [x] B.2 — `appwriteIds.js` frissítés az 5 új COLLECTIONS konstanssal + `TEAMS` `@deprecated` JSDoc
- [x] B.3 — Dashboard `react-router-dom` + auth route skeleton (`ProtectedRoute`, `AuthSplitLayout`, `BrandHero`, 8 auth route, `ScopeContext`)
- [x] B.4 — Dashboard `AuthContext` bővítés + auth route-ok implementáció (register, verifyEmail, requestRecovery, confirmRecovery, updatePassword, fetchMemberships, reloadMemberships) — `acceptInvite` B.5-ig vár
- [ ] B.5 — Új Cloud Function-ök: `invite-to-organization`, `organization-membership-guard`
- [ ] B.6 — Plugin `appwriteConfig.js` `VERIFICATION_URL` + `RECOVERY_URL` átirányítás Dashboard domainre
- [ ] B.7 — Plugin `UserContext` + `DataContext` scope bevezetés (`organizations`, `editorialOffices`, `activeOrganizationId`, `activeEditorialOfficeId`, scope-szűrt fetch)
- [ ] B.8 — Meglévő CF-ek (`validate-article-creation`, `article-update-guard`, `validate-publication-update`) officeId scope kiterjesztés + `editorialOfficeMemberships` lookup
- [ ] B.9 — Teszt adat wipe
- [ ] B.10 — Manual happy path verifikáció

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
| 1 | Scope bevezetés + teljes Dashboard auth flow | `organizationId` + `editorialOfficeId` mindenhol, saját tagság collectionök, login/regisztráció/elfelejtett jelszó | **Folyamatban** (B.1–B.4 kész) |
| 2 | Dinamikus csoportok | A 7 fix Appwrite Team helyett saját `groups` + `groupMemberships` | Vár |
| 3 | Dinamikus contributor mezők | `articles.contributors: {slug: userId}` JSON a 7 hardkódolt oszlop helyett | Vár |
| 4 | Workflow runtime | `workflows` collection, `compiled` JSON, Realtime hot-reload, régi workflowConstants törlése | Vár |
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
- **Következő session feladata** (változatlan): B.5 — Új Cloud Function-ök (`invite-to-organization`, `organization-membership-guard`) létrehozása, telepítése és integrálása.
