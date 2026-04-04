# Maestro - InDesign Plugin

A Maestro egy Adobe InDesign UXP plugin, amely segít hatékonyan kezelni a kiadványokat és cikkeket az Appwrite adatbázis integráción keresztül. A plugin segítségével szerkesztők összehangolhatják munkájukat, nyomon követhetik a munkafolyamatokat, és közvetlenül az InDesign-ból kezelhetik a kiadványok tartalmát.

## ✨ Főbb funkciók

- **Kiadványkezelés**: Kiadványok létrehozása, szerkesztése és törölése
- **Cikkkezelés**: Cikkek hozzáadása kiadványokhoz, tulajdonságok szerkesztése
- **Munkafolyamat-követés**: Cikkek státuszának (Tervezés, Szerkesztés, Tördelés, Kiadásra kész) nyomon követése
- **Valós idejű szinkronizáció**: Azonnali frissítések az Appwrite adatbázisból
- **Csapatmunka**: Szerkesztők, tervezők, írók és képszerkesztők hozzárendelése cikkekhez
- **Fájlkezelés**: Cikkek megnyitása InDesign-ban, automatikus verziókezelés a `.maestro` mappában
- **Kapcsolat-állapot visszajelzés**: Átlátható visszajelzés hálózati problémák esetén

## 🛠️ Technológiai stack

- **Frontend**: React 18 + Hooks
- **UI komponensek**: Adobe Spectrum Web Components (SWC)
- **Build tool**: Webpack 5
- **Backend**: Appwrite (adatbázis, hitelesítés, funkciók)
- **Platform**: Adobe UXP (Unified Extensibility Platform)
- **Target alkalmazás**: Adobe InDesign (ID) 20.0.0+

## 📋 Előfeltételek

