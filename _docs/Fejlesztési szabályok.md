---
tags: [moc, fejlesztés]
---

# Fejlesztési szabályok

## Konvenciók

- [[NAMING_CONVENTIONS|Elnevezési konvenciók]] — Swift API Design Guidelines adaptálva JS-re
- [[packages/maestro-indesign/CONTRIBUTING|Hozzájárulási szabályzat]] — Dokumentáció policy, PR workflow

## Technológiai stack

| Réteg | InDesign Plugin | Dashboard |
|-------|----------------|-----------|
| UI | React 18 + Spectrum WC | React 18 + Chakra UI |
| Backend | Appwrite (proxyn át) | Appwrite (közvetlen) |
| Bundler | Webpack 5 | Next.js |
| Stílusok | SCSS/CSS | CSS |
| Platform | Adobe UXP | Böngésző |

## Kódstílus összefoglaló

- **Komment nyelv**: Magyar (JSDoc, inline, fájl-fejlécek)
- **Import sorrend**: vendor → context/hooks → config/constants → utils → components
- **Boolean**: `is`, `has`, `can`, `should` prefix
- **Függvények**: felszólító igék akcióknak, főnévi kifejezések transzformációknak
- **Logger**: `log()` / `logError()` / `logWarn()` / `logDebug()` — **soha** `console.*`

## Hibakezelés

- `try/catch` aszinkron műveleteknél
- `isNetworkError()` / `isAuthError()` hibaosztályozás (`errorUtils.js`)
- `withRetry` exponenciális backoff (`promiseUtils.js`)

## UXP Platform sajátosságok

1. Nincs szabványos Cookie kezelés → localStorage session
2. WebSocket: nincs custom header → proxy injection
3. Nincs `window.location`
4. `uxp`, `indesign`, `os` — Webpack externals
5. ExtendScript bridge — string-ként generált scriptek
6. Plugin izoláció — saját `window` objektum
7. InDesign `.idlk` — valódi fájlzár (DB lock informatív)

## Dashboard-specifikus szabályok

- **DataProvider-en kívül `getDatabases()` / `getFunctions()`**: az [[Komponensek/AuthContext]] modul-szintű publikus exportja a hivatalos belépési pont. Tilos `new Databases(getClient())` konstrukció ad-hoc módon (silent dual-instance bug, render-ciklusonként új példány). DataProvider-en BELÜL: `useData().databases` / `.storage`.
- **`useOrgRole(orgId)` hook**: a `callerOrgRole` pattern központi forrása ([[Komponensek/useOrgRole]]) — ne kalkuláld kézzel `orgMemberships.find()`-dal. 3 szemantikai variáns van (active-org / workflow-owner-org / publication-org), ezért **explicit `organizationId` paraméter** (nincs implicit default).

## Dashboard-specifikus szabályok

- **Realtime feliratkozás**: kizárólag [[Komponensek/RealtimeBus]] `subscribeRealtime()`-on keresztül — közvetlen `client.subscribe()` TILOS ([[Döntések/0004-dashboard-realtime-bus]], [[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]]).
- **Appwrite példány DataProvider-en KÍVÜL**: az [[Komponensek/AuthContext]] modul-szintű `getDatabases()` / `getFunctions()` exportja a hivatalos belépési pont. Tilos `new Databases(getClient())` konstrukció ad-hoc módon — silent dual-instance bug-okat okoz.
- **Appwrite példány DataProvider-en BELÜL**: `useData().databases` / `.storage` (a Provider value singleton-ja).
- **`callerOrgRole` pattern**: a `useOrgRole(orgId)` hook ([[Komponensek/useOrgRole]]) a központi forrás — ne kalkuláld kézzel `orgMemberships.find()`-dal.
- **Modal-alapú dialógusok**: natív `window.prompt()` TILOS — `usePrompt` (Promise-alapú) vagy `useCopyDialog` hook a `ModalContext`-ből. Stílusozható, screen reader-friendly, mobil-konzisztens.
- **Tenant collection ACL-pattern**: új `groups`-/`organizationInvites`-/`workflows`-szerű collection-höz `buildOrgAclPerms()` / `buildOfficeAclPerms()` / `buildWorkflowAclPerms()` helper kötelező + `rowSecurity: true` a collection-ön ([[Döntések/0003-tenant-team-acl]], [[Döntések/0006-workflow-lifecycle-scope]]).
