---
adr: 14
status: Accepted
date: 2026-05-12
tags: [adr, döntés, server, security, tenant, acl, appwrite]
related: [[0003-tenant-team-acl]] [[0009-membership-user-identity-denormalization]] [[0010-meghivasi-flow-redesign]]
---

# ADR 0014 — Tenant doc ACL `withCreator` defense-in-depth

## Kontextus

A [[0003-tenant-team-acl|ADR 0003]] bevezette a per-tenant Appwrite Team ACL-t — a tenant-érintő doc-ok `Permission.read(team:org_${orgId})` vagy `Permission.read(team:office_${officeId})` permissionnel jönnek létre, így a Realtime push és a REST `listDocuments` server-szinten szűri a más tenant kliensek elől.

Az S blokk S.7.1 audit (2026-05-12) felfedte, hogy 8 `createDocument` hívás az `invite-to-organization` CF-ben ÜRES `permissions` paraméterrel jött létre — collection-szintű `read("users")` örökölt → cross-tenant Realtime push szivárgás. A javítás során **rezsim-szintű problémát találtunk** a `bootstrap_organization` és `acceptOrganizationInvite` action-ekben:

> A creator (új org-ot bootstrap-elő vagy invite-ot elfogadó user) a `createDocument` időpontban **MÉG NEM** `org_${orgId}` team-tag — a `ensureTeam` vagy `ensureTeamMembership` csak később fut (logikailag), vagy egy másik race-en bukhat. Emiatt a `Permission.read(team:org_${orgId})` ACL azonnal NEM hat rá → a creator NEM látja a saját frissen létrehozott doc-ját.

A Codex stop-time + verifying review **MAJOR**-ként jelölte a race-t.

## Döntés

Új helper `withCreator(perms, callerId)` a `teamHelpers.js`-ben — defense-in-depth `Permission.read(user(callerId))` az alap team-szintű ACL mellé. Minden creator-érintő tenant `createDocument` hívás ezzel a wrapper-rel megy:

```js
function withCreator(perms, callerId) {
    const trimmed = typeof callerId === 'string' ? callerId.trim() : '';
    if (!trimmed || trimmed !== callerId) {
        throw new Error('withCreator: callerId required (non-empty, non-whitespace, no leading/trailing space)');
    }
    return [...perms, sdk.Permission.read(sdk.Role.user(callerId))];
}
```

Hívóhely-minta:

```js
const doc = await databases.createDocument(
    env.databaseId,
    env.collectionId,
    sdk.ID.unique(),
    docPayload,
    withCreator(buildOrgAclPerms(organizationId), callerId)
);
```

### Védelmi rétegek (3-réteges defense-in-depth)

| Réteg | Mit véd | Honnan jön |
|---|---|---|
| 1. Collection `documentSecurity: true` | Bekapcsolja a doc-ACL érvényesítését (különben collection-szintű `read("users")` mindenkinek olvasási jog) | Appwrite `createCollection(..., documentSecurity: true, ...)` — manuálisan vagy a `bootstrap_*_schema` CF actionökben |
| 2. Team-szintű `Permission.read(team:X)` | A doc csak az adott tenant Team tagjainak látható (Realtime push + REST szűrve) | `buildOrgAclPerms` / `buildOfficeAclPerms` / `buildOrgAdminAclPerms` / `buildWorkflowAclPerms` |
| 3. `withCreator(perms, callerId)` | A creator azonnal lát, függetlenül a team-membership timing-tól | Új helper az ADR 0014 keretében |

A 3 réteg redundáns, de szándékosan: bármelyik egyetlen pont bukása sem szivárogtat keresztül a többi rétegen.

## Alternatívák megfontolva

### A) Tag-only ACL + atomic transaction

`createDocument` + `ensureTeamMembership` egy atomikus tranzakcióban. **Elvetve**: Appwrite Cloud **NEM ad** transaction API-t a Database + Teams kombinált műveletekre. Bármely sorrend (createDocument-first vagy team-first) race-ablakot hagy.

### B) Post-hoc `updateDocument` permissions

```js
const doc = await databases.createDocument(..., buildOrgAclPerms(orgId)); // ÜRES creator-read
await ensureTeamMembership(orgTeamId, callerId);
await databases.updateDocument(..., doc.$id, undefined, buildOrgAclPerms(orgId)); // re-set perms
```

