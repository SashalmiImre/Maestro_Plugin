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
| **Backend**   | Appwrite Cloud (Database, Realtime, Storage, Groups)                  |
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
- Logolás a `log` / `logError` / `logWarn` / `logDebug` segítségével (`src/core/utils/logger.js`). Közvetlen `console.*` hívások **tilosak** — mindig a logger-t használjuk.
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
    - **Aktivált kiadvány szűrés (Fázis 5)**: A Plugin kizárólag `isActivated === true` publikációkat lát — a `fetchData` query-ben `Query.equal('isActivated', true)` feltétel, a Realtime handler pedig `.create`/`.update` eseményeknél ellenőrzi a `payload.isActivated === true`-t (különben skip/eltávolít a listából). Ha a deaktivált/törölt publikáció éppen az aktív, az `activePublicationId` és a derived state (`articles`/`layouts`/`deadlines`/`validations`) azonnal törlődik. A publikáció létrehozás Fázis 4-től a Dashboard hatásköre — a Plugin csak aktivált rekordokkal dolgozik.
    - **Aktív Kiadvány Hatókör**: Cikkeket és felhasználói validációkat *csak* az aktuálisan aktív kiadványhoz (`activePublicationId`) kér le.
    - REST API lekérés (kezdeti) + Appwrite Realtime (folyamatos szinkron).
    - **Write-through API (szűk hatókör, Fázis 9)**: A Plugin csak `articles` és `userValidations` rekordokba ír (`createArticle`, `updateArticle`, `deleteArticle`, `createValidation`, stb.) — optimista helyi állapotfrissítés a szerver válaszával. A `publications`, `layouts`, `deadlines` collection-ökbe NEM ír (ezeket a Dashboard szerkeszti; a Plugin kizárólag olvassa Realtime szinkron + `fetchData` útján). A „Megnyitás a Dashboardon" hover ikon és a publikáció fejléc dupla kattintás a böngészőben nyitja meg a Dashboardot JWT auto-loginnal (ld. `Workspace.handleOpenDashboard(pubId)`).
    - **Realtime `layoutChanged` dispatch**: A layouts Realtime handler minden `.create`/`.update`/`.delete` esemény után dispatcheli a `MaestroEvent.layoutChanged`-et, hogy a Dashboard-oldali layout módosítások is triggereljék a Plugin `useOverlapValidation` újraszámítását. A hook oldalán per-publikáció 250 ms debounce (`layoutChangedTimersRef` Map) összevonja a Dashboard bulk layout műveletek (pl. kötegelt törlés) Realtime burst-jét egyetlen overlap-revalidációs futtatásba.
    - **Realtime `publicationCoverageChanged` dispatch**: A publications Realtime `.update` handler a `setPublications` ELŐTT (a `latestPublicationsRef`-ből olvasva) ellenőrzi, hogy a `coverageStart`/`coverageEnd` mezők módosultak-e, és csak akkor dispatcheli a `MaestroEvent.publicationCoverageChanged`-et a teljes payload-dal (`{ publication }`), ha (a) a publikáció az aktív, (b) nem stale, (c) tényleg változott a coverage. Ez triggereli a `useOverlapValidation` per-cikk újraszámítását Dashboard-oldali coverage szűkítés után.
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
    - **Optimistic SYSTEM lock**: A `DocumentMonitor.verifyDocumentInBackground()` a DB `lockDocument` hívás ELŐTT azonnal beállítja a SYSTEM lockot a helyi state-ben (`applyArticleUpdate`), így a „MAESTRO" felirat azonnal megjelenik az ArticleTable-ben. Ha a DB lock sikertelen, a `finally` blokk visszavonja az optimistic update-et.

4. **Validációs Rendszer**
    - **Egységes Architektúra**: Összefésüli a rendszer validációkat (Preflight, Overlap) és a felhasználói üzeneteket egyetlen listába.
    - **Felhasználói Validációk**: Közvetlenül a `DataContext` kezeli (DB-ből származnak), Realtime-on keresztül szinkronizálva.
    - **Rendszer Validációk**: A `ValidationContext` kezeli (memóriában, session-önként).
    - **Állapotátmenet-validáció**: A `StateComplianceValidator` koordinálja az összes állapotváltási ellenőrzést (`file_accessible`, `page_number_check`, `filename_verification`, `preflight_check`) a `workflow.validations[state]` `requiredToEnter`/`requiredToExit` alapján. A `WorkflowEngine.validateTransition()` delegál a `validationRunner.validate()` → `StateComplianceValidator` láncon keresztül.
    - **Struktúra Validáció (PublicationStructureValidator)**: Bounds check (`getEffectivePageRange()` — `startPage`/`endPage` + `pageRanges` JSON fallback) és overlap detektálás (`getOccupiedPages()` — layout-alapú csoportosítás). A `validatePerArticle()` per-cikk eredményeket ad vissza (deduplikált párok `reportedPairs` Set-tel). A `useOverlapValidation` hook az `articlesAdded` event payload-ból merge-öli az új cikkeket a ref-elt állapottal (React state batching megkerülése).
    - **Blokkolási Logika**: Bármely aktív `error` típusú elem blokkolja az állapotátmeneteket.
    - **Komponensek**: `ValidationSection.jsx` (UI), `useUnifiedValidation` (Logika), `ValidationContext` (Rendszeradatok).
    - **Mező-szintű Validáció**: `ValidatedTextField` `invalid` prop + validátor statikus metódusok (pl. `isValidFileName`) — azonnali piros keret blur-kor, formátum-hibára. Fájlnév validáció: `\ / : * ? " < > |` tiltott karakterek + Windows fenntartott nevek (CON, PRN, AUX, NUL, COM1–9, LPT1–9) + pontra/szóközre végződő nevek tiltása. (A határidő mezőket Fázis 9 óta a Dashboard szerkeszti — a plugin-oldali `DeadlineValidator` megszűnt.)
    - **Dokumentáció**: `docs/VALIDATION_MECHANISM.md`
    - Ld. `docs/diagrams/data-flow-architecture.md`

