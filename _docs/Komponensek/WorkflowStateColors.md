---
tags: [komponens, dashboard, plugin, workflow, designer, shared]
aliases: [WORKFLOW_STATE_COLORS, nextAvailableColor]
---

# WorkflowStateColors

## Cél
Közös workflow-állapot színpaletta + foglaltság-helper a Dashboard Workflow Designer és a `defaultWorkflow.json` seed számára. Egyetlen igazságforrás: case-insensitive összehasonlítás biztosítja, hogy a legacy lower-case értékek is "használtnak" számítsanak.

## Helye
- **Forrás**: `packages/maestro-shared/workflowStateColors.js`
- **Fogyasztók**:
  - `packages/maestro-dashboard/src/features/workflowDesigner/NodePalette.jsx` (új állapot szín-választó)
  - `packages/maestro-dashboard/src/features/workflowDesigner/defaultWorkflow.json` (seed)

## Felület (API)

```js
export const WORKFLOW_STATE_COLORS = ['#...', '#...', /* 8 hex érték */];

/**
 * @param {string[]} usedColors  // case-insensitive
 * @returns {string}             // a paletta első nem-foglalt eleme;
 *                                // ha minden foglalt, ciklikusan újrahasznosít
 */
export function nextAvailableColor(usedColors) { /* ... */ }
```

## Felhasználás
A `NodePalette` egyetlen "+ Új állapot" gombbal dolgozik: a `WorkflowDesignerPage` `usedNodeColors` memo-ja (a canvas összes node-jának színe) átadódik a Palette-be, amely `nextAvailableColor()`-ral húzza a legközelebbi szabad színt. Ha minden foglalt, a paletta ciklikusan újrahasznosít — a hint sávban erről info látszik.

## Gotchas
- **Case-insensitive**: a `usedColors` lehet `'#3B82F6'` és `'#3b82f6'` keverten — a helper mindkettőt foglaltnak tekinti.
- **Paletta sorrend stabilitása**: ne rendezd át a tömböt nem-determinisztikus módon, a workflow-k seedjei a sorrendre támaszkodnak.

## Kapcsolódó
- Komponensek: [[WorkflowEngine]], [[StateComplianceValidator]]
- Csomag: [[Csomagok/dashboard-workflow-designer]]
- ADR: [[Döntések/0006-workflow-lifecycle-scope]] (átfogó workflow-context)
