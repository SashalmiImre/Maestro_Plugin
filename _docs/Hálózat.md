---
tags: [moc, hálózat]
---

# Hálózat & Realtime

## Proxy szerver

- [[PROXY_SERVER|Proxy Server]] — Auth injection, WS ping, hibakezelés
- [[REALTIME_ARCHITECTURE|Realtime architektúra]] — WebSocket proxy auth bridge (UXP limitációk megoldása)

## Hálózati felépítés

- [[network-architecture|Hálózati architektúra diagram]] — Sleep recovery, auto-retry, connection lifecycle

## Dual-Proxy Failover

Railway (primary, EU West Amsterdam, ~0.5s TTFB) + emago.hu (fallback, Apache/Passenger).

- **EndpointManager** singleton — aktív/fallback endpoint váltás
- `switchToFallback()`, `switchToPrimary()`, `switchToOther()`
- `endpointSwitched` MaestroEvent → toast értesítés

## Recovery

- **RecoveryManager** — Központi orchestrator (health check → reconnect → refresh)
- **Triggerek**: online event, sleep detection (gap > 60s), focus, realtime disconnect, panelShown
- **Cascading Health Check**: aktív endpoint retry → fallback egyetlen próba → offline
- **Fetch generáció-számláló** — elavult fetch eredmények eldobása
- **Ghost Socket védelem** — socket generáció-számláló a `realtimeClient.js`-ben

## Session kezelés (UXP sajátosság)

- Nincs szabványos cookie kezelés → `localStorage` (`cookieFallback` kulcs)
- WebSocket auth: URL query paraméterek + proxy injection (`onProxyReqWs`)
- `readyState` guard a UXP timing problémák ellen

## Timeout értékek

| Művelet | Timeout |
|---------|---------|
| Fetch (publications/articles) | 10s |
| Fetch (layouts/deadlines) | 8s |
| Health check | 5s, 3 retry, 1.5s→3s→6s backoff |
| LockManager | 10s + withRetry |
| Staleness check | 45s |
