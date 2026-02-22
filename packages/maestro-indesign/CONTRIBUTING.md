# Hozzájárulás a Maestro projekthez

Üdvözlünk a Maestro fejlesztői csapatban! A kódbázis minősége és karbantarthatósága a legfontosabb prioritásunk.

## Dokumentációs Szabályzat

> **Aranyszabály:** A kódmódosításoknak mindig együtt kell járniuk a megfelelő dokumentáció frissítésével.

Ha módosítod a kódlogikát, a következőket kell tenned:
1.  Ellenőrizd, hogy érint-e bármely `.md` fájlt (Architektúra, README, Elnevezési konvenciók).
2.  Frissítsd az érintett dokumentációt **ugyanabban a commitban**.
3.  Ha új funkciót adsz hozzá, szükség esetén hozz létre új dokumentációs fájlt.

> **Nagyobb átalakításoknál** (új feature, architektúra változás, viselkedésmódosítás) az alábbi fájlok frissítése **kötelező**, ha az adott változás érinti őket:
> - `CLAUDE.md` — Architektúra Áttekintés, Kulcs Munkafolyamatok
> - `docs/REALTIME_ARCHITECTURE.md` — WebSocket kapcsolat és auth
> - `docs/EVENT_ARCHITECTURE.md` — Eseményrendszer
> - `docs/diagrams/` — Vizuális diagramok (Mermaid)

### Projekt Dokumentáció Felépítése
- **`README.md`**: Általános áttekintés, telepítés és magas szintű struktúra.
- **`CLAUDE.md`**: Architektúra áttekintés, kulcs munkafolyamatok, projektstruktúra (AI asszisztens kontextus).
- **`docs/NAMING_CONVENTIONS.md`**: Változók, függvények és fájlok elnevezési szabályai.
- **`docs/REALTIME_ARCHITECTURE.md`**: WebSocket proxy auth bridge architektúra.
- **`docs/EVENT_ARCHITECTURE.md`**: MaestroEvent rendszer, esemény katalógus.
- **`docs/diagrams/`**: Vizuális architektúra dokumentáció (Mermaid diagramok).

---

## Fejlesztési Szabványok

### 1. Elnevezési Konvenciók
Szigorúan követjük az alábbi fájlban leírt elnevezési konvenciókat:
[**docs/NAMING_CONVENTIONS.md**](./docs/NAMING_CONVENTIONS.md)

Kérjük, olvasd el ezt a fájlt mielőtt bármilyen kódot írnál.

### 2. Kódstílus

#### Import Csoportosítás
Az importokat csoportosítani kell, üres sorokkal elválasztva, a következő sorrendben:
1.  **Vendor / Framework** (React, külső könyvtárak)
2.  **Belső Context-ek & Hook-ok**
3.  **Konfiguráció & Konstansok**
4.  **Segédfüggvények & Helperek**
5.  **Komponensek & Assetek**

Példa:
```javascript
// React & Harmadik fél
import React, { useState } from "react";

// Context-ek
import { useUser } from "../../contexts/UserContext";

// Segédfüggvények
import { formatDate } from "../../utils/dateUtils";
```

#### Dokumentáció & Kommentek
- **Nyelv**: Magyar
- **Fájl-fejlécek**: Minden fájlnak részletes JSDoc blokkal kell kezdődnie, amely leírja a célját, felelősségeit és fő komponenseit.
- **JSDoc**: Minden függvényhez, osztályhoz és összetett logikai blokkhoz részletes JSDoc kommentek szükségesek.
- **Frissítések**: A kommenteket azonnal frissíteni kell, ha a logika megváltozik.

**Fájl-fejléc példa:**
```javascript
/**
 * @file DocumentMonitor.jsx
 * @description Ez a fájl felelős az InDesign dokumentumok állapotának valós idejű figyeléséért.
 *
 * Fő funkciók:
 * - Mentés események (beforeSave, afterSave) kezelése
 * - Csendes bezárások detektálása (Idle watcher)
 * - Adatszinkronizáció a helyi fájlrendszer és az adatbázis között
 */
```

**Függvény példa:**
```javascript
/**
 * Ellenőrzi a dokumentum állapotát és frissíti az adatbázist.
 * @param {string} path - A fájl abszolút útvonala
 * @returns {Promise<boolean>} Sikerült-e a frissítés
 */
const validateDocument = async (path) => { ... }
```

#### Tiszta Kód
- Kövesd a „Világosság a használat helyén" (Clarity at the point of use) elvet.

---

## Munkafolyamat

1.  **Pull Request**: Jelentős változtatásokhoz mindig használj Pull Request-et.
2.  **Review**: A kód review során ellenőrizd, hogy a `NAMING_CONVENTIONS.md` szabályai be vannak-e tartva.
3.  **Ellenőrzés**: Merge előtt győződj meg róla, hogy a dokumentáció frissítve van.
