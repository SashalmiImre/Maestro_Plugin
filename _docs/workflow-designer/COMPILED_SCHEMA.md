# Workflow Designer — `compiled` JSON séma

> A `workflows.compiled` mező formális leírása. Ez a workflow runtime **egyetlen igazságforrása** — a plugin és a Cloud Function-ök kizárólag ezt olvassák.
> **Kapcsolódó**: [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), [MIGRATION_NOTES.md](MIGRATION_NOTES.md).

---

## Top-level struktúra

```jsonc
{
  "version": 12,                              // monoton növekvő, auto-inkrementált mentéskor
  "states": [ /* állapotok */ ],
  "transitions": [ /* átmenetek */ ],
  "validations": { /* state → validátor lista */ },
  "commands": { /* state → parancs lista + allowedGroups */ },
  "elementPermissions": { /* scope → element → perm */ },
  "contributorGroups": [ /* contributor csoportok az Article Properties ContributorsSection-ben */ ],
  "leaderGroups": [ "managing_editors", "art_directors" ],  // szuperjoggal rendelkező csoport slug-ok
  "statePermissions": { /* state → csoportok, akik mozgathatják innen a cikket */ },
  "capabilities": { /* exkluzív capability → csoport slug-ok */ }
}
```

---

## `states`

Minden workflow állapot egy objektum:

```jsonc
{
  "id": "designing",                  // string stateId (régi integer 0 helyett)
  "label": "Tervezés",                 // megjelenített magyar név
  "color": "#FFEA00",                  // hex szín
  "duration": {                        // sürgősség-számításhoz
    "perPage": 60,                     // perc / oldal
    "fixed": 0                         // fix idő percben
  },
  "isInitial": true,                   // új cikk ebbe az állapotba kerül
  "isTerminal": false                  // archivált / nincs tovább átmenet
}
```

**Szabályok**:
- Pontosan **egy** `isInitial: true` állapot lehet.
- `isTerminal: true` állapotból nem indulhat `transition`.
- Az `id` csak `[a-z0-9_]+` karakterekből állhat (URL/key biztonság).
- Állapot átnevezésénél a compiler validator blokkolja a változtatást, ha van hivatkozó `article.state`.

---

## `transitions`

Átmenetek állapotok között:

```jsonc
{
  "from": "designing",                      // kiinduló stateId
  "to": "design_approval",                  // cél stateId
  "label": "Tördelve",                      // az UI gombon megjelenő szöveg
  "direction": "forward",                   // "forward" | "backward" | "reset"
  "allowedGroups": [                        // mely csoport slug-ok tagjai hívhatják ezt az átmenetet
    "designers",
    "art_directors"
  ]
}
```

**Szabályok**:
- Egyedi `(from, to)` párok (nem lehet két azonos átmenet).
- `allowedGroups` üres tömb = senki sem használhatja (hibaüzenet a validator-tól).
- A `leaderGroups` tagjai automatikusan minden átmenetet használhatnak, nem kell őket felvenni az `allowedGroups`-ba.

---

## `validations`

Validátor futtatási szabályok state-enként:

```jsonc
{
  "designing": {
    "onEntry": [],                             // belépéskor lefutó validátorok
    "requiredToEnter": [ "file_accessible" ],  // belépéskor ezeknek passolniuk kell
    "requiredToExit": [ "page_number_check" ]  // kilépéskor ezeknek passolniuk kell
  },
  "design_approval": {
    "onEntry": [],
    "requiredToEnter": [ "filename_verification", "preflight_check" ],
    "requiredToExit": []
  }
}
```

A validátor ID-k a plugin [VALIDATOR_TYPES](../../packages/maestro-indesign/src/core/utils/validationConstants.js) enumjára hivatkoznak. Új validátor = új enum érték **és** új kódbeli implementáció — a designer csak hivatkozik, nem definiál.

---

## `commands`

