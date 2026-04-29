---
tags: [komponens, plugin, workflow]
aliases: [WorkflowEngine]
---

# WorkflowEngine

## Cél
Cikk **állapotátmenet végrehajtó** — validációt kér ([[StateComplianceValidator]]-tól), CF hívást indít (`callUpdateArticleCF`), majd `stateChanged` eventet dispatch-el.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/utils/workflow/workflowEngine.js:1–238`

## Felület (API)
- `getAvailableTransitions(workflow, currentState)` → elérhető átmenetek tömbje
- `validateTransition(workflow, article, targetState, pubRootPath)` → `{ isValid, errors[], warnings[] }` (kliens-oldali preflight)
- `executeTransition(workflow, article, targetState, user, pubRootPath)` → `{ success, document?, error?, permissionDenied?, validation? }`
- `toggleMarker(article, markerType, user)` — marker bitwise AND/OR (`markers` mező)
- `lockDocument(article, lockType, user)` / `unlockDocument(article, user)` — DB lock-info írás

## Belső
- **Kétlépcsős validáció**: kliens-oldali `validateTransition` csak preflight; a végleges engedélyezést a CF szerver adja (office scope, workflow state/átmenet, csoporttagság, szerver-oldali konzisztencia)
- **`lockType` enum**: `LOCK_TYPE.USER` (felhasználó szerkeszti) / `LOCK_TYPE.SYSTEM` (Maestro validál) / `null` (feloldva)

## Kapcsolatok
- **Hívják**: `ArticleProperties.handleStateTransition` (UI), [[DocumentMonitor]] (`verifyDocumentInBackground` → SYSTEM lock/unlock)
- **Hívja**: `callUpdateArticleCF` (server), [[StateComplianceValidator]] (`validateTransition`), `rtGetAvailableTransitions` (`maestro-shared/workflowRuntime`)
- **Eseményei**: dispatch `stateChanged` ([[MaestroEvent]])

## Gotchas
- **Kliens-validáció ≠ engedélyezés**: a sikeres `validateTransition` NEM jelent garantált sikert — a CF újra ellenőrzi (csoporttagság alapján visszadob `permissionDenied: true` flag-et)

## Kapcsolódó
- [[StateComplianceValidator]], [[DocumentMonitor]], [[LockManager]], [[MaestroEvent]]
- [[Munkafolyamat]]
- [[Döntések/0002-fazis2-dynamic-groups]]
