---
tags: [komponens, plugin, hálózat, proxy]
aliases: [EndpointManager, appwriteConfig]
---

# EndpointManager

## Cél
Singleton proxy endpoint failover — Railway (primary) vs. emago.hu (fallback) közötti automatikus váltás az InDesign Plugin oldalán.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/config/appwriteConfig.js:45–102`
- **Bevezetve**: 2026-02-26, [[Döntések/0001-dual-proxy-failover]]

## Felület (API)
- `getEndpoint()` — aktuális aktív endpoint URL
- `switchToFallback()` — Railway → emago.hu (Appwrite client `setEndpoint()` monkey-patch + `endpointSwitched` MaestroEvent)
- `switchToPrimary()` — emago.hu → Railway (ugyanaz a flow)
- `getHealthEndpoint()` — health check URL (`/v1/health`)
- `getProxyBase()` — proxy gyökér (`/v1` suffix nélkül, AI & helper endpointokhoz)

## Mikor vált
- **Primary → Fallback**: aktív endpoint `maxRetries` (3) után nem 200 (és nem 401 session) → switch + log `[EndpointManager] Átkapcsolás fallback-re`
- **Fallback → Primary**: fallback módban a [[RecoveryManager]] minden ciklusban próbál egy retry-mentes primary health check-et — ha 200 → automatikus return
- **Throttle**: a primary prioritás marad, csak az aktív endpoint 3× retry után vált át a másikra (DNS delay nem okoz felesleges flap-et)

## Kapcsolatok
- **Hívják**: [[RecoveryManager]] (health check), [[RealtimeClient]] (init), Appwrite Client (`setEndpoint`, monkey-patch)
- **Eseményei**: dispatch `endpointSwitched` ([[MaestroEvent]]) — UI toast figyeli

## Gotchas
- **Fallback → Primary próba: nincs `sessionExpired` dispatch** — a fallback session él, így a primary visszatérés-próba 401-je NEM jelent valódi session-lejáratot (kihagyott `sessionExpired` MaestroEvent).

## Kapcsolódó
- [[RecoveryManager]], [[RealtimeClient]], [[MaestroEvent]]
- [[Döntések/0001-dual-proxy-failover]]
- [[Hálózat]]
