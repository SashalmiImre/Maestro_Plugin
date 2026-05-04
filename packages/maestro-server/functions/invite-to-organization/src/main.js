const sdk = require("node-appwrite");
const crypto = require("crypto");
const {
    buildOrgTeamId,
    buildOfficeTeamId,
    buildOrgAclPerms,
    buildOfficeAclPerms,
    buildWorkflowAclPerms,
    ensureTeam,
    ensureTeamMembership,
    removeTeamMembership,
    deleteTeamIfExists
} = require("./teamHelpers.js");
// A.3.5/A.3.7 — permission helper modul (ADR 0008). A `DEFAULT_PERMISSION_SETS`
// inline duplikációja a `packages/maestro-shared/permissions.js`-ből származik
// (CF CommonJS, shared ESM — A.7.1 Phase 2 single-source bundle).
const permissions = require("./permissions.js");

// Fázis 1 helper-extract (2026-05-02): a korábban inline definiált helperek
// külön modulokba kerültek a `main.js` átláthatósága érdekében. Komment-anyag
// változatlanul a forrás-modulokban. Tilt: ciklikus require — minden helper
// csak `permissions.js` / `teamHelpers.js` / `helpers/constants.js` felé hív.
const {
    CASCADE_BATCH_LIMIT,
    MAX_REFERENCES_PER_SCAN,
    WORKFLOW_VISIBILITY_VALUES,
    WORKFLOW_VISIBILITY_DEFAULT,
    PARSE_ERROR
} = require("./helpers/constants.js");
const { deleteByQuery, cascadeDeleteOffice } = require("./helpers/cascade.js");
const {
    workflowReferencesSlug,
    contributorJsonReferencesSlug,
    validateCompiledSlugs,
    buildCompiledValidationFailure
} = require("./helpers/compiledValidator.js");
const { createWorkflowDoc } = require("./helpers/workflowDoc.js");
const {
    seedGroupsFromWorkflow,
    findEmptyRequiredGroupSlugs,
    seedDefaultPermissionSets
} = require("./helpers/groupSeed.js");
const { validateDeadlinesInline } = require("./helpers/deadlineValidator.js");
// B.0.3.0 (2026-05-03) — központi util-ok kiszervezve a CommonJS ciklikus
// require kockázat lezárására (B.0.3 inkrementális action-bontás előfeltétele).
// Az új `actions/*.js` modulok ezeket a helpereket innen require-olják, NEM
// a `main.js`-ből.
const {
    DEFAULT_WORKFLOW,
    VALID_ACTIONS,
    SLUG_REGEX,
    SLUG_MAX_LENGTH,
    NAME_MAX_LENGTH,
    fail,
    slugifyName,
    sanitizeString
} = require("./helpers/util.js");

// B.0.3.a-h (2026-05-04) — inkrementális CF action-bontás (Codex (C) opció).
// A `main.js`-ben csak az action-router maradt e szekciókhoz; a logika az
// `actions/*.js` modulokban él.
const schemaActions = require("./actions/schemas.js");
const orgActions = require("./actions/orgs.js");
const inviteActions = require("./actions/invites.js");
const groupActions = require("./actions/groups.js");
const permissionSetActions = require("./actions/permissionSets.js");
const workflowActions = require("./actions/workflows.js");

// ────────────────────────────────────────────────────────────────────────────
// TARTALOMJEGYZÉK (Fázis 1, 2026-05-02; B.0.3.0 update 2026-05-04)
//
// A fájl 36 action handler szekciót tartalmaz. Az alábbi sorszámok a B.0.3.0
// előtti (Fázis 1 helper-extract utáni) állapotot tükrözik megközelítőleg —
// a `helpers/util.js` extract után minden szekció kb. ~66 sorral feljebb
// csúszott. Az inkrementális B.0.3.a-h szétbontás során ezek a szekciók
// külön `actions/*.js` modulokba kerülnek; a TOC-ot a teljes split után
// frissítjük (vagy elhagyjuk, ha a `main.js` már csak action-router lesz).
// Pontos sorszámért: `grep -n "if (action ===" main.js`.
//
// Konstansok és utility-k:
//   `DEFAULT_WORKFLOW`, `INVITE_VALIDITY_DAYS`, `TOKEN_BYTES`, `EMAIL_REGEX`,
//   `VALID_ACTIONS`, `SLUG_REGEX`, `SLUG_MAX_LENGTH`, `NAME_MAX_LENGTH`,
//   `fail()`, `HUN_ACCENT_MAP`, `slugifyName()`, `sanitizeString()`
//   → `helpers/util.js` (B.0.3.0).
//
// CF entry-point: `module.exports = async function ({ req, res, log, error })`.
//   Init: payload parse, action whitelist, callerId header, SDK + env-guard,
//   `permissionEnv` + `permissionContext` + `callerUser` (A.3.6 / A.3.7).
//
// ACTION HANDLEREK (megközelítő sorszámok — futtatáskor pontosak lehetnek
//   a ±5-10 soros eltolódásig):
//
//   Tenant onboarding & invite flow:
//     - bootstrap_organization | create_organization     ~ 418
//     - create (admin invite)                            ~ 759
//     - accept                                           ~ 910
//     - list_my_invites                                  ~ 1085
//     - decline_invite                                   ~ 1207
//     - leave_organization                               ~ 1303
//
//   Group CRUD (A.2 + A.3.6):
//     - add_group_member                                 ~ 1540
//     - remove_group_member                              ~ 1651
//     - create_group                                     ~ 1806
//     - update_group_metadata | rename_group             ~ 1954
//     - archive_group | restore_group                    ~ 2215
//     - delete_group                                     ~ 2517
//
//   Schema bootstrap (owner-only):
//     - bootstrap_workflow_schema                        ~ 2822
//     - bootstrap_publication_schema                     ~ 3016
//     - bootstrap_groups_schema                          ~ 3094
//     - bootstrap_permission_sets_schema                 ~ 3275
//
//   Permission set CRUD (A.3 + A.3.6):
//     - create_permission_set                            ~ 3464
//     - update_permission_set                            ~ 3601
//     - archive_permission_set | restore_permission_set  ~ 3741
//     - assign_permission_set_to_group                   ~ 3853
//     - unassign_permission_set_from_group               ~ 3997
//
//   Workflow CRUD (#30/#80/#81 + A.3.6):
//     - create_workflow                                  ~ 4093
//     - create_editorial_office (LEGACY org-role check)  ~ 4261
//     - update_workflow                                  ~ 4501
//     - update_workflow_metadata                         ~ 4677
//     - archive_workflow | restore_workflow              ~ 4983
//     - delete_workflow                                  ~ 5109
//     - duplicate_workflow                               ~ 5271
//
//   Publication actions (A.2.2-A.2.10 + A.3.6):
//     - create_publication_with_workflow (dual-check)    ~ 5508
//     - assign_workflow_to_publication                   ~ 5710
//     - activate_publication                             ~ 5898
//
//   Org & office CRUD (A.3.6 org-scope):
//     - update_organization (BREAKING: org.rename owner) ~ 6112
//     - update_editorial_office                          ~ 6183
//     - delete_editorial_office                          ~ 6283
//     - delete_organization (org.delete owner-only)      ~ 6392
//
//   Tenant ACL migráció (Fázis 2 / #60):
//     - backfill_tenant_acl                              ~ 6600
// ────────────────────────────────────────────────────────────────────────────

