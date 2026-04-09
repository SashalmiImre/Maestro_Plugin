# CLAUDE.md — Maestro Web Dashboard

> A plugin-oldali részletes architektúrát ld. `../maestro-indesign/CLAUDE.md` és `../maestro-indesign/docs/`.

---

## Parancsok

- **Dev szerver**: `npm run dev` — Vite dev szerver HMR-rel
- **Build**: `npm run build` — Production build → `dist/`
- **Preview**: `npm run preview` — Build-elt verzió lokális előnézete
- **Deploy**: `./deploy.sh` — Build + SCP feltöltés `maestro.emago.hu`-ra

---

## Technológiai Stack

| Réteg         | Technológia                                     |
| ------------- | ----------------------------------------------- |
| **UI**        | React 18                                        |
| **Backend**   | Appwrite Cloud (közvetlen, proxy nélkül)        |
| **Realtime**  | Appwrite Web SDK `client.subscribe()` (natív WS)|
| **Bundler**   | Vite                                            |
| **Stílusok**  | CSS (globális, `css/styles.css`)                |
| **Shared**    | `@shared` alias → `../maestro-shared`           |

### Különbségek a plugin-hez képest

| Szempont        | Plugin (InDesign)                      | Dashboard (Web)                    |
| --------------- | -------------------------------------- | ---------------------------------- |
| **Környezet**   | Adobe UXP                              | Böngésző                           |
| **Auth**        | localStorage cookieFallback + proxy    | Natív böngésző cookie-k            |
| **Realtime**    | Proxy auth bridge (WS)                 | Közvetlen Appwrite WS              |
| **Endpoint**    | Dual-proxy failover                    | `cloud.appwrite.io/v1` (közvetlen) |
| **Adatkezelés** | Read-write (CRUD, workflow, lock)      | **Read-only** (csak megjelenítés)  |
| **Bundler**     | Webpack 5                              | Vite                               |

---

## Kódstílus & Konvenciók

A plugin `CLAUDE.md`-ben leírt konvenciók érvényesek itt is:
- **Komment nyelv**: Magyar
- **Import sorrend**: vendor → context/hooks → config/constants → utils → components
- **Boolean elnevezés**: `is`, `has`, `can`, `should` prefixek
- **Logger**: A dashboardon `console.*` elfogadott (nincs UXP logger)

---

## Architektúra

### Context Hierarchia

```
App
└── AuthProvider             ← user, login, logout, session check
    ├── LoginView            (ha nincs user)
    └── ToastProvider        (ha van user)
        └── DataProvider     ← publications, articles, deadlines, validations, Realtime
            └── DashboardView
```

### Villódzás-mentes Renderelés

A korábbi vanilla JS verzió `innerHTML` cserével renderelt → minden Realtime eseménynél az egész tábla/layout villogott. A React VDOM + célzott optimalizációk megoldják:

| Technika                   | Fájl                | Hatás                                            |
| -------------------------- | ------------------- | ------------------------------------------------ |
| `React.memo(ArticleRow)`  | `ArticleRow.jsx`    | Sor csak akkor renderel újra, ha adata változott |
| `React.memo(PageSlot)`    | `PageSlot.jsx`      | `<img>` nem töltődik újra, ha URL nem változik  |
| `useMemo` filteredArticles | `ArticleTable.jsx`  | Szűrés/rendezés csak ha articles/filters változik|
| `useMemo` validationIndex  | `ArticleTable.jsx`  | Validáció indexelés csak ha validations változik |
| `key={article.$id}`       | `ArticleTable.jsx`  | Stabil React kulcs → DOM node megmarad           |
| `key={pageNum}`            | `LayoutView.jsx`    | Stabil kulcs → thumbnail `<img>` megmarad        |
| CSS custom property zoom   | `LayoutView.jsx`    | Zoom re-render nélkül (`--page-width`)           |

### Adatfolyam

```
Appwrite REST (init)  ───→  DataContext state (useState)
                                  ↓
Appwrite Realtime WS  ───→  setArticles(prev => ...) updater
                                  ↓
                            React VDOM diff
                                  ↓
                          Csak a változott <tr> / <PageSlot> frissül
```

**Realtime handler jellemzők:**
- `$updatedAt` elavulás-védelem (stale WS üzenetek eldobása)
- `activePublicationIdRef` — ref-ből olvasás a stabil subscription-höz
- Csak az aktív kiadvány eseményei kerülnek feldolgozásra

---

## Projektstruktúra

