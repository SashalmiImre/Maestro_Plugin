# CLAUDE.md — Maestro Server

> Szerver-oldali Appwrite Cloud Function-ök és szolgáltatások.
> A plugin-oldali részletes architektúrát ld. `../maestro-indesign/CLAUDE.md`.

---

## Parancsok

### Deployment
```bash
# Appwrite CLI-vel (a maestro-server könyvtárból):
appwrite functions create-deployment \
  --function-id <function-id> \
  --code functions/<function-dir> \
  --entrypoint src/main.js \
  --activate true
```

### Appwrite CLI
```bash
appwrite functions list                    # Function-ök listázása
appwrite functions list-variables --function-id <id>  # Env vars
```

---

## Technológiai Stack

| Réteg        | Technológia                                |
| ------------ | ------------------------------------------ |
| **Runtime**  | Node.js 18.0+ (team function: Node.js 22)  |
| **SDK**      | `node-appwrite` ^11.0.0                    |
| **Platform** | Appwrite Cloud Functions                    |
| **Trigger**  | Event-alapú, ütemezett (cron), vagy manuális (HTTP) |

---

## Kódstílus & Konvenciók

A `maestro-indesign/CLAUDE.md`-ben leírt konvenciók érvényesek:
- **Komment nyelv**: Magyar (kivétel: a `team` function angol kommentekkel íródott)
- **Hibakezelés**: `try/catch` minden aszinkron műveletnél
- **Logolás**: `log()` és `error()` — az Appwrite Function SDK biztosítja
- **Sentinel pattern**: `modifiedByClientId = 'server-guard'` védi a végtelen ciklust az `articles` és `users` collection-ön (a tenant collection-öknél ACL-alapú védelem váltja ki)
- **Fail-closed**: Érvénytelen állapotokat korrigálja, nem elutasítja

---

## Projektstruktúra

```
maestro-server/
├── CLAUDE.md                          ← Ez a fájl
├── package.json                       ← Csomag metaadatok
├── appwrite.json                      ← Appwrite CLI deployment konfig
│
└── functions/                         ← Appwrite Cloud Function-ök
    ├── update-article/                ← Cikk update pre-event szinkron CF (Fázis 9 follow-up — HTTP endpoint, `users` execute)
    │   ├── package.json
    │   └── src/main.js
    ├── article-update-guard/          ← Post-event log-only safety net + parent publication scope sync
    │   ├── package.json
    │   └── src/main.js
    ├── validate-article-creation/     ← Cikk létrehozás validáció (publicationId, state, contributor-ok)
    │   ├── package.json
    │   └── src/main.js
    ├── validate-publication-update/   ← Kiadvány módosítás validáció (default contributor-ok, rootPath)
    │   ├── package.json
    │   └── src/main.js
    ├── set-publication-root-path/     ← Publikáció rootPath beállító CF (null→kanonikus, Plugin folder picker)
    │   ├── package.json
    │   └── src/main.js
    ├── cascade-delete/                ← Kaszkád törlés (cikk: üzenetek, validációk, thumbnailek; kiadvány: cikkek, layoutok, deadline-ok)
    │   ├── appwrite.config.json
    │   ├── package.json
    │   └── src/main.js
    ├── cleanup-orphaned-locks/        ← Árva zárolások takarítása (naponta, 24h-nál régebbi)
    │   ├── package.json
    │   └── src/main.js
    ├── cleanup-orphaned-thumbnails/   ← Árva thumbnail fájlok takarítása (hetente, Storage ↔ DB)
    │   ├── package.json
    │   └── src/main.js
    ├── cleanup-archived-workflows/    ← Soft-delete-elt workflow-k hard-delete-je (naponta, 7 napos retention, snapshot-nélküli pub blokkoló)
    │   ├── package.json
    │   └── src/main.js
    ├── migrate-legacy-paths/          ← Régi útvonalak batch migrációja (manuális, DRY_RUN)
    │   ├── package.json
    │   └── src/main.js
    ├── invite-to-organization/        ← Tenant management + workflow + permission set CRUD (egy CF-ben, ~36 action)
    │   ├── package.json
    │   └── src/
    │       ├── main.js                 ← Action-router + env + permissionContext (~6964 sor, A.3.6 + Fázis 1 helper-extract után)
    │       ├── permissions.js          ← A.3.5/A.3.7 — userHasPermission/userHasOrgPermission + isStillOfficeMember (A.3.6 harden 2026-05-03)
    │       ├── teamHelpers.js          ← Per-tenant Team ACL builder + ensureTeam/Membership helperek
    │       ├── defaultWorkflow.json    ← Bootstrap workflow seed
    │       └── helpers/                ← Fázis 1 helper-extract (2026-05-03)
    │           ├── constants.js        (CASCADE_BATCH_LIMIT, MAX_REFERENCES_PER_SCAN, WORKFLOW_VISIBILITY_*, PARSE_ERROR)
    │           ├── cascade.js          (deleteByQuery, cascadeDeleteOffice)
    │           ├── compiledValidator.js (workflowReferencesSlug, contributorJsonReferencesSlug, validateCompiledSlugs re-export, buildCompiledValidationFailure)
    │           ├── _generated_compiledValidator.js (AUTO-GENERATED: scripts/build-cf-validator.mjs by A.7.1, kanonikus forrás packages/maestro-shared/compiledValidator.js)
    │           ├── workflowDoc.js      (createWorkflowDoc — schema-safe fallback)
    │           ├── groupSeed.js       (seedGroupsFromWorkflow, findEmptyRequiredGroupSlugs, seedDefaultPermissionSets)
    │           └── deadlineValidator.js (validateDeadlinesInline)
    └── team/                          ← DEPRECATED (Fázis 2: groupMemberships collection váltotta ki)
```

---

## Function-ök Összefoglalója

| Function ID | Név | Runtime | Timeout | Trigger |
|---|---|---|---|---|
| `update-article` | Update Article | node-18.0 | 15s | Kliens hívás (HTTP, `execute: ["users"]`) |
| `article-update-guard` | Article Update Guard | node-18.0 | 30s | `articles.*.update` |
| `validate-article-creation` | Validate Article Creation | node-18.0 | 15s | `articles.*.create` |
| `validate-publication-update` | Validate Publication Update | node-18.0 | 15s | `publications.*.create/update` |
| `set-publication-root-path` | Set Publication Root Path | node-18.0 | 15s | Kliens hívás (HTTP, `execute: ["users"]`) |
| `cascade-delete` | Cascade Delete | node-18.0 | 15s | `articles/publications.*.delete` |
| `cleanup-orphaned-locks` | Cleanup Orphaned Locks | node-18.0 | 30s | Schedule: `0 3 * * *` |
| `cleanup-orphaned-thumbnails` | Cleanup Orphaned Thumbnails | node-18.0 | 120s | Schedule: `0 4 * * 0` |
| `cleanup-archived-workflows` | Cleanup Archived Workflows | node-18.0 | 60s | Schedule: `0 5 * * *` |
| `migrate-legacy-paths` | Migrate Legacy Paths | node-18.0 | 120s | Manuális (HTTP) |
| `invite-to-organization` | Invite To Organization | node-18.0 | 15s | Kliens hívás (HTTP, `execute: ["users"]`) |

---

## Környezeti Változók

### Közös (minden function)

| Változó | Érték | Leírás |
|---|---|---|
| `APPWRITE_API_KEY` | *(secret)* | API kulcs — `MaestroFunctionsKey` (databases.rw, users.rw, files.rw) |
| `APPWRITE_ENDPOINT` | `https://fra.cloud.appwrite.io/v1` | Appwrite végpont — explicit beállítás szükséges, mert az automatikus `APPWRITE_FUNCTION_ENDPOINT` belső runtime endpoint a `role: applications` identitást kényszeríti, ami felülírja az API key scope-okat |
| `APPWRITE_FUNCTION_PROJECT_ID` | automatikus | Projekt ID (Appwrite beállítja) |

### Per-function

| Function | Változók |
|---|---|
| `update-article` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `WORKFLOWS_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`, `GROUPS_COLLECTION_ID`, `GROUP_MEMBERSHIPS_COLLECTION_ID` |
| `article-update-guard` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `WORKFLOWS_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`, `GROUPS_COLLECTION_ID`, `GROUP_MEMBERSHIPS_COLLECTION_ID` |
| `validate-article-creation` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `WORKFLOWS_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID` |
| `validate-publication-update` | `DATABASE_ID`, `PUBLICATIONS_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`, `DEADLINES_COLLECTION_ID`, `ARTICLES_COLLECTION_ID`, `WORKFLOWS_COLLECTION_ID` |
| `set-publication-root-path` | `DATABASE_ID`, `PUBLICATIONS_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`, `ORGANIZATION_MEMBERSHIPS_COLLECTION_ID` |
| `cascade-delete` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `USER_VALIDATIONS_COLLECTION_ID`, `SYSTEM_VALIDATIONS_COLLECTION_ID`, `DEADLINES_COLLECTION_ID`, `LAYOUTS_COLLECTION_ID`, `THUMBNAILS_BUCKET_ID` |
| `cleanup-orphaned-locks` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID` |
| `cleanup-orphaned-thumbnails` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `THUMBNAILS_BUCKET_ID` |
| `cleanup-archived-workflows` | `DATABASE_ID`, `WORKFLOWS_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, opcionálisan `ARCHIVED_RETENTION_DAYS` (default 7) |
| `migrate-legacy-paths` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `DRY_RUN` |
| `invite-to-organization` | `DATABASE_ID`, `ORGANIZATIONS_COLLECTION_ID`, `ORGANIZATION_MEMBERSHIPS_COLLECTION_ID`, `EDITORIAL_OFFICES_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`, `ORGANIZATION_INVITES_COLLECTION_ID`, `GROUPS_COLLECTION_ID`, `GROUP_MEMBERSHIPS_COLLECTION_ID`, `WORKFLOWS_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID` (csak a delete ágakhoz kell; hiánya esetén a `delete_organization` / `delete_editorial_office` / `delete_group` action 500 `misconfigured`-et ad, a többi action nem érintett), `ARTICLES_COLLECTION_ID` (csak `delete_group`-hoz kell a contributor scan miatt; hiánya esetén az action 500 `misconfigured`-et ad), **`PERMISSION_SETS_COLLECTION_ID`** és **`GROUP_PERMISSION_SETS_COLLECTION_ID`** (A.3.6 retrofit, 2026-05-03 óta **GLOBÁLISAN KÖTELEZŐEK** — minden retrofit-elt action `userHasPermission()` member-path lookup-ja használja; korábban csak a `bootstrap_permission_sets_schema` action-höz voltak kötelezőek) |

