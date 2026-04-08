---
aliases: [TODO, Tasks, Teendők]
tags: [feladatok]
---

# Feladatok

> Ide gyűjtsd a fejlesztési ötleteket, bugokat, teendőket. A Claude Code is olvassa — megbeszéljük, majd kipipáljuk.

## Aktív

### 🎯 Workflow Designer + Multi-tenant átalakítás

> A Maestro egybérlős, hardkódolt workflow-jának teljes átalakítása dinamikus, multi-tenant rendszerré ComfyUI-stílusú vizuális designerrel a Dashboardon. Teljes terv: [workflow-designer/ARCHITECTURE.md](workflow-designer/ARCHITECTURE.md). State tracker: [workflow-designer/PROGRESS.md](workflow-designer/PROGRESS.md).

#### Fázis 0 — Dokumentációs alap + Stitch UI tervek

- [x] `_docs/workflow-designer/` mappa létrehozása PROGRESS/ARCHITECTURE/DATA_MODEL/COMPILED_SCHEMA/MIGRATION_NOTES/UI_DESIGN fájlokkal
- [x] Régi workflow dokumentumok (`WORKFLOW_CONFIGURATION.md`, `WORKFLOW_PERMISSIONS.md`) áthelyezése `_docs/archive/`-ba
- [x] `packages/maestro-indesign/CLAUDE.md` tetejére „Átalakítás folyamatban" banner
- [x] `_docs/Feladatok.md` `## Aktív` szekcióba a Fázis 0–7 teljes task lista
- [x] `auth-flow` Stitch kép mentve: [workflow-designer/stitch-screens/auth-flow.png](workflow-designer/stitch-screens/auth-flow.png) + annotáció
- [x] `designer-canvas` Stitch kép mentve: [workflow-designer/stitch-screens/designer-canvas.png](workflow-designer/stitch-screens/designer-canvas.png) + annotáció
- [x] `state-node` Stitch kép mentve: [workflow-designer/stitch-screens/state-node.png](workflow-designer/stitch-screens/state-node.png) + annotáció
- [x] `properties-sidebar` Stitch kép mentve: [workflow-designer/stitch-screens/properties-sidebar.png](workflow-designer/stitch-screens/properties-sidebar.png) + annotáció

#### Fázis 1 — Scope bevezetés + teljes auth flow a Dashboardon

