# Cloud Functions — Üzemeltetési referencia

> Szerver-oldali Appwrite Cloud Function-ök: konfiguráció, triggerek, környezeti változók.

---

## Összefoglaló

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

## Környezeti változók

### Közös (minden function)

| Változó | Érték | Leírás |
|---|---|---|
| `APPWRITE_API_KEY` | *(secret)* | API kulcs a szükséges jogosultságokkal |

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

## Jogosultságok (Scopes)

| Function | Scopes |
|---|---|
| `article-update-guard` | `databases.read`, `databases.write`, `users.read`, `teams.read` |
| `validate-article-creation` | `databases.read`, `databases.write`, `users.read` |
| `validate-publication-update` | `databases.read`, `databases.write`, `users.read` |
| `validate-labels` | `users.read`, `users.write`, `databases.read` |
| `cascade-delete` | `databases.read`, `databases.write`, `files.read`, `files.write` |
| `cleanup-orphaned-locks` | `databases.read`, `databases.write`, `users.read` |
| `cleanup-orphaned-thumbnails` | `databases.read`, `files.read`, `files.write` |
| `migrate-legacy-paths` | `databases.read`, `databases.write` |

---

## Működési leírás

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

Új cikk létrehozásakor fut. Érvénytelen `publicationId` → cikk törlés.

### validate-publication-update

Kiadvány létrehozás/módosításkor fut. Nem létező default contributor → nullázás. Legacy rootPath → logolás.

### validate-labels

User frissítéskor fut. A `config` collection-ből olvassa az érvényes label-eket (fallback: hardcoded lista). Érvénytelen label → automatikus eltávolítás.

### cascade-delete

Cikk törléskor: üzenetek, validációk, thumbnailek törlése. Kiadvány törléskor: cikkek törlése (→ rekurzív), layoutok, deadline-ok törlése.

### cleanup-orphaned-locks

Naponta 3:00 UTC. Zárolások ellenőrzése: owner létezik-e, `$updatedAt` > 24h. Feltételek teljesülése → lock feloldás.

### cleanup-orphaned-thumbnails

Hetente vasárnap 4:00 UTC. Storage bucket ↔ DB `thumbnails` mezők összehasonlítása. Nem hivatkozott fájlok törlése. Hibás JSON → abort (nem töröl semmit).

### migrate-legacy-paths

Manuális futtatás. `DRY_RUN=true` alapértelmezett — csak logol. Publications: `/Volumes/...` → kanonikus. Articles: abszolút filePath → relatív.

---

## Deployment

```bash
# Appwrite CLI-vel (a maestro-indesign könyvtárból):
appwrite functions create-deployment \
  --function-id <function-id> \
  --code appwrite_functions/<function-dir> \
  --entrypoint src/main.js \
  --activate true
```

---

## Config Collection

A guard function-ök a `config` collection `workflow_config` dokumentumából olvassák a workflow konstansokat. A plugin induláskor szinkronizálja (`syncWorkflowConfig.js`).

**Mezők:** `configVersion`, `statePermissions`, `validTransitions`, `teamArticleField`, `capabilityLabels`, `validLabels`, `validStates` (JSON string értékek).

**Verzió léptetés:** Ha bármely konstans változik → `CONFIG_VERSION` léptetése a `maestro-shared/workflowConfig.js`-ben.
