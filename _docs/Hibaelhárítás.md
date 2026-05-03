---
tags: [referencia, troubleshooting]
aliases: [Troubleshooting, Known Issues]
---

# Hibaelhárítás

Ismert problémák és bevált workaround-jaik. Egy entry = egy H2. A megoldási lépések tegyenek meg fájl-citation-t (`fájl:sor`).

---

## Realtime SLOT 0 routing bug (Dashboard)
**Tünet**: Egyik tab-on átnevezel egy office-t, a másik tab-on nem frissül. Csak a SLOT 0-n levő subscribe kap WS push-ot.
**Ok**: `api.maestro.emago.hu` custom domain + Appwrite Web SDK 24.1.1 per-subscription query format kombinációja: csak az első `client.subscribe()` (slot 0) kap push-t, slot 1+ néma.
**Megoldás**: Soha ne hívd közvetlenül a `client.subscribe()`-ot a dashboardon — minden subscribe a `packages/maestro-dashboard/src/contexts/realtimeBus.js`-ben lévő `subscribeRealtime()`-on keresztül.
Részletek: [[Komponensek/RealtimeBus]], [[Döntések/0004-dashboard-realtime-bus]].

---

## Safari ITP cookie blokkolás (cross-site)
**Tünet**: Safariban a Dashboard Realtime nem működik, Chrome-ban igen. WS upgrade kérésnél nincs session cookie.
**Ok**: Ha az Appwrite endpoint `cloud.appwrite.io` és a Dashboard `maestro.emago.hu` — két különböző registrable domain → Safari ITP cross-site-nak látja, nem küldi a session cookie-t a WS upgrade-en.
**Megoldás**: Custom domain `api.maestro.emago.hu` CNAME → Appwrite Cloud. Mindkét domain ugyanazon `emago.hu` eTLD+1 alatt → first-party cookie. **Ne állítsd vissza** `cloud.appwrite.io`-ra.
Részletek: [[Döntések/0005-dashboard-custom-domain]].

---

## InDesign UXP nem küld custom headert WebSocketnek
**Tünet**: Realtime WS auth fail az InDesign pluginban közvetlen `cloud.appwrite.io` esetén.
**Ok**: UXP böngésző-implementáció: a `WebSocket` nem támogat custom headert az upgrade kérésen. Az Appwrite session cookie-t és X-Appwrite-Project-et nem lehet közvetlenül elküldeni.
**Megoldás**: A Railway/emago.hu proxy `onProxyReqWs`-en injektálja a `Cookie` és `X-Appwrite-*` headereket query paraméterekből (`?x-fallback-cookies=...`). Soha ne kerüld meg a proxyt.
Részletek: [[packages/maestro-proxy/README]], [[Hálózat]].

---

## Apache/Passenger cold start (emago.hu)
**Tünet**: emago.hu fallback proxy első kérése 8–10s után válaszol, timeout-ok elfogynak.
**Ok**: Apache/Passenger idle után újra-spawn-ol a Node folyamatot.
**Megoldás**: A timeout-ok dinamikusak az aktív endpoint alapján — Railway esetén 5–8s, emago.hu-n 15s. Ld. `packages/maestro-indesign/src/config/constants.js`. Ne csökkentsd 15s alá az emago.hu timeout-ot.
Részletek: [[Komponensek/EndpointManager]], [[Döntések/0001-dual-proxy-failover]].

---