---

## Jogosultságok (API Key Scopes)

| Function | Szükséges Scopes |
|---|---|
| `update-article` | `databases.read`, `databases.write`, `users.read` |
| `article-update-guard` | `databases.read`, `databases.write`, `users.read` |
| `validate-article-creation` | `databases.read`, `databases.write`, `users.read` |
| `validate-publication-update` | `databases.read`, `databases.write`, `users.read` |
| `set-publication-root-path` | `databases.read`, `databases.write`, `users.read` |
| `cascade-delete` | `databases.read`, `databases.write`, `files.read`, `files.write` |
| `cleanup-orphaned-locks` | `databases.read`, `databases.write`, `users.read` |
| `cleanup-orphaned-thumbnails` | `databases.read`, `files.read`, `files.write` |
| `cleanup-archived-workflows` | `databases.read`, `databases.write` |
| `migrate-legacy-paths` | `databases.read`, `databases.write` |
| `invite-to-organization` | `databases.read`, `databases.write`, `users.read` |

> **Megjegyzés**: Jelenleg minden function egyetlen közös API kulcsot használ (`MaestroFunctionsKey`), amely az összes szükséges jogosultsággal rendelkezik.

---

## Működési Leírás

### update-article

HTTP endpoint (`execute: ["users"]`) a Plugin `functions.createExecution(..., async: false)` hívására. Minden cikk update egyetlen belépési pontja Fázis 9 follow-up óta. Fail-closed pre-event validáció — csak pozitív ellenőrzés után ír a DB-be szerver API key-jel.

**Bemenet** (req.body JSON): `{ articleId, data }`. Az `ALLOWED_FIELDS` szűri a `data` kulcsokat: `state`, `previousState`, `name`, `filePath`, `startPage`, `endPage`, `pageRanges`, `contributors`, `markers`, `lockType`, `lockOwnerId`, `thumbnails`. Minden egyéb mező `invalid_field`.

**Kimenet** (res.json):
- Siker: `{ success: true, action: 'applied', document }`.
- Permission denied: `{ success: false, permissionDenied: true, reason, requiredGroups }` (400).
- Invalid / 404 / config: `{ success: false, reason }` megfelelő státuszkóddal.

**Ellenőrzések (sorrendben, fail-closed):**
1. **Auth** — `x-appwrite-user-id` header kötelező.
2. **Payload validáció** — `articleId` + `data` objektum, `ALLOWED_FIELDS` szűrés.
3. **Fresh doc fetch** — `databases.getDocument(articles, articleId)`. 404 → 404 válasz.
4. **Parent publication** — `getDocument(publications, publicationId)`; 404 esetén soft-skip, a fresh doc scope-jával megyünk tovább.
5. **Parent scope drift sync** — ha `parent.editorialOfficeId !== freshDoc.editorialOfficeId` → soft-fix a fresh doc-ra memóriában (a CF a végső write-nál nem alkalmazza).
6. **lockType enum validáció** — ha `data.lockType` jelen van, `VALID_LOCK_TYPES` Set-tel (`'USER'`, `'SYSTEM'`, `null`) ellenőrzés. Érvénytelen érték → 400 `invalid_lock_type`.
7. **Lock fast-path kivétel** — ha a payload kizárólag `lockType`/`lockOwnerId` mezőket tartalmaz ÉS a user a saját lockját állítja be (`data.lockOwnerId === userId` ÉS `freshDoc.lockOwnerId === null || === userId`) VAGY oldja fel (`freshDoc.lockOwnerId === userId` és a payload null-ra állít), a csoportjogosultsági check ki van hagyva. A `freshDoc.lockOwnerId` ellenőrzés megakadályozza, hogy más office tagja zároljon egy már zárolt dokumentumot.
8. **Data validáció** — `data.state`: compiled.states kulcs érvényesség + transition `from: currentState, to: data.state` a compiled.transitions-ben. `data.contributors`: JSON parse + per-userId létezés (log only).
9. **Workflow betöltés** — `getWorkflowForPublication()`, 60s process cache. Nincs workflow → 500 `misconfigured`.
10. **Office membership** — MINDIG fut (lock fast-path esetén is) — a caller tagja-e a `freshDoc.editorialOfficeId`-nek (`editorialOfficeMemberships` lookup). Nem → 403 permissionDenied.
11. **Jogosultsági check** — leader bypass (`compiled.leaderGroups`), utána `statePermissions[freshDoc.state]` a cikk szerkesztéséhez. State váltáskor a cél állapotnak is léteznie kell a transitions-ben. Lock fast-path esetén skip-elve.
12. **DB write** — `databases.updateDocument()` az API key-jel, `modifiedByClientId: 'server-guard'` sentinel-lel — ez jelzi a post-event `article-update-guard` CF-nek, hogy skip-peljen.
13. **Válasz** — `{ success: true, action: 'applied', document }`.

**DB permission függés**: éles környezetben az `articles` collection `Update` role-ból a `users` meg van vonva — így a direkt kliens DB írás lehetetlen, minden update ezen a CF-en keresztül megy.

### article-update-guard

**Fázis 9 follow-up óta defense-in-depth log-only safety net** — az elsődleges érvényesítő az `update-article` CF. Ez a post-event trigger mostantól megfigyelési célt szolgál (Dashboard közvetlen írás, manual Console edit, jövőbeli integrációk) és csak minimális korrekciókat alkalmaz.

**Ellenőrzések:**
1. **Sentinel guard** — `modifiedByClientId === 'server-guard'` → skip (az `update-article` CF írta, már validált)
2. **Workflow betöltés** — `workflows` collection-ből, 60s process cache (csak a log-only check-ek működéséhez)
3. **Parent scope sync (KORREKCIÓ MARAD)** — szülő publikáció `editorialOfficeId`/`organizationId` mezőkhöz igazítás. Ez minden írási forrást lefed, ezért továbbra is kijavítja a drift-et.
4. **Állapot érvényesség** — log-only warning, ha `currentState` nincs a `compiled.states`-ben
5. **Állapotátmenet** — log-only warning, ha `previousState → state` nincs a `compiled.transitions`-ben
6. **Office scope** — log-only warning, ha a caller nem tagja az office-nak (cross-tenant update detektálás)
7. **Jogosultság** — log-only warning, ha a csoporttagság sértett (`[SafetyNet] Jogosultsági sértés ...`)
8. **Contributor mezők** — `contributors` JSON parse + userId létezés (log only, változatlan)
9. **previousState hygiene (KORREKCIÓ MARAD)** — null esetén `currentState`-tel inicializálás

**Mit NEM csinál már** (ezt az `update-article` CF előzetesen lekezeli):
- State revert érvénytelen állapot vagy átmenet esetén
- State revert jogosultság hiány miatt
- State revert office scope sértés miatt

### validate-article-creation

Új cikk létrehozásakor fut. Érvénytelen `publicationId` → cikk törlés. Ellenőrzi a state érvényességét, `contributors` JSON contributor user létezést (érvénytelen userId → nullázás), filePath formátumot.

**Scope ellenőrzés (B.8):** hiányzó `organizationId`/`editorialOfficeId`, parent publication office mismatch, vagy nem-tag caller → cikk törlése (`editorialOfficeMemberships` lookup).

### validate-publication-update

Kiadvány létrehozás/módosításkor fut. `defaultContributors` JSON parse → nem létező userId → nullázás. Legacy rootPath → logolás.

**Scope ellenőrzés (B.8):** create eseménynél hiányzó scope mezők vagy nem-tag caller → publikáció törlése. Update path: nem-tag caller csak logolódik (teljes field-level revert Fázis 6 hatáskör).

**Aktiválás validáció (Dashboard Redesign Fázis 5):** Minden create és update eseménynél, ha a friss dokumentum `isActivated === true`, a CF lefuttatja a `validatePublicationActivationInline()`-t (inline másolat a `maestro-shared/publicationActivation.js`-ből). Ez ellenőrzi: (a) `workflowId` kitöltött, (b) legalább egy deadline létezik, (c) a deadline-ok a teljes `coverageStart..coverageEnd` tartományt átfedés nélkül lefedik és formátum-helyesek. A deadline-ok a `DEADLINES_COLLECTION_ID`-ból kerülnek lekérdezésre (`Query.equal('publicationId', $id)`, limit 500). **Fail-closed**: ha a `DEADLINES_COLLECTION_ID` env var hiányzik, vagy a deadline lekérés dob, vagy a validáció sikertelen → a CF revertel `{ isActivated: false, activatedAt: null }`-re. Ez garantálja, hogy érvénytelen állapot soha nem maradhat a DB-ben, még akkor sem, ha a Dashboard UI-t megkerülik direkt REST hívással.

