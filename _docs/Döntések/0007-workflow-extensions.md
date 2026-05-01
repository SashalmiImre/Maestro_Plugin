---
tags: [adr, workflow, extensions, plugin, runtime]
status: Proposed
date: 2026-05-01
---

# 0007 — Workflow Extensions (parancsok és validátorok dinamikus rendszere)

## Kontextus

A Maestro workflow runtime jelenleg **hardkódolt parancsok és validátorok** halmazát ismeri (`packages/maestro-indesign/src/core/utils/validators/`, `commands/`). Bővítés = plugin újradeploy. Egy szerkesztőség egyedi munkafolyamat-igényei (egyedi cikk-ellenőrzés, megrendelői logikák) így nem tudnak self-service módon belépni — a fejlesztőkhöz kell fordulni.

Cél: **DB-ben tárolt, dinamikusan betöltött parancsok és validátorok**, a workflow JSON-ban hivatkozhatóak. A meglévő, beépített parancsok és validátorok változatlanul maradnak — az új extension-ek mellettük élnek.

## Döntés

**Egyetlen `workflowExtensions` Appwrite collection + InDesign ExtendScript runtime + JSON kontraktus.**

### Adatmodell (`workflowExtensions` collection)

| Mező | Típus | Leírás |
|---|---|---|
| `name` | string | Emberi név (UI-ban látszik) |
| `slug` | string (egyedi szerkesztőségen belül) | A workflow JSON-ban `ext.<slug>` hivatkozás |
| `kind` | enum | `validator` \| `command` |
| `scope` | enum | `article` \| `publication` (Phase 0: csak `article`) |
| `code` | string | InDesign ExtendScript forrás |
| `paramSchema` | string (JSON, opcionális) | UI-builder a workflow Designer-ben |
| `visibility` | enum | `editorial_office` \| `organization` \| `public` (mint a workflow-knál, [[0006-workflow-lifecycle-scope]]) |
| `archivedAt` | datetime, nullable | Soft-delete (uo. minta) |

Doc-szintű ACL: `buildWorkflowAclPerms()` mintája (Fázis 2 → ADR 0003 → ADR 0006). Új helper-funkció (vagy a meglévő általánosítása) a `teamHelpers.js`-ben.

### Runtime kontraktus

Minden extension egyetlen kötött felületet implementál:

```js
// ExtendScript (InDesign runtime)
function maestroExtension(input) {
    // input = JSON: { article, options, publication }
    // ...
    return { /* JSON eredmény */ };
}
```

| `kind` | Bemenet | Kimenet (JSON) |
|---|---|---|
| `validator` | `{ article, options }` | `{ isValid: bool, errors: [], warnings: [] }` |
| `command` | `{ article, options, publicationRoot }` | `{ success: bool, error?, message? }` |

A kód kizárólag InDesign ExtendScript lehet — a runtime az amúgy is meglévő, kontrollált környezet (a beépített parancsok és validátorok is ott futnak), nincs külön JS sandbox.

### Workflow JSON hivatkozás

A meglévő `compiled.states[].validations[]` és `compiled.states[].commands[]` listákban az új hivatkozás `ext.<slug>` prefixet használ — **nincs új mező a sémában**:

```json
{
  "validations": [
    "preflight",                    // beépített
    "ext.author-name-required"      // custom extension
  ]
}
```

### Plugin runtime dispatch

A `workflowEngine.executeTransition` és a `validationRunner` előbb a beépített registry-ből keres; ha `ext.` prefixet lát, a `workflowExtensions` cache-ből oldja fel a slug-ot, betölti az ExtendScript kódot, futtatja a `maestroExtension(input)` globál függvényt, parsolja a JSON eredményt.

### Snapshot-pattern

A kiadvány aktiválásakor a workflow `compiled` snapshot mellé az **extension-snapshot** is rögzül (a használt custom extension-ök kódja + metaadata). Futó kiadvány alól a viselkedés nem módosítható. Mintaként: [[0006-workflow-lifecycle-scope]] `compiledWorkflowSnapshot`.

## Phase-ek

### Phase 0 (MVP)

- Csak `validator` és `command` `kind`.
- Csak `article` scope.
- Admin-only CRUD a Workflow Designer egy új tabján (vagy a Settings → Bővítmények tabon).
- Egyszerű `<textarea>` editor + alap szintaxis-validáció (nincs Monaco/CodeMirror).
- Nincs marketplace, nincs 3rd-party közzététel.

### Phase 1+

- `publication` scope.
- ExtendScript-oldali Maestro SDK (logger / fájl-hozzáférés helper).
- 3rd-party közzététel + marketplace.
- Jogosultsági integráció: a fejlesztés alatt álló user-jogosultsági rendszer ([[Tervek#Jogosultsági rendszer]]) extension-szintű kibővítése.

## Alternatívák

| Opció | Mellette | Ellene |
|---|---|---|
| **Hardkódolt + plugin újradeploy** (status quo) | 0 backend változás | Self-service nincs, fejlesztő-bottleneck |
| **JS sandbox (vm2/QuickJS)** | Nyelvi semlegesség | Nem futtatható InDesign-ban (UXP nem ad sandboxot), kontextus-bridge bonyolult |
| **WebAssembly (WASM)** | Performance, multi-language | InDesign UXP nem ad WASM runtime-ot, plugin oldali komplexitás |
| **InDesign ExtendScript runtime** (választott) | Már része a beépített parancs/validátor architektúrának, kontrollált környezet, fájl/dokumentum-hozzáférés natív | Csak ECMAScript 3 + Adobe-specifikus globál API; nincs modern nyelv-fícsör |

## Következmények

- **Pozitív**: Self-service custom workflow logika. Plugin újradeploy nem kell minden ügyfél-igényhez. Marketplace (Phase 1+) közösségi extension-ekhez. Az ExtendScript runtime már létezik — minimális új attack surface.
- **Negatív / trade-off**: Az ExtendScript korlátozott (ES3). A snapshot-pattern miatt a futó publikáció kódját nem lehet patch-elni — bug-fix új aktiválást igényel.
- **Új kötelezettségek**:
  - Új `workflowExtensions` collection schema bootstrap CF (`bootstrap_workflow_extension_schema`).
  - Új CRUD CF action-ök (`create_workflow_extension`, `update_workflow_extension`, `archive_workflow_extension`).
  - Plugin runtime: `extensionRegistry.js` + cache + Realtime feliratkozás.
  - Kontraktus-validáció: a Designer-ben mentés előtt szintaxis-check + dummy `maestroExtension({})` exec a JSON kimenet ellenőrzésére.

## Implementáció (tervezett kulcsfájlok)

| Modul | Felelősség |
|---|---|
| `packages/maestro-server/invite-to-organization/.../main.js` | Extension CRUD CF action-ök |
| `packages/maestro-shared/extensionContract.js` | JSON I/O séma + slug validátor |
| `packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js` | Plugin runtime dispatch + cache |
| `packages/maestro-dashboard/src/features/workflowDesigner/extensions/...` | Designer tab + textarea editor |

## Kapcsolódó

- Tervek: [[Tervek#Parancsok és validátorok]]
- ADR-ek: [[0006-workflow-lifecycle-scope]] (snapshot-pattern, ACL-minta)
- Komponensek: [[Komponensek/WorkflowExtension]] (kontraktus részletek)
