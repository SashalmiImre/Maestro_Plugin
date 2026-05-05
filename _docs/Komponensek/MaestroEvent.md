---
tags: [komponens, plugin, esemény]
aliases: [MaestroEvent, dispatchMaestroEvent, maestroEvents]
---

# MaestroEvent

## Cél
Window-alapú `CustomEvent` rendszer — komponensek közti **laza csatolás**. Bekövetkezett tények (múlt idő) szignalizálása az UI / context / service rétegek közt.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/config/maestroEvents.js:23` (event-konstansok), `:99` (`dispatchMaestroEvent`)

## Felület (API)
- **Konstansok**: `MaestroEvent.documentSaved`, `.documentClosed`, `.stateChanged`, `.pageRangesChanged`, `.sessionExpired`, `.scopeChanged`, `.dataRefreshRequested`, `.groupMembershipChanged`, `.permissionSetsChanged` (A.5.3), `.workflowChanged`, `.workflowExtensionsChanged` (B.4.3, ADR 0007 Phase 0), `.endpointSwitched`, … (16+ tag, kebab-case, `maestro:` prefix)
- **Dispatch**: `dispatchMaestroEvent(eventName, detail?)` — `CustomEvent`-et hoz létre és `window`-ra küld
- **Subscribe**: standard DOM API: `window.addEventListener(MaestroEvent.eventName, handler)`

## Permission-rendszer eseményei (A.5.3, ADR 0008)
- `groupMembershipChanged` — `groupMemberships` collection változás. Detail: `{ groupId }`. Handler: [[UserContext]] `refreshGroupSlugs` + `refreshPermissions`, [[Komponensek/useContributorGroups]] cache-invalidate.
- `permissionSetsChanged` — `permissionSets` vagy `groupPermissionSets` collection változás (Realtime subscribe a UserContext-ben, 200ms debounce, scope-szűrt). Detail: `{ source: 'realtime' }`. Handler: [[UserContext]] `refreshPermissions`.

## Workflow extension eseményei (B.4.3, ADR 0007 Phase 0)
- `workflowExtensionsChanged` — `workflowExtensions` collection változás (Realtime). Nincs detail. **Phase 0-ban consumer nincs**: a Plugin runtime az aktivált publikáció `compiledExtensionSnapshot`-jából építi a registry-t ([[ExtensionRegistry]]), amely immutable az aktivált pub élettartama alatt. Az event jövőbeli non-snapshot fallback / Designer plugin tab számára él.

## Kapcsolatok
- **Hívják (dispatch)**: minden context ([[DataContext]], [[UserContext]], [[ValidationContext]], [[ScopeContext]] (TBD)), magasabb hookok (`useWorkflowValidation`, `useOverlapValidation`)
- **Figyelői**: [[DocumentMonitor]] (`documentClosed`), [[WorkflowEngine]] (`stateChanged` trigger), [[ValidationContext]] (`scopeChanged` reset), [[RecoveryManager]] (`dataRefreshRequested`), [[UserContext]] (`sessionExpired`, `groupMembershipChanged`, `permissionSetsChanged`, `scopeChanged`); `workflowExtensionsChanged` Phase 0-ban consumer-mentes

## Gotchas
- **Nincs return value** — események aszinkronok, a handler nem tudja blokkolni a dispatch-et vagy értéket visszaadni. Komplexebb koordinációhoz Promise-pairing kell (pl. `registerTask` minta a [[DocumentMonitor]]-ban).
- **Bekövetkezett tények**: az event név mindig **múlt idő** (`documentSaved`, NEM `saveDocument`). A handler az új állapotból dolgozik, nem kérelmet teljesít.

## Kapcsolódó
- [[DocumentMonitor]], [[WorkflowEngine]], [[ValidationContext]], [[RecoveryManager]], [[UserContext]], [[ExtensionRegistry]]
- [[Munkafolyamat]]
- [[Döntések/0007-workflow-extensions]]
