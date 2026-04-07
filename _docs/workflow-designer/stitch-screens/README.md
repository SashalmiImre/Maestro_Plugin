# Stitch screens — Workflow Designer UI tervek

Ebben a mappában a Stitch MCP-vel generált képernyőtervek találhatók a Fázis 0 részeként. Minden képhez tartozik egy `.png` és egy `.md` annotáció pár.

**Stitch projekt**: [Maestro Dashboard — Modern Redesign](https://stitch.withgoogle.com/projects/6473627341647079144) (`projects/6473627341647079144`)
**Design system**: „The Digital Curator" — dark glassmorphism, obsidian surfaces, no-line rule, blue accent gradientek.

## Generált képernyők

| Slug | Állapot | Fájlok | Cél fázis |
|------|---------|--------|-----------|
| `auth-flow` | ✅ Kész | [auth-flow.png](auth-flow.png) + [auth-flow.md](auth-flow.md) | Fázis 1 — auth routes |
| `designer-canvas` | ✅ Kész | [designer-canvas.png](designer-canvas.png) + [designer-canvas.md](designer-canvas.md) | Fázis 5 — Workflow Designer |
| `state-node` | ✅ Kész | [state-node.png](state-node.png) + [state-node.md](state-node.md) | Fázis 5 — Workflow Designer |
| `properties-sidebar` | ✅ Kész | [properties-sidebar.png](properties-sidebar.png) + [properties-sidebar.md](properties-sidebar.md) | Fázis 5 — Workflow Designer |

## Generálási előzmény

- **2026-04-06**: az `auth-flow` siker, a többi 3 hívás kliens timeout-tal hibázott.
- **2026-04-07 reggel**: retry kísérlet egyenként a finomított promptokkal — kliens oldalon mind a három `generate_screen_from_text` újból timeout-tal hibázott. Akkor úgy tűnt, hogy a Stitch projektben sem keletkezett új screen.
- **2026-04-07 később**: a `list_screens` mégis 6 új screen-t talált — a Stitch szerver háttérben befejezte a generálást a kliens timeout után. Mindhárom kategóriához 2 variánst készített. A strukturálisan teljesebb variánsokat választottuk ki:
  - `designer-canvas`: variant B (`05982df3413e4c04b52631ef2111e7ef`) — három-oszlop teljes lefedés
  - `state-node`: variant A (`c45123d03e12456fb6f4856019c14f34`) — a kért 2×2 grid
  - `properties-sidebar`: variant B (`cf75bd0271b54838b47f26248a3af3ac`) — minden mező felirattal
- **Tanulság**: a Stitch tool dokumentációja külön kiemeli, hogy timeout után érdemes később `get_screen`-nel ellenőrizni — most ez valóban így volt. A jövőben egy timeout-ra ne adjuk fel, néhány perc múlva listázzuk a projektet.

## Megjegyzések

- Minden Stitch képhez a fenti `auth-flow.md` minta szerint készítsd el az annotációt: mit mutat, mely React komponensekbe fordul, design tokenek, manuális React munka.
- Az annotációk a később létrejövő React komponensek első iterációjához adnak **layout alapot és vizuális irányt**, nem 1:1 HTML → JSX fordítást.
- Ha a generált kép nem pontos (pl. rossz színek, hiányzó elemek), a prompt finomítható az [UI_DESIGN.md](../UI_DESIGN.md) alapján, és egy új változat generálható.
