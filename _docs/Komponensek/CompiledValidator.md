---
tags: [komponens, workflow, validáció, jogosultság]
---

# CompiledValidator (`maestro-shared/compiledValidator.js`)

Hard contract validátor a workflow `compiled` JSON-ra ([[Döntések/0008-permission-system-and-workflow-driven-groups|ADR 0008]] A.1.9). A `compiled.requiredGroupSlugs[].slug` halmaz **kanonikus** — minden slug-hivatkozó mező csak ennek elemeit tartalmazhatja.

## Hely

`packages/maestro-shared/compiledValidator.js` — shared modul, hogy a kliens-oldali Designer save flow és a tervezett szerver-oldali write-path enforcement (A.2.1) ugyanazt a validátort hívhassa.

## API

```js
import { validateCompiledSlugs, summarizeValidationErrors } from '@shared/compiledValidator.js';

const { valid, errors } = validateCompiledSlugs(compiled);
// errors[]: { code, slug?, location?, message }
//   code: 'unknown_group_slug' | 'duplicate_required_group_slug'
//       | 'invalid_required_group_entry' | 'invalid_field_type' | 'invalid_compiled'

if (!valid) {
    setSaveError(summarizeValidationErrors({ valid, errors }));
}
```

## Ellenőrzött mezők

A 7 slug-hivatkozó mező + a `requiredGroupSlugs[]` belső konzisztencia:

| Mező | Várt típus | Hibakód típus-eltérésnél |
|---|---|---|
| `requiredGroupSlugs[]` | array of `{slug, ...}` | `invalid_field_type` |
| `transitions[].allowedGroups` | string[] | `invalid_field_type` |
| `commands[stateId][*].allowedGroups` | string[] | `invalid_field_type` |
| `elementPermissions[scope][element].groups` (csak ha `type === 'groups'`) | string[] | `invalid_field_type` |
| `leaderGroups[]` | string[] | `invalid_field_type` |
| `statePermissions[stateId][]` | string[] | `invalid_field_type` |
| `contributorGroups[].slug` | array of `{slug, ...}` | `invalid_field_type` |
| `capabilities[name][]` | string[] | `invalid_field_type` |

A belső `asSlugArray(value, location)` és `asObject(value, location)` helperek kerülik a `for...of` exception-t és a string-char-iterálást — malformed-but-parseable input esetén tiszta validation error a kimenet.

## Becsatornázás

| Hely | Mit csinál |
|---|---|
| [WorkflowDesignerPage.handleSave](../packages/maestro-dashboard/src/features/workflowDesigner/WorkflowDesignerPage.jsx) | A graph-validáció után `validateCompiledSlugs(compiled)` — `unknown_group_slug` esetén `setSaveError`. |
| [`normalizeAndValidateImport`](../packages/maestro-dashboard/src/features/workflowDesigner/compiler.js) | Import-flow közös helper: round-trip + raw + normalized re-check. Használja a [[CreateWorkflowModal]] (`packages/maestro-dashboard/src/components/workflows/CreateWorkflowModal.jsx`) és az [[ImportDialog]]-pattern (Designer-en belüli import). |
| Szerver-oldali `create_workflow` / `update_workflow` / `duplicate_workflow` CF (A.2.1, **implementált**) | `validateCompiledSlugs` re-export a [helpers/compiledValidator.js](../packages/maestro-server/functions/invite-to-organization/src/helpers/compiledValidator.js)-ből, ami a [_generated_compiledValidator.js](../packages/maestro-server/functions/invite-to-organization/src/helpers/_generated_compiledValidator.js)-t (auto-generated CommonJS pillanatkép a shared modulból) require-eli. Hard contract write-path enforcement: `unknown_group_slug` 400 + `errors`/`unknownSlugs` payload. **A.7.1 (2026-05-03) óta single-source**: a [scripts/build-cf-validator.mjs](../scripts/build-cf-validator.mjs) generátor ESM → CJS textuális transzformációval (post-transform token-guard `import`/`export`/dynamic `import()` esetére) generálja a CF-pillanatképet. Yarn parancsok: `yarn build:cf-validator` (regenerál) és `yarn check:cf-validator` (drift-detect, exit 1 mismatch-re). |

## `normalizeAndValidateImport(compiled, graph)`

Az import-flow közös helper a `compiler.js`-ben — a duplikált `compiledToGraph → graphToCompiled → validateCompiledSlugs` round-trip-et egyetlen függvényhívásra cseréli. Visszaad:
- `{ ok: false, structuralError }` — ha a `compiledToGraph` vagy `graphToCompiled` exception-t dob (malformed JSON, nem-iterálható mezők).
- `{ ok: true, normalizedCompiled, normalizedGraph, nodes, edges, metadata, viewport, validation }` — minden más esetben.

A **raw input pre-validáció** (Codex stop-hook iter 4): ha a `compiled.requiredGroupSlugs` JELEN van, a raw `validateCompiledSlugs(compiled)` MEGELŐZI a round-trip-et — különben a `reconstructRequiredGroupSlugs()` elmaszkolná a típushibákat (pl. `leaderGroups: 'admins'` char-ra bomlana). Legacy compiled (mező hiány) esetén a raw check kihagyásra kerül (különben minden slug `unknown_group_slug` lenne, és a meglévő export-ok unloadable-vé válnának).

## Race-elhárítás az import-flow-ban

A `ImportDialog` és `CreateWorkflowModal` mindkét komponens védve van három async race ellen (Codex stop-hook iter 5-6):

1. **Stale `importData` reset** — a parse `await` ELŐTT `setImportData(null)`. Új upload a régi adatot azonnal kitörli; egy retry közben a Confirm/Submit gomb disabled.
2. **Out-of-order completion** — `parseSeqRef` ref minden `handleFileChange` elején bumpolódik; a parse-callback minden `setState` előtt `seq !== parseSeqRef.current` esetén korai return-nel kilép.
3. **Submit-vs-parse** (csak `CreateWorkflowModal`) — `isParsingImport` state, a `canSubmit` figyel rá: a Submit gomb blokkolt amíg a parse fut. A `handleClose` / `useEffect cleanup` is bumpolja a seq-et, hogy close/unmount után a parse callback ne írjon stale state-et.

## Hibakódok ↔ UI

| Code | UI-megjelenítés (Designer) | Forrás |
|---|---|---|
| `invalid_compiled` | "A compiled JSON üres vagy érvénytelen." | `validateCompiledSlugs(null)` |
| `invalid_field_type` | "A `<location>` mezőnek tömbnek/objektumnak kell lennie." | malformed JSON |
| `invalid_required_group_entry` | "A `requiredGroupSlugs[i]` elemnek hiányzik vagy érvénytelen a slug." | félkész szerkesztés |
| `duplicate_required_group_slug` | "A requiredGroupSlugs többször tartalmazza a `<slug>`-ot." | mentés-előtti duplikáció |
| `unknown_group_slug` | "Az `<location>` csoport nem szerepel a `requiredGroupSlugs[]`-ban: `<slug>`." | a hard contract sértés |

A `summarizeValidationErrors(result)` helper az UI-friendly összefoglalót adja (Designer save error / CF response details).

## Kapcsolódó

- ADR: [[Döntések/0008-permission-system-and-workflow-driven-groups]]
- Komponens: [[WorkflowLibrary]], [[PermissionTaxonomy]]
- Csomag: [[Csomagok/dashboard-workflow-designer]]
- Séma: [[workflow-designer/COMPILED_SCHEMA#requiredGroupSlugs]]
