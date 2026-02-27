# CLAUDE.md — Maestro Plugin Projekt Útmutató

> **Mindig olvasd el a `docs/` mappában lévő dokumentumokat is — részletes architektúrát és diagramokat tartalmaznak.**

---

## Parancsok

### Build & Futtatás
- **Build Production**: `npm run build` — Webpack production build → `dist/`
- **Watch Mode**: `npm run watch` — `yarn install && webpack --watch --mode development`
- **Start**: `npm start` — `yarn install && webpack`

### UXP Plugin Kezelés
- **Plugin betöltése**: `npm run uxp:load` — A `dist/` mappa betöltése InDesign-ba
- **Plugin újratöltése**: `npm run uxp:reload` — Aktív plugin újratöltése
- **Plugin debug**: `npm run uxp:debug` — UXP Developer Tool indítása

### Csomagkezelő
- **Yarn**-t használunk (`yarn.lock`). NPM script-ek indíthatók `npm run`-nal, de a dependency-ket `yarn`-nal kezeljük.

---

## Technológiai Stack

| Réteg         | Technológia                                                           |
| ------------- | --------------------------------------------------------------------- |
| **Platform**  | Adobe UXP (Unified Extensibility Platform) InDesign-hoz               |
| **UI**        | React 18 + Adobe Spectrum Web Components (`@swc-uxp-wrappers/*`)      |
| **Backend**   | Appwrite Cloud (Database, Realtime, Storage, Teams)                   |
| **Realtime**  | WebSocket proxy auth bridge-en keresztül (ld. `docs/REALTIME_ARCHITECTURE.md`) |
| **Bundler**   | Webpack 5 + Babel                                                     |
| **Stílusok**  | SCSS / CSS                                                            |
| **Externals** | `uxp`, `indesign`, `os` — futásidőben az InDesign biztosítja          |

---

## Kódstílus & Konvenciók

> **Részletes referencia**: `docs/NAMING_CONVENTIONS.md`
> **Hozzájárulási szabályzat**: `CONTRIBUTING.md`

### Általános Elvek
- **Világosság > Rövidség**: Explicit nevek a rövidítések helyett.
- **Kontextus-tudatosság**: Ne ismételd a kontextust a nevekben (`remove(button)` nem `removeElement(button)`).
- **Boolean elnevezés**: `is`, `has`, `can`, `should` prefixek.
- **Függvényelnevezés**:
    - Akciók (mellékhatással): Felszólító igék (`fetchUser`, `updateArticle`).
    - Transzformációk (tiszta): Főnévi kifejezések (`sortedList`, `formattedDate`).
    - Aszinkron: `fetch` (hálózat), `load` (memória), `sync` (szinkronizáció).
    - Callback-ek: `onDidFinishLoading`, `onWillSave`.

### React Specifikus
- **Komponensek**: PascalCase (`ArticleTable`, `PublicationList`).
- **Hook-ok**: camelCase, `use` prefix (`useArticles`, `useValidation`).
- **Props**: Cél szerint elnevezve, nem implementáció szerint (`onClick` vs `onLeftClick`).

### Komment Nyelv
- **Magyar**. JSDoc, inline kommentek és fájl-fejlécek mind magyarul.

### Hibakezelés
- `try/catch` aszinkron műveleteknél.
- Logolás a `logError` / `logWarning` segítségével (`src/core/utils/logger.js`).
- Hibaosztályozás az `isNetworkError` / `isAuthError` segítségével (`src/core/utils/errorUtils.js`).

### Importok
- Preferált a **named import**.
- **Relatív útvonalak** (`../../core/utils/logger.js`).
- **Import sorrend** (üres sorokkal elválasztva):
  1. Vendor / Framework (React, külső könyvtárak)
  2. Context-ek & Hook-ok
  3. Konfiguráció & Konstansok
  4. Segédfüggvények & Helperek
  5. Komponensek & Assetek

### Dokumentáció Karbantartás
- **Nagyobb átalakításoknál** (új feature, architektúra változás, viselkedésmódosítás) mindig frissítsd az érintett markdown fájlokat (`docs/`, `CLAUDE.md`, `CONTRIBUTING.md`) — **ugyanabban a commitban**.
- Ellenőrizd: `docs/diagrams/` diagramok, `CLAUDE.md` Architektúra Áttekintés, `docs/REALTIME_ARCHITECTURE.md` stb.

---

## Architektúra Áttekintés

### Alapfogalmak

