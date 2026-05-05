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
    - **Kritikus vs. nem-kritikus adatlekérés**: A publications és articles `Promise.all`-lal futnak (ha elbuknak, a catch kezeli). A layouts, deadlines és workflows `Promise.allSettled`-del futnak — ha VPN-en timeout-olnak, a UI azonnal megjelenik a kritikus adatokkal, és toast figyelmeztet a hiányzó adatokról. A workflows ugyanebben az `allSettled`-ben fut (nem külön fire-and-forget fetch-ben), hogy a `isInitialized=true` csak betöltött workflow után billenjen — különben a Realtime handler átmenetileg `workflow=null`-t látna.
    - **`isInitialized` a `finally` blokkban**: Auth hibán kívül minden terminal ágon true-ra billen (sikeres fetch, hálózati hiba, timeout) — hogy a Realtime feliratkozás ne csak a RecoveryManager `dataRefreshRequested` eseményére tudjon indulni. Auth hiba esetén viszont NEM állítjuk: nincs session → a Realtime feliratkozás amúgy is elbukna, a user pedig a Login képernyőre kerül.
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
    - **`unlockWithRetry` finally védelem**: A `DocumentMonitor` `finally` blokkja a SYSTEM lock feloldását `unlockWithRetry` helperrel hívja (3× exponenciális backoff: 1s→2s→4s, csak `networkError: true` flagre retry). Indoklás: recovery közbeni átmeneti hálózati hiba esetén az orphaned SYSTEM lock **USER-BLOKKOLÓ** — másik user `openArticle` hívásában a ghost-lock cleanup saját user.$id-re nem aktiválódik (owner tagja az office-nak), így a fájl csak a lock owner következő plugin-indításakor (`cleanupOrphanedLocks`) szabadul fel. A retry bezárja a hálózati eredetű orphan ablakot. Worst case 3s extra háttér-delay a finally-ben (nem UI-blokkoló). Üzleti hiba (permission, nem saját lock) azonnal tér vissza retry nélkül.

4. **Validációs Rendszer**
    - **Egységes Architektúra**: Összefésüli a rendszer validációkat (Preflight, Overlap) és a felhasználói üzeneteket egyetlen listába.
    - **Felhasználói Validációk**: Közvetlenül a `DataContext` kezeli (DB-ből származnak), Realtime-on keresztül szinkronizálva.
    - **Rendszer Validációk**: A `ValidationContext` kezeli (memóriában, session-önként).
    - **Állapotátmenet-validáció**: A `StateComplianceValidator` koordinálja az összes állapotváltási ellenőrzést (`file_accessible`, `page_number_check`, `filename_verification`, `preflight_check`, valamint `ext.<slug>` workflow extension validátorok — ld. 10. pont) a `workflow.validations[state]` `requiredToEnter`/`requiredToExit` alapján. A `WorkflowEngine.validateTransition()` delegál a `validationRunner.validate()` → `StateComplianceValidator` láncon keresztül. A `WorkflowEngine.executeTransition` és `validateTransition` opcionális `extensionRegistry` paramétert vesz fel — a hívók a `DataContext` derived `extensionRegistry`-jét adják át (B.4.2 / ADR 0007 Phase 0).
    - **Struktúra Validáció (PublicationStructureValidator)**: Bounds check (`getEffectivePageRange()` — `startPage`/`endPage` + `pageRanges` JSON fallback) és overlap detektálás (`getOccupiedPages()` — layout-alapú csoportosítás). A `validatePerArticle()` per-cikk eredményeket ad vissza (deduplikált párok `reportedPairs` Set-tel). A `useOverlapValidation` hook az `articlesAdded` event payload-ból merge-öli az új cikkeket a ref-elt állapottal (React state batching megkerülése).
    - **Blokkolási Logika**: Bármely aktív `error` típusú elem blokkolja az állapotátmeneteket.
    - **Perzisztencia race-védelem**: A `useOverlapValidation` és `useWorkflowValidation` upsert műveletei a `validationPersist.queuePersist(key, fn)` helperen mennek keresztül — per-kulcs (pl. `structure::${pubId}` vagy `${source}::${articleId}`) Promise lánc sorosítja a fetch+write párokat, így egymás utáni gyors hívások nem keverednek (korábbi write még futhat, amikor a következő fetch már indulna). A helper belső hibákat a láncon elnyel, hogy egy elbukott persist ne törje meg a következőt.
    - **Komponensek**: `ValidationSection.jsx` (UI), `useUnifiedValidation` (Logika), `ValidationContext` (Rendszeradatok).
    - **Mező-szintű Validáció**: `ValidatedTextField` `invalid` prop + validátor statikus metódusok (pl. `isValidFileName`) — azonnali piros keret blur-kor, formátum-hibára. Fájlnév validáció: `\ / : * ? " < > |` tiltott karakterek + Windows fenntartott nevek (CON, PRN, AUX, NUL, COM1–9, LPT1–9) + pontra/szóközre végződő nevek tiltása. (A határidő mezőket Fázis 9 óta a Dashboard szerkeszti — a plugin-oldali `DeadlineValidator` megszűnt.)
    - **Dokumentáció**: `docs/VALIDATION_MECHANISM.md`
    - Ld. `docs/diagrams/data-flow-architecture.md`

