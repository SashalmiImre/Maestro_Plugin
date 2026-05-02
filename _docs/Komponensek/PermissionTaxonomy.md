---
tags: [komponens, jogosultság, permission, dashboard, workflow, proposed]
aliases: [PermissionTaxonomy, Permission slugs, Jogosultság-opciók]
---

# PermissionTaxonomy (Proposed)

> **Státusz**: tervezett. Részletes ADR: [[Döntések/0008-permission-system-and-workflow-driven-groups]].

## Cél

A jogosultsági rendszer **coarse-granularitású** (38 slug — 5 org-scope + 33 office-scope) permission opció-listája 8 logikai csoportba szervezve. Egyetlen kanonikus referencia minden `permissionSets.permissions[]` mezőhöz, az `userHasPermission(user, slug, editorialOfficeId)` (office-scope) és `userHasOrgPermission(user, orgSlug, organizationId)` (org-scope) CF guardhoz.

A részletes finomítás (új slug felvétele, slug-szétválasztás, opció-átnevezés) ITT történik — az ADR a stabil koncepciót rögzíti, ez a note a változó listát.

## Helye (tervezett)

- **Shared kontraktus**: `packages/maestro-shared/permissions.js` — a slug-konstansok és a `userHasPermission()` helper.
- **Server CF guard**: minden új és módosított CF action `userHasPermission()` hívással ellenőrzi a permission slug-ot.
- **Plugin runtime**: [[UserContext]] `enrichUserWithGroups()` számolja a `user.permissions` array-t.
- **Dashboard UI**: Permission set szerkesztő (`PermissionSetsTab.jsx`) checkbox-mátrixa ezt a struktúrát rendereli.

## Slug-konvenció + scope

**Formátum**: `<resource>.<action>` vagy `<resource>.<sub_resource>.<action>` (pl. `workflow.state.edit`).

A 38 slug **két scope**-ra oszlik:
- **Org-scope (5 slug)** — `org.*` prefix. **Kizárólag** `organizationMemberships.role` dönt róluk (`userHasOrgPermission()`). **Soha** nem tárolható `permissionSets.permissions[]`-ben (server-side validáció: 400 `org_scope_slug_not_allowed`).
- **Office-scope (33 slug)** — `office.*`, `group.*`, `permissionSet.*`, `extension.*`, `publication.*`, `workflow.*`, `workflow.<sub>.*`. Ezek `permissionSets`-en át adhatók egy adott `editorialOfficeId` scope-ban (`userHasPermission()`).

A slug-prefix maga jelöli a logikai csoportot ÉS a scope-ot — nincs külön `scope` mező a `permissionSets` collection-en. Egy office-scope permission set vegyesen tartalmazhat dashboard- és workflow-műveleti slug-okat (de soha `org.*`-ot).

## Logikai csoportok

### 1. Szervezet — `org.*` (**org-scope**, csak `userHasOrgPermission()`)

| Slug | Leírás |
|---|---|
| `org.rename` | Szervezet nevének módosítása |
| `org.delete` | Szervezet törlése (irreverzibilis) |
| `org.member.invite` | Felhasználó meghívása a szervezetbe |
| `org.member.remove` | Felhasználó eltávolítása a szervezetből |
| `org.member.role.change` | Szerepkör módosítása (owner / admin / member) |

### 2. Szerkesztőség — `office.*`

| Slug | Leírás |
|---|---|
| `office.create` | Új szerkesztőség létrehozása a szervezetben |
| `office.rename` | Szerkesztőség átnevezése |
| `office.delete` | Szerkesztőség törlése |
| `office.settings.edit` | Szerkesztőség beállítások szerkesztése |

### 3. Felhasználó-csoportok — `group.*`

| Slug | Leírás |
|---|---|
| `group.create` | Manuális (workflow-független) csoport létrehozása |
| `group.rename` | Csoport `label`, `description`, `color`, `isContributorGroup`, `isLeaderGroup` szerkesztése (a `slug` immutable) |
| `group.delete` | Csoport törlése (`group_in_use` validációval) |
| `group.member.add` | Tag hozzáadása csoporthoz |
| `group.member.remove` | Tag eltávolítása csoportból |

