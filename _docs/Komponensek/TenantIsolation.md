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

## Nyitott kockázat (R.S.7.3 — articles frontend)

Az `articles` doc-okat a plugin / dashboard frontend **direktbe írja** Appwrite SDK-val, NEM CF-eken keresztül. A `validate-article-creation` post-event CF csak **utólagosan** validál + töröl ha cross-tenant ütközés — **race-ablak** maradt a create és validate között. Fix: `articles.createDocument` hívásokon `withCreator(buildOfficeAclPerms(officeId), userId)` pótlása mindkét frontend-ben.

## Kapcsolódó

- [[SecurityBaseline]] — STRIDE per komponens (V4, V5, CIS 3)
- [[SecurityRiskRegister]] — R.S.7.1 + R.S.7.2 closed, R.S.7.3 + R.S.7.4 + R.S.7.5 open
- [[Döntések/0003-tenant-team-acl]] — ADR per-tenant Team ACL alapja
- [[Komponensek/Permissions]] — server-side permission guards (S.7 sorrendileg utáni layer)
- `packages/maestro-server/functions/invite-to-organization/src/teamHelpers.js` — minden ACL helper
