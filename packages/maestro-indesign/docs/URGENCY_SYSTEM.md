# Sürgősség-számítási rendszer

A Maestro plugin sürgősség-rendszere valós időben számítja ki, hogy egy adott cikk elkészítése mennyire sürgős a lapzártáig hátralévő munkaidő és a hátralévő munkafolyamat-állapotok becsült időigénye alapján. A végeredmény egy progresszív színsáv az `ArticleTable` soraiban, amely sárgától pirosig jelzi a sürgősséget.

---

## Architektúra áttekintés

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ArticleTable.jsx                             │
│  urgencyMap = useUrgency(articles, deadlines, publication)          │
│  getRowStyle(article) → { background: "linear-gradient(...)" }     │
└──────────────┬───────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       useUrgency.js (Hook)                          │
│  - Ünnepnapok lekérése (fetchHolidays)                              │
│  - Percenkénti újraszámítás (setInterval 60s)                       │
│  - Minden cikkre: calculateUrgencyRatio() → { ratio, background }   │
│  - Visszaadja: Map<articleId, { ratio, background }>                │
└──────────────┬───────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     urgencyUtils.js (Logika)                        │
│                                                                      │
│  fetchHolidays(year)             → Set<"YYYY-MM-DD">                │
│  calculateWorkingMinutes(from, to, opts) → number (perc)            │
│  calculateRemainingWorkMinutes(state, pageCount) → number (perc)    │
│  getArticleDeadline(article, deadlines) → deadline | null           │
│  calculateUrgencyRatio(article, deadlines, opts) → { ratio, bg }   │
│  getUrgencyBackground(ratio) → CSS linear-gradient | null           │
└──────────────────────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  workflowConstants.js                                │
│  STATE_DURATIONS: { perPage, fixed } állapotonként                  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Fő formula

```
sürgősségi arány (ratio) = hátralévő szükséges munkaidő / rendelkezésre álló munkaidő
```

- **ratio < 0.05** → nincs vizuális jelzés (minden rendben)
- **ratio = 0.5** → a sáv félúton, narancssárga
- **ratio = 1.0** → a sáv teljes szélességű, mély vörös
- **ratio > 1.0** → lejárt / nem fér bele — teljes vörös fedés

---

## Hátralévő szükséges munkaidő

### STATE_DURATIONS

Minden workflow-állapothoz két komponens tartozik:

| Állapot | `perPage` (perc/oldal) | `fixed` (perc) |
|---------|----------------------:|----------------:|
| DESIGNING (0) | 60 | 0 |
| DESIGN_APPROVAL (1) | 30 | 15 |
| WAITING_FOR_START (2) | 10 | 15 |
| EDITORIAL_APPROVAL (3) | 30 | 15 |
| CONTENT_REVISION (4) | 30 | 10 |
| FINAL_APPROVAL (5) | 10 | 15 |
| PRINTABLE (6) | 10 | 5 |

**Formula állapotonként:**

```
állapot idő = perPage × oldalszám + fixed
```

**Összesítés:** A jelenlegi állapottól a PRINTABLE-ig (6) az összes állapot idejét összeadjuk.

### Oldalszám meghatározása

```
oldalszám = article.endPage - article.startPage + 1
```

Ha nincs `startPage` vagy `endPage`, fallback: **1 oldal**.

### Számítási példa

```
Cikk: 4 oldalas, state: EDITORIAL_APPROVAL (3)

  3 (EDITORIAL_APPROVAL): 30×4 + 15 = 135 perc
  4 (CONTENT_REVISION):   30×4 + 10 = 130 perc
  5 (FINAL_APPROVAL):     10×4 + 15 =  55 perc
  6 (PRINTABLE):          10×4 + 5  =  45 perc
                                      ────────
  Összesen:                            365 perc
```

---

## Rendelkezésre álló munkaidő

### Munkaidő szabályok

- **Munkanap:** 9:00–17:00 (480 perc/nap)
- **Hétvégék:** Szombat és vasárnap kihagyása (konfigurálható publikációnként)
- **Ünnepnapok:** Magyar munkaszüneti napok kihagyása (nager.at API)

### Számítás

A `calculateWorkingMinutes(fromDate, toDate, options)` naponként iterál:

1. Ha a nap nem munkanap (hétvége vagy ünnepnap) → kihagyja
2. Első és utolsó napnál a tényleges időpontot veszi figyelembe (nem teljes 480 perc)
3. A köztes munkanapok teljes 480 percet kapnak

