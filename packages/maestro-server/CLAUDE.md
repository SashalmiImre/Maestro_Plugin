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
    ├── validate-labels/               ← Felhasználói label validáció (érvénytelen label-ek eltávolítása)
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
    └── team/                          ← Csapattagok lekérése (kliens hívás, API Key bypass)
        ├── package.json
        └── src/main.js
```

---

## Function-ök Összefoglalója

| Function ID | Név | Runtime | Timeout | Trigger |
|---|---|---|---|---|
| `article-update-guard` | Article Update Guard | node-18.0 | 30s | `articles.*.update` |
| `validate-article-creation` | Validate Article Creation | node-18.0 | 15s | `articles.*.create` |
| `validate-publication-update` | Validate Publication Update | node-18.0 | 15s | `publications.*.create/update` |
| `validate-labels` | Validate Labels | node-18.0 | 15s | `users.*.update` |
| `cascade-delete` | Cascade Delete | node-18.0 | 15s | `articles/publications.*.delete` |
| `cleanup-orphaned-locks` | Cleanup Orphaned Locks | node-18.0 | 30s | Schedule: `0 3 * * *` |
| `cleanup-orphaned-thumbnails` | Cleanup Orphaned Thumbnails | node-18.0 | 120s | Schedule: `0 4 * * 0` |
| `migrate-legacy-paths` | Migrate Legacy Paths | node-18.0 | 120s | Manuális (HTTP) |
| `invite-to-organization` | Invite To Organization | node-18.0 | 15s | Kliens hívás (HTTP, `execute: ["users"]`) |
| `69599cf9000a865db98a` | Get Team Members | node-22 | 15s | Kliens hívás |

---

## Környezeti Változók

### Közös (minden function)

| Változó | Érték | Leírás |
|---|---|---|
| `APPWRITE_API_KEY` | *(secret)* | API kulcs — `MaestroFunctionsKey` (databases.rw, users.rw, teams.r, files.rw) |
| `APPWRITE_FUNCTION_ENDPOINT` | automatikus | Appwrite végpont (Appwrite beállítja) |
| `APPWRITE_FUNCTION_PROJECT_ID` | automatikus | Projekt ID (Appwrite beállítja) |

### Per-function

| Function | Változók |
|---|---|
| `article-update-guard` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `CONFIG_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID` |
| `validate-article-creation` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `CONFIG_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID` |
| `validate-publication-update` | `DATABASE_ID`, `PUBLICATIONS_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID` |
| `validate-labels` | `DATABASE_ID`, `CONFIG_COLLECTION_ID` |
| `cascade-delete` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `ARTICLE_MESSAGES_COLLECTION_ID`, `USER_VALIDATIONS_COLLECTION_ID`, `VALIDATIONS_COLLECTION_ID`, `DEADLINES_COLLECTION_ID`, `LAYOUTS_COLLECTION_ID`, `THUMBNAILS_BUCKET_ID` |
| `cleanup-orphaned-locks` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID` |
| `cleanup-orphaned-thumbnails` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `THUMBNAILS_BUCKET_ID` |
| `migrate-legacy-paths` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `DRY_RUN` |
| `invite-to-organization` | `DATABASE_ID`, `ORGANIZATIONS_COLLECTION_ID`, `ORGANIZATION_MEMBERSHIPS_COLLECTION_ID`, `EDITORIAL_OFFICES_COLLECTION_ID`, `EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID`, `ORGANIZATION_INVITES_COLLECTION_ID` |

---

## Jogosultságok (API Key Scopes)

| Function | Szükséges Scopes |
|---|---|
| `article-update-guard` | `databases.read`, `databases.write`, `users.read`, `teams.read` |
| `validate-article-creation` | `databases.read`, `databases.write`, `users.read` |
| `validate-publication-update` | `databases.read`, `databases.write`, `users.read` |
| `validate-labels` | `users.read`, `users.write`, `databases.read` |
| `cascade-delete` | `databases.read`, `databases.write`, `files.read`, `files.write` |
| `cleanup-orphaned-locks` | `databases.read`, `databases.write`, `users.read` |
| `cleanup-orphaned-thumbnails` | `databases.read`, `files.read`, `files.write` |
| `migrate-legacy-paths` | `databases.read`, `databases.write` |
| `invite-to-organization` | `databases.read`, `databases.write`, `users.read` |
| Get Team Members | `teams.read`, `users.read` |

> **Megjegyzés**: Jelenleg minden function egyetlen közös API kulcsot használ (`MaestroFunctionsKey`), amely az összes szükséges jogosultsággal rendelkezik.

---

## Működési Leírás

### article-update-guard

Összevont workflow állapotátmenet + contributor validáció. Minden cikk frissítéskor fut.

