---
tags: [komponens, plugin, dashboard, workflow, extensions, partially-implemented]
aliases: [WorkflowExtension, Custom validator, Custom command]
---

# WorkflowExtension (Partially Implemented)

> **Státusz**: szerver-oldal + plugin runtime kész, Designer editor hátra. Részletes ADR: [[Döntések/0007-workflow-extensions]].
>
> **Részleges implementáció (2026-05-05)**: B.1 (adatmodell) + B.2 (shared kontraktus) + **B.3 (CF CRUD + activate_publication snapshot + post-event guard) ✅ kész** (commit-csomag: f8537d4 → 76430fb a `feature/maestro-redesign` branchen) + **B.4 (Plugin runtime: `extensionRegistry.js`, [[ExtensionRegistry]], DataContext derived state, StateComplianceValidator + commands/index.js dispatch) ✅ kész** (unstaged a `feature/maestro-redesign` branchen, 2026-05-05). Hátra: B.5 (Designer editor tab).

## Cél
DB-ben tárolt, dinamikusan betöltődő ExtendScript-alapú parancs vagy validátor, amelyre a workflow JSON `ext.<slug>` prefixszel hivatkozik. A beépített parancsok és validátorok mellett él, plugin újradeploy nélkül bővíthető.

## Helye
- **Adatmodell** (B.1.1, kész): `workflowExtensions` Appwrite collection — schema bootstrap a `bootstrap_workflow_extension_schema` CF action-en át, doc-szintű ACL `buildExtensionAclPerms` (`teamHelpers.js`).
- **Shared kontraktus** (B.2.1, kész): [packages/maestro-shared/extensionContract.js](../../packages/maestro-shared/extensionContract.js) — konstansok (`MAESTRO_EXTENSION_GLOBAL_NAME`, `EXTENSION_REF_PREFIX`, kind/scope enum-ok, slug/name méret-korlátok), `validateExtensionSlug()` slug-validátor, `isExtensionRef()` / `parseExtensionRef()` workflow JSON ref-helperek.
- **CF CRUD action-ök** (B.3.1+B.3.2, ✅ kész): [packages/maestro-server/functions/invite-to-organization/src/actions/extensions.js](../../packages/maestro-server/functions/invite-to-organization/src/actions/extensions.js) — `create_workflow_extension`, `update_workflow_extension`, `archive_workflow_extension`. Permission gate (`extension.create/edit/archive`), [acorn](https://github.com/acornjs/acorn) ECMA3 pre-parse a `code` mezőre (`ecmaVersion: 3`, sourceType `script`) + AST-szintű top-level `function maestroExtension(...)` `FunctionDeclaration` ellenőrzés, 256 KB operatív cap (a séma 1 MB-ot enged), slug/name validátor.
- **Snapshot pipeline** (B.3.3, ✅ kész): [packages/maestro-server/functions/invite-to-organization/src/helpers/extensionSnapshot.js](../../packages/maestro-server/functions/invite-to-organization/src/helpers/extensionSnapshot.js) — három export:
  - `extractExtensionRefs(compiled)` → `{ validatorSlugs: Set<string>, commandSlugs: Set<string> }`. A `compiled.validations` (state → `{onEntry, requiredToEnter, requiredToExit}`) és `compiled.commands` (state → `[{id, allowedGroups}]`) struktúrákban keresi az `ext.<slug>` hivatkozásokat. A validation item-ek lehetnek string (`"ext.foo"`) vagy object (`{validator: "ext.foo", options}`); a command item-ek CSAK object-alakok (`{id, allowedGroups}`).
  - `fetchExtensionsForOffice(databases, env, sdk, officeId, requestedSlugs)` — paginált `listDocuments` (limit 100, cursor) `Query.equal('editorialOfficeId', officeId)`-zal, az `archivedAt` szűrése MEMÓRIÁBAN (`!doc.archivedAt`). Csak a `requestedSlugs` Set-ben szereplő slug-okat tartja meg. Visszatér: `Map<slug, extensionDoc>`.
  - `buildExtensionSnapshot(databases, env, sdk, compiled, officeId)` — fail-fast pipeline: (1) ref-extract; (2) ha 0 hivatkozás → `{ ok: true, snapshot: '{}' }` (NEM null, hogy különbözzön a B.3 előtti legacy állapottól); (3) fetch (try/catch → `{ ok: false, status: 500, reason: 'extension_fetch_failed', payload: { error: err.message, note } }` — a payload-ban **MEGADJA** a raw `err.message`-t a CF debug-flow-jához); (4) hiányzó slug → `{ ok: false, status: 422, reason: 'missing_extension_references', payload: { missing: [...] } }`; (5) **kind-konzisztencia invariáns** (validations[] csak `kind:'validator'`, commands[] csak `kind:'command'`) → `{ ok: false, status: 422, reason: 'extension_kind_mismatch', payload: { mismatches: [{slug, expected, actual, lane}] } }`; (6) JSON-szerializálás slug-szerint sortolt **flat map**: `{[slug]: { name, kind, scope, code }}` — schemaVersion vagy extensions[] tömb NINCS, `$id`/`$updatedAt` NEM kerül a snapshot-ba; (7) `EXTENSION_SNAPSHOT_MAX_BYTES` cap → `{ ok: false, status: 422, reason: 'extension_snapshot_too_large' }`. Az `activate_publication` action a return-elt `snapshot` stringet a `compiledExtensionSnapshot` mezőbe írja közvetlenül.
- **Scope-helper** (B.3.3 simplify, ✅ kész): [packages/maestro-server/functions/invite-to-organization/src/helpers/workflowScope.js](../../packages/maestro-server/functions/invite-to-organization/src/helpers/workflowScope.js) — `matchesWorkflowVisibility(workflowDoc, target)` egyetlen forrás a 3-way visibility check-re (`createPublicationWithWorkflow` / `assignWorkflowToPublication` / `activatePublication`).
- **Post-event guard** (B.3.3, ✅ kész): [packages/maestro-server/functions/validate-publication-update/src/main.js](../../packages/maestro-server/functions/validate-publication-update/src/main.js) — három B.3.3 réteg:
  - **§5c-A**: ha `payload.isActivated:true` ÉS a caller nem `server-guard` → deaktiválás 4 mezővel (`isActivated`, `activatedAt`, `compiledWorkflowSnapshot`, `compiledExtensionSnapshot`). Direct REST bypass elleni védelem; csak az `activate_publication` CF action írhat aktivációt (az SERVER_GUARD early-skip-pel megússza a teljes CF-et).
  - **§5c-B**: ha `freshDoc.isActivated=true` ÉS a `compiledExtensionSnapshot` null/üres ÉS a payload nem érintette az `isActivated`-ot → deaktiválás. B.3 előtti legacy pubok fail-closed kezelése (első update-jükkor self-correct).
  - **§6b** (kiterjesztés #37-ből): ha a payload közvetlenül érinti a `compiledWorkflowSnapshot` VAGY `compiledExtensionSnapshot` mezőt ÉS a caller nem `server-guard` → deaktiválás + mindkét snapshot mező null-ra. Új aktiválást kényszerít.
- **Plugin runtime** (B.4, ✅ kész — 2026-05-05): [packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js](../../packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js) — részletes leírás: [[ExtensionRegistry]]. Belépési pontok: [[DataContext]] derived `extensionRegistry` (snapshot-preferáló useMemo) + [[StateComplianceValidator]] `_checkExtensionValidator` + `commands/index.js` `executeCommand` `ext.<slug>` ág + [[WorkflowEngine]] `validateTransition`/`executeTransition` opcionális `extensionRegistry` paraméter. A `MaestroEvent.workflowExtensionsChanged` Realtime event Phase 0-ban consumer-mentes (snapshot-only stratégia).
- **Dashboard editor** (B.5, tervezett): `packages/maestro-dashboard/src/features/workflowDesigner/extensions/...`

## Kontraktus

A user által írt ExtendScript modul **egyetlen kötött globális függvényt** exportál:

```js
function maestroExtension(input) {
    // Phase 0 input: validator → { article }, command → { article, publicationRoot }
    // Phase 1+ input: a `options` mező + `publication` scope kibővítés a paramSchema mentén
    return { /* JSON eredmény */ };
}
```

| `kind` | Bemenet (Phase 0) | Kimenet |
|---|---|---|
| `validator` | `{ article }` | `{ isValid: bool, errors: [], warnings: [] }` |
| `command` | `{ article, publicationRoot }` | `{ success: bool, error?, message? }` |

> **Phase 0 hatókör-szűkítés (B.0.4)**: a per-workflow `options` ÜRES / nem továbbított — a Designer ValidationListField/CommandListField az ismeretlen `options` mezőt eldobja. A Phase 1+ `paramSchema` + Designer options-szerkesztő + Plugin runtime options-átadás ezt megnyitja.
>
> **`publicationRoot` vs `publication`**: a Plugin runtime a publikáció `rootPath` STRINGJÉT adja át a command-nek (nem a teljes publication objektumot) — ld. [`commands/index.js`](../../packages/maestro-indesign/src/core/commands/index.js).

A kód kizárólag InDesign ExtendScript lehet — a beépített parancsok és validátorok is ezen a runtime-on futnak, nincs külön JS sandbox.

## Adatmodell

| Mező | Típus | Megjegyzés |
|---|---|---|
| `name` | string | Emberi név |
| `slug` | string | Egyedi szerkesztőségen belül; a `compiled.validations` / `commands` listában `ext.<slug>` |
| `kind` | enum | `validator` \| `command` |
| `scope` | enum | Phase 0: **csak `article`** a sémában (fail-closed); Phase 1+ `updateEnumAttribute` add-eli a `publication`-t |
| `code` | string | ExtendScript forrás (acorn ECMA3 pre-parse + AST top-level `maestroExtension` FunctionDeclaration check; 256 KB operatív cap) |
| ~~`paramSchema`~~ | ~~string (JSON, opcionális)~~ | **HALASZTVA Phase 1+-ba** (B.0.4 hatókör-szűkítés, [[Döntések/0007-workflow-extensions]]) — a Designer `ValidationListField` és `CommandListField` Phase 0-ban nem támogat per-extension options-szerkesztőt, így a séma sem tartalmazza |
| `visibility` | enum | A séma `editorial_office` / `organization` / `public` 3-way-t enged (uo. mint a workflow-knál); **a B.3.1 CRUD action Phase 0-ban CSAK `editorial_office`-t fogad el** (`assertVisibilityOrFail` → 400 `unsupported_visibility`). A non-default scope Phase 1+ `extension.share` permission slug-ot követelne, amit az A.3.6-os taxonómia még nem tartalmaz |
| `archivedAt` | datetime, nullable | Soft-delete (implicit restore: `update_workflow_extension` `archivedAt: null` payload-dal — Phase 0-ban nincs külön `restore_workflow_extension` action) |
| `editorialOfficeId` / `organizationId` / `createdByUserId` | string (36) | Tenant-scope + audit mezők, `buildExtensionAclPerms` ACL-számoláshoz |

## Snapshot-pattern
A kiadvány aktiválásakor a workflow `compiledWorkflowSnapshot` mellé az **extension-snapshot** is rögzül (a használt extension-ök kódja + metaadata). A futó publikáció alól nem módosítható — bug-fix új aktiválást igényel. Részletek: [[Döntések/0006-workflow-lifecycle-scope]] snapshot-pattern.

## Phase-ek

| Phase | Mit fed le |
|---|---|
| **0 (MVP)** | `validator` / `command` × `article` scope, **permission-based CRUD** (`extension.create/edit/archive` slug-ok az `owner_base`/`admin_base` permission set-ekben — ld. [[PermissionTaxonomy#5. Bővítmények]]), `<textarea>` editor, **acorn ECMA3 pre-parse szintaxis-validáció**. **Per-workflow paraméter-átadás halasztva** (ADR 0007 "Phase 0 hatókör-szűkítés"). |
| **1+** | `publication` scope (`updateEnumAttribute` az enum bővítésére), `paramSchema` + Designer options-szerkesztő, ExtendScript Maestro SDK, marketplace |

## Kapcsolódó
- ADR: [[Döntések/0007-workflow-extensions]]
- Tervek: [[Tervek#Parancsok és validátorok]]
- Snapshot-pattern: [[Döntések/0006-workflow-lifecycle-scope]]