5. **Jogosultsági Rendszer (Workflow Permissions)**
    - **Dinamikus, DB-alapú konfiguráció**: A teljes workflow (állapotok, átmenetek, jogosultságok, elem-engedélyek) a `workflows` collection `compiled` JSON-jából származik, szerkesztőség-szinten (per editorial office). A `workflowRuntime.js` (maestro-shared) 16+ tiszta függvénye az egyetlen interfész a compiled adathoz.
    - **Állapot-alapú átmenet**: Minden workflow állapothoz csoportok vannak rendelve (`compiled.statePermissions`), amelyek mozgathatják a cikkeket onnan. Az állapot ID-k stringek (pl. `"designing"`, `"editing"`).
    - **Két jogosultsági réteg (A.5, ADR 0008)**:
      1. **Workflow-runtime** (cikk-szintű): `user.groupSlugs` (a `groupMemberships` + `groups` collection query-ből) — `canUserMoveArticle`, `canEditElement`, `canEditContributorDropdown`, `canUserAccessInState`. Ez a réteg dönt cikk-szerkesztésről, állapotátmenetről, contributor dropdown-ról. A korábbi `user.labels` / capability label rendszer megszűnt.
      2. **Office-műveleti** (33 slug, ADR 0008): `user.permissions: string[] | null` — kliens-oldali snapshot a server `buildPermissionSnapshot` lépéseit replikálva (label admin → org-role owner/admin shortcut → office cross-check → groupMemberships × groupPermissionSets × permissionSets). `clientHasPermission(user.permissions, slug)` (`maestro-shared/permissions.js`) + `useUserPermission(slug)` / `useUserPermissions(slugs)` hookok ([useElementPermission.js](src/data/hooks/useElementPermission.js)). Tri-state: `null` = loading, `[]` = nincs jog, `string[]` = jogok subset-je. **Plugin-on jelenleg nincs UI consumer** — feature-ready API a B blokk és a későbbi fázisok számára.
      A két réteg AND-elve használandó ott, ahol mindkettő érintett (pl. egy office-szintű publikáció-aktiváló UI). A workflow-runtime guardok a `groupSlugs`-ra építenek, függetlenül a `permissions`-től.
    - **Vezető csoportok bypass**: A `compiled.leaderGroups` (pl. `["managing_editors", "art_directors"]`) minden ACL ellenőrzést megkerülnek — állapottól és hozzárendeléstől függetlenül mozgathatnak, szerkeszthetnek.
    - **Háromszintű védelem**: UI gomb disabled → handler toast → engine guard → CF server-side guard.
    - **Realtime szinkron**: A `groupMemberships` Realtime csatorna → `groupMembershipChanged` MaestroEvent → UserContext frissíti a `user.groupSlugs`-t és a `user.permissions`-t → UI azonnal reagál. Scope-váltáskor a `scopeChanged` MaestroEvent szintén triggereli a `refreshGroupSlugs()` + `refreshPermissions()` párt; eager-clear első lépésként, hogy a refresh hibája ne hagyjon cross-office stale state-et. Plus külön Realtime subscribe a `permissionSets` + `groupPermissionSets` csatornákra (200ms debounce → `permissionSetsChanged` MaestroEvent), valamint az `organizationMemberships` + `editorialOfficeMemberships` csatornákra (300ms debounce → `loadAndSetMemberships` + `refreshPermissions`) a Dashboard-on végzett org-role / office-tagság változások azonnali invalidálásához.
    - **Workflow hot-reload**: A `workflows` collection Realtime csatorna → `DataContext` `setWorkflow()` → minden fogyasztó azonnal az új konfigurációt használja.
    - **UI Elem Jogosultságok**: A `compiled.elementPermissions` határozza meg, mely csoportok szerkeszthetik az egyes UI elemcsoportokat. A `workflowRuntime.canEditElement()` és `canUserAccessInState()` függvények ellenőrzik.
      - `useElementPermission(key)` / `useElementPermissions(keys[])` / `useContributorPermissions(articleState)` hookok (`useElementPermission.js`) — React komponensekben, változatlan publikus API.
      - **Kompozíció**: `disabled={isIgnored || isSyncing || !perm.allowed}` + tooltip a `reason`-nel.
    - **Konfiguráció**: `workflowRuntime.js` (fogyasztói API), `workflowPermissions.js` (plugin proxy), `workflowEngine.js` (átmenet végrehajtás).
    - **Szerver-oldali érvényesítés**: A kliens-oldali ACL-ek UI hint-ek — a végleges engedélyezés az `update-article` Cloud Function-ben történik (office scope, workflow állapot + átmenet, `statePermissions[currentState]`, csoporttagság). Részletek: `../maestro-server/CLAUDE.md` (update-article funkció). A Pluginból minden `updateArticle` hívás a `callUpdateArticleCF` helperen keresztül megy (`updateArticleClient.js`), a direkt DB írás permission-ről meg van vonva.