**Példa:**
```
Most:     2026-02-25 (szerda) 10:00
Deadline: 2026-02-27 (péntek) 14:00

Szerda:  10:00–17:00 = 420 perc
Csütörtök: 9:00–17:00 = 480 perc
Péntek:    9:00–14:00 = 300 perc
                        ────────
Összesen:              1200 perc
```

### Hétvégék kihagyása

A `publication.excludeWeekends` boolean mező szabályozza (alapértelmezett: `true`). A beállítás a kiadvány tulajdonságainál, a **Határidők** szekción belül található (`DeadlinesSection.jsx`, „Hétvégék kihagyása" checkbox).

Az Appwrite adatbázisban a `Publications` collection `excludeWeekends` attribútumként van tárolva.

---

## Ünnepnapok (nager.at API)

### API végpont

```
https://date.nager.at/api/v3/publicholidays/{year}/HU
```

### Lekérési stratégia

- **Alkalmanként 2 HTTP kérés**: az aktuális és a következő év (éves határ közelében is pontos legyen)
- **Memória cache**: Évenként egyszer kéri le, utána `Map<year, Set<string>>` cache-ből szolgálja ki
- **Deduplikáció**: Ha párhuzamosan több hívás indul ugyanarra az évre, csak egy fetch fut (Promise deduplikáció)
- **Fallback**: Ha az API nem elérhető, `null` visszatérés (nem cache-eli a hibát) → a következő hívás újra megpróbálja. Addig csak hétvégéket hagyja ki.

### Időzítés

Az ünnepnapok betöltése a `useUrgency` hook mount-jakor történik. A percenkénti újraszámítás (`recalculate`) minden futáskor ellenőrzi az aktuális évet — ha az év változott (pl. éjfélkor), a `currentYear` state frissítése automatikusan újra futtatja az ünnepnap-lekérő effect-et.

---

## Deadline párosítás

A `getArticleDeadline(article, deadlines)` a cikk `startPage` értékét illeszti a deadline-ok oldaltartományaira:

```
article.startPage >= deadline.startPage  &&  article.startPage <= deadline.endPage
```

Ha **több deadline is lefedi** a cikk oldalait → a **legkorábbi `datetime` értékűt** választja.

Ha nincs matching deadline → `null` (nincs sürgősség-számítás).

---

## Kihagyott cikkek

A rendszer **nem számol sürgősséget** a következő esetekben:

- **ARCHIVABLE állapot** (state = 7) — a cikk már lezárt
- **IGNORE marker** (bitmaszk) — a cikk ideiglenesen ki van hagyva a kiadványból
- **Nincs matching deadline** — a cikkhez nem tartozik határidő
- **remainingMinutes = 0** — a cikk már a célállapotban van

---

## Vizuális megjelenítés

### 20 lépcsős színskála

A sürgősség mértékét egy progresszív, balról jobbra növekvő színsáv jelzi. A szín a citromsárgától a tűzvörösig fokozódik, az átlátszóság 1%-tól 20%-ig nő:

| Lépcső | Szín | Opacity |
|:------:|------|--------:|
| 1 | Halvány citromsárga `rgb(255, 255, 0)` | 1% |
| 2 | `rgb(255, 240, 0)` | 2% |
| 3 | Meleg sárga `rgb(255, 225, 0)` | 3% |
| 4 | `rgb(255, 210, 0)` | 4% |
| 5 | Arany `rgb(255, 195, 0)` | 5% |
| 6 | `rgb(255, 180, 0)` | 6% |
| 7 | Világos narancs `rgb(255, 165, 0)` | 7% |
| 8 | `rgb(255, 150, 0)` | 8% |
| 9 | Narancssárga `rgb(255, 135, 0)` | 9% |
| 10 | Félúton `rgb(255, 120, 0)` | 10% |
| 11 | Erős narancs `rgb(255, 105, 0)` | 11% |
| 12 | `rgb(255, 90, 0)` | 12% |
| 13 | Narancsvörös `rgb(255, 75, 0)` | 13% |
| 14 | `rgb(255, 60, 0)` | 14% |
| 15 | Világos vörös `rgb(255, 45, 0)` | 15% |
| 16 | `rgb(255, 30, 0)` | 16% |
| 17 | Tűzvörös `rgb(255, 15, 0)` | 17% |
| 18 | `rgb(255, 5, 0)` | 18% |
| 19 | Mély vörös `rgb(255, 0, 0)` | 19% |
| 20 | Maximum `rgb(255, 0, 0)` | 20% |

### Progresszív sáv

A szín **és** a sáv szélessége is a ratio-tól függ:

```
ratio = 0.05 →  1. szín, a sáv a sor  5%-át fedi le (balról)
ratio = 0.50 → 10. szín, a sáv a sor 50%-át fedi le
ratio = 1.00 → 20. szín, a sáv a sor 100%-át fedi le (teljes fedés)
ratio > 1.00 → 20. szín, teljes fedés (lejárt deadline)
```

**CSS implementáció:** `linear-gradient(to right, szín 0%, szín X%, transparent X%)`

A gradient a `background` (inline style) property-n keresztül kerül a táblázat sorára, a `CustomTable` `getRowStyle` prop-ján át.

### Hover kezelés

A sorok hover hatása `backgroundColor`-t használ (`rgba(0, 0, 0, 0.06)`), ami a gradient **alá** kerül — így mindkettő egyszerre látszódik. A sötét overlay világos és sötét témán is enyhén sötétíti a sort.

---

## Frissítési ciklus

A `useUrgency` hook **percenként** újraszámolja az összes cikk sürgősségét (`setInterval`, 60 000 ms). Ez biztosítja, hogy a sávok folyamatosan frissüljenek, ahogy közeledik a deadline.

Az újraszámítás azonnal megtörténik, ha:
- Változik az `articles` tömb (új cikk, állapotváltás)
- Változnak a `deadlines`
- Befejeződik az ünnepnapok lekérése
- Változik az `excludeWeekends` beállítás

---

## Teljesítmény-optimalizáció

A percenkénti sürgősség-újraszámítás és a Realtime események sor-szintű újrarajzolást válthatnak ki. A `CustomTable` a következő optimalizációkat alkalmazza:

- **`TableRow` + `React.memo` egyedi comparator-ral (`areRowPropsEqual`)**: Csak azok a sorok renderelődnek újra, amelyeknek ténylegesen változott az adat (`$updatedAt`) vagy a háttérszín (`rowStyle.background`). A `columns` és callback referenciák változása figyelmen kívül marad.
- **CSS `contain: layout style`** a sorokon: Jelzi a böngésző/UXP motornak, hogy egy sor belső változása nem hat ki más sorokra — gyorsabb scroll paint.
- **Validációk előindexelése** (`ArticleTable.userValidationsByArticle`): A felhasználói validációk `Map<articleId, items[]>` indexben tárolódnak (O(1) lookup), nem soronkénti tömb-szűréssel (O(m)).

---

## Érintett fájlok

| Fájl | Szerep |
|------|--------|
| `src/core/utils/urgencyUtils.js` | Fő számítási logika (munkaidő, ünnepnapok, ratio, színek) |
| `src/core/utils/workflow/workflowConstants.js` | `STATE_DURATIONS` definíció (perPage + fixed) |
| `src/data/hooks/useUrgency.js` | React hook (percenkénti újraszámítás, holiday betöltés) |
| `src/ui/features/articles/ArticleTable.jsx` | Sürgősség bekötése a táblázatba (`getRowStyle`) |
| `src/ui/common/Table/CustomTable.jsx` | `getRowStyle` prop + hover kezelés |
| `src/ui/features/publications/PublicationProperties/DeadlinesSection.jsx` | „Hétvégék kihagyása" checkbox |

---

## Összefoglalás diagram

```
                    ┌─────────────────────┐
                    │   nager.at API       │
                    │   (ünnepnapok)       │
                    └────────┬────────────┘
                             │ fetch (évente 1×, cache)
                             ▼
┌──────────┐    ┌────────────────────────────────────────┐
│ Appwrite │───▶│            useUrgency hook              │
│ deadlines│    │                                        │
│ articles │    │   Minden cikkre, percenként:            │
│ publi-   │    │                                        │
│ cation   │    │   1. getArticleDeadline()               │
│          │    │      ↓                                  │
│          │    │   2. calculateRemainingWorkMinutes()     │
│          │    │      (STATE_DURATIONS × oldalszám)       │
│          │    │      ↓                                  │
│          │    │   3. calculateWorkingMinutes()           │
│          │    │      (munkaidő a deadline-ig)            │
│          │    │      ↓                                  │
│          │    │   4. ratio = remaining / available       │
│          │    │      ↓                                  │
│          │    │   5. getUrgencyBackground(ratio)         │
│          │    │      → linear-gradient CSS               │
│          │    └──────────────────┬─────────────────────┘
│          │                       │
│          │                       ▼
│          │              Map<articleId, {ratio, background}>
│          │                       │
│          │                       ▼
│          │              ┌─────────────────┐
│          │              │  ArticleTable    │
│          │              │  getRowStyle()   │
│          │              │       ↓          │
│          │              │  CustomTable     │
│          │              │  (sor háttere)   │
│          │              └─────────────────┘
└──────────┘
```
