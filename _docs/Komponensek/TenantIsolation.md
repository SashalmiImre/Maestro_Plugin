---
tags: [komponens, biztonság, tenant, acl]
status: stable
date: 2026-05-12
related:
  - "[[SecurityBaseline]]"
  - "[[SecurityRiskRegister]]"
  - "[[Döntések/0003-tenant-team-acl]]"
  - "[[Döntések/0014-tenant-doc-acl-with-creator]]"
  - "[[Komponensek/Permissions]]"
---

> **ADR-szintű döntés**: a `withCreator` defense-in-depth minta + 3-réteges ACL [[Döntések/0014-tenant-doc-acl-with-creator|ADR 0014]]-ben rögzítve (Codex Harden P8 GO 2026-05-12). Ez a jegyzet a komponens-szintű aktuális implementáció + 8 fix tábla; az ADR a tradeoff-okat + alternatívákat rögzíti.


# Tenant Isolation

Multi-tenant adatszivárgás védelem rétegei az Appwrite-szintű ACL + Realtime push szűrésen keresztül. S blokk S.7 al-blokk része.

## Védelmi rétegek (defense-in-depth)

### 1. réteg — collection `documentSecurity: true` flag

A `documentSecurity: true` (Appwrite UI-ban "row security") **bekapcsolja** a doc-szintű ACL érvényesítését. Nélküle a collection-szintű `read("users")` permission MINDEN authentikált user-nek olvasási jogot ad, **felülírva** a doc-szintű ACL-eket.

A flag a `createCollection()` 5. paramétere (`databases.createCollection(dbId, colId, name, perms, documentSecurity, enabled)`):
- `permissionSets`, `groupPermissionSets`, `workflowExtensions`, `organizationInviteHistory` — `documentSecurity: true` (CF-action-ek)
- `ipRateLimitCounters`, `ipRateLimitBlocks` — `documentSecurity: false` (csak server-side runtime, OK)
- **MANUAL (Console-on létrehozott)**: `articles`, `publications`, `organizationMemberships`, `editorialOfficeMemberships`, `groupMemberships`, `organizations`, `editorialOffices`, `groups` — flag status manuális verify-szükséges éles deploy előtt.

### 2. réteg — doc-szintű `Permission.read(Team)` ACL

A `createDocument()` 5. paramétere doc-szintű ACL-eket fogad. A `documentSecurity: true` melletti `read("team:org_${orgId}")`-mintán a server szűri a Realtime push-t és a REST `listDocuments` eredményt.

Team-pattern konvenciók (`teamHelpers.js`):
| Helper | Team pattern | Használat |
|---|---|---|
| `buildOrgAclPerms(orgId)` | `team:org_${orgId}` | `organizations`, `organizationMemberships`, `editorialOffices` (admin UI listáz minden office-t) |
| `buildOrgAdminAclPerms(orgId)` | `team:org_${orgId}_admins` | `organizationInvites`, `organizationInviteHistory` (Q1 ACL E blokk — csak owner+admin) |
| `buildOfficeAclPerms(officeId)` | `team:office_${officeId}` | `editorialOfficeMemberships`, `publications`, `groups`, `groupMemberships`, `permissionSets`, `groupPermissionSets` |
| `buildWorkflowAclPerms(visibility, orgId, officeId)` | 3-way: `public` / `org` / `office` | `workflows` (a `visibility` mező dönti el a scope-ot) |
| `buildExtensionAclPerms(...)` | mint workflow | `workflowExtensions` |

### 3. réteg — `withCreator(perms, callerId)` defense-in-depth

**Probléma**: a `bootstrap_organization` és `acceptOrganizationInvite` action-ök a doc-ot a `createDocument` 5. paraméterén át team-szintű ACL-lel `read(team:org_${orgId})` látják el. A creator (vagy meghívott elfogadó) a `createDocument` időpontban MÉG NEM team-tag — az `ensureTeamMembership` vagy a team létrehozása csak később fut. Emiatt a creator a saját doc-ját NEM látja, amíg a team-tagság lefut.

**Megoldás** (`teamHelpers.js`):

```js
function withCreator(perms, callerId) {
    if (!callerId || typeof callerId !== 'string') {
        throw new Error('withCreator: callerId required (non-empty string)');
    }
    return [...perms, sdk.Permission.read(sdk.Role.user(callerId))];
}
```

A `Permission.read(user(callerId))` Role azonnal hat (independent of team-membership timing), így a creator a doc-ot rögtön látja. A team-szintű read a többi tagra továbbra is alkalmazódik (redundáns de korrekt).

## S.7.1 fix-csomag (2026-05-12)

8 `createDocument` hívás-fix az `invite-to-organization` CF-ben — korábban üres permission-paraméter → collection-szintű `read("users")` örökölt → cross-tenant Realtime push szivárgás.

| # | File / sor | Collection | ACL applikálva | Indok |
|---|---|---|---|---|
| 1 | `orgs.js:180` | organizations | `withCreator(buildOrgAclPerms(newOrgId), callerId)` | Org-team-tagság (creator azonnal lát) |
| 2 | `orgs.js:222` | organizationMemberships (owner) | `withCreator(buildOrgAclPerms(newOrgId), callerId)` | Self-membership azonnal |
| 3 | `orgs.js:308` | editorialOffices | `withCreator(buildOrgAclPerms(newOrgId), callerId)` | **Org-scope** (NEM office) — admin UI office-listáz |
| 4 | `orgs.js:351` | editorialOfficeMemberships | `withCreator(buildOfficeAclPerms(newOfficeId), callerId)` | Office-tag-listát csak office-tagok |
| 5 | `offices.js:377` | editorialOffices (create_editorial_office) | `withCreator(buildOrgAclPerms(orgId), callerId)` | Mint #3 |
| 6 | `offices.js:420` | editorialOfficeMemberships | `withCreator(buildOfficeAclPerms(newOfficeId), callerId)` | Mint #4 |
| 7 | `invites.js:1011` | organizationMemberships (acceptInvite) | `withCreator(buildOrgAclPerms(invite.organizationId), callerId)` | Meghívott self-membership azonnal |
| 8 | `publications.js:173` | publications | `withCreator(buildOfficeAclPerms(officeId), callerId)` | Office-scope publication |