6. **Kapcsolat-helyreállítás (RecoveryManager) & Dual-Proxy Failover**
    - **Dual-Proxy Architektúra**: Railway (primary, EU West Amsterdam, ~0.5s TTFB) + emago.hu (fallback, Apache/Passenger, 8-10s cold start). Független infrastruktúra → szinte nulla egyidejű kiesés esélye.
    - **EndpointManager** (`appwriteConfig.js`): Singleton, amely kezeli az aktív/fallback proxy endpoint váltást. `switchToFallback()`, `switchToPrimary()`, `switchToOther()` — automatikusan frissíti az Appwrite Client endpoint-ját. `endpointSwitched` MaestroEvent-et dispatch-el váltáskor → toast értesítés a UI-ban.
    - **Központi RecoveryManager** (`recoveryManager.js`): Egyetlen belépési pont az összes recovery trigger (online, sleep, focus, realtime disconnect) számára.
    - **Cascading Health Check**: (1) Aktív endpoint retry-okkal, (2) ha nem elérhető, másik endpoint egyetlen próbával, (3) ha a másik működik, átkapcsol. Fallback-en minden recovery-nél ellenőrzi: primary visszajött-e → automatikus visszakapcsolás.
    - Lock + debounce védelemmel a párhuzamos és gyors egymás utáni recovery kérések ellen.
    - **Debounce végponttól**: A `lastRecoveryAt` a recovery VÉGÉN is frissül (`finally` blokk), megakadályozva, hogy egy hosszú recovery lejárja a debounce-t.
    - **Kapcsolat-ág egyetlen igazsága (`getConnectionStatus()`)**: A `_executeRecovery()` a „csak adat frissítés" ágra CSAK akkor vált, ha `realtime.getConnectionStatus() === true`. Korábban a `isReconnecting` flag is ebbe az ágba terelt, de az a close-handler in-flight `createSocket()` ideje alatt is true — ilyenkor a REST refresh félrevezető healthy UI-t mutatna egy még halott WS mellett. A `reconnect()` önmaga dedupe-ol (belső `isReconnecting` guard → `ok:true, attempted:0`), így biztonsággal hívható párhuzamos in-flight socket felépítés alatt.
    - Sorrend: health check → `await realtime.reconnect()` → adat frissítés.
    - Sleep detection (InDesign `IdleTask` gap > 60s) → `recoveryManager.requestRecovery('sleep')`.
    - **Async Resubscribe**: A `reconnect()` async — a hívások szinkron indulnak (nincs `setTimeout` delay), de `Promise.all`-lal megvárja a feliratkozások létrejöttét. A RecoveryManager `await`-eli a `reconnect()`-et, így az `isRecovering` flag végig true marad a teljes Realtime újraépítés alatt. A `_attemptSdkSubscription` boolean-nel tér vissza (true/false), így a sikertelen feliratkozások száma pontosan detektálható.
    - **Reconnect hibakezelés (`threw` flag)**: A `reconnect()` try/catch-je külön jelzi a thrown kivétel és a happy path közti különbséget. Ha a try blokk exception-nel (pl. `_initClient()` dobott, `_attemptSdkSubscription` reject) szállt ki, a metódus `_notifyConnectionChange(false)` + `_notifyError({ code: 'reconnect_exception' })` + `{ ok: false }`-t ad vissza, és NEM dispatcheli a `dataRefreshRequested` event-et. Ez megelőzi, hogy egy törött Realtime újraépítés mellett a REST refresh megtévesztően „sikeres recovery"-t sugalljon (overlay feloldás halott WS-szel).
    - **Realtime watchdog (`Main.jsx`)**: Periodikus `setInterval` (5s) ellenőrzi: ha nincs kapcsolat és nincs in-flight handshake (`isHandshaking()`), recovery-t kér. A `_notifyConnectionChange(false→false)` dedupe miatt egy initial handshake-kudarc (vagy post-CONNECTING close) nem váltana ki listener-trigger-t — a polling watchdog ezt a hézagot fedi le. Skip, ha `realtime.hasActiveSubscriptions() === false` (nincs mit újraépíteni; Login képernyő előtti idle churn elkerülése).
    - **Plugin Graceful Shutdown**: Az `index.jsx` `window.unload` eseményre iratkozik fel (az UXP `plugin.destroy()` hook nem mindig fut le, pl. InDesign kilépéskor). Shutdown-kor `recoveryManager.cancel()` → `realtime.disconnect()` sorrendben fut — megelőzi, hogy in-flight recovery egy már leállított kontextusban hozzon létre új WebSocket-et (crash). Az `_isCleanedUp` flag biztosítja, hogy a cleanup csak egyszer fusson le.
    - **Startup Error Capture**: Az `index.jsx` modul-szinten (React init előtt) regisztrál `error` és `unhandledrejection` listenereket. Az előző munkamenet esetleges összeomlásának részleteit localStorage-ba menti (`maestro.lastError`, `maestro.lastRejection`), és induláskor konzolra írja, majd törli.
    - **Recovery Cancellation**: A `RecoveryManager.cancel()` beállítja a `_isCancelled` flag-et, amely in-flight `_executeRecovery()` futást is leállít (health check await után ellenőrzött). Az aktív HTTP fetch kérések `AbortController`-eken keresztül (`_activeControllers` Set) azonnal megszakíthatók. Retry delay Promise-ok szintén megszakíthatók a `_retryReject` függvényen keresztül.
    - **createSocket Moduláris Felépítés**: A `realtimeClient.js` `createSocket` metódusa 4 privát metódusra bontva: `_buildSocketUrl()` (URL + auth params), `_handleSocketOpen()` (auth frame + heartbeat), `_handleSocketMessage()` (szerverhiba tracking + SDK delegálás), `_handleSocketClose()` (close code stratégia + reconnect logika).
    - **Ghost Socket Védelem**: Socket generáció-számláló (`_socketGeneration`) a `_handleSocketClose()`-ban. A close handler ignorálja a régi socket-ek close event-jeit, megakadályozva a végtelen reconnect ciklust.
    - **WebSocket 1001 (Going Away)**: Az alkalmazás/böngésző bezárásakor küldött 1001 close code-ot a `_handleSocketClose()` felismeri és nem indít reconnect-et (szemben az 1000-es normál lezárással, ahol a `realtime.reconnect` flag marad).
    - **Dinamikus Csatorna-kezelés**: A `_subscribedChannels` Set nyomon követi az aktív socket csatornáit. Ha új csatorna érkezik (pl. az `account` a database channels után), a `createSocket` lezárja a régi socketet és újat hoz létre az összes csatornával. Ez megoldja az eltérő React render ciklusokból adódó subscription-sorrend problémát.
    - **Explicit Socket Cleanup**: A `reconnect()` metódus explicit `close(1000)` hívással zárja le a régi WebSocket-et az új létrehozása előtt.
    - **Dinamikus Endpoint (Realtime)**: A `realtimeClient.js` `_initClient()` metódusa `endpointManager.getEndpoint()`-ot használ → `reconnect()` automatikusan felveszi az aktuális (primary/fallback) endpoint-ot.
    - **Timeout ≠ Offline**: Az adatlekérés időtúllépése NEM aktiválja az offline overlay-t — toast figyelmeztetést kap a felhasználó. Csak valódi hálózati hibák (Failed to fetch, ECONNREFUSED stb.) váltják ki az offline állapotot.
    - **Overlay Cleanup**: A `DataContext.fetchData` a `didFetchSucceed` flag-et vezeti — siker esetén (`setValidations` után) true-ra billen. A `finally` blokk overlay-cleanup-ja háromágú: (1) ha siker + korábban offline voltunk → `isOffline` + `isConnecting` törlés (egy sikeres REST recovery fetch feloldja a korábbi offline jelzést); (2) ha offline-ban maradunk, érintetlen; (3) egyébként `isConnecting` törlés. Ez megakadályozza az overlay beragadását ÉS azt, hogy egy elavult offline állapot megmaradjon Realtime reconnect után is.
    - **API Ellenállóképesség**: Centralizált `withRetry` segédfüggvény (`promiseUtils.js`) exponenciális backoff-fal (1s→2s→4s) az átmeneti szerverhibák (502, 503, 504) és hálózati hibák kezelésére.
    - **Szerverhiba Ellenállóképesség (Realtime)**: Speciális exponenciális backoff (5s→60s) + cooldown (5 hiba után 60s szünet) a Realtime WebSocket kapcsolatok védelmére.
    - **Proxy Server Keep-Alive**: A ProxyServer `server.js` TCP Keep-Alive (`keepAliveTimeout: 65s`) + 15s WebSocket ping frame-eket küld az aktív socket-ekre, megakadályozva az Apache/Passenger idle timeout-ot. EPIPE/ECONNRESET zajszűréssel és graceful shutdown-nal.
    - **Mappa-elérhetőség Polling**: A `useDriveAccessibility` hook (Workspace szinten) központilag ellenőrzi az összes kiadvány `rootPath` mappáját. Egyetlen batched ExtendScript hívást használ ciklusonként (`checkPathsAccessibleBatch()` — N mappa → 1 `doScript`), minimalizálva az InDesign blokkolást. Folyamatos `setInterval` polling (2s, `DRIVE_CHECK_INTERVAL_MS`) + `focus`/`panelShown`/`dataRefreshRequested` event listenerek. A `rootPath === null` (még nem konfigurált) publikációk kimaradnak az ExtendScript hívásból és a map-ből — ezek „konfiguráció szükséges" állapotban vannak (külön dimenzió, nem elérhetőségi hiba). A `Publication.jsx` két prop-ot kap: `isConfigured` (rootPath be van állítva) és `isDriveAccessible` (a mappa elérhető). A fejléc (név + chevron) színe: kék alapállapotban, **narancs** (`--spectrum-global-color-orange-500`) ha `!isConfigured` (konfiguráció szükséges), **piros** (`--spectrum-global-color-red-400`) ha `isConfigured && !isDriveAccessible` (mappa nem elérhető). Kinyitott állapotban a megfelelő színű figyelmeztető banner jelenik meg: „Konfiguráció szükséges" (narancs) VAGY „A kiadvány mappája nem érhető el" (piros, lefedi a törölt mappa és a nem csatlakoztatott meghajtó esetét). Cikk műveletek (felvétel, megnyitás) mindkét blokkoló állapotban tiltva (`isBlocked = !isConfigured || !isDriveAccessible`). A folder picker (rootPath beállítás a Pluginból) a #34 feladat hatásköre.
    - Ld. `docs/diagrams/network-architecture.md`, `docs/REALTIME_ARCHITECTURE.md`, `docs/PROXY_SERVER.md`