**Ellenőrzések:**
1. **Sentinel guard** — `modifiedByClientId === 'server-guard'` → skip (végtelen ciklus védelem)
2. **Config betöltés** — DB `workflow_config` dokumentumból, fallback hardkódolt értékekre (fail-closed)
3. **Állapot érvényesség** — `validStates` halmazban van-e (érvénytelen → 0)
4. **Állapotátmenet** — `previousState → state` a `validTransitions` alapján
5. **Parent scope sync (B.8)** — szülő publikáció `editorialOfficeId`/`organizationId` mezőkhöz igazítás (cross-tenant scope támadás scenario 1 védelem)
6. **Scope ellenőrzés (B.8)** — caller user tagja-e a cikk `editorialOfficeId`-jának (`editorialOfficeMemberships` lookup); nem-tag → state revert. Legacy null scope → skip + warning log.
7. **Jogosultság** — felhasználó csapattagsága/label-jei engedélyezik-e az átmenetet
8. **Contributor mezők** — létező felhasználókra mutatnak-e (log only)
9. **previousState karbantartás** — null esetén inicializálás, revert esetén frissítés

### validate-article-creation

Új cikk létrehozásakor fut. Érvénytelen `publicationId` → cikk törlés. Ellenőrzi a state érvényességét, contributor user létezést, filePath formátumot.

**Scope ellenőrzés (B.8):** hiányzó `organizationId`/`editorialOfficeId`, parent publication office mismatch, vagy nem-tag caller → cikk törlése (`editorialOfficeMemberships` lookup).

### validate-publication-update

Kiadvány létrehozás/módosításkor fut. Nem létező default contributor → nullázás. Legacy rootPath → logolás.

**Scope ellenőrzés (B.8):** create eseménynél hiányzó scope mezők vagy nem-tag caller → publikáció törlése. Update path: nem-tag caller csak logolódik (teljes field-level revert Fázis 6 hatáskör).

### validate-labels

User frissítéskor fut. A `config` collection-ből olvassa az érvényes label-eket (fallback: hardcoded lista). Érvénytelen label → automatikus eltávolítás.

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
{ "action": "bootstrap_organization" | "create" | "accept", ... }
```

**Biztonsági megjegyzés**: Korábban létezett egy `organization-membership-guard` trigger CF, amely egy `modifiedByClientId === 'server-guard'` sentinellel engedélyezte az invite-eredetű membership-eket. Ez **kliens-forgeable** volt — bármely hitelesített user beállíthatta a payload-ban. A Codex adversarial review jelezte a kritikus sebezhetőséget, és a javítás ACL-alapú védelemre váltott (B.5 utolsó iteráció, 2026-04-07).

**ACTION='bootstrap_organization'** (onboarding flow):
1. Caller user kötelező (`x-appwrite-user-id` header).
2. Bemeneti mezők: `orgName`, `orgSlug`, `officeName`, `officeSlug` (mind trim + length check + slug regex validáció).
3. **Atomikus 4-collection write** API key-jel:
   - `organizations` — `{ name, slug, ownerUserId: callerId }`
   - `organizationMemberships` — `{ organizationId, userId: callerId, role: 'owner', addedByUserId: callerId }`
   - `editorialOffices` — `{ organizationId, name, slug }` (workflowId nullként, Fázis 4 tölti)
   - `editorialOfficeMemberships` — `{ editorialOfficeId, organizationId, userId: callerId, role: 'admin' }`
4. **Best-effort rollback**: ha a 2-3-4. lépésnél hiba van, a már létrehozott rekordokat visszatörli fordított sorrendben (try/catch minden cleanup lépésen).
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

**Hibakódok** (mind a `fail()` wrapperen keresztül `{ success: false, reason, ...extra }` formátumban):
`invalid_payload`, `invalid_action`, `unauthenticated`, `missing_fields`, `invalid_slug`, `org_slug_taken`, `org_create_failed`, `membership_create_failed`, `office_slug_taken`, `office_create_failed`, `office_membership_create_failed`, `invalid_email`, `invalid_role`, `not_a_member`, `insufficient_role`, `invite_not_found`, `invite_not_pending`, `invite_expired`, `email_mismatch`, `caller_lookup_failed`.

### Get Team Members (team)

Kliens hívás. Csapattagok listázása (név, email, ID) API Key-jel — megkerüli a kliens-oldali privacy korlátozásokat.

---

## Config Collection

A guard function-ök a `config` collection `workflow_config` dokumentumából olvassák a workflow konstansokat. A plugin induláskor szinkronizálja (`maestro-indesign/src/core/utils/syncWorkflowConfig.js`).

**Mezők:** `configVersion`, `statePermissions`, `validTransitions`, `teamArticleField`, `capabilityLabels`, `validLabels`, `validStates` (JSON string értékek).

**Verzió léptetés:** Ha bármely konstans változik → `CONFIG_VERSION` léptetése a `maestro-shared/workflowConfig.js`-ben.

**Fallback**: Ha a config nem elérhető, minden guard function hardkódolt fallback értékeket használ. Ezeket szinkronban kell tartani a `maestro-shared` megfelelő fájljaival (`workflowConfig.js`, `labelConfig.js`).

---

## Kapcsolat a Többi Csomaggal

```
maestro-server (functions)
    ↑ konfigurálja
maestro-indesign (syncWorkflowConfig.js → config collection → functions olvassák)
    ↑ konstansok
maestro-shared (workflowConfig.js, labelConfig.js — fallback értékek forrása)
```

- A function-ök **nem importálnak** a monorepo többi csomagjából — teljesen önállóak
- A `maestro-shared` konstansok **manuálisan szinkronizálandók** a fallback értékekkel
- A plugin-oldali `syncWorkflowConfig.js` írja a DB config-ot, amit a function-ök olvasnak
