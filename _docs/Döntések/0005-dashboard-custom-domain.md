---
tags: [adr, dashboard, hálózat, cookies]
status: Accepted
date: 2026-04-19
---

# 0005 — Dashboard custom domain (api.maestro.emago.hu)

## Kontextus

A Dashboard (`maestro.emago.hu`) eredetileg közvetlenül a `cloud.appwrite.io`-t használta Appwrite endpoint-ként. Két modern böngésző-platform változás miatt ez törött:

1. **Safari ITP (Intelligent Tracking Prevention)**: ha az Appwrite endpoint és a Dashboard origin két külön **registrable domain** (`cloud.appwrite.io` vs `maestro.emago.hu`), Safari a session cookie-t cross-site-nak látja. A WS upgrade kérésnél a cookie nem megy → Realtime push nem jön. Csak Safariban — Chrome ezt nem látta.
2. **Chrome 3rd-party cookie phaseout**: 2024-25-ös time-line-on a Chrome is fokozatosan tiltja a 3rd-party cookie-kat → ugyanez a tünet kerülne elő idővel Chrome-ban is.

A REST API működött (a session cookie-t nem igényli — `X-Fallback-Cookies` headert használ), de a Realtime WS kötelezően cookie-alapú auth-ot használ.

## Döntés

**Custom domain `api.maestro.emago.hu` CNAME → Appwrite Cloud (`*.appwrite.global`).**

Mivel a `api.maestro.emago.hu` és `maestro.emago.hu` **ugyanazon `emago.hu` eTLD+1** alatt vannak, az Appwrite session cookie first-party cookie-nak minősül — minden böngésző (Safari is) küldi a WS upgrade-en.

### Konfiguráció
- **CNAME**: `api.maestro.emago.hu` → `*.appwrite.global` (DNS-szinten)
- **Env var**: `VITE_APPWRITE_ENDPOINT=https://api.maestro.emago.hu/v1` (`packages/maestro-dashboard/.env.production`)
- **Default fallback** a kódban: `cloud.appwrite.io/v1` — ha env nincs beállítva (dev környezetben elfogadható)
- **Forrás**: `packages/maestro-dashboard/src/config.js:27`
- **Appwrite Console**: a Project Platform whitelist-en a **Dashboard origin** (`maestro.emago.hu`) szerepel — **nem** a custom domain. A Platform az origin alapú CORS-ot vezérli, nem az Appwrite endpoint hostot.

## Alternatívák

| Opció | Mellette | Ellene |
|---|---|---|
| **Visszatérés `cloud.appwrite.io`-ra** (status quo) | 0 setup | Safari Realtime nem működik; Chrome is fog törni a 3rd-party phaseout során |
| **Saját Appwrite hosting** (self-hosted) | Teljes kontroll | Ops/karbantartás teher; nem skálázható csapathoz |
| **Custom domain CNAME** (választott) | First-party cookie minden böngészőben; minimális setup | DNS / SSL setup egyszer |

## Következmények

- **Pozitív**: Realtime working minden böngészőben (Safari is). Jövőálló a Chrome 3rd-party phaseout-ra.
- **Negatív / trade-off**: A Dashboard endpoint **nem cserélhető vissza** `cloud.appwrite.io`-ra anélkül, hogy a Safari Realtime ne törne.
- **Új kötelezettségek**:
  - **Új környezet** (pl. staging) → új CNAME az adott env DNS-én (`api-staging.maestro.emago.hu`).
  - **Az Appwrite Console Project Platform whitelist-en** a Dashboard origin (`maestro.emago.hu`) — NEM a custom domain.
  - **A Plugin (UXP InDesign) NEM érintett** — ott a Railway dual-proxy fut ([[0001-dual-proxy-failover]]) más okokból (custom header injection). A két proxy/domain rendszer független.

### Mellékhatás: SLOT 1 Realtime routing bug
A custom domain migráció **leleplezett** egy korábban ismeretlen Appwrite Web SDK 24.1.1 viselkedést: a per-subscription query formátumon csak a SLOT 0-ra (első `client.subscribe()`) érkeznek WS események. A Dashboard két subscribe hívása (`AuthContext` + `DataContext`) miatt a `DataContext` SLOT 1-re került és néma lett — rename eventek eltűntek. Ez nem közvetlenül a custom domain következménye, de a migráció előtti `cloud.appwrite.io` kombinációban a routing más volt, és ezt a bug-ot elfedte.

**Külön ADR**: [[0004-dashboard-realtime-bus]] — egyetlen megosztott subscription consolidation.

## Kapcsolódó
- Memory: `dashboard-custom-domain.md` (2026-04-19)
- ADR-ek: [[0001-dual-proxy-failover]] (független Plugin proxy), [[0004-dashboard-realtime-bus]] (mellékhatás-fix)
- Hibaelhárítás: [[Hibaelhárítás#Safari ITP cookie blokkolás (cross-site)]]