- [x] Új collectionök: `organizations`, `organizationMemberships`, `editorialOffices`, `editorialOfficeMemberships`, `organizationInvites`
- [x] Scope mezők (`organizationId`, `editorialOfficeId`) hozzáadása a `publications`, `articles`, `layouts`, `deadlines`, `uservalidations`, `validations` collectionökhöz
- [x] `appwriteIds.js` frissítés az új collection ID-kkal (a régi `TEAMS` enum egyelőre marad, `@deprecated` JSDoc-kal)
- [x] Új Cloud Function: `invite-to-organization` — token generálás (e-mail küldés Fázis 6-ra halasztva), `bootstrap_organization` + `create` + `accept` action egy CF-ben, ACL-alapú védelem *(B.5 kész + biztonsági javítás)*
- [x] ~~Új Cloud Function: `organization-membership-guard`~~ — **TÖRÖLVE** *(B.5 adversarial review után): a sentinel pattern kliens-forgeable volt, helyette ACL lockdown (5 tenant collection `read("users")` only) + `bootstrap_organization` action a `invite-to-organization` CF-ben.*
- [ ] Meglévő CF-ek (article-update-guard, validate-article-creation, validate-publication-update) officeId scope átvétele
- [x] Dashboard: `react-router-dom` telepítés (v7.14.0)
- [x] Dashboard route `/login` — bejelentkezés (LoginRoute.jsx, az AuthSplitLayout brand részével)
- [x] Dashboard route `/register` — regisztráció (név, e-mail, jelszó) + `account.createVerification(DASHBOARD_URL/verify)` *(B.4 kész)*
- [x] Dashboard route `/verify?userId=&secret=` — e-mail verifikáció callback + átirányítás `/login?verified=1`-re *(B.4 kész)*
- [x] Dashboard route `/onboarding` — első belépés: új org létrehozása (org név + office név → automatikus workflow seed) vagy meghívó token bevitel *(B.5 kész — 4-collection write `createOrganization` + invite accept ág; `workflowId: null` Fázis 4-ig)*
- [x] Dashboard route `/invite?token=` — meghívó elfogadás (token validáció, user bejelentkezve vagy regisztrációra redirect) *(B.5 kész — token tárolás InviteRoute, acceptInvite() OnboardingRoute-on)*
- [x] Dashboard route `/forgot-password` — `account.createRecovery(email, DASHBOARD_URL/reset-password)` *(B.4 kész)*
- [x] Dashboard route `/reset-password?userId=&secret=` — új jelszó form, `account.updateRecovery()` *(B.4 kész)*
- [ ] Dashboard route `/settings/password` — bejelentkezett jelszó módosítás `account.updatePassword()`
- [x] Plugin `appwriteConfig.js` `VERIFICATION_URL` + `RECOVERY_URL` átállítása Dashboard domainre *(B.6 kész — a két URL a `DASHBOARD_URL`-ből származik, Webpack DefinePlugin `process.env.DASHBOARD_URL` inject)*
- [x] Proxy régi reset oldalának megszüntetése vagy Dashboard redirect *(B.6 kész — `GET /verify` + `GET /reset-password` 302 redirect Dashboardra, `POST /reset-password` 410 Gone, HTML helperek + `node-appwrite` dependency törölve)*
- [ ] Plugin `UserContext` + Dashboard `AuthContext` új state-ek: `organizations`, `editorialOffices`, `activeOrganizationId`, `activeEditorialOfficeId` *(B.4: Dashboard `AuthContext` `organizations` + `editorialOffices` kész + `fetchMemberships`/`reloadMemberships`; `activeOrganizationId`/`activeEditorialOfficeId` a `ScopeContext`-ben él, Plugin oldal B.7-ben jön)*
- [ ] Plugin + Dashboard `DataContext`: minden lekérdezésbe `Query.equal('editorialOfficeId', activeOfficeId)` szűrés
- [ ] Teszt adat törlése, új user regisztrációval indulás
- [ ] **Verifikáció**: regisztráció → e-mail verifikáció → onboarding → org + office létrejön → üres workspace. Elfelejtett jelszó flow. Meghívó flow két user között. Plugin bejelentkezés.

#### Fázis 2 — Dinamikus csoportok (groups, groupMemberships)

- [ ] Új collection: `groups` (editorialOfficeId, slug, label, color, isContributorGroup, isLeaderGroup, description)
- [ ] Új collection: `groupMemberships` (groupId, userId, editorialOfficeId, organizationId)
- [ ] Új Cloud Function: `group-membership-guard` — create/delete trigger, office admin jogkört ellenőriz
- [ ] Új shared modul: [packages/maestro-shared/groups.js](../packages/maestro-shared/groups.js) — `getUserGroupSlugs(userId, officeId)`, helper lookupok
- [ ] Dashboard view: minimális „Csoportok" form office-szinten (csoport CRUD, user hozzárendelés)
- [ ] Plugin `UserContext` új állapota: `groupSlugsByOffice: Map<officeId, Set<slug>>` + Realtime feliratkozás saját `groupMemberships` rekordokra
- [ ] `workflowPermissions.js`, `elementPermissions.js` helperek átalakítása: `user.teamIds` helyett `user.groupSlugsByOffice.get(activeOfficeId)`
- [ ] CF-ek (article-update-guard, validate-article-creation): `teams.list()` + label resolve helyett `groupMemberships` lookup
- [ ] `teamMembershipChanged` MaestroEvent átnevezve `groupMembershipChanged`-re, Realtime csatorna `groupMemberships`-re iratkozik fel
- [ ] **Verifikáció**: admin létrehoz `designers` és `editors` csoportot → user2-t `designers`-be → user2 tud cikket létrehozni és state-et váltani

