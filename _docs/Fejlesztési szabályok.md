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
