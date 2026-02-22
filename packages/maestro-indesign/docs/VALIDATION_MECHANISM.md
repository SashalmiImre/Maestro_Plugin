# Egységes Validációs és Üzenetküldő Rendszer

A Maestro plugin validációs rendszere egyesíti a rendszer által generált ellenőrzéseket (például Preflight hibák, struktúra átfedések) és a felhasználók által rögzített üzeneteket/feladatokat egyetlen, koherens felületen.

## Áttekintés

A rendszer célja, hogy minden problémát és teendőt egy helyen kezeljen, egységes súlyozással (Hiba/Figyelmeztetés/Infó), és blokkolja a munkafolyamat-lépéseket (pl. állapotváltást), amíg kritikus hibák állnak fenn.

### Validációs Típusok

Minden bejegyzés (legyen az rendszer vagy felhasználói eredetű) rendelkezik egy típussal:

| Típus | Leírás | Színkód | Hatás |
| :--- | :--- | :--- | :--- |
| **ERROR** (Hiba) | Kritikus probléma vagy javítandó feladat. | Piros | **Blokkolja az állapotváltást.** |
| **WARNING** (Figy.) | Figyelemfelhívás, de nem kritikus. | Sárga | Nem blokkol. |
| **INFO** | Általános információ. | Kék | Nem blokkol. |
| **SUCCESS** | Megoldott probléma. | Zöld | Nem blokkol, elrejthető. |

### Források

A bejegyzések származhatnak:

1.  **Rendszer (System)**
    *   `preflight`: InDesign preflight ellenőrzés eredményei.
    *   `structure`: Kiadvány-szerkezeti hibák (pl. oldalszám-átfedés).
    *   `system`: Egyéb általános rendszerüzenetek.
2.  **Felhasználó (User)**
    *   `user`: Felhasználók által manuálisan rögzített üzenetek (pl. "Cseréld ki a képet").
3.  **Rendszer Felülbírálat (System Override)**
    *   `system_override`: Amikor egy felhasználó "visszaminősít" egy rendszerhibát. Ez technikailag egy felhasználói üzenet, ami "elfedi" az eredeti rendszerhibát.

## Működés és Munkafolyamatok

### 1. Rendszer Validációk
A rendszer automatikusan futtat ellenőrzéseket (pl. mentéskor, állapotváltáskor). Ezek eredményei (hibák és figyelmeztetések) megjelennek a listában.
*   A rendszerhibák mindaddig aktívak, amíg a kiváltó ok meg nem szűnik (pl. az oldalszámok javítása után az átfedés hiba eltűnik).
*   **Visszaminősítés (Downgrade):** Ha egy rendszerhiba technikailag nem javítható, de a munkafolyamatnak folytatódnia kell, a felhasználó "visszaminősítheti" a hibát figyelmeztetéssé. Ekkor a rendszer rögzít egy kivételt, és a hiba helyett egy figyelmeztetés jelenik meg.

### 2. Felhasználói Üzenetek
A felhasználók (Szerkesztők, Tervezők, stb.) üzeneteket küldhetnek egymásnak vagy saját maguknak.
*   **Létrehozás:** Típus, Címzett és Leírás megadásával.
*   **Megoldás (Solve):** A címzett (vagy bárki a csapatból) "Megoldottnak" jelölheti az üzenetet (pipa ikon).
*   **Megjelenítés:** A megoldott üzenetek alapértelmezetten rejtve vannak, de a szűrővel megjeleníthetők.

### 4. Megjelenítés (UI)
*   **Article List (ArticleTable):**
    *   Ha egy cikknek vannak aktív bejegyzései, ikon jelzi a státuszban.
    *   **Prioritás:** Ha van Hiba ÉS Figyelmeztetés is, **mindkettő** ikon megjelenik egymás mellett.
    *   **Tooltip:** Az egérkurzort az ikon fölé víve időrendi sorrendben (legújabb legfelül) felsorolja az aktív üzeneteket.
