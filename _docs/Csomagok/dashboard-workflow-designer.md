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
- **Életciklus + scope**: 3-state visibility (`editorial_office` / `organization` / `public`), soft-delete + napi cron, idegen workflow read-only + Duplikál & Szerkeszt CTA — részletek: [[Döntések/0006-workflow-lifecycle-scope]]
- **Workflow könyvtár modal**: közös belépési pont a breadcrumb chip-ből és a publikáció-hozzárendelésből — [[Komponensek/WorkflowLibrary]]
- **Színpaletta**: a NodePalette és a `defaultWorkflow.json` közös szín-forrása — [[Komponensek/WorkflowStateColors]]
- **Custom parancsok / validátorok (terv)**: ExtendScript extension-ek a workflow JSON-ban `ext.<slug>` prefixszel — [[Döntések/0007-workflow-extensions]] (Proposed), [[Komponensek/WorkflowExtension]]
- **Workflow-driven felhasználó-csoportok**: a workflow `compiled.requiredGroupSlugs[]` mezőben definiálja a saját felhasználó-csoport slug-jait `{slug, label, description, color, isContributorGroup, isLeaderGroup}` formában; hozzárendeléskor / aktiváláskor autoseed-elődnek a célszerkesztőségben. A Designer új tabján szerkeszthető (A.4 frontend). A workflow összes többi slug-mezőjének (`transitions.allowedGroups`, `commands.allowedGroups`, `elementPermissions.*.*.groups`, `leaderGroups`, `statePermissions.*`, `contributorGroups[].slug`, `capabilities.*`) választói erre a listára épülnek; mentéskor `unknown_group_slug` validáció (kliens [[Komponensek/CompiledValidator]] + szerver inline másolat A.2.1). A `compiled.contributorGroups[]` és `leaderGroups[]` automatikusan generálódnak a `requiredGroupSlugs` flag-jeiből. Részletek: [[Döntések/0008-permission-system-and-workflow-driven-groups]] + [[workflow-designer/COMPILED_SCHEMA#requiredGroupSlugs]].
- **Workflow-hozzárendelés és aktiváló flow** ([[Döntések/0008-permission-system-and-workflow-driven-groups|ADR 0008]] A.2.2 / A.2.3): a publikációhoz workflow-hozzárendelés és aktiválás az `assign_workflow_to_publication` és `activate_publication` HTTP CF action-ön át megy (közvetlen `databases.updateDocument({workflowId})` / `({isActivated: true})` megkerülné az autoseedet). Mindkét action `seedGroupsFromWorkflow()`-szel hozza létre a hiányzó `requiredGroupSlugs[]` slug-okhoz tartozó `groups` doc-okat (idempotens, first-write-wins, archivált csoport-detektálás warning-gal). Az aktiválás extra check-ekkel: deadline-fedés, min. 1 `groupMembership` minden slug-on (különben 409 `empty_required_groups` + lista), atomic `compiledWorkflowSnapshot` rögzítés `server-guard` sentinellel. Idempotens early return, ha a snapshot string-egyezik a workflow `compiled`-jével. Frontend belépési pont: [[Komponensek/AuthContext]] `activatePublication()` / `assignWorkflowToPublication()`; lokális state-frissítés [[Komponensek/DataContext]] `applyPublicationPatchLocal()`-on át.
- **Permission set guards (terv)**: a Designer-elérés (`workflow.edit`) és a tartalom-szerkesztés (`workflow.state.edit`, `workflow.requiredGroups.edit`, `workflow.permission.edit`, …) `userHasPermission()` guarddal védett — slug-lista: [[Komponensek/PermissionTaxonomy#7. Workflow CRUD — workflow.*]] és [[Komponensek/PermissionTaxonomy#8. Workflow-tartalom — workflow.<sub>.*]]