1. **DataContext (Központi Adatkezelő)**
    - Központosított `publications[]`, `articles[]` és **`validations[]`** állapot.
    - **Aktív Kiadvány Hatókör**: Cikkeket és felhasználói validációkat *csak* az aktuálisan aktív kiadványhoz (`activePublicationId`) kér le.
    - REST API lekérés (kezdeti) + Appwrite Realtime (folyamatos szinkron).
    - **Write-through API**: A komponensek DataContext metódusokon keresztül írnak (`createArticle`, `updateArticle`, stb.), amelyek DB írást hajtanak végre → optimista helyi állapotfrissítés a szerver válaszával.
    - **`applyArticleUpdate(doc)`**: Külső írók (WorkflowEngine hívók) számára — szerver választ alkalmaz a helyi állapotra DB hívás nélkül.
    - **`$updatedAt` elavulás-védelem**: A Realtime handler kihagyja azokat az eseményeket, ahol a helyi adat frissebb, mint a bejövő payload (megakadályozza, hogy elavult WebSocket események felülírják az optimista frissítéseket).
    - **Stabil Realtime feliratkozás**: Ref-eket használ az `activePublicationId`-hoz és az `articles`-hoz, hogy ne iratkozzon újra fel állapotváltozáskor.
    - **Ref-alapú `fetchData`**: Az `activePublicationId`-t ref-ből olvassa (nem closure-ból) a stabil identitás érdekében; a kiadvány-váltó effect deps tartalmazza az `isInitialized`-t, hogy kezelje a versenyhelyzetet, amikor a PublicationList a pubId-t az kezdeti fetch befejezése előtt állítja be.
    - **Fetch generáció-számláló (`fetchGenerationRef`)**: Minden `fetchData` hívás kap egy sorszámot. Ha közben újabb hívás indul (pl. recovery + publication switch egyidejűleg), az elavult eredmény eldobódik — megelőzi a dupla fetch miatti UI ugrást és felesleges state felülírást.
    - **Kritikus vs. nem-kritikus adatlekérés**: A publications és articles `Promise.all`-lal futnak (ha elbuknak, a catch kezeli). A layouts és deadlines `Promise.allSettled`-del futnak — ha VPN-en timeout-olnak, a UI azonnal megjelenik a kritikus adatokkal, és toast figyelmeztet a hiányzó adatokról.
    - Ld. `docs/diagrams/data-flow-architecture.md`

2. **MaestroEvent Rendszer**
    - Window-alapú eseménybusz `CustomEvent` használatával laza csatoláshoz.
    - Az események megtörtént tényeket képviselnek (múlt idő). A handlerek döntik el, hogyan reagálnak.
    - Központi konfiguráció: `src/core/config/maestroEvents.js`
    - Ld. `docs/EVENT_ARCHITECTURE.md`

3. **LockManager**
    - Dokumentumzárolás kezelése (ki szerkeszt mit).
    - A DB zár **informatív** — a valódi fájlszintű zár az InDesign `.idlk` fájlja.
    - A `WorkflowEngine.lockDocument()` / `unlockDocument()` metódusokat használja → sima `updateRow` → Realtime.
    - **Kétfázisú unlock**: A `registerTask` minta lehetővé teszi, hogy a validátorok befejezzék a munkájukat a zárolás feloldása előtt.

4. **Validációs Rendszer**
    - **Egységes Architektúra**: Összefésüli a rendszer validációkat (Preflight, Overlap) és a felhasználói üzeneteket egyetlen listába.
    - **Felhasználói Validációk**: Közvetlenül a `DataContext` kezeli (DB-ből származnak), Realtime-on keresztül szinkronizálva.
    - **Rendszer Validációk**: A `ValidationContext` kezeli (memóriában, session-önként).
    - **Blokkolási Logika**: Bármely aktív `error` típusú elem blokkolja az állapotátmeneteket.
    - **Komponensek**: `ValidationSection.jsx` (UI), `useUnifiedValidation` (Logika), `ValidationContext` (Rendszeradatok).
    - **Mező-szintű Validáció**: `ValidatedTextField` `invalid` prop + validátor statikus metódusok (pl. `DeadlineValidator.isValidDate/isValidTime`, `isValidFileName`) — azonnali piros keret blur-kor, formátum-hibára. Fájlnév validáció: `\ / : * ? " < > |` tiltott karakterek + Windows fenntartott nevek (CON, PRN, AUX, NUL, COM1–9, LPT1–9) + pontra/szóközre végződő nevek tiltása.
    - **Dokumentáció**: `docs/VALIDATION_MECHANISM.md`
    - Ld. `docs/diagrams/data-flow-architecture.md`