1. [Node.js](https://nodejs.org/) (>= v16.0.0)
2. [Yarn package manager](https://yarnpkg.com/getting-started/install)
3. Adobe InDesign (20.0.0 vagy újabb)
4. UXP Developer Tool (UDT) - [Letöltés](https://developer.adobe.com/console/servicesandapis)
5. UXP >= 7.2
6. Appwrite szerver hozzáférés (konfigurációs adatok szükségesek)

## 🚀 Telepítés és fejlesztés

### 1. Függőségek telepítése

```bash
yarn install
```

### 2. Build létrehozása

**Egyszeri build**:
```bash
yarn build
```

**Folyamatos build (watch mode)**:
```bash
yarn watch
```

Ez automatikusan újraépíti a projektet minden forrásfájl módosításnál. A build eredménye a `dist` mappába kerül.

**Telepítés és watch indítása egyben**:
```bash
yarn start
```

### 3. Plugin betöltése InDesign-ba (UDT-vel)

1. Indítsd el az Adobe InDesign-t
2. Nyisd meg a UXP Developer Tool-t
3. Ellenőrizd, hogy InDesign látható-e a "Connected apps" alatt
4. Kattints az **"Add Plugin"** gombra
5. Válaszd ki a projekt gyökérkönyvtárában található `manifest.json` fájlt
6. Konfiguráld a **`dist`** mappát a plugin munkamappaként:
   - Kattints a plugin sorában a `•••` menüre
   - Válaszd "More" → "Advanced"
   - Állítsd be a `dist` mappát
7. Töltsd be a plugint:
   - Kattints a `•••` menüre
   - Válaszd a **"Load"** opciót
8. **(Opcionális)** Automatikus újratöltés fejlesztés közben:
   - Válaszd a **"Watch"** opciót a `•••` menüből
   - Így minden build után automatikusan újratöltődik a plugin
   - **Megjegyzés**: A `manifest.json` változása esetén manuálisan kell "Unload" → "Load" műveletet végezni

### 4. Appwrite konfiguráció

A plugin működéséhez Appwrite backend szükséges. Hozd létre a következő fájlt:

**`src/core/config/appwriteConfig.js`** (példa):

```javascript
export const APPWRITE_ENDPOINT = 'https://your-appwrite-instance.com/v1';
export const APPWRITE_PROJECT_ID = 'your-project-id';
export const DATABASE_ID = 'your-database-id';
export const COLLECTION_PUBLICATIONS = 'publications';
export const COLLECTION_ARTICLES = 'articles';
export const COLLECTION_TEAM_MEMBERS = 'team_members';
```

**Megjegyzés**: Ez a fájl általában `.gitignore`-ban van.

## 📂 Projekt struktúra

```
Maestro/
├── dist/                        # Build kimenet (webpack által generált)
├── src/
│   ├── index.html               # HTML belépési pont
│   ├── index.css                # Globális stílusok (workflow state színek, CSS változók)
│   ├── polyfill.js              # UXP polyfillok
│   │
│   ├── core/                    # Üzleti logika és infrastruktúra
│   │   ├── index.jsx            # App bootstrap, belépési pont
│   │   ├── Main.jsx             # Gyökér komponens (sleep/focus detektálás, RecoveryManager)
│   │   ├── config/              # Appwrite kliens, Realtime, Recovery, MaestroEvent-ek
│   │   ├── contexts/            # React Context-ek (Data, Validation, User, Connection)
│   │   ├── controllers/         # UXP panel életciklus (panelController)
│   │   ├── commands/            # InDesign parancs handlerek (export, preflight, print, stb.)
│   │   └── utils/               # Segédfüggvények, validátorok, InDesign scriptek, workflow
│   │
│   ├── data/                    # Adat hookok (Context ↔ UI híd)
│   │   └── hooks/               # useArticles, usePublications, useWorkflowValidation, stb.
│   │
│   ├── ui/                      # React komponensek
│   │   ├── common/              # Újrafelhasználható elemek (Table, Toast, Loading, stb.)
│   │   └── features/            # Domain-specifikus komponensek
│   │       ├── articles/        # ArticleTable, ArticleProperties
│   │       ├── publications/    # PublicationList, Publication, PublicationProperties
│   │       ├── workspace/       # Workspace, DocumentMonitor, LockManager, PropertiesPanel
│   │       └── user/            # Login
│   │
│   └── assets/                  # Statikus erőforrások (ikonok, stb.)
│
├── appwrite_functions/          # Appwrite Cloud Functions
├── docs/                        # Architektúra dokumentáció
├── manifest.json                # UXP plugin manifest
├── package.json                 # Függőségek (Yarn)
├── webpack.config.js            # Webpack 5 konfiguráció
└── CLAUDE.md                    # Részletes projekt útmutató
```

> **Részletes struktúra**: Ld. `CLAUDE.md` — Project Structure szekció.

## 📖 Használat

### Bejelentkezés

1. Töltsd be a plugint InDesign-ban (Windows → Extensions → Maestro)
2. Add meg az Appwrite bejelentkezési adatokat
3. Sikeres bejelentkezés után megjelenik a fő munkaterület

### Kiadványok kezelése

- **Új kiadvány létrehozása**: Kattints az "Új kiadvány" gombra
- **Kiadvány kibontása**: Kattints a kiadvány nevére a cikkek megtekintéséhez
- **Kiadvány törlése**: Használd a törlés gombot (kuka ikon)

### Cikkek kezelése

- **Új cikk hozzáadása**: Kibontott kiadványnál kattints az "Új cikk" gombra
- **Cikk megnyitása**: Dupla kattintás a cikk során
- **Tulajdonságok szerkesztése**: Dupla kattintás a cikken, majd szerkeszd a mezőket a jobb oldali panelen
  - **Összecsukható szekciók**: Az Általános, Üzenetek és Közreműködők szekciók összecsukhatók a jobb átláthatóság érdekében.
  - **"Kimarad" státusz**: A "Kimarad" jelölőnégyzet bepipálásával a cikk inaktív státuszba kerül, és a szerkesztőfelület letiltásra kerül a véletlen módosítások elkerülése érdekében.
- **Munkafolyamat státusz**: Státusz gomb segítségével változtatható (Tervezés → Szerkesztés → Tördelés → Kiadásra kész)
- **Csapattagok hozzárendelése**: Szerkesztő, tervező, író és képszerkesztő dropdown menükből

### Validáció

A plugin automatikusan validálja a cikkeket:
- ✅ Zöld pipa: Az összes kötelező mező kitöltve
- ⚠️ Sárga felkiáltójel: Hiányos adatok
- ❌ Piros X: Kritikus hibák

## 🔧 Fejlesztői parancsok

```bash
# Függőségek telepítése
yarn install

# Build készítése (production)
yarn build

# Folyamatos build fejlesztéshez
yarn watch

# Telepítés + watch indítása
yarn start

# Plugin betöltése UDT-vel (dist mappából)
yarn uxp:load

# Plugin újratöltése
yarn uxp:reload

# Debug mód indítása
yarn uxp:debug
```

## 🏗️ Építés és debug

### Webpack konfiguráció

A projekt Webpack-et használ a bundle létrehozásához. A `webpack.config.js` tartalmazza a konfigurációt, beleértve:

- **Babel transpilation**: JSX és modern JavaScript transpilálás
- **Alias mapping**: SWC komponensek helyes betöltése UXP környezetben
- **CSS bundling**: SASS támogatás
- **Asset másolás**: Statikus fájlok kezelése

### Source maps

Debug célokra add hozzá a következőt a `webpack.config.js`-hez:

```javascript
devtool: 'eval-cheap-source-map'
```

Ez lehetővé teszi a forrás szintű debuggolást a UXP Developer Tool debug ablakában.

## 🎨 Spectrum Web Components (SWC)

A Maestro a Adobe Spectrum Design System komponenseket használja. Fontos:

- Minden komponens importálása **centralizált** az `index.js`-ben
- Ez megakadályozza a `CustomElementRegistry` duplikált regisztrációs hibákat
- Új komponens hozzáadásakor:
  1. `yarn add @swc-uxp-wrappers/[component-name]`
  2. Importáld az `index.js`-be
  3. **Ne** importáld lokálisan más fájlokban

**SWC verzió megfeleltetés**: A `@swc-uxp-wrappers` komponensek specifikus SWC verziókon alapulnak. Ellenőrizd a [hivatalos dokumentációt](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-spectrum/swc).

## 🌐 Appwrite Cloud Functions

A `appwrite_functions/` mappa tartalmazza a szerver-oldali funkciókat:

| Function | Trigger | Leírás |
|---|---|---|
| **Article Update Guard** | `articles.*.update` | Workflow állapotátmenet + jogosultság + contributor validáció |
| **Validate Article Creation** | `articles.*.create` | publicationId, state, contributor, filePath ellenőrzés |
| **Validate Publication Update** | `publications.*.create/update` | Default contributor ID-k, rootPath formátum |
| **Validate Labels** | `users.*.update` | Érvénytelen capability label-ek automatikus eltávolítása |
| **Cascade Delete** | `articles/publications.*.delete` | Kaszkád törlés (üzenetek, validációk, thumbnailek, layoutok, deadlines) |
| **Cleanup Orphaned Locks** | Schedule: naponta 3:00 UTC | 24h-nál régebbi árva zárolások feloldása |
| **Cleanup Orphaned Thumbnails** | Schedule: vasárnap 4:00 UTC | Storage ↔ DB összehasonlítás, orphaned fájlok törlése |
| **Migrate Legacy Paths** | Manuális | Régi útvonalak kanonikus/relatív konverziója (DRY_RUN=true) |
| **Get Team Members** | Kliens hívás | Csapattagok lekérdezése dropdown menükhöz |

> Részletes üzemeltetési referencia: [`docs/CLOUD_FUNCTIONS.md`](./docs/CLOUD_FUNCTIONS.md)

## 🔐 Jogosultságok

A plugin a következő jogosultságokat igényli (`manifest.json`):

- **localFileSystem**: `fullAccess` - Cikkek megnyitása, `.maestro` mappa kezelése
- **network**: `all` - Appwrite API hívások
- **launchProcess**: Külső alkalmazások indítása (opcionális)

## 🐛 Hibakeresés

### Gyakori problémák

1. **"Custom element already defined" hiba**:
   - Ellenőrizd, hogy nincs-e duplikált SWC import
   - Minden import az `index.js`-ben legyen

2. **Cikkek nem töltődnek be**:
   - Ellenőrizd az Appwrite kapcsolatot
   - Nézd meg a konzol logokat (UDT → Debug)

3. **Fájl nem nyílik meg**:
   - Ellenőrizd, hogy létezik-e a fájl az adott útvonalon
   - Jogosultság probléma lehet: a plugin fullAccess-szel rendelkezik?

4. **Webpack build hiba**:
   - `rm -rf node_modules && yarn install`
   - Ellenőrizd a Node.js verziót

### Logok megtekintése

A UXP Developer Tool Debug ablakában láthatók a konzol logok:

```
UDT → [Plugin neve] → •••  → Debug
```

## 📝 Licensz

Copyright 2023 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0.

---

## 🤝 Közreműködés

A projekt részletes fejlesztési irányelveit a [CONTRIBUTING.md](./CONTRIBUTING.md) fájl tartalmazza.

Kérjük, fejlesztés előtt olvasd el:
- [Development Standards & Workflow](./CONTRIBUTING.md)
- [Naming Conventions](./docs/NAMING_CONVENTIONS.md)

## 📚 További dokumentáció

- [Adobe UXP Documentation](https://developer.adobe.com/indesign/uxp/)
- [Spectrum Web Components](https://opensource.adobe.com/spectrum-web-components/)
- [Appwrite Documentation](https://appwrite.io/docs)
- [React Documentation](https://react.dev/)

---

**Verzió**: 2.1.0
**Utolsó frissítés**: 2026. február
