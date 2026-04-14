# Workflow Designer — Migrációs jegyzetek

> Régi (statikus) → új (dinamikus) megfeleltetési táblázatok.
> **Kapcsolódó**: [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), [COMPILED_SCHEMA.md](COMPILED_SCHEMA.md).

Ez a dokumentum segít eligazodni, ha a régi kódbázisból indulsz és meg szeretnéd találni az új megfelelőjét.

---

## Fájl → fájl megfeleltetés

| Régi fájl | Sors | Új hely / megjegyzés |
|-----------|------|----------------------|
| `packages/maestro-shared/workflowConfig.js` | **Törölve** | `workflows.compiled` (DB) + `workflowRuntime.js` helperek |
| `packages/maestro-shared/labelConfig.js` | **Törölve** | `workflows.compiled.capabilities` (exkluzív) és `workflows.compiled.leaderGroups` (csapat-ekvivalens) |
| `packages/maestro-indesign/src/core/utils/workflow/workflowConstants.js` | **Törölve** | `workflows.compiled` egyetlen igazságforrás |
| `packages/maestro-indesign/src/core/utils/workflow/elementPermissions.js` | **Törölve** | `workflows.compiled.elementPermissions` |
| `packages/maestro-indesign/src/core/utils/syncWorkflowConfig.js` | **Törölve** | Nincs szinkron szükség — a plugin read-only a workflows collectionre |
| `packages/maestro-indesign/src/core/utils/workflow/workflowEngine.js` | Átírva | Belépési pont marad, de minden hívás kap egy `workflow` (compiled JSON) paramétert |
| `packages/maestro-indesign/src/core/utils/workflow/workflowPermissions.js` | Átírva | `workflowRuntime.js` proxy |
| `packages/maestro-server/functions/article-update-guard/src/main.js` | Átírva | `config` collection helyett `workflows` dokumentum olvasása az article `editorialOfficeId`-ja alapján, 60s TTL cache |
| `packages/maestro-server/functions/validate-article-creation/src/main.js` | Átírva | Ugyanaz a pattern |
| `packages/maestro-server/functions/validate-publication-update/src/main.js` | Átírva | Ugyanaz a pattern |
| `packages/maestro-server/functions/validate-labels/src/main.js` | **Törölve** | A capability label rendszer eltűnik, a `compiled.capabilities` helyettesíti |
| **Új**: `packages/maestro-shared/workflowRuntime.js` | Létrehozandó | A `compiled` JSON fogyasztó helpereinek gyűjtőhelye |
| **Új**: `packages/maestro-shared/defaultWorkflow.json` | Létrehozandó | A jelenlegi 8 állapotos magazin workflow `compiled` formátumban — gyári template új office-nak |
| **Új**: `packages/maestro-shared/groups.js` | Létrehozandó | `getUserGroupSlugs(userId, officeId)` helper, `groups` + `groupMemberships` lookup |
| **Új**: `packages/maestro-shared/commandRegistry.js` | Létrehozandó | Command ID + label lista a dashboard designer számára |

---

## Konstans → új hely

