---
tags: [csomag, dashboard, workflow-designer, sub-feature]
aliases: [Workflow Designer]
---

# Dashboard — Workflow Designer

## Cél
A Maestro hardkódolt, egybérlős workflow-jának átalakítása teljesen dinamikus, multi-tenant rendszerré. ComfyUI-stílusú vizuális workflow designer a Dashboardon. A feature saját, részletes dokumentációval rendelkezik a `_docs/workflow-designer/` mappában.

## Belépési pont
- **[[workflow-designer/PROGRESS]]** — minden új Claude Code session első olvasnivalója (aktuális fázis, checklist, nyitott kérdések, session jegyzetek). 111 KB — gondozott munkanapló.

## Részletes dokumentumok
| Dokumentum | Leírás |
|---|---|
| [[workflow-designer/ARCHITECTURE]] | A multi-tenant átalakítás + dinamikus workflow rendszer átfogó leírása |
| [[workflow-designer/DATA_MODEL]] | Új és módosuló Appwrite collection-ök részletes leírása |
| [[workflow-designer/COMPILED_SCHEMA]] | A `workflows.compiled` mező formális JSON sémája — runtime egyetlen igazságforrása |
| [[workflow-designer/MIGRATION_NOTES]] | Régi (statikus) → új (dinamikus) megfeleltetési táblázatok |
| [[workflow-designer/UI_DESIGN]] | Stitch MCP-vel generált képernyőtervek + annotációk |

## UI minták (`workflow-designer/stitch-screens/`)
- `auth-flow.md` + `auth-flow.png`
- `designer-canvas.md` + `designer-canvas.png`
- `properties-sidebar.md` + `properties-sidebar.png`
- `state-node.md` + `state-node.png`

A design rendszer: Dashboard Stitch „Digital Curator" design tokenek (glassmorphism, `--bg-base`, `--accent`, no-line border).

## Kapcsolódás a vault többi részéhez
- **Package**: [[maestro-dashboard]] — a feature a `packages/maestro-dashboard/src/features/workflowDesigner/` alatt él
- **Package CLAUDE.md**: [[packages/maestro-dashboard/CLAUDE]]
- **Realtime**: a Workflow Designer doc-szintű Realtime csatornát használ ([[Komponensek/RealtimeBus]] `documentChannel`-en át) — ütközés-warning remote version eltérésnél
- **Compiled snapshot**: a Plugin a `workflows.compiled` JSON-t olvassa runtime-on; a Dashboard [[Komponensek/DataContext]] `workflow` derived state ezt parsolja
- **Adatmodell**: az Appwrite `workflows` collection a fázis 2 dinamikus csoport-rendszer része ([[Döntések/0002-fazis2-dynamic-groups]])
