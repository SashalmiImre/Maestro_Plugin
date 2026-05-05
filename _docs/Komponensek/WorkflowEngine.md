---
tags: [komponens, plugin, workflow]
aliases: [WorkflowEngine]
---

# WorkflowEngine

## Cél
Cikk **állapotátmenet végrehajtó** — validációt kér ([[StateComplianceValidator]]-tól, beleértve workflow extension validátorokat), CF hívást indít (`callUpdateArticleCF`), majd `stateChanged` eventet dispatch-el.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/utils/workflow/workflowEngine.js`

## Felület (API)
- `getAvailableTransitions(workflow, currentState)` → elérhető átmenetek tömbje
- `validateTransition(workflow, article, targetState, pubRootPath, extensionRegistry?)` → `{ isValid, errors[], warnings[] }` (kliens-oldali preflight)
- `executeTransition(workflow, article, targetState, user, pubRootPath, extensionRegistry?)` → `{ success, document?, error?, permissionDenied?, networkError?, validation? }`
- `toggleMarker(article, markerType, user)` — marker bitwise AND/OR (`markers` mező)
- `lockDocument(article, lockType, user)` / `unlockDocument(article, user)` — DB lock-info írás

## Belső
- **Kétlépcsős validáció**: kliens-oldali `validateTransition` csak preflight + extension validátorok; a végleges engedélyezést a CF szerver adja (office scope, workflow state/átmenet, csoporttagság, szerver-oldali konzisztencia)
- **`lockType` enum**: `LOCK_TYPE.USER` (felhasználó szerkeszti) / `LOCK_TYPE.SYSTEM` (Maestro validál) / `null` (feloldva)
- **`extensionRegistry` paraméter (B.4.2, ADR 0007 Phase 0)**: `buildExtensionRegistry(activePublication.compiledExtensionSnapshot)` eredménye — a [[StateComplianceValidator]] `ext.<slug>` ágához. Ha hiányzik (`null`), az `ext.<slug>` validátorok fail-closed `isValid:false`-t adnak (a state-átmenet bukik). A hívók a [[DataContext]] derived `extensionRegistry`-jét adják át.

## Kapcsolatok
- **Hívják**: `ArticleProperties.handleStateTransition` (UI), [[DocumentMonitor]] (`verifyDocumentInBackground` → SYSTEM lock/unlock)
- **Hívja**: `callUpdateArticleCF` (server), [[StateComplianceValidator]] (`validateTransition` — `extensions: extensionRegistry` context-en át), `rtGetAvailableTransitions` (`maestro-shared/workflowRuntime`)
- **Eseményei**: dispatch `stateChanged` ([[MaestroEvent]])

## Gotchas
- **Kliens-validáció ≠ engedélyezés**: a sikeres `validateTransition` NEM jelent garantált sikert — a CF újra ellenőrzi (csoporttagság alapján visszadob `permissionDenied: true` flag-et)
- **Hiányzó `extensionRegistry`**: ha a hívó nem adja át, az `ext.<slug>` validátorokat tartalmazó workflow-állapot átmenetei mindig fail-closed bukás — fő használati hiba

## Kapcsolódó
- [[StateComplianceValidator]], [[DocumentMonitor]], [[LockManager]], [[MaestroEvent]], [[ExtensionRegistry]], [[DataContext]]
- [[Munkafolyamat]]
- [[Döntések/0002-fazis2-dynamic-groups]], [[Döntések/0007-workflow-extensions]]
