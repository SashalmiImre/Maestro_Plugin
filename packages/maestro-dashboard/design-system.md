# Maestro Dashboard — Design System

> Egyetlen forrása a Dashboard design tokeneknek és komponens-konvencióknak.
> A fájl a repóval együtt verziókövetett — Claude bármelyik felületén (claude.ai chat, Claude Code, desktop app) ugyanazt látja. Módosításhoz edit + code-apply (`/design-handoff` skill).

## Token forrás

A runtime értékek a [css/tokens.css](css/tokens.css) `:root` blokkjában élnek. Ez a dokumentum ember-olvasható tükrözés; a kódváltás mindig ott történik.

> **Szerkezet**: a stílusok modulosak, az [css/index.css](css/index.css) az entry — `tokens → base → layouts → components → features` sorrendben tölti be a fájlokat. Új komponens hozzáadása: új `components/<név>.css` + egy `@import` sor az `index.css`-ben.

## Paletta

### Háttér — rétegzett (5 szint)
| Token | Érték | Használat |
|---|---|---|
| `--bg-base` | `#111319` | Alap háttér, login, app shell |
| `--bg-surface` | `#191b22` | Alap felszín (`surface-container-low`) |
| `--bg-elevated` | `#282a30` | Kiemelt felszín (`surface-container-high`) |
| `--bg-overlay` | `#1e1f26` | Modál, popover (`surface-container`) |
| `--bg-hover` | `#33343b` | Hover/aktív állapot (`surface-container-highest`) |

### Keret
| Token | Érték |
|---|---|
| `--border` | `rgba(66, 71, 84, 0.15)` |
| `--border-muted` | `rgba(66, 71, 84, 0.05)` |

> **„No-Line" szabály**: ghost border-ek, soha ne legyen éles `#000` vagy telített keret. Elválasztást inkább háttérkontraszttal.

### Szöveg — hierarchia
| Token | Érték | Használat |
|---|---|---|
| `--text-primary` | `#e2e2eb` | Fő szöveg (`on-surface`) |
| `--text-secondary` | `#c2c6d6` | Másodlagos (`on-surface-variant`) |
| `--text-muted` | `#9aa0b0` | Placeholder, metadata (`outline`) — AA 4.7:1 a `--bg-elevated` felett |
| `--text-disabled` | `#424754` | Disabled állapot (`outline-variant`) |

### Accent — interaktív
| Token | Érték | Használat |
|---|---|---|
| `--accent` | `#adc6ff` | Link, fókusz-gyűrű, primary szöveg |
| `--accent-hover` | `#4d8eff` | Hover state |
| `--accent-subtle` | `rgba(173, 198, 255, 0.15)` | Subtle háttér (badge, highlight) |
| `--accent-solid` | `#3b82f6` | Primary gomb háttér |

### Státusz
| Token | Érték | Használat |
|---|---|---|
| `--c-error` | `#ffb4ab` | Hiba, Danger Zone |
| `--c-warning` | `#e3b341` | Figyelmeztetés |
| `--c-success` | `#4ade80` | Siker, aktív |

### Tercier — Tervezet / System lock
| Token | Érték |
|---|---|
| `--tertiary` | `#ddb7ff` |
| `--tertiary-container` | `#b76dff` |

### Badge variánsok
A közös `.badge` osztály (`css/components/badge.css`) az egész dashboard jelzői számára:
uppercase, letter-spacing `0.06em`, `--radius-sm`, padding `2px 8px`, font-size 10px, font-weight 700.

| Variáns | Használat | Háttér / szöveg |
|---|---|---|
| **me** | Saját lock (ArticleRow) | `--badge-me-bg / text / border` |
| **sys** | System lock (ArticleRow) | `--badge-sys-bg / text / border` |
| **other** | Másik user lockja (ArticleRow) | `--badge-other-bg / text / border` |
| **current** | „Aktuális" jelzés (WorkflowLibrary) | `--accent-solid` 18% / `--accent` |
| **own** | „Saját" tulajdonos (WorkflowLibrary) | `--accent-solid` 12% / `--accent` |
| **foreign** | „Idegen" szerkesztőség (WorkflowLibrary) | `shadow-tint` 30% / `--text-muted` |
| **public** | Workflow láthatóság — publikus | lila 15% / `#a98bff` |
| **organization** | Workflow láthatóság — szervezet | kék 15% / `#6fb8e8` |
| **editorial_office** | Workflow láthatóság — szerkesztőség | `shadow-tint` 30% / `--text-secondary` |
| **warning** | Archivált törlési visszaszámláló | `--c-warning` 15% / `--c-warning` |

