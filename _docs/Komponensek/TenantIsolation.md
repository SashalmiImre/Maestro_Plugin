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

## Nyitott kockázat (R.S.7.2 — backfill)

A `document_already_exists` race-fallback ágon (`orgs.js:189-194`, `invites.js:1024+`, `offices.js:391-397`) a legacy doc permissions értéke ismeretlen. **A jelenlegi fix-ek NEM korrigálják**. Acceptable a "nincs éles adat" + fejlesztői env-en eseti reset kontextusban; éles deploy előtt:

```js
// backfill_acl_phase2 (S.7.2 deferred CF action, vázlat)
async function backfillAclPhase2({ databases, env, dryRun }) {
    const targets = [
        { col: env.organizationsCollectionId, scope: 'org' },
        { col: env.membershipsCollectionId, scope: 'org' },
        { col: env.officesCollectionId, scope: 'org' },
        { col: env.officeMembershipsCollectionId, scope: 'office' },
        { col: env.publicationsCollectionId, scope: 'office' }
    ];
    // List → for each missing permission → updateDocument(permissions = recompute)
    // dryRun = log only, NO write
}
```

## Nyitott kockázat (R.S.7.3 — articles frontend)

Az `articles` doc-okat a plugin / dashboard frontend **direktbe írja** Appwrite SDK-val, NEM CF-eken keresztül. A `validate-article-creation` post-event CF csak **utólagosan** validál + töröl ha cross-tenant ütközés — **race-ablak** maradt a create és validate között. Fix: `articles.createDocument` hívásokon `withCreator(buildOfficeAclPerms(officeId), userId)` pótlása mindkét frontend-ben.

## Kapcsolódó

- [[SecurityBaseline]] — STRIDE per komponens (V4, V5, CIS 3)
- [[SecurityRiskRegister]] — R.S.7.1 closed, R.S.7.2 + R.S.7.3 open
- [[Döntések/0003-tenant-team-acl]] — ADR per-tenant Team ACL alapja
- [[Komponensek/Permissions]] — server-side permission guards (S.7 sorrendileg utáni layer)
- `packages/maestro-server/functions/invite-to-organization/src/teamHelpers.js` — minden ACL helper