7. **Cross-Platform Útvonalkezelés**
    - **Kanonikus formátum**: A DB-ben platform-független útvonalak: `/ShareName/relative/path` (pl. `/Story/2026/March`). Article `filePath` relatív a kiadvány `rootPath`-jához (pl. `.maestro/article.indd`).
    - **MOUNT_PREFIX** (`constants.js`): `{ darwin: "/Volumes", win32: "C:/Volumes" }`. Mac-en a rendszer automatikusan ide mountol, Windows-en IT állítja be symlink-ekkel (`mklink /D C:\Volumes\ShareName \\server\ShareName`).
    - **Konverziós függvények** (`pathUtils.js`): `toCanonicalPath()` (natív → DB), `toNativePath()` (DB → natív), `toRelativeArticlePath()` (abszolút → relatív), `toAbsoluteArticlePath()` (relatív → natív abszolút, `..` path traversal védelemmel).
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
    - **Plugin read-only**: A Plugin NEM ír a `workflows` collection-be — csak olvassa. A Dashboard Workflow Designer szerkeszti (create/update/rename, delete, duplicate).
    - **Láthatóság (#30, 2-way MVP)**: A `workflows.visibility` enum két értéket vesz fel: `editorial_office` (default — csak az adott office tagjai látják) vagy `organization` (az org bármely office-ának tagjai látják). A `createdBy` mező info-szintű (nem permission gate) — az eredeti létrehozó userId-ja. Legacy payload (visibility=null) → `editorial_office` default. Bootstrap: a `bootstrap_workflow_schema` CF action idempotensen létrehozza a két attribútumot az első deploy előtt (org owner futtatja).
    - **DataContext integráció**: A Plugin DataContext `workflows[]` plural state-et tart (az aktív scope-ban látható workflow-k, név szerint rendezve). A fetch query `Query.or([...])`-rel szűr a 2-way visibility szabályra (`(visibility='organization' ∧ organizationId=activeOrg) ∨ (visibility='editorial_office' ∧ editorialOfficeId=activeOffice)`). A cache kulcsa `${orgId}|${officeId}` (`workflowFetchedForScopeRef`) — scope-váltásra automatikus refetch. A Realtime handler ugyanezt a két-ágú `isVisible` ellenőrzést futtatja `.create`/`.update` eseményekre. A workflow feloldás **négy egymásra épülő useMemo-val** történik, snapshot-preferáló logikával (#38): (1) `workflowCache` — parse cache doc-onként a `workflows[]` legacy útvonalához; (2) `activePublication` — az aktív pub objektum stabil identitása, szűk deps (`publications`, `activePublicationId`), kiszűri a nem-aktív pub mutációkat; (3) `activeSnapshotCompiled` — az aktív publikáció `compiledWorkflowSnapshot` JSON parse eredménye, szűk deps (`$id` + `compiledWorkflowSnapshot` string identitás), az élő publikáción soha nem parse-olódik újra; (4) `activeWorkflowId` — CSAK ha nincs snapshot (legacy fallback), így workflow-doc Realtime mutáció nem zavarja az aktivált publikációt; (5) derived `workflow` — preferencia-sorrend: snapshot → workflowCache[workflowId] → null. **Fail-closed**: snapshot parse hiba → fallback a `workflowId` útvonalra; ha az sem old fel, `null` (cikk blokkolás). A `workflowChanged` event-et egy külön `useEffect` dispatcheli, amely a derived `workflow` identitás változására figyel `prevWorkflowRef`-fel.
    - **Snapshot rögzítés (#37)**: A `validate-publication-update` CF §5a aktiválási sikeres átmenetkor (vagy snapshot-hiányos aktív publikáción backfill-ként) a workflow `compiled` JSON-ját a publikáció `compiledWorkflowSnapshot` mezőjébe írja. Onnantól a workflow Dashboard-oldali módosításai **NEM érintik az élő publikációt** — csak új aktiválásnál kerül új snapshot. Legacy (snapshot nélküli) aktivált publikációk a `workflowId` cache-re fallback-elnek. A snapshot immutability-t a CF §6b guard védi.
    - **workflowRuntime.js** (maestro-shared): 16+ tiszta függvény (`getStateConfig`, `getAllStates`, `getAvailableTransitions`, `canUserMoveArticle`, `canEditElement`, `canRunCommand`, stb.) — minden `compiled` paramétert kap, nincsenek globális állapotok.
    - **CF process cache**: A Cloud Function-ök 60s TTL-lel cache-elik a workflow dokumentumot per (office, workflowId) kulcs (`getWorkflowForPublication()`). Ha nincs workflow doc → fail-closed (state revert / reject).
    - **Workflow Extensions (B blokk, ADR 0007 Phase 0)**: A `workflowExtensions` collection szerkesztőség-szintű custom validátorokat és parancsokat tárol (ExtendScript `code` + `kind` `validator`/`command` + `slug`). A workflow JSON `validations[]` / `commands[]` listájában `ext.<slug>` prefixszel hivatkozhatóak.
        - **Snapshot-pattern**: A publikáció aktiválásakor a használt extension-ök kódja + metaadata a `publication.compiledExtensionSnapshot` JSON mezőbe rögzül (`{ slug: { name, kind, scope, code } }`). Futó publikáció alól a viselkedés NEM módosítható — analóg a `compiledWorkflowSnapshot`-tal.
        - **Plugin runtime**: A `DataContext` derived `extensionRegistry` az aktivált pub `compiledExtensionSnapshot`-jából épül `useMemo`-val (`buildExtensionRegistry`, [src/core/utils/extensions/extensionRegistry.js](src/core/utils/extensions/extensionRegistry.js)), `$id` + snapshot-string deps. Single-source: a fogyasztók (`StateComplianceValidator` `_checkExtensionValidator`, `commands/index.js` `executeCommand` `ext.<slug>` ág) ezt a derived state-et használják, NEM kell külön `buildExtensionRegistry()` minden komponensben. A `WorkflowEngine.validateTransition` / `executeTransition` opcionális `extensionRegistry` paramétert vesz fel — fail-closed `[ext.<slug>] ...` errorral, ha hiányzik.
        - **Realtime**: A `DataContext` feliratkozik a `workflowExtensions` collection-re és `workflowExtensionsChanged` MaestroEvent-et dispatchel, de Phase 0-ban runtime cache invalidálás NINCS — az aktivált pub registry immutable a snapshot szerint.
        - **Phase 0 hatókör-szűkítés (B.0.4)**: a per-workflow extension `options` ÜRES / nem továbbított a `maestroExtension(input)`-be. Phase 1+: `paramSchema` mező + Designer options-szerkesztő + plugin runtime options-átadás.
        - **Phase 0 konzisztencia-ablak**: a server-oldali `validate-publication-update` post-write revert + Plugin Realtime fetch közötti race-ből egy aktivált pub rövid ideig (~1-2s) látszhat hiányzó/stale `compiledExtensionSnapshot`-tal — ilyenkor az `ext.<slug>` dispatch fail-closed `unknown_slug`. UX kompromisszum: a felhasználó újrapróbálja a transition-t a következő Realtime ciklus után.

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
│   │       ├── validationPersist.js    ← Validáció upsert helperek: `fetchAllValidationRows` (paginált list), `queuePersist` (per-kulcs Promise lánc)
│   │       ├── validationRunner.js     ← Validátor futtatás orchestrálása (fájl létezés delegálás: StateComplianceValidator.checkFileAccessible)
│   │       ├── validators/             ← Tiszta validációs logika osztályok
│   │       │   ├── ValidatorBase.js
│   │       │   ├── DatabaseIntegrityValidator.js
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
`ArticleProperties.handlePageNumberChange` → validáció (filePath, startPage, coverage bounds) → dokumentum megnyitása (ha szükséges) → oldalak átszámozása (offset) → új oldalszámok kinyerése → mentés `maestroSkipCount` számlálóval (DocumentMonitor ne reagáljon) → régi PDF-ek törlése (`__PDF__`, `__FINAL_PDF__` mappák, `generateDeleteOldPdfsScript`) → thumbnail újragenerálás (ha plugin nyitotta meg, `!wasAlreadyOpen`) → dokumentum bezárás (ha mi nyitottuk) → DB frissítés (startPage, endPage, pageRanges, thumbnails).

- **`maestroSkipCount` minta**: Számláló (`window.maestroSkipCount`) megakadályozza, hogy a programozott mentés visszacsatolási hurkot indítson a DocumentMonitor-ban. A producer (átpaginázás, átnevezés) inkrementálja, a `DocumentMonitor.handleSave` dekrementálja és `return`-öl — így több egyidejű programozott mentés is pontosan egyszer-egyszer kihagyható (nincs bool flag ütközés). A Cikk Átnevezés is használja.
- **PDF takarítás**: A `generateDeleteOldPdfsScript()` az eredeti (átszámozás előtti) oldalszámok alapján keresi a régi PDF fájlokat.

### Cikk Átnevezés
- **Validáció**: `isValidFileName()` ellenőrzi a tiltott karaktereket (`\ / : * ? " < > |`), Windows fenntartott neveket (CON, PRN stb.), pontra/szóközre végződő neveket, lock ellenőrzés (más felhasználó szerkeszti-e).
- **Zárt dokumentum**: `GeneralSection` → `handleFieldUpdate("name")` → `useArticles.renameArticle` → `generateRenameFileScript()` (ExtendScript `File.rename`) → DB update.
- **Nyitott dokumentum**: `generateRenameOpenDocumentScript()` → dokumentum keresése `fullName` útvonal alapján (fallback: `name`) → `doc.save(newFile)` (Save As) → régi fájl törlése (hibakezeléssel) → DB update. A `maestroSkipCount` számláló megakadályozza, hogy a DocumentMonitor reagáljon a programozott mentésre.
- **Rollback**: Ha a DB frissítés sikertelen, a fájl visszanevezése automatikus.

### Workflow Állapotátmenet
`GeneralSection` gomb kattintás (disabled ha `isLocked` / `!canTransition` / `!hasRequiredContributor` / `isSyncing`) → `ArticleProperties.handleStateTransition` → `transitionInFlightRef` guard (ref, nem state — a React setState nem véd a duplakattintástól) → `hasErrors` / `canUserMoveArticle` hint / `filePath` ellenőrzés → `WorkflowEngine.executeTransition(workflow, article, targetState, user, publicationRootPath)`.

- **Egyetlen kliens-oldali validáció**: A drága preflight + file-accessible csak az engine-ben fut (a UI korábban explicit `validateTransition`-t is hívott — ezt a dupla futást megszüntettük).
- **Kategorizált hiba-visszajelzés**: Az engine `{ success, document?, error?, permissionDenied?, networkError?, validation? }` alakot ad vissza. A UI négy ágra toast-ol: (1) `validation.skipped` → csatolatlan meghajtó, (2) `validation.errors` → pontos validációs hibalista, (3) `permissionDenied` → „Nincs jogosultságod…", (4) `networkError` → „Hálózati hiba" retry-javaslattal. A catch-ág `isNetworkError(error)` alapján különíti el a váratlan throw-okat.
- **Háromszintű védelem**: UI gomb disabled → UI handler hint (sync, olcsó) → CF szerver-oldali gate (végleges engedélyezés). Az engine-ből a kliens-oldali `canUserMoveArticle` check eltávolítva — felesleges volt, a CF a végső kapu.
- **Lock blokkolás**: Ha `article.lockType` aktív (USER vagy SYSTEM), a gombok disabled, tooltip: „Zárd be az InDesign dokumentumot az állapotváltáshoz".
- **`stateChanged` MaestroEvent**: A payload cikk-objektuma a CF szinkron válaszából származik (legfrissebb állapot). A `useWorkflowValidation` handler `articlesRef.current.some($id)` existence check-kel szűri ki a közben eltűnt (pub switch / törlés) cikkeket.
- **CF protokoll-védelem**: `callUpdateArticleCF` dob, ha a CF `success:true`-t ad, de `document` nélkül — nem hagyhatunk üres optimista state-et.

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
- **Write-Through — Cikkek**: `createArticle(data)`, `updateArticle(id, data)`, `deleteArticle(id)` — a cikk CRUD a Pluginban marad (InDesign fájlfelvétel, oldalszám, állapotváltások). **Fázis 9 óta az `updateArticle` NEM írja közvetlenül az `articles` collection-t** — a hívás az `update-article` CF-en keresztül megy (`functions.createExecution(..., async: false)` → `callUpdateArticleCF()` helper). A CF szinkron validál (office scope, workflow state/átmenet, csoport jogosultság, `statePermissions[currentState]`) és csak pozitív ellenőrzés után ír szerver API key-jel. A `users` role-ból az `articles` Update permission megvonódik, így a direkt DB írás bypass-elése lehetetlen. Permission denied esetén a helper `PermissionDeniedError`-t dob, amit a hívó tipizáltan kezelhet (toast, optimistic rollback). Fast-path kivétel: ha a payload kizárólag `lockType`/`lockOwnerId` mezőket tartalmaz és a user a saját lockját állítja be (a cikk nincs más által zárolva) vagy oldja fel, a workflow + csoport jogosultsági check ki van hagyva (orphan lock cleanup és DocumentMonitor SYSTEM lock fail-closed kompatibilitása). Az office membership check MINDIG fut — cross-office lock-lopás nem lehetséges. A `lockType` értéke szerver-oldalon is enum-validált (`USER`/`SYSTEM`/`null`). A `callUpdateArticleCF` helper belépési pontjai: `DataContext.updateArticle`, `WorkflowEngine.executeTransition/toggleMarker/lockDocument/unlockDocument`, `LockManager.cleanupOrphanedLocks`, `useArticles.openArticle` (ghost lock cleanup), `DatabaseIntegrityValidator.autoCorrect`.
- **Write-Through — Validációk**: `createValidation(data)`, `updateValidation(id, data)`, `deleteValidation(id)` — user message CRUD. Közvetlen DB írás (`tables.createRow` / `updateRow` / `deleteRow`) — nincs CF közvetítés, szemben az `articles` update útvonallal. Az `updateValidation` a szerver válaszát a belső `applyValidationUpdate` helperen keresztül alkalmazza (lásd Apply-Optimistic), amely `$updatedAt` staleness guardot ad — egy párhuzamos (más user) írás Realtime-on már beérkezett magasabb `$updatedAt`-je nem íródik felül a saját, régebbi szerver válaszunkkal.
- **Olvas-csak — Kiadványok / Layoutok / Határidők (Fázis 9)**: A Plugin NEM ír publikáció, layout vagy határidő rekordokba. A DataContext a megfelelő `create*`/`update*`/`delete*` metódusokat nem exportálja, ezeket a Dashboard szerkeszti. A Plugin kizárólag olvassa ezeket Realtime szinkron + `fetchData` útján. A Publication hover toolbar „Megnyitás a Dashboardon" (`sp-icon-link-out`) ikonja és a publikáció fejléc dupla kattintása a böngészőben nyitja meg a Dashboardot JWT auto-loginnal (`handleOpenDashboard(pubId)` a Workspace-ben, `?pub=<id>` query + `#jwt=<token>` fragment).
  - **Kivétel — `rootPath` beállítás (#32 + #34)**: A Plugin folder picker modalja (Publication.jsx narancs banner „Gyökérmappa beállítása" gomb → UXP `storage.localFileSystem.getFolder()`) a `set-publication-root-path` CF-en keresztül tud egyszer, null-ról kanonikus értékre írni a `publications.rootPath` mezőn. A hívás a `callSetPublicationRootPathCF` helperen (`src/core/utils/updatePublicationClient.js`) megy át — az `updateArticleClient.js` mintáját követi, egységes `PermissionDeniedError` / `err.cfReason` hibaágakkal. Plugin-oldali pre-flight: `isUnderMountPrefix(nativePath)` (`pathUtils.js`) szűri ki a nem megosztott meghajtón lévő mappákat még a CF hívás előtt, clear user feedback-kel. A CF kanonikus formátum + office admin / org owner-admin jogosultság ellenőrzéssel validál; már beállított rootPath esetén `root_path_already_set` (409). Siker után a Realtime `publications.update` esemény hozza a frissített rekordot — a banner automatikusan eltűnik, nincs optimista state-patch. Nincs direkt DB írás a `publications` collection-re a Plugin felől.
- **Apply-Optimistic**: `applyArticleUpdate(serverDocument)` — külső írók (WorkflowEngine hívók) számára exportált, belsőleg a `DataContext.updateArticle` is ezt használja. Tartalmaz `$updatedAt` elavulás-védelmet: frissebb helyi adat nem felülíródik régebbi szerveradattal. Ez kritikus az `syncLocks()` és `fetchData()` párhuzamos futásánál — megakadályozza, hogy egy korábbi lock műveleti válasz felülírja a frissebb (lock-mentes) DB állapotot; és egy párhuzamos másik user CF válaszát, amelynek Realtime eseménye a mi válaszunk ELŐTT érkezett. A helper csak akkor alkalmaz — „update only if row exists locally" — ha a sor még a helyi `articles` állapotban van; pub switch / scope switch / deaktiváció utáni clear szándékosan eldobja a késve érkező választ (nem resurrect). Analóg, belső helper az `applyValidationUpdate(serverDocument)` — ugyanezt a staleness guardot alkalmazza user validation dokumentumokra (a `DataContext.updateValidation` használja). **Ismert kompromisszumok**: (1) a `fetchData` `setArticles(fetched)` és `setValidations(normalizedValidations)` teljes cseréje nem végez per-row staleness merge-öt, így egy optimista update elvileg felülíródhat egy azonnal utána befutó fetch által — init / recovery alatti szűk időablak. (2) Ha a recovery-t megelőző halott socketen egy `.delete` esemény elveszett, a recovery fetch egy már törölt sort visszahozhat — ez a deferred convergence valójában a következő érvényes Realtime `.delete` / `.update` eseménytől vagy a következő teljes fetch-től függ. Mindkét eset tudatosan elfogadott kompromisszum a bonyolultság és az előny arányában.
- **Realtime handler**: Automatikusan frissíti az állapotot WebSocket eseményekből `$updatedAt` elavulás-védelemmel. Ugyanez a minta mint az `applyArticleUpdate()`-ben — normál Appwrite kézbesítés mellett best-effort védelmet ad, hogy egy hosszabb hálózati késleltetésű update ne írja felül az optimista UI frissítéseket vagy közelmúltbeli szerver válaszokat. Halott socket / reconnect / óraeltolódás esetén nem abszolút garancia — a fenti „Ismert kompromisszumok" szekció részletezi.
- **Scope-szűrt fetch**: A `fetchData` minden lekérdezéséhez (`publications`, `articles`, `layouts`, `deadlines`, `userValidations`) hozzáfűzi a `Query.equal("editorialOfficeId", activeEditorialOfficeIdRef.current)` feltételt — így a Plugin kizárólag az aktív szerkesztőség adatait látja. A `publications` query ezen felül tartalmaz `Query.equal('isActivated', true)` feltételt is (Fázis 5). Ha nincs aktív officeId, a `fetchData` üres listákat állít be és `isInitialized=true`-ra vált, hogy a Realtime feliratkozás tudjon indulni. Office-váltáskor a `prevOfficeIdRef` alapján egy külön effect nullázza az `activePublicationId`-t és törli a derived state-et (`articles`, `layouts`, `deadlines`, `validations`).
- **Realtime scope szűrés**: A `publications`, `articles`, `layouts`, `deadlines`, `userValidations` ágak a meglévő `publicationId` szűrés MELLÉ `payload.editorialOfficeId === activeEditorialOfficeIdRef.current` ellenőrzést futtatnak (kivéve `.delete` eseményeknél, ahol a `filter()` amúgy is védett). **Publications aktiválás szűrés (Fázis 5)**: A `publications` ág `.create`/`.update` eseményeinél `payload.isActivated !== true` → skip (create) vagy filter-out (update, mintha delete lenne). Deaktiváláskor vagy törléskor, ha a target az aktív publikáció, az `activePublicationId` és a derived state (articles/layouts/deadlines/validations) azonnal nullázódik.
- **Write-through scope injection**: A `createArticle` és `createValidation` közös `withScope(data)` helper-en keresztül automatikusan rácsapja az `organizationId` + `editorialOfficeId` mezőket a payload-ra, refből olvasva az aktív értékeket. Ha nincs aktív scope, a helper dob (`'Nincs aktív szerkesztőség — a művelet nem hajtható végre.'`) — ez a happy path-ban nem tüzelhet (a UI a `ScopeMissingPlaceholder` mögött zárolva). Az `updateX` metódusok NEM kapnak scope injection-t — a scope mezők immutable-ek a CF guard-ok által.

### ScopeContext API
- `activeOrganizationId`, `activeEditorialOfficeId` — az aktuálisan választott multi-tenant scope (localStorage-ban perzisztált, `maestro.activeOrganizationId` / `maestro.activeEditorialOfficeId` kulcsok; a Plugin és Dashboard localStorage izolált, nincs ütközés).
- `setActiveOrganization(id)`, `setActiveOffice(id)` — írják az állapotot és a localStorage-ot. A `setActiveOffice` dispatch-eli a `scopeChanged` MaestroEvent-et, amely triggereli a UserContext `refreshGroupSlugs()`-t és a `useGroupMembers` hookok cache invalidálását.
- **Stale ID védelem + auto-pick**: A `useEffect` a `UserContext` memberships betöltése után (`loading === false && !membershipsError`) ellenőrzi, hogy az aktuális ID-k még szerepelnek-e a listákban. Stale esetben az első elérhetőre vált, vagy nullázza. Ha nincs aktív scope, de van membership, automatikusan az elsőt választja (ez biztosítja a Dashboardon frissen onboardolt user első Plugin-belépésnél az azonnali scope-ot, külön UI interakció nélkül). A cascading logika (org → office) egy tiszta `resolveScope({...})` függvénybe van kiemelve, ami `{ resolved, apply, reason }`-t ad vissza — az `useEffect` csak az `apply(setOrg, setOffice)` callbacket hívja. Nincs React dep a függvényben, így unit-tesztelhető.
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
- **Staleness guardok (auth lánc)**: Négy generáció-számláló véd a cross-module race ellen, a `bumpAllAuthGens()` Provider-helper mind4-et bumpolja az auth-boundary átmeneteknél (login start, logout, sessionExpired) — egy in-flight refresh válasza ne tudja az új munkamenetbe szivárogtatni az előző user adatait (cross-user leakage védelem). (1) `authGenRef` — minden aszinkron hydrate (`login` / mount `checkUserStatus` / recovery `handleRefresh`) bumpolja belépéskor; a záró `setUser(enrichedUser)` ellenőrzi, hogy a saját generációja még aktuális — enélkül egy in-flight hydrate resurrectelhetné a kijelentkezett usert. A `checkUserStatus` `finally`-ben `setConnected()` + `setLoading(false)`, hogy a stale `return` se ragassza be a „Felhasználó betöltése..." overlay-t. (2) `groupSlugsGenRef` — minden `refreshGroupSlugs` hívás bumpolja; a fetch utáni commit csak akkor írja felül a `user.groupSlugs`-t, ha még ő a legutolsó hívás. A `setUser`-callback `prev.$id !== currentUserId` belt-and-suspenders guard. (3) `permissionsGenRef` (A.5.1) — minden `refreshPermissions` hívás bumpolja; ugyanaz a setUser user-id guard. (4) `membershipsGenRef` — a `loadAndSetMemberships` stale választ eldobja.
- **officeId data flow**: Az `enrichUserWithGroups` / `refreshGroupSlugs` / `hydrateUserWithMemberships` nem olvas közvetlenül localStorage-ot — az aktív officeId paraméterként érkezik. A hívó oldal: `scopeChanged` handler az `event.detail.editorialOfficeId`-t használja (ScopeContext írja a payload-ba), a többi hely (mount / login / recovery / Realtime account memberships / groupMembershipChanged) a `getPersistedOfficeId()` helperrel a localStorage-ból. Tesztelhető és a ScopeContext perzisztálási részleteitől kevésbé függő.

### ConnectionContext API
- `isOnline`, `isConnecting` — UI indikátorokhoz (spinner, overlay)

### ValidationContext API
- `validationResults` — összefésült Map (articleId → { errors, warnings })
- `updateArticleValidation(articleId, source, results)`, `updatePublicationValidation(pubId, source, results)`
- `clearArticleValidation(articleId, source)` — egy forrás eredményeinek törlése
- **Scope-váltás reset**: A `scopeChanged` MaestroEvent-re a belső `sourceResults` Map teljesen törlődik (no-op guard: ha már üres, nem cseréli) — különben az idegen office articleId-s eredményei benne rekednének. Az új office eredményei amúgy is új validátor futáson jönnek.

---

## Appwrite Konfiguráció

### Végpontok & ID-k
A konfigurációs konstansok: `src/core/config/appwriteConfig.js`

- **Endpoint**: Dual-proxy failover-rel (`EndpointManager`): Railway (primary) → emago.hu (fallback). Mindig `endpointManager.getEndpoint()`-ot használj az aktuális endpoint lekéréséhez — a korábbi `APPWRITE_ENDPOINT` statikus export el lett távolítva. Az `endpointManager.getProxyBase()` a proxy gyökér URL-t adja vissza (a `/v1` suffix nélkül) — az AI clustering (`/api/cluster-article`) és egyéb proxy-szintű endpointokhoz.
- **Project ID**, **Database ID**, **Collection ID-k** (`COLLECTIONS` objektum a `maestro-shared/appwriteIds.js`-ből, közvetlenül exportálva az `appwriteConfig.js`-ből), **Bucket ID** (Storage).
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
