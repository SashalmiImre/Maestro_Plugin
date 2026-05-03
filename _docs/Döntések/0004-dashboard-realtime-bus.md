---
tags: [adr, dashboard, realtime]
status: Accepted
date: 2026-04-19
---

# 0004 — Dashboard Realtime Bus (egy megosztott subscription)

## Kontextus
Az [[0005-dashboard-custom-domain|0005 — custom domain]] migráció után (`api.maestro.emago.hu`) Chrome→Safari irányban működött a Dashboard Realtime, Safari→Chrome NEM. A korábbi `cloud.appwrite.io` végponton fordítva volt.

A diagnosztika (manual WebSocket raw test + Chrome DevTools WS inspect) bizonyította:
- Az Appwrite Web SDK 24.1.1 minden `client.subscribe()` hívásnál per-subscription query paramétert ad a WS URL-hez (`channel[slot][]=...`).
- A custom domain proxy az SDK `connected` üzenetben `subscriptions: {slot: uuid}` mappingot ad, az `event` üzenetek `subscriptions: [uuid]` alapján route-olnak slotra.
- Empirikusan: csak a SLOT 0-ra érkeznek események. A SLOT 1-re regisztrált subscribe soha nem kap push-t, holott a `connected` üzenet visszaigazolja.

A Dashboard két subscribe hívást használt — `AuthContext` (4 tenant collection, SLOT 0) + `DataContext` (7 adat collection, SLOT 1, NÉMA).

## Döntés
Egyetlen megosztott subscription a `packages/maestro-dashboard/src/contexts/realtimeBus.js`-ben. **Tilos közvetlen `client.subscribe()` a dashboardon** — minden fogyasztó a `subscribeRealtime(channels, callback)` függvényen át megy.

A bus union-diff guarddal ragadja meg a no-op rebuild-eket, és 50ms debounce-szal kezeli a StrictMode / gyors mount-unmount burst-öket.

## Alternatívák
| Opció | Mellette | Ellene |
|---|---|---|
| Bus refactor (választott) | Stabil minden böngészőn, jövőálló | Egyszeri refactor 4 fogyasztón |
| SDK downgrade (<24) | 0 kód-módosítás | Régebbi Appwrite SDK biztonsági/feature szint |
| Visszatérés `cloud.appwrite.io`-ra | 0 kód-módosítás | Safari ITP törne (lásd 0005 ADR) |

## Következmények
- **Pozitív**: Egy WS, predikálható routing, 50ms debounce csillapít, union-diff guard kifogja a felesleges rebuild-eket.
- **Negatív**: Új konvenció betartása minden új context-ben — egy fejlesztő hibázhat. Mitigáció: lint-szerű review és ez az ADR.
- **Új kötelezettségek**: Új tenant collection vagy doc-szintű subscribe esetén `collectionChannel(col)` / `documentChannel(col, id)` helper.

## Fogyasztók (2026-04-19 állapot)
| Modul | Csatornák | Callback |
|---|---|---|
| `AuthContext.jsx` | 4 tenant collection | 300ms debounce `loadAndSetMemberships()` |
| `DataContext.jsx` | 7 adat collection | per-collection dispatcher |
| `useTenantRealtimeRefresh.js` | 3 group/invite collection | scope-szűrt 300ms debounce reload |
| `WorkflowDesignerPage.jsx` | 1 doc-szintű channel | remote version-ütközés warning |

## 2026-05-03 záradék — Reconnect-time resync (A.4.9 review fix)

### Probléma
A bus a SLOT 0 bug-ot megoldja, de a WS megszakadás-és-újrakapcsolódás ablakában érkező szerver-mutációk nem érkeznek push-ként. A Realtime-vezérelt cache-ek (AuthContext memberships, DataContext aktív kiadvány child rekordok, `useTenantRealtimeRefresh` fogyasztói modálok) néma stale-ben ragadnak a következő mount-ig vagy scope-váltásig. A Plugin-oldal a [[Döntések/0001-dual-proxy-failover|dual-proxy failover]] proxy reconnect-rétegével védve van, a Dashboard közvetlenül beszél az Appwrite Cloud-dal, ezért szimmetrikusan szüksége van saját reconnect-detektálásra.

