# Workflow Designer — Architektúra

> A Maestro multi-tenant átalakításának és a dinamikus workflow rendszernek az átfogó leírása.
> **Kapcsolódó**: [DATA_MODEL.md](DATA_MODEL.md), [COMPILED_SCHEMA.md](COMPILED_SCHEMA.md), [MIGRATION_NOTES.md](MIGRATION_NOTES.md).

---

## Kiindulási helyzet

A Maestro jelenleg **egybérlős, hardkódolt workflow-val** működik. A kulcsfájlok:

- [packages/maestro-shared/workflowConfig.js](../../packages/maestro-shared/workflowConfig.js) — 8 állapot integer enum-ban, `STATUS_LABELS`, `STATUS_COLORS`, `STATE_DURATIONS`, `TEAM_ARTICLE_FIELD` (7 hardkódolt csapat → mezőnév leképezés).
- [packages/maestro-shared/labelConfig.js](../../packages/maestro-shared/labelConfig.js) — 8 capability label statikus konfiguráció.
- [packages/maestro-shared/appwriteIds.js](../../packages/maestro-shared/appwriteIds.js) — 7 fix Appwrite Team ID.
- [packages/maestro-indesign/src/core/utils/workflow/workflowConstants.js](../../packages/maestro-indesign/src/core/utils/workflow/workflowConstants.js) — `WORKFLOW_CONFIG`, `STATE_PERMISSIONS`, `VALID_TRANSITIONS`.
- [packages/maestro-indesign/src/core/utils/workflow/elementPermissions.js](../../packages/maestro-indesign/src/core/utils/workflow/elementPermissions.js) — `ARTICLE_ELEMENT_PERMISSIONS`, `PUBLICATION_ELEMENT_PERMISSIONS`, `LEADER_TEAMS`.

Minden jogosultság-döntés ezekre a statikus konstansokra épül. A `articles` collection `state` mezője integer (0–7), a contributor-ök külön oszlopokban (`designerId`, `editorId`, …). Ez a modell egy magazin-szerkesztőségre lett szabva, több cég nem tudja egyszerre használni, a workflow nem változtatható.

---

## Célrendszer

### 1. Multi-tenant scope lánc

```
organization → editorialOffice → publication → article
```

Minden alacsonyabb entitás **denormalizált scope mezővel** hordozza a felette lévő szinteket (`organizationId`, `editorialOfficeId`). Ez gyors query-t és hatékony Cloud Function guard-okat tesz lehetővé (`Query.equal('editorialOfficeId', activeOfficeId)`).

A regisztráló user automatikusan az új organization `owner`-je lesz, és kap egy default `editorialOffice`-t a gyári workflow template-tel.

### 2. Saját tagság collectionök (Appwrite Teams helyett)

A korábbi 7 fix Appwrite Team **eltűnik**. Helyette három collection kezeli a tagságokat:

- `organizationMemberships` (`owner` | `admin` | `member`)
- `editorialOfficeMemberships` (`admin` | `member`)
- `groupMemberships` — a dinamikus csoportok tagsága

A meghívó flow **saját Cloud Function**-nel (`invite-to-organization`), Appwrite Messaging-en keresztül küldi az e-mailt, egy generált tokent használva. A user a linkre kattint, regisztrál vagy elfogadja a meghívást → `organizationMemberships` rekord létrejön.

### 3. Dinamikus csoportok

Minden `editorialOffice` saját csoportokat definiál a `groups` collectionben. A csoportoknak van `slug`, `label`, `color`, `isContributorGroup`, `isLeaderGroup` mezője. A leader csoportok tagjai szuperjoggal rendelkeznek — ez a régi `LEADER_TEAMS` dinamikus megfelelője.

A user csoporttagságát a `groupMemberships` tárolja. A plugin `UserContext`-ben ez `groupSlugsByOffice: Map<officeId, Set<slug>>` formában él, Realtime-on szinkronizálva.

### 4. Dinamikus contributor mezők

Az `articles.contributors: {groupSlug: userId}` JSON map váltja a 7 hardkódolt `*Id` oszlopot. A `publications.defaultContributors` ugyanígy. A `ContributorsSection` komponens dinamikusan loop-ol a `workflow.compiled.contributorGroups` alapján, nincs többé statikus JSX lista.

### 5. Workflow runtime

A workflow definíció a **`workflows` collectionben** él, office-onként egy dokumentum. Két alakban:

- **`graph`** (JSON) — a vizuális designerhez: node pozíciók, UI state.
- **`compiled`** (JSON) — a plugin és Cloud Function-ök által fogyasztott, minimalizált, validált forma. A compiler (dashboard-oldalon) mentéskor futtatja a validátort és generálja ezt.