#### Fázis 3 — Dinamikus contributor mezők

- [ ] `articles` schema: új `contributors` longtext (JSON), a 7 régi `*Id` mező törlése
- [ ] `publications` schema: új `defaultContributors` longtext (JSON), a 7 régi `default*Id` mező törlése
- [ ] `TEAM_ARTICLE_FIELD` mapping törlése — a kulcs a csoport `slug`-ja
- [ ] `ContributorsSection.jsx` (plugin és Dashboard): fix JSX helyett loop a `compiled.contributorGroups` alapján, dinamikus dropdown rendering
- [ ] `canEditContributorDropdown`: `FIELD_TO_TEAM` lookup helyett közvetlen `groupSlug` paraméter
- [ ] `validate-article-creation` és `article-update-guard`: `contributors` objektum kulcsait iterálja, minden kulcsra user létezés + csoporttagság lookup → nem-tag → mező nullázása + logolás (soft correction)
- [ ] **Verifikáció**: cikk létrehozás → dinamikus dropdown render → DB-ben `contributors: {designers: "...", editors: "..."}` formátum

#### Fázis 4 — Workflow runtime (workflows collection, `compiled`)

- [ ] Új collection: `workflows` — minden új office auto kap egy dokumentumot a `defaultWorkflow.json` template másolataként
- [ ] Új shared modul: [packages/maestro-shared/workflowRuntime.js](../packages/maestro-shared/workflowRuntime.js) — a projekt szíve, fogyasztói helperek a `compiled` JSON fölött (getStateConfig, canUserMoveArticle, canEditElement, canRunCommand, canEditContributorDropdown, canUserAccessInState, hasCapability, getContributorGroups, getAvailableTransitions, validateTransition)
- [ ] Új template: [packages/maestro-shared/defaultWorkflow.json](../packages/maestro-shared/defaultWorkflow.json) — jelenlegi 8 állapotos magazin workflow `compiled` formátumban
- [ ] **TÖRÖLT**: `packages/maestro-shared/workflowConfig.js`
- [ ] **TÖRÖLT**: `packages/maestro-shared/labelConfig.js`
- [ ] **TÖRÖLT**: `packages/maestro-indesign/src/core/utils/workflow/workflowConstants.js`
- [ ] **TÖRÖLT**: `packages/maestro-indesign/src/core/utils/workflow/elementPermissions.js`
- [ ] **TÖRÖLT**: `packages/maestro-indesign/src/core/utils/syncWorkflowConfig.js`
- [ ] `workflowEngine.js` és `workflowPermissions.js` proxy a `workflowRuntime.js`-re — minden hívás kap `workflow` (compiled) paramétert
- [ ] Plugin `DataContext` új állapota: `workflow` (compiled JSON) + Realtime feliratkozás `workflows.{id}` update-ekre
- [ ] Snapshot pattern a hot-reloadhoz: `executeTransition` belépéskor `const wf = workflowRef.current`, a futás végéig ezzel dolgozik
- [ ] Cloud Function-ök átírása (article-update-guard, validate-article-creation, validate-publication-update): `workflow_config` helyett `workflows` dokumentum olvasás az article `editorialOfficeId` alapján, 60s TTL process cache
- [ ] `FALLBACK_CONFIG` hardkódolt konstansok törlése — fail-closed viselkedés, ha nincs workflow doc → update revertál
- [ ] `validate-labels` Cloud Function törlése — a label rendszer megszűnik
- [ ] CLAUDE.md „5. Jogosultsági Rendszer" szekció újraírása a dinamikus modellre
- [ ] **Verifikáció**: `workflows.{id}.compiled` manuális módosítás → plugin Realtime hot-reloadol → ArticleTable új színnel/címkével mutatja. CF-ek betiltanak egy kivett átmenetet.

#### Fázis 5 — Workflow Designer UI (Dashboardon)