**Mellékes változás**: a `organizations` és `editorialOffices` (a `bootstrap_organization` action-ben) `let newOrgId = sdk.ID.unique();` és `let newOfficeId = sdk.ID.unique();` ELŐRE generálják az ID-t (mert a `buildOrgAclPerms(newOrgId)` paraméter a `createDocument` 5. argumentumában kell). Atomikus, nincs új state-flow.

## Codex pipeline (3 iteráció, CLEAN)

| Iteráció | Eredmény | Lényeges fix |
|---|---|---|
| **Pre-review** | Q1.D **GO** (code-audit első, adversarial később); Q3 CONCERN (backfill kell legacy doc-okra); 3 BLOCKER + 2 MAJOR (terv) | Sorrend: invariáns fix → backfill → adversarial |
| **Stop-time** (8-fix iter 1) | 2 MAJOR (`bootstrap` creator race + `acceptInvite` creator race) + 1 MINOR (legacy doc) + 1 NIT | Új `withCreator` helper + mind a 8 helyen alkalmazva |
| **Verifying** (8-fix iter 2) | **CLEAN** + 1 MINOR (legacy backfill open) + 1 NIT (`callerId` guard) | NIT fixed: `if (!callerId) throw` |

## Backfill action (S.7.2, Done 2026-05-12)

A `document_already_exists` race-fallback ágon (`orgs.js:189-194`, `invites.js:1024+`, `offices.js:391-397`) a legacy doc permissions értéke ismeretlen. A S.7.1 fix-ek csak a friss `createDocument` hívásokra hatnak. Az S.7.2 új CF action retroaktívan korrigálja a legacy üres-permission doc-okat:

**Action**: `backfill_acl_phase2` (a `actions/schemas.js`-ben, R.S.7.2 close).

**Scope** (5 collection, S.7.1 fix-csomag tükörképe):

| # | Collection | Apply ACL |
|---|---|---|
| 1 | `organizations[targetOrgId]` | `buildOrgAclPerms(targetOrgId)` |
| 2 | `organizationMemberships` (target org) | `buildOrgAclPerms(targetOrgId)` |
| 3 | `editorialOffices` (target org) | `buildOrgAclPerms(targetOrgId)` — ORG-scope, mint S.7.1 fix #3 |
| 4 | `editorialOfficeMemberships` (per office) | `buildOfficeAclPerms(office.$id)` |
| 5 | `publications` (per office) | `buildOfficeAclPerms(office.$id)` |

**Payload**:
```json
{
  "action": "backfill_acl_phase2",
  "organizationId": "string",
  "dryRun": false,
  "scope": "all" | "organizations" | "organizationMemberships" | "editorialOffices" | "editorialOfficeMemberships" | "publications"
}
```

**Auth**: target org `owner` role (NEM `requireOwnerAnywhere`, mint `backfillTenantAcl` / `backfillAdminTeamAcl`). Orphaned org-on a `transfer_orphaned_org_ownership` recovery flow után jut owner-hez a caller → onnantól futtatható.

**user-read preserve** (ADR 0014 defense-in-depth): a backfill regex-szel (`/^read\("user:/`) átemeli a meglévő `read("user:X")` perm-eket. Friss S.7.1 doc-ok `read(user(creatorId))` perm-je megmarad; legacy doc-ok csak team-perm-et kapnak. `Role.user(id, status)` formát is preserve-eli (Codex verifying review confirmed).

**Stats**:
- `wouldRewrite` (dryRun esetén) vs `rewritten` (non-dry esetén) szétválasztva — különben félreérthető (dryRun NEM rewrite).
- `partialFailure: true` flag ha `errors.length > 0` — automatizált futtatók így megkülönböztetik a teljes-sikertől.
- Audit log: `caller=X org=Y scope=Z dryRun=W errors=N partial=B counts={...}` JSON.

**Scope paraméter indoka**: a CF 60s timeout-ja egy nagy orgon (100+ office × 50+ pub) szétesne single-pass-ban. Az admin többször futtathatja collection-enként.

**Hibakezelés**: per-doc try/catch → `errors[]`-be sorolva, flow folytatódik. Idempotens overwrite (mint `backfillTenantAcl`) — egy második futtatás zaj-mentes (azonos perms, csak `$updatedAt` mozdul).

**Codex pipeline** (3 iteráció):

| Iteráció | Eredmény | Lényeges fix |
|---|---|---|
| **Pre-review** | Q1 NO-GO drop user-read; Q3 NO-GO single-pass; Q4/Q5 GO | user-read preserve + scope-param |
| **Stop-time** | **GO** (0 BLOCKER, 0 MAJOR, 1 MINOR idempotens-write dokumentált tradeoff, 1 NIT typo) | `késöbb→később` |
| **Verifying** | **CLEAN GO** (regex preserve `Role.user(id, status)` formát is, drift-integritás OK) | — |

**Deploy státusz**: kódoldalon **kész** (2026-05-12, Harden pass 2026-05-13 után). Production deploy halasztva — user-trigger (`appwrite deploy function`). A backfill futtatás minden orgon `dryRun: true` → éles módon, admin UI-ról vagy `appwrite functions createExecution`-nel.

**Nyitott kockázat marad** (R.S.7.4 + R.S.7.5 — különálló S.7.x al-pontok, lásd ADR 0014 + Feladatok.md).

### Operations runbook (S.7.2 deploy)

**Default happy-path**: `scope: 'all'` + `dryRun: true` előzetes ellenőrzés → ha a `wouldRewrite` counts elfogadhatóak (nincs unexpected null vagy errorCount > 0) → `dryRun: false` éles futtatás.

**Kötelező sorrend** (ha `scope: 'all'` timeout-ban hal CF 60s default-on, vagy szándékos részleteben futtatás):

1. `scope: 'organizations'` — 1 doc (mindig gyors)
2. `scope: 'organizationMemberships'` — N tag
3. `scope: 'editorialOffices'` — N iroda
4. `scope: 'editorialOfficeMemberships'` — N iroda-tagság
5. `scope: 'publications'` — N publikáció (legtöbb doc, leghosszabb)

Mindegyik scope külön CF-call. A jövőbeli admin-UI gomb (`S.7.12` Feladatok.md, alacsony prio) automatizálhatja a teljes szekvenciát. Jelenleg shell-script / curl / Appwrite Console "Execute function" panel.

