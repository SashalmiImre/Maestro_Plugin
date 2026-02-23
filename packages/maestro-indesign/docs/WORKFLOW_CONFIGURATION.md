# Workflow Configuration Guide

A Maestro plugin munkafolyamat-motorjának (`WorkflowEngine`) konfigurációja a `src/core/utils/workflow/workflowConstants.js` fájlban található `WORKFLOW_CONFIG` objektumban van definiálva.

Ez a dokumentum leírja a konfigurációs objektum felépítését és a validációs szabályok működését.

## Struktúra

A konfiguráció állapotonként (`WORKFLOW_STATES`) csoportosítva tartalmazza a szabályokat:

```javascript
[WORKFLOW_STATES.ALLAPOT_NEVE]: {
    config: { ... },      // UI megjelenés (címke, szín, ikon)
    transitions: [ ... ], // Lehetséges állapotátmenetek
    validations: { ... }, // Validációs szabályok (belépés/kilépés)
    commands: [ ... ]     // UI-ban megjelenő gombok/parancsok
}
```

## Validációs Rendszer

A `validations` objektum három kulcsot tartalmazhat, amelyek a munkafolyamat különböző pontjain érvényesülnek.

### 1. `onEntry` (Automatikus Futtatás)
**Nem blokkoló.** Az állapotba lépéskor automatikusan lefutó validációk listája.
- **Célja**: Adatgenerálás, ellenőrzés futtatása (pl. Preflight, fájlméret mérés).
- **Működése**: A rendszer elindítja a validátort, de nem akadályozza meg a belépést, amíg az fut. Az eredmény aszinkron módon érkezik meg.

**Szintaxis:**
```javascript
onEntry: [
    { validator: 'validator_neve', options: { ... } }
]
```

### 2. `requiredToEnter` (Belépési Feltétel)
**BLOKKOLÓ.** Feltételek, amelyeknek teljesülniük kell ahhoz, hogy a cikk ebbe az állapotba léphessen (vagy ebben az állapotban maradhasson "compliant" státusszal).
- **Célja**: Megakadályozni a hibás állapotváltást (pl. nem léphet be a "Nyomdakész" állapotba, ha nincs kész a Preflight).
- **Működése**: Ha bármelyik feltétel nem teljesül (hiba), az állapotváltás meghiúsul.

**Szintaxis:**
- Egyszerű string (opciók nélkül): `"validator_neve"`
- Részletes objektum: `{ validator: 'validator_neve', options: { ... } }`

```javascript
requiredToEnter: [
    "file_accessible",
    { validator: 'preflight_check', options: { profile: "Levil" } }
]
```

### 3. `requiredToExit` (Kilépési Feltétel)
**BLOKKOLÓ.** Feltételek, amelyeknek teljesülniük kell ahhoz, hogy a cikk elhagyhassa a jelenlegi állapotot.
- **Célja**: Biztosítani, hogy az állapotban előírt feladatok el lettek végezve.
- **Működése**: Ha bármelyik feltétel nem teljesül, a "Tovább" gomb nem engedi a váltást.

**Szintaxis:**
Hasonló a `requiredToEnter`-hez.

```javascript
requiredToExit: [
    { validator: 'preflight_check', options: { profile: "Levil" } }
]
```

## Validátor Konfiguráció (String vs Object)

A `requiredToEnter` és `requiredToExit` listákban kétféle módon hivatkozhatunk validátorokra:

1.  **String referenciával** (`"validator_neve"`):
    - Egyszerű ellenőrzés, nincsenek paraméterek.
    - Példa: `"file_accessible"`

2.  **Objektummal** (`{ validator: '...', options: {...} }`):
    - **Szigorúbb ellenőrzés.** Lehetőséget ad paraméterek átadására.
    - Példa: `{ validator: 'preflight_check', options: { profile: "Levil" } }`
    - Ebben az esetben a rendszer ellenőrzi, hogy a validáció **ezekkel a paraméterekkel** futott-e le sikeresen.

> **Megjegyzés:** Ha egy validátort objektumként adunk meg, az felülbírálja az esetleges `onEntry`-ben definiált alapértelmezéseket az ellenőrzés során.

## Jogosultsági Rendszer

Az állapotátmenetek csapat-alapú jogosultsági rendszerrel vannak védve. Részletes dokumentáció: **[WORKFLOW_PERMISSIONS.md](./WORKFLOW_PERMISSIONS.md)**
