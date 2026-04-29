---
tags: [adr, jogosultság, fázis2]
status: Accepted
date: 2026-04-09
---

# 0002 — Fázis 2: dinamikus csoportok (groups + groupMemberships collection)

## Kontextus

Az 1. fázisban a jogosultsági rendszer **7 fix Appwrite Team**-en alapult: `editors`, `designers`, `writers`, `image_editors`, `art_directors`, `managing_editors`, `proofwriters`. Ennek korlátai:

- **Egy organization → egy szerkesztőség**: a Team-ek globálisak voltak, nem támogatták a multi-tenant scope-ot.
- **Statikus csoportlista**: új csoport létrehozásához kódváltozás kellett.
- **Appwrite Team API ↔ membership szinkron**: nem natív, kézi API hívásokkal.

A 2. fázis multi-tenant rendszert vezet be (organization → 1+ editorial office), és minden szerkesztőség saját, dinamikus csoportlistát kezel.

## Döntés

**A 7 fix Appwrite Team-et lecseréljük `groups` + `groupMemberships` collection-re**, szerkesztőség-szintű (editorial office) scope-pal.

### Kollekciók
- `groups`: `slug`, `name`, `editorialOfficeId`, `organizationId`, `description`, `createdByUserId`
- `groupMemberships`: `groupId`, `userId`, `editorialOfficeId`, `organizationId`, `role`, `addedByUserId`, `userName`, `userEmail` (denormalizált — a listing optimalizációhoz; ne Appwrite users API-t hívjunk render-enként)

### Slug-megőrzés
A 7 alapértelmezett csoport slug-jai változatlanok (`editors`, `designers`, …). Így a `STATE_PERMISSIONS`, `TEAM_ARTICLE_FIELD`, `elementPermissions` konfigok **nem igényelnek módosítást** — drop-in csere.

### Adatfolyam
- **Plugin**: `UserContext.enrichUserWithGroups()` — `localStorage.editorialOfficeId` → `groupMemberships` + `groups` query → `resolveGroupSlugs()` → `user.groupSlugs`
- **Dashboard**: `AuthContext.fetchGroupSlugs(userId)` — ugyanaz a logika
- **CF guard**: `article-update-guard` `getUserGroupSlugs()` — article `editorialOfficeId`-ből scope, query → slugs (server-side validáció)
- **Realtime**: `groupMemberships` collection csatorna → `DataContext` handler → `groupMembershipChanged` MaestroEvent → cache invalidálás (`useGroupMembers`)
- **Scope-váltás**: `ScopeContext.setActiveOffice()` → `scopeChanged` MaestroEvent → `UserContext.refreshGroupSlugs()`

### Jogosultság értékelés
A `canUserMoveArticle()` és társai mindkét forrást egyenrangúan kezelik:
- `user.groupSlugs` (csoporttagság, fenti adatfolyamból)
- `user.labels` (Appwrite user label override — admin manuális beállítás, scope nélküli)

Az OR logika tudatos: az `user.labels` admin-szintű override, a `groupSlugs` szerkesztőség-szintű scope.

### Default group seeding
Új organization létrehozásakor a `bootstrap_organization` CF action seedeli a 7 alapértelmezett csoportot + 7 groupMembership-et a létrehozó user számára.

## Alternatívák

| Opció | Mellette | Ellene |
|---|---|---|
| **Marad 7 fix Team** (status quo) | Egyszerű, kész | Nem multi-tenant; nem dinamikus |
| **Per-tenant Team-ek** (1 org × 7 Team) | Appwrite natív Team API | Skálázhatatlan: 100 org × 7 = 700 Team menedzselése |
| **`groups` + `groupMemberships` collection** (választott) | Dinamikus, multi-tenant, slug-megőrzés | Custom membership szinkron logika kell |

## Következmények

- **Pozitív**: Új csoport létrehozása kódváltozás nélkül; multi-tenant scope; slug-stabilitás.
- **Negatív / trade-off**: Custom membership-szinkron a `groupMemberships` collection-ön — nincs Appwrite-natív Team API rácsatlakozás. **A 2026-04-19-es [[0003-tenant-team-acl]] ezt visszahozza dokumentum-szintű ACL Team-ek formájában** (Realtime cross-tenant leak miatt) — nem ütközik az itteni döntéssel: a Team-ek itt csak ACL Role-ok, a csoport-szintű jogosultság továbbra is a `groupSlugs`-ban van.
- **Új kötelezettségek**:
  - `bootstrap_organization` action seedeli az alapértelmezett csoportokat
  - Új tagság szinkronizálása a `groupMemberships` collection-ön át
  - **`groupSlugs` megőrzése az `account` Realtime handlerben**: `{...payload, groupSlugs: prev?.groupSlugs || []}` — a Realtime user-payload nem tartalmazza, csak az `enrichUserWithGroups()` újrafuttatása ad ki

## Lezáratlan manuális lépések (Appwrite Console)

A 2026-04-09-es deploy után ezek **még nincsenek elvégezve** (low risk, idle):
- `get-team-members` CF (ID: `69599cf9000a865db98a`) törlése — már nem hívja senki
- A 7 régi Appwrite Team törlése (`editors`, `designers`, `writers`, `image_editors`, `art_directors`, `managing_editors`, `proofwriters`)

## Implementáció (kulcsfájlok)

| Modul | Felelősség |
|---|---|
| `packages/maestro-indesign/src/contexts/UserContext.jsx` | `enrichUserWithGroups()`, `refreshGroupSlugs()` |
| `packages/maestro-dashboard/src/contexts/AuthContext.jsx` | `fetchGroupSlugs()` |
| `packages/maestro-server/article-update-guard/...` | `getUserGroupSlugs()` server-side validáció |
| `packages/maestro-server/bootstrap_organization/...` | Default group + membership seeding |
| `packages/maestro-server/add_group_member`, `remove_group_member` | Csoporttagság mutáció CF action |

## Kapcsolódó
- Memory: `fazis2-groups.md`
- Komponens: [[Komponensek/UserContext]], [[Komponensek/DataContext]], [[Komponensek/MaestroEvent]]
- ADR-ek: [[0003-tenant-team-acl]] (Realtime ACL réteg, kompatibilis), [[0004-dashboard-realtime-bus]] (Dashboard Realtime fogyasztó refactor)
