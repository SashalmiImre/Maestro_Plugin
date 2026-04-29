---
tags: [komponens, plugin, útvonal, util]
aliases: [CanonicalPath, pathUtils, toCanonicalPath]
---

# CanonicalPath

## Cél
**Cross-platform útvonal-konverter** — Windows (`C:/Volumes/...`) és Mac (`/Volumes/...`) közötti váltás. A DB-ben kanonikus formában (`/ShareName/path`) tárolt útvonalakat alakítja platform-specifikus natív formává és vissza.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/utils/pathUtils.js:145–290`

## Felület (API)
- `toCanonicalPath(nativePath)` — natív → `/ShareName/path` (DB formátum)
- `toNativePath(canonicalPath)` — kanonikus → aktuális platform natív
- `getArticleCanonicalPath(article, publications)` — article relativePath + pub rootPath → kanonikus abszolút
- `toAbsoluteArticlePath(relativePath, canonicalRoot)` — relatív + pub root → natív abszolút
- `toRelativeArticlePath(absolutePath, canonicalRoot)` — abszolút → relatív (pub root-hoz képest)
- `isUnderMountPrefix(nativePath)` → boolean — legalább 1 szinten a megosztás alatt van-e

## Példák
| Bemenet (natív) | Kimenet (kanonikus) |
|---|---|
| `/Volumes/Story/2026/March` (Mac) | `/Story/2026/March` |
| `C:/Volumes/Story/2026/March` (Win) | `/Story/2026/March` |
| `/Story/2026/March` (kanonikus → Mac) | `/Volumes/Story/2026/March` |

## Védelmek
- **Path traversal block**: `toAbsoluteArticlePath()` regex `/(^|\/)\.\.($|\/)` → `..` szegmens elutasítva (no escape from pub root)
- **NFC normalizálás**: `decodeURIComponent()` + `normalize('NFC')` — URI-kódolt és Unicode-variáns útvonalak konzisztensek
- **MOUNT_PREFIX fallback**: ha egyik platform-prefix sem illeszkedik → helyi fájl, natív formátumban marad (nem kanonizálható)
- **`isUnderMountPrefix()`**: folder picker szűréshez — csak a mount prefix alatt **legalább egy alkönyvtár** szinten lévő mappákat lehet beállítani (a `/Volumes` maga nem valós kiadvány gyökér)

## Kapcsolatok
- **Hívják**: [[LockManager]] (path → query variants), [[StateComplianceValidator]] (file existence check), [[WorkflowEngine]] (lock path), publication-kezelő UI

## Kapcsolódó
- [[Architektúra]] (path handling szakasz)