## Programozott save → DocumentMonitor visszacsatolás
**Tünet**: A plugin kódja menti a dokumentumot, és ettől a `DocumentMonitor` `afterSave` lefut, és a saját mentésünket idegen mentésnek látja → felesleges thumbnail export, vagy lock konfliktus.
**Ok**: InDesign UXP `afterSave` event nem különbözteti meg a programozott vs. user mentést.
**Megoldás**: `maestroSkipMonitor` flag állítása a save előtt, törlése utána. Mintáért: keress a kódban `maestroSkipMonitor`-ra.
Részletek: [[Szószedet#maestroSkipMonitor]].

---

## Office nélküli szervezetre váltás után stale publikáció / workflow state

**Tünet**: Új szervezetre váltáskor (0 office) az `ArticleTable` nem tűnik el, az onboarding splash sosem jelenik meg. A workflow chip is "kattintható"-nak látszik, de a célállapot nem konzisztens a sibling "Szerkesztőség" dropdown viselkedésével.
**Ok**: `DashboardLayout.jsx:102` scope-effect korai `if (!activeEditorialOfficeId) return;` guard. A `fetchPublications` / `fetchWorkflow` / `switchPublication(null)` null-tolerant — a `setPublications([])`, `setWorkflows([])`, articles/layouts/deadlines/validations clear már mind benne van. A guard redundánsan blokkolja a clear-elést, ezért a `publications.length > 0` miatt az `isOnboarding` (`publications.length === 0`) sose teljesül.
**Megoldás**: A guard-return törlése. A null-tolerant fetch függvények elvégzik a clear-t. Plusz a workflow chip `disabled` állapota a `isWorkflowDisabled = !activeEditorialOfficeId || isOfficeSetupPending` képletre épül (legacy default office + 0 publikáció esetére is).
Részletek: [[Komponensek/DataContext]], [[Komponensek/AuthContext]], [[Döntések/0006-workflow-lifecycle-scope]].

---

## Office nélküli szervezetre váltás után stale publikáció / workflow state
**Tünet**: Új szervezetre váltáskor (0 office vagy "legacy default office" + 0 publikáció) az `ArticleTable` nem tűnik el, az onboarding splash sosem jelenik meg.
**Ok**: `DashboardLayout.jsx` scope-effect korai `if (!activeEditorialOfficeId) return;` guard. A `ScopeContext` stale-ID validáció `setActiveOffice(null)`-ra állít, de a guard ezen az ágon blokkolja a `fetchPublications` / `fetchWorkflow` / `switchPublication(null)` clear-elést — `publications.length > 0` miatt az `isOnboarding` (`publications.length === 0`) sose teljesül.
**Megoldás**: A guard-return eltávolítása. A `fetchPublications()` null office-ra `setPublications([])`-t ad, `fetchWorkflow()` null scope-ra `setWorkflows([])`-t ad, `switchPublication(null)` clearel articles/layouts/deadlines/validations-t — mind null-tolerant, ezért a belső guard redundáns volt.
Részletek: [[Komponensek/DataContext]] (null-tolerant fetch), Feladatok M. szekció #97.

---

## WS reconnect után stale cache (Dashboard)
**Tünet**: Egyik tab-on (vagy másik felhasználó) létrehoz/töröl/átnevez egy rekordot, miközben a saját Dashboard WS-e épp megszakadt (laptop alvás, WiFi switch, custom domain backend bounce). A WS visszakapcsolódik, de a Realtime-vezérelt cache-ek (memberships, aktív kiadvány child rekordjai, csoport listák) a régi állapotot mutatják mount-ig vagy scope-váltásig.
**Ok**: A `client.subscribe()` callback CSAK `event` típusú push-okat lát — a disconnect-ablakban érkezett szerver-mutációk nem érkeznek meg, és a SDK 24.1.1 publikus API-ja nem tesz közzé reconnect signal-t. A Plugin-oldal a [[Döntések/0001-dual-proxy-failover|dual-proxy reconnect-réteg]]-gel védve van; a Dashboard közvetlenül beszél az Appwrite Cloud-dal, így saját reconnect-detektálás kell.
**Megoldás**: `subscribeRealtime(channels, callback, { onReconnect: resync })` — a bus a `client.realtime.createSocket`-et monkey-patch-eli, hogy minden új socket `open` event-jén (kivéve az első kapcsolódást) meghívja a regisztrált `onReconnect` callback-eket. Bekötött fogyasztók (2026-05-03): `AuthContext` (silent membership reload), `DataContext` (`resyncRealtimeData` — publikációk + aktív pub child + workflow listák), `useTenantRealtimeRefresh` (debounce nélküli `reload()`).
Részletek: [[Komponensek/RealtimeBus]] (5. pont: Reconnect-detect), [[Döntések/0004-dashboard-realtime-bus]] (2026-05-03 záradék).
