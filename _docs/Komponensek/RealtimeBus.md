---
tags: [komponens, dashboard, realtime]
aliases: [Realtime Bus, subscribeRealtime]
---

# RealtimeBus

## Cél
Egyetlen megosztott Appwrite Realtime subscription a Dashboard összes fogyasztójához. Megkerüli a [[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard|SLOT 0 bug]]-ot, és csillapítja a StrictMode / route-váltás okozta WS churn-t.

## Helye
- **Forrás**: `packages/maestro-dashboard/src/contexts/realtimeBus.js`
- **Bevezetve**: 2026-04-19, [[Döntések/0004-dashboard-realtime-bus]]

## Felület (API)
```js
import { subscribeRealtime, collectionChannel, documentChannel } from '../contexts/realtimeBus.js';

// channels: string | string[]
// callback: (response) => void
const unsubscribe = subscribeRealtime(channels, callback);

// Helperek (ne építs inline string-et)
collectionChannel(COLLECTIONS.ARTICLES);                    // databases.{db}.collections.{col}.documents
documentChannel(COLLECTIONS.WORKFLOWS, workflowDocId);     // doc-szintű
```

## Belső működés
1. **`handlers` Map** module-scope-ban — minden fogyasztó saját csatorna-halmazzal és callback-kel.
2. **`rebuild()`** — 50ms debounce, hogy a StrictMode dupla effect ne építsen újra WS-t.
3. **`doRebuild()`** — kiszámítja a csatornák unióját, összehasonlítja `currentChannels`-szel, csak eltérés esetén teardown + új `client.subscribe()`. Átfedő subscribe → 0 churn.
4. **Event dispatch** — minden bejövő event-re végigmegy a handler-eken; ha a handler csatornái érintik a `response.channels`-t, hívja (try/catch izolálva).

## Kapcsolatok
- **Felhasználói**: [[AuthContext]], [[DataContext]] (Dashboard), `useTenantRealtimeRefresh`, `WorkflowDesignerPage`
- **Függőségei**: Appwrite `client.subscribe`, `databases` singleton
- **Eseményei**: nincs MaestroEvent — direkt callback hívás

## Gotchas
- **Tilos** `client.subscribe()` közvetlenül a dashboard-kódban. Ez a SLOT 1+ mute miatt néma fogyasztót okoz.
- A handler kivételei try/catch-el izoláltak — egy handler hibája nem állítja le a többit.
- A debounce 50ms — gyors policy-választáshoz mérlegelendő.

## Kapcsolódó
- [[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]]
- [[Döntések/0004-dashboard-realtime-bus]]
- [[Döntések/0005-dashboard-custom-domain]]
- Memory: `dashboard-realtime-bus.md`