5. **Jogosultsági Rendszer (Workflow Permissions)**
    - **Dinamikus, DB-alapú konfiguráció**: A teljes workflow (állapotok, átmenetek, jogosultságok, elem-engedélyek) a `workflows` collection `compiled` JSON-jából származik, szerkesztőség-szinten (per editorial office). A `workflowRuntime.js` (maestro-shared) 16+ tiszta függvénye az egyetlen interfész a compiled adathoz.
    - **Állapot-alapú átmenet**: Minden workflow állapothoz csoportok vannak rendelve (`compiled.statePermissions`), amelyek mozgathatják a cikkeket onnan. Az állapot ID-k stringek (pl. `"designing"`, `"editing"`).
    - **Csoporttagság-alapú jogosultság**: A `user.groupSlugs` (a `groupMemberships` + `groups` collection query-ből) az egyetlen jogosultsági forrás. A korábbi `user.labels` / capability label rendszer megszűnt.
    - **Vezető csoportok bypass**: A `compiled.leaderGroups` (pl. `["managing_editors", "art_directors"]`) minden ACL ellenőrzést megkerülnek — állapottól és hozzárendeléstől függetlenül mozgathatnak, szerkeszthetnek.
    - **Háromszintű védelem**: UI gomb disabled → handler toast → engine guard → CF server-side guard.
    - **Realtime szinkron**: A `groupMemberships` Realtime csatorna → `groupMembershipChanged` MaestroEvent → UserContext frissíti a `user.groupSlugs`-t → UI azonnal reagál. Scope-váltáskor a `scopeChanged` MaestroEvent szintén triggereli a `refreshGroupSlugs()`-t.
    - **Workflow hot-reload**: A `workflows` collection Realtime csatorna → `DataContext` `setWorkflow()` → minden fogyasztó azonnal az új konfigurációt használja.
    - **UI Elem Jogosultságok**: A `compiled.elementPermissions` határozza meg, mely csoportok szerkeszthetik az egyes UI elemcsoportokat. A `workflowRuntime.canEditElement()` és `canUserAccessInState()` függvények ellenőrzik.
      - `useElementPermission(key)` / `useElementPermissions(keys[])` / `useContributorPermissions(articleState)` hookok (`useElementPermission.js`) — React komponensekben, változatlan publikus API.
      - **Kompozíció**: `disabled={isIgnored || isSyncing || !perm.allowed}` + tooltip a `reason`-nel.
    - **Konfiguráció**: `workflowRuntime.js` (fogyasztói API), `workflowPermissions.js` (plugin proxy), `workflowEngine.js` (átmenet végrehajtás).
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
    - **Plugin Graceful Shutdown**: Az `index.jsx` `window.unload` eseményre iratkozik fel (az UXP `plugin.destroy()` hook nem mindig fut le, pl. InDesign kilépéskor). Shutdown-kor `recoveryManager.cancel()` → `realtime.disconnect()` sorrendben fut — megelőzi, hogy in-flight recovery egy már leállított kontextusban hozzon létre új WebSocket-et (crash). Az `_isCleanedUp` flag biztosítja, hogy a cleanup csak egyszer fusson le.
    - **Startup Error Capture**: Az `index.jsx` modul-szinten (React init előtt) regisztrál `error` és `unhandledrejection` listenereket. Az előző munkamenet esetleges összeomlásának részleteit localStorage-ba menti (`maestro.lastError`, `maestro.lastRejection`), és induláskor konzolra írja, majd törli.
    - **Recovery Cancellation**: A `RecoveryManager.cancel()` beállítja a `_isCancelled` flag-et, amely in-flight `_executeRecovery()` futást is leállít (health check await után ellenőrzött). Az aktív HTTP fetch kérések `AbortController`-eken keresztül (`_activeControllers` Set) azonnal megszakíthatók. Retry delay Promise-ok szintén megszakíthatók a `_retryReject` függvényen keresztül.
    - **Ghost Socket Védelem**: Socket generáció-számláló (`_socketGeneration`) a `realtimeClient.js`-ben. A close handler ignorálja a régi socket-ek close event-jeit, megakadályozva a végtelen reconnect ciklust.
    - **WebSocket 1001 (Going Away)**: Az alkalmazás/böngésző bezárásakor küldött 1001 close code-ot a close handler felismeri és nem indít reconnect-et (szemben az 1000-es normál lezárással, ahol a `realtime.reconnect` flag marad).
    - **Dinamikus Csatorna-kezelés**: A `_subscribedChannels` Set nyomon követi az aktív socket csatornáit. Ha új csatorna érkezik (pl. az `account` a database channels után), a `createSocket` lezárja a régi socketet és újat hoz létre az összes csatornával. Ez megoldja az eltérő React render ciklusokból adódó subscription-sorrend problémát.
    - **Explicit Socket Cleanup**: A `reconnect()` metódus explicit `close(1000)` hívással zárja le a régi WebSocket-et az új létrehozása előtt.
    - **Dinamikus Endpoint (Realtime)**: A `realtimeClient.js` `_initClient()` metódusa `endpointManager.getEndpoint()`-ot használ → `reconnect()` automatikusan felveszi az aktuális (primary/fallback) endpoint-ot.
    - **Timeout ≠ Offline**: Az adatlekérés időtúllépése NEM aktiválja az offline overlay-t — toast figyelmeztetést kap a felhasználó. Csak valódi hálózati hibák (Failed to fetch, ECONNREFUSED stb.) váltják ki az offline állapotot.
    - **Overlay Cleanup**: A `DataContext.fetchData` finally blokkja mindig törli az `isConnecting` állapotot, ha nem mentünk offline-ba — megakadályozza az overlay beragadását.
    - **API Ellenállóképesség**: Centralizált `withRetry` segédfüggvény (`promiseUtils.js`) exponenciális backoff-fal (1s→2s→4s) az átmeneti szerverhibák (502, 503, 504) és hálózati hibák kezelésére.
    - **Szerverhiba Ellenállóképesség (Realtime)**: Speciális exponenciális backoff (5s→60s) + cooldown (5 hiba után 60s szünet) a Realtime WebSocket kapcsolatok védelmére.
    - **Proxy Server Keep-Alive**: A ProxyServer `server.js` TCP Keep-Alive (`keepAliveTimeout: 65s`) + 15s WebSocket ping frame-eket küld az aktív socket-ekre, megakadályozva az Apache/Passenger idle timeout-ot. EPIPE/ECONNRESET zajszűréssel és graceful shutdown-nal.
    - **Mappa-elérhetőség Polling**: A `useDriveAccessibility` hook (Workspace szinten) központilag ellenőrzi az összes kiadvány `rootPath` mappáját. Egyetlen batched ExtendScript hívást használ ciklusonként (`checkPathsAccessibleBatch()` — N mappa → 1 `doScript`), minimalizálva az InDesign blokkolást. Folyamatos `setInterval` polling (2s, `DRIVE_CHECK_INTERVAL_MS`) + `focus`/`panelShown`/`dataRefreshRequested` event listenerek. A `Publication.jsx` prop-ként (`isDriveAccessible`) kapja az eredményt. A fejléc (név + chevron) kék (`--spectrum-global-color-blue-400`) alapállapotban, piros (`--spectrum-global-color-red-400`) ha a mappa nem elérhető. Kinyitott állapotban piros figyelmeztető banner jelenik meg. A banner szövege lefedi a törölt mappa és a nem csatlakoztatott meghajtó esetét is.
    - Ld. `docs/diagrams/network-architecture.md`, `docs/REALTIME_ARCHITECTURE.md`, `docs/PROXY_SERVER.md`