- [ ] Függőségek: `@xyflow/react` (MIT, React Flow), `react-router-dom`
- [ ] Új mappa: `packages/maestro-dashboard/src/features/workflowDesigner/`
- [ ] `WorkflowDesigner.jsx` — konténer, betölt + ment `workflows` dokumentumot
- [ ] `WorkflowCanvas.jsx` — xyflow-alapú canvas
- [ ] `nodes/StateNode.jsx` — custom state node komponens (label, szín, duration, portok, validator badge, command lista)
- [ ] `edges/TransitionEdge.jsx` — custom edge (label + allowedGroups chipek)
- [ ] `NodePalette.jsx` — bal oldali palette drag-n-drop-pal
- [ ] `PropertiesSidebar.jsx` — jobb oldali panel, kiválasztott elem tulajdonságai (state/transition/üres)
- [ ] `GroupsPanel.jsx` — külön tab: csoport CRUD, tag-hozzárendelés
- [ ] `ElementPermissionsEditor.jsx` — tab: UI elem × csoport rács, checkboxok
- [ ] `CapabilitiesEditor.jsx` — tab: exkluzív capability-k (pl. `canAddArticlePlan`) csoportokhoz rendelése
- [ ] `compiler.js` — graph → compiled normalizálás a mentéskor
- [ ] `validator.js` — mentés előtti ellenőrzés (initial state, elárvult cikk state, körkörös forward-only path)
- [ ] `exportImport.js` — workflow JSON export/import logika
- [ ] `ImportDialog.jsx` — fájlfeltöltés, séma validáció, diff megjelenítés, megerősítés dialog
- [ ] Export gomb: két változat — „Export aktuális" (DB-ben mentett) és „Export szerkesztett" (még-nem-mentett canvas állapot)
- [ ] Export fájlnév formátum: `workflow-<office-slug>-v<version>-<YYYYMMDD>.json`
- [ ] Import flow: JSON feltöltés → validator → diff megjelenítés → csoport-hivatkozás ellenőrzés (ismeretlen slug-ok figyelmeztetése + create/map opció) → megerősítés → `graph` + `compiled` mentés aktuális workflow dokumentumba + verzió auto-inkrement
- [ ] `react-router-dom` route-ok: `/`, `/login`, `/register`, `/admin/organization`, `/admin/office/:officeId`, `/admin/office/:officeId/workflow`
- [ ] Jelenlegi view-switch (`table`/`layout`) a `/` alatti gyerek route-okká konvertálva
- [ ] Dashboard `DataContext` új `workflow` state + Realtime + kliens oldali `compiler.js` mentés előtt
- [ ] **Verifikáció**: admin átnevez egy állapotot → ment → plugin pillanatok alatt az új címkét mutatja. Új csoport + transition → tagok azonnal használhatják. Export/import happy path.

#### Fázis 6 — Org/Office Admin UI finomítás

- [ ] `OrganizationAdminView.jsx` — org név szerkesztés, meghívó flow, user lista, office lista
- [ ] `EditorialOfficeAdminView.jsx` — office áttekintés, csoport lista (link a `GroupsPanel`-re), user → csoport hozzárendelés dashboard, workflow designer link
- [ ] `InviteUserModal.jsx` — e-mail, szerepkör választó, opcionális üzenet
- [ ] Plugin `UserContext` több-org mode: ha a user több org-hoz tartozik, WorkspaceHeader kap egy org + office választó dropdown-t
- [ ] **Verifikáció**: teljes happy path a `ARCHITECTURE.md` Verifikáció szekció szerint

#### Fázis 7 — Cleanup

