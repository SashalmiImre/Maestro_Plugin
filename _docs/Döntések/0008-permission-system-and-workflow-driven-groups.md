---
tags: [adr, jogosultság, csoportok, workflow, permission-sets]
status: Proposed
date: 2026-05-01
---

# 0008 — Jogosultsági rendszer + workflow-driven felhasználó-csoportok

## Kontextus

A Maestro két ortogonális jogosultsági igényt kell kezeljen, amik mindketten a meglévő rendszer hiányosságát fedik fel:

### 1. Felhasználó-csoportok forrása

[[Döntések/0002-fazis2-dynamic-groups|ADR 0002]] óta minden szervezet a `bootstrap_organization` action során 7 fix default csoportot kap (`editors`, `designers`, `writers`, `image_editors`, `art_directors`, `managing_editors`, `proofwriters`). Ezt a 7 slug-ot a [[Csomagok/dashboard-workflow-designer|workflow designer]] kötelező alapként kezeli (`compiled.statePermissions[stateId] = ["editors", "designers"]` — slug-okra hivatkozó listák).

A korlát: a 7 default csoport-modell **fix workflow-feltevésre épül** ("egy szerkesztőségben pont ez a 7 szerep van"), és nem skálázik a [[Döntések/0006-workflow-lifecycle-scope|ADR 0006]] óta self-contained workflow-entitásra. Egy szerkesztőségre hozott `public` workflow más szerepköröket igényelhet, vagy egy szerkesztőség kifejezetten egy szűk munkafolyamatot futtat — a 7-csoport seed mindkét esetben felesleges szemét vagy hiányos készlet.

### 2. Granuláris jogosultságok hiánya

Mai dashboard-jogosultság = [[Komponensek/useOrgRole|useOrgRole]] (`owner` / `admin` / `member` — 3 érték). Nincs lehetőség arra, hogy egy felhasználó például "publikációkat létrehozhasson, de workflow-kat ne archiválhasson", vagy hogy "extension-ek kezelése egy szűkebb csoportra korlátozódjon".

A workflow-szintű jogosultság (`compiled.statePermissions[stateId]` → groupSlugs) működik (workflow-runtime), de a workflow-on **kívüli** műveletekre (CF action-szintű authorizáció) nincs analóg réteg.

### Tervi alapelvek (2026-05-01)

- **Nincs éles verzió, nincs visszafelé-kompatibilitás követelmény, nincs adatmigráció.** Minden meglévő dev-adat dobható.
- A két fél (workflow-driven groups + permissionSets) **egy ADR-ben** kerül rögzítésre, mert szorosan kapcsolódnak: a `permissionSets` permission-jai között `group.*` slug-ok is vannak, és a workflow-driven autoseed eldönti, hogy a felhasználó-csoportok mikor jönnek létre.

## Döntés

**Két fél egy rendszerben:**

1. **Workflow-driven felhasználó-csoportok** — a workflow `compiled.requiredGroupSlugs[]` mezőben definiálja a saját slug-jait; aktiváláskor / hozzárendeléskor autoseed.
2. **`permissionSets` mint új ortogonális réteg** — coarse-granularitású (38 slug, ebből 5 org-scope + 33 office-scope) dashboard- és workflow-műveleti jogosultságok, m:n kapcsolat felhasználó-csoportokhoz (`groupPermissionSets`). A `permissionSets.permissions[]` **CSAK** office-scope slug-okat tárol; az `org.*` slug-ok kizárólag `organizationMemberships.role`-on át.

A két réteg **ortogonális** — különböző döntési szinteket fed le:

- **Permission set guard** (CF action-szint): "ki indíthat el egy CRUD-műveletet" — workflow CRUD, csoport-CRUD, settings, kiadvány-CRUD, stb. Ezeken a CF action-ökön `userHasPermission()` guard fut.
- **Workflow-runtime guard** (cikk-szint): "ki dolgozhat egy adott állapotban / mezőben" — `compiled.statePermissions`, `compiled.elementPermissions`, `compiled.transitions[].allowedGroups`, `compiled.leaderGroups`. A meglévő `update-article` CF ezt validálja (változatlan).

A két réteg **csak a CRUD-oldalon AND-elődik** azokon a CF action-eken, amik permission slug-gal vannak védve (pl. `update_workflow_metadata` AND `workflow.edit`). A cikk-szintű állapot-átmenet és mezőszerkesztés (`update-article`) **kizárólag** workflow-runtime guardot használ — a `permissionSets` rétegnek itt **nincs hatása**. Ez tudatos szétválasztás: a permission set "mit szabad CRUD-szinten csinálni"-t válaszolja meg, a workflow-runtime pedig "ki dolgozhat ezen a state-en/mezőn"-t.