7. **Cross-Platform Útvonalkezelés**
    - **Kanonikus formátum**: A DB-ben platform-független útvonalak: `/ShareName/relative/path` (pl. `/Story/2026/March`). Article `filePath` relatív a kiadvány `rootPath`-jához (pl. `.maestro/article.indd`).
    - **MOUNT_PREFIX** (`constants.js`): `{ darwin: "/Volumes", win32: "C:/Volumes" }`. Mac-en a rendszer automatikusan ide mountol, Windows-en IT állítja be symlink-ekkel (`mklink /D C:\Volumes\ShareName \\server\ShareName`).
    - **Konverziós függvények** (`pathUtils.js`): `toCanonicalPath()` (natív → DB), `toNativePath()` (DB → natív), `toRelativeArticlePath()` (abszolút → relatív), `toAbsoluteArticlePath()` (relatív → natív abszolút).
    - **Lazy migráció** (`DataContext.jsx`): `migratePathsIfNeeded()` automatikusan konvertálja a régi formátumú útvonalakat (abszolút natív) kanonikus/relatív formátumra az adatbázisban, fetch után futva.
    - **LockManager / DocumentMonitor**: Kanonikus útvonal-összehasonlítást használnak (`getArticleCanonicalPath()`) a cross-platform egyeztetéshez. A `nativePathToQueryVariants()` generálja a DB lekérdezéshez szükséges útvonal-variánsokat (relatív + legacy kanonikus).
    - **`convertNativePathToUrl()`**: Natív útvonalat `file:///` URL-lé konvertál a UXP `getEntryWithUrl()` számára. **Nem kódol** `encodeURIComponent`-tel — a UXP API saját maga végzi az URL-kódolást. A kézi kódolás dupla kódolást okozna (szóköz → `%20` → `%2520`). Már kódolt URL-eket (`file:` prefix) `decodeURIComponent`-tel nyers útvonalra decode-ol.
    - **Edge case-ek**: Helyi (nem hálózati) fájlok nem kanonizálhatók — cross-platform nem működik velük. Ha a Windows symlink hiányzik, `checkPathAccessible()` false → piros fejléc.

8. **Thumbnail Rendszer (Oldalkép generálás)**
    - **Cél**: JPEG oldalkép thumbnailek generálása InDesign fájlokból → Appwrite Storage feltöltés → Dashboard Layout (flatplan) nézet.
    - **Triggerek**:
      - (1) `addArticle` — az **eredeti** (nyitott) dokumentumból generálódik, **párhuzamosan** az oldalszám-kinyeréssel, még a `saveACopy` előtt. Ha a plugin nyitotta meg a fájlt, a thumbnail export és feltöltés inline történik; ha a felhasználó nyitotta, a `documentClosed` event kezeli.
      - (2) `MaestroEvent.documentClosed` — a DocumentMonitor `registerTask` mintájával (`useThumbnails.js` hook).
      - (3) `handlePageNumberChange` (átpaginázás) — ha a plugin nyitotta meg a dokumentumot (`!wasAlreadyOpen`), thumbnail újragenerálás inline; ha a felhasználó nyitotta meg, a `documentClosed` event kezeli.
    - **ExtendScript JPEG Export**: `doc.exportFile(ExportFormat.JPG, ...)` oldalanként, 120 DPI, `JPEGOptionsQuality.MEDIUM`, `exportingSpread = false`.
    - **Link check**: Missing VAGY out-of-date linkek esetén export kihagyása, warning toast megjelenítése. A `getLinkCheckLogic()` (scriptHelpers) a pasteboard-on (nem oldalon) elhelyezett hibás linkeket kihagyja (`link.parent.parent.parentPage.name` try/catch — InDesign `NothingEnum.NOTHING`-ot ad vissza pasteboard elemekre, nem JS `null`-t) — csak az oldalon lévő elemek blokkolják az exportot. `"ERROR:..."` stringet ad vissza → a `parseThumbnailExportResult()` felismeri és kihagyja az exportot.
    - **Storage**: Appwrite `thumbnails` bucket, max 2MB/fájl, `.jpg` kiterjesztés. Az article `thumbnails` mező JSON tömb: `[{ fileId, page }]`.
    - **Fájlok**: `thumbnailScripts.js` (ExtendScript generátorok), `thumbnailUploader.js` (upload/delete/cleanup), `useThumbnails.js` (React hook, documentClosed event).
    - **Takarítás**: Kiadvány törléskor a `deleteOldThumbnails()` törli a kapcsolódó fájlokat a Storage-ból. Átpaginázáskor a régi thumbnailek cserélődnek (upload új → delete régi → DB frissítés).
    - **Dashboard Layout nézet**: Magazin konvenció szerinti spread elrendezés (1. oldal = címlap jobb, 2-3, 4-5, ...). Thumbnail preview URL: `storage.getFileView(BUCKETS.THUMBNAILS, fileId)`. Oldalütközés detektálás: narancssárga badge + tooltip, ha több cikk ugyanazt az oldalt foglalja. Zoom: `transform: scale()` + wrapper div (a transform nem befolyásolja a layout-ot, a wrapper explicit méretezéssel hozza létre a scrollozható területet). PDF export: `window.print()` + `@media print` CSS (elrejti a sidebar/header/toolbar-t, felszabadítja a scroll konténereket).
    - **Alapelv**: Thumbnail generálás **soha nem blokkolja** a fő munkafolyamatot.