| Régi konstans (fájl:név) | Új hely |
|--------------------------|---------|
| `workflowConfig.js:WORKFLOW_STATES` (integer enum 0–7) | `compiled.states[].id` (string, pl. `"designing"`) |
| `workflowConfig.js:STATUS_LABELS` | `compiled.states[].label` |
| `workflowConfig.js:STATUS_COLORS` | `compiled.states[].color` |
| `workflowConfig.js:STATE_DURATIONS` | `compiled.states[].duration` |
| `workflowConfig.js:TEAM_ARTICLE_FIELD` | **Törölve** — a contributor kulcs a csoport `slug`-ja az `articles.contributors` map-ben |
| `workflowConfig.js:MARKERS` | Változatlan, vagy áthelyezve `constants.js`-be |
| `labelConfig.js:CAPABILITY_LABELS` | `compiled.capabilities` (exkluzív capability-k) |
| `labelConfig.js:VALID_LABELS` | Nincs — a labelek eltűnnek |
| `labelConfig.js:resolveGrantedTeams()` | Nincs — a `user.groupSlugsByOffice` közvetlenül jön a `groupMemberships`-ből |
| `labelConfig.js:hasCapability()` | **Törölve** — dead code, nem volt kódbázis-szintű fogyasztója. A `compiled.capabilities` mező megmaradt, új fogyasztó közvetlenül olvashat belőle. |
| `workflowConstants.js:WORKFLOW_CONFIG` | `compiled.transitions` + `compiled.validations` + `compiled.commands` |
| `workflowConstants.js:STATE_PERMISSIONS` | `compiled.statePermissions` |
| `workflowConstants.js:VALID_TRANSITIONS` | `compiled.transitions` (a `from` → `to` párok listája) |
| `workflowConstants.js:buildWorkflowConfigDocument()` | **Törölve** — a compiler a dashboard-oldalon fut |
| `elementPermissions.js:ARTICLE_ELEMENT_PERMISSIONS` | `compiled.elementPermissions.article` |
| `elementPermissions.js:PUBLICATION_ELEMENT_PERMISSIONS` | `compiled.elementPermissions.publication` |
| `elementPermissions.js:LEADER_TEAMS` | `compiled.leaderGroups` |
| `elementPermissions.js:ANY_TEAM` szimbólum | `{ "type": "anyMember" }` a perm objektumban |
| `elementPermissions.js:checkElementPermission()` | `workflowRuntime.js:canEditElement(compiled, scope, key, userGroups)` |
| `elementPermissions.js:canUserAccessInState()` | `workflowRuntime.js:canUserAccessInState(compiled, userGroups, stateId)` |
| `elementPermissions.js:canEditContributorDropdown()` | `workflowRuntime.js:canEditContributorDropdown(compiled, groupSlug, userGroups, currentState)` |
| `appwriteIds.js:TEAMS` enum | **Törölve** — saját `groups` collection |
| `appwriteIds.js:GET_TEAM_MEMBERS_FUNCTION_ID` | **Törölve** vagy átnevezve `get-group-members`-re |
| `appwriteIds.js:CONFIG` collection ID | **Törölve** |

---

## Hardkódolt csapat → dinamikus csoport

A régi 7 fix Appwrite Team az új rendszerben ugyanazokkal a slug-okkal jelenik meg a `groups` collection-ben — de minden office saját példányt kap a default template-ből. A gyári [defaultWorkflow.json](../../packages/maestro-shared/defaultWorkflow.json) template ezt tükrözi:

| Régi Appwrite Team slug | Új `groups.slug` (office default) | `isLeaderGroup` | `isContributorGroup` |
|--------------------------|-----------------------------------|-----------------|----------------------|
| `designers` | `designers` | ❌ | ✅ |
| `editors` | `editors` | ❌ | ✅ |
| `writers` | `writers` | ❌ | ✅ |
| `image_editors` | `image_editors` | ❌ | ✅ |
| `art_directors` | `art_directors` | ✅ | ✅ |
| `managing_editors` | `managing_editors` | ✅ | ✅ |
| `proofwriters` | `proofwriters` | ❌ | ✅ |

Minden más office 0 csoporttal indul — az admin dönti el, mit hoz létre.

---

## DB mező → új hely

### `articles` collection

| Régi mező | Új hely |
|-----------|---------|
| `state: integer` (0–7) | `state: string` (pl. `"designing"`) |
| `previousState: integer` | `previousState: string` |
| `designerId: string` | `contributors: string (JSON)` → `{"designers": "<userId>"}` |
| `writerId: string` | `contributors.writers` |
| `editorId: string` | `contributors.editors` |
| `imageEditorId: string` | `contributors.image_editors` |
| `artDirectorId: string` | `contributors.art_directors` |
| `managingEditorId: string` | `contributors.managing_editors` |
| `proofwriterId: string` | `contributors.proofwriters` |
| — | **Új**: `organizationId: string`, `editorialOfficeId: string` |

### `publications` collection

| Régi mező | Új hely |
|-----------|---------|
| `defaultDesignerId: string` | `defaultContributors: string (JSON)` → `{"designers": "<userId>"}` |
| `defaultWriterId`, `defaultEditorId`, `defaultImageEditorId`, `defaultArtDirectorId`, `defaultManagingEditorId`, `defaultProofwriterId` | `defaultContributors.<slug>` |
| — | **Új**: `organizationId: string`, `editorialOfficeId: string` |

### `layouts`, `deadlines`, `uservalidations`, `validations`

Minden kap **új** `organizationId` + `editorialOfficeId` mezőt (denormalizált scope).