### A. Workflow-driven felhasználó-csoportok

#### A.1. Új workflow-mező: `compiled.requiredGroupSlugs[]`

A workflow `compiled` JSON új top-level mezőt kap — a workflow által hivatkozott **összes** felhasználó-csoport slug-jának kanonikus listája. Részletes formális leírás: [[workflow-designer/COMPILED_SCHEMA#requiredGroupSlugs]].

```jsonc
{
  "requiredGroupSlugs": [
    { "slug": "editors",            "label": "Szerkesztők",   "description": "Cikkek szerkesztése.",     "color": "#A0E0FF", "isContributorGroup": true,  "isLeaderGroup": false },
    { "slug": "external_reviewers", "label": "Külső lektorok", "description": "Külső szakmai lektorálás.", "color": "#FFA500", "isContributorGroup": false, "isLeaderGroup": false }
  ],
  "states": [...],
  "transitions": [...],
  "statePermissions": {
    "draft":  ["editors"],
    "review": ["editors", "external_reviewers"]
  }
}
```

A `requiredGroupSlugs[]` minden eleme egy `groups` doc auto-seed-elhető csontváza (`slug`, `label`, `description`, `color`, `isContributorGroup`, `isLeaderGroup`). Az autoseed flow ezekből hozza létre a `groups` doc-ot a célszerkesztőségben.

**Designer-validáció mentés előtt**: a workflow összes többi mezőjében hivatkozott slug **kötelezően** szerepeljen a `requiredGroupSlugs[].slug` halmazban — különben mentési error (`unknown_group_slug`). Az érintett mezők: `transitions[].allowedGroups`, `commands[*].allowedGroups`, `elementPermissions.*.*.groups`, `leaderGroups`, `statePermissions.*`, `contributorGroups[].slug`, `capabilities.*`.

A `compiled.contributorGroups[]` és `compiled.leaderGroups[]` mezőket a compiler **automatikusan generálja** a `requiredGroupSlugs[]`-ban szereplő `isContributorGroup` / `isLeaderGroup` flag-ekből — nincsenek külön szerkeszthető mezők.

#### A.2. `bootstrap_organization` refactor

A 7 fix default csoport seedelése **kivéve** — új szervezet 0 felhasználó-csoporttal indul. Permission set default seed marad (lásd B.4).

#### A.3. Autoseed flow

**Workflow hozzárendelése publikációhoz** (`assign_workflow_to_publication` CF):
- A `compiled.requiredGroupSlugs[]` minden eleme-re: ha nincs `groups` doc a célszerkesztőségben az adott `slug`-ra, **autoseed** (`label` + `description` + `color` + `isContributorGroup` + `isLeaderGroup` a workflow-ból, üres `groupMemberships`).
- Ha létezik már a slug, az autoseed **nem írja felül** a meglévő mezőket (idempotens).
- Nem követeli meg a min. 1 tagot ezen a ponton.

**Publikáció aktiválás** (`activate_publication` CF):
- Megismételt autoseed (idempotens — a hozzárendelés óta változott workflow-ra).
- Minden `requiredGroupSlugs` slug-hoz: legalább 1 `groupMembership` ellenőrzés. Ha nincs → **409 `empty_required_groups`** + a hiányzó slug-ok listája.
- Sikeres aktiváláskor a `compiledWorkflowSnapshot.requiredGroupSlugs` is rögzítődik (a futó pub immune marad workflow-változásra).

**Slug-collision policy** (két workflow ugyanazt a slug-ot eltérő flag-ekkel hivatkozza):

A `groups` doc a szerkesztőségben **első autoseed-elt jelentés szerint kanonikus** ("first-write wins"). Az idempotens autoseed nem írja felül — tehát ha workflow A először `editors` slug-ot autoseedeli `isContributorGroup: true`-val, és utána workflow B `editors`-t `isContributorGroup: false`-szal kérné, a `groups` doc változatlan marad.

A felhasználói kontroll erre két szinten működik:

1. **Designer mentés-time validáció** — ha a workflow `requiredGroupSlugs[]` olyan slug-ot definiál, amely már létezik a célszerkesztőségben **eltérő flag-ekkel** (`isContributorGroup` vagy `isLeaderGroup`), a Designer mentésekor **`group_slug_collision` warning** jelenik meg. A warning sorolja a konfliktusos mezőket (a meglévő `groups` doc vs. a workflow `requiredGroupSlugs[]` értékei). A felhasználó dönt: (a) elfogadja a meglévő `groups` doc-ot kanonikusként és a workflow flag-eket nem írja felül; (b) explicit `update_group_metadata` CF action-nel frissíti a meglévő doc-ot a workflow szerint (ehhez `group.rename` permission kell).

2. **Hozzárendeléskor / aktiváláskor** — ha autoseed runtime-on talál collision-t, **silent skip** a `groups` doc felülírásra (a meglévő doc érvényes), de a CF response `warnings[]` tömbjében visszaadja a konfliktusos slug-okat. A Dashboard UI ezeket banner-ként megjeleníti, és linket ad a "Csoport szerkesztése" akcióra.

A workflow-snapshot pillanatában a `compiledWorkflowSnapshot.requiredGroupSlugs[]` a workflow saját értékeit rögzíti (mint forrás), de a runtime-engedélyezés a `groups` doc-on alapul (label és flag-ek tekintetében — a slug-tagság a `groupMemberships`-ből jön).

#### A.4. Csoport-életciklus szabályok

- **`slug` immutable**: a `slug` a csoport-doc azonosítója a workflow-hivatkozások szempontjából. Csak a `label`, `description`, `color`, `isContributorGroup`, `isLeaderGroup` szerkeszthetőek (`update_group_metadata` CF). Slug-átnevezés / merge → Phase 2.
- **`archive_group` / `delete_group` blokk**: ha a csoport slug-ja bármely **aktív publikáció** vagy **nem-archivált workflow** `requiredGroupSlugs`-jában szerepel → 409 `group_in_use` + a hivatkozó workflow-k és pub-ok listája. **Plusz**: ha bármely **`articles.contributors`** vagy **`publications.defaultContributors`** JSON-mezőben (a slug **kulcsként** szerepel — ezek slug→userId mapping-ek) → szintén `group_in_use` 409 + a hivatkozó cikkek/pub-ok listája. A meglévő `removeUserFromGroup` CF már a member-eltávolítás után takarítja az orphan kulcsokat (`packages/maestro-server/functions/invite-to-organization/src/main.js:2261-2425`); a csoport-törlés-blokk ezt mintaként használja, csak fordítva — nem kulcs-takarítás, hanem hivatkozás-detektálás és blokk.
- **Csoport-kiürülés warning**: `remove_group_member` CF — ha az utolsó tag eltávolítása + a csoport slug-ja egy aktív (snapshot-tal védett) pub workflow-jának `requiredGroupSlugs`-jában van → engedi a műveletet (snapshot védi a runtime-ot), de UI banner + notification az érintett pub admin-jának.
- **`compiled.statePermissions` szemantika**: a `statePermissions[stateId]` a **forrás-state**-ből történő kimozgatás engedélyét adja meg (lásd `canUserMoveArticle(compiled, userGroups, currentState)` runtime helper) — nem a célállapotba való belépést. A `transitions[].allowedGroups` és a `statePermissions[currentState]` AND-elődik az állapot-átmenet engedélyezésében; a `leaderGroups` tagjai mindkét ellenőrzést megkerülik.

#### A.5. Visszahatás a meglévő adatmodellre

A `groups` collection **séma változatlan** ([[workflow-designer/DATA_MODEL#groups]]): `slug`, `label`, `editorialOfficeId`, `organizationId`, `color`, `isContributorGroup`, `isLeaderGroup`, `description`, `createdAt`. A `groupMemberships` is változatlan. Ami **változik**: a definíció-forrás (workflow → autoseed), és a CRUD szabályok (slug immutable, törlés-blokk).

### B. `permissionSets` réteg

#### B.1. Adatmodell

**Új collection: `permissionSets`**

| Mező | Típus | Leírás |
|---|---|---|
| `name` | string | UI-ban látszó név (pl. "Szerkesztő alap") |
| `slug` | string | Egyedi szerkesztőség-szinten (pl. `editor_base`) |
| `description` | string, opcionális | UI-tooltip |
| `permissions` | string[] | Permission slug-ok listája (pl. `["workflow.state.edit", "publication.edit"]`) |
| `editorialOfficeId` | string | Scope |
| `organizationId` | string | Scope |
| `archivedAt` | datetime, nullable | Soft-delete |
| `createdByUserId` | string | Tulajdonos |

**Új collection: `groupPermissionSets` (m:n junction)**

| Mező | Típus | Leírás |
|---|---|---|
| `groupId` | string | Hivatkozott `groups` doc |
| `permissionSetId` | string | Hivatkozott `permissionSets` doc |
| `editorialOfficeId` | string | Scope |
| `organizationId` | string | Scope |

Doc-szintű ACL mindkét új collection-ön: `buildOfficeAclPerms()` ([[Döntések/0003-tenant-team-acl|ADR 0003]] minta), `rowSecurity: true`.

#### B.2. Permission slug konvenció

**Formátum**: `<resource>.<action>` vagy `<resource>.<sub_resource>.<action>` (pl. `workflow.state.edit`).

**Logikai csoportok** (UI mátrix):

- **Szervezet**: `org.rename`, `org.delete`, `org.member.invite`, `org.member.remove`, `org.member.role.change`
- **Szerkesztőség**: `office.create`, `office.rename`, `office.delete`, `office.settings.edit`
- **Felhasználó-csoportok**: `group.create` (manuális), `group.rename`, `group.delete`, `group.member.add`, `group.member.remove`
- **Jogosultság-csoportok**: `permissionSet.create`, `permissionSet.edit`, `permissionSet.archive`, `permissionSet.assign`
- **Bővítmények**: `extension.create`, `extension.edit`, `extension.archive`
- **Kiadvány**: `publication.create`, `publication.edit`, `publication.archive`, `publication.activate`, `publication.workflow.assign`, `publication.settings.edit`
- **Workflow CRUD**: `workflow.create`, `workflow.edit`, `workflow.archive`, `workflow.duplicate`, `workflow.share`
- **Workflow-tartalom**: `workflow.state.edit`, `workflow.transition.edit`, `workflow.permission.edit`, `workflow.requiredGroups.edit`, `workflow.validation.edit`, `workflow.command.edit`

**Coarse granularitás**: 38 slug a 8 logikai csoportban (`org.*` 5 — **org-scope**, `office.*` 4, `group.*` 5, `permissionSet.*` 4, `extension.*` 3, `publication.*` 6, `workflow.*` 5 CRUD, `workflow.<sub>.*` 6 tartalom — utóbbi 7 csoport, 33 slug **office-scope**). Egy slug több CF-action-t fed le (pl. `workflow.edit` engedi a `update_workflow_metadata` és `update_workflow_compiled` CF-eket egyaránt). A kanonikus slug-katalógust a [[Komponensek/PermissionTaxonomy]] atomic note tartalmazza — slug-bővítés / -szétválasztás ott történik.

A `permissionSets.permissions[]` mező CSAK office-scope slug-okat tárol — az `org.*` slug-ok server-oldali validáció miatt nem engedettek (lásd B.3 `org_scope_slug_not_allowed`). Egy permission set vegyesen tartalmazhat dashboard-CRUD és workflow-műveleti office-scope slug-okat.

#### B.3. Permission helper-ek (két scope: org + office)

**Slug-scope szétválasztás**: a 38 slug két scope-ra oszlik:
- **5 org-scope slug** (`org.*`): `org.rename`, `org.delete`, `org.member.invite`, `org.member.remove`, `org.member.role.change`. Ezek **kizárólag** `organizationMemberships.role` alapján döntődnek el — soha nem jönnek `permissionSets.permissions[]`-ből (server-side validáció).
- **33 office-scope slug** (minden, ami NEM `org.*`): `office.*`, `group.*`, `permissionSet.*`, `extension.*`, `publication.*`, `workflow.*`, `workflow.<sub>.*`. Ezek `permissionSets`-en át adhatók, és az `editorialOfficeId` scope-ban érvényesek.

Új modul: `packages/maestro-shared/permissions.js`:

```js
// Office-scope helper (33 slug):
async function userHasPermission(user, permissionSlug, editorialOfficeId) {
  if (user.labels?.includes('admin')) return true;

  if (permissionSlug.startsWith('org.')) {
    throw new Error(
      `userHasPermission() office-scope only — use userHasOrgPermission() for "${permissionSlug}".`
    );
  }

  // Org-membership role override (a useOrgRole-rel konzisztens):
  const organizationId = await lookupOrgIdFromOffice(editorialOfficeId);
  const orgRole = await lookupOrgRole(user.id, organizationId);
  if (orgRole === 'owner' || orgRole === 'admin') return true; // mindketten 33 office-scope slug-ot kapnak

  // Permission set lookup (member + specifikus szerepek):
  return checkPermissionSetLookup(user, permissionSlug, editorialOfficeId);
}

// Org-scope helper (5 slug):
async function userHasOrgPermission(user, orgPermissionSlug, organizationId) {
  if (user.labels?.includes('admin')) return true;
  if (!orgPermissionSlug.startsWith('org.')) {
    throw new Error(
      `userHasOrgPermission() org-scope only — use userHasPermission() for "${orgPermissionSlug}".`
    );
  }

  const orgRole = await lookupOrgRole(user.id, organizationId);
  if (orgRole === 'owner') return true;                                              // 5 slug
  if (orgRole === 'admin' && !ADMIN_EXCLUDED_SLUGS.has(orgPermissionSlug)) return true; // 3 slug
  return false; // member-nek nincs org-scope slug-ja a permission set-rendszerben
}

const ADMIN_EXCLUDED_SLUGS = new Set(['org.delete', 'org.rename']);
```

**`permissionSets.permissions[]` validáció**: a `create_permission_set` / `update_permission_set` CF action minden slug-ra ellenőrzi, hogy NEM `org.*`-prefixű — különben **400 `org_scope_slug_not_allowed`** error a slug-listával. Ez biztosítja, hogy az `org.*` slug-ok kizárólag az org-membership role-on át jönnek, nem permission set-en át.

Plugin- és server-oldalon egyaránt használt. A user oldali `user.permissions` mezőt a [[Komponensek/UserContext]] `enrichUserWithGroups()` (mostantól `enrichUserWithPermissions()` is) számolja — `groupSlugs` → permission set lookup → unique office-scope permission slug array. (Az `org.*` slug-ok NEM kerülnek a `user.permissions`-be — ott külön `user.orgRole` mező hordozza az `owner`/`admin`/`member` role-t per `organizationId`.)

**Bootstrap-cutover stratégia**: új szervezet 0 felhasználó-csoporttal indul (workflow-driven). Az org owner mégis azonnal CRUD-jogosult, mert az **`organizationMemberships.role === 'owner'` automatikusan minden 33 office-scope slug-ot megad** a `userHasPermission()` 2. lépésében + minden 5 org-scope slug-ot a `userHasOrgPermission()`-ben. Ugyanígy az admin: 33 office-scope + 3 org-scope (kivéve `org.delete`/`org.rename`). Ez kompatibilis a meglévő [[Komponensek/useOrgRole|useOrgRole]] hookkal — a frontend role-gate ugyanazt a logikát fejezi ki, csak más néven.

A `permissionSets` (member-szintű specifikus jogok) csak akkor lép működésbe, ha a user nem owner / admin, ÉS van `groupMembership` valamely csoportban, amihez `groupPermissionSets` tartozik. Az org-scope műveletek (`org.*`) ekkor sem érhetők el.

**Cache stratégia**: a `userHasPermission()` minden hívás 3 collection-lépést jár be (`organizationMemberships` → `groupMemberships` → `groupPermissionSets` → `permissionSets`). Cache nélkül egy CF action több guard-hívással lassú lenne.

- **Per-request memoizáció (server CF)**: minden CF entry-pointnál egyszer számoljuk ki a user `permissionSnapshot`-ját (`{ userId, editorialOfficeId, orgRole, permissionSlugs: Set<string> }`), és minden további `userHasPermission()` hívás ezt használja request-szinten.
- **Office-scope cache (Plugin + Dashboard)**: a [[Komponensek/UserContext]] (Plugin) és [[Komponensek/AuthContext]] (Dashboard) az `enrichUserWithGroups()`-ban kiszámolja a `user.permissions: Set<string>` snapshotot office-scope-ban. Realtime invalidálódik:
  - `groupMemberships` change (a user-é) → újraszámolás
  - `groupPermissionSets` change (érintett `groupId` esetén) → újraszámolás
  - `permissionSets.permissions[]` change (érintett `permissionSetId`) → újraszámolás
  - `organizationMemberships` change (orgRole-váltás) → újraszámolás
- **Plugin client-side guard**: a `useElementPermission` és társai a `user.permissions` cache-ből döntenek (NEM hívnak server-side `userHasPermission()`-t). A server-side CF guard a végső authority — kliens-bypass-t a server állít meg.

A cache invalidáció a [[Komponensek/RealtimeBus|realtimeBus]] csatornáin keresztül érkezik; a server-side per-request memoizáció minden CF hívás elején ürül.

#### B.4. Default permission set seed

`bootstrap_organization` CF kibővítés — 3 default permission set seedelése (workflow-driven csoport-seed nincs, csak permission set):

> A `permissionSets.permissions[]` mező CSAK office-scope slug-okat tartalmazhat (validáció: lásd B.3). Az `org.*` slug-okat soha nem seedeljük permission set-be — azokat a `userHasOrgPermission()` az `organizationMemberships.role`-ból oldja fel.

| Permission set slug | Név | Mit fed le |
|---|---|---|
| `owner_base` | Tulajdonos alap | 33 office-scope slug. Az org-szintű 5 `org.*` slug az `organizationMemberships.role === 'owner'`-ből jön — nem ebből a set-ből. |
| `admin_base` | Adminisztrátor alap | Tartalom-azonos `owner_base`-szel (33 office-scope slug). A megkülönböztetés csak az `org.*`-okon van: az admin-role kapja az `org.member.*`-ot, de NEM kapja az `org.delete`/`org.rename`-et — ez kizárólag a role-on át. |
| `member_base` | Tag alap | `publication.create`, `publication.activate`, `workflow.duplicate` — saját kezdeményezésű műveletek. A tényleges cikk-szintű munka-jog a workflow-runtime-ból ered (`canUserMoveArticle()`), nem permission set-ből. Részletes magyarázat: [[Komponensek/PermissionTaxonomy#`member_base` — Tag alap]]. |

A bootstrap NEM rendel hozzá a permission set-eket csoportokhoz (mert csoport még nincs).

#### B.5. CF guard-ok

Minden új és érintett CF action a megfelelő scope-ú helperrel védett: **office-scope** action `userHasPermission()`, **org-scope** action `userHasOrgPermission()`. A meglévő `update-article` state-permission validáció **változatlan** (workflow-runtime, ortogonális).

Példa office-scope CF guard mintája:

```js
// create_workflow CF (office-scope)
const { editorialOfficeId } = req.body;
if (!await userHasPermission(user, 'workflow.create', editorialOfficeId)) {
  return res.status(403).json({ error: 'insufficient_permission', slug: 'workflow.create' });
}
```

Példa org-scope CF guard mintája:

```js
// rename_organization CF (org-scope)
const { organizationId } = req.body;
if (!await userHasOrgPermission(user, 'org.rename', organizationId)) {
  return res.status(403).json({ error: 'insufficient_permission', slug: 'org.rename' });
}
```

### C. Két réteg integrációja

| Művelet | Permission set guard | Workflow-runtime guard |
|---|---|---|
| Workflow létrehozás | `workflow.create` | — |
| Workflow szerkesztés (Designer) | `workflow.edit` | — |
| `requiredGroupSlugs` szerkesztés | `workflow.requiredGroups.edit` | — |
| `statePermissions` szerkesztés | `workflow.permission.edit` | — |
| Cikk állapot-átmenet | — | `canUserMoveArticle(compiled, user.groupSlugs, currentState)` — a forrás `statePermissions[currentState]` ÉS a `transitions.allowedGroups` AND-je (`leaderGroups` mindkettőt megkerüli) |
| Cikk-mező szerkesztés | — | `canEditElement(compiled, scope, fieldKey, user.groupSlugs)` — `elementPermissions.*.*` |
| Felhasználó-csoport CRUD | `group.create` / `group.delete` | — |
| Tag hozzáadása csoporthoz | `group.member.add` | — |

A két réteg **AND-elődik** a CF guardokban: workflow-runtime művelet (cikk-frissítés) ÉS permission set műveletek (CRUD) egymástól független ellenőrzések.

## Alternatívák

| Opció | Mellette | Ellene |
|---|---|---|
| **Status quo + új permission rendszer csak (workflow csoportok marad mint ma)** | Egyszerűbb adatmodell | A 7-default seed feltételezés továbbra is megmarad, és nem skálázik a self-contained workflow-modellre. A Tervek 1. pontja kifejezetten ezt változtatja |
| **Workflow-driven groups + `user.labels` admin override** (permission set nélkül) | Minimális adatmodell-bővítés | Nem skálázik granulárisra ("publikáció létrehozhat, de archiválni nem" típusú szabályok nem fejezhetőek ki) |
| **Workflow-driven groups + permission set scope-onként külön collection** | Dashboard-permission és workflow-permission tisztán szétválasztva | Két új collection helyett három — felesleges komplikáció, a slug-konvenció (`workflow.*` / `dashboard nélküli` prefix) elég a logikai szétválasztáshoz |
| **Workflow-driven groups + `permissionSets` (választott)** | Mindkét igény lefedve, m:n granuláris, snapshot-pattern megőrzött, slug-konvenció scope-jelölést helyettesít | Két új collection, új helper, új CF guards-réteg minden action-ön |

## Következmények

### Pozitív

- **Workflow first-class entity csoport-listával** — a workflow magával hozza a saját szerepköreit, és a publikáció-aktiválás validáltan csak akkor indulhat, ha a tagság feltételezett.
- **Granuláris jogosultsági modell** — coarse 38 slug, mátrix-UI-val átláthatóan szerkeszthető. Bővíthető Phase 2-ben gomb-szintűre, ha tényleges igény jön.
- **Slug-stabilitás megőrződik** — a `groups.slug` immutable; a `groups.label`, `description`, `color`, `isContributorGroup`, `isLeaderGroup` szerkeszthetőek; a `permissionSets.permissions[]` slug-jai a `<resource>.<action>` formátumban dokumentáltak.
- **Snapshot-pattern konzisztens** — a `compiledWorkflowSnapshot` mostantól `requiredGroupSlugs`-szal együtt, futó pub immune marad.

### Negatív / trade-off

- **Két új collection + egy új helper modul** — `permissionSets`, `groupPermissionSets`, `maestro-shared/permissions.js`.
- **Workflow-aktiválás lassabb** — autoseed + tag-validáció + permission set lookup.
- **UI komplexitás** — három új tab/oldal (`UserGroupsTab`, `PermissionSetsTab`, Workflow Designer "Felhasználó-csoportok" tab).
- **Minden új CF action `userHasPermission()` guard** kötelezően. A meglévő CF action-ök retrofit-elése egyszeri munka (~10-15 action).
- **Cache komplexitás** — kétrétegű (per-request memoizáció + office-scope kliens-cache) Realtime-invalidációval. Tévesen kezelt invalidáció vagy stale snapshot security-bypass-t jelenthet (kliens cache esetén csak UX, server-side csak per-request → kis blast-radius).
- **Slug-collision sub-state** — két workflow ugyanazt a slug-ot eltérő flag-ekkel hivatkozhatja. First-write wins az autoseed pillanatában; a felhasználói döntés explicit `update_group_metadata` action-en át.

### Új kötelezettségek

- Minden új és módosított CF action a megfelelő helperrel guardol: **office-scope** action `userHasPermission(user, slug, editorialOfficeId)`, **org-scope** action `userHasOrgPermission(user, orgSlug, organizationId)`. A meglévő `bootstrap_organization`-szerű publikus action-ök kivételek.
- A `permissionSets.permissions[]` **kötelezően office-scope-ra korlátozott** — az `org.*` slug-okat a `create_permission_set` / `update_permission_set` 400 `org_scope_slug_not_allowed`-szal elutasítja. Ez biztosítja, hogy az org-szintű jogokat soha nem lehet permission-set-en keresztül "kiosztani".
- Server-side per-request memoizáció (`permissionSnapshot`) mindkét helperhez kötelező — kliens-cache csak UX.
- A Realtime cache-invalidáció érintett collection-jei (`groupMemberships`, `groupPermissionSets`, `permissionSets`, `organizationMemberships`) mindegyikére kötelező a `subscribeRealtime()` ([[Komponensek/RealtimeBus]]) handler — a stale `user.permissions` snapshot security UX-bypass-szal jár.
- Workflow Designer mentés előtt validál: a workflow összes slug-hivatkozó mezőjének (`transitions[].allowedGroups`, `commands[*].allowedGroups`, `elementPermissions.*.*.groups`, `leaderGroups`, `statePermissions.*`, `contributorGroups[].slug`, `capabilities.*`) minden slug-ja szerepeljen a `requiredGroupSlugs[].slug` halmazban. Ha nem teljesül → `unknown_group_slug` mentési error.
- A `compiled.contributorGroups[]` és `compiled.leaderGroups[]` automatikusan generálódnak a compiler által — soha nem szerkesztett közvetlenül.
- `slug` immutable enforcement: minden `update_group_metadata` CF action-ben kötelező a `slug` mező-átírás 400-as elutasítása.
- Default permission set-eket a `bootstrap_organization` automatikusan hozza létre. Ha új default kell, ott a kódban módosul.
- Aktivált publikáció `compiledWorkflowSnapshot.requiredGroupSlugs` mezőjét a runtime soha nem írhatja felül — a workflow változások csak az új aktiválásra hatnak.

## Implementáció (kulcsfájlok)

| Modul | Felelősség |
|---|---|
| `packages/maestro-server/.../bootstrap_organization` | Default csoport seed kivétele; permission set default seed (`owner_base`, `admin_base`, `member_base`) |
| `packages/maestro-server/.../assign_workflow_to_publication` | Autoseed minden `requiredGroupSlugs` slug-ra (idempotens) |
| `packages/maestro-server/.../activate_publication` | Autoseed (idempotens) + min. 1 tag validáció + snapshot `requiredGroupSlugs` mentés |
| `packages/maestro-server/.../update_group_metadata` | `slug` immutable enforcement (csak `label`, `description`, `color`, `isContributorGroup`, `isLeaderGroup`) |
| `packages/maestro-server/.../archive_group` (és `delete_group`) | `group_in_use` blokk, ha aktív pub vagy nem-archivált workflow `requiredGroupSlugs`-ban; **plusz** ha bármely `articles.contributors` vagy `publications.defaultContributors` JSON-mezőben kulcsként szerepel |
| `packages/maestro-server/.../remove_group_member` | Üres-csoport detektálás, warning + notification (engedi) |
| `packages/maestro-server/.../create_permission_set` (+ update, archive) | Új CF action-ök |
| `packages/maestro-server/.../assign_permission_set_to_group` (+ unassign) | M:n junction CRUD |
| `packages/maestro-server/.../bootstrap_permission_sets_schema` | Új schema bootstrap CF |
| `packages/maestro-shared/permissions.js` | Két helper: `userHasPermission(user, slug, editorialOfficeId)` (33 office-scope slug — admin label → org-role → permission set lookup) és `userHasOrgPermission(user, orgSlug, organizationId)` (5 org-scope slug — admin label → org-role only). `permissionSets.permissions[]` validáció: `org.*` prefix tilos. Per-request memoizáció `permissionSnapshot`-tal. |
| `packages/maestro-server/.../assign_workflow_to_publication` (+ Designer compiler) | Slug-collision detektálás: ha `requiredGroupSlugs[]` flag-jei eltérnek a meglévő `groups` doc flag-jeitől → `group_slug_collision` warning a response `warnings[]`-ban (NEM blokk; a meglévő `groups` doc kanonikus) |
| `packages/maestro-shared/groups.js` | `DEFAULT_GROUPS` konstans **eltávolítva** (workflow-driven a forrás) |
| `packages/maestro-dashboard/.../UserGroupsTab.jsx` | Új tab: csoport-lista, tagok, `label`/`description`/`color`/`isContributorGroup`/`isLeaderGroup` szerkesztése (a `slug` immutable!), törlés (`group_in_use` validációval) |
| `packages/maestro-dashboard/.../PermissionSetsTab.jsx` | Új tab: lista, létrehozás, archiválás |
| `packages/maestro-dashboard/.../PermissionSetEditor.jsx` | Modal vagy oldal: 8 logikai csoport-fa + 38 checkbox-opció ([[Komponensek/PermissionTaxonomy]]) |
| `packages/maestro-dashboard/.../EditorialOfficeGroupsTab.jsx` | Bővítés: csoporthoz `permissionSet` hozzárendelés (multi-select) |
| `packages/maestro-dashboard/.../WorkflowDesignerPage.jsx` | Új tab/szekció: `requiredGroupSlugs` szerkesztése |
| `packages/maestro-dashboard/.../publications/PublicationActivateDialog.jsx` | `empty_required_groups` 409 kezelés: hiányzó csoportok modal + "Tagok hozzáadása" CTA |
| `packages/maestro-indesign/.../UserContext.jsx` | `enrichUserWithGroups()` bővítés: `permissionSets` betöltés + `user.permissions` array |
| `packages/maestro-indesign/.../useElementPermission.js` | `groupSlugs` (workflow-runtime) + `user.permissions` (új réteg) együtt értékelve |

## Kapcsolódó

- ADR-ek: [[0002-fazis2-dynamic-groups]] (alapozó — `groups` collection változatlan), [[0003-tenant-team-acl]] (ACL minta), [[0006-workflow-lifecycle-scope]] (workflow lifecycle + snapshot-pattern), [[0007-workflow-extensions]] (extension-CRUD beilleszkedik a permission rendszerbe Phase 0-tól)
- Tervek: [[Tervek#Jogosultsági rendszer]]
- Komponensek: [[Komponensek/UserContext]], [[Komponensek/DataContext]], [[Komponensek/AuthContext]], [[Komponensek/useOrgRole]], [[Komponensek/WorkflowLibrary]], [[Komponensek/PermissionTaxonomy]] (új, A.1.1 feladat)
- Csomagok: [[Csomagok/dashboard-workflow-designer]]