**Workflow snapshot rögzítése (§5a, #37):** Sikeres aktiválási átmenet vagy snapshot-hiányos aktív publikáció esetén a CF beolvassa a `workflowId`-hoz tartozó `workflows.compiled` JSON-t és a `publications.compiledWorkflowSnapshot` mezőbe írja. Trigger-szűk: csak `payload.isActivated` érintés vagy `freshDoc.compiledWorkflowSnapshot` hiány → nem fut normál szerkesztési update-nél (így egy időközben módosított workflow nem szivárog be az élő publikáció snapshotjába). Fail-closed: workflow lookup hiba vagy office scope mismatch → deaktiválás. Idempotens: azonos tartalomra nem ír, elkerüli a felesleges SERVER_GUARD korrekciós kört. Szükséges env var: `WORKFLOWS_COLLECTION_ID`.

**Snapshot immutability guard (§6b, #37):** Ha a kliens payload tartalmazza a `compiledWorkflowSnapshot` kulcsot ÉS a caller nem SERVER_GUARD, invariáns-sértés → deaktiválás + snapshot null-ra. A post-event CF nem lát pre-state-et, ezért közvetlen mező-revert nem lehetséges; a deaktiválás új aktiválást kényszerít, ahol az §5a a workflow aktuális `compiled`-ját ráírja. Normál szerkesztés (name, coverage, contributors stb.) nem érinti a mezőt, így a guard csak explicit visszaélés ellen véd.

### set-publication-root-path

HTTP endpoint (`execute: ["users"]`) a Plugin folder picker modaljából hívva (`functions.createExecution(..., async: false)`). A Plugin `users` role NEM rendelkezik direkt `publications.update` joggal (Fázis 9), ezért minden rootPath beállítás ezen a CF-en keresztül történik. Szűk hatókörű: kizárólag null → nem-null kanonikus írás.

**Bemenet** (req.body JSON): `{ publicationId, rootPath }`. A `rootPath` kanonikus formátumú (`/ShareName/opcionális/relatív/path`) — natív mount prefix vagy drive betű tiltott.

**Kimenet** (res.json):
- Siker: `{ success: true, action: 'applied', document }` (200).
- Permission denied: `{ success: false, permissionDenied: true, reason, requiredGroups: [] }` (403).
- Hiba: `{ success: false, reason, ...extra }` megfelelő státuszkóddal.

**Ellenőrzések (sorrendben, fail-closed):**
1. **Payload parse** — `publicationId` string kötelező; invalid → `invalid_payload` / `missing_publication_id` (400).
2. **Auth** — `x-appwrite-user-id` header kötelező; hiány → `unauthenticated` (401).
3. **Env var guard** — hiány → `misconfigured` (500) + `missing` lista.
4. **Kanonikus rootPath validáció** — inline `isCanonicalRootPath()` helper (`MAX_ROOT_PATH_LENGTH = 1024` char). Részletes `detail` a hibaüzenetben:
   - `not_string` — nem string (hiány vagy rossz típus)
   - `empty` — trim utáni üres string (vagy csak `/` perjel, szegmens nélkül)
   - `too_long` — a trim-elt hossz > 1024 karakter (CPU-szivárgás elleni védelem)
   - `contains_backslash` — `\` karakter a stringben (Windows natív)
   - `no_leading_slash` — nem `/`-vel kezdődik
   - `drive_letter` — `Z:/` stílusú natív Windows path
   - `legacy_mount_prefix` — `/Volumes/...` vagy `C:/Volumes/...` kezdetű
   - `path_traversal` — `.` vagy `..` szegmens
5. **Publication fetch** — 404 → `publication_not_found`; egyéb hiba → `publication_fetch_failed` (500).
6. **Scope mezők** — `organizationId` + `editorialOfficeId` kötelező a pub-on; hiány → `missing_scope` (422, data integrity hiba).
7. **Jogosultság** — (a) office admin: `editorialOfficeMemberships.role === 'admin'` a pub office-ában, VAGY (b) org owner/admin: `organizationMemberships.role ∈ {owner, admin}` a pub org-jában. Egyik sem → `permissionDenied` (403). Membership lookup hiba → fail-closed permissionDenied. **Az auth a null check ELŐTT fut** — különben a 409 `root_path_already_set` leakelné a pub állapotát bármely auth'd hívónak, aki ismer/találgat egy publicationId-t.
8. **Null check** — ha `pub.rootPath` már be van állítva (nem üres trim után) → `root_path_already_set` (409). A válasz NEM tartalmazza a `currentRootPath`-ot (az auth-szűrés után is tiszta felszínt tartunk; a hívó a pub read API-val úgyis lekérdezheti). Nincs idempotens "ugyanaz az érték" ág.
9. **DB write** — `databases.updateDocument()` az API key-jel. 404 → `publication_not_found`; egyéb hiba → `write_failed` (500).

**Sentinel nincs**: a `validate-publication-update` post-event CF a rootPath-t csak logolja (nem revertel), így nincs visszacsatolási veszély.

**Hibakódok**: `invalid_payload` (400), `missing_publication_id` (400), `unauthenticated` (401), `misconfigured` (500), `invalid_root_path` (400, + `detail`), `publication_not_found` (404), `publication_fetch_failed` (500), `missing_scope` (422), `permissionDenied` (403), `root_path_already_set` (409), `write_failed` (500), `internal_error` (500).

### cascade-delete

Cikk törléskor: üzenetek, validációk, thumbnailek törlése. Kiadvány törléskor: cikkek törlése (→ rekurzív cascade), layoutok, deadline-ok törlése.

### cleanup-orphaned-locks

Naponta 3:00 UTC. Zárolások ellenőrzése: owner létezik-e, `$updatedAt` > 24h. Feltételek teljesülése → lock feloldás.

### cleanup-orphaned-thumbnails

Hetente vasárnap 4:00 UTC. Storage bucket ↔ DB `thumbnails` mezők összehasonlítása. Nem hivatkozott fájlok törlése. Hibás JSON → abort (nem töröl semmit).

### cleanup-archived-workflows

Naponta 5:00 UTC. A soft-delete-elt workflow-k (`archivedAt` a user által beállítva az `archive_workflow` action-ön keresztül) közül a `ARCHIVED_RETENTION_DAYS` napnál (default 7) régebbieket hard-delete-eli. **Blocking scan**: per-workflow lekéri az összes hivatkozó publikációt (`publications.workflowId === wf.$id`) és szűri a `compiledWorkflowSnapshot`-tal rendelkezőket — ha legalább egy **snapshot-nélküli** publikáció referálja, skip (a nem-aktivált vagy legacy snapshot-nélküli aktív pub a live doc-ra támaszkodik). Aktivált, snapshot-tal védett publikációk NEM blokkolnak (a snapshot leválasztja a runtime-ot a live doc-tól, ld. Feladat #37). Korai blocker-cap: 5 blocker/workflow (elég a skip döntéshez). Retention env var-ral konfigurálható.

### migrate-legacy-paths

Manuális futtatás. `DRY_RUN=true` alapértelmezett — csak logol. Publications: `/Volumes/...` → kanonikus. Articles: abszolút filePath → relatív.

### invite-to-organization

HTTP CF, három `action`-nel — minden tenant management művelet egy helyen. A tenant collection-öket (organizations, organizationMemberships, editorialOffices, editorialOfficeMemberships, organizationInvites) a **collection-szintű ACL** védi: a kliens `read("users")` joggal rendelkezik (csak olvasás), az írás kizárólag ezen a CF-en keresztül történik API key-jel. Nincs szükség sentinel mezőre vagy külön trigger guard CF-re.

**Bemeneti payload**:
```json
{ "action": "bootstrap_organization" | "create_organization" | "create" | "accept" | "list_my_invites" | "decline_invite" | "leave_organization" | "add_group_member" | "remove_group_member" | "create_group" | "rename_group" | "update_group_metadata" | "archive_group" | "restore_group" | "delete_group" | "create_workflow" | "update_workflow" | "update_workflow_metadata" | "delete_workflow" | "duplicate_workflow" | "archive_workflow" | "restore_workflow" | "assign_workflow_to_publication" | "activate_publication" | "create_permission_set" | "update_permission_set" | "archive_permission_set" | "restore_permission_set" | "assign_permission_set_to_group" | "unassign_permission_set_from_group" | "bootstrap_workflow_schema" | "bootstrap_publication_schema" | "bootstrap_groups_schema" | "bootstrap_permission_sets_schema" | "delete_organization" | "delete_editorial_office" | "backfill_tenant_acl", ... }
```

**Biztonsági megjegyzés**: Korábban létezett egy `organization-membership-guard` trigger CF, amely egy `modifiedByClientId === 'server-guard'` sentinellel engedélyezte az invite-eredetű membership-eket. Ez **kliens-forgeable** volt — bármely hitelesített user beállíthatta a payload-ban. A Codex adversarial review jelezte a kritikus sebezhetőséget, és a javítás ACL-alapú védelemre váltott (B.5 utolsó iteráció, 2026-04-07).

**ACTION='bootstrap_organization'** (onboarding flow):
1. Caller user kötelező (`x-appwrite-user-id` header).
2. Bemeneti mezők: `orgName`, `orgSlug`, `officeName`, `officeSlug` (mind trim + length check + slug regex validáció).
3. **Atomikus tenant + workflow write** API key-jel:
   - `organizations` — `{ name, slug, ownerUserId: callerId }`
   - `organizationMemberships` — `{ organizationId, userId: callerId, role: 'owner', addedByUserId: callerId }`
   - `editorialOffices` — `{ organizationId, name, slug }` (workflowId nullként, a 7. lépés tölti)
   - `editorialOfficeMemberships` — `{ editorialOfficeId, organizationId, userId: callerId, role: 'admin' }`
   - **A.2.8 (ADR 0008, 2026-05-02)**: a 7-csoport default group/groupMembership seedelés **kivéve**. Az új office 0 felhasználó-csoporttal indul; a workflow `requiredGroupSlugs[]` a forrás, az autoseed flow (`activate_publication` / `assign_workflow_to_publication`) hozza létre őket.
   - **Workflow seed**: `defaultWorkflow.json` clone az új office alá (lásd [packages/maestro-shared/defaultWorkflow.json](packages/maestro-shared/defaultWorkflow.json)). A default workflow `requiredGroupSlugs[]`-je tartalmazza a 7 hagyományos slugot (editors/designers/writers/...) — autoseed-elhetőek aktiváláskor.
4. **Best-effort rollback**: ha a tenant lépéseknél hiba van, a már létrehozott rekordokat visszatörli fordított sorrendben (try/catch minden cleanup lépésen). A workflow seeding hiba nem akadályozza meg az org bootstrap sikerét.
5. Slug ütközés: `org_slug_taken` / `office_slug_taken` (409).
6. Response: `{ success: true, action: 'bootstrapped' | 'existing', organizationId, editorialOfficeId, groupsSeeded: false, workflowSeeded }`.

**ACTION='create_organization'** (#40, avatar dropdown „Új szervezet…"):

A `bootstrap_organization`-vel azonos atomikus create logika (4 collection write + team ACL + workflow seed), de az idempotencia check kihagyva, és (A.2.8 óta) felhasználó-csoport seedelés nélkül. Akkor használandó, ha a caller már tagja egy meglévő orgnak és explicit ÚJ szervezetet kér. Frontend-oldali duplaklikk-védelem szükséges (modal `isSubmitting` guard). Slug ütközés: szerveroldali unique index → `org_slug_taken` (409).

Response: `{ success: true, action: 'created', organizationId, editorialOfficeId, groupsSeeded: false, workflowSeeded }`.

**ACTION='create'** (admin meghívó küldés):
1. Caller user lekérése (`x-appwrite-user-id` header).
2. **Caller jogosultság check** — `listDocuments(memberships, [eq(orgId), eq(userId)])` → role kötelező `owner` vagy `admin`.
3. **Email format check** — `EMAIL_REGEX`.
4. **Idempotencia** — ha létezik pending invite ugyanerre az `email + organizationId` párra, lejárat előtt visszaadjuk a meglévő tokent. Lejárt invite → `expired`-re állítva, új invite generálva.
5. **Token generálás** — `crypto.randomBytes(32).toString('hex')` → 64 char hex.
6. **Expiry** — `now + 7 nap` ISO string.
7. `createDocument(organizationInvites, {...})` → response.

> **NINCS** `messaging.*` hívás. Az e-mail küldés Fázis 6-ra halasztva. B.10-ben Console-ról manuálisan tesztelhető.

**ACTION='accept'** (invitee oldal):
1. Caller user kötelező.
2. **Token lookup** — `listDocuments(invites, [eq(token)])`. 0 hit → `invite_not_found` (404).
3. **Status check** — `invite.status !== 'pending'` → `invite_not_pending` (410).
4. **Expiry check** — lejártnál `expired`-re állítás + `invite_expired` (410).
5. **Email match check** — `usersApi.get(callerId)` → caller.email vs invite.email (lowercase összehasonlítás). Eltérés → `email_mismatch` (403). Ez védi, hogy más user ne tudja ellopni a tokent.
6. **Duplikátum check** — ha már van membership, csak az invite status frissül `accepted`-re (idempotens).
7. `createDocument(memberships, { organizationId, userId: callerId, role, addedByUserId })` — API key-jel írja, az ACL miatt csak így lehetséges.
8. `updateDocument(invite, { status: 'accepted' })`.

**ACTION='list_my_invites'** (#41, Maestro beállítások „Függő meghívóim" szekció):

A meghívott user nem tudja közvetlenül lekérdezni a saját pending invite-jait — az `organizationInvites` ACL `read("team:org_${orgId}")`-re szűkített, és az invitee még nincs a team-ben. Ez az action API key-jel keres a caller `email`-jére regisztrált pending invite-okra, és denormalizált org-név + meghívó user név mezőkkel adja vissza.

1. `usersApi.get(callerId)` → caller `email` (lower-case-elve, hiány esetén `missing_caller_email` 400).
2. `listDocuments(invites, [eq(email), eq(status, 'pending'), orderDesc($createdAt), limit(100)])`.
3. Lejárt invite-okat opportunista módon `expired`-re állítja (best-effort, nem blokkolja a választ).
4. Per-invite enrichment: `organizations.getDocument(orgId)` + `usersApi.get(invitedByUserId)` per-request cache-elve, hogy az ismétlődő lekérések egyszer fussanak.

Response: `{ success: true, action: 'listed', invites: [{ $id, token, email, role, organizationId, organizationName, invitedByUserId, invitedByName, expiresAt, createdAt }, ...] }`.

**ACTION='decline_invite'** (#41):

Pending invite elutasítása. Token + e-mail match védelem (mint az `accept`-nél), majd `status='declined'`. Idempotens: nem-pending invite → megfelelő hibakód.

1. Payload: `{ token }` (kötelező).
2. Token lookup → 404 `invite_not_found`.
3. Status check → 410 `invite_not_pending`.
4. Expiry check → auto-expire + 410 `invite_expired`.
5. E-mail match check → 403 `email_mismatch`.
6. `updateDocument(invite, { status: 'declined' })`.

Response: `{ success: true, action: 'declined', inviteId, organizationId }`.

**ACTION='leave_organization'** (#41):

A caller saját kilépése egy szervezetből — a teljes scope-takarítás a caller saját rekordjaira korlátozott. Last-owner blokk: ha a caller az utolsó owner és van más tag → `last_owner_block` (delegálás kell előtte). Ha a caller az egyedüli tag → `last_member_block` (a UI a `delete_organization` flow-t kínálja fel; szándékos disambiguation, hogy a leave ne legyen árva-org generátor).

1. Payload: `{ organizationId }` (kötelező).
2. **Caller membership lookup** — 404 `not_a_member`.
3. **Last-owner check** — owner caller-nél ha nincs másik owner és van másik tag → 409 `last_owner_block` (`hint: 'transfer_ownership_first'`); ha egyetlen tag is → 409 `last_member_block` (`hint: 'delete_organization_instead'`).
4. **Office ID-k listája** — lapozott listing a per-office team membership cleanup-hoz.
5. **Team cleanup STRICT (DB delete ELŐTT)** — minden office-ra `removeTeamMembership(teamsApi, office_${oid}, callerId)`, majd az org team-ből is. Fázis 2 Team ACL óta a team membership szabályozza a Realtime + REST olvasási hozzáférést; ha előbb a DB doc-okat törölnénk és a team cleanup elbukna, a user továbbra is kapna Realtime push-t már-törölt rekordokról (ghost ACL access). Hiba → 500 `team_cleanup_failed`, a DB érintetlen, retry biztonságos (`removeTeamMembership` idempotens, 404/409 skip).
6. **Office memberships törlés** — lapozott `deleteDocument` a caller `editorialOfficeMemberships` doksin az adott orgban (`CASCADE_BATCH_LIMIT=100`). Bármely delete hiba → loop break + 500 `office_memberships_failed` (infinite-loop guard: full-size page + tartós delete hiba különben örökre újrapörgetné a lapozást).
7. **Group memberships törlés** — lapozott `deleteDocument` a caller `groupMemberships` doksin az adott orgban, ugyanazzal az infinite-loop guard-dal. Bármely failure → 500 `group_memberships_failed`.
8. **Org membership doc törlés** — a fő rekord. Hiba → 500 `membership_delete_failed`. A gyerek-membership-ek már le vannak bontva, retry biztonságos (idempotens).

Response: `{ success: true, action: 'left', organizationId, removed: { organizationMembership, editorialOfficeMemberships, groupMemberships }, teamCleanup }`.

**ACTION='add_group_member'**:
1. Caller user kötelező.
2. Bemeneti mezők: `groupId`, `userId`.
3. **Caller jogosultság check** — group lekérés → `organizationId` → org membership lookup → `owner` vagy `admin` role szükséges.
4. Target user lekérés (`users.get()`) → `userName`, `userEmail` denormalizálás.
5. `createDocument(groupMemberships, { groupId, userId, editorialOfficeId, organizationId, role: 'member', addedByUserId, userName, userEmail })`.
6. **Idempotens**: `document_already_exists` → success `{ action: 'already_member' }`.

**ACTION='remove_group_member'**:
1. Caller user kötelező.
2. Bemeneti mezők: `groupId`, `userId`.
3. **Caller jogosultság check** — group lekérés → org membership lookup → `owner` vagy `admin`.
4. `listDocuments(groupMemberships, [eq(groupId), eq(userId)])` → delete.
5. **Idempotens**: ha nem létezik → success `{ action: 'already_removed' }`.
6. **A.2.5 (ADR 0008) warning scan**: ha a delete után a csoport üres lett ÉS a slug bármely aktív publikáció `compiledWorkflowSnapshot.requiredGroupSlugs[]`-ben szerepel (org-szintű scan, `MAX_REFERENCES_PER_SCAN=50` cap), a response `warnings: [{ code: 'empty_required_group', slug, groupId, affectedPublications: [...], note }]` mezővel jelzi. A művelet engedett (snapshot védi a runtime-ot), best-effort scan (hibára nem blokkol). Az UI banner-ként megjeleníti.

**ACTION='update_group_metadata'** (alias: `rename_group`):
1. Caller user + `groupId` kötelező.
2. **Slug immutable enforcement**: `payload.slug !== undefined` → 400 `slug_immutable`.
3. Frissíthető mezők (mindegyik opcionális, `undefined` = no-op):
   - `label` vagy `name` — UI-ban "Címke", DB-ben a `name` mezőben tárolva (max 128 char).
   - `description` — max 500 char, `null` = explicit törlés.
   - `color` — CSS hex (`#rrggbb`/`#rrggbbaa`/`#rgb`), nullable.
   - `isContributorGroup` / `isLeaderGroup` — boolean.
4. Caller jogosultság: org owner/admin.
5. Label-uniqueness check az office-on belül (csak ha változik).
6. **Schema-safe fallback**: ha az új mezők (`description`/`color`/`isContributorGroup`/`isLeaderGroup`) hiányoznak a sémából, két ág:
   - Tiszta legacy `rename_group` (csak `name` érkezett) → success `{ action: 'renamed' }`.
   - Vegyes payload → 422 `schema_missing` + `bootstrap_groups_schema` hint (ne adjunk hamisan sikeres response-t részleges update után).

**ACTION='archive_group' / 'restore_group'** (A.2.7):

Soft-delete a csoporton — `archivedAt` set/null. Idempotens (`already_archived`/`already_active`). Az `archive_group` ugyanazt a blocker-set-et alkalmazza, mint a `delete_group`: blokk, ha nem-archivált workflow `requiredGroupSlugs[]`/state-mezők hivatkozzák, VAGY aktív pub `compiledWorkflowSnapshot` hivatkozza. A tagok (`groupMemberships`) intaktan maradnak — a restore-szemantika megőrzéséhez. Auth: org owner/admin. Schema-safe fallback: ha az `archivedAt` mező hiányzik, 422 `schema_missing` + `bootstrap_groups_schema` hint.

**ACTION='delete_group'** (A.2.7 update — `DEFAULT_GROUPS` védelem eltávolítva, A.2.8 óta):

Hard-delete + kaszkád. Blocker-check: org-szintű scan (a) **nem-archivált workflow** compiled JSON-ja hivatkozza (`workflowReferencesSlug` az új `requiredGroupSlugs[]` mezőt is fedi); (b) **aktív publikáció `compiledWorkflowSnapshot`**-ja hivatkozza; (c) `articles.contributors` / `publications.defaultContributors` JSON kulcsként tartalmazza. Bármelyik → 409 `group_in_use` + `workflows`/`activePublications`/`publications`/`articles` listák. Auth: org owner/admin. Cascade: `groupMemberships` → `groups` doc → compensating sweep race-védelemhez.

**ACTION='assign_workflow_to_publication'** (A.2.3):

Workflow hozzárendelése publikációhoz. Lépések: (1) caller office-membership a pub office-ában; (2) pub fetch + workflow fetch + 3-way visibility scope match; (3) aktivált pub workflow-cseréje TILTOTT (`publication_active_workflow_locked` 409); (4) **autoseed** (`seedGroupsFromWorkflow` helper) — minden hiányzó `requiredGroupSlugs[].slug`-ra üres `groups` doc, idempotens, `first-write wins` policy + `group_slug_collision` warning eltérő flag-ekre + schema-safe fallback `bootstrap_groups_schema` nélkül; (5) pub update `workflowId`-vel. Min. 1 tag-check **NINCS** — az csak az `activate_publication`-nél kötelező. Response: `{ success, publicationId, workflowId, autoseed: { created, existed, warnings } }`.

**ACTION='activate_publication'** (A.2.2 + A.2.4):

Publikáció aktiválása. Lépések: (1) caller office-membership; (2) **TOCTOU guard** — opcionális `expectedUpdatedAt` payload mezővel összevetjük a fresh `pubDoc.$updatedAt`-et, eltérés → 409 `concurrent_modification`; (3) `workflowId` set + workflow fetch; (4) **pre-aktiválási validáció** inline `validateDeadlinesInline`-szel (workflowId megvan, deadlinek lefedik a coverage-et átfedés nélkül) → 422 `invalid_deadlines` ha invalid; (5) **autoseed** (`seedGroupsFromWorkflow`); (6) **min. 1 tag check** (`findEmptyRequiredGroupSlugs`) → 409 `empty_required_groups: [slugs]` ha nincs; (7) idempotens `already_activated` ha pub már aktivált + snapshot azonos a workflow `compiled`-jével; (8) atomic update: `{ isActivated: true, activatedAt, compiledWorkflowSnapshot: wf.compiled, modifiedByClientId: 'server-guard' }`. A `server-guard` sentinel a post-event `validate-publication-update` CF-et skip-pelteti, hogy a snapshot ne íródjon felül + a deaktiválási loop ne fusson. Response: `{ success, publicationId, workflowId, activatedAt, autoseed }`.

**ACTION='bootstrap_groups_schema'** (A.2.6 + A.2.7 + A.2.2 előfeltétel):

Owner-only schema-bővítés a `groups` collection-en. Új mezők: `description` (string 500), `color` (string 9, hex), `isContributorGroup` (bool, default false), `isLeaderGroup` (bool, default false), `archivedAt` (datetime, nullable). Plusz unique index `office_slug_unique` az `(editorialOfficeId, slug)` páron — az autoseed `document_already_exists` skip duplikátum-védelméhez kötelező (Codex review). Idempotens (409 → skip), `indexesPending` listával az aszinkron attribute-feldolgozás miatt. Action-szintű env var igény nincs külön (a `GROUPS_COLLECTION_ID` mindig kötelező).

**ACTION='delete_editorial_office'** (Dashboard Redesign Fázis 8):
1. Caller user kötelező + `editorialOfficeId` payload.
2. **Env var guard** — `PUBLICATIONS_COLLECTION_ID` hiánya esetén 500 `misconfigured` (a többi action továbbra is fut).
3. **Office létezés** (`getDocument`) — 404 → `office_not_found`.
4. **Caller jogosultság** — az office `organizationId`-jában `owner` vagy `admin` role szükséges (`Query.select(['role'])` szűkítéssel).
5. **Fail-closed kaszkád** (`cascadeDeleteOffice` helper): publications doc-onkénti `deleteDocument` → a meglévő `cascade-delete` CF kaszkádolja az articles/layouts/deadlines-t és az azokhoz kapcsolódó validációkat/thumbnaileket. Parallel `deleteByQuery`: workflows, groups, groupMemberships, editorialOfficeMemberships. Bármely lépés hibája → dob és az office doc érintetlen marad (`cascade_failed`, 500).
6. **Office doc törlése** — csak akkor, ha minden gyerek cleanup sikeres.
7. Response: `{ success: true, editorialOfficeId, deletedCollections }`.

**ACTION='delete_organization'** (Dashboard Redesign Fázis 8):
1. Caller user kötelező + `organizationId` payload.
2. **Env var guard** — `PUBLICATIONS_COLLECTION_ID` hiánya esetén 500 `misconfigured`.
3. **Org létezés** (`getDocument`) — 404 → `organization_not_found`.
4. **Caller jogosultság** — kizárólag `owner` (admin NEM törölhet org-ot, szándékos magas blast radius miatt).
5. **Lapozott, fail-closed office kaszkád**: `listDocuments(offices, [Query.equal('organizationId', …), limit=100])`, majd minden office-ra `cascadeDeleteOffice` + `deleteDocument(office)`. A soron következő batch-et frissen listázzuk (a már törölt office-ok nem szerepelnek). Az első office kaszkád hiba → azonnali leállás, a részleges `completedOffices` stats a response-ban.
6. **Org-szintű cleanup sorrend (harden reorder)**: (a) `organizationInvites` `deleteByQuery`, (b) az **org doc törlése**, (c) `organizationMemberships` `deleteByQuery`. A memberships az org doc UTÁN, hogy a caller owner-sége megmaradjon a kritikus pontig — különben egy félúton elhasalt delete árva, újra-törölhetetlen (not_a_member) szervezetet hagyna. A memberships cleanup az org doc törlése után már csak kozmetikus; ha elbukik, a hiba a server log-ba kerül, de a user `success`-t kap (az org úgyis eltűnt).
7. Response: `{ success: true, organizationId, deletedOffices, officeStats, orgCleanup }`.

#### Tenant scope Team ACL (Feladat #60, 2026-04-19)

A Realtime WS payload minden authentikált usernek szétszór rá-feliratkozott collection-eventeket — a collection-szintű `read("users")` ACL tehát a Realtime push-t cross-tenant lefedi. Mivel a Dashboard és Plugin ugyanazokat a collection-eket tölti be, minden user látná az összes szervezet groups/groupMemberships/organizationInvites eventjeit (az UI oldali filter kozmetikus). A megoldás: per-tenant Appwrite Team alapú, dokumentum-szintű ACL.

**Team ID konvenciók** (`teamHelpers.js`):
- `org_${organizationId}` — minden szervezetre egy team, tagjai az `organizationMemberships` alapján.
- `office_${editorialOfficeId}` — minden szerkesztőségre egy team, tagjai az `editorialOfficeMemberships` alapján.

**Dokumentum ACL**:
- `organizationInvites` — `read("team:org_${orgId}")`
- `groups`, `groupMemberships` — `read("team:office_${officeId}")`

**Team sync eseménynaptár** (minden változás ezen a CF-en keresztül):
- `bootstrap_organization` → org team + office team + owner/admin tagság + minden seed group/groupMembership ACL-lel.
- `create_editorial_office` → új office team + admin tagság + seed groupok/memberships ACL-lel.
- `accept` (invite) → az új org-member-t ráhúzza az org team-re (best-effort, nem blokkol).
- `create_group` / `add_group_member` → új group / groupMembership doc kapja az office ACL-t.
- `delete_editorial_office` / `delete_organization` → office team + (org esetén) org team törlés cascade. A team törlése az Appwrite-oldalon a memberships-et is takarítja.

**ACTION='backfill_tenant_acl'** (scoped migráció, owner-only):
- Payload: `{ organizationId, dryRun? }` — kötelező `organizationId`, a caller annak `owner`-je kell legyen. NINCS project-wide scan (különben A tenant owner-e mutálhatná B tenant ACL-jét — Codex review [P1] 2026-04-19).
- A target org + annak minden office-a kap team-et + szinkronizált tagságot a memberships collection-ök alapján, és a `organizationInvites` + `groups` + `groupMemberships` doc-okon újraíródik az ACL.
- Idempotens: 409 → skip mind a team, mind a membership műveletnél.
- **Hard prerequisite az org ágon**: ha az org team `ensureTeam` hibát dob, az action azonnal `500 org_team_create_failed`-del leáll, **mielőtt** bármelyik invite ACL-t átírná. Enélkül a `read(team:org_<id>)` egy nem létező team-re mutatna és az invite-ok láthatatlanná válnának (Codex adversarial review [high] 2026-04-19).
- **`team_not_found` hard error**: ha a membership sync 404-et kap egy imént létrehozott team-en (párhuzamos törlés), a `errors[]`-be kerül (mind org, mind office ágon).
- Fail-open per-doc az ACL rewrite loopokban: egyedi hiba belekerül a `errors[]` listába, a többi doc megy tovább.
- Opcionális `dryRun: true` — csak számol, nem ír. Javasolt a deploy utáni első futásra.
- Response: `{ success: true, action: 'backfilled', stats: { dryRun, organizationId, organizations, offices, acl, errors } }`.
- Több org migrálásához többször kell hívni (egyszeri művelet, nem üzleti flow).

**Deploy checklist** (egyszeri):
1. `invite-to-organization` CF újradeploy (új `teamHelpers.js` miatt `--code functions/invite-to-organization` teljes feltöltés kell).
2. API key scope-ok: a meglévő `databases.*` + `users.read` mellett `teams.read` + `teams.write` szükséges.
3. `backfill_tenant_acl` futtatása `{ organizationId, dryRun: true }`-val minden org-ra → log ellenőrzés.
4. `backfill_tenant_acl` futtatása éles móddal (`dryRun` nélkül) minden org-ra → stats validálás.
5. Appwrite Console-on a 3 érintett collection (`organizationInvites`, `groups`, `groupMemberships`) `rowSecurity` flag-jét `true`-ra + a globális `read("users")` ACL-t eltávolítani (csak utána lesz aktív a tenant szűrés — addig a doc-szintű perms el van tárolva, de a collection-szintű olvasás még mindenkinek engedi).

**Hibakódok** (mind a `fail()` wrapperen keresztül `{ success: false, reason, ...extra }` formátumban):
`invalid_payload`, `invalid_action`, `unauthenticated`, `missing_fields`, `invalid_slug`, `org_slug_taken`, `org_create_failed`, `membership_create_failed`, `office_slug_taken`, `office_create_failed`, `office_membership_create_failed`, `org_team_create_failed`, `org_team_membership_create_failed`, `office_team_create_failed`, `office_team_membership_create_failed`, `invalid_email`, `invalid_role`, `not_a_member`, `insufficient_role`, `invite_not_found`, `invite_not_pending`, `invite_expired`, `email_mismatch`, `missing_caller_email`, `invites_list_failed`, `invite_lookup_failed`, `invite_update_failed`, `last_owner_block`, `last_member_block`, `membership_lookup_failed`, `membership_delete_failed`, `owner_scan_failed`, `office_memberships_failed`, `group_memberships_failed`, `caller_lookup_failed`, `group_not_found`, `target_user_not_found`, `group_member_create_failed`, `misconfigured`, `office_not_found`, `office_fetch_failed`, `cascade_failed`, `office_delete_failed`, `organization_not_found`, `organization_fetch_failed`, `office_list_failed`, `org_cleanup_failed`, `organization_delete_failed`, `scan_failed`.

---

## Workflows Collection (Fázis 4)

A guard function-ök a `workflows` collection `compiled` JSON mezőjéből olvassák a workflow konfigurációt. Minden szerkesztőséghez (editorial office) tartozik egy workflow dokumentum.

**Betöltés**: `getWorkflowForOffice(databases, databaseId, workflowsCollectionId, editorialOfficeId)` — 60s TTL process-szintű cache-sel, hogy ne legyen per-request DB olvasás.

**Fail-closed**: Ha nincs workflow dokumentum (cache miss + DB üres) → state revert / reject. Nincs fallback konfiguráció.

**Compiled JSON struktúra**: `states`, `transitions`, `validations`, `commands`, `elementPermissions`, `contributorGroups`, `leaderGroups`, `statePermissions`, `capabilities`.

**Contributor mezők (Fázis 3)**: A `contributors` (articles) és `defaultContributors` (publications) JSON longtext mező, a kulcsa a csoport `slug`-ja (pl. `{"designers":"userId1","editors":"userId2"}`). A CF-ek `JSON.parse()` → kulcs iterálás → userId validáció mintát használják.

### Visibility + createdBy (#30)

Két új attribútum a `workflows` collection-ön:

| Mező | Típus | Default | Célja |
|------|-------|---------|-------|
| `visibility` | enum (`organization`, `editorial_office`) | `editorial_office` | A workflow láthatósági hatóköre a Plugin / Dashboard fetch query-ben. |
| `createdBy` | string (36, nullable) | null | A létrehozó user `$id`-je (informatív; legacy row-okon null). |

**2-way MVP szemantika**:
- `organization`: az adott org bármely office tagja látja a workflow-t (cross-office szabvány).
- `editorial_office`: csak az adott office tagjai látják (alapértelmezett, régi viselkedés).

**Idempotens schema bootstrap** — `bootstrap_workflow_schema` CF action:
- Owner-only (any org-ban owner role elég).
- `databases.createEnumAttribute` + `createStringAttribute` — 409 catch → skip (idempotens).
- Legacy row-ok `visibility=null` → a Plugin / CF fallback `'editorial_office'`-ra értékeli.

**Idempotens publications schema bootstrap** — `bootstrap_publication_schema` CF action (#36):
- Owner-only (any org-ban owner role elég).
- `databases.createStringAttribute(publications, 'compiledWorkflowSnapshot', 1_000_000, required=false, default=null)` — 409 catch → skip.
- A mezőt a `validate-publication-update` CF §5a írja aktiválási sikeres átmenetnél (a workflow `compiled` JSON pillanatképe). Onnantól immutable (§6b guard). Legacy (snapshot nélküli) aktív publikációkon null marad — a Plugin a `workflowId` cache-re fallback-el (Feladat #38).

**Idempotens permission set schema bootstrap** — `bootstrap_permission_sets_schema` CF action (A.1 / ADR 0008):
- Owner-only (any org-ban owner role elég).
- Két új collection (`permissionSets` + `groupPermissionSets`) idempotens létrehozása `documentSecurity: true` flaggel. A collection-szintű perms üres — a doc-szintű team ACL ad olvasási jogot (ADR 0003 minta szerint). A 409 / "already exists" → `skipped`, a hiba propagál minden más esetre.
- `permissionSets` attribútumok: `name`, `slug`, `description`, `permissions[]` (string array), `editorialOfficeId`, `organizationId`, `archivedAt`, `createdByUserId`. Indexek: `office_slug_unique`, `office_idx`, `org_idx`.
- `groupPermissionSets` (m:n junction) attribútumok: `groupId`, `permissionSetId`, `editorialOfficeId`, `organizationId`. Indexek: `group_set_unique`, `office_idx`, `group_idx`, `set_idx`.
- Action-szintű env var guard: `PERMISSION_SETS_COLLECTION_ID` + `GROUP_PERMISSION_SETS_COLLECTION_ID` — csak ezen az action-ön kötelezőek; a többi action működése érintetlen.
- A default permission set-ek (`owner_base`, `admin_base`, `member_base`) seedelése **NEM ennek az action-nek a feladata** — A.3.2 implementálta: a `bootstrap_organization` és a `create_editorial_office` automatikusan seedeli őket minden új office-ra (`seedDefaultPermissionSets` helper).
- Aszinkron Appwrite attribute processing miatt az index-create első futáson 400-zal elbukhat (`indexesPending`) — a user 10s múlva újra futtatja az action-t (idempotens).
- Deploy után a Console-on ellenőrizendő: a két új collection `rowSecurity` flag-je aktív (különben a doc-szintű ACL nem érvényesül).

### Permission set CRUD action-ök (A.3.3-A.3.4 / ADR 0008)

**ACTION='create_permission_set'** (A.3.3):
- Payload: `{ editorialOfficeId, name, slug, description?, permissions[] }`.
- Auth jelenleg org owner/admin (mint `create_group`). A.3.6 retrofitben → `userHasPermission('permissionSet.create', editorialOfficeId)`.
- Slug regex check (`SLUG_REGEX`), `validatePermissionSetSlugs(permissions)` (`permissions.js`-ből) — 400 `org_scope_slug_not_allowed` ha bármely slug `org.*`-prefixű, 400 `invalid_permissions` egyéb hibára.
- Slug-ütközés: `office_slug_unique` index → 409 `permission_set_slug_taken`.
- ACL: `buildOfficeAclPerms(editorialOfficeId)`.
- Description max 500 char, nullable. `permissions` de-duplikálva.

**ACTION='update_permission_set'** (A.3.3):
- Payload: `{ permissionSetId, name?, description?, permissions? }`.
- **Slug immutable**: `payload.slug !== undefined` → 400 `slug_immutable`.
- Selective update; `name` undefined / `description` undefined / `permissions` undefined = no-op az adott mezőre. Ha mind undefined, success `action: 'noop'`.
- `permissions[]` validáció ugyanaz, mint a create-nél.

**ACTION='archive_permission_set'** / **'restore_permission_set'** (A.3.3):
- Payload: `{ permissionSetId }`. Közös handler (`isArchive` flag).
- `archivedAt` set/null. Idempotens (`already_archived` / `already_active`).
- **NINCS blocker scan** (Codex review (b) opció): a `groupPermissionSets` junction docok intaktan maradnak. Az archivált permission set-eket a `userHasPermission()` snapshot build a `Query.isNull('archivedAt')` szűrővel hagyja figyelmen kívül; restore esetén automatikusan visszaáll.
- Schema-missing → 422 `schema_missing` + `bootstrap_permission_sets_schema` hint.

**ACTION='assign_permission_set_to_group'** (A.3.4):
- Payload: `{ groupId, permissionSetId }`. M:n junction (`groupPermissionSets`) doc create.
- Cross-office check: 400 `office_mismatch` ha `groupDoc.editorialOfficeId !== setDoc.editorialOfficeId`.
- Idempotens: `group_set_unique` index → `already_assigned` + a meglévő junction doc.
- Best-effort warning ha a permission set archivált (`{ code: 'permission_set_archived' }`) — UI banner-rel jelezhető, hogy a hozzárendelés érvényes lesz a restore után.
- ACL: `buildOfficeAclPerms`.

**ACTION='unassign_permission_set_from_group'** (A.3.4):
- Payload: `{ groupId, permissionSetId }`. Junction doc lookup + delete.
- Idempotens: ha nem létezik junction → success `already_unassigned`.

### `permissions.js` modul (A.3.5 + A.3.6 + 2026-05-03 harden)

A jogosultsági helper kétféle:

- **[`packages/maestro-shared/permissions.js`](packages/maestro-shared/permissions.js)** (ESM, kliens + szerver): slug-konstansok (38 slug + 8 `PERMISSION_GROUPS`), `DEFAULT_PERMISSION_SETS`, `validatePermissionSetSlugs`, sync helperek (`isOfficeScopeSlug`, `isOrgScopeSlug`, `clientHasPermission`).
- **[`packages/maestro-server/.../src/permissions.js`](packages/maestro-server/functions/invite-to-organization/src/permissions.js)** (CommonJS, server-only): inline duplikáció + async lookup helperek:
  - `userHasPermission(databases, env, user, slug, officeId, snapshotsByOffice?, orgRoleByOrg?)` — office-scope (33 slug). 1) global admin label (a CF entry-pointja az `x-appwrite-user-labels` headerből CSV-ben tölti be — A.3.6 final review fix), 2) `organizationMemberships.role === 'owner'/'admin'` → mind a 33 slug, 3) **`isStillOfficeMember` defense-in-depth cross-check (A.3.6 harden 2026-05-03)** — ha a user nincs `editorialOfficeMemberships`-ben, üres set, 4) member-path: `groupMemberships` × `groupPermissionSets` × `permissionSets.permissions[]` (`archivedAt === null` szűrt, `OFFICE_SCOPE_PERMISSION_SLUG_SET` defense). Throw `org.*` slugra.
  - `userHasOrgPermission(databases, env, user, slug, orgId, orgRoleByOrg?)` — org-scope (5 slug). 1) global admin label, 2) `organizationMemberships.role === 'owner'` → mind az 5, `'admin'` → 3 (kivéve `org.delete`/`org.rename`). Throw nem-`org.*` slugra.
  - `isStillOfficeMember(databases, env, userId, officeId)` — **A.3.6 harden 2026-05-03**: shared single-source-of-truth a `editorialOfficeMemberships` lookup-okhoz. Fail-closed boolean. 3 hívási hely: `buildPermissionSnapshot` member-path, `archive_workflow`/`restore_workflow` ownership-fallback, `update_workflow_metadata` visibility-ág. Két privilege-eszkalációs felület lezárása: (a) rogue `groupMembership` write (out-of-band DB), (b) kilépett creator ownership.
  - `buildPermissionSnapshot()` — egyszer számol per office, `{ userId, editorialOfficeId, organizationId, orgRole, permissionSlugs: Set<string>, hasGlobalAdminLabel }` formátumban.
  - `createPermissionContext()` — `{ snapshotsByOffice: Map, orgRoleByOrg: Map }` per-request scaffold (A.3.7 server-side cache). **Request-snapshot consistency**: a memoizált snapshot a CF-call lifecycle-ja alatt él — egy mid-request permission-változás NEM látszik a request belül (szándékos elv).
  - `validatePermissionSetSlugs(slugs)` — write-path validáció (CRUD action-ök).