### `config` collection

**Törölve** — a `workflow_config` dokumentum megszűnik, a workflow helye a `workflows` collection office-onként.

---

## API hívás minta → új hívás minta

### Csapattagság ellenőrzés

**Régi**:
```js
const isDesigner = user.teamIds?.includes('designers');
// vagy label:
const isDesignerViaLabel = user.labels?.includes('canUseDesignerFeatures');
```

**Új**:
```js
import { userHasGroup } from '../utils/workflowRuntime';
const slugs = user.groupSlugsByOffice.get(activeOfficeId) ?? new Set();
const isDesigner = slugs.has('designers');
```

### Állapotátmenet jogosultság

**Régi**:
```js
import { canUserMoveArticle } from '../workflow/workflowPermissions';
const allowed = canUserMoveArticle(user, article, STATE_PERMISSIONS);
```

**Új**:
```js
import { canUserMoveArticle } from '@maestro/shared/workflowRuntime';
const { workflow } = useData();
const userGroups = user.groupSlugsByOffice.get(article.editorialOfficeId);
const allowed = canUserMoveArticle(workflow, userGroups, article.state);
```

### UI elem jogosultság

**Régi**:
```js
import { useElementPermission } from '../hooks/useElementPermission';
const perm = useElementPermission('articleName');
```

**Új**:
```js
// Ugyanaz az API, a hook belül olvassa a workflow-t a DataContextből
const perm = useElementPermission('articleName');
```

A `useElementPermission` belsejét átírjuk, de a komponens-oldali API nem változik. Ez csökkenti a csatolási felületet.

### Cloud Function workflow olvasás

**Régi** (pl. `article-update-guard`):
```js
const configDoc = await databases.getDocument(DATABASE_ID, CONFIG_COLLECTION, 'workflow_config');
const statePermissions = JSON.parse(configDoc.statePermissions);
```

**Új**:
```js
import { getWorkflowForOffice } from './workflowCache.js';
const workflow = await getWorkflowForOffice(article.editorialOfficeId);
// workflow.statePermissions már objektum, cache-elt, 60s TTL
```

---

## Terminológia

| Régi | Új |
|------|-----|
| Appwrite Team | `groups` collection rekord |
| „csapat slug" | „csoport slug" (ugyanaz a fogalom, más tároló) |
| `LEADER_TEAMS` | `compiled.leaderGroups` / `groups.isLeaderGroup: true` |
| „capability label" | „capability" (nincs label többé, csak a `compiled.capabilities` szótár) |
| „workflow config doc" (DB-ben) | `workflows.compiled` (per office) |
| `workflow_config` config collection dokumentum | `workflows` collection dokumentum |
| `FALLBACK_CONFIG` hardkódolt CF konstansok | **Nincs** — a CF fail-closed ha nincs workflow doc |
| „state integer 0–7" | „string stateId" |
| „TEAM_ARTICLE_FIELD lookup" | `articles.contributors[groupSlug]` direkt |

---

## Fázis-specifikus migrációs lépések