5. **Jogosultsági Rendszer (Workflow Permissions)**
    - **Állapot-alapú**: Minden workflow állapothoz csapatok vannak rendelve (`STATE_PERMISSIONS`), amelyek mozgathatják a cikkeket onnan.
    - **Fallback**: Ha nincs senki hozzárendelve a releváns csapatok contributor mezőiből → csak a releváns csapatok tagjai mozgathatják (labels ellenőrzés).
    - **Label override**: Appwrite user `labels` tömb felülírja a jogosultságot (team slug = label).
    - **Háromszintű védelem**: UI gomb disabled → handler toast → engine guard.
    - **Konfiguráció**: `workflowConstants.js` (`STATE_PERMISSIONS`, `TEAM_ARTICLE_FIELD`), `workflowPermissions.js` (`canUserMoveArticle`).
    - Ld. `docs/WORKFLOW_PERMISSIONS.md`

6. **Kapcsolat-helyreállítás (RecoveryManager) & Dual-Proxy Failover**
    - **Dual-Proxy Architektúra**: Railway (primary, EU West Amsterdam, ~0.5s TTFB) + emago.hu (fallback, Apache/Passenger, 8-10s cold start). Független infrastruktúra → szinte nulla egyidejű kiesés esélye.
    - **EndpointManager** (`appwriteConfig.js`): Singleton, amely kezeli az aktív/fallback proxy endpoint váltást. `switchToFallback()`, `switchToPrimary()`, `switchToOther()` — automatikusan frissíti az Appwrite Client endpoint-ját. `endpointSwitched` MaestroEvent-et dispatch-el váltáskor → toast értesítés a UI-ban.
    - **Központi RecoveryManager** (`recoveryManager.js`): Egyetlen belépési pont az összes recovery trigger (online, sleep, focus, realtime disconnect) számára.
    - **Cascading Health Check**: (1) Aktív endpoint retry-okkal, (2) ha nem elérhető, másik endpoint egyetlen próbával, (3) ha a másik működik, átkapcsol. Fallback-en minden recovery-nél ellenőrzi: primary visszajött-e → automatikus visszakapcsolás.
    - Lock + debounce védelemmel a párhuzamos és gyors egymás utáni recovery kérések ellen.
    - **Debounce végponttól**: A `lastRecoveryAt` a recovery VÉGÉN is frissül (`finally` blokk), megakadályozva, hogy egy hosszú recovery lejárja a debounce-t.
    - **isReconnecting guard**: Nem indít újabb `reconnect()`-et, ha egy már folyamatban van.
    - Sorrend: health check → realtime reconnect → adat frissítés.
    - Sleep detection (InDesign `IdleTask` gap > 60s) → `recoveryManager.requestRecovery('sleep')`.
    - **Szinkron Resubscribe**: A `reconnect()` szinkron építi újra a feliratkozásokat (nincs `setTimeout`), megakadályozva az `isConnected` flag ideiglenesen hamis állapotát.
    - **Ghost Socket Védelem**: Socket generáció-számláló (`_socketGeneration`) a `realtimeClient.js`-ben. A close handler ignorálja a régi socket-ek close event-jeit, megakadályozva a végtelen reconnect ciklust.
    - **Dinamikus Csatorna-kezelés**: A `_subscribedChannels` Set nyomon követi az aktív socket csatornáit. Ha új csatorna érkezik (pl. az `account` a database channels után), a `createSocket` lezárja a régi socketet és újat hoz létre az összes csatornával. Ez megoldja az eltérő React render ciklusokból adódó subscription-sorrend problémát.
    - **Explicit Socket Cleanup**: A `reconnect()` metódus explicit `close(1000)` hívással zárja le a régi WebSocket-et az új létrehozása előtt.
    - **Dinamikus Endpoint (Realtime)**: A `realtimeClient.js` `_initClient()` metódusa `endpointManager.getEndpoint()`-ot használ → `reconnect()` automatikusan felveszi az aktuális (primary/fallback) endpoint-ot.
    - **Timeout ≠ Offline**: Az adatlekérés időtúllépése NEM aktiválja az offline overlay-t — toast figyelmeztetést kap a felhasználó. Csak valódi hálózati hibák (Failed to fetch, ECONNREFUSED stb.) váltják ki az offline állapotot.
    - **Overlay Cleanup**: A `DataContext.fetchData` finally blokkja mindig törli az `isConnecting` állapotot, ha nem mentünk offline-ba — megakadályozza az overlay beragadását.
    - **API Ellenállóképesség**: Centralizált `withRetry` segédfüggvény (`promiseUtils.js`) exponenciális backoff-fal (1s→2s→4s) az átmeneti szerverhibák (502, 503, 504) és hálózati hibák kezelésére.
    - **Szerverhiba Ellenállóképesség (Realtime)**: Speciális exponenciális backoff (5s→60s) + cooldown (5 hiba után 60s szünet) a Realtime WebSocket kapcsolatok védelmére.
    - **Proxy Server Keep-Alive**: A ProxyServer `server.js` TCP Keep-Alive (`keepAliveTimeout: 65s`) + 15s WebSocket ping frame-eket küld az aktív socket-ekre, megakadályozva az Apache/Passenger idle timeout-ot. EPIPE/ECONNRESET zajszűréssel és graceful shutdown-nal.
    - **Mappa-elérhetőség Polling**: A `Publication.jsx` kétszintű ellenőrzést végez a `rootPath` mappára: (1) egyszeri ellenőrzés mount-kor (összecsukott állapotban is, a fejléc színéhez), (2) folyamatos `setInterval` polling (2s, `DRIVE_CHECK_INTERVAL_MS`) a kinyitott (`isExpanded`) kiadványnál. A fejléc (név + chevron) kék (`--spectrum-global-color-blue-400`) alapállapotban, piros (`--spectrum-global-color-red-400`) ha a mappa nem elérhető. Kinyitott állapotban piros figyelmeztető banner jelenik meg. A banner szövege lefedi a törölt mappa és a nem csatlakoztatott meghajtó esetét is.
    - Ld. `docs/diagrams/network-architecture.md`, `docs/REALTIME_ARCHITECTURE.md`, `docs/PROXY_SERVER.md`