> **Szabály**: új "badge-szerű" pill-t ne egyedi CSS-sel csinálj — adj hozzá `.badge--<név>` variánst a közös fájlhoz.

### SegmentedToggle
Reusable, többszörös kijelölésű gombcsoport (`src/components/SegmentedToggle.jsx`, `css/components/segmented-toggle.css`). Egyetlen vizuális „összetett gomb", amit szegmensekre tagolnak a toggle-k; ha minden opció aktív, az a teljes halmazt szűri (az implicit „Mind" állapot). `minSelected` (default 1) megakadályozza az üres kiválasztást — az utolsó aktív gomb lenyomása no-op.

```jsx
<SegmentedToggle
  options={[{ value, label, title? }]}
  selected={new Set([...])}
  onChange={(nextSet) => ...}
  minSelected={1}
  ariaLabel="Szűrés láthatóság szerint"
/>
```

Használat: WorkflowLibraryPanel scope szűrő (Szerkesztőség / Szervezet / Publikus).

## Theming — dark / light

Két téma él a Dashboard-on, ugyanazon token-csoport felett:

- **Dark** (default): a `:root` szelektorban élő tokenek (Editorial OS dark v2).
- **Light**: a `[data-theme="light"]` szelektorban élő override-ok (GitHub light-ihletésű paletta, ugyanaz az 5-szintes hierarchia).

A `<html data-theme="...">` attribútumot a [main.jsx](src/main.jsx) korai bootstrap állítja be (no-flash render), a [`useTheme`](src/hooks/useTheme.js) hook kezeli a futtatási váltást + `localStorage` perzisztenciát.

### Theme-aware token kategóriák

| Kategória | Dark forrás | Light override | Megjegyzés |
|---|---|---|---|
| Háttér (5 szint) | Stitch "Digital Curator" tónusok | GitHub light hierarchia | Lásd Paletta szekció |
| Szöveg (4 szint) | világos ↑ sötét ↓ | sötét ↑ világos ↓ | Invertált hierarchia |
| Accent | `#adc6ff` (világos kék) | `#0969da` (telített kék) | Light-on telítettebb a kontraszt |
| Status (`--c-error/warning/success`) | világos pasztell | sötét telített | Olvashatóság saját háttéren |
| Modal/tooltip backdrop | `rgba(0,0,0,0.55)` | `rgba(31,35,40,0.40)` | `--shadow-tint` RGB tokenen át |
| Glassmorphism élek | `rgba(255,255,255,...)` | `rgba(31,35,40,...)` | Invertált overlay-irány |
| Lock badge variánsok | dark paletta | light paletta | `--badge-{me,sys,other}-*` |

### Új theme-függő token bevezetésének szabálya

1. A `:root`-ba kerül a dark érték.
2. A `[data-theme="light"]` blokkba a light verzió.
3. Használati helyen `var(--token)` — semmi hardcoded szín.
4. Token-derivált alpha preferált formája: `rgb(from var(--bg-surface) r g b / 0.5)` — automatikusan követi a téma váltást.

### Komponens-szintű override szükséges (NEM token-szintű)

Ahol third-party prop nem CSS-tokenből jön (pl. React Flow `Background` color, `MiniMap.maskColor` — ld. [WorkflowCanvas.jsx](src/features/workflowDesigner/WorkflowCanvas.jsx)), ott a komponensben kell a `useTheme()`-ből származó értéket átadni a prop-nak. A pattern: a token-érték `getComputedStyle(document.documentElement).getPropertyValue('--token')` vagy a prop-átadás `useTheme()` enum alapján.