State-függő parancsok (pl. „PDF export" gomb csak `design_approval`-ban, csak designer/art director futtathatja):

```jsonc
{
  "design_approval": [
    {
      "id": "export_pdf",
      "allowedGroups": [ "designers", "art_directors" ]
    }
  ],
  "printable": [
    {
      "id": "export_final_pdf",
      "allowedGroups": [ "art_directors", "managing_editors" ]
    }
  ]
}
```

A command ID-k a plugin [COMMAND_REGISTRY](../../packages/maestro-indesign/src/core/commands/index.js)-jére hivatkoznak. Új command = új kód az indesign pluginban + új bejegyzés a shared [commandRegistry.js](../../packages/maestro-shared/commandRegistry.js)-ben (hogy a dashboard is lássa a listát).

---

## `elementPermissions`

UI elem × csoport jogosultságok. Scope szerint bontva (`article`, `publication`):

```jsonc
{
  "article": {
    "articleName":          { "type": "groups", "groups": [ "editors", "designers" ] },
    "validationForm":       { "type": "anyMember" },
    "pageNumberField":      { "type": "groups", "groups": [ "designers", "art_directors" ] },
    "contributorDropdown":  { "type": "groups", "groups": [ "art_directors", "managing_editors" ] }
  },
  "publication": {
    "publicationProperties": { "type": "groups", "groups": [ "managing_editors" ] },
    "defaultContributors":   { "type": "groups", "groups": [ "managing_editors" ] },
    "deadlineSection":       { "type": "anyMember" }
  }
}
```

**Perm típusok**:
- `{ "type": "groups", "groups": [...] }` — csak a listázott csoportok tagjai, vagy bármely `leaderGroups` tag.
- `{ "type": "anyMember" }` — bármely office member (csoporttagság nélkül is).
- `{ "type": "none" }` — senki nem szerkesztheti (read-only mező).

Az element kulcsok megfeleltetése a komponensekhez a [MIGRATION_NOTES.md](MIGRATION_NOTES.md)-ben található táblázatban.

---

## `contributorGroups`

Csoportok, amik az Article Properties `ContributorsSection`-ében contributor dropdown-ként jelennek meg:

```jsonc
[
  { "slug": "designers",        "label": "Tervező" },
  { "slug": "editors",          "label": "Szerkesztő" },
  { "slug": "writers",          "label": "Író" },
  { "slug": "image_editors",    "label": "Képszerkesztő" },
  { "slug": "art_directors",    "label": "Művészeti vezető" },
  { "slug": "managing_editors", "label": "Vezetőszerkesztő" },
  { "slug": "proofwriters",     "label": "Korrektor" }
]
```

A `ContributorsSection` dinamikusan loop-ol ezen a tömbön → minden elemhez egy dropdown, amely az adott csoport tagjaiból tölt. Az `articles.contributors` JSON-ban a `slug` a kulcs, a kiválasztott `userId` az érték.

A `publications.defaultContributors` ugyanezt a formát használja.

**Szabály**: Csak azok a csoportok szerepelhetnek itt, amelyeknek a `groups.isContributorGroup: true`. A designer `compiler.js`-e ezt ellenőrzi.

---

## `leaderGroups`

Szuperjoggal rendelkező csoport slug-ok tömbje:

```jsonc
[ "managing_editors", "art_directors" ]
```

A leader csoportok tagjai:
- **Bármely** transition-t használhatják, függetlenül az `allowedGroups`-tól.
- **Bármely** state-ben hozzáférhetnek a cikkekhez (`canUserAccessInState` mindig igaz).
- **Bármely** contributor dropdown-t szerkeszthetik.
- **Minden** `elementPermissions.*.*.type === "groups"` ellenőrzést átlépnek.

A leader csoportok listáját a compiler a `groups.isLeaderGroup: true` flag-ekből generálja.

---

## `statePermissions`

Állapotonként ki mozgathatja ki onnan a cikket (a régi `STATE_PERMISSIONS` dinamikus megfelelője):

```jsonc
{
  "designing":          [ "designers", "art_directors" ],
  "design_approval":    [ "art_directors", "managing_editors" ],
  "waiting_for_start":  [ "managing_editors" ],
  "editorial_approval": [ "editors", "managing_editors" ],
  "content_revision":   [ "editors", "proofwriters", "image_editors" ],
  "final_approval":     [ "managing_editors" ],
  "printable":          [ "art_directors", "managing_editors" ],
  "archivable":         [ "managing_editors" ]
}
```

A `canUserMoveArticle(compiled, userGroups, currentState)` helper ezt konzultálja: a user akkor mozgathatja ki a cikket, ha tagja valamelyik listázott csoportnak **vagy** ha tagja egy `leaderGroups` csoportnak.

---

## `capabilities`

Exkluzív capability-k (nincs csapat-ekvivalensük) — a régi `CAPABILITY_LABELS` exclusive része:

```jsonc
{
  "canAddArticlePlan": [ "designers", "managing_editors" ]
}
```

A `capabilities` mező a compiled schema része marad (a Dashboard Workflow Designer szerkesztheti), de a fogyasztói `hasCapability()` helper törölve lett (nem volt kódbázis-szintű használata). Új capability használatkor a fogyasztó közvetlenül olvas a `compiled.capabilities[name]` tömbből, vagy új helper kerül a `workflowRuntime.js`-be.

**Példa capability-k**:
- `canAddArticlePlan` — cikk terv hozzáadása InDesign fájl nélkül
- `canExportFinalPdf` — végleges PDF generálás
- `canArchivePublication` — kiadvány archiválás
- `canDeletePublication` — kiadvány törlés

---

## Fogyasztói API

A plugin és a Cloud Function-ök a [workflowRuntime.js](../../packages/maestro-shared/workflowRuntime.js) helpereken keresztül olvasnak a `compiled`-ből. Ez az egyetlen interfész — **soha nem szabad közvetlenül mezőket olvasni**, mert a séma változhat.

**Fő függvények**:
- `getStateConfig(compiled, stateId)` — `{label, color, duration, isInitial, isTerminal}`
- `getAvailableTransitions(compiled, currentState)` — a `from === currentState` átmenetek
- `canUserMoveArticle(compiled, userGroups, currentState)` — bool
- `canEditElement(compiled, scope, elementKey, userGroups)` — `{allowed, reason}`
- `canRunCommand(compiled, stateId, commandId, userGroups)` — `{allowed, reason}`
- `canEditContributorDropdown(compiled, groupSlug, userGroups, currentState)` — bool
- `canUserAccessInState(compiled, userGroups, stateId)` — bool
- `isInitialState(compiled, stateId)` — bool
- `getInitialState(compiled)` — stateId string

---

## Minimális példa (kibontva)

Egy három állapotú mini workflow (csak illusztráció):

```json
{
  "version": 1,
  "states": [
    { "id": "draft",  "label": "Piszkozat", "color": "#CCCCCC",
      "duration": { "perPage": 30, "fixed": 0 }, "isInitial": true,  "isTerminal": false },
    { "id": "review", "label": "Ellenőrzés", "color": "#FFA500",
      "duration": { "perPage": 15, "fixed": 10 }, "isInitial": false, "isTerminal": false },
    { "id": "done",   "label": "Kész", "color": "#00AA00",
      "duration": { "perPage": 0, "fixed": 0 }, "isInitial": false, "isTerminal": true }
  ],
  "transitions": [
    { "from": "draft",  "to": "review", "label": "Küldés ellenőrzésre", "direction": "forward",
      "allowedGroups": [ "authors" ] },
    { "from": "review", "to": "done",   "label": "Jóváhagyás", "direction": "forward",
      "allowedGroups": [ "reviewers" ] },
    { "from": "review", "to": "draft",  "label": "Visszadob", "direction": "backward",
      "allowedGroups": [ "reviewers" ] }
  ],
  "validations": {
    "draft":  { "onEntry": [], "requiredToEnter": [], "requiredToExit": [ "file_accessible" ] },
    "review": { "onEntry": [], "requiredToEnter": [], "requiredToExit": [] },
    "done":   { "onEntry": [], "requiredToEnter": [], "requiredToExit": [] }
  },
  "commands": {
    "review": [ { "id": "export_pdf", "allowedGroups": [ "reviewers" ] } ]
  },
  "elementPermissions": {
    "article": {
      "articleName":    { "type": "groups", "groups": [ "authors" ] },
      "validationForm": { "type": "anyMember" }
    },
    "publication": {
      "publicationProperties": { "type": "groups", "groups": [ "editors" ] }
    }
  },
  "contributorGroups": [
    { "slug": "authors", "label": "Szerző" }
  ],
  "leaderGroups": [ "editors" ],
  "statePermissions": {
    "draft":  [ "authors" ],
    "review": [ "reviewers" ],
    "done":   []
  },
  "capabilities": {}
}
```