---

## Projektstruktúra

```text
Maestro/
├── CLAUDE.md                     ← Ez a fájl
├── CONTRIBUTING.md               ← Fejlesztési szabványok, komment nyelv, PR szabályzat
├── README.md                     ← Általános áttekintés & telepítés
├── manifest.json                 ← UXP plugin manifest (ID: com.sashalmiimre.maestro)
├── package.json                  ← Függőségek & scriptek (Yarn)
├── webpack.config.js             ← Webpack 5 konfig (entry: src/core/index.jsx → dist/bundle.js)
│
├── docs/                         ← Architektúra dokumentáció (ld. §Dokumentáció Katalógus)
│   ├── NAMING_CONVENTIONS.md
│   ├── EVENT_ARCHITECTURE.md
│   ├── REALTIME_ARCHITECTURE.md
│   ├── WORKFLOW_PERMISSIONS.md
│   ├── URGENCY_SYSTEM.md
│   ├── PROXY_SERVER.md
│   └── diagrams/
│       ├── data-flow-architecture.md
│       ├── open-file-flow.md
│       └── network-architecture.md
│
├── src/
│   ├── index.html                ← HTML belépési pont
│   ├── index.css                 ← Globális stílusok
│   ├── polyfill.js               ← UXP polyfill-ek
│   │
│   ├── core/                     ← Üzleti logika & infrastruktúra
│   │   ├── index.jsx             ← App bootstrap, belépési pont, hamburgermenü handlerek (jelszókezelés, kijelentkezés)
│   │   ├── Main.jsx              ← Gyökér komponens (sleep/focus detektálás, RecoveryManager trigger)
│   │   ├── config/
│   │   │   ├── appwriteConfig.js       ← Appwrite kliens, EndpointManager (dual-proxy), db/collection/bucket ID-k, VERIFICATION_URL, RECOVERY_URL
│   │   │   ├── realtimeClient.js       ← WebSocket kliens proxy auth injection-nel
│   │   │   ├── recoveryManager.js      ← Központi recovery orchestrator (health check, reconnect, refresh)
│   │   │   └── maestroEvents.js        ← MaestroEvent konstansok & dispatchMaestroEvent()
│   │   ├── contexts/
│   │   │   ├── DataContext.jsx         ← Kiadványok & cikkek állapota + Realtime szinkron
│   │   │   ├── ValidationContext.jsx   ← Validációs eredmények (cikk- és kiadvány-szintű)
│   │   │   ├── UserContext.jsx         ← Auth állapot, bejelentkezés/kijelentkezés/regisztráció, session kezelés
│   │   │   └── ConnectionContext.jsx   ← Online/offline/connecting állapot UI visszajelzéshez
│   │   ├── controllers/
│   │   │   └── panelController.jsx     ← UXP panel életciklus (megjelenítés/elrejtés)
│   │   ├── commands/
│   │   │   ├── index.js                ← Parancs-regiszter
│   │   │   └── handlers/               ← InDesign parancs handlerek
│   │   │       ├── collectImages.js    ← Képgyűjtés
│   │   │       ├── exportPdf.js        ← PDF export (preset támogatással)
│   │   │       ├── preflightCheck.js   ← Kézi preflight trigger
│   │   │       ├── archiving.js        ← Archiválás parancs
│   │   │       └── printing.js         ← Nyomtatás parancs
│   │   └── utils/
│   │       ├── logger.js               ← logInfo, logWarning, logError, logDebug
│   │       ├── errorUtils.js           ← Hibaosztályozás (Hálózati, Auth, stb.)
│   │       ├── constants.js            ← Alkalmazás-szintű konstansok
│   │       ├── messageConstants.js     ← Felhasználónak megjelenő üzenet stringek
│   │       ├── pathUtils.js            ← Fájlútvonal segédfüggvények (UXP ↔ InDesign leképezés)
│   │       ├── namingUtils.js          ← Név formázó helperek
│   │       ├── promiseUtils.js         ← Promise segédfüggvények (withTimeout, withRetry)
│   │       ├── urgencyUtils.js         ← Sürgősség-számítás (munkaidő, ünnepnapok, ratio, színek)
│   │       ├── validationRunner.js     ← Validátor futtatás orchestrálása
│   │       ├── validators/             ← Tiszta validációs logika osztályok
│   │       │   ├── ValidatorBase.js
│   │       │   ├── DatabaseIntegrityValidator.js
│   │       │   ├── FileSystemValidator.js
│   │       │   ├── PreflightValidator.js
│   │       │   ├── PublicationStructureValidator.js
│   │       │   ├── StateComplianceValidator.js
│   │       │   ├── DeadlineValidator.js
│   │       │   └── index.js
│   │       ├── indesign/               ← ExtendScript generálás & InDesign segédfüggvények
│   │       │   ├── indesignUtils.js    ← Script futtatás, dokumentum műveletek
│   │       │   ├── documentScripts.js  ← Dokumentum-szintű ExtendScript generátorok
│   │       │   ├── exportScripts.js    ← PDF/nyomtatás export scriptek
│   │       │   ├── preflightScripts.js ← Preflight ellenőrzés scriptek
│   │       │   ├── scriptHelpers.js    ← Közös script építőelemek
│   │       │   └── index.js
│   │       └── workflow/                  ← Cikk állapotgép
│   │           ├── workflowConstants.js   ← Állapotok, átmenetek, jogosultságok, STATE_PERMISSIONS
│   │           ├── workflowEngine.js      ← executeTransition, lockDocument, unlockDocument
│   │           ├── workflowPermissions.js ← canUserMoveArticle, hasTransitionPermission
│   │           └── index.js
│   │
│   ├── data/                     ← Adat hook-ok réteg (Context ↔ UI híd)
│   │   └── hooks/
│   │       ├── useArticles.js                   ← CRUD + megnyitás/bezárás + szűrés kiadvány szerint
│   │       ├── usePublications.js               ← CRUD + lefedettség kezelés
│   │       ├── useTeamMembers.js                ← Csapattagok listázása
│   │       ├── useUserValidations.js            ← Felhasználói validációs üzenetek CRUD
│   │       ├── useUnifiedValidation.js          ← Rendszer + felhasználói validációk összefésülése
│   │       ├── useWorkflowValidation.js         ← Preflight + workflow validáció (esemény-vezérelt)
│   │       ├── useDatabaseIntegrityValidation.js ← DB integritás esemény-feliratkozó hook
│   │       ├── useOverlapValidation.js          ← Átfedés detektálás esemény-feliratkozó hook
│   │       ├── useDeadlines.js                  ← Határidők CRUD
│   │       ├── useLayouts.js                    ← Layoutok CRUD + layoutChanged esemény
│   │       └── useUrgency.js                    ← Sürgősség-számítás hook (percenkénti frissítés)
│   │
│   ├── ui/                       ← React Komponensek
│   │   ├── common/               ← Újrafelhasználható UI elemek
│   │   │   ├── CollapsibleSection.jsx
│   │   │   ├── ConfirmDialog.jsx
│   │   │   ├── CustomCheckbox.jsx
│   │   │   ├── CustomDropdown.jsx
│   │   │   ├── ValidatedTextField.jsx
│   │   │   ├── Loading/
│   │   │   ├── Table/            ← CustomTable (átméretezhető oszlopok, rendezés)
│   │   │   └── Toast/            ← Toast értesítési rendszer
│   │   └── features/             ← Szakterület-specifikus komponensek
│   │       ├── articles/
│   │       │   ├── ArticleTable.jsx
│   │       │   └── ArticleProperties/   ← Cikk részletes szerkesztő panel
│   │       │       ├── ArticleProperties.jsx
│   │       │       ├── GeneralSection.jsx
│   │       │       ├── ContributorsSection.jsx
│   │       │       └── ValidationSection.jsx
│   │       ├── publications/
│   │       │   ├── PublicationList.jsx
│   │       │   ├── PublicationListToolbar.jsx
│   │       │   ├── Publication/         ← Egyetlen kiadvány nézet
│   │       │   │   ├── Publication.jsx
│   │       │   │   ├── FilterBar.jsx    ← Cikkszűrés (állapot, layout, marker)
│   │       │   │   └── WorkflowStatus.jsx
│   │       │   └── PublicationProperties/
│   │       │       ├── PublicationProperties.jsx
│   │       │       ├── GeneralSection.jsx
│   │       │       ├── LayoutsSection.jsx
│   │       │       └── DeadlinesSection.jsx
│   │       ├── workspace/
│   │       │   ├── Workspace.jsx        ← Fő munkaterület konténer
│   │       │   ├── DocumentMonitor.jsx  ← InDesign dokumentum életciklus figyelő
│   │       │   ├── LockManager.jsx      ← Dokumentumzárolás kezelő UI
│   │       │   └── PropertiesPanel/     ← Jobb oldali tulajdonságok panel
│   │       └── user/
│   │           ├── Login/               ← Bejelentkezés UI
│   │           └── Register/            ← Regisztráció UI (email verifikációval)
│   │
│   └── assets/                   ← Statikus erőforrások (ikonok, stb.)
│
└── appwrite_functions/           ← Szerver-oldali Appwrite Cloud Funkciók
    ├── delete-article-messages/  ← Cikk üzenetek takarító funkció
    └── team/                     ← Csapat kezelő funkciók
```