## Tipográfia

- **Font család**: `Inter`, fallback `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
- **Alap méret**: `13px`
- **Line-height**: `1.4`
- **Antialiasing**: `-webkit-font-smoothing: antialiased`

### Skála (ajánlott — még nem kodifikált)
| Token | Méret | Használat |
|---|---|---|
| `--font-xs` | 11px | Metadata, caption |
| `--font-sm` | 12px | Secondary text |
| `--font-base` | 13px | Body (default) |
| `--font-md` | 15px | Emphasis |
| `--font-lg` | 18px | Modal title |
| `--font-xl` | 24px | Page title |
| `--font-2xl` | 32px | Brand (MAESTRO) |

## Spacing (kódban)

| Token | Érték |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 24px |
| `--space-6` | 32px |
| `--space-7` | 48px |
| `--space-8` | 64px |

**Sweep állapota (#48)**: a `border-radius`, `gap`, és single-value `padding` property-ket már `var(--space-*)` / `var(--radius-*)` tokenekre cseréltük a CSS modulokban. A shorthand értékek (pl. `padding: 8px 16px`) és a component-szintű `padding-left/right` property-k inkrementálisan tokenizálandók, amikor az érintett komponens módosul.

## Radius (kódban)

| Token | Érték | Használat |
|---|---|---|
| `--radius-sm` | 4px | Badge, chip, input |
| `--radius-md` | 6px | Button, card |
| `--radius-lg` | 8px | Modal, popover |
| `--radius-xl` | 12px | Hero, workflow node |

## Fókusz

Minden interaktív elem:
```css
:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}
```

## Komponens-konvenciók

### Primary Button
Háttér `--accent-solid`, szöveg fehér, padding `--space-3 --space-5`, radius `--radius-md`. Disabled: `--text-disabled` háttér, `--text-muted` szöveg.

### Danger Action (`.danger-action`)
Subtle piros variáns egységes destruktív akciókhoz. CSS minta ([css/components/danger.css](css/components/danger.css)):
- Háttér `rgba(255, 180, 171, 0.10)` (`--c-error` 10%)
- Keret `1px solid rgba(255, 180, 171, 0.30)`
- Szín `var(--c-error)` (`#ffb4ab`)
- Padding `var(--space-2) var(--space-4)`, radius `var(--radius-md)`, font-weight 600
- Hover: háttér 18%-os, keret 50%-os
- Disabled: `opacity: 0.5`, `cursor: not-allowed`

**Block variáns** (`.danger-action--block`): full-width, side panel gombokhoz.

**Használók**:
- `DangerZone.jsx` — Org / Office / Publication kaszkád törlés.
- `StatePropertiesEditor.jsx` — Workflow Designer állapot törlés.
- `TransitionPropertiesEditor.jsx` — Workflow Designer átmenet törlés.

> **Megjegyzés**: a `ConfirmDialog.jsx` `.confirm-dialog-btn-danger` külön minta marad
> (dialog primary gomb, vizuálisan kiemelt). Tokenizálása külön iterációban.

### Modal
- Háttér `--bg-overlay`
- Backdrop `var(--modal-backdrop)` — token-alapú, theme-aware (dark `rgba(0,0,0,0.55)` / light `rgba(31,35,40,0.40)`)
- Radius `--radius-lg`
- Tab strip felül, tartalom 24px padding, akciógombok jobbra igazítva alul (Mégse bal, Primary jobb)

### Breadcrumb
- Csak akkor dropdown, ha tényleg van választási lehetőség vagy több menüpont
- Üres scope-ban: disabled állapot tooltip-pel
- Chevron-animáció nyitáskor (180° rotation)

### State node (Workflow Designer)
- Border-color = workflow state szín (dinamikus, a `compiled.stateColors`-ból)
- Marker kódok (FA/PN/FN/EP) hover-re teljes névre cserélődnek
- Selected állapot: 2px accent outline

## Copy-hygiene (C.0.3 előkészület)

