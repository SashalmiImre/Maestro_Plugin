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
