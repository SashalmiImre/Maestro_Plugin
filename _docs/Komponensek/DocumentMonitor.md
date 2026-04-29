---
tags: [komponens, plugin, monitor]
aliases: [DocumentMonitor]
---

# DocumentMonitor

## Cél
**InDesign dokumentum életciklus-figyelő** — `afterSave` / `afterClose` UXP eventek, háttér-validáció zárás után, a `maestroSkipMonitor` flag tisztelete (programozott save-ek kihagyása).

## Helye
- **Forrás**: `packages/maestro-indesign/src/ui/features/workspace/DocumentMonitor.jsx:1–479`

## Felület (API)
- `verifyDocumentInBackground(filePath, article)` — SYSTEM lock → polling fájl-zár feloldódásig → validátorok futtatása (`registerTask` minta) → unlock with retry
- **Realtime unlock detektálás kétfázisú**: (1) lock tracking (mindig) → `pendingUnlockRef`; (2) unlock feldolgozás (csak ha NEM fut verifikáció)
- Dispatchol `documentSaved` ([[MaestroEvent]]) — validátorok reagálnak; `documentClosed` (`registerTask` mintával)

## Belső védelmek
- **`maestroSkipCount`**: programozott save-ek megkülönböztetése. A plugin saját kódja állítja `window.maestroSkipCount++`-t a save előtt, a save után `--`. A `handleSave` kihagyja, ha `> 0`. Ld. [[Hibaelhárítás#Programozott save → DocumentMonitor visszacsatolás]].
- **`unlockWithRetry`**: 3× 1s→2s→4s, **csak hálózati hiba** (`result?.networkError === true`) — üzleti hiba azonnal visszatér.
- **Timestamp optimalizáció**: `$updatedAt` azonossága kihagyja az ismétlődő validációkat (change detector).
- **`isVerifyingRef.current`**: a [[LockManager]] `handleAfterOpen` nem zárolja a doc-ot, míg validáció fut.

## Kapcsolatok
- **Hívják**: InDesign `afterSave` / `afterClose` event-ek, `useWorkflowValidation` / `useOverlapValidation` hookok (registerTask callback)
- **Hívja**: [[WorkflowEngine]] (SYSTEM `lockDocument`/`unlockDocument`), [[MaestroEvent]] (dispatch), [[CanonicalPath]] (path lookup), `getFileTimestamp` (ExtendScript), `getOpenDocumentPaths`

## Kapcsolódó
- [[LockManager]], [[WorkflowEngine]], [[MaestroEvent]], [[ValidationContext]]
- [[Hibaelhárítás#Programozott save → DocumentMonitor visszacsatolás]]
