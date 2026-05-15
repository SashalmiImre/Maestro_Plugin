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
// ADR 0010 W3 — Resend e-mail kiküldés (külön action-modul, mert a Resend
// SDK csak a sendEmail.js-ben él; az invites.js belsőleg hívja a
// sendOneInviteEmail-t auto-send flow-ban).
const sendEmailActions = require("./actions/sendEmail.js");
const groupActions = require("./actions/groups.js");
const permissionSetActions = require("./actions/permissionSets.js");
const workflowActions = require("./actions/workflows.js");
const officeActions = require("./actions/offices.js");
const publicationActions = require("./actions/publications.js");
// B.3.1 (ADR 0007 Phase 0, 2026-05-04) — workflow extension CRUD.
const extensionActions = require("./actions/extensions.js");

// ────────────────────────────────────────────────────────────────────────────
// ACTION HANDLERS (B.0.3 plan 3. pont, 2026-05-04)
//
// Dispatch table: action-string → handler függvény. A CF entry-pointja
// ezen keresztül routeolja a request-et a megfelelő `actions/*.js`
// modulra. Az alias action-ök (pl. `bootstrap_organization` és
// `create_organization`) ugyanarra a handler-re mutatnak, és a handler
// `ctx.action`-ből dönt a flow-ról (lásd `bootstrapOrCreateOrganization`,
// `archiveOrRestoreGroup`, `archiveOrRestoreWorkflow`,
// `archiveOrRestorePermissionSet`, `updateGroupMetadata` (`rename_group`
// alias)).
//
// A map kulcsainak halmaza ÉS a `VALID_ACTIONS` (helpers/util.js) halmaza
// szinkronban kell legyen. Drift-rizikó: ha új action-t adnak hozzá, mindkét
// helyen frissíteni kell. Defense-in-depth: a router 500-at ad ha a két
// lista szétcsúszik (lásd lent a fallback ágat).
// ────────────────────────────────────────────────────────────────────────────
const ACTION_HANDLERS = {
    // Tenant onboarding & invite flow
    'bootstrap_organization': orgActions.bootstrapOrCreateOrganization,
    'create_organization': orgActions.bootstrapOrCreateOrganization,
    'create': inviteActions.createInvite,
    'create_batch_invites': inviteActions.createBatchInvites,
    'accept': inviteActions.acceptInvite,
    'list_my_invites': inviteActions.listMyInvites,
    'decline_invite': inviteActions.declineInvite,
    'leave_organization': officeActions.leaveOrganization,
    // ADR 0010 W3 — e-mail újraküldés (admin manuális gomb).
    // (`send_invite_email_batch` törölve — Codex review 2026-05-08 BLOCKER 1
    // miatt; a multi-invite flow a createBatchInvites belső auto-send-et használ.)
    'send_invite_email': sendEmailActions.sendInviteEmail,

    // Group CRUD (A.2 + A.3.6)
    'add_group_member': groupActions.addGroupMember,
    'remove_group_member': groupActions.removeGroupMember,
    'create_group': groupActions.createGroup,
    'update_group_metadata': groupActions.updateGroupMetadata,
    'rename_group': groupActions.updateGroupMetadata,
    'archive_group': groupActions.archiveOrRestoreGroup,
    'restore_group': groupActions.archiveOrRestoreGroup,
    'delete_group': groupActions.deleteGroup,

    // Schema bootstrap (owner-only) + ACL backfill
    'bootstrap_workflow_schema': schemaActions.bootstrapWorkflowSchema,
    'bootstrap_publication_schema': schemaActions.bootstrapPublicationSchema,
    'bootstrap_groups_schema': schemaActions.bootstrapGroupsSchema,
    'bootstrap_permission_sets_schema': schemaActions.bootstrapPermissionSetsSchema,
    'bootstrap_workflow_extension_schema': schemaActions.bootstrapWorkflowExtensionSchema,
    'backfill_tenant_acl': schemaActions.backfillTenantAcl,
    // 2026-05-07 — userName/userEmail denormalizáció backfill (owner-anywhere).
    'backfill_membership_user_names': schemaActions.backfillMembershipUserNames,
    // ADR 0010 W2 — invite collection séma-bővítés (4 új mező) + rate-limit collectionök.
    'bootstrap_invites_schema_v2': schemaActions.bootstrapInvitesSchemaV2,
    'bootstrap_rate_limit_schema': schemaActions.bootstrapRateLimitSchema,
    // D.2 (2026-05-09) — last-owner enforcement Phase 1.5: organizations.status enum
    'bootstrap_organization_status_schema': schemaActions.bootstrapOrganizationStatusSchema,
    'backfill_organization_status': schemaActions.backfillOrganizationStatus,
    // D.3 (2026-05-09) — invite audit-trail collection
    'bootstrap_organization_invite_history_schema': schemaActions.bootstrapOrganizationInviteHistorySchema,
    // E (2026-05-09 follow-up) — Q1 ACL refactor: admin-team scoped backfill
    'backfill_admin_team_acl': schemaActions.backfillAdminTeamAcl,
    // S.7.2 (2026-05-12) — R.S.7.2 close: legacy ACL backfill 5 collection-én.
    // Target-org-owner auth + scope-paraméter (multi-call, kerüli a CF 60s
    // timeout-ot egy nagy orgon) + user-read preserve (ADR 0014).
    'backfill_acl_phase2': schemaActions.backfillAclPhase2,
    // S.7.7b (2026-05-15) — R.S.7.6 close: collection-meta `documentSecurity`
    // flag verify a 6 user-data collection-en. Read-only deploy-gate
    // (ADR 0014 Layer 1 prerequisite). Target-org-owner auth.
    'verify_collection_document_security': schemaActions.verifyCollectionDocumentSecurity,
    // S.7.7c (2026-05-15) — R.S.7.7 close: legacy ACL backfill a 6 user-data
    // collection-en (publications + articles + layouts + deadlines + 2 validation).
    // Kategória 1/2 fallback policy + `fallbackUsedDocs` audit + 2-step JOIN.
    'backfill_acl_phase3': schemaActions.backfillAclPhase3,
    // S.7.9 (2026-05-15) — R.S.7.5 close: GDPR Art. 17 stale withCreator
    // user-read cleanup. 12 collection scan, self-anonymize + admin-anonymize
    // kettős auth. Auto-trigger a leave_organization + delete_my_account flow-ban.
    'anonymize_user_acl': schemaActions.anonymizeUserAcl,

    // Permission set CRUD (A.3 + A.3.6)
    'create_permission_set': permissionSetActions.createPermissionSet,
    'update_permission_set': permissionSetActions.updatePermissionSet,
    'archive_permission_set': permissionSetActions.archiveOrRestorePermissionSet,
    'restore_permission_set': permissionSetActions.archiveOrRestorePermissionSet,
    'assign_permission_set_to_group': permissionSetActions.assignPermissionSetToGroup,
    'unassign_permission_set_from_group': permissionSetActions.unassignPermissionSetFromGroup,

    // Workflow CRUD (#30/#80/#81 + A.3.6)
    'create_workflow': workflowActions.createWorkflow,
    'update_workflow': workflowActions.updateWorkflow,
    'update_workflow_metadata': workflowActions.updateWorkflowMetadata,
    'archive_workflow': workflowActions.archiveOrRestoreWorkflow,
    'restore_workflow': workflowActions.archiveOrRestoreWorkflow,
    'delete_workflow': workflowActions.deleteWorkflow,
    'duplicate_workflow': workflowActions.duplicateWorkflow,

    // Publication actions (A.2.2-A.2.10 + A.3.6)
    'create_publication_with_workflow': publicationActions.createPublicationWithWorkflow,
    'assign_workflow_to_publication': publicationActions.assignWorkflowToPublication,
    'activate_publication': publicationActions.activatePublication,

    // Org & office CRUD (A.3.6 org-scope/office-scope)
    'update_organization': orgActions.updateOrganization,
    // 2026-05-07: org-tag role változtatás (org.member.role.change slug,
    // self-edit + last-owner + owner-touch guardokkal). UsersTab role-dropdown.
    'change_organization_member_role': orgActions.changeOrganizationMemberRole,
    // 2026-05-10 ([[Döntések/0012-org-member-removal-cascade]]) — admin-kick a
    // UsersTab "Felhasználók" tabról. STRICT team-cleanup + cascade DB delete.
    'remove_organization_member': orgActions.removeOrganizationMember,
    // 2026-05-10 ([[Döntések/0013-self-service-account-management]]) — self-service
    // fiók-törlés a /settings/account profile-screen-en. Cross-org cleanup +
    // users.delete. Codex BLOCKER B1+B2+B3 fix-ek beépítve.
    'delete_my_account': orgActions.deleteMyAccount,
    // D.2.5b (2026-05-09) — recovery flow orphan org-ra. Globális admin auth,
    // saját guard-dal (NEM userHasOrgPermission, mert az orphan-guard fail-closed).
    'transfer_orphaned_org_ownership': orgActions.transferOrphanedOrgOwnership,
    'create_editorial_office': officeActions.createEditorialOffice,
    'update_editorial_office': officeActions.updateEditorialOffice,
    'delete_editorial_office': officeActions.deleteEditorialOffice,
    'delete_organization': orgActions.deleteOrganization,

    // B.3.1 (ADR 0007 Phase 0) — workflow extension CRUD.
    'create_workflow_extension': extensionActions.createWorkflowExtension,
    'update_workflow_extension': extensionActions.updateWorkflowExtension,
    'archive_workflow_extension': extensionActions.archiveWorkflowExtension
};

