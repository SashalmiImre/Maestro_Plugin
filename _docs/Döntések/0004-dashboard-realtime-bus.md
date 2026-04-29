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

## Kapcsolódó
- Memory: `dashboard-realtime-bus.md` (2026-04-19)
- Komponens: [[Komponensek/RealtimeBus]]
- ADR-ek: [[0005-dashboard-custom-domain]], [[0003-tenant-team-acl]]
- Hibaelhárítás: [[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]]
