# Maestro Workspace

> **Ez egy multi-project monorepo workspace.** Minden fejlesztésnél gondolj a cross-project hatásokra.

---

## Áttekintés

A Maestro rendszer egy szerkesztőségi munkafolyamat-kezelő platform, amely Adobe InDesign (és a jövőben InCopy) pluginokból, egy CORS proxy szerverből, és Appwrite Cloud backend-ből áll.

```
maestro-workspace/
  packages/
    maestro-indesign/    ← Adobe InDesign UXP plugin (React 18 + Appwrite)
    maestro-proxy/       ← CORS/WebSocket proxy szerver (Express)
    maestro-shared/      ← [JÖVŐBELI] Megosztott kód (contexts, hooks, utils, UI)
    maestro-incopy/      ← [JÖVŐBELI] Adobe InCopy UXP plugin
```

---

## Package-ek

| Package | Szerep | Technológia | Deployment |
|---------|--------|-------------|------------|
| `maestro-indesign` | InDesign plugin — szerkesztőségi munkafolyamat, cikkkezelés, zárolás, validáció | React 18, UXP, Webpack, Appwrite SDK | InDesign plugin betöltés (`dist/`) |
| `maestro-proxy` | CORS proxy + WebSocket auth bridge az Appwrite API-hoz | Express, http-proxy-middleware | emago.hu szerveren |
| `maestro-shared` | **[JÖVŐBELI]** Megosztott üzleti logika, adatréteg, UI komponensek | React, Appwrite SDK | Nem önálló — bundled mindkét pluginba |
| `maestro-incopy` | **[JÖVŐBELI]** InCopy plugin — szerkesztői nézet | React 18, UXP, Webpack | InCopy plugin betöltés |

---

## Függőségi Gráf

```
maestro-indesign ──→ maestro-shared (jövőbeli)
maestro-incopy   ──→ maestro-shared (jövőbeli)
maestro-proxy    ──→ (standalone, nincs belső függősége)

Mindkét plugin ──→ maestro-proxy (runtime, hálózaton keresztül)
Mindkét plugin ──→ Appwrite Cloud (a proxy-n át)
```

---

## Cross-Project Hatás Szabályok

| Változás helye | Érintett package-ek | Teendő |
|----------------|---------------------|--------|
| `maestro-proxy` (API, WebSocket kezelés) | `maestro-indesign`, `maestro-incopy` | Mindkét plugin tesztelése szükséges |
| `maestro-shared` (jövőbeli) | `maestro-indesign`, `maestro-incopy` | Mindkét plugin újraépítése + tesztelése |
| `maestro-indesign` (InDesign-specifikus kód) | Csak az InDesign plugin | Nincs cross-project hatás |
| Appwrite collection/function változás | Mindegyik | Proxy + mindkét plugin érintett |
| `appwriteConfig.js` (endpoint, ID-k) | Mindkét plugin (jelenleg csak InDesign) | Ha shared-be kerül: automatikus |

---

## Build & Deploy

### maestro-indesign
```bash
cd packages/maestro-indesign
npm run build          # Production build → dist/
npm run watch          # Development watch mode
npm run uxp:load       # Plugin betöltése InDesign-ba
npm run uxp:reload     # Plugin újratöltése
npm run uxp:debug      # UXP Developer Tool
```

### maestro-proxy
```bash
cd packages/maestro-proxy
node server.js         # Lokális futtatás
# Éles deployment: emago.hu szerverre (külön deploy folyamat)
```

### Workspace szintű (Yarn workspaces)
```bash
# Root-ból:
yarn install           # Minden package függőségeit telepíti
```

---

## Jövőbeli Terv: Kódmegosztás (maestro-shared)

Az InCopy plugin fejlesztésekor a megosztott kódot egy külön `maestro-shared` package-be emeljük ki:

### Megosztható kód (InDesign-specifikus API hívás nélkül)
- **Config**: `appwriteConfig`, `realtimeClient`, `recoveryManager`, `maestroEvents`
- **Contexts**: `DataContext`, `UserContext`, `ConnectionContext`, `ValidationContext`
- **Data hooks**: `usePublications`, `useTeamMembers`, `useDeadlines`, `useLayouts`, `useUnifiedValidation`, stb.
- **Utils**: `workflow/`, `constants`, `errorUtils`, `promiseUtils`, `namingUtils`, `validationRunner`
- **UI common**: `Table`, `Toast`, `Loading`, `ConfirmDialog`, `CustomCheckbox`, `CustomDropdown`
- **UI features**: `publications/`, `user/Login`

### Plugin-specifikus marad
- **InDesign**: `indesign/` utils (ExtendScript), `DocumentMonitor`, `LockManager`, `pathUtils`, specifikus validátorok (`PreflightValidator`, `FileSystemValidator`)
- **InCopy**: InCopy-specifikus API hívások, dokumentumkezelés, specifikus nézetek

### Host Adapter Pattern
Ahol a shared kód host-specifikus műveletet hív (pl. dokumentum megnyitás), egy adapter interfész biztosítja a laza csatolást:
- Shared: `getHostAdapter().openDocument(path)` — generikus hívás
- InDesign: `setHostAdapter({ openDocument: (path) => app.open(path) })` — InDesign implementáció
- InCopy: `setHostAdapter({ openDocument: (path) => /* InCopy API */ })` — InCopy implementáció

---

## Fájlszerkezet Konvenciók

- Minden package saját `package.json`, `manifest.json` (pluginoknál), és `CLAUDE.md` (ha szükséges) fájlokkal rendelkezik
- Részletes architektúra és kódstílus: ld. `packages/maestro-indesign/CLAUDE.md`
- Komment nyelv: **magyar**
- Package manager: **Yarn** (workspace szinten is)