// Module-load-time invariáns: a `VALID_ACTIONS` és `ACTION_HANDLERS`
// kulcs-halmazának egyeznie kell. Drift fail-fast-ot dob a require-load-kor
// (cold start container init → a CF az első hívásnál azonnal kibukik 500-zal,
// nem szétszórt 500/misconfigured-ekkel a futási idő során).
//
// Két irány:
//   - VALID_ACTIONS-ban van, ACTION_HANDLERS-ben nincs → halott eljutás a
//     router fallback-jéhez (500 misconfigured runtime — defenseive-in-depth)
//   - ACTION_HANDLERS-ben van, VALID_ACTIONS-ban nincs → halott kód (a CF entry
//     `VALID_ACTIONS.has` guard-ja eldobja, mielőtt a router-hez érne)
{
    const handlerKeys = new Set(Object.keys(ACTION_HANDLERS));
    const validKeys = VALID_ACTIONS;
    const missing = [...validKeys].filter(k => !handlerKeys.has(k));
    const extra = [...handlerKeys].filter(k => !validKeys.has(k));
    if (missing.length > 0 || extra.length > 0) {
        const err = new Error(
            `[Router] ACTION_HANDLERS / VALID_ACTIONS drift: `
            + `missing=[${missing.join(',')}], extra=[${extra.join(',')}]`
        );
        // Dobás require-load-time → cold start fail-fast.
        throw err;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// FÁJL-SZERKEZET (B.0.3 inkrementális action-bontás után, 2026-05-04)
//
// A `main.js` mostantól TÖMÖR action-router. A meglévő action handler-ek
// logikája 8 külön `actions/*.js` modulban él; a `main.js` csak az init +
// dispatch. Az ACTION_HANDLERS / VALID_ACTIONS halmaz a B-blokk feladatokkal
// folyamatosan bővül — az aktuális méretet a `helpers/util.js` `VALID_ACTIONS`
// set-je és az alábbi `ACTION_HANDLERS` map kulcs-halmaza ÉS a require-load-time
// drift-check együtt fémjelzi.
//
// Konstansok és utility-k → `helpers/util.js` (B.0.3.0):
//   DEFAULT_WORKFLOW, INVITE_VALIDITY_DAYS, TOKEN_BYTES, EMAIL_REGEX,
//   VALID_ACTIONS, SLUG_REGEX, SLUG_MAX_LENGTH, NAME_MAX_LENGTH,
//   HUN_ACCENT_MAP, fail(), slugifyName(), sanitizeString().
//
// Fázis 1 helper-extract → `helpers/{constants,cascade,compiledValidator,
//   workflowDoc,groupSeed,deadlineValidator}.js`.
//
// Action handlers (B.0.3.a-h, + B.1 bővítések):
//   - actions/schemas.js          — bootstrap_*_schema (workflow / publication /
//                                   groups / permission_sets / workflow_extension)
//                                   + backfill_tenant_acl
//   - actions/orgs.js             — bootstrap/create/update/delete_organization
//   - actions/invites.js          — create/accept/decline_invite/list_my_invites
//   - actions/groups.js           — add/remove_group_member, create/update_metadata,
//                                   rename_group alias, archive/restore/delete_group
//   - actions/permissionSets.js   — create/update/archive/restore_permission_set,
//                                   assign/unassign_permission_set_to_group
//   - actions/workflows.js        — create/update/update_metadata/archive/restore/
//                                   delete/duplicate_workflow
//   - actions/offices.js          — leave_organization, create/update/delete_editorial_office
//   - actions/publications.js     — create_publication_with_workflow (A.2.10 atomic),
//                                   assign_workflow_to_publication, activate_publication
//
// Tilos import-irány: `actions/*` → `helpers/*` → `permissions.js` /
// `teamHelpers.js`. Visszafelé NEM (CommonJS ciklikus require csendben
// fél-inicializált exports-ot ad).
//
// CF entry-point: `module.exports = async function ({ req, res, log, error })`.
//   Init: payload parse + action whitelist + callerId header + SDK
//   + env-guard + `permissionEnv` + `permissionContext` + `callerUser`
//   + ctx (handler-context) → `ACTION_HANDLERS[action](ctx)`.
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
 * - PERMISSION_SETS_COLLECTION_ID (A.1 / ADR 0008 — A.3.6 retrofit óta
 *   GLOBÁLISAN KÖTELEZŐ a `userHasPermission()` member-path lookuphoz)
 * - GROUP_PERMISSION_SETS_COLLECTION_ID (A.1 / ADR 0008 — A.3.6 retrofit
 *   óta GLOBÁLISAN KÖTELEZŐ)
 * - WORKFLOW_EXTENSIONS_COLLECTION_ID (B.1.1 / ADR 0007 Phase 0 — egyelőre
 *   CSAK a `bootstrap_workflow_extension_schema` action-höz; a B.3 új CRUD
 *   action-jeinek érkezésekor globális fail-fast-ba emelendő.)
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
        // B.1.1 (ADR 0007 Phase 0) — workflowExtensions collection.
        // **B.3 (2026-05-04) — globális fail-fast**: a B.3.1 új CRUD action-jei
        // (`create/update/archive_workflow_extension`) ÉS a B.3.3 snapshot
        // logika (`activate_publication`) is ezen a collection-en olvas/ír,
        // ezért a `PERMISSION_SETS_COLLECTION_ID` evolúciójának mintáját
        // (A.3.6) követve a globális env var listára emeljük. Hiánya
        // 500 `misconfigured`-et ad mindenfaj action-re.
        const workflowExtensionsCollectionId = process.env.WORKFLOW_EXTENSIONS_COLLECTION_ID;

        // ADR 0010 W2/W3 (2026-05-08) — invite redesign env vars.
        //
        // Mindegyik OPCIONÁLIS (NEM fail-fast):
        //   - `DASHBOARD_URL`: a Resend e-mail link `${url}/invite?token=...` épít.
        //     Hiányzik → e-mail kiküldés `failed` (link nem épül).
        //   - `RESEND_API_KEY`: a Resend SDK auth. Hiányzik → sendOneInviteEmail
        //     skeleton-stubbal jár (invite létrejön, e-mail NEM ment ki, log warn).
        //   - `IP_RATE_LIMIT_*_COLLECTION_ID`: ha a 2 collection nincs felvéve, a
        //     `checkRateLimit` log-warningot ad és átenged — best-effort védelem.
        const dashboardUrl = process.env.DASHBOARD_URL || '';
        const resendApiKey = process.env.RESEND_API_KEY || '';
        const ipRateLimitCountersCollectionId = process.env.IP_RATE_LIMIT_COUNTERS_COLLECTION_ID || '';
        const ipRateLimitBlocksCollectionId = process.env.IP_RATE_LIMIT_BLOCKS_COLLECTION_ID || '';
        // D.3 (2026-05-09) — invite audit-trail collection. OPCIONÁLIS env var:
        // ha hiányzik, a `_archiveInvite` helper csak loggol és skippel (a fő
        // accept/decline flow nem blokkolódik). A `bootstrap_organization_invite_history_schema`
        // action-höz kötelező.
        const organizationInviteHistoryCollectionId = process.env.ORGANIZATION_INVITE_HISTORY_COLLECTION_ID || '';

        // S.7.7b (2026-05-15) — `verify_collection_document_security` action env varok.
        // OPCIONÁLISAK (NEM fail-fast): csak az új RO action használja, így a meglévő
        // CF deploy-okat NEM töri. Hiányuk az action stats-ban `missingEnv: true`
        // jelzéssel megjelenik + `criticalFail: true` (a 6 required user-data
        // collection-re hat). A 2 új CF env var (`LAYOUTS_COLLECTION_ID`,
        // `DEADLINES_COLLECTION_ID`, `USER_VALIDATIONS_COLLECTION_ID`,
        // `SYSTEM_VALIDATIONS_COLLECTION_ID`) a deploy-trigger user-task része.
        const layoutsCollectionId = process.env.LAYOUTS_COLLECTION_ID || '';
        const deadlinesCollectionId = process.env.DEADLINES_COLLECTION_ID || '';
        const userValidationsCollectionId = process.env.USER_VALIDATIONS_COLLECTION_ID || '';
        const systemValidationsCollectionId = process.env.SYSTEM_VALIDATIONS_COLLECTION_ID || '';

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
        // B.3 (ADR 0007 Phase 0, 2026-05-04) — a B.3.1 CRUD action-ök ÉS a
        // B.3.3 `activate_publication` snapshot scan globális olvasója.
        if (!workflowExtensionsCollectionId) missingEnvVars.push('WORKFLOW_EXTENSIONS_COLLECTION_ID');
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
            permissionSetsCollectionId,
            // D.2.4 (2026-05-09 Codex baseline BLOCKER fix): a `getOrgStatus()`
            // orphan-guard a `organizations` doc `status` mezőjét olvassa.
            // Hiánya esetén `'lookup_failed'` sentinel → `userHasOrgPermission()`
            // fail-closed minden `org.*` slug-ra (5xx admin attention).
            organizationsCollectionId
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

        // 2026-05-07 — User identity per-request cache.
        // Az `organizationMemberships` és `editorialOfficeMemberships` collection-ök
        // mostantól denormalizálják a `userName` és `userEmail` mezőket (snapshot-at-join).
        // A `helpers/util.fetchUserIdentity(usersApi, userId, cache)` ezt a Map-et
        // használja, hogy egy request egy userId-re csak egyszer hívja az `usersApi.get`-et
        // (pl. bootstrap a self-membership + office-membership ágon kétszer érintené).
        const userIdentityCache = new Map();

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
            groupPermissionSetsCollectionId,
            workflowExtensionsCollectionId,
            // ADR 0010 W2/W3 (opcionális, ld. fent)
            dashboardUrl,
            resendApiKey,
            ipRateLimitCountersCollectionId,
            ipRateLimitBlocksCollectionId,
            // D.3 (2026-05-09) — invite audit-trail (opcionális, ld. fent)
            organizationInviteHistoryCollectionId,
            // S.7.7b (2026-05-15) — opcionális collection ID-k a
            // `verify_collection_document_security` action számára.
            layoutsCollectionId,
            deadlinesCollectionId,
            userValidationsCollectionId,
            systemValidationsCollectionId
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
            req, // ADR 0010 W2 — rate-limit middleware (extractClientIp) a x-forwarded-for headert olvassa
            fail,
            permissionEnv,
            permissionContext,
            userIdentityCache
        };

        // ════════════════════════════════════════════════════════
        // Action router (B.0.3 plan 3. pont): if-elif lánc helyett
        // dispatch table. A `VALID_ACTIONS` (helpers/util.js) már
        // szűrte az ismeretlen action-öket, így a lookup soha nem
        // ad undefined-et — defense-in-depth fallback alább.
        // ════════════════════════════════════════════════════════
        const handler = ACTION_HANDLERS[action];
        if (handler) {
            return await handler(ctx);
        }

        // Unreachable a `VALID_ACTIONS.has(action)` guard miatt — de
        // defense-in-depth: ha a két lista szétcsúszik (pl. új action
        // VALID_ACTIONS-ban, de handler-map-ben nincs), 500-zal
        // jelezzük a misconfig-et és nem 200/undefined-del.
        error(`[Router] Unmapped action passed VALID_ACTIONS guard: ${action}`);
        return fail(res, 500, 'misconfigured', {
            note: `Action "${action}" valid, de nincs handler-je. Frissítsd az ACTION_HANDLERS map-et.`
        });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