- [ ] `grep` ellenőrzés: 0 találat a következőkre: `designerId`, `CAPABILITY_LABELS`, `STATE_PERMISSIONS`, `TEAM_ARTICLE_FIELD`, `ARTICLE_ELEMENT_PERMISSIONS`, `LEADER_TEAMS`, `workflow_config`, `workflowConstants`
- [ ] `appwriteIds.js`: `TEAMS` enum és `CONFIG` collection ID törlése
- [ ] Appwrite Console: régi 7 Appwrite Team és `config` collection manuális törlése
- [ ] `getTeamMembers` Cloud Function átnevezése `get-group-members`-re vagy törlés
- [ ] `packages/maestro-indesign/CLAUDE.md` teljes frissítése a végső architektúrával, „Átalakítás folyamatban" banner törlése
- [ ] `_docs/workflow-designer/PROGRESS.md` lezárás, `MIGRATION_NOTES.md` véglegesítés
- [ ] `_docs/Feladatok.md`: aktív feladatok átkerülnek `## Kész` szekcióba egy összefoglaló kommenttel

---

## Kész
### Appwrite Cloud Function-ök — Szerver-oldali üzleti logika

> A kliens-oldali (InDesign plugin / Dashboard) kód jelenleg "becsületalapú" — a jogosultságokat, zárolást és adatintegritást csak a UI ellenőrzi. Közvetlen API hívással ezek megkerülhetők. Az alábbi Cloud Function-ök szerver-oldalon is kikényszerítik a szabályokat.

#### Kritikus — Biztonsági kockázat

- [x] **`validate-workflow-transition`** + **`validate-article-update`** → Összevonva: **`article-update-guard`** Cloud Function. A `config` collection `workflow_config` dokumentumából olvassa a konstansokat (STATE_PERMISSIONS, VALID_TRANSITIONS, TEAM_ARTICLE_FIELD, CAPABILITY_LABELS). A `previousState` mező az articles collection-ben biztosítja az előző állapot ismeretét. `modifiedByClientId = 'server-guard'` sentinel védi a végtelen ciklus ellen.

- [x] **`validate-article-creation`** — Cikk létrehozás szerver-oldali validáció. publicationId ellenőrzés (404 → törlés), state validáció, contributor user létezés ellenőrzés, filePath formátum.

#### Fontos — Adatintegritás

- [x] **`validate-article-update`** — Összevonva az `article-update-guard`-dal (ld. fent).

- [x] **`validate-publication-update`** — Kiadvány módosítás szerver-oldali validáció. Default contributor ID-k ellenőrzése, rootPath kanonikus formátum figyelése.

- [x] **`cascade-delete` bővítés** — MÁR KÉSZ: A `cascade-delete/src/main.js` `deleteThumbnails()` függvénye (94-129. sor) már törli a Storage fájlokat. A publication ág az article törlés re-triggerelésén keresztül kezeli.

#### Alacsony prioritás — Karbantartás

- [x] **`cleanup-orphaned-locks`** — Árva zárolások időszakos takarítása. Schedule: naponta 3:00 UTC. 24h-nál régebbi vagy nem létező owner-ű lockokat feloldja.

- [x] **`migrate-legacy-paths`** — Régi formátumú útvonalak egyszeri batch migrációja. DRY_RUN=true alapértelmezett. Path konverziós logika portolva pathUtils.js-ből.