/**
 * Appwrite Function: Invite To Organization
 *
 * Szerver-oldali tenant management. A 4 tenant collection
 * (organizations, organizationMemberships, editorialOffices,
 * editorialOfficeMemberships) + organizationInvites collectionökre
 * a kliens NEM rendelkezik direkt írási joggal — minden írás ezen a
 * CF-en keresztül történik API key-jel.
 *
 * Action-ök:
 *
 *   ACTION='bootstrap_organization' — új org + első office + owner/admin
 *     membership + 7 alapértelmezett csoport + csoporttagságok atomikus
 *     létrehozása. Az OnboardingRoute hívja első belépéskor. A CF létrehozza
 *     az összes rekordot az API key-jel. Ha bármelyik lépés elszáll, a már
 *     létrehozott rekordokat visszatörli (best-effort). Idempotens: ha a
 *     caller már tagja egy orgnak, az existing rekordot adja vissza.
 *
 *   ACTION='create_organization' — ugyanaz a 7 lépéses create logika, de
 *     az idempotencia check kihagyva (#40, avatar dropdown „Új szervezet…").
 *     A user explicit új szervezetet akar, miközben már tagja egy meglévőnek.
 *
 *   ACTION='create' — admin meghívót küld egy e-mail címre.
 *     - Caller jogosultság: csak `owner` vagy `admin` role az adott orgban.
 *     - Idempotencia: ha már van pending invite ugyanerre az email+org párra,
 *       a meglévő tokent adja vissza (nem hoz létre duplikátumot).
 *     - Token: crypto.randomBytes(32).toString('hex') → 64 char.
 *     - Lejárati idő: 7 nap.
 *     - FÁZIS 6: itt kerül majd be a `messaging.createEmail()` hívás. B.5-ben
 *       a frontend admin UI (még nincs) vagy az Appwrite Console kapja a
 *       linket, és manuálisan küldi tovább a meghívottnak.
 *
 *   ACTION='accept' — invitee elfogadja a meghívót.
 *     - Caller user kötelező (`x-appwrite-user-id` header).
 *     - Token lookup → status check → expiry check → e-mail egyezés check.
 *     - Membership létrehozás API key-jel (a collection create permission
 *       üres, tehát csak a server SDK tud írni).
 *     - Invite status frissítése `accepted`-re.
 *     - Idempotens: ha a user már tagja az orgnak, csak az invite státusz
 *       frissül és sikeres választ adunk vissza.
 *
 *   ACTION='add_group_member' — admin hozzáad egy usert egy csoporthoz.
 *     - Caller jogosultság: org owner/admin.
 *     - Payload: { groupId, userId }
 *     - Idempotens: ha már létezik a membership, success-t ad vissza.
 *
 *   ACTION='remove_group_member' — admin eltávolít egy usert egy csoportból.
 *     - Caller jogosultság: org owner/admin.
 *     - Payload: { groupId, userId }
 *     - Idempotens: ha nem létezik, success `already_removed`.
 *
 *   ACTION='create_workflow' — admin új workflow-t hoz létre egy szerkesztőség
 *     számára (default workflow klón). A név unique az office-on belül.
 *     - Caller jogosultság: org owner/admin (office → org lookup).
 *     - Payload: { editorialOfficeId, name }
 *     - Return: { success: true, workflowId, name }
 *
 *   ACTION='update_workflow' — admin frissíti a workflow compiled + graph JSON-t.
 *     - Caller jogosultság: org owner/admin (office → org lookup).
 *     - Payload: { editorialOfficeId, compiled, graph, version }
 *     - Optimistic concurrency: doc.version !== payload.version → version_conflict.
 *     - Return: { success: true, version: newVersion }
 *
 *   ACTION='create_editorial_office' — org owner/admin új szerkesztőséget hoz
 *     létre egy meglévő szervezetben. Az action létrehozza a caller-hez tartozó
 *     office-tagságot (admin role), 7 alapértelmezett csoportot, és mindegyikhez
 *     a caller groupMembership-jét. Opcionális `sourceWorkflowId`: ha megadva és
 *     a forrás ugyanabban az org-ban van, a compiled JSON klónozódik egy új
 *     workflow doc-ba az új office alá, és az office.workflowId beáll. Ha nincs
 *     megadva, az office workflow nélkül jön létre — a user a #30 Workflow tab-on
 *     rendelheti hozzá. A slug a névből auto-generálódik (Hungarian transliteráció).
 *     - Payload: { organizationId, name, sourceWorkflowId? }
 *     - Return: { success: true, editorialOfficeId, workflowId, groupsSeeded }
 *
 *   ACTION='update_editorial_office' — org owner/admin átnevezi a szerkesztőséget.
 *     A slug változatlan marad (stabilitás: office slug cikkek és publikációk
 *     nem követik). Uniqueness check: ugyanazon org-on belül nem lehet két
 *     azonos megjelenítendő nevű office.
 *     - Payload: { editorialOfficeId, name }
 *     - Return: { success: true, editorialOfficeId, name }
 *
 *   ACTION='delete_editorial_office' — org owner/admin törli a szerkesztőséget
 *     az összes alárendelt publikációval, workflow-val, csoporttal, csoport-
 *     tagsággal és office-tagsággal együtt. A publikációkat doc-onként törli,
 *     így a cascade-delete CF elkapja az event-et és takarítja az articles/
 *     layouts/deadlines (→ validations + thumbnails) rekurzívan.
 *     - Payload: { editorialOfficeId }
 *     - Return: { success: true, deletedCollections: {...} }
 *
 *   ACTION='delete_organization' — kizárólag az org `owner` role-lal
 *     rendelkező tagja törölheti az egész szervezetet. Minden alárendelt
 *     office-ra futtatja a delete_editorial_office kaszkádot, majd takarítja
 *     az organizationInvites + organizationMemberships collectiont, végül az
 *     org dokumentumot.
 *     - Payload: { organizationId }
 *     - Return: { success: true, deletedOffices, officeStats, orgCleanup }
 *
 * Trigger: nincs (HTTP, `execute: ["users"]`)
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY
 * - DATABASE_ID
 * - ORGANIZATIONS_COLLECTION_ID
 * - ORGANIZATION_MEMBERSHIPS_COLLECTION_ID
 * - EDITORIAL_OFFICES_COLLECTION_ID
 * - EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID
 * - ORGANIZATION_INVITES_COLLECTION_ID
 * - GROUPS_COLLECTION_ID
 * - GROUP_MEMBERSHIPS_COLLECTION_ID
 * - WORKFLOWS_COLLECTION_ID
 * - PUBLICATIONS_COLLECTION_ID (Fázis 8 — a delete_* action-ökhöz)
 * - PERMISSION_SETS_COLLECTION_ID (A.1 / ADR 0008 — csak a
 *   `bootstrap_permission_sets_schema` action-höz)
 * - GROUP_PERMISSION_SETS_COLLECTION_ID (A.1 / ADR 0008 — csak a
 *   `bootstrap_permission_sets_schema` action-höz)
 */

// (Fázis 1 helper-extract, 2026-05-02): a `WORKFLOW_VISIBILITY_*`,
// `CASCADE_BATCH_LIMIT`, `MAX_REFERENCES_PER_SCAN`, `PARSE_ERROR` konstansok
// a `helpers/constants.js` modulba kerültek és a fájl tetején a require-blokk
// hozza vissza őket. A `createWorkflowDoc`, `deleteByQuery`, `cascadeDeleteOffice`,
// `workflowReferencesSlug`, `contributorJsonReferencesSlug`, `validateCompiledSlugs`,
// `buildCompiledValidationFailure`, `seedGroupsFromWorkflow`,
// `findEmptyRequiredGroupSlugs`, `seedDefaultPermissionSets`,
// `validateDeadlinesInline` szintén külön modulokban — a `helpers/cascade.js`,
// `helpers/compiledValidator.js`, `helpers/workflowDoc.js`,
// `helpers/groupSeed.js`, `helpers/deadlineValidator.js` fájlokban.
//
// B.0.3.0 (2026-05-03): A `DEFAULT_WORKFLOW`, `INVITE_VALIDITY_DAYS`,
// `TOKEN_BYTES`, `EMAIL_REGEX`, `VALID_ACTIONS`, `SLUG_REGEX`,
// `SLUG_MAX_LENGTH`, `NAME_MAX_LENGTH`, `HUN_ACCENT_MAP`, `fail()`,
// `slugifyName()`, `sanitizeString()` a `helpers/util.js` modulba kerültek
// (az új `actions/*.js` modulok onnan require-olják, NEM a `main.js`-ből
// — CommonJS ciklikus require kockázat lezárása).

// A.2.8 — `DEFAULT_GROUPS` konstans eltávolítva. A felhasználó-csoportok
// forrása mostantól a workflow `compiled.requiredGroupSlugs[]`; az autoseed
// flow (`activate_publication` / `assign_workflow_to_publication`) hozza
// létre a `groups` doc-okat aktiváláskor / hozzárendeléskor.


