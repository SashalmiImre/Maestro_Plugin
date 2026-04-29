---
tags: [adr, biztonság, fázis2, acl, realtime]
status: Accepted
date: 2026-04-19
---

# 0003 — Per-tenant Team ACL (Realtime cross-tenant leak fix)

## Kontextus

A [[0002-fazis2-dynamic-groups|0002 — Dinamikus csoportok]] bevezetése után 3 collection ACL-je `read("users")` lett:
- `groups`
- `groupMemberships`
- `organizationInvites`

Ez azt jelenti: **minden hitelesített user minden organization minden Realtime payload-ját megkapja**. Két-tab smoke teszt megerősítette: tab A (Org X) létrehoz egy meghívót, tab B (Org Y) WS-en megkapja az `organizationInvites` create event-et a Y számára idegen email-címmel együtt.

JS-oldali filter (UI-szintű kiszűrés `editorialOfficeId` alapján) **kozmetikus**: a raw payload szivárog. Compliance és bizalmasság szempontból nem elfogadható (Feladat #60).

## Döntés

**Per-tenant Appwrite Team + dokumentum-szintű ACL.**

### Team konvenciók
- Organization scope: `Team(team_id="org_${organizationId}")` — minden organization-membert tartalmaz
- Editorial office scope: `Team(team_id="office_${editorialOfficeId}")` — minden office-membert tartalmaz

### Doc-szintű ACL
- `organizationInvites` → `read("team:org_${orgId}")` (csak az org tagjai látják)
- `groups` → `read("team:office_${officeId}")` (csak az office tagjai látják)
- `groupMemberships` → `read("team:office_${officeId}")` (ugyanaz)

A Team membership szinkronban marad a meglévő `organizationMemberships` / `editorialOfficeMemberships` rekordokkal — az `invite-to-organization` CF minden tenant művelete írja a Team-et is.

### Helper-ek
A `teamHelpers.js`-ben két függvény: `buildOrgAclPerms(orgId)` és `buildOfficeAclPerms(officeId)`. Új doc create művelet kötelezően ezen helperekből származó perm-listát ad át a `databases.createDocument()` 5. paraméterének.

### Miért office-szintű (nem group-szintű) team
Minden szerkesztőség **dinamikus, saját csoportokkal**. Group-szintű Team az ACL-ben kódolatlan csoportszámot jelentene, és minden csoport-mutációnál ACL-újraszámolást követelne. Az office-szintű Role automatikusan kezeli a csoportváltozásokat — egy user akkor lát egy `groups` doc-ot, ha az adott office tagja, függetlenül attól, melyik csoportokba tartozik.

### Legacy adat backfill
A meglévő doc-ok ACL-je `read("users")` — nem szivárgásmentes önmagában. A `backfill_tenant_acl` CF action utólag kitölti:
- **Owner-only** (csak admin futtathatja)
- **Idempotens** (ismételt futás nem rontja az állapotot)
- **Per-doc fail-open** (egy doc hibája nem állítja le a többit)
- **`dryRun: true` támogatás** (számolás futás előtt)

### Zero-downtime rollout
A collection-szintű `read("users")` és a `rowSecurity: true` flag eltávolítása **manuális Appwrite Console művelet**. Amíg ez nem történik meg, a doc-szintű ACL már el van tárolva, de a collection read mindenkinek engedett — a doc ACL-ek csak a `rowSecurity: true` után érvényesülnek a Realtime-on. Biztonságos: az új doc-ok már most korrekt ACL-lel mennek be, a régiek a backfill után. A cutover egy egyszeri Console művelet.

## Alternatívák

| Opció | Mellette | Ellene |
|---|---|---|
| **JS-oldali filter** (status quo) | 0 backend változás | Kozmetikus — raw payload szivárog (compliance fail) |
| **Csoport-szintű team** (per-group ACL) | Granuláris | Skálázhatatlan dinamikus csoportokkal — kódolatlan csoportszám |
| **Office-szintű team ACL** (választott) | Skálázható, dinamikus csoportokkal kompatibilis | Új konvenció minden új tenant collection-höz |

## Következmények

- **Pozitív**: Realtime cross-tenant leak megszűnik. A doc-szintű team ACL minden registrable domain alatt first-class Appwrite feature, **nincs kliens változtatás** — a Realtime channel és REST list automatikusan szűr.
- **Negatív / trade-off**: Új konvenció betartása minden új tenant-érintett action-ben. Egy elfelejtett `permissions` paraméter a `databases.createDocument()`-ben **üres ACL-t tárol → senki nem látja az új doc-ot** (silent fail mód). Mitigáció: kötelező `buildOfficeAclPerms()` használat, code review.
- **Új kötelezettségek**:
  - **Új tenant collection ACL flow**: mindig `team:org_${orgId}` vagy `team:office_${officeId}` Role a `sdk.Permission.read()`-ben (lásd `teamHelpers.js`).
  - **Új action a 3 érintett collection-be**: kötelező az 5. paramétert (`permissions`) feltölteni, különben üres ACL.
  - **Új membership-mutáló action**: kötelező az azonos team-tagság szinkronizálása (`ensureTeamMembership` — Appwrite cascade-eli a törlésnél).
  - **CF API key scope**: a meglévő `databases.*` + `users.read` mellett **`teams.read` + `teams.write` is kell**.

## Implementáció (kulcsfájlok)

| Modul | Felelősség |
|---|---|
| `packages/maestro-server/.../teamHelpers.js` | `buildOrgAclPerms`, `buildOfficeAclPerms`, `ensureTeamMembership` |
| `packages/maestro-server/invite-to-organization/...` | Per-tenant Team létrehozás + doc ACL beállítás |
| `packages/maestro-server/backfill_tenant_acl/...` | Legacy doc ACL utólagos kitöltés (idempotens, dry-run-os) |
| Appwrite Console (manuális cutover) | `rowSecurity: true` + collection `read("users")` eltávolítás |

## Kapcsolódó
- Memory: `fazis2-tenant-acl.md` (Feladat #60, 2026-04-19)
- ADR-ek: [[0002-fazis2-dynamic-groups]] (alapozó), [[0004-dashboard-realtime-bus]] (Realtime fogyasztó refactor a SLOT 0 bug miatt)
- Komponens: [[Komponensek/AuthContext]], [[Komponensek/DataContext]]
