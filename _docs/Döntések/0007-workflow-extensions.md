---
tags: [adr, workflow, extensions, plugin, runtime]
status: Proposed
date: 2026-05-01
updated: 2026-05-03
---

> **Frissítés (2026-05-03)** — B.0 tervi tisztázás (Codex review): a Phase 0 hatókör szűkítve. Jelölve a változások a "Phase-ek" szekcióban + új "Phase 0 hatókör-szűkítés" szakasz az implementáció előtt. Az "Adatmodell" tábla `paramSchema` sora halasztva-jellel.

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
| ~~`paramSchema`~~ | ~~string (JSON, opcionális)~~ | **HALASZTVA Phase 1+-ba** (B.0 2026-05-03 — UI-builder Phase 0-ban nem implementált, ld. "Phase 0 hatókör-szűkítés"). |
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
- **Permission-based CRUD** (B.0 2026-05-03 frissítés, korábbi "admin-only flag" helyett): az `extension.create / extension.edit / extension.archive` office-scope slug-ok ([[Komponensek/PermissionTaxonomy#5. Bővítmények — extension.*]]) védik a `create / update / archive_workflow_extension` CF action-öket. A `owner_base` és `admin_base` default permission set tartalmazza mind a hármat ([packages/maestro-shared/permissions.js:84-87](packages/maestro-shared/permissions.js)); a `member_base` szándékosan NEM (extension-kód CRUD magasabb trust-szintű office-művelet). Az org owner / admin az office-scope shortcut révén implicit megkapja, mindenki más permission set-en keresztül.
- Egyszerű `<textarea>` editor + alap szintaxis-validáció (nincs Monaco/CodeMirror).
- Nincs marketplace, nincs 3rd-party közzététel.
- **Nincs per-workflow extension-paraméterezés** (ld. "Phase 0 hatókör-szűkítés" lent).

#### Phase 0 hatókör-szűkítés (Codex flag, B.0.4 — 2026-05-03)

A Phase 0 MVP **nem támogat per-workflow extension-paraméter-átadást**:

- A Workflow Designer `ValidationListField` komponens a visszacsatoláskor el is dobja az ismeretlen `options` mezőt ([ValidationListField.jsx:36-40](packages/maestro-dashboard/src/features/workflowDesigner/fields/ValidationListField.jsx)).
- A `CommandListField` csak `{ id, allowedGroups }` alakot kezel ([CommandListField.jsx:16-18](packages/maestro-dashboard/src/features/workflowDesigner/fields/CommandListField.jsx)).
- A Plugin command runtime csak `cmd.id`-t propagál ([PropertiesPanel.jsx:37-44](packages/maestro-indesign/src/ui/features/workspace/PropertiesPanel/PropertiesPanel.jsx), [commands/index.js:28-39](packages/maestro-indesign/src/core/commands/index.js)).

Következmények Phase 0-ra:
- Az ExtendScript `code`-ja önálló logika, **kötött I/O kontraktussal**: validator → `{ article, options? }`, command → `{ article, options?, publication }`. A futtatott `options` argumentum extension-eknek **MVP-ben üres / nincs továbbítva** (a beépített validátorok ma használnak `options`-t, pl. `preflight_check.requiredArticleStates`, de azt a Designer és a runtime még csak rájuk van bekötve).
- A `paramSchema` mező halasztása a Phase 1+ kibővítés egy darabja, de **nem önálló blokkoló** — Phase 1-ben együtt jön a Designer `ValidationListField`/`CommandListField` options-szerkesztő bővítésével és a Plugin runtime options-átadás kibővítésével.

### Phase 1+

- `paramSchema` mező a `workflowExtensions` collection-ön (additive — nincs migráció a "no éles verzió, no kompatibilitás" alapelv miatt).
- Designer `ValidationListField` és `CommandListField` extension-options-szerkesztő (a `paramSchema` alapján renderelt input mezők).
- Plugin runtime per-workflow extension-options propagáció (`commands/index.js` + `validationRunner` → ExtendScript `maestroExtension({ options })`).
- `publication` scope.
- ExtendScript-oldali Maestro SDK (logger / fájl-hozzáférés helper).
- 3rd-party közzététel + marketplace.
- ~~Jogosultsági integráció~~ — **már Phase 0-ban kész** az A.3 retrofit (ADR 0008) keretében; az `extension.*` slug-ok a 33 office-scope slug katalógusban élnek.

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

> **CF szervezés** (B.0.3 2026-05-03): a Phase 0 új CRUD action-jei (`create / update / archive_workflow_extension`) az új `actions/extensions.js` modulba kerülnek — egyidőben a `main.js` 36 meglévő action handler-jének inkrementális szétbontásával 7-8 `actions/*.js` modulra. A teljes terv és a `B.0.3.0` előfeltétel (központi utilok kiszervezése `helpers/` alá a CommonJS ciklikus require elkerüléséhez) az [[Feladatok#B.0.3]] alatt él.

| Modul | Felelősség |
|---|---|
| `packages/maestro-server/invite-to-organization/.../main.js` | Action-router + env init + `permissionContext` (B.0.3 után ~300-400 sor) |
| `packages/maestro-server/invite-to-organization/.../actions/extensions.js` | Extension CRUD CF action-ök (új, B.3) |
| `packages/maestro-shared/extensionContract.js` | JSON I/O séma + slug validátor |
| `packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js` | Plugin runtime dispatch + cache |
| `packages/maestro-dashboard/src/features/workflowDesigner/extensions/...` | Designer tab + textarea editor |

## Kapcsolódó

- Tervek: [[Tervek#Parancsok és validátorok]]
- ADR-ek: [[0006-workflow-lifecycle-scope]] (snapshot-pattern, ACL-minta)
- Komponensek: [[Komponensek/WorkflowExtension]] (kontraktus részletek)