*   **Properties Panel (ValidationSection):**
    *   Az összes bejegyzés egy listában, időrendben (legújabb felül).
    *   **Megoldott elemek:** Checkbox-szal megjeleníthetők. Stílusuk: eredeti szín megőrzése mellett **50% áttetszőség**.
    *   **Hover effekt:** A megoldott (halvány) elemek fölé víve az egeret, azok teljes fedettséggel (100% opacity) jelennek meg a könnyebb olvashatóság érdekében.

## Mező-szintű Validáció (UI Layer)

A fenti rendszer- és felhasználói validációk mellett létezik egy harmadik réteg: a **mező-szintű formátum-validáció**, amely közvetlenül a szerkesztőmezőkön ad azonnali vizuális visszajelzést.

### Jellemzők

| Tulajdonság | Érték |
| :--- | :--- |
| **Mikor fut** | Blur / Enter (a mező elhagyásakor) |
| **Visszajelzés** | `sp-textfield` piros kerete (`invalid` attribútum) |
| **Hatás** | Megakadályozza az érvénytelen adat mentését, de **nem blokkol** állapotváltást |
| **Törlődik** | A következő billentyűleütéskor (gépelés közben nincs piros keret) |

### Implementáció

*   A `ValidatedTextField` komponens fogadja az `invalid` propot, és továbbadja az `sp-textfield`-nek.
*   A `DeadlinesSection` a `DeadlineValidator` statikus metódusait (`isValidDate`, `isValidTime`) használja blur-kor.
*   Ha a formátum érvénytelen, a mező piros keretet kap és az adat nem kerül mentésre.
*   Ha a formátum érvényes, a mentés normálisan folytatódik, és a `DeadlineValidator.validate()` instance metódus a mentett adatokon futtatja a kereszt-validációkat (átfedés, lefedettség, tartomány).

### Validációs Rétegek Összehasonlítása

| Réteg | Scope | Mikor | Visszajelzés | Példa |
| :--- | :--- | :--- | :--- | :--- |
| **Mező-szintű** | Egyetlen input mező | Blur/Enter | Piros keret (`invalid`) | „2024.13.01" → érvénytelen hónap |
| **Kereszt-validáció** | Több rekord egymáshoz viszonyítva | Debounce 300ms | Hiba/figyelmeztetés kártyák | Átfedő oldaltartományok |
| **Rendszer** | Cikk / kiadvány szintű | Mentéskor / állapotváltáskor | ValidationSection lista | Preflight hiba, oldalszám-átfedés |

## Adatmodell (Technikai)

Az üzenetek és validációs állapotok az Appwrite adatbázisban tárolódnak.

### `messages` kollekció
Minden felhasználói üzenet és rendszer-felülbírálat itt tárolódik.
*   `articleId`: Kapcsolódó cikk.
*   `type`: `error` | `warning` | `info` | `success`
*   `source`: `user` | `system_override`
*   `message`/`description`: Szöveges tartalom.
*   `contextId` (opcionális): Rendszerhiba azonosítója (hash) felülbírálathoz.
*   `originalType` (opcionális): Eredeti típus felülbírálatnál.
*   `isResolved`: Logikai érték.

### `validations` kollekció
A rendszer validációs eredményeinek gyorsítótára (cache).
*   `articleId`: Kapcsolódó cikk.
*   `source`: `preflight` | `structure`
*   `errors`: Szöveges tömb.
*   `warnings`: Szöveges tömb.

A UI (`ValidationSection.jsx`) ezt a két forrást fésüli össze (`useUnifiedValidation` hook segítségével) egyetlen időrendi listába.
*   **DataContext:** A `messages` kollekció (felhasználói üzenetek) szinkronizálásáért a központi `DataContext` felel. A komponensek (`useUserValidations` hook) innen kapják a mindig naprakész adatot.
*   **ValidationContext:** A rendszer validációk (preflight, structure) eredményeit tárolja.
*   **Konzisztencia:** A `DataContext` Realtime kapcsolata biztosítja, hogy minden felhasználó azonnal lássa az új üzeneteket.
