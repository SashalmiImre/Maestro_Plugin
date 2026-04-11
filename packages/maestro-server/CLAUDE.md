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
    ├── article-update-guard/          ← Cikk frissítés guard (állapotátmenet + jogosultság + contributor)
    │   ├── package.json
    │   └── src/main.js
    ├── validate-article-creation/     ← Cikk létrehozás validáció (publicationId, state, contributor-ok)
    │   ├── package.json
    │   └── src/main.js
    ├── validate-publication-update/   ← Kiadvány módosítás validáció (default contributor-ok, rootPath)
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
    ├── migrate-legacy-paths/          ← Régi útvonalak batch migrációja (manuális, DRY_RUN)
    │   ├── package.json
    │   └── src/main.js
    ├── invite-to-organization/        ← Tenant management (bootstrap + create + accept egy CF-ben)
    │   ├── package.json
    │   └── src/main.js
    └── team/                          ← DEPRECATED (Fázis 2: groupMemberships collection váltotta ki)
```

---

## Function-ök Összefoglalója

| Function ID | Név | Runtime | Timeout | Trigger |
|---|---|---|---|---|
| `article-update-guard` | Article Update Guard | node-18.0 | 30s | `articles.*.update` |
| `validate-article-creation` | Validate Article Creation | node-18.0 | 15s | `articles.*.create` |
| `validate-publication-update` | Validate Publication Update | node-18.0 | 15s | `publications.*.create/update` |
| `cascade-delete` | Cascade Delete | node-18.0 | 15s | `articles/publications.*.delete` |
| `cleanup-orphaned-locks` | Cleanup Orphaned Locks | node-18.0 | 30s | Schedule: `0 3 * * *` |
| `cleanup-orphaned-thumbnails` | Cleanup Orphaned Thumbnails | node-18.0 | 120s | Schedule: `0 4 * * 0` |
| `migrate-legacy-paths` | Migrate Legacy Paths | node-18.0 | 120s | Manuális (HTTP) |
| `invite-to-organization` | Invite To Organization | node-18.0 | 15s | Kliens hívás (HTTP, `execute: ["users"]`) |

---

## Környezeti Változók

### Közös (minden function)

| Változó | Érték | Leírás |
|---|---|---|
| `APPWRITE_API_KEY` | *(secret)* | API kulcs — `MaestroFunctionsKey` (databases.rw, users.rw, files.rw) |
| `APPWRITE_FUNCTION_ENDPOINT` | automatikus | Appwrite végpont (Appwrite beállítja) |
| `APPWRITE_FUNCTION_PROJECT_ID` | automatikus | Projekt ID (Appwrite beállítja) |

### Per-function

| Function | Változók |
|---|---|
| `article-update-guard` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `WORKFLOWS_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`, `GROUPS_COLLECTION_ID`, `GROUP_MEMBERSHIPS_COLLECTION_ID` |
| `validate-article-creation` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `WORKFLOWS_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID` |
| `validate-publication-update` | `DATABASE_ID`, `PUBLICATIONS_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`, `DEADLINES_COLLECTION_ID` |
| `cascade-delete` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `USER_VALIDATIONS_COLLECTION_ID`, `SYSTEM_VALIDATIONS_COLLECTION_ID`, `DEADLINES_COLLECTION_ID`, `LAYOUTS_COLLECTION_ID`, `THUMBNAILS_BUCKET_ID` |
| `cleanup-orphaned-locks` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID` |
| `cleanup-orphaned-thumbnails` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `THUMBNAILS_BUCKET_ID` |
| `migrate-legacy-paths` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `DRY_RUN` |
| `invite-to-organization` | `DATABASE_ID`, `ORGANIZATIONS_COLLECTION_ID`, `ORGANIZATION_MEMBERSHIPS_COLLECTION_ID`, `EDITORIAL_OFFICES_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`, `ORGANIZATION_INVITES_COLLECTION_ID`, `GROUPS_COLLECTION_ID`, `GROUP_MEMBERSHIPS_COLLECTION_ID`, `WORKFLOWS_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID` (csak a delete ágakhoz kell; hiánya esetén a `delete_organization` / `delete_editorial_office` action 500 `misconfigured`-et ad, a többi action nem érintett) |

---

## Jogosultságok (API Key Scopes)

| Function | Szükséges Scopes |
|---|---|
| `article-update-guard` | `databases.read`, `databases.write`, `users.read` |
| `validate-article-creation` | `databases.read`, `databases.write`, `users.read` |
| `validate-publication-update` | `databases.read`, `databases.write`, `users.read` |
| `cascade-delete` | `databases.read`, `databases.write`, `files.read`, `files.write` |
| `cleanup-orphaned-locks` | `databases.read`, `databases.write`, `users.read` |
| `cleanup-orphaned-thumbnails` | `databases.read`, `files.read`, `files.write` |
| `migrate-legacy-paths` | `databases.read`, `databases.write` |
| `invite-to-organization` | `databases.read`, `databases.write`, `users.read` |