9. **Placeholder Sorok (Lefedetlen Oldalak)**
    - **Cél**: A kiadvány terjedelmén belüli (`coverageStart`–`coverageEnd`) hozzárendeletlen oldalak vizuális jelzése helykitöltő sorokkal az ArticleTable-ben.
    - **Logika**: `buildPlaceholderRows()` (`pageGapUtils.js`) — az összes cikk `pageRanges`/`pageStart`–`pageEnd` alapján összegyűjti a lefedett oldalakat, majd a hiányzó oldalszámokból összefüggő csoportokat épít.
    - **UI**: Szürke, nem szerkeszthető sorok az ArticleTable-ben. „Helykitöltők mutatása" toggle a FilterBar-ban (localStorage perzisztált, alapértelmezett: be).
    - **Sürgősség**: Placeholder állapota az initial state (pl. `"designing"`) → teljes hátralévő munkaidő jelenik meg.
    - **Szűrés**: A placeholder generálás az **összes** (szűrés nélküli) cikket figyelembe veszi, hogy a lefedettség pontos legyen.

10. **Dinamikus Workflow Rendszer**
    - **Egyetlen igazságforrás**: A `workflows` collection `compiled` JSON mezője tartalmazza a teljes workflow konfigurációt (states, transitions, validations, commands, elementPermissions, contributorGroups, leaderGroups, statePermissions).
    - **Szerkesztőség-szintű, publikáció-kötött**: Egy editorial office több workflow doc-ot is tarthat (Fázis 7). Minden publikáció a saját `publication.workflowId` mezője alapján hivatkozik egy konkrét workflow-ra. Onboarding / office létrehozáskor egy default workflow (a `defaultWorkflow.json`-ből klónozva) kerül seedingre, a többi szerkesztői szándékkal (Dashboard Workflow Designer „+ Új workflow" gomb) jön létre.
    - **Plugin read-only**: A Plugin NEM ír a `workflows` collection-be — csak olvassa. A Dashboard Workflow Designer szerkeszti (create/update/rename, delete Fázis 8).
    - **DataContext integráció**: A Plugin DataContext `workflows[]` plural state-et tart (összes workflow az aktív office-ban, név szerint rendezve). A workflow feloldás három külön useMemo-val történik: (1) `workflowCache` — parse cache doc-onként (stabil referencia publikáció-váltáskor, ha ugyanarra a workflow-ra mutat); (2) `activeWorkflowId` — csak a publikáció-változást figyeli, szűk deps-szel; (3) derived `workflow` — az `activeWorkflowId`-t feloldja a cache-ből. **Fail-closed**: ha nincs `activeWorkflowId` (`publication.workflowId === null`), vagy a cache nem tartalmazza az ID-t (törölt/cross-tenant workflow), a derived `workflow` → `null`. Nincs legacy `workflows[0]` fallback — az adatok konzisztenciáját elvárjuk. A Realtime handler a `workflows[]`-t merge-öli (create / update / delete), a `workflowChanged` event-et egy külön `useEffect` dispatcheli, amely a derived `workflow` identitás változására figyel `prevWorkflowRef`-fel.
    - **workflowRuntime.js** (maestro-shared): 16+ tiszta függvény (`getStateConfig`, `getAllStates`, `getAvailableTransitions`, `canUserMoveArticle`, `canEditElement`, `canRunCommand`, stb.) — minden `compiled` paramétert kap, nincsenek globális állapotok.
    - **CF process cache**: A Cloud Function-ök 60s TTL-lel cache-elik a workflow dokumentumot per (office, workflowId) kulcs (`getWorkflowForPublication()`). Ha nincs workflow doc → fail-closed (state revert / reject).

11. **Szerver-oldali Guard Function-ök (Cloud Functions)**
    - A Cloud Function-ök külön csomagban élnek: `../maestro-server/`
    - Részletes leírás: `../maestro-server/CLAUDE.md`

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
├── ../maestro-server/             ← Szerver-oldali Appwrite Cloud Function-ök (ld. maestro-server/CLAUDE.md)
├── ../maestro-shared/            ← Közös csomag (plugin + dashboard által megosztott konstansok és logika)
│   ├── appwriteIds.js            ← Appwrite projekt/DB/gyűjtemény/bucket ID-k
│   ├── constants.js              ← Platform-független enumerációk (LOCK_TYPE, VALIDATION_TYPES, MARKERS)
│   ├── defaultWorkflow.json      ← 8 állapotos default compiled workflow (seeding és fallback)
│   ├── workflowRuntime.js        ← Workflow fogyasztói API (16+ tiszta függvény, compiled paramétert kap)
│   ├── commandRegistry.js        ← Command ID → label mapping (Dashboard designer számára)
│   ├── contributorHelpers.js     ← Contributors JSON parse/serialize/query helperek (getContributor, setContributor, isContributor)
│   ├── groups.js                 ← DEFAULT_GROUPS (7 alapértelmezett csoport), resolveGroupSlugs() helper
│   ├── urgency.js                ← Sürgősség-számítás (munkaidő, ünnepnapok, ratio, színskála, workflow paramétert kap)
│   └── pageGapUtils.js           ← Placeholder sorok generálása lefedetlen oldalakhoz (workflow paramétert kap)
│
├── docs/                         ← Architektúra dokumentáció (ld. §Dokumentáció Katalógus)
│   ├── NAMING_CONVENTIONS.md
│   ├── EVENT_ARCHITECTURE.md
│   ├── REALTIME_ARCHITECTURE.md
│   ├── WORKFLOW_PERMISSIONS.md
│   ├── URGENCY_SYSTEM.md
│   ├── PROXY_SERVER.md
│   ├── ARCHIVING_TEXT_EXTRACTION.md  ← Archiválási szövegkinyerés: clustering, típusosztályozás, XML/TXT generálás
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
│   │   ├── index.jsx             ← App bootstrap, belépési pont, hamburgermenü handlerek (jelszókezelés, kijelentkezés), graceful shutdown, startup error capture
│   │   ├── Main.jsx              ← Gyökér komponens (sleep/focus detektálás, RecoveryManager trigger)
│   │   ├── config/
│   │   │   ├── appwriteConfig.js       ← Appwrite kliens, EndpointManager (dual-proxy), db/collection/bucket ID-k, DASHBOARD_URL, VERIFICATION_URL, RECOVERY_URL
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
│   │       ├── logger.js               ← log, logError, logWarn, logDebug
│   │       ├── errorUtils.js           ← Hibaosztályozás (Hálózati, Auth, stb.)
│   │       ├── constants.js            ← Alkalmazás-szintű konstansok (MOUNT_PREFIX, LOCK_TYPE, stb.)
│   │       ├── messageConstants.js     ← Felhasználónak megjelenő üzenet stringek
│   │       ├── pathUtils.js            ← Cross-platform útvonalkezelés (kanonikus ↔ natív konverzió, MOUNT_PREFIX, checkPathsAccessibleBatch)
│   │       ├── namingUtils.js          ← Név formázó helperek
│   │       ├── promiseUtils.js         ← Promise segédfüggvények (withTimeout, withRetry)
│   │       ├── archivingProcessor.js    ← Hibrid AI + szabály-alapú clustering (Union-Find, polygon clipping, TXT/XML output)
│   │       ├── thumbnailUploader.js    ← Thumbnail JPEG feltöltés/törlés/takarítás (Appwrite Storage)
│   │       ├── pageGapUtils.js         ← Placeholder sorok generálása lefedetlen oldalakhoz
│   │       ├── urgencyUtils.js         ← Sürgősség-számítás (munkaidő, ünnepnapok, ratio, színek)
│   │       ├── validationConstants.js  ← VALIDATOR_TYPES és VALIDATION_SOURCES enumerációk
│   │       ├── validationRunner.js     ← Validátor futtatás orchestrálása + standalone fájl létezés ellenőrzés
│   │       ├── validators/             ← Tiszta validációs logika osztályok
│   │       │   ├── ValidatorBase.js
│   │       │   ├── DatabaseIntegrityValidator.js
│   │       │   ├── FileSystemValidator.js
│   │       │   ├── PreflightValidator.js
│   │       │   ├── PublicationStructureValidator.js
│   │       │   ├── StateComplianceValidator.js  ← Állapotátmenet-validáció koordinátor (fájl, oldalszám, fájlnév, preflight)
│   │       │   └── index.js
│   │       ├── indesign/               ← ExtendScript generálás & InDesign segédfüggvények
│   │       │   ├── indesignUtils.js    ← Script futtatás, dokumentum műveletek
│   │       │   ├── documentScripts.js  ← Dokumentum-szintű ExtendScript generátorok
│   │       │   ├── exportScripts.js    ← PDF/nyomtatás export scriptek
│   │       │   ├── preflightScripts.js ← Preflight ellenőrzés scriptek
│   │       │   ├── archivingScripts.js ← Archiválási ExtendScript generátorok (adatkinyerés, fájlmentés, másolás)
│   │       │   ├── thumbnailScripts.js ← Thumbnail JPEG export ExtendScript generátorok
│   │       │   ├── scriptHelpers.js    ← Közös script építőelemek
│   │       │   └── index.js
│   │       └── workflow/                  ← Cikk állapotgép (a workflowRuntime.js delegál)
│   │           ├── workflowEngine.js      ← executeTransition (→ StateComplianceValidator), lockDocument, unlockDocument
│   │           ├── workflowPermissions.js ← canUserMoveArticle, hasTransitionPermission (proxy a workflowRuntime-ra)
│   │           └── index.js
│   │
│   ├── data/                     ← Adat hook-ok réteg (Context ↔ UI híd)
│   │   └── hooks/
│   │       ├── useArticles.js                   ← CRUD + megnyitás/bezárás + szűrés kiadvány szerint
│   │       ├── useGroupMembers.js                ← Csoporttagok listázása (scope-szűrt, Realtime szinkronnal)
│   │       ├── useContributorGroups.js           ← Contributor csoportok + tagok (2 query, 5 perces cache)
│   │       ├── useUserValidations.js            ← Felhasználói validációs üzenetek CRUD
│   │       ├── useUnifiedValidation.js          ← Rendszer + felhasználói validációk összefésülése
│   │       ├── useWorkflowValidation.js         ← Preflight + workflow validáció (esemény-vezérelt)
│   │       ├── useDatabaseIntegrityValidation.js ← DB integritás esemény-feliratkozó hook
│   │       ├── useOverlapValidation.js          ← Átfedés detektálás esemény-feliratkozó hook (per-pub debounce)
│   │       ├── useThumbnails.js                ← Thumbnail generálás hook (documentClosed event)
│   │       ├── useUrgency.js                    ← Sürgősség-számítás hook (percenkénti frissítés)
│   │       ├── useElementPermission.js          ← UI elem jogosultság hookok (useElementPermissions, useContributorPermissions)
│   │       ├── useDriveAccessibility.js         ← Központi mappa-elérhetőség figyelő (batched ExtendScript)
│   │       └── useFilters.js                    ← Központi szűrő állapot hook (localStorage perzisztált)
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
│   │       │   ├── PublicationList.jsx  ← Kiadvány lista (read-only; üres állapot Dashboard CTA-val)
│   │       │   ├── PublicationListToolbar.jsx
│   │       │   └── Publication/         ← Egyetlen kiadvány nézet (hover toolbar: Cikk hozzáadása + Dashboard megnyitása)
│   │       │       ├── Publication.jsx
│   │       │       └── WorkflowStatus.jsx
│   │       ├── workspace/
│   │       │   ├── Workspace.jsx        ← Fő munkaterület konténer
│   │       │   ├── WorkspaceHeader.jsx  ← Fejléc sáv (felhasználó név + szűrők gomb + dashboard link)
│   │       │   ├── FilterBar.jsx        ← Központi szűrősáv (állapot, kimarad, saját cikkek, helykitöltők)
│   │       │   ├── DocumentMonitor.jsx  ← InDesign dokumentum életciklus figyelő
│   │       │   ├── LockManager.jsx      ← Dokumentumzárolás kezelő UI
│   │       │   └── PropertiesPanel/     ← Jobb oldali tulajdonságok panel
│   │       └── user/
│   │           ├── Login/               ← Bejelentkezés UI
│   │           └── Register/            ← Regisztráció UI (email verifikációval)
│   │
│   └── assets/                   ← Statikus erőforrások (ikonok, stb.)
│
└── (A Cloud Function-ök a ../maestro-server/ csomagba kerültek)
```

---

## Kulcs Munkafolyamatok

### Fájl Megnyitás
`ArticleTable` (dupla kattintás) → `Publication.onOpen` → `useArticles.openArticle` → `app.open()` (UXP) → `LockManager` észleli & zárolja → Realtime → UI frissül.

> Részletes diagram: `docs/diagrams/open-file-flow.md`

### Fájl Mentés
InDesign `afterSave` → `DocumentMonitor` → `dispatch(documentSaved)` → Validátorok futnak (Preflight, DB Integritás) → automatikus javítás ha szükséges → `dispatch(pageRangesChanged)` → Átfedés ellenőrzés.

> Részletes diagram: `docs/EVENT_ARCHITECTURE.md` (Validációs Hurok)

### Cikkfelvétel (addArticle)
Fájl kiválasztása → `useArticles.addArticle` → útvonal validáció (kiadvány gyökérben van-e) → `.maestro/` mappa előkészítés → duplikátum ellenőrzés → eredeti fájl megnyitása InDesign-ban (ha még nincs nyitva) → `doc.saveACopy()` a `.maestro/` mappába (másolat mindig aktuális InDesign verzióban; újabb verzió → `app.open()` fail → cikk nem kerül felvételre) → **párhuzamosan**: oldalszám-kinyerés + thumbnail generálás az **eredeti** dokumentumból → dokumentum bezárás (ha mi nyitottuk) → thumbnail feltöltés (Appwrite Storage) → DB rekord létrehozás (alapértelmezett contributor-ökkel a kiadványból) → `articlesAdded` MaestroEvent a létrehozott cikk objektumokkal.

- **Dinamikus initial state**: A `state` mező értékét a `getInitialState(workflow)` adja (a compiled workflow első állapota). Fallback: `"designing"` + `logWarn` — ha a workflow még nem töltődött be.
- **saveACopy stratégia**: A korábbi `file.copyTo()` bináris másolást váltja ki — megoldja a verziókonverziós problémákat és a „Save As" dialógus kérdést.
- **Rollback**: Ha a DB létrehozás sikertelen, a `.maestro/` mappába másolt fájl árván marad (nem blokkoló).
- **Esemény payload**: Az `articlesAdded` event a `{ publicationId, articles }` payload-ot kapja, ahol `articles` a `createArticle` DB válaszából származó objektumok tömbje. Ez megkerüli a React state batching okozta race condition-t (a ref-ek nem frissülnek szinkron az event dispatch-kor).

### Átpaginázás (oldalszám-módosítás)
`ArticleProperties.handlePageNumberChange` → validáció (filePath, startPage, coverage bounds) → dokumentum megnyitása (ha szükséges) → oldalak átszámozása (offset) → új oldalszámok kinyerése → mentés `maestroSkipMonitor` flag-gel (DocumentMonitor ne reagáljon) → régi PDF-ek törlése (`__PDF__`, `__FINAL_PDF__` mappák, `generateDeleteOldPdfsScript`) → thumbnail újragenerálás (ha plugin nyitotta meg, `!wasAlreadyOpen`) → dokumentum bezárás (ha mi nyitottuk) → DB frissítés (startPage, endPage, pageRanges, thumbnails).

- **`maestroSkipMonitor` minta**: Megakadályozza, hogy a programozott mentés visszacsatolási hurkot indítson a DocumentMonitor-ban. A Cikk Átnevezés is használja.
- **PDF takarítás**: A `generateDeleteOldPdfsScript()` az eredeti (átszámozás előtti) oldalszámok alapján keresi a régi PDF fájlokat.

### Cikk Átnevezés
- **Validáció**: `isValidFileName()` ellenőrzi a tiltott karaktereket (`\ / : * ? " < > |`), Windows fenntartott neveket (CON, PRN stb.), pontra/szóközre végződő neveket, lock ellenőrzés (más felhasználó szerkeszti-e).
- **Zárt dokumentum**: `GeneralSection` → `handleFieldUpdate("name")` → `useArticles.renameArticle` → `generateRenameFileScript()` (ExtendScript `File.rename`) → DB update.
- **Nyitott dokumentum**: `generateRenameOpenDocumentScript()` → dokumentum keresése `fullName` útvonal alapján (fallback: `name`) → `doc.save(newFile)` (Save As) → régi fájl törlése (hibakezeléssel) → DB update. A `maestroSkipMonitor` flag megakadályozza, hogy a DocumentMonitor reagáljon a programozott mentésre.
- **Rollback**: Ha a DB frissítés sikertelen, a fájl visszanevezése automatikus.

### Realtime Adatfolyam
Appwrite DB változás → WebSocket esemény → `realtimeClient.js` → `DataContext` handler → `setArticles()`/`setPublications()` → React újra-renderelési kaszkád.

### Csoporttagság Szinkronizáció
Appwrite `groupMemberships` collection Realtime csatorna → `DataContext` handler → `groupMembershipChanged` MaestroEvent → `useGroupMembers` hook cache invalidálás + `groupMemberships` query újralekérés. Recovery-nél (`dataRefreshRequested`) szintén frissül. Scope-váltáskor (`scopeChanged` MaestroEvent) a UserContext `refreshGroupSlugs()`-t hív, a `useGroupMembers` hookok cache-t invalidálnak.

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
| `docs/WORKFLOW_PERMISSIONS.md`            | Jogosultsági rendszer: csoporttagság-alapú állapotátmenet-védelem   |
| `docs/URGENCY_SYSTEM.md`                  | Sürgősség-számítás: munkaidő, ünnepnapok, ratio, progresszív sáv   |
| `docs/VALIDATION_MECHANISM.md`            | Egységes validációs és üzenetküldő rendszer működése                |
| `docs/ARCHIVING_TEXT_EXTRACTION.md`       | Archiválási szövegkinyerés: clustering, típusosztályozás, XML/TXT   |
| `../maestro-server/CLAUDE.md`             | Cloud Function-ök üzemeltetési referencia: ID-k, triggerek, env vars |
| `CONTRIBUTING.md`                         | Fejlesztési szabályok, JSDoc policy, import sorrend, PR workflow    |

---

## Context Provider-ek (Hierarchia)

```text
index.jsx
  └─ UserProvider          ← Auth állapot, bejelentkezés/kijelentkezés, session megőrzés
       └─ ConnectionProvider  ← Online/offline/connecting UI állapot
            └─ Main.jsx       ← Sleep detektálás, retry logika, routing
                 └─ ToastProvider       ← Toast értesítések
                      └─ (user?) ScopeProvider  ← activeOrganizationId, activeEditorialOfficeId
                           └─ DataProvider       ← publications[], articles[], fetchData()
                                └─ ValidationProvider  ← validationResults Map
                                     └─ ScopedWorkspace  ← scope placeholder / Workspace switch
```

A `ScopeProvider` csak a bejelentkezett ág belsejében jelenik meg — a `ScopedWorkspace`
dönti el, hogy a valódi `<Workspace />` vagy a `<ScopeMissingPlaceholder />` (loading /
no-membership / error) renderelődik, attól függően, hogy a `UserContext` memberships
már betöltődött-e és a `ScopeContext` auto-pick adott-e aktív officeId-t.

### DataContext API
- `publications`, `articles`, `validations` — az adat tömbök
- `activePublicationId` — az aktuálisan kiválasztott kiadvány ID-ja
- `setActivePublicationId(id)` — Kontextust vált és adat lekérést indít
- `isLoading`, `isSwitchingPublication` — betöltési állapot
- `fetchData(isBackground)` — REST API lekérés (inicializáláskor & újracsatlakozáskor)
- **Write-Through — Cikkek**: `createArticle(data)`, `updateArticle(id, data)`, `deleteArticle(id)` — a cikk CRUD a Pluginban marad (InDesign fájlfelvétel, oldalszám, állapotváltások).
- **Write-Through — Validációk**: `createValidation(data)`, `updateValidation(id, data)`, `deleteValidation(id)` — user message CRUD.
- **Olvas-csak — Kiadványok / Layoutok / Határidők (Fázis 9)**: A Plugin NEM ír publikáció, layout vagy határidő rekordokba. A DataContext a megfelelő `create*`/`update*`/`delete*` metódusokat nem exportálja, ezeket a Dashboard szerkeszti. A Plugin kizárólag olvassa ezeket Realtime szinkron + `fetchData` útján. A Publication hover toolbar „Megnyitás a Dashboardon" (`sp-icon-link-out`) ikonja és a publikáció fejléc dupla kattintása a böngészőben nyitja meg a Dashboardot JWT auto-loginnal (`handleOpenDashboard(pubId)` a Workspace-ben, `?pub=<id>` query + `#jwt=<token>` fragment).
- **Apply-Optimistic**: `applyArticleUpdate(serverDocument)` — külső írók (WorkflowEngine hívók) számára. Tartalmaz `$updatedAt` elavulás-védelmet: frissebb helyi adat nem felülíródik régebbi szerveradattal. Ez kritikus az `syncLocks()` és `fetchData()` párhuzamos futásánál — megakadályozza, hogy egy korábbi lock műveleti válasz felülírja a frissebb (lock-mentes) DB állapotot.
- **Realtime handler**: Automatikusan frissíti az állapotot WebSocket eseményekből `$updatedAt` elavulás-védelemmel. Ugyanez a minta mint az `applyArticleUpdate()`-ben — garantálja, hogy egy hosszabb hálózati késleltetésű update soha nem írja felül az optimista UI frissítéseket vagy közelmúltbeli szerver válaszokat.
- **Scope-szűrt fetch**: A `fetchData` minden lekérdezéséhez (`publications`, `articles`, `layouts`, `deadlines`, `userValidations`) hozzáfűzi a `Query.equal("editorialOfficeId", activeEditorialOfficeIdRef.current)` feltételt — így a Plugin kizárólag az aktív szerkesztőség adatait látja. A `publications` query ezen felül tartalmaz `Query.equal('isActivated', true)` feltételt is (Fázis 5). Ha nincs aktív officeId, a `fetchData` üres listákat állít be és `isInitialized=true`-ra vált, hogy a Realtime feliratkozás tudjon indulni. Office-váltáskor a `prevOfficeIdRef` alapján egy külön effect nullázza az `activePublicationId`-t és törli a derived state-et (`articles`, `layouts`, `deadlines`, `validations`).
- **Realtime scope szűrés**: A `publications`, `articles`, `layouts`, `deadlines`, `userValidations` ágak a meglévő `publicationId` szűrés MELLÉ `payload.editorialOfficeId === activeEditorialOfficeIdRef.current` ellenőrzést futtatnak (kivéve `.delete` eseményeknél, ahol a `filter()` amúgy is védett). **Publications aktiválás szűrés (Fázis 5)**: A `publications` ág `.create`/`.update` eseményeinél `payload.isActivated !== true` → skip (create) vagy filter-out (update, mintha delete lenne). Deaktiváláskor vagy törléskor, ha a target az aktív publikáció, az `activePublicationId` és a derived state (articles/layouts/deadlines/validations) azonnal nullázódik.
- **Write-through scope injection**: A `createArticle` és `createValidation` közös `withScope(data)` helper-en keresztül automatikusan rácsapja az `organizationId` + `editorialOfficeId` mezőket a payload-ra, refből olvasva az aktív értékeket. Ha nincs aktív scope, a helper dob (`'Nincs aktív szerkesztőség — a művelet nem hajtható végre.'`) — ez a happy path-ban nem tüzelhet (a UI a `ScopeMissingPlaceholder` mögött zárolva). Az `updateX` metódusok NEM kapnak scope injection-t — a scope mezők immutable-ek a CF guard-ok által.

### ScopeContext API
- `activeOrganizationId`, `activeEditorialOfficeId` — az aktuálisan választott multi-tenant scope (localStorage-ban perzisztált, `maestro.activeOrganizationId` / `maestro.activeEditorialOfficeId` kulcsok; a Plugin és Dashboard localStorage izolált, nincs ütközés).
- `setActiveOrganization(id)`, `setActiveOffice(id)` — írják az állapotot és a localStorage-ot. A `setActiveOffice` dispatch-eli a `scopeChanged` MaestroEvent-et, amely triggereli a UserContext `refreshGroupSlugs()`-t és a `useGroupMembers` hookok cache invalidálását.
- **Stale ID védelem + auto-pick**: A `useEffect` a `UserContext` memberships betöltése után (`loading === false && !membershipsError`) ellenőrzi, hogy az aktuális ID-k még szerepelnek-e a listákban. Stale esetben az első elérhetőre vált, vagy nullázza. Ha nincs aktív scope, de van membership, automatikusan az elsőt választja (ez biztosítja a Dashboardon frissen onboardolt user első Plugin-belépésnél az azonnali scope-ot, külön UI interakció nélkül).
- **WorkspaceHeader dropdown**: Ha a user több org-hoz vagy office-hoz tartozik, a `WorkspaceHeader` feltételes `CustomDropdown`-okat mutat a scope váltáshoz.

### UserContext API
- `user` — aktuális felhasználó objektum (vagy `null`)
- `login(email, password)`, `logout()`, `register(name, email, password)`
- `loading` — hitelesítés folyamatban
- **Regisztráció**: `register()` fiókot hoz létre → ideiglenes bejelentkezés → `account.createVerification(VERIFICATION_URL)` → kijelentkezés. A felhasználó NEM léphet be, amíg az email nincs megerősítve (`emailVerification` flag ellenőrzés a login-ban). A `VERIFICATION_URL` a Dashboard `/verify` route-jára mutat (Dashboard `VerifyRoute.jsx` hívja az `account.updateVerification()`-t).
- **Jelszókezelés** (hamburgermenü, `index.jsx`-ben, React kontextuson kívül):
  - **Jelszó módosítás**: InDesign natív dialog → `account.updatePassword()` — bejelentkezést igényel.
  - **Elfelejtett jelszó**: InDesign natív dialog (email) → `account.createRecovery(email, RECOVERY_URL)` → Dashboard `/reset-password` oldal a böngészőben (Dashboard `ResetPasswordRoute.jsx` hívja az `account.updateRecovery()`-t).
- **Realtime szinkron (labels/prefs)**: Az Appwrite Realtime `account` csatornára feliratkozva a `user` objektum (beleértve `labels`, `name`, `prefs`) automatikusan frissül, ha a szerveren módosítják (Console/Server SDK). A handler a `response.events[]` alapján szűri a session eseményeket (`.sessions.` stringet ignórálja) és validálja a payload `$id`-ját (csak `currentUserId` egyezésekor alkalmaz frissítéseket), megakadályozva, hogy session ID-k felülírják a user objektumot. A `name` és `email` mezők megőrződnek, ha a Realtime payload nem tartalmaz értéket (field preservation).
- **Realtime szinkron (groupSlugs)**: A `groupMemberships` collection Realtime csatorna → `groupMembershipChanged` MaestroEvent → UserContext `refreshGroupSlugs()` — `groupMemberships` + `groups` query az aktív szerkesztőségben. A `sameGroupSlugs()` helper Set-alapú duplikátum-mentes összehasonlítást végez, hogy a szinkron ne okozzon felesleges re-rendereket. Scope-váltáskor a `scopeChanged` MaestroEvent szintén triggereli a frissítést.
- **Recovery szinkron**: A `dataRefreshRequested` MaestroEvent-re is feliratkozik — minden recovery-nél (sleep/wake, reconnect, focus) `account.get()`-tel frissíti a user adatokat. Ez biztosítja a labels/prefs szinkront akkor is, ha az Appwrite Realtime `account` csatorna nem tüzel proxy-n keresztül (pl. szerver-oldali label módosításnál).
- **Memberships**: `organizations`, `editorialOffices` — a user által elérhető teljes scope rekordok (az `organizationMemberships` és `editorialOfficeMemberships` collection-ökből húzva, majd a scope rekordok paralel lekérésével). `membershipsError` — a legutóbbi memberships fetch hibája (ha volt). `reloadMemberships()` — manuális újratöltő (a `ScopeMissingPlaceholder` „error" variánsának retry gombja hívja). A loading minden belépési pontnál (login, mount `checkUserStatus`, recovery) paralel fut az `enrichUserWithGroups` mellett `Promise.all`-lal — egy membership hiba nem blokkolja az auth happy path-ot (külön `.catch` → `membershipsError` state), a `ScopeContext` auto-pick effect pedig csak `!membershipsError` esetén fut, hogy egy átmeneti fetch hiba ne törölje a helyes scope-ot.

### ConnectionContext API
- `isOnline`, `isConnecting` — UI indikátorokhoz (spinner, overlay)

### ValidationContext API
- `validationResults` — összefésült Map (articleId → { errors, warnings })
- `updateArticleValidation(articleId, source, results)`, `updatePublicationValidation(pubId, source, results)`
- `clearArticleValidation(articleId, source)` — egy forrás eredményeinek törlése

---

## Appwrite Konfiguráció

### Végpontok & ID-k
A konfigurációs konstansok: `src/core/config/appwriteConfig.js`

- **Endpoint**: Dual-proxy failover-rel (`EndpointManager`): Railway (primary) → emago.hu (fallback). Mindig `endpointManager.getEndpoint()`-ot használj az aktuális endpoint lekéréséhez — a korábbi `APPWRITE_ENDPOINT` statikus export el lett távolítva. Az `endpointManager.getProxyBase()` a proxy gyökér URL-t adja vissza (a `/v1` suffix nélkül) — az AI clustering (`/api/cluster-article`) és egyéb proxy-szintű endpointokhoz.
- **Project ID**, **Database ID**, **Collection ID-k** (Articles, Publications, Messages), **Bucket ID** (Storage).
- **Csoportok**: Saját `groups` + `groupMemberships` collection-ök (szerkesztőség-szintű scope). A csoportok szerkesztőség-szintűek (scope: `editorialOfficeId`). 7 alapértelmezett csoport: `editors`, `designers`, `writers`, `image_editors`, `art_directors`, `managing_editors`, `proofwriters`. Új csoportok a Dashboard `/settings/groups` UI-ról kezelhetők.

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
- **Logger**: `src/core/utils/logger.js` — `log()`, `logError()`, `logWarn()`, `logDebug()`. Kimenet a UXP DevTool console-ban. A `logDebug()` csak fejlesztési módban logol (production build-ben a Webpack kiszűri).
- **Realtime hibakeresés**: A proxy logokban `[WS Proxy Error]` és `[HTTP Proxy Error]` üzenetek jelzik a valódi hibákat (EPIPE/ECONNRESET automatikusan szűrve). `[Auth Inject Error]` jelzi a cookie injection problémákat. Ld. `docs/PROXY_SERVER.md`.
- **Webpack source map-ek**: `eval-cheap-source-map` (development mode) — gyors rebuild, debugolható.
