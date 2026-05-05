---
tags: [komponens, plugin, dashboard, data]
aliases: [DataContext, useData]
---

# DataContext

## Cél
Központi adatállapot kezelő (publications, articles, validations, layouts, deadlines, workflow). REST API fetch (init) + Appwrite Realtime (live) + write-through API. **Két implementáció**: Plugin (InDesign) és Dashboard.

## Plugin DataContext

### Helye
- **Forrás**: `packages/maestro-indesign/src/core/contexts/DataContext.jsx:67`

### Felület (API)
- **Read**: `publications[]`, `articles[]`, `validations[]`, `layouts[]`, `deadlines[]`, `workflow`, `workflows[]`, `activePublication`, `extensionRegistry`, `activePublicationId`, `isLoading`, `isSwitchingPublication`
- **Write-through**: `createArticle(data)`, `updateArticle(id, data)` (CF-en át), `deleteArticle(id)`, `createValidation`/`updateValidation`/`deleteValidation`
- **Util**: `setActivePublicationId(id)`, `fetchData(isBackground)`, `applyArticleUpdate(doc)` (külső írók — pl. [[WorkflowEngine]] — számára)
- **Hook**: `useData()`

### Belső védelmek
- **`$updatedAt` staleness guard**: Realtime és write-through is ellenőrzi, hogy a helyi adat frissebb-e az incoming payload-nál — megelőzi az optimista update felülírást
- **Fetch generáció-számláló**: párhuzamos `fetchData()` hívások (recovery + pub switch) eredményeit szűri — a régibb generáció eldobódik (no UI jump)