---

## Kulcs Munkafolyamatok

### Fájl Megnyitás
`ArticleTable` (dupla kattintás) → `Publication.onOpen` → `useArticles.openArticle` → `app.open()` (UXP) → `LockManager` észleli & zárolja → Realtime → UI frissül.

> Részletes diagram: `docs/diagrams/open-file-flow.md`

### Fájl Mentés
InDesign `afterSave` → `DocumentMonitor` → `dispatch(documentSaved)` → Validátorok futnak (Preflight, DB Integritás) → automatikus javítás ha szükséges → `dispatch(pageRangesChanged)` → Átfedés ellenőrzés.

> Részletes diagram: `docs/EVENT_ARCHITECTURE.md` (Validációs Hurok)

### Cikk Átnevezés
- **Validáció**: `isValidFileName()` ellenőrzi a tiltott karaktereket (`\ / : * ? " < > |`), Windows fenntartott neveket (CON, PRN stb.), pontra/szóközre végződő neveket, lock ellenőrzés (más felhasználó szerkeszti-e).
- **Zárt dokumentum**: `GeneralSection` → `handleFieldUpdate("name")` → `useArticles.renameArticle` → `generateRenameFileScript()` (ExtendScript `File.rename`) → DB update.
- **Nyitott dokumentum**: `generateRenameOpenDocumentScript()` → dokumentum keresése `fullName` útvonal alapján (fallback: `name`) → `doc.save(newFile)` (Save As) → régi fájl törlése (hibakezeléssel) → DB update. A `maestroSkipMonitor` flag megakadályozza, hogy a DocumentMonitor reagáljon a programozott mentésre.
- **Rollback**: Ha a DB frissítés sikertelen, a fájl visszanevezése automatikus.