> **Megjegyzés**: Jelenleg minden function egyetlen közös API kulcsot használ (`MaestroFunctionsKey`), amely az összes szükséges jogosultsággal rendelkezik.

---

## Működési Leírás

### article-update-guard

Összevont workflow állapotátmenet + contributor validáció. Minden cikk frissítéskor fut.

**Ellenőrzések:**
1. **Sentinel guard** — `modifiedByClientId === 'server-guard'` → skip (végtelen ciklus védelem)
2. **Workflow betöltés** — `workflows` collection-ből az office `editorialOfficeId` alapján, 60s process cache (fail-closed: nincs workflow → state revert)
3. **Parent scope sync (B.8)** — szülő publikáció `editorialOfficeId`/`organizationId` mezőkhöz igazítás
4. **Állapot érvényesség** — `compiled.states` kulcsai között van-e (érvénytelen → első állapot order szerint)
5. **Állapotátmenet** — `previousState → state` a `compiled.transitions` alapján
6. **Scope ellenőrzés (B.8)** — caller user tagja-e a cikk `editorialOfficeId`-jának; nem-tag → state revert
7. **Jogosultság** — felhasználó csoporttagsága (`groupMemberships` + `groups` → slug tömb) a `compiled.statePermissions` és `compiled.leaderGroups` alapján
8. **Contributor mezők** — `contributors` JSON parse → slug-ok iterálása → userId létezés ellenőrzés (log only)
9. **previousState karbantartás** — null esetén inicializálás, revert esetén frissítés

### validate-article-creation

Új cikk létrehozásakor fut. Érvénytelen `publicationId` → cikk törlés. Ellenőrzi a state érvényességét, `contributors` JSON contributor user létezést (érvénytelen userId → nullázás), filePath formátumot.

**Scope ellenőrzés (B.8):** hiányzó `organizationId`/`editorialOfficeId`, parent publication office mismatch, vagy nem-tag caller → cikk törlése (`editorialOfficeMemberships` lookup).

### validate-publication-update

Kiadvány létrehozás/módosításkor fut. `defaultContributors` JSON parse → nem létező userId → nullázás. Legacy rootPath → logolás.

**Scope ellenőrzés (B.8):** create eseménynél hiányzó scope mezők vagy nem-tag caller → publikáció törlése. Update path: nem-tag caller csak logolódik (teljes field-level revert Fázis 6 hatáskör).

**Aktiválás validáció (Dashboard Redesign Fázis 5):** Minden create és update eseménynél, ha a friss dokumentum `isActivated === true`, a CF lefuttatja a `validatePublicationActivationInline()`-t (inline másolat a `maestro-shared/publicationActivation.js`-ből). Ez ellenőrzi: (a) `workflowId` kitöltött, (b) legalább egy deadline létezik, (c) a deadline-ok a teljes `coverageStart..coverageEnd` tartományt átfedés nélkül lefedik és formátum-helyesek. A deadline-ok a `DEADLINES_COLLECTION_ID`-ból kerülnek lekérdezésre (`Query.equal('publicationId', $id)`, limit 500). **Fail-closed**: ha a `DEADLINES_COLLECTION_ID` env var hiányzik, vagy a deadline lekérés dob, vagy a validáció sikertelen → a CF revertel `{ isActivated: false, activatedAt: null }`-re. Ez garantálja, hogy érvénytelen állapot soha nem maradhat a DB-ben, még akkor sem, ha a Dashboard UI-t megkerülik direkt REST hívással.

### cascade-delete

Cikk törléskor: üzenetek, validációk, thumbnailek törlése. Kiadvány törléskor: cikkek törlése (→ rekurzív cascade), layoutok, deadline-ok törlése.

### cleanup-orphaned-locks

Naponta 3:00 UTC. Zárolások ellenőrzése: owner létezik-e, `$updatedAt` > 24h. Feltételek teljesülése → lock feloldás.

### cleanup-orphaned-thumbnails

Hetente vasárnap 4:00 UTC. Storage bucket ↔ DB `thumbnails` mezők összehasonlítása. Nem hivatkozott fájlok törlése. Hibás JSON → abort (nem töröl semmit).

### migrate-legacy-paths

Manuális futtatás. `DRY_RUN=true` alapértelmezett — csak logol. Publications: `/Volumes/...` → kanonikus. Articles: abszolút filePath → relatív.

### invite-to-organization

HTTP CF, három `action`-nel — minden tenant management művelet egy helyen. A tenant collection-öket (organizations, organizationMemberships, editorialOffices, editorialOfficeMemberships, organizationInvites) a **collection-szintű ACL** védi: a kliens `read("users")` joggal rendelkezik (csak olvasás), az írás kizárólag ezen a CF-en keresztül történik API key-jel. Nincs szükség sentinel mezőre vagy külön trigger guard CF-re.

