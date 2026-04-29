---
tags: [komponens, plugin, validáció]
aliases: [ValidationContext, useValidation]
---

# ValidationContext

## Cél
Validációs eredmények (rendszer + felhasználói üzenetek) **forrásonkénti (source-aware) tárolása**, és cikk-szintű, összefésült Map-ben szolgáltatása az UI számára.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/contexts/ValidationContext.jsx:43`

## Felület (API)
- **Read**: `validationResults` Map (articleId → Array<ValidationItem>) — összefésült view memo-ban
- **Write (cikk-szintű)**: `updateArticleValidation(articleId, source, items)` — egy forrás felülírása egy cikkre
- **Write (pub-szintű)**: `updatePublicationValidation(resultsMap, allArticleIds, source)` — batch egész pub-ra
- **Clear**: `clearArticleValidation(articleId, source?)` — egy forrás vagy a teljes cikk törlése
- **Hook**: `useValidation()`

## Belső struktúra
- `Map<articleId, Map<source, items>>` belül — külső összefésülés `useMemo`-ban
- Ha egy cikk **összes** forrása üres, a cikk törlődik a Map-ből (GC, nincs monoton mem-növekedés)
- **Scope-váltás reset**: a `scopeChanged` eventre a teljes belső Map törlődik (különben az idegen office articleId-jai rekednének, holott a `validationResults` memo már nem mutatna rájuk)

## Kapcsolatok
- **Hívják (write)**: `useWorkflowValidation`, `useOverlapValidation`, `useDatabaseIntegrityValidation`, `useUnifiedValidation` hookok — a validáció eredményeit `updateX`-szel commit-olják
- **Olvasói**: `ValidationSection` UI (oldal-szinten összefésült listát mutat)
- **Eseményei**: figyel `scopeChanged` ([[MaestroEvent]])

## Gotchas
- **Source-megőrzés**: egy cikknek lehet több forrásból (workflow / overlap / DB integrity) eltérő `severity`-jű üzenete; a Map minden forrást külön tárol, hogy egy validátor `clearArticleValidation(articleId, source)`-szal csak a sajátját törölhesse.

## Kapcsolódó
- [[DataContext]], [[MaestroEvent]], [[StateComplianceValidator]]
- [[Munkafolyamat]]