**Drift kockázat**: a slug-set, `DEFAULT_PERMISSION_SETS` és `validatePermissionSetSlugs` a CF inline-ban duplikált. A két forrás manuálisan szinkronban tartandó (Phase 2: ugyanaz a minta, mint a `validateCompiledSlugs` (A.2.1) — **A.7.1 megoldotta** a `compiledValidator.js`-re a `scripts/build-cf-validator.mjs` generátorral; ezt a `permissions.js`-re is meg kell ismételni egy hasonló `scripts/build-cf-permissions.mjs` script-tel).

**Snapshot-preferáló workflow lookup** (CF hardening, #37):
- `update-article` CF `getWorkflowForPublication()` — ha a publikációnak van `compiledWorkflowSnapshot`-ja, a CF kizárólag azt parse-olja (snap cache kulcs: `snap:${pubId}:${length}`). Csak snapshot hiányában / parse hibánál esik vissza a live `workflowId` lookup-ra. A workflow Dashboard-oldali módosításai így NEM érintik az aktivált publikáció cikk-validációit.
- `validate-article-creation` CF `loadValidStates(parentPublication)` — ugyanez a preferencia: a snapshot-ból vett states set elfogadja a Plugin által a pillanatkép alapján választott initial state-et akkor is, ha a live workflow-ból már hiányzik.
- `article-update-guard` CF (post-event safety net) `getWorkflowForPublication()` — snapshot preferencia a teljes stack konzisztenciájáért: plugin, write-path CF és guard mind ugyanazt a workflow verziót látják.

**Új CF action-ök (#30, #80, #81)**:
- `update_workflow_metadata` — `{ editorialOfficeId, workflowId, name?, visibility?, description?, force? }`, org admin/owner auth, office scope match, name uniqueness per office, visibility whitelist. **#80 szűkítés warning**: a `#30`-as `visibility_downgrade_blocked` hard block lecserélve `visibility_shrinkage_warning + force: true` soft warning flow-ra — a kliens popup-ban megerősítteti a usert és `force: true` flag-gel újraküldi. **#81 owner-guard**: a `visibility` változtatást csak a `createdBy === callerId` tulajdonos végezheti (rename/description továbbra is org admin/owner). A `description` field nullable, a trim-elt üres string `null` szándékos törlést jelent (`undefined` = no-op). ACL újraszámolás (`buildWorkflowAclPerms`) minden visibility-váltásnál.
- `duplicate_workflow` — `{ editorialOfficeId, workflowId, name? }`, **#81 cross-tenant**. Az `editorialOfficeId` mostantól a TARGET office (a caller aktív office-a), a forrás bárhol lehet ha a caller olvashatja (scope alapján). A duplikátum MINDIG `editorial_office` scope-on indul, `createdBy = caller`. Auto-suffix a name-hez (`(másolat)`, `(másolat 2)`, …) ha a user nem ad explicit nevet és van ütközés (cap 20). Archivált forrás: 400 `source_archived`.
- `archive_workflow` + `restore_workflow` (#81) — `{ editorialOfficeId, workflowId }`, közös handler (`isArchive` flag). Auth (A.3.6 + 2026-05-03 harden): `createdBy === callerId` ownership-fallback **+ `isStillOfficeMember()` check** (kilépett creator nem maradhat jogosult), VAGY `userHasPermission('workflow.archive', officeId)`. Soft-delete: `archivedAt = now()` / `null`. Idempotens: már archivált → `already_archived`, már aktív → `already_active`. A doc read ACL-je változatlan marad, hogy a még futó publikáció UI-ja tovább lássa.
- `delete_workflow` — `{ editorialOfficeId, workflowId }`, org owner/admin auth. **Blocking scan**: a workflow-ra hivatkozó publikációk listája (`publications.workflowId === workflowId`) — ha van, `workflow_in_use` + `usedByPublications: [...]`. Hatókör: ha `visibility='organization'`, az egész org minden office-át scan-eli; egyébként csak a saját office-t. Cap: `MAX_REFERENCES_PER_SCAN=50` (korai kilépés), `CASCADE_BATCH_LIMIT=100` (paginált listDocuments). A hard-delete a `cleanup-archived-workflows` scheduled CF-en keresztül automatizált — a 7 napon túl archivált workflow-kra.
- `create_workflow` kiegészítés (#30): új row `visibility` (default `editorial_office`) + `createdBy = caller` + `organization` / `public` scope választás support. **A.3.6 ship-blocker fix**: ha `payload.visibility !== WORKFLOW_VISIBILITY_DEFAULT`, plusz `workflow.share` slug-guard (különben egy `workflow.create`-jogú user megkerülné az `update_workflow_metadata` visibility-gate-jét).

### A.3.6 retrofit (2026-05-02 → 2026-05-03 harden, ADR 0008)

A meglévő CF action guardok átkötve a slug-alapú permission rendszerre:

- **24 office-scope action** `userHasPermission()` hívást kap (`workflow.create/edit/archive/duplicate/share`, `group.create/rename/delete/member.add/member.remove`, `permissionSet.create/edit/archive/assign`, `office.rename/delete`, `publication.create/activate/workflow.assign`).
- **3 org-scope action** `userHasOrgPermission()` (`org.member.invite`, `org.rename`, `org.delete`). **BREAKING**: az `org.rename` és `org.delete` az `ADMIN_EXCLUDED_ORG_SLUGS`-ban — admin elveszti rename/delete jogát, kizárólag owner.
- **2 dual-check** a `create_publication_with_workflow`-ban (`publication.create` ÉS `publication.workflow.assign`).
- **Új error reason** `403 insufficient_permission` + `{slug, scope: 'office'|'org', requiresOwnership?: true, field?: 'visibility'}` mezők. A `403 not_workflow_owner` és `403 not_a_member` reason-ök (a retrofit-elt action-ökön) `insufficient_permission`-re egységesítve.
- **Globális env vars** (A.3.6, 2026-05-03 óta KÖTELEZŐ): `PERMISSION_SETS_COLLECTION_ID`, `GROUP_PERMISSION_SETS_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID` (utóbbi az `isStillOfficeMember` defense-in-depth lookup-hoz).

**Szándékos retrofit-kivételek**: `create_editorial_office` (még nincs officeId, marad `org owner/admin` check), `bootstrap_*_schema` / `backfill_tenant_acl` (owner-only schema action-ök), `accept` / `decline_invite` / `leave_organization` / `list_my_invites` (saját önkezelő flow).

**2026-05-03 harden Critical fix-ek**:
1. **Kilépett creator ownership-fallback membership-check**: `archive_workflow`/`restore_workflow` és `update_workflow_metadata` visibility-ág `createdBy === callerId` ownership csak akkor érvényes, ha a caller `isStillOfficeMember()`. Privilege-eszkalációs felület lezárva.
2. **Member-path defense-in-depth `editorialOfficeMemberships` cross-check**: `buildPermissionSnapshot` member-path elején `isStillOfficeMember()` lookup. Rogue `groupMembership` (out-of-band DB-write) privilege-eszkalációs felület lezárva.

**Frontend impact A.4-re**: a 403 reason-mapping átállás slug-alapúra. A.4-ig a régi `insufficient_role` toast-ok generic-be esnek vissza (vault szabálya: nincs visszafelé-kompat).

### Fázis 1 helper-extract (2026-05-03)

A `main.js` 7790 → 6964 sor (-844 sor, -11%) az inline helper-függvények külön modulokba költöztetésével. Új mappa: [packages/maestro-server/functions/invite-to-organization/src/helpers/](packages/maestro-server/functions/invite-to-organization/src/helpers/) (6 modul).

**Import-irány tilt** (Codex flag, ciklikus require kockázat): `actions/*` → `helpers/*` → `permissions.js` / `teamHelpers.js`. Visszafelé NEM. CommonJS ciklikus require csendben fél-inicializált exports-ot ad.

A `main.js` tetejére **77 soros TOC-blokk** került a 36 action handler approximate sorszámaival. **Fázis 2 (CF action-bontás)** szándékosan halasztva — a B blokk (Workflow Extensions) elejére időzítve, mert akkor új action-ök jönnek (lásd Feladatok B.0.3).

**Plugin 2-way fetch query** (`DataContext.jsx`):
```js
Query.or([
    Query.and([Query.equal("visibility", "organization"), Query.equal("organizationId", currentOrgId)]),
    Query.and([Query.equal("visibility", "editorial_office"), Query.equal("editorialOfficeId", currentOfficeId)])
])
```

A Realtime handler `isVisible` logikával ugyanezt a kétágú szűrést alkalmazza minden `.create`/`.update` eseményre (legacy null → `editorial_office` fallback).

### Workflow életciklus + scope refactor (#80, 2026-04-20)

Három irányú scope-modell + doc-szintű Team ACL + archiválás (soft-delete) + fulltext keresés. A Realtime cross-tenant leak-et ugyanaz a Team ACL pattern zárja le, mint a Fázis 2 tenant collection-öké (#60).

**Adatmodell bővítés**:

| Mező | Típus | Default | Célja |
|------|-------|---------|-------|
| `visibility` | enum (`organization`, `editorial_office`, `public`) | `editorial_office` | Három szintű scope — a `public` új érték. |
| `description` | string (500, nullable) | null | Rövid leírás a library panel cardjára. |
| `archivedAt` | datetime (nullable) | null | Soft-delete időpont; `restoreWorkflow` null-ozza. Hard-delete cron trigger 7 nap után. |
| `name_fulltext`, `description_fulltext` | fulltext index | — | Szabadszavas kereső a `WorkflowLibraryPanel`-ben. |

**Doc-szintű ACL** — `teamHelpers.buildWorkflowAclPerms(visibility, orgId, officeId)`:
- `public` → `read("users")` (minden authentikált felhasználó).
- `organization` → `read("team:org_${orgId}")`.
- `editorial_office` → `read("team:office_${officeId}")`.
- Write-jog a CF API key-jé (collection-szintű Update/Delete szerep NEM kap `users`-t). A tulajdonos-ellenőrzést a CF action-ök végzik (`createdBy === callerId`), nem ACL-alapon — ez kell ahhoz, hogy a duplikáló / archiváló CF flow-k az API key-vel írhassanak.
- **`rowSecurity: true` kötelező** a `workflows` collection-ön (különben a collection-szintű olvasás felülírja a doc ACL-t).

**CF hívási pontok, ahol a doc ACL-t ki kell írni** (mind `buildWorkflowAclPerms(...)`-et kap a `createWorkflowDoc` / `updateDocument` 5. paraméterén):
- `bootstrap_organization` — seed default workflow, `WORKFLOW_VISIBILITY_DEFAULT = 'editorial_office'` scope-pal.
- `create_editorial_office` — új office seed workflow, szintén `editorial_office` default.
- `create_workflow` — felhasználó által kért scope (a `visibility` payload érvényes értéke vagy fallback default).
- `duplicate_workflow` — örökölt scope a source workflow-ból (whitelist fallback-kel).
- `update_workflow_metadata` — scope-váltáskor újraszámolt ACL, `databases.updateDocument(..., perms)` 5. paramétere.

**`bootstrap_workflow_schema` (#80 bővítés)**:
- `visibility` enum attribútum: `createEnumAttribute(['organization', 'editorial_office', 'public'])`. Meglévő 2-elemű enum-on 409 → fallback `updateEnumAttribute('public')` hozzáadással. Ha az is elbukik, skip + a response `skipped[]`-be kerül (manuális Console-bump szükséges).
- `description` (string 500, nullable), `archivedAt` (datetime, nullable) létrehozás `createAttribute` 409-fallback-kel.
- Fulltext indexek `name_fulltext` + `description_fulltext` az attribútumok `available` státusza után. Appwrite aszinkron feldolgozása miatt az első futás 400-zal elbukhat a még nem elérhető attribútumokon — ilyenkor a response `indexesPending: true`, és a user 10 másodperc múlva újra futtathatja (idempotens).
- Válasz: `{ success: true, created: [...], updated: [...], skipped: [...], indexesPending: bool, note? }`.

**`update_workflow_metadata` scope-váltás szemantika (#80 átírás)**:
- Korábbi (#30) `visibility_downgrade_blocked` hard block lecserélve `visibility_shrinkage_warning` soft warning + `force: true` override flow-ra.
- Szűkítés (`public → org/office`, `organization → editorial_office`): a CF scan-eli az érintett publikációkat, és ha van `orphanedPublications` lista, `{ success: false, reason: 'visibility_shrinkage_warning', from, to, orphanedPublications, count, note }` választ ad. A kliens popup-ban megkérdezi, majd `force: true` flag-gel újraküldi.
- Tágítás (`editorial_office → org/public`, `organization → public`): nincs warning, ACL egyszerűen átíródik. A kliens a UI-ban info-tooltipot mutat („mostantól szélesebb kör látja").
- Minden scope-módosításnál `buildWorkflowAclPerms(...)`-szel újraszámolt permission-t a `databases.updateDocument(..., perms)` 5. paramétere kap.

**Deploy checklist (egyszeri, manuális Console)**:
1. `invite-to-organization` CF újradeploy (új `teamHelpers.js` + `main.js`) — `--code functions/invite-to-organization` teljes feltöltés.
2. `bootstrap_workflow_schema` action futtatás owner-rel. Ha `indexesPending: true`, várj 10s-t és futtasd újra.
3. Appwrite Console → `workflows` collection: `rowSecurity` → **true**, collection Permissions-ből a globális `read("users")` eltávolítása. Update/Delete role üresen marad (CF API key-vel íródik).
4. Dev-adatbázis workflow-ok eldobhatók; `bootstrap_organization` újraseedeli a default-okat helyes ACL-lel.
5. 2-tab smoke: A org workflow create/update → B org kliens Realtime subscribe-ján NEM jön WS payload.

---

## Publications Collection — Aktiválási mezők (Dashboard Redesign Fázis 3 + 5)

A Dashboard Redesign Fázis 3 keretében a `publications` collection három új mezőt kapott, amelyeket a Fázis 5 kötött be a teljes aktiválási rendszerbe.

| Mező | Típus | Default | Célja |
|------|-------|---------|-------|
| `workflowId` | string (36) | null | A publikációhoz rendelt workflow `$id`-je. Aktiválás után nem módosítható (Dashboard UI-oldali lock; szerver-oldali enforcement Fázis 6). |
| `isActivated` | boolean | `false` | A Plugin csak aktivált publikációkat lát (`DataContext.fetchData` + Realtime handler `Query.equal('isActivated', true)` szűrés). |
| `activatedAt` | datetime | null | Aktiválás időpontja (informatív). |

**Indexek**: `workflowId` (ASC), `isActivated` (ASC) — a Fázis 5-7 query-khez szükségesek.

**Guardok** (Fázis 5 állapot):
- **Aktiválás validáció**: `validate-publication-update` CF minden create/update eseménynél ellenőrzi, hogy az `isActivated === true` állapot konzisztens-e (workflowId kitöltve + deadline-ok teljes fedést adnak + nincs átfedés + formátum-helyes). Fail-closed: érvénytelen állapot → revert `isActivated: false, activatedAt: null`-re. Részletek a `validate-publication-update` leírásánál.
- **Plugin szűrés**: A Plugin `DataContext` kizárólag `isActivated === true` publikációkat kér le és iratkozik fel rájuk Realtime-on. Deaktiválás vagy törlés az aktív publikáción → a Plugin azonnal nullázza az `activePublicationId`-t és törli a derived state-et (articles/layouts/deadlines/validations).
- **Határidő szerkezet** (2026-04-20 update): aktivált publikáción is szerkeszthetők az oldalszám tartományok és a darabszám — a szerkesztőségi gyakorlat gyakran igényel utólagos finomhangolást (extra oldal, kibővített rész). A teljes fedés / átfedésmentesség a Dashboard `DeadlinesTab`-jében validálódik (figyelmeztető kártyák a `validateDeadlines()` eredménye alapján), csak nem blokkolja a mentést. A lefedetlen oldalak a Plugin oldalon placeholder sorként jelennek meg az `ArticleTable`-ben (ld. `pageGapUtils.buildPlaceholderRows()`).
- **Workflow lock**: Aktivált publikáción a Dashboard `GeneralTab` workflow dropdown `disabled` + tooltip. Szerver-oldali enforcement **Fázis 6** hatáskör (ott a cikkek létezése lesz a lock trigger — a valós threat model: futó workflow alatt ne lehessen workflow-t cserélni).

---

## Kapcsolat a Többi Csomaggal

```
maestro-server (functions)
    ↑ workflow config
    workflows collection (compiled JSON — a Dashboard Workflow Designer írja, Fázis 5+)
    ↑ olvassa
maestro-indesign (Plugin, read-only a workflows-ra)
maestro-dashboard (Dashboard, a designer UI fogja írni)
```

- A function-ök **nem importálnak** a monorepo többi csomagjából — teljesen önállóak
- A workflow config a `workflows` collection `compiled` JSON-jából származik — nincs fallback, fail-closed
- A Plugin és Dashboard a `workflowRuntime.js` (maestro-shared) helpereket használja, a CF-ek közvetlen JSON olvasást