### Realtime Adatfolyam
Appwrite DB változás → WebSocket esemény → `realtimeClient.js` → `DataContext` handler → `setArticles()`/`setPublications()` → React újra-renderelési kaszkád.

> Részletes diagram: `docs/diagrams/data-flow-architecture.md`

### Kapcsolat-helyreállítás (Sleep/Wake)
- Alvás észlelve (gap > 60s) → kapcsolat állapot ellenőrzése.
- Ha megszakadt: Appwrite kliens megsemmisítése → új példány létrehozása → újrafeliratkozás → `dataRefreshRequested` esemény → teljes adat lekérés.
- Ha él a kapcsolat: csak `dataRefreshRequested` esemény dispatch-elése (nincs WebSocket leépítés).

> Részletes diagram: `docs/diagrams/network-architecture.md`

---

## Dokumentáció Katalógus

| Fájl                                      | Tartalom                                                            |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `docs/NAMING_CONVENTIONS.md`              | Elnevezési konvenciók (Swift API Design Guidelines adaptálva JS-re) |
| `docs/EVENT_ARCHITECTURE.md`              | MaestroEvent rendszer, esemény katalógus, szekvencia diagramok      |
| `docs/REALTIME_ARCHITECTURE.md`           | WebSocket proxy auth bridge (UXP limitációk megoldása)              |
| `docs/PROXY_SERVER.md`                    | Reverse proxy szerver: auth injection, WS ping, hibakezelés         |
| `docs/diagrams/data-flow-architecture.md` | Teljes adatáramlás: Context + Event + komponens hierarchia          |
| `docs/diagrams/open-file-flow.md`         | Fájl megnyitás lépésről lépésre (kattintástól a UI frissülésig)     |
| `docs/diagrams/network-architecture.md`   | Hálózati kapcsolatkezelés, sleep recovery, auto-retry               |
| `docs/WORKFLOW_CONFIGURATION.md`          | Munkafolyamat konfiguráció, állapotátmenetek és validációs szabályok |
| `docs/WORKFLOW_PERMISSIONS.md`            | Jogosultsági rendszer: csapat-alapú állapotátmenet-védelem          |
| `docs/URGENCY_SYSTEM.md`                  | Sürgősség-számítás: munkaidő, ünnepnapok, ratio, progresszív sáv   |
| `docs/VALIDATION_MECHANISM.md`            | Egységes validációs és üzenetküldő rendszer működése                |
| `CONTRIBUTING.md`                         | Fejlesztési szabályok, JSDoc policy, import sorrend, PR workflow    |

