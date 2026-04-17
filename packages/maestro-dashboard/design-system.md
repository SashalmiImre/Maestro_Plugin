# Maestro Dashboard — Design System

> Egyetlen forrása a Dashboard design tokeneknek és komponens-konvencióknak.
> A fájl a repóval együtt verziókövetett — Claude bármelyik felületén (claude.ai chat, Claude Code, desktop app) ugyanazt látja. Módosításhoz edit + code-apply (`/design-handoff` skill).

## Token forrás

A runtime értékek a [css/styles.css](css/styles.css) `:root` blokkjában élnek. Ez a dokumentum ember-olvasható tükrözés; a kódváltás mindig ott történik.

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
| `--text-muted` | `#8c909f` | Placeholder, metadata (`outline`) |
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

### Badge variánsok (lock)
| Variáns | Háttér | Szöveg | Keret |
|---|---|---|---|
| **me** (saját lock) | `--badge-me-bg` | `--badge-me-text` | `--badge-me-border` |
| **sys** (system lock) | `--badge-sys-bg` | `--badge-sys-text` | `--badge-sys-border` |
| **other** (másik user) | `--badge-other-bg` | `--badge-other-text` | `--badge-other-border` |

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

**Sweep állapota (#48)**: a `border-radius`, `gap`, és single-value `padding` property-ket már `var(--space-*)` / `var(--radius-*)` tokenekre cseréltük a `styles.css`-ben. A shorthand értékek (pl. `padding: 8px 16px`) és a component-szintű `padding-left/right` property-k inkrementálisan tokenizálandók, amikor az érintett komponens módosul.

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

### Danger Action
Háttér `transparent`, szöveg `--c-error`, keret `1px solid --c-error`. Hover: `--c-error` 10%-os háttér.
**Minden Veszélyes zóna** (Org/Office/Publication törlés, Workflow állapot törlés) ezt használja.

### Modal
- Háttér `--bg-overlay`
- Backdrop `rgba(0,0,0,0.6)`
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

## Hiányzó / TODO

- [ ] Spacing tokenek bevezetése (sweep a `styles.css`-en)
- [ ] Radius tokenek bevezetése
- [ ] Font-size skála kodifikálása
- [ ] IconButton komponens stílus-szabvány (`aria-label` kötelező, 3 méret)
- [ ] DangerAction egységesítés (Workflow Designer „Állapot törlése" is kerüljön rá)
- [ ] Elevation/shadow tokenek (modal, popover, tooltip)

## Sync folyamat (Claude felületek között)

1. **Olvasás**: bármely Claude felületen (claude.ai, Claude Code, desktop) — ez a fájl `git pull` után naprakész.
2. **Módosítás**: a markdown-t szerkeszteni lehet beszélgetés közben; commitálás után a többi felület is látja.
3. **Kód-apply**: a markdown módosítás után `/design-handoff` skill → SCSS változások generálása + `styles.css` patch.
4. **Kód → markdown visszasync**: ha valaki közvetlenül `styles.css`-t edit, a tokeneket a `:root` blokk a forrás; a markdown-t manuálisan kell frissíteni (vagy egy script-tel, ami a `:root`-ot lexeli).

Nincs "live bi-directional sync" — a git a szinkronizáló mechanizmus.