### Workflow extension registry (B.4.2, ADR 0007 Phase 0)
- **Snapshot-preferáló derived state**: `extensionRegistry` az `activePublication.compiledExtensionSnapshot`-ból épül (`buildExtensionRegistry`, [[ExtensionRegistry]]), `useMemo` deps: `$id` + snapshot-string identitás. Workflow-doc Realtime mutáció NEM invalidálja az aktivált pub registry-jét (immutable a pub élettartama alatt).
- **Single-source**: a fogyasztók (`ArticleProperties`, `PropertiesPanel`, [[WorkflowEngine]] `validateTransition`/`executeTransition`, `executeCommand`) ezt a derived state-et használják — egy parse / aktivált pub.
- **Realtime subscribe**: a `workflowExtensions` collection változásait a Plugin Realtime handler debug-logolja és [[MaestroEvent#Workflow extension eseményei B.4.3, ADR 0007 Phase 0|`workflowExtensionsChanged` event]]-tel jelzi — Phase 0-ban consumer NINCS, runtime cache invalidálás NINCS (jövőbeli Designer plugin tab / non-snapshot fallback számára).

## Dashboard DataContext

### Helye
- **Forrás**: `packages/maestro-dashboard/src/contexts/DataContext.jsx`

### Felület (API)
- **Read**: `publications`, `articles`, `layouts`, `deadlines`, `validations`, `workflows` (scope-szűrt aktív lista), `archivedWorkflows`, `archivedWorkflowsError`, `workflowsLoading`, `archivedWorkflowsLoading`, `workflow` (aktív, derived `useMemo` snapshot-fallback-kel), `activePublicationId`, `isLoading`
- **Singleton-ok (context value-n át)**: `databases`, `storage` — egyetlen Appwrite példány a Provider-ben (`new Databases(getClient())` ad-hoc TILOS, ld. [[Fejlesztési szabályok]])
- **Pub váltás**: `switchPublication(id)` — paralel fetch + state-nullázás
- **Fetch**: `fetchPublications()` (paginált, scope-szűrt), `fetchWorkflow()` (org+office+public visibility, scope-szűrt aktív), `fetchArchivedWorkflows()` (scope-eager, dual-list filter-only), `fetchAllOrgWorkflows(orgId)` (opt-in, **nem-cache, nem-Realtime** — pl. CreateEditorialOfficeModal klón-forrás), `fetchAllGroupMembers()` (5 perces cache)
- **Write-through**: `createPublication`/`updatePublication`/`deletePublication`, `createLayout`/`updateLayout`/`deleteLayout` (cascading delete cikkekkel), `createDeadline`/`updateDeadline`/`deleteDeadline`, `updateArticle(id, data)` (CF-en át), `createValidation`/`updateValidation`/`deleteValidation`
- **Util**: `applyArticleUpdate(serverDocument)` (külső írók), `applyPublicationPatchLocal(id, patch)` ([[Döntések/0008-permission-system-and-workflow-driven-groups|ADR 0008]] A.2.9): lokális publikáció state-patch DB hívás nélkül a `activate_publication` / `assign_workflow_to_publication` CF response-jából. Stale-guard: a meglévő `isStaleUpdate` helperrel közös szemantika — ha a lokális rekord szigorúan frissebb (Realtime már megérkezett), a CF response patch SKIP-pel kerülendő. A `$updatedAt` mindig a CF `response.publication.$updatedAt` (autoritatív), különben `now()` fallback. Early-return ha az `id` nincs a publications listában (no-op array-realloc kerülése).

### Race-védelem (refek)
- **`workflowLatestUpdatedAtRef`** (`Map<$id, $updatedAt>`) — globális `$updatedAt` version-check minden workflow-eseményre. Out-of-order Realtime payload-ok stale cross-list upsert-jét blokkolja (`workflows` ↔ `archivedWorkflows` átmenetnél elengedhetetlen)
- **`archivedFetchGenRef`** — `fetchArchivedWorkflows` A→B→A scope-váltás gen-counter, finally-ben gen-guard
- **`fetchWorkflowGenRef`** — `fetchWorkflow` finally-loading-race védelem (régebbi fetch ne oltsa ki a frissebb fetch loading flag-jét). Megjegyzés: a list-override race-fix halasztva, ld. forráskód komment

### Realtime
- 7 collection: ARTICLES, PUBLICATIONS, LAYOUTS, DEADLINES, USER_VALIDATIONS, SYSTEM_VALIDATIONS, WORKFLOWS
- **Subscribe módja**: kötelezően [[RealtimeBus]] `subscribeRealtime()` — NEM közvetlen `client.subscribe()` ([[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]])
- **Scope szűrés**: pub-ok az `activeEditorialOfficeId`-ra; cikkek az `activePublicationId`-ra; validációk csak az aktív pub cikkeire
- **`$updatedAt` staleness guard** (mint a Plugin-é) + globális `workflowLatestUpdatedAtRef` (workflow-eseményekre)
- **`applyWorkflowEvent` 6-arg signature**: `(setWorkflows, setArchivedWorkflows, versionsMap, ...)` — dual-list (aktív + archivált) Realtime handler. Archive↔restore átmenet mindkét listán szinkron, delete a versionsMap entry-t is törli
- **Reconnect-time resync** ([[Döntések/0004-dashboard-realtime-bus]] 2026-05-03 záradék): `subscribeRealtime` `{ onReconnect: resyncRealtimeData }` opció. A `resyncRealtimeData` useCallback `await fetchPublications()` → ha az aktív pub disconnect alatt törlődött, clear-eli a derived state-et (articles / layouts / deadlines / validations / `articleIdsRef`); ha létezik, `switchPublication(activeId)` újrahúzza a child rekordokat. Végül párhuzamos `fetchWorkflow()` + `fetchArchivedWorkflows()`. Hibát warn-olja, nem dobja — más fogyasztók resync-je tovább megy.

### Memoizált context value
A Provider `value` `useMemo`-zott (deps: minden state, singleton, useCallback). Megelőzi az ok nélküli context-consumer re-render-eket olyan komponenseknél, amelyek csak singleton-okat olvasnak (pl. `useContributorGroups`, `CreateEditorialOfficeModal`).

## Kapcsolatok
- **Felhasználói**: minden `useData()`-t hívó komponens; [[ScopeContext]] (TBD); modal-ok (create/update/delete)
- **Függőségei**: [[MaestroEvent]] (event dispatch), [[RealtimeBus]] (Dashboard), [[ConnectionContext]] (Plugin overlay), `databases.*` Appwrite SDK, `callUpdateArticleCF` (server cikk-validáció), `withScope()` helper (Dashboard, organId+officeId inject)
- **Eseményei**: dispatch `dataRefreshRequested`, `articleChanged` stb.

## Gotchas
- **`switchPublication` (Dashboard)** nullázza a derived state-et — pub-váltás után az előző pub adatai eltűnnek
- **`applyArticleUpdate` (mindkettő)** $updatedAt staleness guard + "update-only-if-exists" — pub switch utáni késleltetett szerver-választ eldob
- **Workflow derived (Dashboard)** prefer sorrend: compiled snapshot JSON → workflowId cache → null (fail-closed)

## Kapcsolódó
- [[MaestroEvent]], [[RealtimeBus]], [[ScopeContext]] (TBD), [[ConnectionContext]], [[ExtensionRegistry]]
- [[Döntések/0002-fazis2-dynamic-groups]], [[Döntések/0004-dashboard-realtime-bus]], [[Döntések/0006-workflow-lifecycle-scope]], [[Döntések/0007-workflow-extensions]]
- [[WorkflowLibrary]] (a panel a `archivedWorkflows` + scope-szűrt `workflows` consumer-e)
