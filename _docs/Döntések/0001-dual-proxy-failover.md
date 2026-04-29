---
tags: [adr, hálózat, proxy, failover]
status: Accepted
date: 2026-02-26
---

# 0001 — Dual-proxy failover (Railway primary + emago.hu fallback)

## Kontextus

Az InDesign UXP plugin nem tud közvetlenül beszélni az Appwrite Cloud-dal — három korlát miatt kell egy proxy:

1. **WebSocket auth**: az UXP böngésző-implementáció nem tud custom headert küldeni a WS upgrade kéréshez. A proxy a query paramokat (`?x-fallback-cookies=...`) headerré konvertálja az Appwrite felé.
2. **Origin header**: az Appwrite Cloud-on `emago.hu` regisztrált web platform-ként → a proxy injektálja az Origin headert.
3. **Cookie injection**: a session UXP-ben `localStorage`-ban van, a proxy konvertálja Cookie header-re.

Az eredeti architektúra **egyetlen `emago.hu` proxy** volt (Apache/Passenger shared hosting). Két fő probléma:
- **Cold start**: idle után 8–10s válaszidő az első kérésre. A timeout-ok nem csökkenthetők 15s alá, holott a normál válaszidő ~0,2s lenne.
- **Single point of failure**: Apache vagy szerver leállás esetén a plugin teljesen leáll.

## Döntés

**Két független proxy: Railway (primary) + emago.hu (fallback).**

| | Railway (primary) | emago.hu (fallback) |
|---|---|---|
| Infra | GCP konténer | Apache/Passenger shared hosting |
| Régió | Frankfurt (közel az Appwrite Cloud FRA-hoz) | EU |
| Válaszidő | ~50–200ms (mindig meleg) | ~0,2s meleg / 8–10s cold start |
| WS támogatás | natív | Apache/Passenger WS proxy réteg |
| SLA | 99.9% (Pro plan) | shared hosting alap |
| Költség | ~$5–10/hó | a többi szolgáltatás miatt amúgy is fut |

A `EndpointManager` singleton kezeli az aktív/fallback váltást, a `RecoveryManager` cascading health check-tel: aktív → másik → offline. Fallback módban minden recovery ciklus ellenőrzi a primary visszatérését — ha igen, automatikus visszakapcsolás.

A timeout-ok dinamikusak az aktív endpoint alapján: Railway-en 5–8s, emago.hu-n 15s (a cold start miatt megőrizve).

## Alternatívák

| Opció | Mellette | Ellene |
|---|---|---|
| **Egyetlen Railway** | Egyszerű, gyors | SPOF — Railway / GCP outage esetén plugin leáll |
| **Egyetlen emago.hu** (status quo) | 0 új infra | Cold start, alkalmi szerver-leállás |
| **Dual-proxy Railway + emago.hu** (választott) | Két független infra → szinte 0 egyidejű kiesés | Két infrastruktúra fenntartása |
| **Degradált mód proxy nélkül** (REST direkt) | Nincs új infra | Realtime helyett polling (15-30s) — UX rosszabb; a `cloud.appwrite.io`-ra direkt kapcsolat ehhez kell, ami CORS/header-szempontból külön kihívás |

A degradált mód **kombinálható** harmadik rétegként (ha mindkét proxy bukik → REST direkt + polling), de az alapdöntés a két független proxy.

## Következmények

- **Pozitív**:
  - Független provider-ek (GCP vs shared hosting) — egyszerre csak az Appwrite Cloud teljes leállása érintene mindkettőt.
  - Cold start eliminálva a Railway primary-vel.
  - Timeout-ok visszacsökkenthetők 15s-ről 5–8s-re az aktív Railway esetén.
- **Negatív / trade-off**:
  - Két infra fenntartása (Railway ~$5–10/hó).
  - Új failover logika — az `EndpointManager` és `RecoveryManager` komplexitása nőtt.
- **Új kötelezettségek**:
  - Railway domain (`gallant-balance-production-b513.up.railway.app`) regisztrálva az Appwrite Console-ban web platform-ként.
  - Új környezet (staging) → új Railway service + új domain regisztráció.
  - A `constants.js` timeout-jainál ügyelni az endpoint-függő különbségre (ne szigorítsd 15s alá az emago.hu fallback-et).

## Implementáció (kulcsfájlok)

| Modul | Felelősség |
|---|---|
| `packages/maestro-indesign/src/config/appwriteConfig.js` | `EndpointManager` singleton — aktív/fallback endpoint, váltás |
| `packages/maestro-indesign/src/services/recoveryManager.js` | Cascading health check (5s timeout, 3 retry, 1.5s→3s→6s backoff) |
| `packages/maestro-indesign/src/services/realtimeClient.js` | Aktív endpoint használata WS-hez |
| `packages/maestro-indesign/src/config/constants.js` | Endpoint-függő timeout-ok (publications/articles/validations 10s, layouts/deadlines 8s, lock 10s; staleness check `REALTIME_STALENESS_MS=45s`) |
| `packages/maestro-proxy/server.js` | Railway-en deployolt Express proxy (ugyanaz a kód, csak `process.env.PORT`) |

### Worst-case recovery
Aktív endpoint 3×5s health check fail + 1,5s + 3s backoff = ~20s; átállás fallback-re: +1×5s = **~25s**. Ennyi alatt a UI offline jelzést kapcsol, majd visszatér online a fallback endpoint-on.

### Deploy
- **Railway CLI**: `npm i -g @railway/cli` → `railway login` → `railway up`. A `server.js` változtatás nélkül fut Railway-en (`process.env.PORT || 3000`).
- Railway projekt: `successful-mindfulness`, service: `gallant-balance`, port `3000`.

## Kapcsolódó
- Memory: `proxy-failover.md` (eredeti tervezési jegyzet)
- Komponens: [[Komponensek/EndpointManager]], [[Komponensek/RecoveryManager]], [[Komponensek/RealtimeClient]]
- Hibaelhárítás: [[Hibaelhárítás#Apache/Passenger cold start (emago.hu)]], [[Hibaelhárítás#InDesign UXP nem küld custom headert WebSocketnek]]
