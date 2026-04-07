# Workflow Designer — UI tervek

> A Stitch MCP-vel generált képernyőtervek és annotációik. Az képek a [stitch-screens/](stitch-screens/) almappában találhatók.
> **Design rendszer**: Dashboard Stitch „Digital Curator" design tokenek (glassmorphism, `--bg-base`, `--accent`, no-line border).
> **Kapcsolódó**: [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Design alapok

A workflow designer a Dashboard meglévő Stitch „Digital Curator" design nyelvét követi:

- **Alapszín**: `--bg-base` (sötét), glassmorphism rétegekkel
- **Accent**: `--accent` (lila/ibolya)
- **Border nélküli panelek**: a rétegek elválasztása elmosással és háttérkontraszttal, nem vonallal
- **Tipográfia**: System stack, magyar akcentusokhoz optimalizálva
- **Ikonok**: Lucide React (a Dashboard már használja)

A tervek inspirációként és layout alapként szolgálnak — a React komponensek manuális munka, ugyanazon a design tokenen.

---

## Képernyő katalógus

### 1. Bejelentkezés / Regisztráció flow

**Cél**: Teljes auth UX a Dashboardon (Fázis 1). Egy képernyőben szerepel a login, regisztráció, elfelejtett jelszó link, e-mail verifikáció várakoztató állapot, meghívó elfogadás.

**Slug**: `auth-flow`
**Képek**:
- `stitch-screens/auth-login.png` — bejelentkezés form (e-mail, jelszó, „Elfelejtett jelszó?" link, „Nincs fiókod? Regisztráció" link)
- `stitch-screens/auth-register.png` — regisztráció form (név, e-mail, jelszó, jelszó megerősítés)
- `stitch-screens/auth-verify-pending.png` — „Ellenőrizd az e-mailedet" várakoztató képernyő
- `stitch-screens/auth-forgot.png` — elfelejtett jelszó form (e-mail)
- `stitch-screens/auth-reset.png` — új jelszó form (jelszó, megerősítés)
- `stitch-screens/auth-invite.png` — meghívó elfogadás (org neve, meghívó neve, „Elfogadom" gomb)
- `stitch-screens/auth-onboarding.png` — első belépés: új org név + első office név

**Annotációk**: `stitch-screens/auth-flow.md`

---

### 2. Workflow Designer canvas

**Cél**: A teljes designer oldal fő nézete. ComfyUI ihletésű, `@xyflow/react` alapú canvas, bal oldali node palette, jobb oldali properties sidebar, felső toolbar.

**Slug**: `designer-canvas`
**Képek**:
- `stitch-screens/designer-canvas.png` — üres canvas, 8 állapotú magazin workflow betöltve
- `stitch-screens/designer-canvas-selected.png` — egy state node kiválasztva, properties sidebar nyitott

**Layout**:
```
┌─────────────────────────────────────────────────────────────┐
│  [Dashboard fejléc]                                          │
├──────────┬───────────────────────────────────────┬──────────┤
│          │                                       │          │
│  Node    │                                       │  Props   │
│  Palette │          Canvas (xyflow)              │  Sidebar │
│          │                                       │          │
│  - State │   ┌─────┐   ┌─────┐                   │  [kivá-  │
│  - Valid │   │  S1 ├──▶│  S2 │                   │  lasz-   │
│  - Cmd   │   └─────┘   └──┬──┘                   │  tott    │
│          │                │                       │  elem]   │
│  [Csop.] │   ┌─────┐◀─────┘                       │          │
│  [El.pm] │   │  S3 │                               │          │
│  [Caps]  │   └─────┘                               │          │
│          │                                       │          │
├──────────┴───────────────────────────────────────┴──────────┤
│  [Toolbar: Mentés | Export | Import | Verzió: 12]           │
└─────────────────────────────────────────────────────────────┘
```

**Annotációk**: `stitch-screens/designer-canvas.md`

---

### 3. State Node komponens

**Cél**: Egyetlen állapot node részletes megjelenítése a canvason. A node mutatja a címkét, színt, duration-t, a csatlakozó portokat (input/output), a validátor badge-eket és a parancs lista preview-t.

**Slug**: `state-node`
**Képek**:
- `stitch-screens/state-node-default.png` — alap állapot (nem kiválasztott)
- `stitch-screens/state-node-selected.png` — kiválasztott állapot (highlight border + glow)
- `stitch-screens/state-node-initial.png` — kezdő állapot jelzéssel (⊙ ikon)
- `stitch-screens/state-node-terminal.png` — terminál állapot jelzéssel (⊡ ikon)

**Node anatómia**:
```
┌─────────────────────────────┐
│ ○ input port                │  ← bal oldali csatlakozó
│                             │
│  🎨 Tervezés                 │  ← label + színes accent bar
│  ⏱  60 min/oldal             │  ← duration info
│                             │
│  Validátorok:                │  ← validator badge-ek
│  [file_acc] [page_num]      │
│                             │
│  Parancsok:                  │  ← command preview (ha van)
│  → export_pdf (designer)    │
│                   output ○  │  ← jobb oldali csatlakozó
└─────────────────────────────┘
```

**Annotációk**: `stitch-screens/state-node.md`

---

### 4. Properties Sidebar

**Cél**: A kiválasztott elem tulajdonságainak szerkesztése. Sidebar tartalma dinamikusan változik aszerint, mi van kijelölve: state, transition, semmi (általános workflow props), csoport, UI element permission, vagy capability.

**Slug**: `properties-sidebar`
**Képek**:
- `stitch-screens/properties-sidebar-state.png` — state kiválasztva (név, szín, perPage, fixed, isInitial, isTerminal, validations, commands, statePermissions)
- `stitch-screens/properties-sidebar-transition.png` — transition kiválasztva (label, direction, allowedGroups multi-select)
- `stitch-screens/properties-sidebar-empty.png` — semmi nincs kiválasztva (általános workflow info: version, groups count, updated by)

**State szerkesztő mezők**:
- `id` (string, slug format, read-only ha van hivatkozó cikk)
- `label` (magyar megjelenített név)
- `color` (color picker)
- `duration.perPage` (number)
- `duration.fixed` (number)
- `isInitial` (checkbox, csak egy állapot lehet)
- `isTerminal` (checkbox)
- **Validations** collapsible section:
  - `onEntry` — validator multi-select
  - `requiredToEnter` — validator multi-select
  - `requiredToExit` — validator multi-select
- **Commands** collapsible section:
  - [+ Add command] → dropdown a command ID-ból + `allowedGroups` multi-select
- **State permissions** collapsible section:
  - Csoport slug-ok multi-select

**Annotációk**: `stitch-screens/properties-sidebar.md`

---

## Stitch generálás menete

1. **Project létrehozás** a Stitch MCP-ben: „Maestro Workflow Designer"
2. **Design system betöltés**: a Dashboard [styles.css](../../packages/maestro-dashboard/css/styles.css) Stitch „Digital Curator" tokenjei
3. **Screen generation**: egyesével `mcp__stitch__generate_screen_from_text` az alábbi promptokkal:
   - `auth-login`: „Modern glassmorphism login form, email and password inputs, primary button 'Bejelentkezés', secondary links for password recovery and registration, dark background, purple accent"
   - `auth-register`: „Glassmorphism registration form, name/email/password/confirm fields, primary button 'Regisztráció', link to login"
   - `auth-verify-pending`: „Empty state illustration, icon mail, heading 'Ellenőrizd az e-mailedet', description text, secondary button 'Új link küldése'"
   - `auth-onboarding`: „Two-step onboarding, step 1 organization name input, step 2 editorial office name input, next/back buttons"
   - `designer-canvas`: „ComfyUI-inspired workflow graph editor, dark background, node palette left, xyflow canvas center with 8 state nodes connected, properties sidebar right, toolbar top with save/export/import buttons"
   - `state-node-default`: „Single workflow state node card, title 'Tervezés', color accent yellow, duration info, validator badges, input/output ports, glassmorphism background"
   - `state-node-selected`: „Same state node with purple glow border and elevated shadow indicating selection"
   - `properties-sidebar-state`: „Right sidebar with form fields for editing a selected state: label text input, color picker, duration number inputs, checkboxes for initial/terminal, collapsible sections for validations/commands/permissions"
4. **Export képek** PNG-ben a `stitch-screens/` mappába
5. **Annotációk** írása minden képhez `<slug>.md` fájlban (mit mutat, mely elemek kritikusak, mit kell a React-ben manuálisan megoldani)

---

## React fordítás stratégia

A Stitch HTML/CSS kimenet **nem 1:1 React**. A workflow:

1. A képek adják a layout alapot és a komponens hierarchiát.
2. A design tokenek (színek, border radius, shadow) a Dashboard meglévő CSS változóira fordítódnak.
3. Az interaktív elemek (xyflow canvas, drag-n-drop, sidebar animáció) manuális React kód.
4. A glassmorphism effekt CSS osztályként újrahasználódik a már meglévő Dashboard komponensekből.

**Tipikus lépések egy Stitch kép React-esítésekor**:
1. Vezesd be az új route-ot (pl. `/admin/office/:officeId/workflow`)
2. Hozd létre a konténer komponenst (`WorkflowDesigner.jsx`) üres layout-tal (grid: palette / canvas / sidebar)
3. Implementáld a xyflow canvas-t a `compiled.states` és `compiled.transitions`-ből
4. Hozd létre a custom `StateNode.jsx`-et (xyflow `<Handle>`-ekkel)
5. Csatold a properties sidebar-t a kijelölés state-hez
6. Implementáld a mentés flow-t (`compiler.js` → `validator.js` → `workflows.{id}.update`)

---

## Nyitott UI kérdések

- **Drag-n-drop mobilbarát?** — Egyelőre desktop-only, mobil support nem cél.
- **Diff megjelenítés az import-nál** — Egymás melletti oszlop vs. inline diff. Javaslat: egymás melletti, de az első kísérlet után megnézzük.
- **Undo/redo a designerben?** — A fázis 5 első iterációjában **nem**. Mentés előtt „Visszavonás" gombbal a graph visszatölthető az aktuális DB állapotra. Az undo stack későbbi fejlesztés.
- **Csoport kezelése külön tab vagy inline az állapot panelben?** — Külön tab (`GroupsPanel`), mert a csoportok nem kötődnek egyetlen state-hez — office-szintű objektumok.