### 4. Jogosultság-csoportok — `permissionSet.*`

| Slug | Leírás |
|---|---|
| `permissionSet.create` | Új permission set létrehozása |
| `permissionSet.edit` | Permission set szerkesztése (név, opciók) |
| `permissionSet.archive` | Permission set archiválása |
| `permissionSet.assign` | Permission set hozzárendelése felhasználó-csoporthoz |

### 5. Bővítmények — `extension.*`

> [[WorkflowExtension|Workflow Extensions]] ([[Döntések/0007-workflow-extensions|ADR 0007]]) Phase 0-tól ebbe a permission-fába illeszkedik.

| Slug | Leírás |
|---|---|
| `extension.create` | Új workflow extension létrehozása |
| `extension.edit` | Extension kód / metadata szerkesztése |
| `extension.archive` | Extension archiválása |

### 6. Kiadvány — `publication.*`

| Slug | Leírás |
|---|---|
| `publication.create` | Új kiadvány létrehozása |
| `publication.edit` | Kiadvány metadata szerkesztése (név, határidők) |
| `publication.archive` | Kiadvány archiválása |
| `publication.activate` | Kiadvány aktiválása workflow-val (snapshot mentés) |
| `publication.workflow.assign` | Workflow hozzárendelése kiadványhoz |
| `publication.settings.edit` | Kiadvány-beállítások szerkesztése |

### 7. Workflow CRUD — `workflow.*` (a tartalom-szerkesztésen kívül)

| Slug | Leírás |
|---|---|
| `workflow.create` | Új workflow létrehozása |
| `workflow.edit` | Designer-elérés (tartalom-szerkesztés általános engedélye) |
| `workflow.archive` | Workflow archiválása (soft-delete) |
| `workflow.duplicate` | Workflow duplikálása (cross-tenant `public` / `organization` source-ról is) |
| `workflow.share` | Workflow `visibility` módosítása (`editorial_office` / `organization` / `public`) |

### 8. Workflow-tartalom — `workflow.<sub>.*` (designer-en belül)

> Ezek a `workflow.edit` master-permission birtokában finomhangolt szerkesztő-jogok. Ha valakinek nincs `workflow.edit`-je, ezek nem alkalmazódnak.

| Slug | Leírás |
|---|---|
| `workflow.state.edit` | Állapotok szerkesztése (létrehozás, törlés, átnevezés, szín) |
| `workflow.transition.edit` | Átmenetek szerkesztése (from → to élek) |
| `workflow.permission.edit` | `compiled.statePermissions` szerkesztése — forrás-state-enként ki mozgathatja ki onnan a cikket (csoport-slug-listák) |
| `workflow.requiredGroups.edit` | `compiled.requiredGroupSlugs[]` szerkesztése |
| `workflow.validation.edit` | Validátorok hozzárendelése állapotokhoz |
| `workflow.command.edit` | Parancsok hozzárendelése állapotokhoz |

## Default permission set-ek

A `bootstrap_organization` CF a következő 3 default permission set-et seedeli minden új szervezetnek. Csoporthoz nincsenek hozzárendelve (mert csoport még nincs) — az org owner / admin manuálisan rendel hozzá vagy testreszab.

### `owner_base` — Tulajdonos alap

**Tartalom**: 33 office-scope slug (a 2–8 csoport teljes listája). Az 1. csoport (`org.*` 5 slug) NEM kerül a permission set-be — azokat az `organizationMemberships.role === 'owner'` ad meg automatikusan.

### `admin_base` — Adminisztrátor alap

**Tartalom**: tartalom-azonos `owner_base`-szel (33 office-scope slug). A különbség **NEM** a permission set-ben, hanem az `organizationMemberships.role`-ban: az `admin` role 3 org-scope slug-ot kap (`org.member.invite/remove/role.change`), de NEM kapja az `org.delete`/`org.rename`-et — ezt a `userHasOrgPermission()` dönti el.

> Az `admin_base` permission set létezésének értelme: ha egy felhasználó **NEM org-admin** (csak member az org-scope-on), de office-szinten admin-jellegű jogokat kell kapjon, ez a set hozzárendelhető a csoportjához. A 33 office-scope slug elég ehhez.

### `member_base` — Tag alap