```
maestro-dashboard/
├── CLAUDE.md                     ← Ez a fájl
├── index.html                    ← Vite entry point (<div id="root">)
├── package.json                  ← React, Vite, Appwrite deps
├── vite.config.js                ← @shared alias konfig
├── deploy.sh                     ← Build + SCP deploy (maestro.emago.hu)
│
├── css/
│   └── styles.css                ← Globális stílusok (dark theme, responsive)
│
├── src/
│   ├── main.jsx                  ← ReactDOM.createRoot + CSS import
│   ├── App.jsx                   ← AuthProvider → login/dashboard routing
│   ├── config.js                 ← Re-exportok @shared-ból + dashboard konstansok
│   │
│   ├── contexts/
│   │   ├── AuthContext.jsx       ← user, login(), logout(), checkSession()
│   │   ├── DataContext.jsx       ← publications, articles, deadlines, validations + Realtime
│   │   └── ToastContext.jsx      ← showToast(message, type, duration)
│   │
│   ├── hooks/
│   │   ├── useFilters.js         ← Szűrő állapot (localStorage perzisztált)
│   │   └── useUrgency.js         ← Sürgősség batch-számítás (5 perces timer)
│   │
│   └── components/
│       ├── LoginView.jsx         ← Bejelentkezés form
│       ├── DashboardView.jsx     ← Fő layout (sidebar + content + szűrők)
│       ├── DashboardHeader.jsx   ← Felhasználónév + kijelentkezés
│       ├── Sidebar.jsx           ← Kiadvány lista (oldalsáv + mobil dropdown)
│       ├── ContentHeader.jsx     ← Cím, nézet váltó, cikkszám, szűrő gomb
│       ├── FilterBar.jsx         ← Státusz checkboxok, kimarad, saját cikkek
│       ├── ArticleTable.jsx      ← Tábla nézet (rendezés, urgency, validáció)
│       ├── ArticleRow.jsx        ← ★ React.memo egyetlen sor
│       ├── LayoutView.jsx        ← Flatplan nézet (zoom, spreadek)
│       └── PageSlot.jsx          ← ★ React.memo egyetlen oldal-slot
│
├── shared -> ../maestro-shared   ← Symlink a közös csomagra
└── dist/                         ← Vite build output (gitignore-olt)
```

---

## Context API-k

### AuthContext
- `user` — aktuális felhasználó objektum (vagy `null`)
- `loading` — session ellenőrzés folyamatban
- `login(email, password)` — bejelentkezés + csapattagság lekérés
- `logout()` — session törlés

### DataContext
- `publications`, `articles`, `deadlines`, `validations` — adat tömbök
- `activePublicationId` — kiválasztott kiadvány ID
- `isLoading` — adatlekérés folyamatban
- `storage` — Appwrite Storage (thumbnail URL-ekhez)
- `fetchPublications()` — lapozásos kiadvány lekérés
- `switchPublication(id)` — párhuzamos fetch (articles + deadlines + validations)
- `fetchAllTeamMembers()` — Cloud Function, 5 perces cache
- `getMemberName(userId)` — cache-ből feloldás

### ToastContext
- `showToast(message, type, duration)` — toast értesítés

---

## Shared Csomag (`maestro-shared`)

A `@shared` Vite alias a `../maestro-shared` mappára mutat. Tartalom:

| Fájl               | Export                                                                     |
| ------------------ | -------------------------------------------------------------------------- |
| `appwriteIds.js`   | `APPWRITE_PROJECT_ID`, `DATABASE_ID`, `COLLECTIONS`, `TEAMS`, `BUCKETS`    |
| `workflowConfig.js`| `WORKFLOW_STATES`, `MARKERS`, `STATUS_LABELS`, `STATUS_COLORS`                       |
| `contributorHelpers.js` | `parseContributors`, `getContributor`, `setContributor`, `isContributor`        |
| `constants.js`     | `LOCK_TYPE`, `VALIDATION_TYPES`                                            |
| `urgency.js`       | `fetchHolidays`, `calculateUrgencyRatio`, `getUrgencyBackground`           |

---

## Deploy

**Cél szerver**: `emagohu@emago.hu:~/maestro.emago.hu`
**URL**: `https://maestro.emago.hu/`

A `deploy.sh` automatikusan:
1. `npm run build` (Vite production)
2. Törli a szerveren a régi fájlokat (`js/`, `css/`, `shared/`, `assets/`)
3. Feltölti a `dist/index.html` + `dist/assets/` mappát

A `shared/` többé nem kell külön — Vite bebundolja a build-be.
