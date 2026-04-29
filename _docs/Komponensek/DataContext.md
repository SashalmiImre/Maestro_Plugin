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
- **Read**: `publications[]`, `articles[]`, `validations[]`, `layouts[]`, `deadlines[]`, `workflow`, `activePublicationId`, `isLoading`, `isSwitchingPublication`
- **Write-through**: `createArticle(data)`, `updateArticle(id, data)` (CF-en át), `deleteArticle(id)`, `createValidation`/`updateValidation`/`deleteValidation`
- **Util**: `setActivePublicationId(id)`, `fetchData(isBackground)`, `applyArticleUpdate(doc)` (külső írók — pl. [[WorkflowEngine]] — számára)
- **Hook**: `useData()`

### Belső védelmek
- **`$updatedAt` staleness guard**: Realtime és write-through is ellenőrzi, hogy a helyi adat frissebb-e az incoming payload-nál — megelőzi az optimista update felülírást
- **Fetch generáció-számláló**: párhuzamos `fetchData()` hívások (recovery + pub switch) eredményeit szűri — a régibb generáció eldobódik (no UI jump)

## Dashboard DataContext

### Helye
- **Forrás**: `packages/maestro-dashboard/src/contexts/DataContext.jsx`

### Felület (API)
- **Read**: `publications`, `articles`, `layouts`, `deadlines`, `validations`, `workflows` (office összes), `workflow` (aktív, derived `useMemo` snapshot-fallback-kel), `activePublicationId`, `isLoading`
- **Pub váltás**: `switchPublication(id)` — paralel fetch + state-nullázás
- **Fetch**: `fetchPublications()` (paginált, scope-szűrt), `fetchWorkflow()` (org+office visibility), `fetchAllOrgWorkflows()` (admin, klón forrás), `fetchAllGroupMembers()` (5 perces cache)
- **Write-through**: `createPublication`/`updatePublication`/`deletePublication`, `createLayout`/`updateLayout`/`deleteLayout` (cascading delete cikkekkel), `createDeadline`/`updateDeadline`/`deleteDeadline`, `updateArticle(id, data)` (CF-en át), `createValidation`/`updateValidation`/`deleteValidation`
- **Util**: `applyArticleUpdate(serverDocument)` (külső írók)

### Realtime
- 7 collection: ARTICLES, PUBLICATIONS, LAYOUTS, DEADLINES, USER_VALIDATIONS, SYSTEM_VALIDATIONS, WORKFLOWS
- **Subscribe módja**: kötelezően [[RealtimeBus]] `subscribeRealtime()` — NEM közvetlen `client.subscribe()` ([[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]])
- **Scope szűrés**: pub-ok az `activeEditorialOfficeId`-ra; cikkek az `activePublicationId`-ra; validációk csak az aktív pub cikkeire
- **`$updatedAt` staleness guard** (mint a Plugin-é)

## Kapcsolatok
- **Felhasználói**: minden `useData()`-t hívó komponens; [[ScopeContext]] (TBD); modal-ok (create/update/delete)
- **Függőségei**: [[MaestroEvent]] (event dispatch), [[RealtimeBus]] (Dashboard), [[ConnectionContext]] (Plugin overlay), `databases.*` Appwrite SDK, `callUpdateArticleCF` (server cikk-validáció), `withScope()` helper (Dashboard, organId+officeId inject)
- **Eseményei**: dispatch `dataRefreshRequested`, `articleChanged` stb.

## Gotchas
- **`switchPublication` (Dashboard)** nullázza a derived state-et — pub-váltás után az előző pub adatai eltűnnek
- **`applyArticleUpdate` (mindkettő)** $updatedAt staleness guard + "update-only-if-exists" — pub switch utáni késleltetett szerver-választ eldob
- **Workflow derived (Dashboard)** prefer sorrend: compiled snapshot JSON → workflowId cache → null (fail-closed)

## Kapcsolódó
- [[MaestroEvent]], [[RealtimeBus]], [[ScopeContext]] (TBD), [[ConnectionContext]]
- [[Döntések/0002-fazis2-dynamic-groups]], [[Döntések/0004-dashboard-realtime-bus]]