**Bemeneti payload**:
```json
{ "action": "bootstrap_organization" | "create" | "accept" | "add_group_member" | "remove_group_member" | "create_workflow" | "update_workflow" | "delete_organization" | "delete_editorial_office", ... }
```

**Biztonsági megjegyzés**: Korábban létezett egy `organization-membership-guard` trigger CF, amely egy `modifiedByClientId === 'server-guard'` sentinellel engedélyezte az invite-eredetű membership-eket. Ez **kliens-forgeable** volt — bármely hitelesített user beállíthatta a payload-ban. A Codex adversarial review jelezte a kritikus sebezhetőséget, és a javítás ACL-alapú védelemre váltott (B.5 utolsó iteráció, 2026-04-07).

**ACTION='bootstrap_organization'** (onboarding flow):
1. Caller user kötelező (`x-appwrite-user-id` header).
2. Bemeneti mezők: `orgName`, `orgSlug`, `officeName`, `officeSlug` (mind trim + length check + slug regex validáció).
3. **Atomikus 4+14 collection write** API key-jel:
   - `organizations` — `{ name, slug, ownerUserId: callerId }`
   - `organizationMemberships` — `{ organizationId, userId: callerId, role: 'owner', addedByUserId: callerId }`
   - `editorialOffices` — `{ organizationId, name, slug }` (workflowId nullként, Fázis 4 tölti)
   - `editorialOfficeMemberships` — `{ editorialOfficeId, organizationId, userId: callerId, role: 'admin' }`
   - **Fázis 2 — Group seeding**: 7 `groups` dokumentum (`DEFAULT_GROUPS` alapján, scope: officeId + orgId) + 7 `groupMemberships` (a bootstrapping user-t minden csoportba felveszi, denormalizált `userName`/`userEmail`-lel).
4. **Best-effort rollback**: ha a 2-3-4. lépésnél hiba van, a már létrehozott rekordokat visszatörli fordított sorrendben (try/catch minden cleanup lépésen). A group seeding hiba nem akadályozza meg az org bootstrap sikerét (`groupsSeeded: false` a response-ban).
5. Slug ütközés: `org_slug_taken` / `office_slug_taken` (409).
6. Response: `{ success: true, organizationId, editorialOfficeId }`.

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

**Hibakódok** (mind a `fail()` wrapperen keresztül `{ success: false, reason, ...extra }` formátumban):
`invalid_payload`, `invalid_action`, `unauthenticated`, `missing_fields`, `invalid_slug`, `org_slug_taken`, `org_create_failed`, `membership_create_failed`, `office_slug_taken`, `office_create_failed`, `office_membership_create_failed`, `invalid_email`, `invalid_role`, `not_a_member`, `insufficient_role`, `invite_not_found`, `invite_not_pending`, `invite_expired`, `email_mismatch`, `caller_lookup_failed`, `group_not_found`, `target_user_not_found`, `group_member_create_failed`, `misconfigured`, `office_not_found`, `office_fetch_failed`, `cascade_failed`, `office_delete_failed`, `organization_not_found`, `organization_fetch_failed`, `office_list_failed`, `org_cleanup_failed`, `organization_delete_failed`.

---

## Workflows Collection (Fázis 4)

A guard function-ök a `workflows` collection `compiled` JSON mezőjéből olvassák a workflow konfigurációt. Minden szerkesztőséghez (editorial office) tartozik egy workflow dokumentum.

**Betöltés**: `getWorkflowForOffice(databases, databaseId, workflowsCollectionId, editorialOfficeId)` — 60s TTL process-szintű cache-sel, hogy ne legyen per-request DB olvasás.

**Fail-closed**: Ha nincs workflow dokumentum (cache miss + DB üres) → state revert / reject. Nincs fallback konfiguráció.

**Compiled JSON struktúra**: `states`, `transitions`, `validations`, `commands`, `elementPermissions`, `contributorGroups`, `leaderGroups`, `statePermissions`, `capabilities`.

**Contributor mezők (Fázis 3)**: A `contributors` (articles) és `defaultContributors` (publications) JSON longtext mező, a kulcsa a csoport `slug`-ja (pl. `{"designers":"userId1","editors":"userId2"}`). A CF-ek `JSON.parse()` → kulcs iterálás → userId validáció mintát használják.

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
- **Határidő szerkezet lock**: Aktivált publikáción a Dashboard `DeadlinesTab` letiltja az oldalszám input-okat, a törlés és „+ Új határidő" gombokat (a fedés-invariáns megőrzéséhez). A dátum és idő mezők továbbra is szerkeszthetők, mert nem bontják a fedést.
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
