---
name: review-docs
description: Dokumentáció ellenőrzése commit előtt. Átnézi, hogy a kódváltozások konzisztensek-e a docs/ és CLAUDE.md leírásokkal.
model: haiku
allowed-tools: Bash(git diff *), Bash(git log *), Read, Grep, Glob
---

# Dokumentáció Ellenőrzés Commit Előtt

## Feladat

Ellenőrizd, hogy a staged és unstaged kódváltozások konzisztensek-e a projekt dokumentációval. Használd a leggyorsabb, leggazdaságosabb megközelítést.

## Lépések

### 1. Változások összegyűjtése

Futtasd: `git diff --stat HEAD` és `git diff --cached --stat` a módosított fájlok listájához.

### 2. Érintett dokumentációs fájlok azonosítása

Az alábbi leképezés alapján döntsd el, mely docs fájlokat kell ellenőrizni:

| Ha ezek a fájlok változtak | Ellenőrizd ezeket a docs-okat |
|---|---|
| `src/core/config/appwriteConfig.js`, `realtimeClient.js`, `recoveryManager.js` | `docs/REALTIME_ARCHITECTURE.md`, `docs/PROXY_SERVER.md`, `docs/diagrams/network-architecture.md` |
| `src/core/contexts/DataContext.jsx` | `docs/diagrams/data-flow-architecture.md`, `CLAUDE.md` (DataContext API szekció) |
| `src/core/contexts/UserContext.jsx` | `CLAUDE.md` (UserContext API szekció) |
| `src/core/contexts/ValidationContext.jsx` | `docs/VALIDATION_MECHANISM.md`, `CLAUDE.md` (ValidationContext API) |
| `src/core/config/maestroEvents.js` | `docs/EVENT_ARCHITECTURE.md` |
| `src/core/utils/workflow/*` | `docs/WORKFLOW_CONFIGURATION.md`, `docs/WORKFLOW_PERMISSIONS.md` |
| `src/core/utils/urgencyUtils.js` | `docs/URGENCY_SYSTEM.md` |
| `src/core/utils/validators/*` | `docs/VALIDATION_MECHANISM.md` |
| `src/core/utils/indesign/*` | `docs/diagrams/open-file-flow.md` |
| Bármely új fájl vagy mappa | `CLAUDE.md` (Projektstruktúra szekció) |
| Context provider hierarchia változás | `CLAUDE.md` (Context Provider-ek szekció) |

### 3. Konzisztencia ellenőrzés

Minden érintett docs fájlnál:
- Olvasd el a docs fájlt és a kapcsolódó kódváltozást
- Ellenőrizd: a leírás még helytálló-e a változás után?
- Keress elavult hivatkozásokat (fájlnevek, függvénynevek, paraméterek)

### 4. Eredmény

Adj egy tömör összefoglalót:

**Ha minden rendben:**
> Dokumentáció konzisztens a változásokkal. Commitolható.

**Ha frissítés szükséges:**
> A következő docs fájlok frissítésre szorulnak:
> - `docs/XYZ.md` — [mi hiányzik/elavult]
> - `CLAUDE.md` — [melyik szekció, mi változott]

NE módosíts semmit automatikusan — csak jelezd a problémákat, hogy a fejlesztő dönthessen.