module.exports = async function ({ req, res, log, error }) {
    try {
        // ── Payload feldolgozása ──
        let payload = {};
        if (req.body) {
            try {
                payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            } catch (e) {
                error(`Payload parse hiba: ${e.message}`);
                return fail(res, 400, 'invalid_payload');
            }
        }

        const action = payload.action;
        if (!VALID_ACTIONS.has(action)) {
            return fail(res, 400, 'invalid_action', {
                hint: `expected one of: ${[...VALID_ACTIONS].join(', ')}`
            });
        }

        // ── Caller user ID kötelező mindhárom ágon ──
        const callerId = req.headers['x-appwrite-user-id'];
        if (!callerId) {
            return fail(res, 401, 'unauthenticated');
        }

        // ── SDK init ──
        // A key elsődleges forrása a request `x-appwrite-key` header — az Appwrite
        // runtime automatikusan beinjektálja a function aktuális scope-jaival
        // generált dynamic API kulcsot. Így a CF mindig a naprakész scope-okkal
        // fut, és nem kell külön env var-ban kezelni a key-t.
        //
        // Fallback a `process.env.APPWRITE_API_KEY` env var-ra, ha valami miatt
        // a header hiányzik (pl. régebbi runtime vagy Appwrite Console-ból
        // „Execute function" gombbal).
        const apiKey = req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY || '';
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(apiKey);

        const databases = new sdk.Databases(client);
        const usersApi = new sdk.Users(client);
        const teamsApi = new sdk.Teams(client);

        const databaseId = process.env.DATABASE_ID;
        const organizationsCollectionId = process.env.ORGANIZATIONS_COLLECTION_ID;
        const membershipsCollectionId = process.env.ORGANIZATION_MEMBERSHIPS_COLLECTION_ID;
        const officesCollectionId = process.env.EDITORIAL_OFFICES_COLLECTION_ID;
        const officeMembershipsCollectionId = process.env.EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID;
        const invitesCollectionId = process.env.ORGANIZATION_INVITES_COLLECTION_ID;
        const groupsCollectionId = process.env.GROUPS_COLLECTION_ID;
        const groupMembershipsCollectionId = process.env.GROUP_MEMBERSHIPS_COLLECTION_ID;
        const workflowsCollectionId = process.env.WORKFLOWS_COLLECTION_ID;
        // Fázis 8 — a delete_organization / delete_editorial_office action-ök
        // igénylik a publications collectiont (doc-onként deleteDocument, hogy
        // a cascade-delete CF elkapja a publication.delete event-et). Ez csak
        // a delete ágakban kötelező — NEM tesszük a globális guard-ba, hogy a
        // meglévő action-ök (bootstrap/invite/workflow) tovább működjenek, ha
        // az env var még nincs beállítva a Console-on.
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;
        // Fázis 9 — a delete_group action contributor-scan ellenőrzéshez kell
        // (articles.contributors JSON slug-kulcsokat tárol). Action-szintű guard.
        const articlesCollectionId = process.env.ARTICLES_COLLECTION_ID;
        // A.1 (ADR 0008) — a `bootstrap_permission_sets_schema` action két új
        // collectiont hoz létre. A.3.6 óta a `userHasPermission()` minden
        // retrofit-elt action-en a member-pathon ezen a két collection-en
        // keres permission-set lookupot, ezért mindkét env var **globálisan
        // kötelező** (a deploy-folyamatban a `bootstrap_permission_sets_schema`
        // futtatása amúgy is előfeltétel). Ha bármelyik hiányzik, a member
        // user-ek `userHasPermission()` lookup-ja silent üres set-tel térne
        // vissza, ami a guardokban 403-at eredményezne — fail-fast jobb.
        const permissionSetsCollectionId = process.env.PERMISSION_SETS_COLLECTION_ID;
        const groupPermissionSetsCollectionId = process.env.GROUP_PERMISSION_SETS_COLLECTION_ID;

        // ── Fail-fast env var guard ──
        const missingEnvVars = [];
        if (!databaseId) missingEnvVars.push('DATABASE_ID');
        if (!organizationsCollectionId) missingEnvVars.push('ORGANIZATIONS_COLLECTION_ID');
        if (!membershipsCollectionId) missingEnvVars.push('ORGANIZATION_MEMBERSHIPS_COLLECTION_ID');
        if (!officesCollectionId) missingEnvVars.push('EDITORIAL_OFFICES_COLLECTION_ID');
        if (!officeMembershipsCollectionId) missingEnvVars.push('EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID');
        if (!invitesCollectionId) missingEnvVars.push('ORGANIZATION_INVITES_COLLECTION_ID');
        if (!groupsCollectionId) missingEnvVars.push('GROUPS_COLLECTION_ID');
        if (!groupMembershipsCollectionId) missingEnvVars.push('GROUP_MEMBERSHIPS_COLLECTION_ID');
        if (!workflowsCollectionId) missingEnvVars.push('WORKFLOWS_COLLECTION_ID');
        // A.3.6 (ADR 0008) — `userHasPermission()` member-path lookuphoz kötelező.
        if (!permissionSetsCollectionId) missingEnvVars.push('PERMISSION_SETS_COLLECTION_ID');
        if (!groupPermissionSetsCollectionId) missingEnvVars.push('GROUP_PERMISSION_SETS_COLLECTION_ID');
        if (!apiKey) missingEnvVars.push('APPWRITE_API_KEY (vagy x-appwrite-key header)');
        if (missingEnvVars.length > 0) {
            error(`[Config] Hiányzó környezeti változók: ${missingEnvVars.join(', ')}`);
            return fail(res, 500, 'misconfigured', { missing: missingEnvVars });
        }

        // A.3.6 (ADR 0008) — közös permission env objektum a `userHasPermission()`
        // / `userHasOrgPermission()` hívásokhoz + per-request memoizációs cache.
        // A CF entry-point egyszer hozza létre a contextet, és minden retrofit-elt
        // action-helper-hívás ezt kapja paraméterként (snapshot-cache `${userId}::
        // ${officeId}` kulccsal — Codex baseline review Critical fix).
        const permissionEnv = {
            databaseId,
            officesCollectionId,
            membershipsCollectionId,
            // Codex adversarial review 2026-05-02 Critical fix:
            //   defense-in-depth a member-path `groupMemberships` rogue
            //   write-tal szemben → office-tagság cross-check.
            officeMembershipsCollectionId,
            groupMembershipsCollectionId,
            groupPermissionSetsCollectionId,
            permissionSetsCollectionId
        };
        const permissionContext = permissions.createPermissionContext();

        // **A.3.6 final review fix (Codex Critical)**: a `permissions.userHasPermission`
        // / `userHasOrgPermission` 1. lépése `user.labels?.includes('admin')`
        // shortcutot ad — ezt egy `{ id: callerId }` objektum NEM tudja teljesíteni
        // (labels=undefined → false), így a globális admin override halott kód
        // lenne. Az Appwrite runtime az `x-appwrite-user-labels` headerben CSV-
        // formátumban küldi a user labels-eket — ezt felbontjuk, és a `callerUser`-be
        // tesszük. (Az `accept`/`list_my_invites`/`leave_organization` action-ök
        // saját `let callerUser` shadowing-et használnak userApi.get-ből — azok
        // önkezelő flow-k, NEM hívnak permission helpert, így a globális
        // shadowing-je biztonságos.)
        const callerLabelsHeader = req.headers['x-appwrite-user-labels'] || '';
        const callerLabels = callerLabelsHeader
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        const callerUser = { id: callerId, labels: callerLabels };

        // B.0.3 (2026-05-04) — közös handler-context.
        // A `actions/*.js` modulok ezt az egy objektumot kapják paraméterként;
        // mindegyik handler destrukturálja, amire szüksége van. Az `env` plain
        // object minden collection ID-vel; a `permissionEnv` és
        // `permissionContext` az A.3.6 retrofit-elt action-öknek kell.
        //
        // ctx shape (kanonikus — ne adjunk hozzá ad-hoc mezőt, ne átnevezzünk):
        //   - databases:   sdk.Databases példány (API key-jel)
        //   - usersApi:    sdk.Users példány
        //   - teamsApi:    sdk.Teams példány
        //   - sdk:         a `node-appwrite` modul (Query, ID, Permission, Role)
        //   - env:         { databaseId, ...CollectionId } — minden CF env var
        //   - action:      string — a payload `action` mező (handler-elágazáshoz)
        //   - callerId:    string — `x-appwrite-user-id` header
        //   - callerUser:  { id, labels: string[] } — globális admin shortcut-hoz
        //   - payload:     parsed `req.body` JSON
        //   - log/error:   Appwrite Function logger callback-ek
        //   - res:         Appwrite Function `res` (res.json + statusCode)
        //   - fail:        helpers/util.js fail() — `{ success: false, reason, ... }`
        //   - permissionEnv:    A.3.6 — `permissions.userHasPermission` env
        //   - permissionContext: A.3.6 — `permissions.createPermissionContext()` cache
        const env = {
            databaseId,
            organizationsCollectionId,
            membershipsCollectionId,
            officesCollectionId,
            officeMembershipsCollectionId,
            invitesCollectionId,
            groupsCollectionId,
            groupMembershipsCollectionId,
            workflowsCollectionId,
            publicationsCollectionId,
            articlesCollectionId,
            permissionSetsCollectionId,
            groupPermissionSetsCollectionId
        };
        const ctx = {
            databases,
            usersApi,
            teamsApi,
            sdk,
            env,
            action,
            callerId,
            callerUser,
            payload,
            log,
            error,
            res,
            fail,
            permissionEnv,
            permissionContext
        };

        // ════════════════════════════════════════════════════════
        // ACTION = 'bootstrap_organization' | 'create_organization' (B.0.3.b)
        // ════════════════════════════════════════════════════════
        if (action === 'bootstrap_organization' || action === 'create_organization') {
            return await orgActions.bootstrapOrCreateOrganization(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'create' (B.0.3.c — actions/invites.js)
        // ════════════════════════════════════════════════════════
        if (action === 'create') {
            return await inviteActions.createInvite(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'accept' (B.0.3.c — actions/invites.js)
        // ════════════════════════════════════════════════════════
        if (action === 'accept') {
            return await inviteActions.acceptInvite(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'list_my_invites' (B.0.3.c — actions/invites.js)
        // ════════════════════════════════════════════════════════
        if (action === 'list_my_invites') {
            return await inviteActions.listMyInvites(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'decline_invite' (B.0.3.c — actions/invites.js)
        // ════════════════════════════════════════════════════════
        if (action === 'decline_invite') {
            return await inviteActions.declineInvite(ctx);
        }

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'leave_organization'  (#41)
        // ════════════════════════════════════════════════════════════════
        //
        // Caller saját kilépése egy szervezetből. A teljes scope-takarítás
        // a caller saját rekordjaira korlátozott:
        //   - organizationMemberships (a caller 1 doca az adott orgban)
        //   - editorialOfficeMemberships (a caller minden office-tagsága az
        //     org alatt — több office is lehet)
        //   - groupMemberships (a caller minden csoporttagsága az org-on belül)
        //   - Appwrite Team membership-ek: `org_${orgId}` + per-office
        //     `office_${officeId}` (Realtime ACL push leszűkítés)
        //
        // Last-owner blokk: ha a caller az utolsó `owner` role-ú tag és van
        // legalább egy másik member (admin/member) → `last_owner_block`,
        // a usernek delegálnia kell előbb. Ha a caller az utolsó tag (semmi
        // egyéb membership), akkor is blokkoljuk — ilyenkor a UI a
        // `delete_organization` flow-t kínálja fel (szándékos disambiguation,
        // hogy a kilépés ne legyen árva-org generátor).
        if (action === 'leave_organization') {
            const { organizationId } = payload;
            if (!organizationId || typeof organizationId !== 'string') {
                return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
            }

            // 1) Caller org membership lekérése — kötelező.
            let callerMembership;
            try {
                const result = await databases.listDocuments(
                    databaseId,
                    membershipsCollectionId,
                    [
                        sdk.Query.equal('organizationId', organizationId),
                        sdk.Query.equal('userId', callerId),
                        sdk.Query.limit(1)
                    ]
                );
                if (result.documents.length === 0) {
                    return fail(res, 404, 'not_a_member');
                }
                callerMembership = result.documents[0];
            } catch (e) {
                error(`[LeaveOrg] caller membership lookup hiba: ${e.message}`);
                return fail(res, 500, 'membership_lookup_failed');
            }

            // 2) Last-owner blokk. Ha a caller owner, ellenőrizzük, hogy
            //    van-e másik owner. Ha nincs → blokkolva, de először
            //    eldöntjük, hogy egyedüli-e (ekkor `last_member_block`,
            //    a UI a delete_organization-t ajánlja fel).
            if (callerMembership.role === 'owner') {
                let otherOwners;
                try {
                    otherOwners = await databases.listDocuments(
                        databaseId,
                        membershipsCollectionId,
                        [
                            sdk.Query.equal('organizationId', organizationId),
                            sdk.Query.equal('role', 'owner'),
                            sdk.Query.notEqual('userId', callerId),
                            sdk.Query.limit(1)
                        ]
                    );
                } catch (e) {
                    error(`[LeaveOrg] other-owner scan hiba: ${e.message}`);
                    return fail(res, 500, 'owner_scan_failed');
                }

                if (otherOwners.documents.length === 0) {
                    // Egyedüli owner — most külön nézzük, hogy van-e bármilyen
                    // más tag. Ha van → owner-átruházás kell előtte. Ha nincs
                    // → org törlés a megoldás.
                    let otherMembers;
                    try {
                        otherMembers = await databases.listDocuments(
                            databaseId,
                            membershipsCollectionId,
                            [
                                sdk.Query.equal('organizationId', organizationId),
                                sdk.Query.notEqual('userId', callerId),
                                sdk.Query.limit(1)
                            ]
                        );
                    } catch (e) {
                        error(`[LeaveOrg] other-member scan hiba: ${e.message}`);
                        return fail(res, 500, 'owner_scan_failed');
                    }

                    if (otherMembers.documents.length > 0) {
                        return fail(res, 409, 'last_owner_block', {
                            hint: 'transfer_ownership_first'
                        });
                    }
                    return fail(res, 409, 'last_member_block', {
                        hint: 'delete_organization_instead'
                    });
                }
            }

            // 3) Az org alá tartozó office-ok listája — a per-office team
            //    cleanup-hoz kell. Lapozott listing.
            const officeIds = [];
            let cursor;
            while (true) {
                const queries = [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.select(['$id']),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ];
                if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
                let resp;
                try {
                    resp = await databases.listDocuments(databaseId, officesCollectionId, queries);
                } catch (e) {
                    error(`[LeaveOrg] office listing hiba: ${e.message}`);
                    return fail(res, 500, 'office_list_failed');
                }
                if (resp.documents.length === 0) break;
                for (const o of resp.documents) officeIds.push(o.$id);
                if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
                cursor = resp.documents[resp.documents.length - 1].$id;
            }

            // 3.5) Team cleanup STRICT — a DB doc törlések ELŐTT fut le, mert
            //      Fázis 2 ACL óta a team membership szabályozza a Realtime + REST
            //      olvasási hozzáférést. Ha előbb DB-t törölnénk és a team cleanup
            //      elbukna, a user továbbra is kapna payload-ot már-törölt
            //      rekordokról (ghost ACL access). A sorrend fordított: előbb
            //      levágjuk a push-csatornákat, utána pusztítunk DB-ben.
            //
            //      Hiba esetén 500-zal leállunk — a DB még érintetlen, a user
            //      nyugodtan újrahívhat. A `removeTeamMembership` idempotens
            //      (409/404 skip), így a retry nem ír felül semmit.
            const teamCleanup = { officeTeams: 0, orgTeam: false };
            try {
                for (const oid of officeIds) {
                    const r = await removeTeamMembership(teamsApi, buildOfficeTeamId(oid), callerId);
                    if (r.removed > 0) teamCleanup.officeTeams += r.removed;
                }
                const r = await removeTeamMembership(teamsApi, buildOrgTeamId(organizationId), callerId);
                if (r.removed > 0) teamCleanup.orgTeam = true;
            } catch (teamErr) {
                error(`[LeaveOrg] team membership remove hiba — abort, DB érintetlen: ${teamErr.message}`);
                return fail(res, 500, 'team_cleanup_failed', { message: teamErr.message });
            }

            // 4) Caller saját office membership-ek törlése. Az
            //    `editorialOfficeMemberships` collection a `(officeId, userId)`
            //    composite indexen unique, de egy user több office-ban is lehet
            //    → lapozott törlés (analóg a lenti groupMemberships loop-pal).
            let officeMembershipsRemoved = 0;
            const officeFailures = [];
            try {
                while (true) {
                    const resp = await databases.listDocuments(
                        databaseId,
                        officeMembershipsCollectionId,
                        [
                            sdk.Query.equal('organizationId', organizationId),
                            sdk.Query.equal('userId', callerId),
                            sdk.Query.limit(CASCADE_BATCH_LIMIT)
                        ]
                    );
                    if (resp.documents.length === 0) break;
                    for (const m of resp.documents) {
                        try {
                            await databases.deleteDocument(databaseId, officeMembershipsCollectionId, m.$id);
                            officeMembershipsRemoved++;
                        } catch (delErr) {
                            officeFailures.push({ docId: m.$id, message: delErr.message });
                        }
                    }
                    // Végtelen-loop guard: ha bármelyik delete hibázott, kilépünk és
                    // lejjebb 500-zal elszállunk. Nélküle egy tartós delete-hiba +
                    // full-size page esetén (documents.length === CASCADE_BATCH_LIMIT)
                    // soha nem érne véget a ciklus.
                    if (officeFailures.length > 0) break;
                    if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
                }
            } catch (e) {
                error(`[LeaveOrg] office memberships listing hiba: ${e.message}`);
                return fail(res, 500, 'office_memberships_failed');
            }
            if (officeFailures.length > 0) {
                error(`[LeaveOrg] office membership delete failures: ${JSON.stringify(officeFailures)}`);
                return fail(res, 500, 'office_memberships_failed', { failures: officeFailures });
            }

            // 5) Caller saját groupMembership-ek törlése (org-szintű szűrés).
            let groupMembershipsRemoved = 0;
            const groupFailures = [];
            try {
                while (true) {
                    const resp = await databases.listDocuments(
                        databaseId,
                        groupMembershipsCollectionId,
                        [
                            sdk.Query.equal('organizationId', organizationId),
                            sdk.Query.equal('userId', callerId),
                            sdk.Query.limit(CASCADE_BATCH_LIMIT)
                        ]
                    );
                    if (resp.documents.length === 0) break;
                    for (const m of resp.documents) {
                        try {
                            await databases.deleteDocument(databaseId, groupMembershipsCollectionId, m.$id);
                            groupMembershipsRemoved++;
                        } catch (delErr) {
                            groupFailures.push({ docId: m.$id, message: delErr.message });
                        }
                    }
                    // Ld. office-memberships loop fenti guardja — azonos infinite-loop rizikó.
                    if (groupFailures.length > 0) break;
                    if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
                }
            } catch (e) {
                error(`[LeaveOrg] group memberships listing hiba: ${e.message}`);
                return fail(res, 500, 'group_memberships_failed');
            }
            if (groupFailures.length > 0) {
                error(`[LeaveOrg] group membership delete failures: ${JSON.stringify(groupFailures)}`);
                return fail(res, 500, 'group_memberships_failed', { failures: groupFailures });
            }

            // 6) Org membership doc törlése — a fő rekord. Mostanra már
            //    minden gyerek-membership (office + group) le van bontva,
            //    az org doc-on a caller jogosultsága megszűnik.
            try {
                await databases.deleteDocument(
                    databaseId,
                    membershipsCollectionId,
                    callerMembership.$id
                );
            } catch (e) {
                error(`[LeaveOrg] org membership delete hiba (${callerMembership.$id}): ${e.message}`);
                return fail(res, 500, 'membership_delete_failed');
            }

            log(`[LeaveOrg] User ${callerId} kilépett org ${organizationId}-ból — office=${officeMembershipsRemoved}, groupMemberships=${groupMembershipsRemoved}, teams.office=${teamCleanup.officeTeams}, teams.org=${teamCleanup.orgTeam}`);

            return res.json({
                success: true,
                action: 'left',
                organizationId,
                removed: {
                    organizationMembership: 1,
                    editorialOfficeMemberships: officeMembershipsRemoved,
                    groupMemberships: groupMembershipsRemoved
                },
                teamCleanup
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'add_group_member' (B.0.3.d — actions/groups.js)
        // ════════════════════════════════════════════════════════
        if (action === 'add_group_member') {
            return await groupActions.addGroupMember(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'remove_group_member' (B.0.3.d — actions/groups.js)
        // ════════════════════════════════════════════════════════
        if (action === 'remove_group_member') {
            return await groupActions.removeGroupMember(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'create_group' (B.0.3.d — actions/groups.js)
        // ════════════════════════════════════════════════════════
        if (action === 'create_group') {
            return await groupActions.createGroup(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'update_group_metadata' | 'rename_group' (B.0.3.d)
        // ════════════════════════════════════════════════════════
        if (action === 'update_group_metadata' || action === 'rename_group') {
            return await groupActions.updateGroupMetadata(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'archive_group' | 'restore_group' (B.0.3.d)
        // ════════════════════════════════════════════════════════
        if (action === 'archive_group' || action === 'restore_group') {
            return await groupActions.archiveOrRestoreGroup(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'delete_group' (B.0.3.d — actions/groups.js)
        // ════════════════════════════════════════════════════════
        if (action === 'delete_group') {
            return await groupActions.deleteGroup(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'bootstrap_workflow_schema' (B.0.3.a — actions/schemas.js)
        // ════════════════════════════════════════════════════════
        if (action === 'bootstrap_workflow_schema') {
            return await schemaActions.bootstrapWorkflowSchema(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'bootstrap_publication_schema' (B.0.3.a — actions/schemas.js)
        // ════════════════════════════════════════════════════════
        if (action === 'bootstrap_publication_schema') {
            return await schemaActions.bootstrapPublicationSchema(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'bootstrap_groups_schema' (B.0.3.a — actions/schemas.js)
        // ════════════════════════════════════════════════════════
        if (action === 'bootstrap_groups_schema') {
            return await schemaActions.bootstrapGroupsSchema(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'bootstrap_permission_sets_schema' (B.0.3.a — actions/schemas.js)
        // ════════════════════════════════════════════════════════
        if (action === 'bootstrap_permission_sets_schema') {
            return await schemaActions.bootstrapPermissionSetsSchema(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'create_permission_set' (B.0.3.e — actions/permissionSets.js)
        // ════════════════════════════════════════════════════════
        if (action === 'create_permission_set') {
            return await permissionSetActions.createPermissionSet(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'update_permission_set' (B.0.3.e — actions/permissionSets.js)
        // ════════════════════════════════════════════════════════
        if (action === 'update_permission_set') {
            return await permissionSetActions.updatePermissionSet(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'archive_permission_set' | 'restore_permission_set' (B.0.3.e)
        // ════════════════════════════════════════════════════════
        if (action === 'archive_permission_set' || action === 'restore_permission_set') {
            return await permissionSetActions.archiveOrRestorePermissionSet(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'assign_permission_set_to_group' (B.0.3.e)
        // ════════════════════════════════════════════════════════
        if (action === 'assign_permission_set_to_group') {
            return await permissionSetActions.assignPermissionSetToGroup(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'unassign_permission_set_from_group' (B.0.3.e)
        // ════════════════════════════════════════════════════════
        if (action === 'unassign_permission_set_from_group') {
            return await permissionSetActions.unassignPermissionSetFromGroup(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'create_workflow' (B.0.3.f — actions/workflows.js)
        // ════════════════════════════════════════════════════════
        if (action === 'create_workflow') {
            return await workflowActions.createWorkflow(ctx);
        }


        // ════════════════════════════════════════════════════════
        // ACTION = 'create_editorial_office'
        // ════════════════════════════════════════════════════════
        //
        // Új szerkesztőség létrehozása egy meglévő szervezeten belül.
        // A bootstrap_organization 3–7. lépéseit replikálja (office doc +
        // officeMembership admin role + 7 default group + caller groupMembership-k
        // + opcionális workflow klón), külön org létrehozás nélkül.
        //
        // Caller: a szervezet `owner` vagy `admin` role-lal rendelkező tagja.
        //
        // Rollback: minden lépés hibája esetén a korábbi rekordokat best-effort
        // visszatöröljük (mint a bootstrap_organization).
        if (action === 'create_editorial_office') {
            const { organizationId } = payload;
            const sanitizedName = sanitizeString(payload.name, NAME_MAX_LENGTH);
            const sourceWorkflowId = typeof payload.sourceWorkflowId === 'string' && payload.sourceWorkflowId
                ? payload.sourceWorkflowId
                : null;

            if (!organizationId || !sanitizedName) {
                return fail(res, 400, 'missing_fields', {
                    required: ['organizationId', 'name']
                });
            }

            // 1. Caller jogosultság — org owner/admin.
            //
            // A.3.6 (ADR 0008) **tudatos kivétel**: az `office.create` slug az
            //   ADR 38-as taxonómiájában office-scope-ba van sorolva, de az új
            //   office még NEM LÉTEZIK — `userHasPermission(slug='office.create',
            //   officeId=???)` input-ja problémás. Mivel a helper 2. lépése
            //   úgyis automatikusan minden 33 office-scope slugot megad org
            //   owner/admin-nak, a régi role-check **logikailag ekvivalens**
            //   és a "nincs még office" probléma elkerülhető. A retrofit
            //   itt szándékosan kimarad (Codex 2026-05-02 strategy review).
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.select(['role']),
                    sdk.Query.limit(1)
                ]
            );
            if (callerMembership.documents.length === 0) {
                return fail(res, 403, 'not_a_member');
            }
            const callerRole = callerMembership.documents[0].role;
            if (callerRole !== 'owner' && callerRole !== 'admin') {
                return fail(res, 403, 'insufficient_role', { yourRole: callerRole });
            }

            // 2. Opcionális workflow forrás validáció — még az office létrehozás
            //    ELŐTT, hogy invalid source esetén ne kelljen rollback-elni.
            let sourceWorkflowDoc = null;
            if (sourceWorkflowId) {
                try {
                    sourceWorkflowDoc = await databases.getDocument(
                        databaseId,
                        workflowsCollectionId,
                        sourceWorkflowId
                    );
                } catch (err) {
                    if (err?.code === 404) return fail(res, 404, 'source_workflow_not_found');
                    error(`[CreateOffice] source workflow fetch hiba: ${err.message}`);
                    return fail(res, 500, 'source_workflow_fetch_failed');
                }
                if (sourceWorkflowDoc.organizationId !== organizationId) {
                    return fail(res, 403, 'source_workflow_scope_mismatch');
                }
            }

            // Rollback-stack (LIFO) — lásd bootstrap_organization komment.
            const rollbackSteps = [];
            const runRollback = async () => {
                for (let i = rollbackSteps.length - 1; i >= 0; i--) {
                    try { await rollbackSteps[i](); }
                    catch (e) { error(`[CreateOffice] rollback lépés hiba: ${e.message}`); }
                }
            };

            // 3. Office létrehozás — slug auto-generálás + ütközéskor retry
            //    random suffix-szel. Max 3 próba.
            const baseSlug = slugifyName(sanitizedName);
            let newOfficeId = null;
            let usedSlug = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                const candidateSlug = attempt === 0
                    ? baseSlug
                    : `${baseSlug.slice(0, SLUG_MAX_LENGTH - 5)}-${crypto.randomBytes(2).toString('hex')}`;
                try {
                    const officeDoc = await databases.createDocument(
                        databaseId,
                        officesCollectionId,
                        sdk.ID.unique(),
                        {
                            organizationId,
                            name: sanitizedName,
                            slug: candidateSlug
                        }
                    );
                    newOfficeId = officeDoc.$id;
                    usedSlug = candidateSlug;
                    rollbackSteps.push(() => databases.deleteDocument(databaseId, officesCollectionId, newOfficeId));
                    break;
                } catch (err) {
                    const isUnique = err?.type === 'document_already_exists' || /unique/i.test(err?.message || '');
                    if (isUnique && attempt < 2) continue;
                    error(`[CreateOffice] office create hiba (slug=${candidateSlug}, attempt=${attempt}): ${err.message}`);
                    if (isUnique) return fail(res, 409, 'office_slug_taken');
                    return fail(res, 500, 'office_create_failed');
                }
            }

            // 3.5. Office team — tenant ACL alapja, idempotens
            const officeTeamId = buildOfficeTeamId(newOfficeId);
            try {
                const result = await ensureTeam(teamsApi, officeTeamId, `Office: ${sanitizedName}`);
                if (result.created) {
                    rollbackSteps.push(() => teamsApi.delete(officeTeamId));
                }
            } catch (err) {
                error(`[CreateOffice] office team create hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'office_team_create_failed');
            }

            // 4. officeMembership — admin role a caller-hez.
            let newOfficeMembershipId = null;
            try {
                const memDoc = await databases.createDocument(
                    databaseId,
                    officeMembershipsCollectionId,
                    sdk.ID.unique(),
                    {
                        editorialOfficeId: newOfficeId,
                        organizationId,
                        userId: callerId,
                        role: 'admin'
                    }
                );
                newOfficeMembershipId = memDoc.$id;
                rollbackSteps.push(() => databases.deleteDocument(databaseId, officeMembershipsCollectionId, newOfficeMembershipId));
            } catch (err) {
                error(`[CreateOffice] officeMembership create hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'office_membership_create_failed');
            }

            // 4.5. Caller az office team-be (admin role — cascade-re épít: a team
            //      törlése törli a memberships-et is, ezért nem kell explicit rollback step).
            try {
                await ensureTeamMembership(teamsApi, officeTeamId, callerId, ['admin']);
            } catch (err) {
                error(`[CreateOffice] office team membership hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'office_team_membership_create_failed');
            }

            // 5-6. (A.2.8) — DEFAULT_GROUPS seedelés kivéve. Az új office 0
            //    felhasználó-csoporttal indul; a workflow `requiredGroupSlugs[]`
            //    a forrás. A caller az org-role override miatt teljes
            //    CRUD-jogot kap (`userHasPermission()` 2. lépés), tagság
            //    explicit `add_group_member` action-en keresztül adható.

            // 6.5. (A.3.2) — Default permission set seed (owner_base, admin_base,
            //      member_base) az új office-ra. Best-effort, mint a
            //      `bootstrap_organization`-ben — Codex flag: aszimmetria
            //      elkerülése a bootstrap és create_office között.
            const permSetSeed = await seedDefaultPermissionSets(
                databases,
                { databaseId, permissionSetsCollectionId },
                organizationId,
                newOfficeId,
                callerId,
                buildOfficeAclPerms,
                log,
                error
            );
            if (permSetSeed.errors.length > 0) {
                log(`[CreateOffice] permission set seed warnings: ${JSON.stringify(permSetSeed.errors)}`);
            }

            // 7. Opcionális workflow klón. Nem kritikus — ha elhasal, az office
            //    workflow nélkül marad (felhasználó később #30-ban rendelhet hozzá).
            let newWorkflowId = null;
            if (sourceWorkflowDoc) {
                try {
                    const workflowDoc = await createWorkflowDoc(
                        databases,
                        databaseId,
                        workflowsCollectionId,
                        sdk.ID.unique(),
                        {
                            editorialOfficeId: newOfficeId,
                            organizationId,
                            name: sourceWorkflowDoc.name || 'Alapértelmezett workflow',
                            version: 1,
                            compiled: typeof sourceWorkflowDoc.compiled === 'string'
                                ? sourceWorkflowDoc.compiled
                                : JSON.stringify(sourceWorkflowDoc.compiled),
                            updatedByUserId: callerId
                        },
                        WORKFLOW_VISIBILITY_DEFAULT,
                        callerId,
                        buildWorkflowAclPerms(WORKFLOW_VISIBILITY_DEFAULT, organizationId, newOfficeId),
                        log
                    );
                    newWorkflowId = workflowDoc.$id;
                    await databases.updateDocument(
                        databaseId,
                        officesCollectionId,
                        newOfficeId,
                        { workflowId: newWorkflowId }
                    );
                } catch (err) {
                    error(`[CreateOffice] workflow klón hiba: ${err.message}`);
                }
            }

            log(`[CreateOffice] User ${callerId} új office-t hozott létre: id=${newOfficeId} ("${sanitizedName}", slug=${usedSlug}), org=${organizationId}, workflow=${newWorkflowId || 'none'}`);

            return res.json({
                success: true,
                action: 'created',
                editorialOfficeId: newOfficeId,
                organizationId,
                name: sanitizedName,
                slug: usedSlug,
                workflowId: newWorkflowId,
                // A.2.8 — workflow-driven autoseed.
                groupsSeeded: 0,
                workflowSeeded: !!newWorkflowId,
                // A.3.2 — default permission set seed eredménye.
                permissionSetsSeeded: permSetSeed.created.length,
                permissionSetsSkipped: permSetSeed.skipped.length,
                permissionSetSeedErrors: permSetSeed.errors
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'update_workflow' (B.0.3.f — actions/workflows.js)
        // ════════════════════════════════════════════════════════
        if (action === 'update_workflow') {
            return await workflowActions.updateWorkflow(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'update_workflow_metadata' (B.0.3.f — actions/workflows.js)
        // ════════════════════════════════════════════════════════
        if (action === 'update_workflow_metadata') {
            return await workflowActions.updateWorkflowMetadata(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'archive_workflow' | 'restore_workflow' (B.0.3.f — actions/workflows.js)
        // ════════════════════════════════════════════════════════
        if (action === 'archive_workflow' || action === 'restore_workflow') {
            return await workflowActions.archiveOrRestoreWorkflow(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'delete_workflow' (B.0.3.f — actions/workflows.js)
        // ════════════════════════════════════════════════════════
        if (action === 'delete_workflow') {
            return await workflowActions.deleteWorkflow(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'duplicate_workflow' (B.0.3.f — actions/workflows.js)
        // ════════════════════════════════════════════════════════
        if (action === 'duplicate_workflow') {
            return await workflowActions.duplicateWorkflow(ctx);
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'create_publication_with_workflow'  (A.2.10)
        // ════════════════════════════════════════════════════════
        //
        // Atomic publikáció-létrehozás workflow-hozzárendeléssel + autoseed.
        // Codex stop-time review: az utólagos `assign_workflow_to_publication`
        // call kliens-oldali tranziens ablakot teremt (createPub → assign
        // között a publikáció workflowId nélkül látható Realtime-on át, más
        // tab/derived state csendben null/wrong workflow-val futna).
        //
        // Auth: caller a target office-ának tagja. A workflow scope (3-way
        // visibility) szerver-szinten validált. Rollback ha az autoseed
        // bukik (deleteDocument a frissen létrehozott publikációra).
        //
        // Payload: `{ organizationId, editorialOfficeId, workflowId, name,
        //   coverageStart, coverageEnd, excludeWeekends?, rootPath? }`
        // Return: `{ success, publication, autoseed }`
        if (action === 'create_publication_with_workflow') {
            const {
                organizationId,
                editorialOfficeId,
                workflowId,
                name,
                coverageStart,
                coverageEnd,
                excludeWeekends,
                rootPath
            } = payload;

            if (!organizationId || !editorialOfficeId || !workflowId || !name
                || coverageStart == null || coverageEnd == null) {
                return fail(res, 400, 'missing_fields', {
                    required: ['organizationId', 'editorialOfficeId', 'workflowId', 'name', 'coverageStart', 'coverageEnd']
                });
            }
            if (!publicationsCollectionId) {
                return fail(res, 500, 'misconfigured', {
                    missing: ['PUBLICATIONS_COLLECTION_ID']
                });
            }

            // 1) Auth — A.3.6 dual permission check (Codex strategy review):
            //    az endpoint kombinált művelet (publikáció create + workflow
            //    assign), ezért MINDKÉT slugnak teljesülnie kell, különben
            //    egy `publication.create`-jogú user megkerülné a workflow
            //    assign-jogot. Az ADR 0008 helper-szerződése szerint
            //    `userHasPermission()` true-t ad org owner/admin-nak mind a
            //    33 slugra, így a meglévő admin-flow változatlan; member
            //    user-eknek viszont mindkét slug kell a `permissionSets`-ben.
            //
            //    Auth-first védelem: a workflow-létezést nem szivárogtatjuk
            //    nem-tag user-nek — a permission helper false-t ad, ha a user
            //    nem tagja az office-nak (orgRole=null, nincs groupMembership).
            const allowedCreate = await permissions.userHasPermission(
                databases,
                permissionEnv,
                callerUser,
                'publication.create',
                editorialOfficeId,
                permissionContext.snapshotsByOffice,
                permissionContext.orgRoleByOrg
            );
            if (!allowedCreate) {
                return fail(res, 403, 'insufficient_permission', {
                    slug: 'publication.create',
                    scope: 'office'
                });
            }
            const allowedAssign = await permissions.userHasPermission(
                databases,
                permissionEnv,
                callerUser,
                'publication.workflow.assign',
                editorialOfficeId,
                permissionContext.snapshotsByOffice,
                permissionContext.orgRoleByOrg
            );
            if (!allowedAssign) {
                return fail(res, 403, 'insufficient_permission', {
                    slug: 'publication.workflow.assign',
                    scope: 'office'
                });
            }

            // 1.5) Office → org match validáció a payload integritásához.
            //      A permission helper már ellenőrizte, hogy a caller jogosult
            //      ezen az office-on, de még mindig le kell csekkolni, hogy
            //      a `payload.organizationId` és az office tényleges
            //      organizationId-ja egyezik (különben mismatched scope).
            let officeOrgIdCheck;
            try {
                const officeDoc = await databases.getDocument(
                    databaseId,
                    officesCollectionId,
                    editorialOfficeId
                );
                officeOrgIdCheck = officeDoc.organizationId;
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'office_not_found');
                error(`[CreatePubWithWorkflow] office fetch hiba: ${err.message}`);
                return fail(res, 500, 'office_fetch_failed');
            }
            if (officeOrgIdCheck && officeOrgIdCheck !== organizationId) {
                return fail(res, 403, 'organization_mismatch');
            }

            // 2) Workflow fetch + 3-way visibility scope match.
            let workflowDoc;
            try {
                workflowDoc = await databases.getDocument(databaseId, workflowsCollectionId, workflowId);
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'workflow_not_found');
                error(`[CreatePubWithWorkflow] workflow fetch hiba: ${err.message}`);
                return fail(res, 500, 'workflow_fetch_failed');
            }
            const wfVisibility = WORKFLOW_VISIBILITY_VALUES.includes(workflowDoc.visibility)
                ? workflowDoc.visibility
                : WORKFLOW_VISIBILITY_DEFAULT;
            let scopeOk = false;
            if (wfVisibility === 'public') scopeOk = true;
            else if (wfVisibility === 'organization' && workflowDoc.organizationId === organizationId) scopeOk = true;
            else if (wfVisibility === 'editorial_office' && workflowDoc.editorialOfficeId === editorialOfficeId) scopeOk = true;
            if (!scopeOk) {
                return fail(res, 403, 'workflow_scope_mismatch', {
                    visibility: wfVisibility
                });
            }

            // 3) Compiled parse (ha nem parse-elhető, fail-fast a create előtt).
            let compiled;
            try {
                compiled = typeof workflowDoc.compiled === 'string'
                    ? JSON.parse(workflowDoc.compiled)
                    : workflowDoc.compiled;
            } catch (parseErr) {
                error(`[CreatePubWithWorkflow] workflow compiled parse hiba: ${parseErr.message}`);
                return fail(res, 500, 'workflow_compiled_invalid');
            }

            // 4) Atomic createDocument. A `validate-publication-update` post-event
            //    CF a scope-mezőket validálja; a workflowId set + isActivated:false
            //    nem triggereli a aktiválási guardot, így biztonságos.
            const docPayload = {
                organizationId,
                editorialOfficeId,
                workflowId,
                name: String(name).trim(),
                coverageStart: parseInt(coverageStart, 10),
                coverageEnd: parseInt(coverageEnd, 10),
                isActivated: false,
                modifiedByClientId: callerId
            };
            if (typeof excludeWeekends === 'boolean') docPayload.excludeWeekends = excludeWeekends;
            if (typeof rootPath === 'string' && rootPath.trim() !== '') docPayload.rootPath = rootPath.trim();

            let pubDoc;
            try {
                pubDoc = await databases.createDocument(
                    databaseId,
                    publicationsCollectionId,
                    sdk.ID.unique(),
                    docPayload
                );
            } catch (err) {
                error(`[CreatePubWithWorkflow] publikáció create hiba: ${err.message}`);
                return fail(res, 500, 'publication_create_failed', { error: err.message });
            }

            // 5) Autoseed — ha bukik, rollback (deleteDocument). A publikáció
            //    NEM maradhat workflowId-vel DE seedeletlen csoportokkal,
            //    különben a következő aktiváló-flow `empty_required_groups`-ot
            //    adna a usernek hibás kontextusban.
            let autoseed;
            try {
                autoseed = await seedGroupsFromWorkflow(
                    databases,
                    { databaseId, groupsCollectionId },
                    compiled,
                    editorialOfficeId,
                    organizationId,
                    callerId,
                    log,
                    buildOfficeAclPerms
                );
            } catch (seedErr) {
                error(`[CreatePubWithWorkflow] autoseed hiba — rollback (pub=${pubDoc.$id}): ${seedErr.message}`);
                try {
                    await databases.deleteDocument(databaseId, publicationsCollectionId, pubDoc.$id);
                } catch (rollbackErr) {
                    error(`[CreatePubWithWorkflow] rollback hiba (pub=${pubDoc.$id}, orphan!): ${rollbackErr.message}`);
                }
                return fail(res, 500, 'autoseed_failed', { error: seedErr.message });
            }

            log(`[CreatePubWithWorkflow] User ${callerId}: pub=${pubDoc.$id} ("${docPayload.name}") létrehozva workflow=${workflowId}-vel, autoseed.created=[${autoseed.created.join(',')}]`);

            return res.json({
                success: true,
                action: 'created',
                publication: pubDoc,
                autoseed
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'assign_workflow_to_publication'  (A.2.3)
        // ════════════════════════════════════════════════════════
        //
        // Workflow hozzárendelése egy publikációhoz + autoseed a workflow
        // `requiredGroupSlugs[]`-ban szereplő összes csoportra. NEM követeli
        // meg a min. 1 tagot — az csak az `activate_publication`-nél kötelező.
        //
        // Auth: caller az adott publikáció office-ának tagja kell legyen
        // (officeMembership), és a workflow scope-ja meg kell egyezzen az
        // office-szal (vagy az org-gal `organization` visibility esetén,
        // vagy `public` visibility-nél bárkinek).
        //
        // Payload: `{ publicationId, workflowId }`
        // Return: `{ success, publicationId, workflowId, autoseed: { created, existed, warnings } }`
        if (action === 'assign_workflow_to_publication') {
            const { publicationId, workflowId, expectedUpdatedAt } = payload;
            if (!publicationId || !workflowId) {
                return fail(res, 400, 'missing_fields', {
                    required: ['publicationId', 'workflowId']
                });
            }
            if (!publicationsCollectionId) {
                return fail(res, 500, 'misconfigured', {
                    missing: ['PUBLICATIONS_COLLECTION_ID']
                });
            }

            // 1) Pub fetch
            let pubDoc;
            try {
                pubDoc = await databases.getDocument(databaseId, publicationsCollectionId, publicationId);
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'publication_not_found');
                error(`[AssignWorkflow] publikáció fetch hiba: ${err.message}`);
                return fail(res, 500, 'publication_fetch_failed');
            }

            // 1a) Optimistic concurrency guard (parity az `activate_publication`-nel,
            //     SHOULD FIX). Két paralel tab a workflow-t különböző értékre
            //     állíthatja; az `expectedUpdatedAt` opt-in védelmet ad a
            //     last-write-wins ellen.
            if (expectedUpdatedAt && pubDoc.$updatedAt !== expectedUpdatedAt) {
                return fail(res, 409, 'concurrent_modification', {
                    expectedUpdatedAt,
                    currentUpdatedAt: pubDoc.$updatedAt,
                    note: 'A publikáció módosult a betöltés óta. Frissítsd az állapotot és próbáld újra.'
                });
            }

            // 2) A.3.6 — `publication.workflow.assign` office-scope permission
            //    guard (auth-first sorrend megőrzi a Codex MAGAS review-t: a
            //    workflow-létezést nem szivárogtatjuk nem-tag user-nek, mert
            //    a helper false-t ad, ha a user nem tagja az office-nak).
            const allowed = await permissions.userHasPermission(
                databases,
                permissionEnv,
                callerUser,
                'publication.workflow.assign',
                pubDoc.editorialOfficeId,
                permissionContext.snapshotsByOffice,
                permissionContext.orgRoleByOrg
            );
            if (!allowed) {
                return fail(res, 403, 'insufficient_permission', {
                    slug: 'publication.workflow.assign',
                    scope: 'office'
                });
            }

            // 3) Workflow fetch + scope match
            let workflowDoc;
            try {
                workflowDoc = await databases.getDocument(databaseId, workflowsCollectionId, workflowId);
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'workflow_not_found');
                error(`[AssignWorkflow] workflow fetch hiba: ${err.message}`);
                return fail(res, 500, 'workflow_fetch_failed');
            }
            // Visibility-alapú scope match: a workflow office-ára vagy
            // org-jára kell illeszteni — különben nem rendelhető hozzá.
            const wfVisibility = WORKFLOW_VISIBILITY_VALUES.includes(workflowDoc.visibility)
                ? workflowDoc.visibility
                : WORKFLOW_VISIBILITY_DEFAULT;
            let scopeOk = false;
            if (wfVisibility === 'public') scopeOk = true;
            else if (wfVisibility === 'organization' && workflowDoc.organizationId === pubDoc.organizationId) scopeOk = true;
            else if (wfVisibility === 'editorial_office' && workflowDoc.editorialOfficeId === pubDoc.editorialOfficeId) scopeOk = true;
            if (!scopeOk) {
                return fail(res, 403, 'workflow_scope_mismatch', {
                    visibility: wfVisibility,
                    workflowOfficeId: workflowDoc.editorialOfficeId,
                    publicationOfficeId: pubDoc.editorialOfficeId
                });
            }

            // 4) Aktivált pub workflow-cseréje TILTOTT (snapshot védi a runtime-ot,
            //    de új workflow autoseed-elése zavart okozna). Ez a checkout a
            //    `validate-publication-update` Fázis 6 §-jával konzisztens
            //    (`workflowLockReason` post-event guard).
            if (pubDoc.isActivated === true && pubDoc.workflowId !== workflowId) {
                return fail(res, 409, 'publication_active_workflow_locked', {
                    note: 'Aktivált publikáció workflow-ja nem cserélhető. Deaktiváld előbb.'
                });
            }

            // 5) Compiled parse → autoseed
            let compiled;
            try {
                compiled = typeof workflowDoc.compiled === 'string'
                    ? JSON.parse(workflowDoc.compiled)
                    : workflowDoc.compiled;
            } catch (parseErr) {
                error(`[AssignWorkflow] workflow compiled parse hiba: ${parseErr.message}`);
                return fail(res, 500, 'workflow_compiled_invalid');
            }

            let autoseed;
            try {
                autoseed = await seedGroupsFromWorkflow(
                    databases,
                    { databaseId, groupsCollectionId },
                    compiled,
                    pubDoc.editorialOfficeId,
                    pubDoc.organizationId,
                    callerId,
                    log,
                    buildOfficeAclPerms
                );
            } catch (seedErr) {
                error(`[AssignWorkflow] autoseed hiba (pub=${publicationId}): ${seedErr.message}`);
                return fail(res, 500, 'autoseed_failed', { error: seedErr.message });
            }

            // 6) Pub update — workflowId set. A `validate-publication-update`
            //    post-event guard nem fog rontani: a pub továbbra is
            //    `isActivated: false` (vagy ugyanaz az érték), nincs aktiválási
            //    flag-csere.
            let updatedPubDoc;
            try {
                updatedPubDoc = await databases.updateDocument(
                    databaseId,
                    publicationsCollectionId,
                    publicationId,
                    {
                        workflowId,
                        modifiedByClientId: callerId
                    }
                );
            } catch (updErr) {
                error(`[AssignWorkflow] pub update hiba (pub=${publicationId}): ${updErr.message}`);
                return fail(res, 500, 'publication_update_failed');
            }

            log(`[AssignWorkflow] User ${callerId}: pub=${publicationId} ← workflow=${workflowId}, autoseed created=[${autoseed.created.join(',')}], existed=[${autoseed.existed.join(',')}]`);

            return res.json({
                success: true,
                action: 'assigned',
                publicationId,
                workflowId,
                // A.2.9 — a fresh dokumentumot visszaadjuk, hogy a kliens
                // a `$updatedAt`-tel együtt patchelhesse a lokális state-et
                // (stale Realtime push-ok elleni védelem).
                publication: updatedPubDoc,
                autoseed
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'activate_publication'  (A.2.2 + A.2.4)
        // ════════════════════════════════════════════════════════
        //
        // Publikáció aktiválása. Lépések:
        //   1. Caller office-membership a pub office-ában (auth gate).
        //   2. Pre-aktiválási validáció: workflowId set + deadline-fedés
        //      (inline `validateDeadlinesInline`).
        //   3. Autoseed a workflow `requiredGroupSlugs[]`-ra (idempotens).
        //   4. Empty check: minden slug-ra legalább 1 `groupMembership`
        //      → 409 `empty_required_groups` + a hiányzó slug-ok listája.
        //   5. Atomic update: `isActivated: true, activatedAt, compiledWorkflowSnapshot,
        //      modifiedByClientId: SERVER_GUARD_ID`. A SERVER_GUARD sentinel
        //      a post-event `validate-publication-update` guard-ot skip-pel,
        //      hogy a snapshot ne íródjon felül és a deaktiválás-loop-ot
        //      megelőzzük.
        //
        // Snapshot (A.2.4): a `compiledWorkflowSnapshot` mezőbe a workflow
        // teljes `compiled` JSON-ját írjuk — a `requiredGroupSlugs[]` mezővel
        // együtt. Ez rögzíti az aktiváláskori állapotot (a futó pub immune
        // marad workflow-változásra).
        //
        // Idempotens: ha a pub már aktiválva van + snapshot azonos a workflow
        // jelenlegi `compiled`-jével → `already_activated` success.
        //
        // **TOCTOU NOTE (Codex review)**: két paralel `activate_publication`
        // last-write-wins szemantikát kap (`activatedAt` és snapshot az utolsó
        // író szerint). Az `expectedUpdatedAt` opcionális kliens-paraméter
        // optimistic guardot ad: ha a pub `$updatedAt` már nem azonos a kliens
        // által ismert értékkel, 409 `concurrent_modification` válasz. A
        // dashboard frontend a save flow-ban átadja, az UI duplaklikk-védelem
        // kiegészítéseként.
        //
        // Payload: `{ publicationId, expectedUpdatedAt? }`
        if (action === 'activate_publication') {
            const { publicationId, expectedUpdatedAt } = payload;
            if (!publicationId) {
                return fail(res, 400, 'missing_fields', {
                    required: ['publicationId']
                });
            }
            const missingActivateEnvs = [];
            if (!publicationsCollectionId) missingActivateEnvs.push('PUBLICATIONS_COLLECTION_ID');
            const deadlinesCollectionId = process.env.DEADLINES_COLLECTION_ID;
            if (!deadlinesCollectionId) missingActivateEnvs.push('DEADLINES_COLLECTION_ID');
            if (missingActivateEnvs.length > 0) {
                return fail(res, 500, 'misconfigured', { missing: missingActivateEnvs });
            }

            // 1) Pub fetch
            let pubDoc;
            try {
                pubDoc = await databases.getDocument(databaseId, publicationsCollectionId, publicationId);
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'publication_not_found');
                error(`[ActivatePub] publikáció fetch hiba: ${err.message}`);
                return fail(res, 500, 'publication_fetch_failed');
            }

            // 1a) Optimistic concurrency guard — ha a kliens átadta az
            //    `expectedUpdatedAt`-et, ennek meg kell egyeznie a fresh
            //    `$updatedAt`-tel. Ez fedi a TOCTOU race-t (két paralel
            //    activate, egyik már módosította az állapotot).
            if (expectedUpdatedAt && pubDoc.$updatedAt !== expectedUpdatedAt) {
                return fail(res, 409, 'concurrent_modification', {
                    expectedUpdatedAt,
                    currentUpdatedAt: pubDoc.$updatedAt,
                    note: 'A publikáció módosult a betöltés óta. Frissítsd az állapotot és próbáld újra.'
                });
            }

            // 2) A.3.6 — `publication.activate` office-scope permission guard.
            const allowed = await permissions.userHasPermission(
                databases,
                permissionEnv,
                callerUser,
                'publication.activate',
                pubDoc.editorialOfficeId,
                permissionContext.snapshotsByOffice,
                permissionContext.orgRoleByOrg
            );
            if (!allowed) {
                return fail(res, 403, 'insufficient_permission', {
                    slug: 'publication.activate',
                    scope: 'office'
                });
            }

            // 3) workflowId kötelező
            if (!pubDoc.workflowId) {
                return fail(res, 422, 'workflow_required', {
                    note: 'A kiadványhoz workflow-t kell rendelni az aktiválás előtt (assign_workflow_to_publication).'
                });
            }

            // 4-5) Workflow fetch + deadline lookup paralel — független
            //      hívások (mindkettő csak a pubDoc-ot követeli).
            let workflowDoc;
            let deadlines;
            try {
                const [wf, deadlineResult] = await Promise.all([
                    databases.getDocument(databaseId, workflowsCollectionId, pubDoc.workflowId),
                    databases.listDocuments(
                        databaseId,
                        deadlinesCollectionId,
                        [
                            sdk.Query.equal('publicationId', publicationId),
                            sdk.Query.limit(500)
                        ]
                    )
                ]);
                workflowDoc = wf;
                deadlines = deadlineResult.documents || [];
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'workflow_not_found');
                error(`[ActivatePub] workflow/deadline fetch hiba: ${err.message}`);
                return fail(res, 500, 'preactivation_fetch_failed', { error: err.message });
            }

            const deadlineCheck = validateDeadlinesInline(pubDoc, deadlines);
            if (!deadlineCheck.isValid) {
                return fail(res, 422, 'invalid_deadlines', {
                    errors: deadlineCheck.errors
                });
            }
            if (deadlines.length === 0) {
                return fail(res, 422, 'invalid_deadlines', {
                    errors: ['Legalább egy határidőt meg kell adni.']
                });
            }

            // Normalizált compiled string — a snapshot-egyezés ellenőrzéshez
            // ÉS a snapshot-íráshoz egyaránt. Ha a `workflowDoc.compiled`
            // bármilyen okból nem string (pl. legacy seriálizálás), enélkül
            // a `pubDoc.compiledWorkflowSnapshot === workflowDoc.compiled`
            // string-vs-object hasonlítás sosem lenne egyenlő, és az `already_
            // activated` retry mindig új snapshot-ot írna (nem idempotens).
            const compiledStr = typeof workflowDoc.compiled === 'string'
                ? workflowDoc.compiled
                : JSON.stringify(workflowDoc.compiled);

            // 6) Idempotens early-return — már aktiválva ugyanezzel a
            //    workflow-snapshottal. Compiled parse ELŐTT: így sérült de
            //    azonos snapshotú retry is zöldet ad (a runtime amúgy is a
            //    snapshot string-egyezésből dolgozik, nem a parse-olt JSON-ból).
            const alreadyActivatedSameWorkflow =
                pubDoc.isActivated === true
                && pubDoc.compiledWorkflowSnapshot === compiledStr;
            if (alreadyActivatedSameWorkflow) {
                return res.json({
                    success: true,
                    action: 'already_activated',
                    publicationId,
                    workflowId: pubDoc.workflowId,
                    activatedAt: pubDoc.activatedAt,
                    publication: pubDoc
                });
            }

            // 7) Compiled parse — autoseed + empty-check ezt használja, így
            //    csak az új aktiváló ágon szükséges (idempotens után).
            let compiled;
            try {
                compiled = JSON.parse(compiledStr);
            } catch (parseErr) {
                error(`[ActivatePub] workflow compiled parse hiba: ${parseErr.message}`);
                return fail(res, 500, 'workflow_compiled_invalid');
            }

            // 8) Autoseed (idempotens — `assign_workflow_to_publication` már
            //    valószínűleg lefuttatta; a workflow azóta változhatott).
            let autoseed;
            try {
                autoseed = await seedGroupsFromWorkflow(
                    databases,
                    { databaseId, groupsCollectionId },
                    compiled,
                    pubDoc.editorialOfficeId,
                    pubDoc.organizationId,
                    callerId,
                    log,
                    buildOfficeAclPerms
                );
            } catch (seedErr) {
                error(`[ActivatePub] autoseed hiba (pub=${publicationId}): ${seedErr.message}`);
                return fail(res, 500, 'autoseed_failed', { error: seedErr.message });
            }

            // 9) Empty check
            const requiredSlugs = Array.isArray(compiled.requiredGroupSlugs)
                ? compiled.requiredGroupSlugs.map(e => e?.slug).filter(s => typeof s === 'string')
                : [];
            const emptySlugs = await findEmptyRequiredGroupSlugs(
                databases,
                { databaseId, groupsCollectionId, groupMembershipsCollectionId },
                requiredSlugs,
                pubDoc.editorialOfficeId
            );
            if (emptySlugs.length > 0) {
                return fail(res, 409, 'empty_required_groups', {
                    slugs: emptySlugs,
                    note: 'A workflow által kötelező csoportoknak legalább 1 tagja kell legyen az aktiválás előtt.',
                    autoseed
                });
            }

            // 10) Atomic update — isActivated + snapshot. SERVER_GUARD sentinel
            //     a post-event `validate-publication-update`-nek (skip).
            const SERVER_GUARD_ID = 'server-guard';
            const nowIso = new Date().toISOString();
            let updatedPubDoc;
            try {
                updatedPubDoc = await databases.updateDocument(
                    databaseId,
                    publicationsCollectionId,
                    publicationId,
                    {
                        isActivated: true,
                        activatedAt: nowIso,
                        compiledWorkflowSnapshot: compiledStr,
                        modifiedByClientId: SERVER_GUARD_ID
                    }
                );
            } catch (updErr) {
                error(`[ActivatePub] pub update hiba (pub=${publicationId}): ${updErr.message}`);
                return fail(res, 500, 'activation_update_failed');
            }

            log(`[ActivatePub] User ${callerId} aktiválta: pub=${publicationId}, workflow=${pubDoc.workflowId}, snapshot.size=${compiledStr.length}, autoseed.created=${autoseed.created.length}`);

            return res.json({
                success: true,
                action: 'activated',
                publicationId,
                workflowId: pubDoc.workflowId,
                activatedAt: nowIso,
                // A.2.9 — fresh `$updatedAt` a stale Realtime push-ok elleni
                // optimistic patch-hez. A `compiledWorkflowSnapshot` (~1MB)
                // benne van; a kliens nem render-eli direktbe, de a snapshot-
                // immutability guard miatt ne küldjük csonkítva.
                publication: updatedPubDoc,
                autoseed
            });
        }

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'update_organization' (B.0.3.b — actions/orgs.js)
        // ════════════════════════════════════════════════════════════════
        if (action === 'update_organization') {
            return await orgActions.updateOrganization(ctx);
        }

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'update_editorial_office'
        // ════════════════════════════════════════════════════════════════
        //
        // Szerkesztőség átnevezése. A slug változatlan — a cikk / publikáció
        // rekordok nem hivatkoznak a slugra (csak az office $id-re), így a
        // megjelenítendő név szabadon cserélhető. Uniqueness: ugyanazon org-on
        // belül nem lehet két azonos `name`-ű office (case-insensitive check-et
        // kerülünk, hogy a case-distinct név még használható legyen — a UI-ban
        // a user látja, hogy pontosan milyen név ütközik).
        if (action === 'update_editorial_office') {
            const { editorialOfficeId, name } = payload;

            if (!editorialOfficeId || !name) {
                return fail(res, 400, 'missing_fields', {
                    required: ['editorialOfficeId', 'name']
                });
            }

            const sanitizedName = sanitizeString(name, NAME_MAX_LENGTH);
            if (!sanitizedName) {
                return fail(res, 400, 'invalid_name');
            }

            // 1) Office létezés check
            let officeDoc;
            try {
                officeDoc = await databases.getDocument(
                    databaseId,
                    officesCollectionId,
                    editorialOfficeId
                );
            } catch (fetchErr) {
                if (fetchErr.code === 404) return fail(res, 404, 'office_not_found');
                error(`[UpdateOffice] getDocument hiba: ${fetchErr.message}`);
                return fail(res, 500, 'office_fetch_failed');
            }

            // 2) A.3.6 — `office.rename` office-scope permission guard.
            const allowed = await permissions.userHasPermission(
                databases,
                permissionEnv,
                callerUser,
                'office.rename',
                editorialOfficeId,
                permissionContext.snapshotsByOffice,
                permissionContext.orgRoleByOrg
            );
            if (!allowed) {
                return fail(res, 403, 'insufficient_permission', {
                    slug: 'office.rename',
                    scope: 'office'
                });
            }

            // 3) Uniqueness check — ugyanazon org más office-a nem foglalhatja
            //    ugyanezt a nevet. A saját office self-match-et kizárjuk, hogy
            //    idempotens rename (változatlan név → 200 OK, noop) ne dobjon.
            if (sanitizedName !== officeDoc.name) {
                const conflictQuery = await databases.listDocuments(
                    databaseId,
                    officesCollectionId,
                    [
                        sdk.Query.equal('organizationId', officeDoc.organizationId),
                        sdk.Query.equal('name', sanitizedName),
                        sdk.Query.limit(1)
                    ]
                );
                const conflict = conflictQuery.documents.find(d => d.$id !== editorialOfficeId);
                if (conflict) {
                    return fail(res, 409, 'name_taken');
                }
            }

            // 4) Frissítés
            try {
                await databases.updateDocument(
                    databaseId,
                    officesCollectionId,
                    editorialOfficeId,
                    { name: sanitizedName }
                );
            } catch (updateErr) {
                error(`[UpdateOffice] updateDocument hiba: ${updateErr.message}`);
                return fail(res, 500, 'update_failed');
            }

            log(`[UpdateOffice] User ${callerId} átnevezte office ${editorialOfficeId} → "${sanitizedName}"`);

            return res.json({
                success: true,
                action: 'updated',
                editorialOfficeId,
                name: sanitizedName
            });
        }

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'delete_editorial_office'
        // ════════════════════════════════════════════════════════════════
        //
        // Szerkesztőség kaszkád törlés: publications (→ cascade-delete CF
        // takarítja az articles/layouts/deadlines-t), workflows, groups,
        // groupMemberships, editorialOfficeMemberships, majd maga az office.
        //
        // Caller: a szervezet `owner` vagy `admin` role-lal rendelkező tagja.
        //
        // Fail-closed: ha bármely gyerek cleanup-lépés elhasal, az office
        // dokumentumot NEM töröljük — inkább árva gyerek nélküli retry,
        // mint elveszett tulajdonosi lánc.
        if (action === 'delete_editorial_office') {
            // Delete action-szintű env var guard — a PUBLICATIONS_COLLECTION_ID
            // csak ehhez az action-höz kell, ne blokkolja a többi flow-t.
            if (!publicationsCollectionId) {
                error('[DeleteOffice] PUBLICATIONS_COLLECTION_ID nincs beállítva.');
                return fail(res, 500, 'misconfigured', { missing: ['PUBLICATIONS_COLLECTION_ID'] });
            }

            const { editorialOfficeId } = payload;
            if (!editorialOfficeId || typeof editorialOfficeId !== 'string') {
                return fail(res, 400, 'missing_fields', { required: ['editorialOfficeId'] });
            }

            // 1) Office létezés check
            let officeDoc;
            try {
                officeDoc = await databases.getDocument(
                    databaseId,
                    officesCollectionId,
                    editorialOfficeId
                );
            } catch (fetchErr) {
                if (fetchErr.code === 404) return fail(res, 404, 'office_not_found');
                error(`[DeleteOffice] getDocument hiba: ${fetchErr.message}`);
                return fail(res, 500, 'office_fetch_failed');
            }

            const officeOrgId = officeDoc.organizationId;

            // 2) A.3.6 — `office.delete` office-scope permission guard.
            const allowed = await permissions.userHasPermission(
                databases,
                permissionEnv,
                callerUser,
                'office.delete',
                editorialOfficeId,
                permissionContext.snapshotsByOffice,
                permissionContext.orgRoleByOrg
            );
            if (!allowed) {
                return fail(res, 403, 'insufficient_permission', {
                    slug: 'office.delete',
                    scope: 'office'
                });
            }

            // 3) Kaszkád takarítás a helper-rel — fail-closed.
            const envIds = {
                databaseId,
                publicationsCollectionId,
                workflowsCollectionId,
                groupsCollectionId,
                groupMembershipsCollectionId,
                officeMembershipsCollectionId
            };

            let stats;
            try {
                stats = await cascadeDeleteOffice(databases, editorialOfficeId, envIds, log);
            } catch (cascadeErr) {
                error(`[DeleteOffice] Kaszkád hiba (${editorialOfficeId}) [collection=${cascadeErr.collectionId || 'n/a'}]: ${cascadeErr.message}`);
                return fail(res, 500, 'cascade_failed', {
                    message: cascadeErr.message
                });
            }

            // 4) Az office dokumentum törlése — csak akkor, ha minden gyerek
            //    cleanup sikeres volt.
            try {
                await databases.deleteDocument(databaseId, officesCollectionId, editorialOfficeId);
            } catch (deleteErr) {
                error(`[DeleteOffice] office doc törlés: ${deleteErr.message}`);
                return fail(res, 500, 'office_delete_failed');
            }

            // 5) Office team cleanup — best-effort. Az office doc már törölve,
            //    a team törlés cascade-eli a memberships-et. Ha elbukik, a team
            //    árva (nem létező office-ra mutat) — nem blokkoljuk a usert.
            try {
                await deleteTeamIfExists(teamsApi, buildOfficeTeamId(editorialOfficeId));
            } catch (teamErr) {
                error(`[DeleteOffice] office team törlés best-effort hiba: ${teamErr.message}`);
            }

            log(`[DeleteOffice] User ${callerId} törölte office ${editorialOfficeId} ("${officeDoc.name}") + kaszkád`);

            return res.json({
                success: true,
                action: 'deleted',
                editorialOfficeId,
                deletedCollections: stats
            });
        }

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'delete_organization' (B.0.3.b — actions/orgs.js)
        // ════════════════════════════════════════════════════════════════
        if (action === 'delete_organization') {
            return await orgActions.deleteOrganization(ctx);
        }

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'backfill_tenant_acl' (B.0.3.a — actions/schemas.js)
        // ════════════════════════════════════════════════════════════════
        if (action === 'backfill_tenant_acl') {
            return await schemaActions.backfillTenantAcl(ctx);
        }

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
