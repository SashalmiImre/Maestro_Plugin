---
tags: [komponens, plugin, hálózat, recovery]
aliases: [RecoveryManager, requestRecovery]
---

# RecoveryManager

## Cél
Központi recovery orchestrator — online/offline állapotváltás, alvás-detektálás, Realtime disconnect, focus visszatérés koordinálása. Lock-védelemmel és debounce-szal megakadályozza a párhuzamos recovery futásokat.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/config/recoveryManager.js:25–356`

## Felület (API)
- `requestRecovery(trigger)` — recovery kérés (debounce-olt, lock-védelemmel)
- `cancel()` — in-flight recovery leállítása (shutdown-nál)
- `_healthCheckWithRetry()` — privát, cascading health check

## Recovery ciklus (5 lépés)
1. **Health check (aktív endpoint)** — `maxRetries=3`, exponenciális backoff (1.5s → 3s → 6s). Ha 401 → `sessionExpired` ([[MaestroEvent]]) + return.
2. **Fallback próba** — ha aktív fail → másik endpoint egyetlen retry-mentes próba. Ha OK → [[EndpointManager]] `switchToOther()`.
3. **Realtime reconnect** — `realtime.reconnect()` await-elve (async feliratkozás + `isReconnecting` guard).
4. **Adat frissítés** — `dataRefreshRequested` ([[MaestroEvent]]) → [[DataContext]] REST fetch-et indít.
5. **Debounce frissítés** — `lastRecoveryAt = Date.now()` a `finally`-ben (long retry után se csússzon ki a debounce ablak).

## Védelmek
- **Lock + debounce**: `isRecovering` flag + `lastRecoveryAt` timestamp — szinte 0 esély párhuzamos futásra. Gyors több trigger → egyetlen `_pendingTimeout` ütemezés.
- **`_isCancelled`**: shutdown-kor `cancel()` → in-flight `_executeRecovery` abort. AbortController-ek + ignore-elt promise-ok.

## Kapcsolatok
- **Triggerek**: `online`/`offline` browser event, focus visszatérés, alvás-detektálás (`Date.now()` jump), [[RealtimeClient]] disconnect callback
- **Hívja**: [[EndpointManager]] (health check, switch), [[RealtimeClient]] (`reconnect()`), [[MaestroEvent]] (dispatch)
- **Olvasói**: [[ConnectionContext]] (state update)

## Gotchas
- **Cascading health check race**: ha az aktív endpoint éppen helyreállt, de a fallback request még útban van, az előbbi érkezik elsőként → kedvezőtlen sorrend, de nem kritikus (a következő ciklusban tisztul).
- **Worst case timing**: aktív 3×5s + 1.5s + 3s + fallback 1×5s = ~25s teljes átállás.

## Kapcsolódó
- [[EndpointManager]], [[RealtimeClient]], [[ConnectionContext]], [[MaestroEvent]]
- [[Döntések/0001-dual-proxy-failover]]
