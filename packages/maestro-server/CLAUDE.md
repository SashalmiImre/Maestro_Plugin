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
- **Sentinel pattern**: `modifiedByClientId = 'server-guard'` védi a végtelen ciklust
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
| `article-update-guard` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `CONFIG_COLLECTION_ID` |
| `validate-article-creation` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `CONFIG_COLLECTION_ID` |
| `validate-publication-update` | `DATABASE_ID`, `PUBLICATIONS_COLLECTION_ID` |
| `validate-labels` | `DATABASE_ID`, `CONFIG_COLLECTION_ID` |
| `cascade-delete` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `ARTICLE_MESSAGES_COLLECTION_ID`, `USER_VALIDATIONS_COLLECTION_ID`, `VALIDATIONS_COLLECTION_ID`, `DEADLINES_COLLECTION_ID`, `LAYOUTS_COLLECTION_ID`, `THUMBNAILS_BUCKET_ID` |
| `cleanup-orphaned-locks` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID` |
| `cleanup-orphaned-thumbnails` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `THUMBNAILS_BUCKET_ID` |
| `migrate-legacy-paths` | `DATABASE_ID`, `ARTICLES_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `DRY_RUN` |

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
5. **Jogosultság** — felhasználó csapattagsága/label-jei engedélyezik-e az átmenetet
6. **Contributor mezők** — létező felhasználókra mutatnak-e (log only)
7. **previousState karbantartás** — null esetén inicializálás, revert esetén frissítés

### validate-article-creation

Új cikk létrehozásakor fut. Érvénytelen `publicationId` → cikk törlés. Ellenőrzi a state érvényességét, contributor user létezést, filePath formátumot.

### validate-publication-update

Kiadvány létrehozás/módosításkor fut. Nem létező default contributor → nullázás. Legacy rootPath → logolás.

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