### Fázis 1
- A régi `config` collection és workflow hardkódolások **még maradnak** — csak scope mezők bevezetése + auth flow.
- `appwriteIds.js:TEAMS` enum **még megmarad** (B.2-ben `@deprecated` JSDoc-ot kapott — fizikai törlés Fázis 7-ben).
- **B.2 (2026-04-07)**: `appwriteIds.js` `COLLECTIONS` enumba bekerült az 5 új ID (`ORGANIZATIONS`, `ORGANIZATION_MEMBERSHIPS`, `EDITORIAL_OFFICES`, `EDITORIAL_OFFICE_MEMBERSHIPS`, `ORGANIZATION_INVITES`).
- **B.3 (2026-04-07)**: Dashboard router skeleton bevezetve (`react-router-dom@7`, `BrowserRouter`, `<Routes>`). 8 auth route fájl + `ProtectedRoute` + `AuthSplitLayout` + `BrandHero` + `DashboardLayout` + `ScopeContext`. Csak a `LoginRoute` aktív, a többi 6 placeholder (B.4-ben implementálva). A meglévő [packages/maestro-dashboard/src/components/LoginView.jsx](packages/maestro-dashboard/src/components/LoginView.jsx) **deprecated, nem hivatkozott** — B.10 manual happy path után törölhető.
- **B.4 (2026-04-07)**: Dashboard auth flow implementálva. `AuthContext.jsx` bővítés (`organizations`/`editorialOffices` state, `fetchMemberships`, `register`, `verifyEmail`, `requestRecovery`, `confirmRecovery`, `updatePassword`, `reloadMemberships`). 5 auth route élesedik (`RegisterRoute`, `VerifyRoute`, `ForgotPasswordRoute`, `ResetPasswordRoute`, `LoginRoute` tab nav + success bannerek), `OnboardingRoute` és `InviteRoute` placeholder finomítás (kijelentkezés gomb, ill. token mentés + redirect) — a tényleges 4-collection write és `acceptInvite()` flow B.5-ben jön a guard CF-fel együtt. A `ProtectedRoute` megkapta az `organizations.length === 0 → /onboarding` redirectet. CSS class-ok: `.auth-tabs`, `.auth-tab`, `.auth-success`, `.auth-success-large`, `.auth-help`, `.auth-info`, `.auth-bottom-link`, `.auth-link`, `.form-row-end`. A régi `LoginView.jsx` **továbbra is deprecated, nem hivatkozott** — B.10 után törölhető.
- **B.4 adversarial review fix-ek (2026-04-07)**: a `/codex:adversarial-review` 3 problémát jelzett, mind javítva.
  1. **`membershipsError` állapot szétválasztás (high)**: a `fetchMemberships()` többé NEM nyel le hibát — új `loadAndSetMemberships(userId)` helper külön `membershipsError` state-be teszi az átmeneti backend hibákat. A `ProtectedRoute` `!user` után új ágat kapott: `membershipsError` esetén retry képernyő (`reloadMemberships()` + kijelentkezés), nem onboarding redirect. Egy átmeneti 5xx többé nem zárja ki a meglévő tenantot.
  2. **`register()` partícionált rollback (high)**: a `register()` partícionált try/catch-ekkel működik. Ha a verifikációs e-mail küldés a fiók létrehozása UTÁN szárll el, `verification_send_failed` kódú wrapped `Error` dobódik. Új `resendVerification(email, password)` metódus. A `RegisterRoute` `phase` state-tel (`'idle'` | `'success'` | `'verification_failed'`) kezeli a partial-success ágat: külön „Fiók létrehozva" képernyő + „Verifikációs e-mail újraküldése" gomb. A user nem reked az „account already exists" zsákutcában.
  3. **`ForgotPasswordRoute` hiba-szűrés szűkítés (medium)**: csak a `type === 'user_not_found'` maszkolódik success-ként (anti-enumeration). Rate limit / invalid argument / network / általános hiba látható error állapotot kap, hogy a user retry-olhasson és az ops észlelje az outage-et. `console.warn` az ismeretlen ágon.
  - Új CSS class: `.auth-link-button` — button styled as auth-link a `ProtectedRoute` retry képernyőhöz.
  - Build verifikáció: 530ms, hibamentes, 348.52 kB JS / 104.71 kB gzip.

### Fázis 2
- Új `groups` + `groupMemberships` collection.
- A régi 7 Appwrite Team megkapja a megfelelő `groups` rekordokat minden létező office-hoz.
- `UserContext.groupSlugsByOffice` bevezetve, a jogosultsági döntések ide váltanak.
- A régi `user.teamIds` és `user.labels` még olvasva, de nem használva a guardokban.

### Fázis 3
- `articles.contributors` JSON bevezetve, a 7 régi `*Id` oszlop eltávolítva.
- `ContributorsSection` dinamikus loop.
- `TEAM_ARTICLE_FIELD` törölve.

### Fázis 4
- `workflows` collection + `defaultWorkflow.json` template.
- `workflowRuntime.js` helperek.
- A fenti **Törölve** fájlok ténylegesen törlődnek.
- CF-ek átírva, `FALLBACK_CONFIG` kitörölve.

### Fázis 7 (cleanup)
- `appwriteIds.js:TEAMS` enum törlése.
- Régi 7 Appwrite Team manuális törlése az Appwrite Console-ban.
- `validate-labels` Cloud Function törlése.
- `getTeamMembers` → `get-group-members` átnevezés vagy törlés.
- `grep` ellenőrzés: 0 találat a régi konstans nevekre.
