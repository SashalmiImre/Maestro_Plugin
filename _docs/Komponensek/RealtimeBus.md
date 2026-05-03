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
// options.onReconnect?: () => void  — opcionális, WS reconnect-kor (NEM kezdeti kapcsolódáskor) hívódik
const unsubscribe = subscribeRealtime(channels, callback, { onReconnect: refetch });

// Helperek (ne építs inline string-et)
collectionChannel(COLLECTIONS.ARTICLES);                    // databases.{db}.collections.{col}.documents
documentChannel(COLLECTIONS.WORKFLOWS, workflowDocId);     // doc-szintű
```

`options.onReconnect` használata: a fogyasztó cache-ének invalidálása + adatok újratöltése reconnect után. A disconnect-ablakban érkezett szerver-mutációk nem érkeznek push-ként; az `onReconnect` callback ezt a stale-ablakot zárja le. Az unsubscribe-bal együtt automatikusan eltávolítódik.

## Belső működés
1. **`handlers` Map** module-scope-ban — minden fogyasztó saját csatorna-halmazzal és callback-kel.
2. **`rebuild()`** — 50ms debounce, hogy a StrictMode dupla effect ne építsen újra WS-t.
3. **`doRebuild()`** — kiszámítja a csatornák unióját, összehasonlítja `currentChannels`-szel, csak eltérés esetén teardown + új `client.subscribe()`. Átfedő subscribe → 0 churn. Az első futáskor lazy felaggatja a `installSocketHook()`-ot.
4. **Event dispatch** — minden bejövő event-re végigmegy a handler-eken; ha a handler csatornái érintik a `response.channels`-t, hívja (try/catch izolálva).
5. **Reconnect-detect (`installSocketHook()`, A.4.9 review fix)** — egyszer monkey-patch-eli a `client.realtime.createSocket()`-et, hogy minden új socket-példányra `open`/`close` listener-t aggasson. A SDK 24.1.1 publikus subscribe API-ja nem ad reconnect callback-et (`subscribe()` szinkron unsubscribe-ot ad vissza, nem promise-t), és a `realtime.socket` minden reconnect-nél új példány — emiatt a `createSocket` az egyetlen kontrollált hookpont. Az első `open` NEM tüzeli az `onReconnect`-eket (kezdeti kapcsolódás, fals duplikált fetch elkerülése), csak a `hasBeenConnected && pendingResync` állapot. Idempotens, fail-safe (ha az SDK API eltűnik, warn + skip).

## Kapcsolatok
- **Felhasználói**: [[AuthContext]], [[DataContext]] (Dashboard), `useTenantRealtimeRefresh`, `WorkflowDesignerPage`
- **Függőségei**: Appwrite `client.subscribe`, `client.realtime.createSocket` (monkey-patch hookpont), `databases` singleton
- **Eseményei**: nincs MaestroEvent — direkt callback hívás

## Gotchas
- **Tilos** `client.subscribe()` közvetlenül a dashboard-kódban. Ez a SLOT 1+ mute miatt néma fogyasztót okoz.
- A handler kivételei try/catch-el izoláltak — egy handler hibája nem állítja le a többit.
- A debounce 50ms — gyors policy-választáshoz mérlegelendő.
- `onReconnect` callback **nem** debounce-olt — a SDK belső reconnect retry backoff-ja már szabályozza a frekvenciát; a fogyasztói fetch függvénynek idempotensnek kell lennie (vagy belső generation-guard-ot használnia, mint pl. `fetchArchivedWorkflows` `archivedFetchGenRef`).
- Single-doc subscribe (pl. `WorkflowDesignerPage`) NE használjon `onReconnect`-et automatikus refetch-re, ha a doc-ot a felhasználó éppen szerkeszti — letörölné a nem mentett változtatásokat.

## Kapcsolódó
- [[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]]
- [[Hibaelhárítás#WS reconnect után stale cache Dashboard]]
- [[Döntések/0004-dashboard-realtime-bus]] (2026-05-03 záradék: reconnect-time resync)
- [[Döntések/0005-dashboard-custom-domain]]
- [[Döntések/0001-dual-proxy-failover]] (Plugin proxy reconnect — aszimmetria)
- Memory: `dashboard-realtime-bus.md`