**Off-peak window (deploy ajánlás)**: Magyar éjszaka **23:00–05:00 UTC+1**, **vasárnap éjszaka preferred** (legalacsonyabb connected kliens-szám). Az `updateDocument` 1000+ Realtime push triggert generál; a kliens-szintű 300ms debounce ([[dashboard tenant Realtime memo, MEMORY 2026-04-18]]) tolerálja, de off-peak window minimalizálja az UX-zavart.

**Worldwide deploy follow-up**: a jelenlegi piac magyar — bővítéskor az off-peak ablak per-tenant timezone-szerű vagy globális "weekend low-traffic" mintával frissítendő. Roadmap: `S.7.13` (Feladatok.md, post-S.7.7+S.7.9).

### Design-Q decisions (2026-05-13, Harden Phase 7)

A Harden Phase 7 prezentált 4 design-Q-ra a user-döntések:

| Q | Téma | Döntés | Indok / Roadmap |
|---|---|---|---|
| Q1 | Stale `read("user:X")` cleanup vs. anonymize | **B — külön `anonymize_user_acl` action** | 1 felelősség per action, eltérő cadence (backfill 1×, cleanup havonta/évente). Roadmap: `S.7.9` (R.S.7.5 close) |
| Q2 | Részleges backfill admin-felejt | **B (runbook) most + C (admin-UI gomb) halasztva** | Ritka művelet, shell/curl is OK. C csak ha tényleges admin-flow használja. Roadmap: `S.7.12` (LOW prio) |
| Q3 | Partial-state CF timeout | **B + C (idempotens újrafuttatás + 2. réteg server-side guard véd)** | Default minta, semmi kódváltozás. A `permissions.js` slug-guard kiegészíti az ACL-szintű enforcement-et. Acceptable risk |
| Q4 | Realtime push flood | **B + C (meglévő 300ms debounce + off-peak runbook)** | Kliens-szintű debounce már él. Worldwide deploy később frissítendő (`S.7.13`) |

## S.7.7 frontend ACL fix (2026-05-14, R.S.7.3 close)

A frontend (plugin + dashboard) **direkt írja** az Appwrite-ot 7 helyen — a S.7.7 fix-csomag mind a 7 helyen `withCreator(buildOfficeAclPerms(officeId), userId)`-mintán épít doc-szintű ACL-t (ADR 0014 3. réteg, defense-in-depth). Új helper-fájl mindkét csomagban (`teamHelpers.client.js`).

### Új shared helper-fájl (ESM, web `appwrite` SDK)

- `packages/maestro-shared/teamHelpers.client.js` (kanonikus single-source, 2026-05-14 refactor)

API IDENTIKUS a server-side `teamHelpers.js`-rel (azonos nevek, azonos fail-closed viselkedés). A `maestro-shared/package.json`-ban `appwrite` mint `peerDependency` (`^24.1.1`) — mind a plugin, mind a dashboard amúgy is bundle-be hozza, így a peer-dep nem okoz duplikációt. A CF (`node-appwrite`) NEM importálja ezt a modult — server-side külön `teamHelpers.js` él.

**Refactor history (2026-05-14)**: az S.7.7 elsőként **két különálló** helper-fájllal indult (plugin + dashboard, Codex pre-review Q1 GO A), de stop-time után összevontuk a `maestro-shared`-be (Codex GO "B is reasonable later"). Indok: a két helper diff-je 1 sor volt (header `@description` szöveg), DRY-win + drift-kockázat megszűnik + jövőbeli új tenant-érintő frontend `createX` hívás 1 modulból importál → ADR 0014 invariáns 1 helyen ellenőrizhető. Importálás mindkét csomagban: `import { buildOfficeAclPerms, withCreator } from 'maestro-shared/teamHelpers.client.js'`.

### 7 fix-hívóhely

| # | Csomag | Fájl / sor | Hívás | Collection | ACL applikálva |
|---|---|---|---|---|---|
| 1 | Plugin | `core/contexts/DataContext.jsx` (`createArticle`) | `tables.createRow` | `articles` | `withCreator(buildOfficeAclPerms(officeId), userId)` |
| 2 | Plugin | `core/contexts/DataContext.jsx` (`createValidation`) | `tables.createRow` | `userValidations` | mint #1 |
| 3 | Plugin | `data/hooks/useOverlapValidation.js` (`persistStructureValidation`) | `tables.createRow` | `systemValidations` | mint #1 |
| 4 | Plugin | `data/hooks/useWorkflowValidation.js` (`persistToDatabase`) | `tables.createRow` | `systemValidations` | mint #1 |
| 5 | Dashboard | `contexts/DataContext.jsx` (`createPublication`) | `databases.createDocument` | `publications` | mint #1 |
| 6 | Dashboard | `contexts/DataContext.jsx` (`createLayout`) | `databases.createDocument` | `layouts` | mint #1 |
| 7 | Dashboard | `contexts/DataContext.jsx` (`createDeadline`) | `databases.createDocument` | `deadlines` | mint #1 |

### Belső helper: `buildTenantDocOptions(data)` (mindkét DataContext)

A DataContext-en belüli helper: egyetlen snapshot a callback elején — orgId + officeId + userId egyhelyben olvasva, fail-closed throw bármelyik hiányzásra. Output `{data: scopedData, permissions: [Permission.read(team:office_X), Permission.read(user(creatorId))]}`. A két writer-callback (`tables.createRow` / `databases.createDocument`) ugyanazt az officeId-t használja a data injection-höz és a perm-buildhez → **interleaving race-mentes** (Codex MAJOR S.7.7 absorb).

A 2 validation hookban (`useOverlapValidation`, `useWorkflowValidation`) **silent log+skip** mintán a `persistToDatabase` callback elején, mert ezek fire-and-forget background flow-k — egy throw a `pageRangesChanged` event-handlerből UX-szintű kárt okozna. `logError` emitti a skipping-eseményt.

### Codex pipeline

