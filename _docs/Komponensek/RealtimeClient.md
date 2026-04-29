---
tags: [komponens, plugin, hálózat, realtime]
aliases: [RealtimeClient, realtimeClient]
---

# RealtimeClient

## Cél
Appwrite Realtime WebSocket kliens a UXP / InDesign Plugin-hez. UXP proxy auth-injection (query paraméterek), csatorna-feliratkozás, szerverhiba-backoff, generation guard a "ghost socket" ellen, kényszerített reconnect alvás után. **NEM tévesztendő össze a Dashboard [[RealtimeBus]]-szal**.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/config/realtimeClient.js:57–976`

## Felület (API)
- `subscribe(channel, callback)` → Promise (async feliratkozás, callback Set)
- `unsubscribe(channel, callback)` → callback eltávolítása; ha utolsó → SDK unsub + cleanup
- `reconnect()` → teljes destroy & rebuild
- `disconnect()` → graceful shutdown (szándékos lecsatlakozás)
- `getConnectionStatus()`, `onConnectionChange(cb)`, `onError(cb)`, `isHandshaking()`

## Belső védelmek
- **`_subscribedChannels` Set**: az aktuális socket csatornáit követi. Új feliratkozás (eltérő render ciklus) → ha új csatorna van, **socket lezárás + újraépítés** az összes csatornával. `reconnect()` törli a Set-et.
- **`_socketGeneration` (ghost socket guard)**: minden `createSocket()` inkrementálja, a régi socket close-handler-je ellenőrzi `myGeneration === _socketGeneration` — különben ignore (megelőzi a végtelen reconnect ciklust).
- **`isReconnecting` guard**: a close-handler backoff ciklusa figyeli; ha `reconnect()` már épít újra, kihagyja a saját `createSocket()` hívást.
- **Szerverhiba backoff**: `consecutiveServerErrors` (5 után 60s cooldown). Close 1008 (Policy Violation) → inkrementál; sikeres `event` → nullázás. Általános close → exponenciális backoff (5s→10s→20s→40s→60s max).

## Kapcsolatok
- **Hívják**: [[DataContext]] (subscribe articles, validations stb.), [[RecoveryManager]] (`reconnect()`)
- **Hívja**: [[EndpointManager]] (`getEndpoint()`), Appwrite SDK Realtime
- **Eseményei**: `onConnectionChange` listenerek (deduplikált notify)

## Gotchas
- **UXP `readyState` timing**: az `open` eventben nem garantált, hogy `readyState === OPEN` — auth frame küldése előtt 200ms retry, ha még nem.
- **`_suppressOpenNotify`**: rebuild közben elnyomja a köztes open notification-öket — csak a végleges állapot megy ki a fogyasztóknak.
- **UXP custom header korlát**: a `WebSocket` upgrade-en nem lehet custom headert küldeni — a session cookie és `X-Appwrite-Project` query paraméterekben megy, a proxy konvertálja headerré (ld. [[Hibaelhárítás#InDesign UXP nem küld custom headert WebSocketnek]]).

## Kapcsolódó
- [[EndpointManager]], [[RecoveryManager]], [[DataContext]]
- [[Döntések/0001-dual-proxy-failover]]
- [[Hibaelhárítás#InDesign UXP nem küld custom headert WebSocketnek]]