A plugin a `DataContext`-ben `workflow` állapotként tárolja a `compiled`-et, és Realtime-on figyeli az office workflow dokumentumát. A Cloud Function-ök ugyanezt teszik (60s TTL process cache-sel a cold-start ellen).

Részletes `compiled` JSON séma: [COMPILED_SCHEMA.md](COMPILED_SCHEMA.md).

### 6. Permission resolve flow

1. Plugin betölti az aktív `editorialOffice` `workflows.compiled`-jét → `DataContext.workflow`.
2. Betölti a user `groupMemberships` rekordjait erre az office-ra → `UserContext.groupSlugsByOffice.get(officeId)`.
3. Minden jogosultság helper (`canUserMoveArticle`, `canEditElement`, `canRunCommand`) a `workflow.compiled` és a `groupSlugs` metszetéből dönt.
4. `leaderGroups` tagjai szuperjoggal rendelkeznek.
5. Realtime: `workflows.{id}` update → hot reload; `groupMemberships` update → permission újraszámolás.

### 7. Vizuális Workflow Designer

Dashboard-oldali React feature a [@xyflow/react](https://reactflow.dev/) (MIT) könyvtárral. ComfyUI-szerű canvas, node-ok = állapotok, edge-ek = átmenetek. Jobb oldali sidebar a kiválasztott elem tulajdonságaival. Külön tabok a csoportokhoz, UI elem jogosultságokhoz, exkluzív capability-khez.

A designer mentéskor futtatja a `compiler.js`-t (graph → compiled normalizálás) és a `validator.js`-t (initial state létezik, nincs elárvult cikk state, nincs körkörös forward-only path, stb.), majd `graph` + `compiled` együtt kerül a `workflows` dokumentumba. A többi kliens Realtime-on kapja.

#### Workflow JSON export/import

A designer toolbarból:
- **Export**: `{version, graph, compiled}` letöltése helyi JSON fájlba. Fájlnév: `workflow-<office-slug>-v<version>-<YYYYMMDD>.json`.
- **Import**: JSON feltöltés → séma validáció → **diff megjelenítés** (aktuális vs. importált) → figyelmeztetés ismeretlen csoport-hivatkozásokra → megerősítés → írás a jelenlegi office workflow dokumentumába (verzió auto-inkrement).

Use case-ek: backup, office-ok közti workflow átvitel, template megosztás, fejlesztés közbeni gyors visszaállás.

### 8. Auth flow a Dashboardon

A dashboard lesz a teljes auth UI gazdája. Új route-ok a `react-router-dom`-mal:

- `/login` — bejelentkezés
- `/register` — regisztráció + e-mail verifikáció indítás
- `/verify?userId=&secret=` — verifikáció callback
- `/onboarding` — első belépés: új org vagy meghívó token
- `/invite?token=` — meghívó elfogadás
- `/forgot-password` — jelszó helyreállítás indítás
- `/reset-password?userId=&secret=` — új jelszó beállítás callback
- `/settings/password` — bejelentkezett user jelszó módosítás

A plugin [appwriteConfig.js](../../packages/maestro-indesign/src/core/config/appwriteConfig.js) `VERIFICATION_URL` és `RECOVERY_URL` beállítása átkerül a Dashboard domain-re. A plugin kényelmi jelszó-dialogjai megmaradhatnak, de a teljes funkcionalitás a weben él.

---

## Réteg-diagramm

```
┌─────────────────────────────────────────────────────────────────┐
│ DASHBOARD (React + Vite + react-router-dom)                     │
│                                                                 │
│   Auth routes          Workflow Designer        Admin views     │
│   /login               xyflow canvas            Org / Office    │
│   /register            PropertiesSidebar        Groups / Users  │
│   /verify              compiler.js              InviteModal     │
│   /onboarding          validator.js                             │
│   /forgot-password     exportImport.js                          │
│                                                                 │
└───────────────────────┬─────────────────────────────────────────┘
                        │ Appwrite SDK (Database, Realtime, Account)
                        │
┌───────────────────────▼─────────────────────────────────────────┐
│ APPWRITE CLOUD                                                  │
│                                                                 │
│   Collections:                                                  │
│     organizations, organizationMemberships, organizationInvites │
│     editorialOffices, editorialOfficeMemberships                │
│     groups, groupMemberships                                    │
│     workflows (graph + compiled)                                │
│     publications, articles, layouts, deadlines,                 │
│     uservalidations, validations   (+ scope mezők)              │
│                                                                 │
│   Cloud Functions:                                              │
│     article-update-guard      (compiled-et olvas)               │
│     validate-article-creation (compiled-et olvas)               │
│     validate-publication-update                                 │
│     group-membership-guard                                      │
│     invite-to-organization (bootstrap + create + accept)        │
│     cascade-delete, cleanup-orphaned-*                          │
│                                                                 │
│   Tenant collection védelem: ACL `read("users")` only —         │
│     minden írás CF-en keresztül (API key bypass), nincs guard CF │
│                                                                 │
└───────────────────────▲─────────────────────────────────────────┘
                        │ Appwrite SDK + Realtime (proxy-n át)
                        │
┌───────────────────────┴─────────────────────────────────────────┐
│ INDESIGN PLUGIN (UXP + React)                                   │
│                                                                 │
│   DataContext.workflow (compiled)     ← Realtime hot-reload     │
│   UserContext.groupSlugsByOffice      ← Realtime                │
│   workflowRuntime.js                  ← pure fogyasztó helperek │
│   workflowEngine.js                   ← átmenetek, lock, unlock │
│   ContributorsSection                 ← dinamikus render        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Kritikus tervezési döntések

### A `compiled` JSON a rendszer szíve

A plugin és a Cloud Function-ök **kizárólag** a `workflow.compiled` JSON-ból dolgoznak — nincs második igazságforrás. A régi statikus fájlok (`workflowConstants.js`, `labelConfig.js`, `elementPermissions.js`, `workflowConfig.js`) a Fázis 4 végén **törlődnek**. Ez eliminálja a divergencia kockázatát, és minden workflow-változás egyetlen DB update.

A compiler a dashboard-oldalon fut (nem szerver), így a Cloud Function-öknek csak olvasniuk kell a `compiled` mezőt. A mentés előtt a validator blokkolja a töröttséget (pl. state ID átnevezés, ha cikk hivatkozik rá).

### Fail-closed Cloud Function-ök

A régi `FALLBACK_CONFIG` hardkódolt konstansok törlődnek. Ha nincs `workflows` dokumentum az adott office-ra → a guard **blokkolja** a műveletet (revertál). Ez tiszta és biztonságos — jobb lezárni, mint megengedni valamit tévedésből.

### Snapshot pattern a hot-reload race-re

A plugin `executeTransition` belépéskor `const wf = workflowRef.current` snapshot-et vesz, és a futás végéig ezzel dolgozik. Így ha egy admin épp a designerben ment, miközben a plugin egy tranzíciót végrehajt, nem keveredik össze a két verzió.

### Dual `graph` + `compiled`

A `graph` a designer számára hordozza a pozíciókat és UI állapotot, a `compiled` a runtime számára minimalizált. Mindkettő ugyanabban a `workflows` dokumentumban él, atomosan íródik. Az import szintén mindkettőt hozza.

### Leader csoportok mint dinamikus LEADER_TEAMS

A régi hardkódolt `LEADER_TEAMS` helyett a csoportok `isLeaderGroup` flag-je dönti el, kik kapnak szuperjogot. Ezt a `compiled.leaderGroups` tömb tükrözi, a plugin és a CF onnan olvassa.

---

## Kockázatok és enyhítés

| Kockázat | Enyhítés |
|----------|----------|
| Cold-start a CF-ekben (workflow fetch minden híváskor) | Process-belüli `Map<officeId, {compiled, fetchedAt}>` 60s TTL cache. |
| Hot-reload race condition a pluginban | Snapshot pattern minden tranzíciónál. |
| State átnevezés elárvult cikkeket hagy | Compiler validator blokkolja, ha van hivatkozó cikk. „Force" flag kell a töröléshez figyelmeztetéssel. |
| Stitch HTML/CSS → React fordítás nem 1:1 | A Stitch outputok inspirációként és layout alapként szolgálnak, a React komponensek manuális munka ugyanazon a design tokenen. |
| Több-org user: UI zavar | WorkspaceHeader-ben org/office választó dropdown, az aktív officeId DataContextbe íródik, az összes query átrendeződik. |
| Fix teszt-user nélküli indulás | Új regisztráció minden új teszt-fázis elején, a teszt adat eldobható. |

---

## Útmutató a következő session-öknek

Amikor új Claude Code session indul ebben a projektben:

1. **Olvasd el a [PROGRESS.md](PROGRESS.md)-t** — ebből derül ki, hol tartunk és mi a következő lépés.
2. **Nézd meg a [_docs/Feladatok.md](../Feladatok.md) `## Aktív` szekcióját** — a magyar nyelvű, fázisok szerint bontott feladatlista.
3. **Ha kódot módosítasz**, amely érinti a `compiled` szerkezetet → frissítsd a [COMPILED_SCHEMA.md](COMPILED_SCHEMA.md)-t ugyanabban a commitban.
4. **Ha új collection vagy mező kerül a DB-be** → frissítsd a [DATA_MODEL.md](DATA_MODEL.md)-t.
5. **Ha régi → új mapping változik** → frissítsd a [MIGRATION_NOTES.md](MIGRATION_NOTES.md)-t.
6. **Amint egy fázis feladatait elvégezted** → pipáld ki a [PROGRESS.md](PROGRESS.md) checklist-jében és a Feladatok.md-ben.