| Iteráció | Eredmény | Lényeges fix |
|---|---|---|
| Pre-review | 5×GO (Q1 helper-distribution A, Q2 separate S.7.7b, Q3 internal hooks A, Q4 withCreator mandate A, Q5 no test infra) | Design GO |
| Stop-time | **NO-GO**: 2 BLOCKER (deploy-prerequisite) + 1 MAJOR + 1 MINOR | (a) `useAuth() ?? {}` → explicit `if (!authValue) throw` — javítva |
| Verifying | TBD | — |

### Deploy-blokkolók (Codex stop-time BLOCKER 1+2 → új al-pontok)

- **S.7.7b** ([[Feladatok#S.7.7b]], R.S.7.6): `documentSecurity: true` flag verify a 6 érintett collection-en (`articles`, `publications`, `layouts`, `deadlines`, `userValidations`, `systemValidations`). ADR 0014 Layer 1 prerequisite. **Nem fizikai close** ezen al-pont nélkül.
- **S.7.7c** ([[Feladatok#S.7.7c]], R.S.7.7): legacy backfill action a 6 collection-re — a S.7.2 NEM fedte ezt le. Új `backfill_acl_phase3` vagy `backfill_acl_phase2` bővítés. **Nem fizikai close** ezen al-pont nélkül.

### S.7.5 adversarial verifikáció

A 2-tab cross-org adversarial teszt ([[Feladatok#S.7.5]]) most a 6 user-data collection-re is kiterjed (Realtime push + REST `listDocuments` egyaránt). Ez zárja le a Codex MINOR (Realtime smoke gap)-et.

## S.7.7b `verify_collection_document_security` action (2026-05-15, R.S.7.6 close code-only)

Új CF action az `invite-to-organization` CF-ben — programatikus deploy-gate a S.7.7 frontend ACL fix Layer 1 prerequisite (`documentSecurity: true` flag) verify-jére a 6 user-data collection-en. Read-only `databases.getCollection` lookup, nincs mutation.

### Architektúra

| Modul | Cél |
|---|---|
| `helpers/collectionMetadata.js` (új, ~210 sor) | REQUIRED + OPTIONAL diagnostic whitelist alias-tömb + `Object.freeze` immutable konstans-tábla + `findUnknownAliases` (strict whitelist reject) + `resolveCollectionId` (env-var → collection ID, `missingEnv` flag) + `verifyDocumentSecurity` (paralel `databases.getCollection` lookup, determinisztikus output rendezés) |
| `actions/schemas.js` | `verifyCollectionDocumentSecurity(ctx)` action handler + import + export |
| `helpers/util.js` | `'verify_collection_document_security'` a `VALID_ACTIONS` set-be |
| `main.js` | 4 új opcionális env var (`LAYOUTS_COLLECTION_ID`, `DEADLINES_COLLECTION_ID`, `USER_VALIDATIONS_COLLECTION_ID`, `SYSTEM_VALIDATIONS_COLLECTION_ID`) + ACTION_HANDLERS bejegyzés |

### Whitelist alias-tábla

**REQUIRED set** (6 user-data collection — `criticalFail` scope):

| Alias | Env var | Env key |
|---|---|---|
| `articles` | `ARTICLES_COLLECTION_ID` | `articlesCollectionId` |
| `publications` | `PUBLICATIONS_COLLECTION_ID` | `publicationsCollectionId` |
| `layouts` | `LAYOUTS_COLLECTION_ID` | `layoutsCollectionId` |
| `deadlines` | `DEADLINES_COLLECTION_ID` | `deadlinesCollectionId` |
| `userValidations` | `USER_VALIDATIONS_COLLECTION_ID` | `userValidationsCollectionId` |
| `systemValidations` | `SYSTEM_VALIDATIONS_COLLECTION_ID` | `systemValidationsCollectionId` |

**OPTIONAL diagnostic set** (drift-monitoring, NEM blokkol deploy-t):

| Alias | Env var |
|---|---|
| `organizations` | `ORGANIZATIONS_COLLECTION_ID` |
| `organizationMemberships` | `ORGANIZATION_MEMBERSHIPS_COLLECTION_ID` |
| `editorialOffices` | `EDITORIAL_OFFICES_COLLECTION_ID` |
| `editorialOfficeMemberships` | `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID` |
| `groups` | `GROUPS_COLLECTION_ID` |
| `groupMemberships` | `GROUP_MEMBERSHIPS_COLLECTION_ID` |

### Payload + Auth

**Payload**:
```json
{
  "action": "verify_collection_document_security",
  "organizationId": "<orgId>",
  "collections": ["organizationMemberships"]   // OPCIONÁLIS — ADDITIVE
}
```

A `collections` paraméter **ADDITIVE** (Harden Phase 2 adversarial HIGH fix, 2026-05-15): a REQUIRED-set MINDIG benne, a caller-passed alias-ok csak APPEND-elnek (optional diagnostic). NEM tud subset-re csökkenteni — ezzel kizárt a "false-pass deploy-gate" támadási vektor (`collections: ['articles']`-szel kerülő `criticalFail: false`).

**Auth**: target org `owner` (`requireOrgOwner(ctx, targetOrgId)`). NEM mert org-specific doc-ot olvas (csak collection meta), hanem mert (1) az action collection enum-állapotot exponál, (2) audit-trail (`who-checked-what`), (3) ASVS V4.1.1 least privilege baseline. Codex Q2 GO.

### Output

```json
{
  "success": true,
  "action": "verified_collection_document_security",
  "results": [
    {
      "alias": "articles",
      "collectionId": "articles",
      "envVar": "ARTICLES_COLLECTION_ID",
      "missingEnv": false,
      "exists": true,
      "documentSecurity": true,
      "enabled": true,
      "name": "Articles",
      "error": null
    },
    {
      "alias": "publications",
      "collectionId": "publications",
      "envVar": "PUBLICATIONS_COLLECTION_ID",
      "missingEnv": false,
      "exists": true,
      "documentSecurity": false,    // ← Layer 1 FAIL
      "enabled": true,
      "name": "Publications",
      "error": null
    }
  ],
  "summary": {
    "total": 6,
    "secured": 5,
    "unsecured": 1,
    "missingEnv": 0,
    "missingCollection": 0,
    "errors": 0
  },
  "criticalFail": true
}
```

### `criticalFail` szemantika (Codex BLOCKER fix)

`criticalFail: true` ha BÁRMELY REQUIRED collection bármelyik kifogást ad:
- `missingEnv: true` (CF env var hiányzik — konfiguráció-failure)
- `error` truthy (SDK lookup-failure — perm denied, network, 5xx; explicit Codex MAJOR fix az olvashatóságért)
- `!exists` (collection NEM létezik Appwrite-on — 404)
- `documentSecurity !== true` (a flag NEM be van kapcsolva — Layer 1 fail)

Optional diagnostic collection drift `criticalFail`-ből KIMARAD — csak `summary` jelez. Deploy-gate-en a script `criticalFail`-re bail-elhet.

A `summary.missingCollection` count a 404-es lookup-failure-t is felöleli (Harden Phase 1 baseline P2 fix, 2026-05-15): ha az `err.code === 404` vagy `err.type === 'collection_not_found'`, akkor `missingCollection++`, NEM `errors++`. Egy delete-elt vagy elgépelt collection ID a deploy-gate diagnostikai üzenetében a "configured collection ID does not exist" kategóriát kap; az `errors` count a generic perm-denied / network / 5xx hibákra marad.

### Codex pipeline + Harden pass

| Iteráció | Eredmény | Lényeges fix |
|---|---|---|
| **Pre-review** | 5×GO Q2-Q7 + 1 NEEDS-WORK Q1 + 1 BLOCKER + 2 MAJOR + 1 MINOR + 1 NIT | (1) default scope hardcoded canonical 6 REQUIRED; (2) `criticalFail` csak required-set; (3) whitelist strict reject unknown aliases; (4) missingEnv külön hibakód-osztály lookup-failure-től; (5) paralel + determinisztikus rendezés |
| **Stop-time** | **GO** 0 BLOCKER + 1 MAJOR (`r.error` explicit a `criticalFail` feltételben) + 1 MINOR (rate-limit defer) + 1 NIT (Map freeze N/A) | `r.error` hozzáadva olvashatóságért |
| **Verifying** | **GO CLEAN** C1+C2+C3 | — |
| **Harden baseline** | 1 P2 (`summary.missingCollection` 404 misclassification) | 404 SDK lookup-failure dedicated `missingCollection++` ág a summary loop-ban |
| **Harden adversarial** | 1 HIGH (caller scope-bypass) | `collections` paraméter **ADDITIVE** — REQUIRED-set MINDIG benne, caller-passed csak APPEND. Üres `collections: []` is OK (omitted-egyenértékű). |

### Deploy steps (user-trigger, halasztott)

1. **CF redeploy**: `invite-to-organization` Appwrite Function új deployment.
2. **4 új CF env var** Appwrite Console → Function → Variables:
   - `LAYOUTS_COLLECTION_ID=layouts`
   - `DEADLINES_COLLECTION_ID=deadlines`
   - `USER_VALIDATIONS_COLLECTION_ID=userValidations`
   - `SYSTEM_VALIDATIONS_COLLECTION_ID=systemValidations`
3. **Verify minden orgon**: `appwrite functions createExecution` payload-szal `{action: 'verify_collection_document_security', organizationId: '<X>'}`.
4. **Ha `criticalFail: true`**: az érintett collection-eken Appwrite Console → Database → Collection → Settings → "Document Security" toggle bekapcsolása + ismételt verify.
5. **`criticalFail: false`** mind az éles orgokon → **S.7.7c** (legacy backfill) deploy mehet.

## S.7.7c `backfill_acl_phase3` action (2026-05-15, R.S.7.7 close code-only)

Új CF action a S.7.7 fix ELŐTT létrejött legacy doc-ok retroaktív ACL korrekciójára a 6 user-data collection-en. A S.7.7 fix CSAK a friss `createRow`/`createDocument` hívásokra ad doc-szintű ACL-t — a legacy doc-ok üres permissions-szal hagyatkoznak a collection-fallback-ra → cross-tenant read("users") szivárgás. A `backfill_acl_phase3` retroaktívan `updateDocument(..., perms)`-szel helyes team-perm-et ad.

### Architektúra

| Modul | Cél |
|---|---|
| `actions/schemas.js` (~470 sor új) | `backfillAclPhase3(ctx)` handler — payload validation + `requireOrgOwner` + pre-load Map-ek + office team-ensure + per-doc kategória 1/2 fallback + scope-onkénti scan + audit log |
| `helpers/util.js` | Új export `preserveUserReadPermissions` (Harden Reuse #1: phase2+phase3 közös, ADR 0014 single-source) |
| `teamHelpers.js` | `withCreator` import (kategória-1 ACL build-hez) |
| `helpers/collectionMetadata.js` | `REQUIRED_SECURED_COLLECTIONS` reuse (S.7.7b single-source) |

### Office-resolution mátrix

| Alias | Resolution | Pre-load |
|---|---|---|
| `publications` | direkt `editorialOfficeId` mező | `pubOfficeMap` (Map<pubId, officeId>) |
| `articles`/`layouts`/`deadlines` | `publicationId` → pubOfficeMap | `pubOfficeMap` |
| `userValidations`/`systemValidations` | `articleId` → `artPubMap` → `pubOfficeMap` (2-step JOIN) | `artPubMap` (Map<articleId, pubId>) + `pubOfficeMap` |

A validation collection-ök NEM tárolnak `organizationId`-t (frontend `useOverlapValidation`/`useWorkflowValidation` hookok csak `articleId`/`publicationId`/`source` + permissions-t írnak) — ezért `Query.equal('articleId', batch)` BATCH-szel scan-elünk (BATCH=25, Verifying P1 fix).

### Fallback policy (4-reason enum)

| Kategória | Feltétel | Apply ACL | `fallbackReason` |
|---|---|---|---|
| 1 | `createdBy` valid + Auth user létezik | `withCreator(buildOfficeAclPerms(office.$id), createdBy)` | — |
| 2 | `createdBy` undefined/null | `buildOfficeAclPerms(office.$id)` | `createdBy_missing` |
| 2 | `createdBy` invalid (nem-string / üres / whitespace) | mint fent | `createdBy_invalid` |
| 2 | `createdBy` valid + Auth user 404 | mint fent | `auth_user_not_found` |
| 2 | `createdBy` valid + transient SDK-hiba | mint fent | `auth_lookup_failed_transient` |

ASVS V4.1.3 + ownership enforcement: kategória-2-ben NINCS user-read inference (NE inferáljunk `modifiedBy`-ból vagy más mezőből arbitrary usert).

### Biztonsági guardok (Harden Phase 1+2)

| Guard | Cél | Fail-mode |
|---|---|---|
| `validOfficesForTargetOrg` Set (Harden adversarial HIGH) | Cross-tenant `editorialOfficeId` attack vector — egy korrupt vagy malicious pub-doc office-B (másik org) ID-re mutathat → backfill office_B perm-eket adna | `kind: 'cross_org_office_violation'` recordError + skip (ACL NEM íródik) |
| `failedOfficeTeams` Set (Harden baseline P1) | `ensureTeam(office_X)` failure → NE írjunk `read(team:office_X)` perm-et nem-létező team-re (lockout-prevent) | `kind: 'office_team_unavailable'` recordError + skipped++ |
| `Set` dedupe a `newPerms`-en (Verifying P2) | Duplikált `read("user:X")` perm `updateDocument` reject — idempotens re-run break | `Array.from(new Set(...))` build a `updateDocument` előtt |

### Payload + Auth

```json
{
  "action": "backfill_acl_phase3",
  "organizationId": "<orgId>",
  "scope": "all",        // OR articles | publications | layouts | deadlines | userValidations | systemValidations
  "dryRun": true         // ELŐBB minden orgon, majd false éles
}
```

**Auth**: target org `owner` (mint `backfill_acl_phase2` + verify, audit-trail + ASVS V4.1.1 least privilege).

### Output

```json
{
  "success": true,        // false ha errorCount > 0
  "action": "backfilled_acl_phase3",
  "stats": {
    "dryRun": false,
    "organizationId": "...",
    "scope": "all",
    "partialFailure": false,
    "publications":      { "scanned": 12, "wouldRewrite": 0, "rewritten": 12, "skipped": 0, "fallbackUsed": 1 },
    "articles":          { "scanned": 240, ... },
    "layouts":           { "scanned": 48, ... },
    "deadlines":         { "scanned": 36, ... },
    "userValidations":   { "scanned": 89, ... },
    "systemValidations": { "scanned": 142, ... },
    "errorCount": 0,
    "errorsTruncated": false,
    "errors": [],
    "fallbackUsedDocsCount": 1,
    "fallbackUsedDocsTruncated": false,
    "fallbackUsedDocs": [{ "alias": "publications", "collectionId": "...", "docId": "...", "fallbackReason": "auth_user_not_found" }]
  }
}
```

### Codex pipeline

| Iteráció | Eredmény | Lényeges fix |
|---|---|---|
| Pre-review | 10/10 GO + 1 BLOCKER + 2 MAJOR + 1 MINOR | Office-resolution failure policy explicit, 4-reason fallback enum, `read("user:X")`-only regex, per-alias stats |
| Stop-time | **NEEDS-WORK** 1 MAJOR audit-noise + 2 MAJOR runtime tradeoff | `auth_user_not_found_cached` → `auth_user_not_found` egységes; runtime accept-tradeoff dokumentálva (operator-supervised scope-by-scope) |
| Verifying | C1 GO + C2 NEEDS-WORK (ops-doc-hardening) + C3 GO | Observable stop conditions + `createdByAuthCache` wording |

### Harden pipeline (7 fázis)

| Fázis | Eredmény | Fix |
|---|---|---|
| Baseline | 1 P1 (team-ensure lockout) | `failedOfficeTeams` Set + filter |
| Adversarial | 1 HIGH (cross-tenant office attack vector) | `validOfficesForTargetOrg` Set + pre-validation |
| Simplify Reuse #1 | `preserveUserReads` duplikáció phase2+phase3 | Hoist `helpers/util.js`-be `preserveUserReadPermissions` |
| Simplify Quality #4 | `failedOfficeTeams` filter 3 callback-en duplikált | `rewriteAclBatchPhase3` post-resolve filter (1 hely) |
| Verifying iter 1 | 2 P1+P2 | Validation `Query.equal('articleId', batch)` BATCH-scan + `Set` dedupe |
| Verifying iter 2 | 1 P2 LOW (dry-run nem számolja a fallback stats-ot) | **SHOULD FIX halasztott** — operator-UX gap, nem regresszió |

### Operations runbook (S.7.7c deploy)

**Pre-requisite**: S.7.7b (verify_collection_document_security) `criticalFail: false` minden orgon. Ha bármelyik collection `documentSecurity: false` → manuálisan beállítani előbb.

**Deploy steps** (user-trigger, off-peak window):

1. CF redeploy (`invite-to-organization`) — a `backfill_acl_phase3` action plus a `helpers/util.js` `preserveUserReadPermissions` export-tal.
2. **DryRun minden orgon**: `{action: 'backfill_acl_phase3', organizationId: '<X>', scope: 'all', dryRun: true}`. Ellenőrizd:
   - `wouldRewrite` counts plausible-ek (a doc-szám-becsléssel egyezzen)
   - `errorCount === 0`
   - `fallbackUsedDocsCount` várt (operator-UX gap: ez 0 marad dry-run-ban a Verifying P2 LOW miatt — ne támaszkodj rá pre-migration audit-ban)
   - **Ha `cross_org_office_violation` vagy `office_team_unavailable` error** → admin manuálisan vizsgálja (potential data-corruption vagy missing-team)
3. **Éles futtatás scope-by-scope** (operator-supervised, Codex stop-time MAJOR 2+3 + Verifying C2 minta):
   - Sorrend: `publications` → `articles` → `layouts` → `deadlines` → **utolsónak** `userValidations` + `systemValidations` (2-step JOIN memory-intensív)
   - Per-scope: `dryRun: false`. Observable stop conditions: ~500 egyedi createdBy / scope-CF-call biztos; 500-1000 között óvatos; >1000 esetén bontás.
4. **Verify smoke**: 2-tab adversarial teszt (S.7.5 — user-task fejlesztői env-en).
5. **S.7.7 production close**: ha S.7.7c és S.7.7b mind kész és `criticalFail: false` → a S.7.7 production deploy mehet (frontend tenant ACL fix ÉLES).

### Accepted runtime tradeoffs (Codex stop-time)

- **`usersApi.get` per egyedi `createdBy` SDK-call**: 1000+ egyedi createdBy → ~100s, CF 60s timeout-ot átléphet. Mitigáció: scope-by-scope MANUÁLIS futtatás + lokális `createdByAuthCache` per-invocation reuse.
- **`articlesList` pre-load Map**: nagy orgon 100k+ article = ~2MB (projection-szel). Memory-pressure → admin abort + streaming refactor escalation.
- **Operator-supervised only** — NEM autonóm batch. A `scope` paraméter MINDIG explicit (NE futtass `all`-t scriptből nagy orgon).

## S.7.9 `anonymize_user_acl` action (2026-05-15, R.S.7.5 close code-only)

GDPR Art. 17 stale `withCreator` user-read cleanup. A user kilépésekor vagy fiók-törlésekor a `Permission.read(user:X)` perm a meglévő tenant doc-okon megmarad (`removeTeamMembership` NEM törli a doc-szintű perm-et). Az új action retroaktívan eltávolítja a target user `read("user:X")` (és minden ACL-művelet) perm-jét a 12-collection scope-ban.

### Architektúra

| Modul | Cél |
|---|---|
| `actions/schemas.js` `anonymizeUserAclCore(ctx, params)` | Core helper, NEM hív `res.json`-t. Self-service flow + public action közös. Params: `{organizationId, targetUserId, dryRun, callerId, maxRunMs}` |
| `actions/schemas.js` `anonymizeUserAcl(ctx)` | Thin wrapper, **ADMIN-ONLY** (self-path public auth-gap zárva). Auth: `requireOrgOwner(ctx, organizationId)`. Hiba self-path: `403 self_anonymize_disallowed` |
| `actions/offices.js` `leaveOrganization` (3.6 lépés) | Self-anonymize a team-cleanup UTÁN, DB-delete ELŐTT. `maxRunMs: 30_000` |
| `actions/orgs.js` `deleteMyAccount` (4d.5 lépés) | Self-anonymize per-org a team-cleanup UTÁN. `maxRunMs: 10_000` (10 org × 10s) |

### Scope (12 collection)

1. `organizations` (single-doc getDocument)
2. `organizationMemberships`, `editorialOffices`, `editorialOfficeMemberships`, `publications`, `articles`, `layouts`, `deadlines` — `Query.equal('organizationId', orgId)`
3. `userValidations`, `systemValidations` — `Query.equal('articleId', batch)` az `articles` target-org id-listából (BATCH=25, Codex BLOCKER scope-szűkítés)
4. `organizationInvites`, `organizationInviteHistory` — `Query.equal('organizationId', orgId)`, opcionális env-var (`skippedCollections[]` audit)

### Filter algoritmus

```js
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PERM_PATTERN = new RegExp(`^[a-z]+\\("user:${escapeRegex(targetUserId)}"\\)$`);
const filteredPerms = currentPerms.filter(p => !PERM_PATTERN.test(p));
// Idempotens: ha length === currentPerms.length → skipped++ (no-op).
// Ha csökken: Array.from(new Set(filteredPerms)) dedupe + updateDocument.
```

### Auth modell (kettős)

| Path | Caller | Engedett | Auth-check |
|---|---|---|---|
| Public admin-anonymize | org owner | `targetUserId !== callerId` | `requireOrgOwner(ctx, organizationId)` |
| Public self-anonymize | bármely user | **TILOS** (Harden HIGH fix) | `403 self_anonymize_disallowed` |
| Self-service flow | `leaveOrganization` / `deleteMyAccount` | mindenkire (`callerId === targetUserId`) | A flow saját security guard-jai (org-membership, last-owner, confirm) |

### Time-budget (Harden Verifying P1 fix)

A platform 60s CF timeout NEM catch-elhető `try/catch`-szel — split-brain veszély a self-flow-n. A `maxRunMs` paraméter partial-return-rel garantálja a flow-folytatást. `stats.timeBudgetExceeded: true` jelez partial-cleanup-ot.

- `leaveOrganization`: 30s budget (a flow többi része ~5-10s)
- `deleteMyAccount`: 10s per-org × max 10 org = ~100s combined

### Audit

- `stats.organizations` / `stats.articles` / etc.: per-collection `{scanned, anonymized, skipped}`
- `stats.errorCount` / `errorsTruncated` / `errors[]` cap 100
- `stats.skippedCollections[]` — env-var-missing collection-ök (NEM silent)
- `stats.timeBudgetExceeded` — partial-cleanup jelölés
- `stats.partialFailure: errorCount > 0`
- `success: errorCount === 0`

### Re-anonymize fallback path

A self-service flow-n a partial-cleanup admin re-anonymize-cal pótolható:

```bash
appwrite functions createExecution --function-id <fid> --body '{
  "action": "anonymize_user_acl",
  "organizationId": "<orgId>",
  "targetUserId": "<userId>",
  "dryRun": false
}'
```

(A caller org owner kell legyen az admin-path engedélyezéséhez.)

### Codex pipeline + Harden

| Iteráció | Eredmény |
|---|---|
| Pre-review | 8/8 GO + 1 BLOCKER (validation scope) + 1 MAJOR (regex escape) — javítva |
| Stop-time | NEEDS-WORK 3 MAJOR (CF timeout op-bound + re-anonymize op + partial sem) + 1 MINOR — mind javítva (kódfix + doku) |
| Verifying | C1+C2+C3 GO CLEAN |
| Harden Baseline | 1 P1 (`callerId` undef-ref) — javítva (params-ban explicit) |
| Harden Adversarial | 1 HIGH (self-path public auth-gap) + 1 medium (duplikált P1) — javítva (public ADMIN-ONLY) |
| Harden Simplify | **HALASZTOTT** (/loop context-fogyás) |
| Harden Verifying iter 1 | 2 P1 (sync-anonymize timeout-risk a self-flow-n) — javítva (`maxRunMs` time-budget) |
| Harden Verifying iter 2 | **HALASZTOTT** (/loop context-fogyás, manuálisan futtatható) |

## S.7.8 Phase 1 phantom-org window (2026-05-15, R.S.7.4 partial close)

Phantom-org window: a `bootstrap_organization` `createDocument(organizations)` SIKER UTÁN + flow VÉGE ELŐTT ~10-100ms-ig a creator látja a doc-ot a `withCreator` `Permission.read(user(callerId))` azonnali hatása miatt. Ha a frontend ebben az ablakban lekér a doc-ról (Realtime push vagy REST list), fantom-org megjelenik a UI-ban.

### Phase 1: Backend mitigáció (env-flag-feltételes)

Új OPCIONÁLIS env-var `ENABLE_PROVISIONING_GUARD` (default `false` visszafelé kompatibilis). Ha `'true'`:

1. **Schema-bővítés**: `bootstrap_organization_status_schema` action enum `['provisioning', 'active', 'orphaned', 'archived']`. Idempotens `updateEnumAttribute` ha létezik a 3-elem enum (Appwrite SDK NEM tudja BŐVÍTENI a meglévő enum-ot, csak update-elni).
2. **Bootstrap flow**: `createDocument(organizations)` data-objektum `status: 'provisioning'`. Flow VÉGÉN (minden child-write OK) `_finalizeOrgIfProvisioning(ctx, orgId)` helper-rel `'active'`-ra finalize-eli (best-effort).
3. **Permission write-block**: `permissions.ORG_STATUS.PROVISIONING: 'provisioning'` enum-bővítés. `isOrgWriteBlocked('provisioning')` true — minden CRUD action `userHasOrgPermission`-on át 403-mal blokkol a phantom-doc-on (fail-closed). A `bootstrap_organization` saját child write-jai admin API-key-vel mennek (Codex BLOCKER verify: NEM hív `userHasOrgPermission`-t), így NEM self-deadlock.

### Finalize fail-soft + audit

A `_finalizeOrgIfProvisioning` visszaad `{finalized, error?}`. Ha bukik, a doc `'provisioning'`-on marad, és a return-ben:

```json
{
  "success": true,
  "provisioningStuck": true,
  "provisioningStuckReason": "<error message>",
  "recoveryHint": "Admin manuálisan futtathat `update_organization`-t a status: \"active\"-ra állításhoz."
}
```

Frontend észreveheti és figyelmeztetheti a usert / retry-zhet. Pre-existing re-bootstrap path (idempotens) is hív self-heal `_finalizeOrgIfProvisioning`-ot (Codex MINOR fix).

### Phase 2 DONE 2026-05-15 (frontend filter)

Plugin + dashboard org-list query null-tolerant filter (Codex stop-time NO-GO Q1 fix):

```js
queries: [
    Query.equal('$id', orgIds),
    Query.or([Query.equal('status', 'active'), Query.isNull('status')]),
    Query.limit(100)
]
```

Null-tolerant a legacy doc-okra (a `backfill_organization_status` ELŐTT létrejött org-ok `status: null` mezővel). A `provisioning` szigorúan NEM-null érték → szűrve.

Dashboard Realtime callback (`classify` helper a `AuthContext.jsx`-ben) defense-in-depth:

```js
if (payload?.status === 'provisioning') {
    return { relevant: false, destructive: false };
}
```

A push-race-protect: ha egy `provisioning`-os create event érkezik a kliens-cache invalidálás ELŐTT, a callback szűr.

**`user-cascade-delete` CF NEM érintett**: a `bootstrap_organization` rollback `deleteDocument(organizations)`-szal direkt törli a phantom-doc-ot, NEM trigger `account.delete` event-en át.

Plugin Realtime NEM iratkozik fel a `organizations` collection-re (grep verify). Csak a dashboard-on van kettős védelem.

### Codex pipeline

| Iteráció | Eredmény |
|---|---|
| Pre-review | 6/6 GO + 1 MAJOR (enum migration sorrend) + 1 MINOR (`archived` skip — már be van vezetve) — javítva |
| Stop-time | NEEDS-WORK: 1 BLOCKER conditional (bootstrap önmaga userHasOrgPermission? — verify: NEM, admin API-key-vel) + 1 MAJOR (finalize fail-soft → `provisioningStuck` flag) + 1 MINOR (pre-existing re-bootstrap self-heal) — mind javítva |
| Verifying + /harden | **HALASZTOTT** (/loop context-fogyás, manuálisan futtatható). Phase 2 külön iterációba. |

### Deploy steps (Phase 1)

1. CF redeploy az új `permissions.js` + `actions/schemas.js` + `actions/orgs.js` + `main.js`-szel
2. Új env-var `ENABLE_PROVISIONING_GUARD=true` Appwrite Console-on
3. `bootstrap_organization_status_schema` action futtatása **MINDEN orgra** (idempotens enum-bővítés)
4. Smoke: új org bootstrap → return `success: true` + `provisioningStuck` flag = false (várt)
5. Phase 2 frontend filter — külön iteráció

### Affected fájlok

| Fájl | Változás |
|---|---|
| `actions/schemas.js bootstrapOrganizationStatusSchema` | Enum-bővítés `STATUS_ENUM` 4-elem + idempotens `updateEnumAttribute` ág |
| `permissions.js ORG_STATUS` | `PROVISIONING: 'provisioning'` + `isOrgWriteBlocked` bővítés |
| `main.js` | `ENABLE_PROVISIONING_GUARD` env-var + ctx.env propag |
| `actions/orgs.js` | Új helper `_finalizeOrgIfProvisioning(ctx, orgId)` + `bootstrapOrCreateOrganization` `createDocument` data status + flow-vég finalize 3 helyen (early-no-office return + happy-path + pre-existing-re-bootstrap self-heal) |

## Kapcsolódó

- [[SecurityBaseline]] — STRIDE per komponens (V4, V5, CIS 3)
- [[SecurityRiskRegister]] — R.S.7.1 + R.S.7.2 closed, R.S.7.3 closed (code-only 2026-05-14), R.S.7.6 + R.S.7.7 + R.S.7.5 closed (code-only 2026-05-15), **R.S.7.4 Phase 1 backend done** (code-only 2026-05-15, Phase 2 PENDING)
- [[Döntések/0003-tenant-team-acl]] — ADR per-tenant Team ACL alapja
- [[Komponensek/Permissions]] — server-side permission guards (S.7 sorrendileg utáni layer)
- `packages/maestro-server/functions/invite-to-organization/src/teamHelpers.js` — minden ACL helper