---

## Context Provider-ek (Hierarchia)

```text
index.jsx
  └─ UserProvider          ← Auth állapot, bejelentkezés/kijelentkezés, session megőrzés
       └─ ConnectionProvider  ← Online/offline/connecting UI állapot
            └─ DataProvider       ← publications[], articles[], fetchData()
                 └─ ValidationProvider  ← validationResults Map
                      └─ ToastProvider       ← Toast értesítések
                           └─ Main.jsx       ← Sleep detektálás, retry logika, routing
```

### DataContext API
- `publications`, `articles`, `validations` — az adat tömbök
- `activePublicationId` — az aktuálisan kiválasztott kiadvány ID-ja
- `setActivePublicationId(id)` — Kontextust vált és adat lekérést indít
- `isLoading`, `isSwitchingPublication` — betöltési állapot
- `fetchData(isBackground)` — REST API lekérés (inicializáláskor & újracsatlakozáskor)
- **Write-Through — Kiadványok**: `createPublication(data)`, `updatePublication(id, data)`, `deletePublication(id)`
- **Write-Through — Cikkek**: `createArticle(data)`, `updateArticle(id, data)`, `deleteArticle(id)`
- **Write-Through — Validációk**: `createValidation(data)`, `updateValidation(id, data)`, `deleteValidation(id)`
- **Apply-Optimistic**: `applyArticleUpdate(serverDocument)` — külső írók (WorkflowEngine hívók) számára
- A Realtime handler automatikusan frissíti az állapotot WebSocket eseményekből `$updatedAt` elavulás-védelemmel

### UserContext API
- `user` — aktuális felhasználó objektum (vagy `null`)
- `login(email, password)`, `logout()`, `register(name, email, password)`
- `loading` — hitelesítés folyamatban
- **Regisztráció**: `register()` fiókot hoz létre → ideiglenes bejelentkezés → `account.createVerification(VERIFICATION_URL)` → kijelentkezés. A felhasználó NEM léphet be, amíg az email nincs megerősítve (`emailVerification` flag ellenőrzés a login-ban).
- **Jelszókezelés** (hamburgermenü, `index.jsx`-ben, React kontextuson kívül):
  - **Jelszó módosítás**: InDesign natív dialog → `account.updatePassword()` — bejelentkezést igényel.
  - **Elfelejtett jelszó**: InDesign natív dialog (email) → `account.createRecovery(email, RECOVERY_URL)` → proxy `/reset-password` oldal a böngészőben.