A C.2 redesign keretében **újragyúrt** screen-eken a user-facing copy nem inline JSX-stringként, hanem **file-local `LABELS`** (egyszerű kulcs–érték) vagy **`COPY`** (egymással összetartozó stringek csoportja, pl. dialógus-szöveg blokk) objektumban él. Ez **nem i18n** — sem `t()` wrapper, sem locale-engine, sem key-namespace policy nincs ebben a fázisban. A cél kétlépcsős:

1. **Most** (C.2): a redesign közben szétválik a layout/markup és a copy → diff-barát, a copy átolvasható egyetlen blokkban, és a string-frissítés nem keveredik a JSX-strukturális változással.
2. **Később** (D blokk, jövőbeli): az i18n bevezetésekor a `LABELS` kulcsai válnak a `t()` keyspace tövévé — a copy migráció akkor csak `LABELS.foo` → `t('foo')` mintára szűkül, nem teljes string-extraction.

### Mintázat

```jsx
// FilterBar.jsx (illusztratív, NEM kész implementáció)
const LABELS = {
    resetTitle: 'Szűrők törlése',
    resetButton: 'Törlés',
    statusIgnored: 'Kimarad',
    onlyMine: 'Csak a saját cikkeim',
    placeholders: 'Helykitöltők mutatása',
};

export default function FilterBar({ ... }) {
    return (
        <button title={LABELS.resetTitle}>{LABELS.resetButton}</button>
        // ...
    );
}
```

### Hatókör

- **Igen**: a C.2-ben újragyúrt screen-ek (Table View, Publication Settings, Flatplan, Workflow Designer, Login, Org Settings, Create Publication) a redesign-commit-ban kapnak `LABELS` / `COPY` blokkot.
- **Nem**: a többi screen (settings, workflow library panel, stb.) NEM kap most string-extraction-t — az csak a D blokkban, az i18n migráció keretében. Felesleges churn lenne.
- **Nem**: cross-app `t()` infrastruktúra, locale-engine, JSON resource fájl — szigorúan **D blokk** hatáskör.

### Konvenció

- Az objektum file-local, nem export. Ha más komponens is használná ugyanazt a copy-t, akkor egy közös primitív kell (ld. „Komponens-konvenciók"), nem közös `LABELS`.
- A kulcsok angol kódbeli azonosítók, az értékek magyar UI-szöveg. A 2026-05-01 alapelv szerint: angol kód, magyar UI.
- Interpoláció (pl. „X cikk kiválasztva") template literállal megy, nem `LABELS.foo.replace(...)`-szal — egyszerűbb és a D blokk-ban a `t('foo', { count })` is template-alapú.
- Pluralizáció jelen fázisban manuális if/else-szel — `LABELS.singular` / `LABELS.plural`.

## Hiányzó / TODO

- [x] Spacing tokenek bevezetése (#48)
- [x] Radius tokenek bevezetése (#48)
- [ ] Font-size skála kodifikálása
- [ ] IconButton komponens stílus-szabvány (`aria-label` kötelező, 3 méret)
- [x] DangerAction egységesítés (#51) — Workflow Designer „Állapot törlése" és átmenet törlése is ezen.
- [ ] Elevation/shadow tokenek (modal, popover, tooltip)
- [ ] `ConfirmDialog.btn-danger` tokenizálás (hardcoded `#e53935` → token-alapú)

## Sync folyamat (Claude felületek között)

1. **Olvasás**: bármely Claude felületen (claude.ai, Claude Code, desktop) — ez a fájl `git pull` után naprakész.
2. **Módosítás**: a markdown-t szerkeszteni lehet beszélgetés közben; commitálás után a többi felület is látja.
3. **Kód-apply**: a markdown módosítás után `/design-handoff` skill → CSS változások generálása + a megfelelő modul (`tokens.css` / `components/*.css`) patch-elése.
4. **Kód → markdown visszasync**: ha valaki közvetlenül a CSS modulokat editeli, a tokeneket a `tokens.css` `:root` blokk a forrás; a markdown-t manuálisan kell frissíteni (vagy egy script-tel, ami a `:root`-ot lexeli).

Nincs "live bi-directional sync" — a git a szinkronizáló mechanizmus.
