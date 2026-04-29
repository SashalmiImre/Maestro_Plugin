---
tags: [komponens, plugin, lock]
aliases: [LockManager]
---

# LockManager

## Cél
**DB-szintű dokumentum-zár** kezelő. Az Appwrite `articles` collection `lockOwnerId` / `lockType` mezőit szinkronizálja az InDesign nyitott fájlokkal (afterOpen/afterClose). **NEM valódi fájlszintű zár** — az InDesign saját `.idlk` fájlja erre szolgál; ez csak informatív DB-flag.

## Helye
- **Forrás**: `packages/maestro-indesign/src/ui/features/workspace/LockManager.jsx:1–650`

## Felület (API)
- `cleanupOrphanedLocks()` — induláskor a saját `user.$id`-jal zárolt sorokat feloldja (`withRetry`)
- `fetchRelevantArticles(openPaths)` — aktuális user által zárolt + megnyitott fájlok lekérése
- `lockFile(path)` / `unlockFile(path)` — egyedi fájl zárolása/feloldása
- `syncLocks()` — szinkronizáció: nyitott ÉS (nincs zár VAGY saját) → ZÁRÁS; NINCS nyitva ÉS saját → FELOLDÁS
- `debouncedSyncLocks(delay)` — 300ms debounce gyors nyitás/zárásra

## Belső védelmek
- **`withRetry`**: 3 próba, 1s→2s→4s exponenciális backoff. **Csak `networkError: true` flag-re** retry-zik (üzleti hiba — pl. permission, idegen lock — azonnal tér vissza)
- **`lockingInProgressRef`**: per-cikk in-flight flag, megakadályozza a duplakattintásos `handleAfterOpen` ÉS `syncLocks` párhuzamos CF hívásait

## Kapcsolatok
- **Hívják**: InDesign `afterOpen` / `afterClose` / `afterSaveAs` event-ek, `handleVerificationStart`/`End` ([[DocumentMonitor]] zárás-szüneteltetés)
- **Hívja**: [[WorkflowEngine]] (`lockDocument`/`unlockDocument`), [[CanonicalPath]] (`nativePathToQueryVariants`), `getOpenDocumentPaths` (ExtendScript)

## Gotchas
- **Realtime nincs**: a lock Realtime-on jön ugyan, de másik user által felszabadított zárat csak a következő `syncLocks` ciklusban (vagy a plugin újraindítás `cleanupOrphanedLocks`-ban) látja
- **`UserContext.user.groupSlugs` perm check**: a lock-állítás engedélyezését a kliens ellenőrzi, a szerver is újra (kétréteg)

## Kapcsolódó
- [[WorkflowEngine]], [[DocumentMonitor]], [[UserContext]], [[CanonicalPath]]
- [[Munkafolyamat]]