- **Realtime szinkron**: Az Appwrite Realtime `account` csatornára feliratkozva a `user` objektum (beleértve `labels`, `name`, `prefs`) automatikusan frissül, ha a szerveren módosítják (Console/Server SDK)
- **Recovery szinkron**: A `dataRefreshRequested` MaestroEvent-re is feliratkozik — minden recovery-nél (sleep/wake, reconnect, focus) `account.get()`-tel frissíti a user adatokat. Ez biztosítja a labels/prefs szinkront akkor is, ha az Appwrite Realtime `account` csatorna nem tüzel proxy-n keresztül (pl. szerver-oldali label módosításnál).

### ConnectionContext API
- `isOnline`, `isConnecting` — UI indikátorokhoz (spinner, overlay)

### ValidationContext API
- `getArticleValidation(articleId)`, `getPublicationValidation(pubId)`
- `updateArticleValidation(articleId, results)`, `updatePublicationValidation(pubId, results)`

---

## Appwrite Konfiguráció

### Végpontok & ID-k
A konfigurációs konstansok: `src/core/config/appwriteConfig.js`

- **Endpoint**: Dual-proxy failover-rel (`EndpointManager`): Railway (primary) → emago.hu (fallback). Mindig `endpointManager.getEndpoint()`-ot használj az aktuális endpoint lekéréséhez — a korábbi `APPWRITE_ENDPOINT` statikus export el lett távolítva.
- **Project ID**, **Database ID**, **Collection ID-k** (Articles, Publications, Messages), **Bucket ID** (Storage).
- **Team ID-k**: Team-alapú hozzáférés-kezelés és jogosultságkezelés. Csapatok: `editors`, `designers`, `writers`, `image_editors`, `art_directors`, `managing_editors`, `proofwriters`.

### Session Kezelés (UXP Sajátosság)
A UXP nem kezeli normálisan a cookie-kat. A session a `localStorage`-ban van tárolva (`cookieFallback` kulcs), és kézzel injektáljuk a requestekbe. Ld. `docs/REALTIME_ARCHITECTURE.md`.

---

## UXP Platform Sajátosságok

> Ezek a specialitások a UXP (nem böngésző!) környezetből adódnak.

1. **Nincs szabványos Cookie kezelés** — A session-ök `localStorage`-ban tárolódnak, kézzel injektálva.
2. **WebSocket nem támogat custom headereket** — Auth URL query paramétereken + proxy injection-ön keresztül (`onProxyReq` HTTP-hez, `onProxyReqWs` WebSocket upgrade-hez). Kliens-oldali `readyState` guard védi a UXP timing problémáktól.
3. **Nincs `window.location`** — Nem böngésző, nincs URL sáv.
4. **`uxp` és `indesign` externals** — Webpack externals-ként vannak konfigurálva, futásidőben az InDesign biztosítja.
5. **ExtendScript bridge** — InDesign scriptelés CEP/ExtendScript-en keresztül, string-ként generált scriptek (`src/core/utils/indesign/`).
6. **Plugin izoláció** — Minden plugin saját `window`-ot kap (MaestroEvent rendszer ezért biztonságos).
7. **InDesign `.idlk` fájlok** — Az igazi fájlzár, a DB lock csak informatív.
8. **Panel megjelenítés/elrejtés életciklus** — `panelController.jsx` kezeli, `panelShown` event-tel jelzi.

---

## Debug Tippek

- **UXP Developer Tool**: `npm run uxp:debug` — Console, Network, React DevTools.
- **Logger**: `src/core/utils/logger.js` — `logInfo()`, `logWarning()`, `logError()`, `logDebug()`. Kimenet a UXP DevTool console-ban.
- **Realtime hibakeresés**: A proxy logokban `[WS Proxy Error]` és `[HTTP Proxy Error]` üzenetek jelzik a valódi hibákat (EPIPE/ECONNRESET automatikusan szűrve). `[Auth Inject Error]` jelzi a cookie injection problémákat. Ld. `docs/PROXY_SERVER.md`.
- **Webpack source map-ek**: `eval-cheap-source-map` (development mode) — gyors rebuild, debugolható.