**Elvetve**: két plusz API-call, és az `updateDocument(permissions)` race-window-t nyit (a `ensureTeamMembership` és `updateDocument` között a creator nem lát, és ha a CF crash-el itt, a doc tartósan creator-read nélkül marad).

### C) `withCreator` defense-in-depth (választott)

Egy API-call, race-resilient: `Permission.read(user(callerId))` Appwrite Role azonnal hat (NEM team-membership-függő). A team-szintű read a többi tenant-tagra továbbra is alkalmazódik (defense-in-depth, redundáns de korrekt).

**Hátrány**: a `withCreator` `user(callerId)` perm **STALE** marad, ha a user később kilép a tenant-ből (`removeTeamMembership` NEM törli a doc-szintű perm-et). GDPR Art. 17 (right to be forgotten) sérülés-kockázat → S.7.x al-pont, új `anonymize_user_acl` CF action (lásd Konzekvenciák).

## Következmények

### Pozitív

- **Race-resilient**: a creator MINDIG látja a saját frissen létrehozott doc-ját, függetlenül a team-membership timing-tól.
- **Egyszerű hívóhely**: 1 wrapper, 1 API-call.
- **Helper-újrahasznosítás**: jövőbeli tenant-érintő `createDocument` action-ök is `withCreator(buildXxxAclPerms(...), callerId)`-rel mennek — kanonikus minta.
- **Konzisztens minta**: a `buildOrgAclPerms` / `buildOfficeAclPerms` / `buildOrgAdminAclPerms` `withCreator`-rel kompozit. NEM bonyolítjuk a base helper-eket.

### Negatív

- **Stale `user(callerId)` perm GDPR-kockázat**: user kilépés / törlés UTÁN a `Permission.read(user(callerId))` STALE marad a régi membership/history doc-okon. A user továbbra is lát a saját history-ját — GDPR Art. 17 sérülés. **Mitigáció**: új `anonymize_user_acl` CF action (S.7.x al-pont), amely `removeTeamMembership` MELLÉ `updateDocument` permissions a user-id-jét tartalmazó doc-okon. **Halasztott, R.S.7.5 open.**
- **Doc-permissions duplikáció**: `Permission.read(team:org_X)` + `Permission.read(user:Y)` mindkettő benne a doc-on. Appwrite NEM duplikálja a `team:X` és `user:Y` permission-eket (különböző Role-okra mutatnak), no functional duplication.

### Semleges

- **Defense-in-depth redundancia**: a `user(callerId)` perm a 99%-os esetben felesleges (a creator azonnal team-tag lesz a `ensureTeamMembership` után). A redundancia szándékos a race-corner case-re.

## Hatály

A `withCreator` helper minden új tenant-érintő `createDocument` hívásra **kötelező** az `invite-to-organization` CF-ben (és minden jövőbeli CF-ben, ami tenant-doc-ot ír). A létező 8 hívóhely az S.7.1 commit-csomagban már `withCreator`-rel megy.

Frontend (plugin + dashboard) `articles.createDocument` direkt Appwrite SDK hívások: **R.S.7.3 open**, S.7.7 al-pont — szintén `withCreator(buildOfficeAclPerms(officeId), userId)`-rel kell.

## Verifikáció

- Codex pre-review (S.7 design): Q1.D GO (`task-mp1...`)
- Codex stop-time review: 2 MAJOR (bootstrap + acceptInvite race) — `withCreator` minta javítása
- Codex verifying review: CLEAN
- Codex baseline harden: CLEAN + 4 NIT (komment-sor stale, javítva)
- Codex adversarial harden: 5 CONCERN (P1/P2/P4/P6/P8) — MUST FIX-ek alkalmazva, DESIGN-Q-k külön al-pontra (S.7.x)
- Codex verifying harden: CLEAN

## Kapcsolódó

- [[Komponensek/TenantIsolation]] — komponens-szintű implementáció + 8 createDocument-fix tábla
- [[0003-tenant-team-acl|ADR 0003]] — per-tenant Team ACL alapja
- [[Komponensek/SecurityRiskRegister]] — R.S.7.1 closed, R.S.7.2 (backfill) + R.S.7.3 (articles frontend) + R.S.7.4 (phantom-org) + R.S.7.5 (GDPR stale user-read) open
- [[Feladatok#S.7]] — al-pont státusz
