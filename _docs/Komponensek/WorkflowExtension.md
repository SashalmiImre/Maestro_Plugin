---
tags: [komponens, plugin, dashboard, workflow, extensions, proposed]
aliases: [WorkflowExtension, Custom validator, Custom command]
---

# WorkflowExtension (Proposed)

> **Státusz**: tervezett. Részletes ADR: [[Döntések/0007-workflow-extensions]].
>
> **Részleges implementáció (2026-05-04)**: B.1 (adatmodell) + B.2 (shared kontraktus) kész. Részletek alább a "Helye" és "Kontraktus" szekciókban; B.3 (CF CRUD) és B.4 (plugin runtime) hátra van.

## Cél
DB-ben tárolt, dinamikusan betöltődő ExtendScript-alapú parancs vagy validátor, amelyre a workflow JSON `ext.<slug>` prefixszel hivatkozik. A beépített parancsok és validátorok mellett él, plugin újradeploy nélkül bővíthető.

## Helye
- **Adatmodell** (B.1.1, kész): `workflowExtensions` Appwrite collection — schema bootstrap a `bootstrap_workflow_extension_schema` CF action-en át, doc-szintű ACL `buildExtensionAclPerms` (`teamHelpers.js`).
- **Shared kontraktus** (B.2.1, kész): [packages/maestro-shared/extensionContract.js](../../packages/maestro-shared/extensionContract.js) — konstansok (`MAESTRO_EXTENSION_GLOBAL_NAME`, `EXTENSION_REF_PREFIX`, kind/scope enum-ok, slug/name méret-korlátok), `validateExtensionSlug()` slug-validátor, `isExtensionRef()` / `parseExtensionRef()` workflow JSON ref-helperek.
- **Plugin runtime** (B.4, tervezett): `packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js`
- **Dashboard editor** (B.5, tervezett): `packages/maestro-dashboard/src/features/workflowDesigner/extensions/...`

## Kontraktus

A user által írt ExtendScript modul **egyetlen kötött globális függvényt** exportál:

```js
function maestroExtension(input) {
    // input = JSON: { article, options, publication }
    return { /* JSON eredmény */ };
}
```

| `kind` | Bemenet | Kimenet |
|---|---|---|
| `validator` | `{ article, options }` | `{ isValid: bool, errors: [], warnings: [] }` |
| `command` | `{ article, options, publicationRoot }` | `{ success: bool, error?, message? }` |

A kód kizárólag InDesign ExtendScript lehet — a beépített parancsok és validátorok is ezen a runtime-on futnak, nincs külön JS sandbox.

## Adatmodell

| Mező | Típus | Megjegyzés |
|---|---|---|
| `name` | string | Emberi név |
| `slug` | string | Egyedi szerkesztőségen belül; a `compiled.validations` / `commands` listában `ext.<slug>` |
| `kind` | enum | `validator` \| `command` |
| `scope` | enum | `article` \| `publication` (Phase 0: csak `article`) |
| `code` | string | ExtendScript forrás |
| `paramSchema` | string (JSON, opcionális) | Designer UI builder |
| `visibility` | enum | `editorial_office` / `organization` / `public` (uo. mint a workflow-knál) |
| `archivedAt` | datetime, nullable | Soft-delete |

## Snapshot-pattern
A kiadvány aktiválásakor a workflow `compiledWorkflowSnapshot` mellé az **extension-snapshot** is rögzül (a használt extension-ök kódja + metaadata). A futó publikáció alól nem módosítható — bug-fix új aktiválást igényel. Részletek: [[Döntések/0006-workflow-lifecycle-scope]] snapshot-pattern.

## Phase-ek

| Phase | Mit fed le |
|---|---|
| **0 (MVP)** | `validator` / `command` × `article` scope, admin-only CRUD, `<textarea>` editor, alap szintaxis-validáció |
| **1+** | `publication` scope, ExtendScript Maestro SDK, marketplace, jogosultsági integráció |

## Kapcsolódó
- ADR: [[Döntések/0007-workflow-extensions]]
- Tervek: [[Tervek#Parancsok és validátorok]]
- Snapshot-pattern: [[Döntések/0006-workflow-lifecycle-scope]]