**Tartalom**:
- `publication.create` — saját office-ára publikáció létrehozás
- `publication.activate` — saját pub aktiválása
- `workflow.duplicate` — `public` / `organization` workflow forkolása saját office-ára

> A member tényleges munka-jogát NEM ez adja: a workflow-runtime `canUserMoveArticle(compiled, user.groupSlugs, currentState)` (forrás-state `statePermissions[currentState]` ÉS `transitions.allowedGroups` AND-je, `leaderGroups` mindkettőt megkerüli) dönti el a cikk-szintű állapot-átmenet végrehajthatóságát. A `member_base` csak a CF action-szintű engedélyek ezen három "saját kezdeményezésre" történő művelethez.

## Két réteg integrációja

| Művelet | `permissionSets` guard | Workflow-runtime guard |
|---|---|---|
| Workflow létrehozás | `workflow.create` | — |
| Workflow szerkesztés (Designer) | `workflow.edit` + tartalom slug-jai | — |
| Cikk állapot-átmenet | — | `canUserMoveArticle(compiled, user.groupSlugs, currentState)` — forrás-state `statePermissions[currentState]` ÉS `transitions.allowedGroups` AND-je (`leaderGroups` mindkettőt megkerüli) |
| Cikk-mező szerkesztés | — | `compiled.elementPermissions.article[field]` |
| Felhasználó-csoport CRUD | `group.create` / `group.delete` | — |

A két réteg **AND-elődik** — egy CF action akkor fut le, ha mindkét guard engedi.

## Phase 2 split candidates

A jelenlegi 38 slug **coarse** — minimum az alábbi slug-ok valószínűleg **ketté kell vágni** Phase 2-ben, ha a felhasználói visszajelzések finomabb kontrollt igényelnek:

| Master slug | Várható Phase 2 split | Indok |
|---|---|---|
| `workflow.edit` | `workflow.designer.access` (designer-megnyitás) + `workflow.compiled.save` (mentés) | Ma egy slug fedi a "megnézhetem-e a designerben" és a "menthetek is" különbséget. Egy reviewer-szerep mehet read-only designer-be, de mentést ne kapjon. |
| `publication.activate` | `publication.activate.start` (kezdeményezés) + `publication.activate.confirm` (megerősítés / blokk-felülírás) | A 409 `empty_required_groups` esetében az override külön jog lehet — kis csoport admin-ja megerősíthet, de tag nem indíthat aktiválást. |
| `group.member.remove` | `group.member.remove.self` (saját kilépés) + `group.member.remove.other` (mások eltávolítása) | A "kilép a csoportból" tag-jog, az "eltávolít másokat" admin-jog. |

A split tervezésekor figyelembe veendő: az új slug-ok a meglévők **mellé** kerülnek (a régi marad mint `legacy_master_slug`), és a permission set-eket a felhasználók manuálisan migrálhatják. A `workflow.edit` master-marker a legrosszabb candidate — ha ez ketté megy, minden meglévő permission set-et át kell nézni.

## Slug-frissítés szabályai

- **Új slug felvétele**: új sor a megfelelő logikai csoport táblájába + `permissions.js` konstans-frissítés + minden hivatkozó CF action guard-frissítés. Existing permission set-ek nem érzik (a permission set csak az adott slug-okat tartalmazó subset-et engedi).
- **Slug-átnevezés**: kerülendő. Ha nem elkerülhető, akkor a régi slug deprecated marad egy ideig, az új slug mellé kerül, a permission set-eket a felhasználók manuálisan migrálhatják.
- **Slug-törlés**: csak ha 0 `permissionSets.permissions[]`-ben hivatkozik rá. Indok: a permission rendszer "engedmény-logikájú" — ha egy slug törölve, a hivatkozó set-ek számára egyszerűen "nem létező permission" lesz.

## Kapcsolódó

- ADR: [[Döntések/0008-permission-system-and-workflow-driven-groups]]
- Tervek: [[Tervek#Jogosultsági rendszer]]
- Komponensek: [[UserContext]], [[useOrgRole]], [[WorkflowLibrary]], [[WorkflowExtension]]
- Csomag: [[Csomagok/dashboard-workflow-designer]]
