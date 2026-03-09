# /review-docs — Dokumentáció Audit & Javítási Terv

## Módszer
Minden `docs/` fájl tartalmát összevetettem a tényleges forráskóddal. Az alábbiakban szerepelnek a talált eltérések és hiányosságok.

---

## Talált eltérések (Docs vs. Kód)

### 1. `docs/EVENT_ARCHITECTURE.md` — `stateChanged` payload neve helytelen

**Hol:** Esemény Katalógus táblázat, `stateChanged` sor, Payload oszlop

| | Dokumentáció | Valódi kód (`maestroEvents.js:33`) |
|---|---|---|
| Payload | `{ article, oldState, newState }` | `{ article, previousState, newState }` |

**Javítás:** `oldState` → `previousState`

---

### 2. `docs/EVENT_ARCHITECTURE.md` — `authStateChanged` esemény hiányzik

Az `authStateChanged: 'maestro:auth-state-changed'` esemény létezik a kódban (`maestroEvents.js:54`), de **sehol nem szerepel** az EVENT_ARCHITECTURE.md esemény-katalógusában.

**Detail:** `{ isLoggedIn }`  
**Publisher:** `UserContext`  
**Leírás:** Felhasználó bejelentkezett vagy kijelentkezett. A UI routing ennek alapján vált login/workspace nézet között.

**Javítás:** Felvenni a "3. Infrastruktúra & Koordináció" táblázatba.

---

### 3. `docs/WORKFLOW_CONFIGURATION.md` — Preflight példa hiányos `profileFile` option

**Hol:** "Validátor Konfiguráció" szekció, objektumos hivatkozás példája

| | Dokumentáció | Valódi kód (`workflowConstants.js:151,173`) |
|---|---|---|
| options | `{ profile: "Levil" }` | `{ profile: "Levil", profileFile: "Levil.idpp" }` |

**Javítás:** A `profileFile` opciót hozzáadni a példához és megjegyezni, hogy a `StateComplianceValidator` mindkét értéket használja az egyedi azonosításhoz.

---

### 4. `docs/WORKFLOW_PERMISSIONS.md` — Hibás slug formátum a kódpéldában

**Hol:** "Konfiguráció módosítása" → "Új állapot-csapat hozzárendelés" kódblokk

| | Dokumentáció | Valódi kód (`workflowConstants.js:234`) |
|---|---|---|
| Slug formátum | `"art_directors"` (snake_case) | `"artDirectors"` (camelCase) |

**Javítás:** A kódpéldában `"art_directors"` → `"artDirectors"`.

---

### 5. Hiányzó dokumentáció: `MARKERS` enum

A `workflowConstants.js:32–35` tartalmaz egy `MARKERS` bitmaszk enumerációt:

```javascript
export const MARKERS = {
    NONE: 0,
    IGNORE: 1  // cikk ideiglenesen kihagyva a kiadványból
};
```

Ez a rendszer:
- Megjelenik az `URGENCY_SYSTEM.md`-ben (IGNORE marker hivatkozás)
- Megjelenik a `data-flow-architecture.md`-ben (marker szűrés hivatkozás)
- De **nincs leírva sehol**, hogyan kell használni (bitmaszk operátorok, UI kapcsoló, DB mező neve)

**Javítás:** Felvenni a `WORKFLOW_CONFIGURATION.md`-be egy új "Marker Rendszer" szekciót, vagy a `WORKFLOW_PERMISSIONS.md` végére.

---

## Érintett fájlok

| Fájl | Változás típusa |
|------|----------------|
| `docs/EVENT_ARCHITECTURE.md` | `stateChanged` payload javítás + `authStateChanged` sor hozzáadása |
| `docs/WORKFLOW_CONFIGURATION.md` | Preflight `profileFile` option + MARKERS szekció |
| `docs/WORKFLOW_PERMISSIONS.md` | Slug formátum javítás a kódpéldában |

---

## Amit NEM kell módosítani (ellenőrizve, helyes)

- `URGENCY_SYSTEM.md` — `STATE_DURATIONS` értékek egyeznek a kóddal ✓
- `WORKFLOW_PERMISSIONS.md` — `STATE_PERMISSIONS` táblázat helyes ✓
- `WORKFLOW_PERMISSIONS.md` — `TEAM_ARTICLE_FIELD` táblázat helyes ✓
- `REALTIME_ARCHITECTURE.md` — Architecture és konfig leírás helyes ✓
- `PROXY_SERVER.md` — Teljes tartalom naprakész ✓
- `VALIDATION_MECHANISM.md` — Naprakész ✓
- `NAMING_CONVENTIONS.md` — Általános, nem kód-specifikus, naprakész ✓
- `CLAUDE.md` projekt struktúra — Egyezik a tényleges fájlrendszerrel ✓