### SDK ellenőrzés
Az Appwrite Web SDK 24.1.1 `client.subscribe(channels, callback)` **szinkron unsubscribe függvényt** ad vissza — NEM promise-t (a feladatleírás feltételezte). A subscribe callback CSAK `event` típusú push-okat lát; az SDK belső `connected` üzenete és a WS `open`/`close` eventek nincsenek kitéve a publikus API-n. Az egyetlen alacsony szintű hookpont a `client.realtime.socket` WebSocket példány — viszont ez minden reconnect-nél új instance, így nem elég egyszer feliratkozni.

### Döntés
A `subscribeRealtime(channels, callback, options)` kapott egy opcionális `options.onReconnect` callback-et. A bus egyszer (lazy, az első `doRebuild()`-nél) monkey-patch-eli a `client.realtime.createSocket`-et: minden új socket-példányra `open`/`close` listener-t aggat, és a MÁSODIK (vagy későbbi) sikeres `open` után meghívja a regisztrált `onReconnect` callback-eket. Az első `open` (kezdeti kapcsolódás) NEM trigger-eli — a fogyasztók mount-effect-je úgyis lekérte az adatot, fals duplikált fetch-et kerülünk.

Idempotens, fail-safe: ha az SDK `realtime.createSocket` API eltűnik (upgrade), warn-t logolunk és reconnect-detection inaktív marad — a meglévő subscribe továbbra is működik.

### Fogyasztók wiring (2026-05-03)
| Modul | onReconnect viselkedés |
|---|---|
| `AuthContext.jsx` | `loadAndSetMemberships(userId, { silent: true })` — tranziens hiba ne ürítse a már érvényes scope-ot |
| `DataContext.jsx` | `resyncRealtimeData()` — publikációk + aktív pub child rekordok + workflow listák, törölt aktív pub észlelése |
| `useTenantRealtimeRefresh.js` | `reload()` debounce nélkül |
| `WorkflowDesignerPage.jsx` | NINCS (single-doc, az auto-resync letörölné a felhasználó nem mentett változtatásait) |

### Alternatívák (mérlegelt)
| Opció | Mellette | Ellene |
|---|---|---|
| Monkey-patch `createSocket` (választott) | Reaktív, 0 polling overhead, pontosan a WS lifecycle-höz kötve | Az SDK belső API-tól függ — fail-safe csökkenti a kockázatot |
| Polling `client.realtime.socket.readyState` | Nem touch-ol SDK belsőt | 1–2s interval = állandó wakeup; a transition-t könnyű elszalasztani |
| Browser `online` event | Nincs SDK-függés | Coarse signal — nem fed le minden reconnect-okot (heartbeat-fail, 1006) |
| Module-level `realtimeBus.onReconnect()` API | Independent registration, nem subscription-bound | Külön cleanup útvonal, nem természetes a fogyasztó szempontból |

### Nyitva hagyott (jövőbeli munka)
A `useContributorGroups` hook 5 perces module-szintű cache-t tart, de NEM iratkozik fel Realtime-ra (az A.4.9 review feltevése volt — valójában nincs ilyen kód). Ha utólag bekerül a Realtime listening, az `onReconnect` opcióval invalidate + refetch-et kell beállítani. Addig a stale ablak a TTL (5 perc) vagy scope-váltás.

## Kapcsolódó
- Memory: `dashboard-realtime-bus.md` (2026-04-19, frissítve 2026-05-03)
- Komponens: [[Komponensek/RealtimeBus]]
- ADR-ek: [[0001-dual-proxy-failover]] (Plugin reconnect-réteg, aszimmetria-magyarázat), [[0005-dashboard-custom-domain]], [[0003-tenant-team-acl]]
- Hibaelhárítás: [[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]], [[Hibaelhárítás#WS reconnect után stale cache Dashboard]]