- [x] **`cleanup-orphaned-thumbnails`** — Árva thumbnail fájlok időszakos takarítása. Schedule: hetente vasárnap 4:00 UTC. Storage ↔ DB összehasonlítás, orphaned fájlok törlése.
- [x] Előfizettem az Appwrite-ra de lett egy új szervezetem. Ebbe az új szervezetbe kellene áthelyezni MCP-vel a másikból a maestro projektet. Állítólag át lehet helyezni, de vigyázni kell mert van egy bug, hogy ha a régi szervezetből kitörlődik a projekt, akkor az újból is eltűnik. Nem tudom, hogy ez van e már javítva. Ha ez megvan, akkor a label-ek elgépelésének megelőzésére tervezett funkció is implementálható.
- [x] Appwrite SDK frissítés 21.5.0 → 24.1.1 (major breaking change). InDesign plugin: appwrite 21.5.0→24.1.1, Dashboard: 16.0.2→24.1.1, Proxy: node-appwrite 22.1.2→23.1.0. Kritikus: realtimeClient.js activeChannels→activeSubscriptions migráció. Összes API hívás object params stílusra átírva.
- [x] A @Maestro Web Dashboard/src/components/LayoutView.jsx-ben a nagyítás százalékos kijelzésének úgy kellene számítódni, hogy az eredeti kép pixelszáma és a megjelenítés pixelszáma közti százalékos arány legyen. Jelenleg azt veszi 100%-nak, ha az adott képernyőméreten a megadott oldalpár-oszlopszám kifér a képernyőre. A kiegészítő információknak is ezen a méreten kellene alap méreten látszódniuk ami 24pt-os lenne.
- [x] A webes felületen olyan, mintha a validátorok eredményeit saját magának generálja a weboldal, pedig az adatbázisból kellene kiolvasnia az egyes cikkekhez tartozó validátor eredményeket.
- [x] Ha be vagyok jelentkezve a webes felületre de a pluginból is szeretnék a @Maestro InDesign Plugin/src/ui/features/workspace/WorkspaceHeader.jsx#98-109 gombbal bejelentkezni, akkor a weben felugrik a bejelentkezés ablak, de nem enged belépni akkor sem, ha helyes bejelentkezési adatokat adok is meg. Valószínűleg az a baj, hogy már van egy aktív session. Lehet az, hogy ezt is vizsgáljuk?
- [x] Teljes kiadvány archiválása a @Maestro InDesign Plugin/src/core/commands/handlers/archiving.js commanddal, PDF írással amennyiben az összes cikk eljutott az archív state-re. Azt is figyelni kell, hogy a kiadvány összes oldala le legyen fedve, nyilván addig nem tudunk archiválni, amíg nincs meg az összes cikk. Ehhez egy UI-ba illeszkedő gombot kell elhelyezni. Szerintem a @Maestro InDesign Plugin/src/ui/features/workspace/WorkspaceHeader.jsx lenne a megfelelő, de csak akkor jelenjen meg ha az előbbi feltételek teljesülnek.
- [x] Csak a tervezőszerkesztők és a művészeti vezetők tudjanak PDF-et írni a commandsávban lévő gomb segítségével
- [x] Ha egy publikáció törlésre kerül, akkor az adatbázisban nem törlődnek a hozzá kapcsolódó, deadline, layout bejegyzések. — Refaktorálva: `cascade-delete` Cloud Function (`maestro-server/functions/cascade-delete/src/main.js`) mind az article mind a publication deletion eventekre
- [x] WorkspaceHeader szűrők menüpont elrejtése properties panel nézetben (`isPropertiesView` prop + feltételes renderelés)
- [x] MAESTRO lock felirat villanás javítása: optimistic update a `DocumentMonitor.verifyDocumentInBackground()`-ban — a SYSTEM lock azonnal megjelenik a helyi state-ben a DB hívás előtt
- [x] Thumbnail validáció: hiányzó és elavult oldalkép figyelmeztetés (`DatabaseIntegrityValidator.checkThumbnailStaleness()`, `documentClosed` + `documentSaved` triggerek, `VALIDATION_SOURCES.THUMBNAIL`)
- [x] Placeholder cikkek a webes felületen is. A kimarad checkboxnak a többi state checkbox mellé kell kerülnie, a helykitöltők mutatásának a saját cikkeim checkbox mellé kell kerülni úgy, ahogy a @Maestro InDesign Plugin/src/ui/features/workspace/FilterBar.jsx-ben van.
- [x] A @Maestro Web Dashboard/index.html-en kellene a fejlécbe egy layout választó dropdown és az abban kiválasztott layutot kirajzolni úgy, hogy ha az adott layouthoz nem tartozik oldal akkor az alap layout oldalát rajzolja, ha tartozik hozzá oldal, akkor pedig értelemszerűen azt.
- [x] A @Maestro Web Dashboard/index.html-en meg kellene oldani, hogy a UI-elemeket ne lehessen nagyítani, kicsinyíteni, természetesen az elrendezés nézetben az oldalakat igen.
- [x] Weben az elrendezés nézetben a zoom sávja együtt mozog az oldalakkal ha scrollozunk.
