// B.0.3.b (2026-05-04) — Organization CRUD action-ok kiszervezve külön modulba.
// Tartalmazza: bootstrap_organization, create_organization, update_organization,
// delete_organization. Az `update_editorial_office`/`delete_editorial_office`
// és a `create_editorial_office` az `actions/offices.js` (B.0.3.g) hatáskör.
//
// Tilos import-irány: `actions/*` → `helpers/*` → `permissions.js` /
// `teamHelpers.js`. Visszafelé NEM (CommonJS ciklikus require).

const {
    NAME_MAX_LENGTH,
    SLUG_MAX_LENGTH,
    SLUG_REGEX,
    DEFAULT_WORKFLOW,
    sanitizeString,
    fetchUserIdentity,
    listOfficeIdsForOrg
} = require('../helpers/util.js');
// S.7.9 Phase 4b (2026-05-15) — self-anonymize integrate a `deleteMyAccount`-ban.
const { anonymizeUserAclCore } = require('./schemas.js');
const { CASCADE_BATCH_LIMIT, WORKFLOW_VISIBILITY_DEFAULT } = require('../helpers/constants.js');
const { deleteByQuery, cascadeDeleteOffice } = require('../helpers/cascade.js');
const { evaluateAndConsume } = require('../helpers/rateLimit.js');
const { createWorkflowDoc } = require('../helpers/workflowDoc.js');
const { seedDefaultPermissionSets } = require('../helpers/groupSeed.js');
const {
    buildOrgTeamId,
    buildOrgAdminTeamId,
    buildOfficeTeamId,
    buildOrgAclPerms,
    buildOfficeAclPerms,
    buildWorkflowAclPerms,
    withCreator,
    ensureTeam,
    ensureTeamMembership,
    removeTeamMembership,
    deleteTeamIfExists
} = require('../teamHelpers.js');
const permissions = require('../permissions.js');

/**
 * D.2.4 (Codex simplify R3+Q7, 2026-05-09) — közös org-status reset helper.
 * A `transfer_orphaned_org_ownership` (hard-fail) és a
 * `change_organization_member_role` self-heal (best-effort) ugyanazt a
 * `updateDocument(orgs, orgId, { status: 'active' })` write-ot csinálta. A
 * helper egységesíti, a hívó dönti el, dob-e a hibára: ha hard-fail, nem
 * fogja a hibát. Ha best-effort, a hívó saját try-be teszi.
 *
 * @returns {Promise<void>} dob, ha az updateDocument bukik
 */
async function _setOrgStatusActive(databases, env, organizationId) {
    await databases.updateDocument(
        env.databaseId,
        env.organizationsCollectionId,
        organizationId,
        { status: permissions.ORG_STATUS.ACTIVE }
    );
}

/**
 * S.7.8 Phase 1 (2026-05-15) — phantom-org window finalize helper.
 *
 * Csak akkor finalize-eli a doc-ot (`status: 'provisioning' → 'active'`), ha az
 * `env.enableProvisioningGuard` env-flag bekapcsolt. Fail-soft: a hibát NEM
 * dobja, csak loggolja — a phantom-doc 'provisioning'-on marad, és a frontend
 * filter Phase 2 NEM listázza. Admin a `_setOrgStatusActive`-szal manuálisan
 * finalize-elheti (pl. `update_organization` action-en át).
 *
 * @param {Object} ctx - handler context
 * @param {string} organizationId - frissen létrejött org $id
 * @returns {Promise<void>}
 */
async function _finalizeOrgIfProvisioning(ctx, organizationId) {
    if (!ctx.env.enableProvisioningGuard) {
        return { finalized: true, skipped: true };
    }
    try {
        await _setOrgStatusActive(ctx.databases, ctx.env, organizationId);
        return { finalized: true };
    } catch (e) {
        // Codex stop-time MAJOR fix (2026-05-15): a finalize bukás esetén
        // explicit jelez a caller-nek. A doc 'provisioning'-on marad, és a
        // `isOrgWriteBlocked('provisioning')` minden CRUD action-t 403-mal
        // blokkol. A return-ben `provisioningStuck: true` + `recoveryHint`
        // → frontend észreveheti és figyelmeztetheti a usert / retry-zhet.
        ctx.error(`[Bootstrap] status finalize hiba (org=${organizationId}, doc 'provisioning'-on marad): ${e.message}`);
        return { finalized: false, error: e.message };
    }
}

/**
 * ACTION='bootstrap_organization' | 'create_organization' (#40)
 *
 * Atomikus 4-collection write: organizations + organizationMemberships
 * (owner) + editorialOffices + editorialOfficeMemberships (admin).
 *
 * Rollback: ha a 2-3-4. lépésnél hiba van, a már létrehozott
 * rekordokat visszatöröljük (best-effort).
 *
 * Mindkét action ugyanazt a 7 lépéses logikát futtatja. Eltérés:
 *   - bootstrap_organization (onboarding, első org): idempotens — ha
 *     a caller már tagja BÁRMELY orgnak, az existing org ID-t adja
 *     vissza (duplaklikk-védelem az első org létrehozásnál).
 *   - create_organization (avatar dropdown „Új szervezet…", #40):
 *     a caller már tagja egy orgnak, mégis explicit új-t akar — az
 *     idempotens ág kihagyva, minden hívás új szervezetet hoz létre.
 *     A frontend duplaklikk-védelmet a modal `isSubmitting` guardja
 *     adja, a slug ütközés (`org_slug_taken`) a szerveroldali unique
 *     index-en bukik el.
 */
async function bootstrapOrCreateOrganization(ctx) {
    const { databases, env, callerId, payload, log, error, res, fail, sdk, teamsApi, usersApi, userIdentityCache, action } = ctx;

    // 2026-05-07 — Self user identity lookup a denormalizált membership
    // mezőkhöz (`userName`, `userEmail`). Egyszer fetch-elünk, kétszer
    // használjuk (organizationMemberships + editorialOfficeMemberships).
    // Failure tolerant: ha a lookup bukik, `null` marad — a flow tovább megy.
    const callerIdentity = await fetchUserIdentity(usersApi, callerId, userIdentityCache, log);

    const orgName = sanitizeString(payload.orgName, NAME_MAX_LENGTH);
    const orgSlug = sanitizeString(payload.orgSlug, SLUG_MAX_LENGTH);
    // Office mezők OPCIONÁLISAK (2026-04-20): a dashboard onboarding
    // flow már nem kényszerít auto-kreált „Általános" szerkesztőséget.
    // Ha a payload nem ad officeName/officeSlug-ot, a 3–7. lépés
    // (office + team + 7 default group + workflow seed) korai return-nel
    // kimarad, a user 0 office-szal landol az új orgban. A Dashboard
    // onboarding splash felajánlja a `create_editorial_office`-t.
    // Régi kliens (aki még ad office mezőket) továbbra is támogatott.
    const officeName = sanitizeString(payload.officeName, NAME_MAX_LENGTH);
    const officeSlug = sanitizeString(payload.officeSlug, SLUG_MAX_LENGTH);
    const hasOffice = !!(officeName && officeSlug);

    if (!orgName || !orgSlug) {
        return fail(res, 400, 'missing_fields', {
            required: ['orgName', 'orgSlug']
        });
    }

    if (!SLUG_REGEX.test(orgSlug) || (hasOffice && !SLUG_REGEX.test(officeSlug))) {
        return fail(res, 400, 'invalid_slug', {
            hint: 'slug must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/'
        });
    }

    // ── Idempotencia (csak bootstrap_organization-nél): ha a caller
    // már tagja valamelyik orgnak, nem hozunk létre újat. Ez véd a
    // duplaklikkelés és a retry ellen (pl. a kliens elhalt a válasz
    // előtt és újraküldi a kérést). Ugyanazt a success payload-ot
    // adjuk vissza, mint az első futás.
    //
    // A create_organization action SZÁNDÉKOSAN átugorja ezt — ott
    // a user explicit új szervezetet kér az avatar menüből, miközben
    // már van egy meglévő tagsága.
    if (action === 'bootstrap_organization') {
        const existingOrgMembership = await databases.listDocuments(
            env.databaseId,
            env.membershipsCollectionId,
            [
                sdk.Query.equal('userId', callerId),
                sdk.Query.limit(1)
            ]
        );
        if (existingOrgMembership.documents.length > 0) {
            const existingOrgId = existingOrgMembership.documents[0].organizationId;

            // Office-t is próbáljuk felderíteni ugyanehhez a userhez —
            // ha nincs, visszaadjuk csak az orgId-t, és a kliens a
            // loadAndSetMemberships után úgy is az első tagot választja.
            let existingOfficeId = null;
            try {
                const existingOfficeMembership = await databases.listDocuments(
                    env.databaseId,
                    env.officeMembershipsCollectionId,
                    [
                        sdk.Query.equal('userId', callerId),
                        sdk.Query.equal('organizationId', existingOrgId),
                        sdk.Query.limit(1)
                    ]
                );
                if (existingOfficeMembership.documents.length > 0) {
                    existingOfficeId = existingOfficeMembership.documents[0].editorialOfficeId;
                }
            } catch (err) {
                log(`[Bootstrap] Office membership lookup (idempotens ág) hiba: ${err.message}`);
            }

            // S.7.8 Phase 1 (2026-05-15) Codex stop-time MINOR fix: ha a
            // pre-existing org `provisioning`-on ragadt egy korábbi sikertelen
            // finalize miatt, self-heal — best-effort `_setOrgStatusActive`.
            const reFinalizeResult = await _finalizeOrgIfProvisioning(ctx, existingOrgId);
            log(`[Bootstrap] Idempotens — caller ${callerId} már tagja az org ${existingOrgId}-nak, új rekord nem jött létre, reFinalized=${reFinalizeResult.finalized}`);
            return res.json({
                success: true,
                action: 'existing',
                organizationId: existingOrgId,
                editorialOfficeId: existingOfficeId,
                ...(reFinalizeResult.finalized === false && {
                    provisioningStuck: true,
                    provisioningStuckReason: reFinalizeResult.error,
                    recoveryHint: 'Admin manuálisan futtathat `update_organization`-t a status: "active"-ra állításhoz.'
                })
            });
        }
    }

    // Rollback-stack — LIFO: bármelyik hibapontnál visszafelé fut a
    // fordított sorrendben, így elkerüli a korábbi verzió 5x-ismétlődő
    // try/catch rollback láncát. Best-effort: minden lépés saját
    // catch-csel, hogy egy delete hiba ne szakítsa meg a többit.
    const rollbackSteps = [];
    const runRollback = async () => {
        for (let i = rollbackSteps.length - 1; i >= 0; i--) {
            try { await rollbackSteps[i](); }
            catch (e) { error(`[Bootstrap] rollback lépés hiba: ${e.message}`); }
        }
    };

    // 1. organizations
    // S.7.1 fix (2026-05-12): doc-szintű ACL `Permission.read(team:org_${orgId})`.
    // Az ID-t előre generáljuk, hogy a `buildOrgAclPerms(newOrgId)` a `createDocument`
    // paraméterében felhasználható legyen (egy API-hívás, atomikus).
    //
    // S.7.8 Phase 1 (2026-05-15): phantom-org window mitigáció. Ha az
    // `enableProvisioningGuard` env-flag bekapcsolt, a doc `status: 'provisioning'`-szel
    // jön létre — a frontend filter (Phase 2) `Query.equal('status', 'active')`-szel
    // szűri ki, és a `userHasOrgPermission()` `isOrgWriteBlocked('provisioning')`-szel
    // fail-closed. A flow-vég finalize-eli `'active'`-ra. Rollback ágon a status
    // `provisioning`-on marad (admin törölheti / recovery-zheti).
    let newOrgId = sdk.ID.unique();
    try {
        const newOrg = await databases.createDocument(
            env.databaseId,
            env.organizationsCollectionId,
            newOrgId,
            {
                name: orgName,
                slug: orgSlug,
                ownerUserId: callerId,
                status: env.enableProvisioningGuard ? permissions.ORG_STATUS.PROVISIONING : permissions.ORG_STATUS.ACTIVE
            },
            // S.7 stop-time MAJOR fix (2026-05-12): `withCreator` defense-in-depth.
            // A `Permission.read(team:org_${orgId})` ACL még NEM hat a creator-ra,
            // mert az `org_${orgId}` team létrejön (204) ÉS a `ensureTeamMembership`
            // (247) csak később fut. Az explicit `Permission.read(user(callerId))`
            // azonnali read jogot ad — a team-szintű read a többi tagra is.
            withCreator(buildOrgAclPerms(newOrgId), callerId)
        );
        newOrgId = newOrg.$id;
        rollbackSteps.push(() => databases.deleteDocument(env.databaseId, env.organizationsCollectionId, newOrgId));
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
            return fail(res, 409, 'org_slug_taken');
        }
        error(`[Bootstrap] organizations create hiba: ${err.message}`);
        return fail(res, 500, 'org_create_failed');
    }

    // 1.5. Org team — tenant ACL alapja, idempotens
    const orgTeamId = buildOrgTeamId(newOrgId);
    try {
        const result = await ensureTeam(teamsApi, orgTeamId, `Org: ${orgName}`);
        if (result.created) {
            rollbackSteps.push(() => teamsApi.delete(orgTeamId));
        }
    } catch (err) {
        error(`[Bootstrap] org team create hiba: ${err.message}`);
        await runRollback();
        return fail(res, 500, 'org_team_create_failed');
    }

    // 2. organizationMemberships — owner role
    // S.7.1 fix (2026-05-12): doc-szintű ACL `Permission.read(team:org_${orgId})`.
    // Korábban üres permission-paraméter → collection-szintű `read("users")`
    // örökölt → cross-tenant Realtime push szivárgás. A doc most csak az
    // `org_${orgId}` team tagjainak olvasható (server-szintű REST + Realtime
    // filter), write-joga továbbra is kizárólag a CF API key-jé.
    let newMembershipId = null;
    try {
        const membership = await databases.createDocument(
            env.databaseId,
            env.membershipsCollectionId,
            sdk.ID.unique(),
            {
                organizationId: newOrgId,
                userId: callerId,
                role: 'owner',
                addedByUserId: callerId,
                // 2026-05-07 denormalizáció (snapshot-at-join)
                userName: callerIdentity.userName,
                userEmail: callerIdentity.userEmail
            },
            // S.7 stop-time MAJOR fix (2026-05-12): `withCreator` defense-in-depth.
            // A `ensureTeamMembership(orgTeamId)` 247. sorban fut le — a `createDocument`
            // időpontban a creator még NEM team-tag. Az explicit `user(callerId)` Role
            // azonnali read jogot ad a saját membership doc-jára.
            withCreator(buildOrgAclPerms(newOrgId), callerId)
        );
        newMembershipId = membership.$id;
        rollbackSteps.push(() => databases.deleteDocument(env.databaseId, env.membershipsCollectionId, newMembershipId));
    } catch (err) {
        error(`[Bootstrap] organizationMemberships create hiba: ${err.message}`);
        await runRollback();
        return fail(res, 500, 'membership_create_failed');
    }

    // 2.5. Owner a team-be (team törlése cascade-eli a memberships-et → nincs külön rollback step)
    try {
        await ensureTeamMembership(teamsApi, orgTeamId, callerId, ['owner']);
    } catch (err) {
        error(`[Bootstrap] org team membership hiba: ${err.message}`);
        await runRollback();
        return fail(res, 500, 'org_team_membership_create_failed');
    }

    // 2.6. Admin-team (Q1 ACL, E blokk) — `org_${orgId}_admins` létrehozása
    //      + owner-add. Ez a team az `organizationInvites` és
    //      `organizationInviteHistory` doc-szintű ACL-jének tartója.
    //      Idempotens: ha valamiért már létezik (race), `ensureTeam` skip-el.
    const orgAdminTeamId = buildOrgAdminTeamId(newOrgId);
    try {
        const adminResult = await ensureTeam(teamsApi, orgAdminTeamId, `Org admins: ${orgName}`);
        if (adminResult.created) {
            rollbackSteps.push(() => teamsApi.delete(orgAdminTeamId));
        }
    } catch (err) {
        error(`[Bootstrap] org admin-team create hiba: ${err.message}`);
        await runRollback();
        return fail(res, 500, 'org_admin_team_create_failed');
    }
    try {
        await ensureTeamMembership(teamsApi, orgAdminTeamId, callerId, ['owner']);
    } catch (err) {
        error(`[Bootstrap] org admin-team membership hiba: ${err.message}`);
        await runRollback();
        return fail(res, 500, 'org_admin_team_membership_create_failed');
    }

    // ─────────────────────────────────────────────────────────────
    // Office nélküli flow (2026-04-20): ha a kliens nem adott meg
    // office mezőket, itt korai return-nel kilépünk — a 3–7. lépés
    // (office + team + 7 default group + workflow seed) kimarad. A
    // user 0 office-szal landol az új orgban, a Dashboard onboarding
    // splash felajánlja a `create_editorial_office` action-t az első
    // szerkesztőség létrehozásához.
    // ─────────────────────────────────────────────────────────────
    if (!hasOffice) {
        // S.7.8 Phase 1 (2026-05-15): phantom-org window finalize — a doc
        // 'provisioning' → 'active'. Codex stop-time MAJOR fix: explicit
        // `provisioningStuck` flag a return-ben, ha a finalize bukott.
        const finalizeResult = await _finalizeOrgIfProvisioning(ctx, newOrgId);
        log(`[Bootstrap] User ${callerId} új szervezetet hozott létre (action=${action}, office=none): org=${newOrgId}, finalized=${finalizeResult.finalized}`);
        return res.json({
            success: true,
            action: action === 'bootstrap_organization' ? 'bootstrapped' : 'created',
            organizationId: newOrgId,
            editorialOfficeId: null,
            groupsSeeded: false,
            workflowSeeded: false,
            // A.3.2 — office-scope permission set-eket nem tudunk
            // seedelni office nélkül; a `create_editorial_office`
            // hívás majd seedeli az új office-ra.
            permissionSetsSeeded: 0,
            // S.7.8 Phase 1: phantom-org finalize státusz. Ha `provisioningStuck`,
            // a frontend retry-zhet vagy admin-flag-et tehet ki a usernek.
            ...(finalizeResult.finalized === false && {
                provisioningStuck: true,
                provisioningStuckReason: finalizeResult.error,
                recoveryHint: 'Admin manuálisan futtathat `update_organization`-t a status: "active"-ra állításhoz.'
            })
        });
    }

    // 3. editorialOffices
    // S.7.1 fix (2026-05-12): doc-szintű ACL `Permission.read(team:org_${orgId})`.
    // **Org-scope** (NEM office-scope) — minden org-tag látja az office-listát
    // (admin UI office-választó dropdown stb.). Office-tagság a per-office
    // membershipekben dől el, NEM az office doc read-jogán.
    let newOfficeId = sdk.ID.unique();
    try {
        const office = await databases.createDocument(
            env.databaseId,
            env.officesCollectionId,
            newOfficeId,
            {
                organizationId: newOrgId,
                name: officeName,
                slug: officeSlug
                // workflowId: a 7. lépésben (workflow seeding) töltjük ki
            },
            // S.7 stop-time MAJOR fix (2026-05-12): `withCreator` defense-in-depth.
            // Az `ensureTeamMembership(orgTeamId)` előbb (org-membership lépés végén) már lefutott (a creator
            // org-team-tag), de a `Permission.read(user)` explicit redundáns
            // védelmet ad arra az esetre, ha az org-team membership add-ja
            // valamilyen race-en bukna.
            withCreator(buildOrgAclPerms(newOrgId), callerId)
        );
        newOfficeId = office.$id;
        rollbackSteps.push(() => databases.deleteDocument(env.databaseId, env.officesCollectionId, newOfficeId));
    } catch (err) {
        error(`[Bootstrap] editorialOffices create hiba: ${err.message}`);
        await runRollback();
        if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
            return fail(res, 409, 'office_slug_taken');
        }
        return fail(res, 500, 'office_create_failed');
    }

    // 3.5. Office team
    const officeTeamId = buildOfficeTeamId(newOfficeId);
    try {
        const result = await ensureTeam(teamsApi, officeTeamId, `Office: ${officeName}`);
        if (result.created) {
            rollbackSteps.push(() => teamsApi.delete(officeTeamId));
        }
    } catch (err) {
        error(`[Bootstrap] office team create hiba: ${err.message}`);
        await runRollback();
        return fail(res, 500, 'office_team_create_failed');
    }

    // 4. editorialOfficeMemberships — admin role
    // S.7.1 fix (2026-05-12): doc-szintű ACL `Permission.read(team:office_${officeId})`.
    // Korábban üres permission-paraméter → collection-szintű `read("users")`
    // örökölt → cross-office szivárgás. Office-scope a logikusabb (a membership
    // CSAK az adott office tagjainak releváns).
    let newOfficeMembershipId;
    try {
        const officeMembershipDoc = await databases.createDocument(
            env.databaseId,
            env.officeMembershipsCollectionId,
            sdk.ID.unique(),
            {
                editorialOfficeId: newOfficeId,
                organizationId: newOrgId,
                userId: callerId,
                role: 'admin',
                // 2026-05-07 denormalizáció (snapshot-at-join) —
                // ugyanaz a `callerIdentity` cache-ből, nincs 2. usersApi.get
                userName: callerIdentity.userName,
                userEmail: callerIdentity.userEmail
            },
            // S.7 stop-time MAJOR fix (2026-05-12): `withCreator` defense-in-depth.
            // A `ensureTeamMembership(officeTeamId)` lentebb, az office-flow végén fut —
            // a `createDocument` időpontban a creator NEM office-team-tag.
            withCreator(buildOfficeAclPerms(newOfficeId), callerId)
        );
        newOfficeMembershipId = officeMembershipDoc.$id;
        rollbackSteps.push(() => databases.deleteDocument(env.databaseId, env.officeMembershipsCollectionId, newOfficeMembershipId));
    } catch (err) {
        error(`[Bootstrap] editorialOfficeMemberships create hiba: ${err.message}`);
        await runRollback();
        return fail(res, 500, 'office_membership_create_failed');
    }

    // 4.5. Admin az office team-be
    try {
        await ensureTeamMembership(teamsApi, officeTeamId, callerId, ['admin']);
    } catch (err) {
        error(`[Bootstrap] office team membership hiba: ${err.message}`);
        await runRollback();
        return fail(res, 500, 'office_team_membership_create_failed');
    }

    // 5. (A.2.8) — DEFAULT_GROUPS seedelés kivéve. Az új office 0
    //    felhasználó-csoporttal indul; a workflow `requiredGroupSlugs[]`
    //    a forrás. Aktiváláskor / hozzárendeléskor az autoseed flow
    //    (A.2.2 / A.2.3) hozza létre a slug-okat.
    //
    //    A bootstrapping caller az új office-nak nem lesz automatikus
    //    `groupMembership`-tagja semelyik csoportban — a szervezet owner-e
    //    így is teljes CRUD-jogot kap a `userHasPermission()` 2. lépésében
    //    (org-role override). A specifikus workflow-runtime tagság (pl.
    //    leaderGroups bypass) explicit `add_group_member` CF hívással
    //    rendelhető.

    // 6. (A.3.2) — Default permission set-ek seed (owner_base, admin_base,
    //    member_base). Best-effort — a hiba NEM rollback-eli a bootstrap-ot,
    //    csak `permissionSetsSeeded` countot ad vissza (Codex stop-time review).
    //    Az org owner/admin a `userHasPermission()` 2. lépésében (org-role override)
    //    enélkül is teljes CRUD-jogot kap.
    const permSetSeed = await seedDefaultPermissionSets(
        databases,
        { databaseId: env.databaseId, permissionSetsCollectionId: env.permissionSetsCollectionId },
        newOrgId,
        newOfficeId,
        callerId,
        buildOfficeAclPerms,
        log,
        error
    );
    if (permSetSeed.errors.length > 0) {
        log(`[Bootstrap] permission set seed warnings: ${JSON.stringify(permSetSeed.errors)}`);
    }

    // 7. workflows — alapértelmezett workflow seed az új szerkesztőséghez
    let newWorkflowId = null;
    try {
        const workflowDocId = `wf-${newOfficeId}`;
        const workflowDoc = await createWorkflowDoc(
            databases,
            env.databaseId,
            env.workflowsCollectionId,
            workflowDocId,
            {
                editorialOfficeId: newOfficeId,
                organizationId: newOrgId,
                name: 'Alapértelmezett workflow',
                version: 1,
                compiled: JSON.stringify(DEFAULT_WORKFLOW),
                updatedByUserId: callerId
            },
            WORKFLOW_VISIBILITY_DEFAULT,
            callerId,
            buildWorkflowAclPerms(WORKFLOW_VISIBILITY_DEFAULT, newOrgId, newOfficeId),
            log
        );
        newWorkflowId = workflowDoc.$id;

        // Office doc frissítése a workflowId-val
        await databases.updateDocument(
            env.databaseId,
            env.officesCollectionId,
            newOfficeId,
            { workflowId: newWorkflowId }
        );
    } catch (err) {
        // A workflow seeding nem kritikus — az office működik nélküle is,
        // a Plugin/Dashboard fallback-et használ. Logolunk, de nem rollback-elünk.
        error(`[Bootstrap] workflow seed hiba: ${err.message}`);
    }

    // S.7.8 Phase 1 (2026-05-15): phantom-org window finalize — a doc
    // 'provisioning' → 'active'. Codex stop-time MAJOR fix: explicit jelzés.
    const finalizeResult = await _finalizeOrgIfProvisioning(ctx, newOrgId);

    log(`[Bootstrap] User ${callerId} új szervezetet hozott létre (action=${action}): org=${newOrgId}, office=${newOfficeId}, workflow=${newWorkflowId || 'FAILED'}, finalized=${finalizeResult.finalized}`);

    return res.json({
        success: true,
        ...(finalizeResult.finalized === false && {
            provisioningStuck: true,
            provisioningStuckReason: finalizeResult.error,
            recoveryHint: 'Admin manuálisan futtathat `update_organization`-t a status: "active"-ra állításhoz.'
        }),
        action: action === 'bootstrap_organization' ? 'bootstrapped' : 'created',
        organizationId: newOrgId,
        editorialOfficeId: newOfficeId,
        // A.2.8 — workflow-driven autoseed; bootstrap ezért nem hoz
        // létre felhasználó-csoportot (lásd 5. lépés komment).
        groupsSeeded: false,
        workflowSeeded: !!newWorkflowId,
        // A.3.2 — default permission set seed eredménye. A
        // `permSetSeed.errors` lista jelzi a schema-hiányt vagy
        // egyéb best-effort failover-eket.
        permissionSetsSeeded: permSetSeed.created.length,
        permissionSetsSkipped: permSetSeed.skipped.length,
        permissionSetSeedErrors: permSetSeed.errors
    });
}

/**
 * ACTION='update_organization' (#40)
 *
 * Org átnevezés. **A.3.6 BREAKING**: az `org.rename` slug az
 * `ADMIN_EXCLUDED_ORG_SLUGS`-ban van, csak `owner` végezheti
 * (admin elveszti — ADR 0008 szerint).
 */
async function updateOrganization(ctx) {
    const { databases, env, callerUser, payload, log, error, res, fail, permissionEnv, permissionContext } = ctx;
    const { organizationId, name } = payload;

    if (!organizationId || !name) {
        return fail(res, 400, 'missing_fields', {
            required: ['organizationId', 'name']
        });
    }

    const sanitizedName = sanitizeString(name, NAME_MAX_LENGTH);
    if (!sanitizedName) {
        return fail(res, 400, 'invalid_name');
    }

    // A.3.6 — `org.rename` org-scope permission guard.
    //
    // **BREAKING CHANGE az ADR 0008 szerint**: a régi viselkedés
    // owner+admin-t engedett, az új `org.rename` slug a helper
    // `ADMIN_EXCLUDED_ORG_SLUGS` halmazában szerepel — **csak owner**
    // végezheti. Az ADR 38-as taxonómia erre a slug-ra explicit
    // owner-only kompetenciát ír elő. A vault szabálya alapján
    // ("nincs éles verzió, nincs visszafelé-kompatibilitás követelmény")
    // ezt a változást szándékosan benne hagyjuk a retrofitben.
    const allowed = await permissions.userHasOrgPermission(
        databases,
        permissionEnv,
        callerUser,
        'org.rename',
        organizationId,
        permissionContext.orgRoleByOrg,
        permissionContext.orgStatusByOrg // D.2.4 orphan-guard cache
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'org.rename',
            scope: 'org'
        });
    }

    // Org dokumentum frissítése
    try {
        await databases.updateDocument(
            env.databaseId,
            env.organizationsCollectionId,
            organizationId,
            { name: sanitizedName }
        );
    } catch (updateErr) {
        error(`[UpdateOrg] updateDocument hiba: ${updateErr.message}`);
        return fail(res, 500, 'update_failed');
    }

    log(`[UpdateOrg] User ${callerUser.id} átnevezte org ${organizationId} → "${sanitizedName}"`);

    return res.json({
        success: true,
        action: 'updated',
        organizationId,
        name: sanitizedName
    });
}

/**
 * ACTION='delete_organization' (Fázis 8)
 *
 * Szervezet kaszkád törlés: minden alárendelt office-ot végigvesz
 * (→ cascadeDeleteOffice), majd az org-szintű collection-öket
 * (organizationInvites, organizationMemberships), végül az org-ot.
 *
 * Caller: kizárólag a szervezet `owner` role-lal rendelkező tagja
 * (admin NEM törölhet org-ot — ez szándékos, magas blast radius).
 *
 * Fail-closed: ha bármely office kaszkád hibát dob, azonnal leállunk,
 * és NEM nyúlunk az org-szintű cleanup-hoz vagy az org doc-hoz.
 * A részleges törlés után a user retry-olhat (idempotens), vagy a
 * maradék árva office-t az Appwrite Console-ból takaríthatja.
 */
async function deleteOrganization(ctx) {
    const { databases, env, callerId, callerUser, payload, log, error, res, fail, sdk, teamsApi, permissionEnv, permissionContext } = ctx;

    // Delete action-szintű env var guard — lásd delete_editorial_office.
    if (!env.publicationsCollectionId) {
        error('[DeleteOrg] PUBLICATIONS_COLLECTION_ID nincs beállítva.');
        return fail(res, 500, 'misconfigured', { missing: ['PUBLICATIONS_COLLECTION_ID'] });
    }

    const { organizationId } = payload;
    if (!organizationId || typeof organizationId !== 'string') {
        return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
    }

    // 1) Org létezés check
    let orgDoc;
    try {
        orgDoc = await databases.getDocument(
            env.databaseId,
            env.organizationsCollectionId,
            organizationId
        );
    } catch (fetchErr) {
        if (fetchErr.code === 404) return fail(res, 404, 'organization_not_found');
        error(`[DeleteOrg] getDocument hiba: ${fetchErr.message}`);
        return fail(res, 500, 'organization_fetch_failed');
    }

    // 2) A.3.6 — `org.delete` org-scope permission guard.
    //    Az `ADMIN_EXCLUDED_ORG_SLUGS`-ban szerepel (helper) — **csak
    //    owner** végezheti. Ezzel a régi `callerRole !== 'owner'`
    //    explicit ellenőrzés átállt a slug-alapú szemantikára.
    const allowed = await permissions.userHasOrgPermission(
        databases,
        permissionEnv,
        callerUser,
        'org.delete',
        organizationId,
        permissionContext.orgRoleByOrg,
        permissionContext.orgStatusByOrg // D.2.4 orphan-guard cache
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'org.delete',
            scope: 'org'
        });
    }

    const envIds = {
        databaseId: env.databaseId,
        publicationsCollectionId: env.publicationsCollectionId,
        workflowsCollectionId: env.workflowsCollectionId,
        groupsCollectionId: env.groupsCollectionId,
        groupMembershipsCollectionId: env.groupMembershipsCollectionId,
        officeMembershipsCollectionId: env.officeMembershipsCollectionId
    };

    // 3) Lapozott office-törlés: a következő batch-et mindig frissen
    //    listázzuk, így (a) nem kell tudni előre, hány office van, és
    //    (b) az imént törölt office-ok már nem szerepelnek a listában,
    //    tehát a ciklus természetesen kiürül. Fail-closed: az első
    //    office kaszkád hiba dobja a futást.
    const officeStats = [];
    while (true) {
        let officesBatch;
        try {
            const response = await databases.listDocuments(
                env.databaseId,
                env.officesCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ]
            );
            officesBatch = response.documents;
        } catch (listErr) {
            error(`[DeleteOrg] office listing: ${listErr.message}`);
            return fail(res, 500, 'office_list_failed', { message: listErr.message });
        }

        if (officesBatch.length === 0) break;

        for (const office of officesBatch) {
            let stats;
            try {
                stats = await cascadeDeleteOffice(databases, office.$id, envIds, log);
            } catch (cascadeErr) {
                error(`[DeleteOrg] office ${office.$id} ("${office.name}") kaszkád hiba [collection=${cascadeErr.collectionId || 'n/a'}]: ${cascadeErr.message}`);
                return fail(res, 500, 'cascade_failed', {
                    message: cascadeErr.message,
                    officeId: office.$id,
                    completedOffices: officeStats
                });
            }

            try {
                await databases.deleteDocument(env.databaseId, env.officesCollectionId, office.$id);
            } catch (deleteErr) {
                error(`[DeleteOrg] office doc ${office.$id} törlés: ${deleteErr.message}`);
                return fail(res, 500, 'office_delete_failed', {
                    officeId: office.$id,
                    message: deleteErr.message,
                    completedOffices: officeStats
                });
            }

            // Office team cleanup — best-effort, lásd delete_editorial_office.
            try {
                await deleteTeamIfExists(teamsApi, buildOfficeTeamId(office.$id));
            } catch (teamErr) {
                error(`[DeleteOrg] office team törlés best-effort hiba (${office.$id}): ${teamErr.message}`);
            }

            officeStats.push({ officeId: office.$id, name: office.name, stats });
        }

        if (officesBatch.length < CASCADE_BATCH_LIMIT) break;
    }

    // 4) Invites takarítás (a memberships-et NEM itt — lásd lentebb).
    //    Az invites doksik törlése nem befolyásolja a caller retry
    //    képességét (a caller jog `organizationMemberships`-ből jön),
    //    ezért biztonsággal előre vehetők.
    let invitesCleanup;
    try {
        invitesCleanup = await deleteByQuery(databases, env.databaseId, env.invitesCollectionId, 'organizationId', organizationId);
    } catch (cleanupErr) {
        error(`[DeleteOrg] invites cleanup: ${cleanupErr.message}`);
        return fail(res, 500, 'org_cleanup_failed', { message: cleanupErr.message });
    }

    // 5) Org dokumentum törlése — a memberships ELŐTT.
    //    Ha a memberships-et előbb törölnénk és ez a lépés elhasalna,
    //    a caller elvesztené a `owner` membership-ét és a retry
    //    `not_a_member` hibával elakadna → árva szervezet. Az org doc
    //    törlés után a caller membership-e redundáns (az org már nem
    //    létezik), így a cleanup sikertelensége csak kozmetikus
    //    inkonzisztenciát hagy.
    try {
        await databases.deleteDocument(env.databaseId, env.organizationsCollectionId, organizationId);
    } catch (deleteErr) {
        error(`[DeleteOrg] org doc törlés: ${deleteErr.message}`);
        return fail(res, 500, 'organization_delete_failed');
    }

    // 5b) Org team cleanup — best-effort. Az org doc már törölve, a team
    //     törlés cascade-eli az org memberships-et is.
    try {
        await deleteTeamIfExists(teamsApi, buildOrgTeamId(organizationId));
    } catch (teamErr) {
        error(`[DeleteOrg] org team törlés best-effort hiba: ${teamErr.message}`);
    }

    // 5c) Admin-team cascade (Q1 ACL, E blokk) — best-effort. Az org doc már
    //     törölve, így a `organizationInvites` és `organizationInviteHistory`
    //     doc-ok ACL-je dangling lesz, de ez a Phase 1 cleanup után self-heal:
    //     a doksik vagy törölve vannak (invitesCleanup), vagy az org-orphan
    //     transition az `auto_expire_on_*` ágon archiválja őket.
    try {
        await deleteTeamIfExists(teamsApi, buildOrgAdminTeamId(organizationId));
    } catch (teamErr) {
        error(`[DeleteOrg] org admin-team törlés best-effort hiba: ${teamErr.message}`);
    }

    // 6) Memberships takarítás — az org doc már nincs, a caller
    //    membership-e már nem ad semmilyen retry-lehetőséget.
    //    Ha ez elbukik, a maradék memberships árvák maradnak
    //    (nem létező orgId-ra mutatnak), manuális cleanup kell.
    let membershipsCleanup;
    try {
        membershipsCleanup = await deleteByQuery(databases, env.databaseId, env.membershipsCollectionId, 'organizationId', organizationId);
    } catch (cleanupErr) {
        error(`[DeleteOrg] memberships cleanup az org doc törlése után elbukott: ${cleanupErr.message}`);
        // Ponton a szervezet már törölve van — a user-nek nem dobunk
        // hibát, csak hard log-ba tesszük a failure-t, hogy az ops
        // oldalon észrevehető legyen.
        membershipsCleanup = { found: null, deleted: null, error: cleanupErr.message };
    }
    const orgCleanup = { invites: invitesCleanup, memberships: membershipsCleanup };

    log(`[DeleteOrg] User ${callerId} törölte org ${organizationId} ("${orgDoc.name}") — ${officeStats.length} office kaszkád + org cleanup`);

    return res.json({
        success: true,
        action: 'deleted',
        organizationId,
        deletedOffices: officeStats.length,
        officeStats,
        orgCleanup
    });
}

/**
 * ACTION='change_organization_member_role' (2026-05-07).
 *
 * Egy meglévő `organizationMemberships` rekord `role` mezőjének változtatása
 * (`owner` ↔ `admin` ↔ `member`). A `org.member.role.change` org-scope slug
 * adja a jogot — `userHasOrgPermission()` szerint owner és admin egyaránt
 * megkapja, viszont az action **extra owner-only guardot** ír elő minden
 * owner-érintettségű cserére (admin nem promote-olhat owner-ré, és nem
 * demote-olhat egy meglévő owner-t — különben privilege-escalation lenne).
 *
 * Védelmi rétegek (sorban):
 *   1. Payload validation — `organizationId`, `targetUserId`, `role`
 *   2. Self-edit guard — `callerId === targetUserId` → 403
 *      (egy másik owner-rel kell elvégeztetni; egyébként az utolsó owner
 *      saját magát admin-ra léptethetné, és örökre elveszne az org-role)
 *   3. Permission check — `org.member.role.change` (owner / admin)
 *   4. Owner-touch guard — ha az ÚJ role 'owner' VAGY a RÉGI role 'owner',
 *      akkor a caller-nek `owner`-nek kell lennie (admin nem nyúl owner-hez)
 *   5. Membership lookup (`organizationMemberships` `userId + organizationId`)
 *   6. Idempotens: ha a membership.role már egyenlő `role`-lal → success no-op
 *   7. Last-owner guard — ha owner→non-owner és csak 1 owner van az org-ban,
 *      `409 cannot_demote_last_owner` (különben az org „owner-mentes" lenne)
 *   8. `databases.updateDocument` — csak a `role` mező
 *
 * @param {Object} ctx
 * @returns {Promise<Object>} CF response
 */
async function changeOrganizationMemberRole(ctx) {
    const { databases, env, callerId, callerUser, payload, log, error, res, fail, sdk, permissionEnv, permissionContext, teamsApi } = ctx;
    const { organizationId, targetUserId, role } = payload;

    // 1. Payload validation
    if (!organizationId || !targetUserId || !role) {
        return fail(res, 400, 'missing_fields', {
            required: ['organizationId', 'targetUserId', 'role']
        });
    }
    if (typeof organizationId !== 'string'
        || typeof targetUserId !== 'string'
        || typeof role !== 'string') {
        return fail(res, 400, 'invalid_payload_types');
    }
    const VALID_ROLES = ['owner', 'admin', 'member'];
    if (!VALID_ROLES.includes(role)) {
        return fail(res, 400, 'invalid_role', {
            allowed: VALID_ROLES
        });
    }

    // 2. Self-edit guard — a saját org-role-od nem módosíthatod.
    //    Indok: defense-in-depth a last-owner guard mellett. Egy owner
    //    a `last-owner check`-et megkerülhetné (mert ha közben egy
    //    másik owner-t admin-ra rakott, az az adatkár), de a self-edit
    //    blokkolása egyszerűbb és határozottabb szabály.
    if (callerId === targetUserId) {
        return fail(res, 403, 'cannot_change_own_role', {
            note: 'A saját role-od nem módosíthatod. Egy másik owner-rel kell elvégeztetned.'
        });
    }

    // 3. Permission check — `org.member.role.change` org-scope slug.
    const allowed = await permissions.userHasOrgPermission(
        databases,
        permissionEnv,
        callerUser,
        'org.member.role.change',
        organizationId,
        permissionContext.orgRoleByOrg,
        permissionContext.orgStatusByOrg // D.2.4 orphan-guard cache
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'org.member.role.change',
            scope: 'org'
        });
    }

    // 5. Membership lookup — előbb-utánra húzva a 4. (owner-touch) elé,
    //    mert a 4. szabály a `membership.role` ismeretére épül.
    let membership;
    try {
        const list = await databases.listDocuments(
            env.databaseId,
            env.membershipsCollectionId,
            [
                sdk.Query.equal('organizationId', organizationId),
                sdk.Query.equal('userId', targetUserId),
                sdk.Query.limit(1)
            ]
        );
        if (list.documents.length === 0) {
            return fail(res, 404, 'membership_not_found', {
                note: 'A target user nem tagja ennek a szervezetnek.'
            });
        }
        membership = list.documents[0];
    } catch (err) {
        error(`[ChangeOrgMemberRole] membership lookup hiba: ${err.message}`);
        return fail(res, 500, 'membership_lookup_failed');
    }

    const currentRole = membership.role;

    // 4. Owner-touch guard — owner érintettségű cserénél csak owner-caller
    //    léphet. A `userHasOrgPermission` admin-nak is true-t adna, de az
    //    ADR 0008 szerinti privilege-elv azt mondja: admin nem promote-olhat
    //    saját szintje fölé, és nem nyúlhat magasabb szintű felhasználó
    //    role-jához. A caller role-ját a `getOrgRole` per-request cache-ből
    //    olvassuk (idempotens, gyors).
    const isOwnerTouch = role === 'owner' || currentRole === 'owner';
    if (isOwnerTouch) {
        const callerRole = await permissions.getOrgRole(
            databases,
            permissionEnv,
            callerId,
            organizationId,
            permissionContext.orgRoleByOrg
        );
        if (callerRole !== 'owner') {
            return fail(res, 403, 'requires_owner_for_owner_role_change', {
                note: 'Owner promote / demote csak owner caller-rel végezhető. Admin nem nyúlhat owner-szintű role-okhoz.'
            });
        }
    }

    // 6. Idempotens no-op
    if (currentRole === role) {
        return res.json({
            success: true,
            action: 'noop',
            organizationId,
            targetUserId,
            role,
            note: 'A target user már ezzel a role-lal rendelkezik.'
        });
    }

    // 7. Last-owner guard — csak akkor releváns, ha most owner→non-owner
    //    irányú változás. Az org-ban legalább egy owner-nek lennie kell,
    //    különben org.delete / org.rename / member-role-change soha többé
    //    nem futna le owner-hiány miatt (deadlock).
    if (currentRole === 'owner' && role !== 'owner') {
        try {
            const owners = await databases.listDocuments(
                env.databaseId,
                env.membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('role', 'owner'),
                    sdk.Query.limit(2) // 2 elég a "≥2 owner van?" döntéshez
                ]
            );
            if (owners.documents.length <= 1) {
                return fail(res, 409, 'cannot_demote_last_owner', {
                    note: 'A szervezetben legalább egy owner-nek lennie kell. Előbb promote-olj egy másik tagot owner-ré, majd demote-old ezt.'
                });
            }
        } catch (err) {
            error(`[ChangeOrgMemberRole] owner count lookup hiba: ${err.message}`);
            return fail(res, 500, 'owner_count_lookup_failed');
        }
    }

    // 8. Update — csak a `role` mezőt írjuk, a többit változatlanul hagyjuk.
    try {
        await databases.updateDocument(
            env.databaseId,
            env.membershipsCollectionId,
            membership.$id,
            { role }
        );
    } catch (err) {
        error(`[ChangeOrgMemberRole] update hiba: ${err.message}`);
        return fail(res, 500, 'role_update_failed');
    }

    // 8.5. Q1 ACL (E blokk, 2026-05-09 follow-up) — admin-team sync.
    //
    // Codex pre-review: DB-first → strict admin-team add/remove. A DB már
    // konzisztens, a team-mutáció CONSEQUENCE.
    //
    // Promote (member → admin/owner): admin-team-be add (ensureTeam idempotens).
    // Demote (admin/owner → member): admin-team-ből removal.
    // Owner ↔ admin csere: admin-team-ben mindkét role admin team-tag, csak a
    //   role-string változik (idempotens ensure / no-op).
    //
    // Harden Fázis 1+2 (Codex baseline #2 + adversarial DESIGN-QUESTION):
    //   - `ensureTeam` siker NEM elég: a `delete_organization` race közben az
    //     admin-team épp törlődhet → re-create torzott team-et hagyna egy
    //     törölt org mellett. Ezért az `ensureTeam` ELŐTT egy gyors org-doc
    //     re-read invariáns: ha a doc már törölt (404), skippeljük a sync-et.
    //   - `ensureTeamMembership` return-jelzést ellenőrizzük: `team_not_found`
    //     vagy bármely hiba esetén stats-ba sorrendezünk és NEM némán
    //     ignoráljuk. A DB role már updatedt, ezért NEM fail-closed-ozunk
    //     (a user-feeling konzisztens), DE explicit `adminTeamSyncSkipped: true`
    //     flag a response-ban → a frontend tájékoztathat a backfill-igényről.
    let adminTeamSyncSkipped = false;
    let orgStillExists = true;
    // Simplify Efficiency #1: a `userHasOrgPermission()` (3. lépés) már
    // letöltötte az org status-t és cache-elte a `permissionContext.orgStatusByOrg`
    // Map-be (lásd permissions.js getOrgStatus). Ha cache-hit, NEM kell egy
    // redundáns getDocument re-read — minden role-change-en -1 DB roundtrip.
    const cachedStatus = permissionContext?.orgStatusByOrg?.has(organizationId)
        ? permissionContext.orgStatusByOrg.get(organizationId)
        : undefined;
    if (cachedStatus !== undefined) {
        // Cache-hit: az org status egyszer le lett kérve. A `null` legacy active,
        // a `'lookup_failed'` env/DB hiba (a guard úgyis fail-closed-ott volna).
        // Egyik sem 404 — az org létezik. Skip a re-read-et.
    } else {
        // Cache-miss (ritka — pl. globális admin call): csak akkor tényleges
        // re-read fut, és akkor is fail-graceful (404 = törölt org).
        try {
            await databases.getDocument(
                env.databaseId, env.organizationsCollectionId, organizationId,
                [sdk.Query.select(['$id'])]
            );
        } catch (orgReadErr) {
            if (orgReadErr?.code === 404) {
                orgStillExists = false;
                log(`[ChangeOrgMemberRole] org=${organizationId} már törölt — admin-team sync skipping (delete race)`);
            }
            // Egyéb hiba esetén best-effort sync (nem tudjuk biztosan, törölt-e).
        }
    }

    if (orgStillExists) {
        const orgAdminTeamId = buildOrgAdminTeamId(organizationId);
        try {
            await ensureTeam(teamsApi, orgAdminTeamId, `Org admins: ${organizationId}`);
        } catch (teamErr) {
            // Legacy org-on a team-create ritka edge — log, és a sync skip.
            error(`[ChangeOrgMemberRole] admin-team create hiba (sync skip): ${teamErr.message}`);
            adminTeamSyncSkipped = true;
        }
        const isPrivileged = (r) => r === 'owner' || r === 'admin';
        if (!adminTeamSyncSkipped) {
            try {
                if (isPrivileged(role)) {
                    const r = await ensureTeamMembership(teamsApi, orgAdminTeamId, targetUserId, [role]);
                    if (r.skipped === 'team_not_found') {
                        error(`[ChangeOrgMemberRole] admin-team membership team_not_found az ensureTeam után — race`);
                        adminTeamSyncSkipped = true;
                    }
                } else if (isPrivileged(currentRole)) {
                    const r = await removeTeamMembership(teamsApi, orgAdminTeamId, targetUserId);
                    if (r.skipped === 'team_not_found') {
                        // Demote-on a missing-team egy log-only állapot — a user
                        // úgyse lát ACL-t, ami nincs.
                        log(`[ChangeOrgMemberRole] admin-team remove team_not_found — log-only`);
                    }
                }
            } catch (teamErr) {
                error(`[ChangeOrgMemberRole] admin-team sync hiba (DB már updated): ${teamErr.message}`);
                adminTeamSyncSkipped = true;
            }
        }
    } else {
        adminTeamSyncSkipped = true;
    }

    // D.2.4 (Codex adversarial review fix 2026-05-09 MAJOR): self-heal a
    // race window stale `orphaned` status-ára. Ha a promote-ol owner-rel
    // egy olyan org-ot, ami `userHasOrgPermission` orphan-guard cache miss-e
    // miatt átengedte a write-ot, miközben a `user-cascade-delete` közben
    // `orphaned`-re írta — az org most legitim owner-rel rendelkezik, ezért
    // a status visszaállhat `active`-ra. Best-effort: ha bármelyik write
    // dob, csak loggolunk (a role update már sikeres). Csak `role==='owner'`
    // promote-on aktiválódik.
    let orgStatusReset = false;
    if (role === 'owner' && env.organizationsCollectionId) {
        try {
            const orgDoc = await databases.getDocument(
                env.databaseId,
                env.organizationsCollectionId,
                organizationId,
                [sdk.Query.select(['$id', 'status'])]
            );
            if (orgDoc.status === permissions.ORG_STATUS.ORPHANED) {
                await _setOrgStatusActive(databases, env, organizationId);
                orgStatusReset = true;
                log(`[ChangeOrgMemberRole] org=${organizationId} status reset orphaned → active (legitim owner promote-tal)`);
            }
        } catch (statusErr) {
            error(`[ChangeOrgMemberRole] org-status self-heal hiba (non-blocking): ${statusErr.message}`);
        }
    }

    log(`[ChangeOrgMemberRole] User ${callerId} → org=${organizationId} target=${targetUserId} role: ${currentRole} → ${role}`);

    return res.json({
        success: true,
        action: 'updated',
        organizationId,
        targetUserId,
        previousRole: currentRole,
        role,
        ...(orgStatusReset ? { orgStatusReset: true } : {}),
        // Harden Fázis 1+2: ha az admin-team sync bukott (race / legacy /
        // missing team), a frontend tájékoztatja a usert, hogy a
        // `backfill_admin_team_acl` action futása szükséges. A DB role
        // update sikerült — a user-feeling konzisztens.
        ...(adminTeamSyncSkipped ? { adminTeamSyncSkipped: true } : {})
    });
}

/**
 * ACTION='remove_organization_member' (2026-05-10, [[Döntések/0012-org-member-removal-cascade]]).
 *
 * Tag eltávolítása a szervezetből (admin-kick) a `UsersTab` felületről. A
 * `changeOrganizationMemberRole` 8 védelmi rétegét + a `leaveOrganization`
 * STRICT team-cleanup mintáját ötvözi. Self-removal-ra a `leave_organization`
 * action a megfelelő (külön self-service flow, ld. ADR 0013).
 *
 * Védelmi rétegek (sorrendben):
 *   1. Payload validation — `organizationId`, `targetUserId`
 *   2. Self-block — `callerId === targetUserId` → 403 `cannot_remove_self`
 *   3. Permission check — `org.member.remove` (owner + admin default-ban)
 *   4. Membership lookup — `organizationMemberships` (org + targetUserId)
 *   5. Owner-touch guard — admin nem érintheti owner-t (Codex Q3, MAJOR)
 *   6. Last-owner guard — utolsó owner-t nem lehet kicsapni
 *   7. STRICT team cleanup (Codex Q5+Q6, MAJOR) — per-office + org + admin-team
 *      a DB delete ELŐTT, a Realtime ghost-ACL elkerülésére
 *   8. Cascade DB delete — officeMemberships → groupMemberships → org membership
 *      paginált, infinite-loop guard (mint a `leaveOrganization`-ben)
 */
async function removeOrganizationMember(ctx) {
    const { databases, env, callerId, callerUser, payload, log, error, res, fail, sdk, permissionEnv, permissionContext, teamsApi } = ctx;
    const { organizationId, targetUserId } = payload || {};

    // 1. Payload validation
    if (!organizationId || !targetUserId) {
        return fail(res, 400, 'missing_fields', {
            required: ['organizationId', 'targetUserId']
        });
    }
    if (typeof organizationId !== 'string' || typeof targetUserId !== 'string') {
        return fail(res, 400, 'invalid_payload_types');
    }

    // 2. Self-block — self-removal a self-service `leave_organization`-en át.
    //    Indok: a self-flow last-owner / last-member hint-szet ad ('transfer_ownership_first'
    //    vs 'delete_organization_instead'), amit az admin-kick nem tudna megfelelően
    //    visszaadni a hívónak (a hívó nem a target).
    if (callerId === targetUserId) {
        return fail(res, 403, 'cannot_remove_self', {
            hint: 'use_leave_organization',
            note: 'Saját kilépéshez a `leave_organization` action-t használd.'
        });
    }

    // 3. Permission check — `org.member.remove` slug. Admin is megkapja
    //    default-ban (NINCS az `ADMIN_EXCLUDED_ORG_SLUGS`-ban).
    const allowed = await permissions.userHasOrgPermission(
        databases,
        permissionEnv,
        callerUser,
        'org.member.remove',
        organizationId,
        permissionContext.orgRoleByOrg,
        permissionContext.orgStatusByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'org.member.remove',
            scope: 'org'
        });
    }

    // 4. Target membership lookup
    let targetMembership;
    try {
        const list = await databases.listDocuments(
            env.databaseId,
            env.membershipsCollectionId,
            [
                sdk.Query.equal('organizationId', organizationId),
                sdk.Query.equal('userId', targetUserId),
                sdk.Query.limit(1)
            ]
        );
        if (list.documents.length === 0) {
            return fail(res, 404, 'membership_not_found', {
                note: 'A target user nem tagja ennek a szervezetnek.'
            });
        }
        targetMembership = list.documents[0];
    } catch (err) {
        error(`[RemoveOrgMember] target membership lookup hiba: ${err.message}`);
        return fail(res, 500, 'membership_lookup_failed');
    }
    const targetRole = targetMembership.role;

    // 5. Owner-touch guard — admin nem nyúlhat owner-hez (privilege-eszkaláció).
    //    A `userHasOrgPermission` admin-nak is true-t adna; az ADR 0008 elv:
    //    admin nem érinthet magasabb szintű felhasználót. A caller role-t a
    //    `getOrgRole` per-request cache-ből olvassuk.
    if (targetRole === 'owner') {
        const callerRole = await permissions.getOrgRole(
            databases,
            permissionEnv,
            callerId,
            organizationId,
            permissionContext.orgRoleByOrg
        );
        if (callerRole !== 'owner') {
            return fail(res, 403, 'requires_owner_for_owner_removal', {
                note: 'Owner-szintű tag eltávolítása csak owner caller-rel végezhető. Admin nem nyúlhat owner-szintű felhasználóhoz.'
            });
        }
    }

    // 6. Last-owner guard — owner-target esetén ellenőrizzük, hogy van-e
    //    másik owner. Ha nincs → az org owner-mentes lenne, deadlock.
    if (targetRole === 'owner') {
        try {
            const owners = await databases.listDocuments(
                env.databaseId,
                env.membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('role', 'owner'),
                    sdk.Query.limit(2) // 2 elég az "≥2 owner van?" döntéshez
                ]
            );
            if (owners.documents.length <= 1) {
                return fail(res, 409, 'cannot_remove_last_owner', {
                    hint: 'transfer_ownership_first',
                    note: 'A szervezetben legalább egy owner-nek lennie kell. Előbb promote-olj egy másik tagot owner-ré.'
                });
            }
        } catch (err) {
            error(`[RemoveOrgMember] owner count lookup hiba: ${err.message}`);
            return fail(res, 500, 'owner_count_lookup_failed');
        }
    }

    // 7. Office-IDs listing — a per-office team cleanup-hoz kell. Helper-extracted.
    let officeIds;
    try {
        officeIds = await listOfficeIdsForOrg(databases, env, sdk, organizationId, CASCADE_BATCH_LIMIT);
    } catch (e) {
        error(`[RemoveOrgMember] office listing hiba: ${e.message}`);
        return fail(res, 500, 'office_list_failed');
    }

    // 7.5. CAS owner re-check (Codex baseline P1 / adversarial high #2, 2026-05-10).
    //      Az 5+6 lépés a target.role-ra alapozott guardja a 4. lépés után FRESH
    //      lookup-tól származik, de a delete (8.) sok DB-call + team-call után
    //      érkezik. Ha közben másik owner kilép vagy demote-olódik, a stale
    //      pre-check átmegy → utolsó owner is törölhető. CAS-stílusú revalidáció:
    //      "van-e másik owner mint a target?" — `notEqual + limit(1)` minta
    //      konzisztens a `deleteMyAccount` 4b CAS-ével.
    if (targetRole === 'owner') {
        try {
            const otherOwnersFresh = await databases.listDocuments(
                env.databaseId,
                env.membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('role', 'owner'),
                    sdk.Query.notEqual('userId', targetUserId),
                    sdk.Query.limit(1)
                ]
            );
            if (otherOwnersFresh.documents.length === 0) {
                return fail(res, 409, 'cas_last_owner_conflict', {
                    hint: 'concurrent_owner_change',
                    note: 'A delete ELŐTTI fresh-read szerint már nincs másik owner. Más művelet közben demotálta a többit. Ismételd meg a kérést.'
                });
            }
        } catch (err) {
            error(`[RemoveOrgMember] CAS owner re-check hiba: ${err.message}`);
            return fail(res, 500, 'cas_recheck_failed');
        }
    }

    // 7.6. Org membership doc törlése ELSŐKÉNT (Codex adversarial medium, 2026-05-10).
    //      A `userHasOrgPermission()` az `organizationMemberships.role`-on alapszik
    //      (NEM a team-membership-en), ezért az auth-vágás a server-side write-okhoz
    //      AKKOR történik meg, amikor ezt a rekordot töröljük. Ha team-cleanup
    //      vagy a membership-cascade ELŐTT csinálnánk, és valamelyik bukna, a
    //      target user CF-write-okat küldhetne a half-failed admin-kick után
    //      (org.member.invite, org.rename, stb.) — security-issue. A team cleanup
    //      utána fut: a Realtime push-csatornák ~ms-szintű residue-t adnak, de
    //      ez nem authority, csak read-leak.
    try {
        await databases.deleteDocument(
            env.databaseId,
            env.membershipsCollectionId,
            targetMembership.$id
        );
    } catch (e) {
        error(`[RemoveOrgMember] org membership delete hiba (${targetMembership.$id}): ${e.message}`);
        return fail(res, 500, 'membership_delete_failed');
    }

    // 8. Team cleanup — most már a target nem tud authority-t használni a server-side
    //    írási flow-khoz (a `userHasOrgPermission` 7.6 után hard-deny-ot ad). A
    //    team-membership a Realtime/REST read-ACL-t adja; eltávolítása a push-leak
    //    ablakot zárja. Hiba esetén 500, DE az auth már elveszett — retry biztonságos
    //    (`removeTeamMembership` idempotens 404/409 skip), és a target user nem
    //    tud közben "használni" hogyhogy nem létezik a membership rekordban.
    const teamCleanup = { officeTeams: 0, orgTeam: false, orgAdminTeam: false };
    try {
        for (const oid of officeIds) {
            const r = await removeTeamMembership(teamsApi, buildOfficeTeamId(oid), targetUserId);
            if (r.removed > 0) teamCleanup.officeTeams += r.removed;
        }
        const r = await removeTeamMembership(teamsApi, buildOrgTeamId(organizationId), targetUserId);
        if (r.removed > 0) teamCleanup.orgTeam = true;
        const ra = await removeTeamMembership(teamsApi, buildOrgAdminTeamId(organizationId), targetUserId);
        if (ra.removed > 0) teamCleanup.orgAdminTeam = true;
    } catch (teamErr) {
        error(`[RemoveOrgMember] team membership remove hiba (DB org-membership már törölve, retry safe): ${teamErr.message}`);
        return fail(res, 500, 'team_cleanup_failed', { message: teamErr.message, note: 'A target már elvesztette org-authority-t. Retry biztonságos, idempotens.' });
    }

    // 9. Cascade DB delete — `editorialOfficeMemberships` (target + org-szűrt).
    //    Lapozott + infinite-loop guard.
    let officeMembershipsRemoved = 0;
    const officeFailures = [];
    try {
        while (true) {
            const resp = await databases.listDocuments(
                env.databaseId,
                env.officeMembershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('userId', targetUserId),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ]
            );
            if (resp.documents.length === 0) break;
            for (const m of resp.documents) {
                try {
                    await databases.deleteDocument(env.databaseId, env.officeMembershipsCollectionId, m.$id);
                    officeMembershipsRemoved++;
                } catch (delErr) {
                    officeFailures.push({ docId: m.$id, message: delErr.message });
                }
            }
            if (officeFailures.length > 0) break;
            if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
        }
    } catch (e) {
        error(`[RemoveOrgMember] office memberships listing hiba: ${e.message}`);
        return fail(res, 500, 'office_memberships_failed');
    }
    if (officeFailures.length > 0) {
        error(`[RemoveOrgMember] office membership delete failures: ${JSON.stringify(officeFailures)}`);
        return fail(res, 500, 'office_memberships_failed', { failures: officeFailures });
    }

    // 9b. Cascade DB delete — `groupMemberships` (target + org-szűrt).
    let groupMembershipsRemoved = 0;
    const groupFailures = [];
    try {
        while (true) {
            const resp = await databases.listDocuments(
                env.databaseId,
                env.groupMembershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('userId', targetUserId),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ]
            );
            if (resp.documents.length === 0) break;
            for (const m of resp.documents) {
                try {
                    await databases.deleteDocument(env.databaseId, env.groupMembershipsCollectionId, m.$id);
                    groupMembershipsRemoved++;
                } catch (delErr) {
                    groupFailures.push({ docId: m.$id, message: delErr.message });
                }
            }
            if (groupFailures.length > 0) break;
            if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
        }
    } catch (e) {
        error(`[RemoveOrgMember] group memberships listing hiba: ${e.message}`);
        return fail(res, 500, 'group_memberships_failed');
    }
    if (groupFailures.length > 0) {
        error(`[RemoveOrgMember] group membership delete failures: ${JSON.stringify(groupFailures)}`);
        return fail(res, 500, 'group_memberships_failed', { failures: groupFailures });
    }

    log(`[RemoveOrgMember] caller=${callerId} kicsapta target=${targetUserId} org=${organizationId}-ból (target.role=${targetRole}, office=${officeMembershipsRemoved}, groupMemberships=${groupMembershipsRemoved}, teams.office=${teamCleanup.officeTeams}, teams.org=${teamCleanup.orgTeam}, teams.admin=${teamCleanup.orgAdminTeam})`);

    return res.json({
        success: true,
        action: 'removed',
        organizationId,
        targetUserId,
        previousRole: targetRole,
        removed: {
            organizationMembership: 1,
            editorialOfficeMemberships: officeMembershipsRemoved,
            groupMemberships: groupMembershipsRemoved
        },
        teamCleanup
    });
}

/**
 * ACTION='transfer_orphaned_org_ownership' (D.2.5b, 2026-05-09)
 *
 * Recovery flow egy `status === 'orphaned'` organizációra. Az utolsó owner
 * törölte magát, ezzel az org árva állapotba került ([[user-cascade-delete]] v5+
 * írta a markert). A `userHasOrgPermission()` orphan-guard minden `org.*`
 * write-műveletet 403-mal zár — beleértve a normál owner-promote flow-t
 * (`change_organization_member_role` → `org.member.role.change` slug).
 *
 * Ez az action **megkerüli az orphan-guard-ot** azzal, hogy NEM a
 * `userHasOrgPermission()` slug helpert használja, hanem saját globális
 * admin guard-dal fut. Codex tervi review (2026-05-09 BLOCKER ha b helyett):
 * az org admin NEM kaphatja meg ezt a jogot, különben privilege-eszkalációs
 * felület (org admin → owner csak azért, mert az org broken).
 *
 * Lépések:
 *   1. Caller global admin (`users.labels.includes('admin')`).
 *   2. Org létezik, `status === 'orphaned'` (a 2. hívás `409
 *      organization_not_orphaned`-ot ad, mert az 5. lépés már aktiválta).
 *   3. `newOwnerUserId` tagja-e az orgnak (`organizationMemberships`).
 *   4. `organizationMemberships` updateDocument: `newOwnerUserId` role → `owner`.
 *      Idempotens: ha már owner, no-op.
 *   5. `organizations` updateDocument: `status: 'active'`. Idempotens: ha már
 *      active, az Appwrite úgyis no-op-ot csinál.
 *
 * **Retry-safe** (Codex harden adversarial fix 2026-05-09): mind a 4. és 5.
 * lépés idempotens önmagában, így a 4. és 5. közötti CF-timeout esetén a hívó
 * SAFE retryolhatja az egészet — a 2. lépés gate-eli a már-aktivált orgokat.
 * **EGY edge case** marad: ha a 4. sikeres (role=owner), de az 5. még NEM
 * futott le → az org `orphaned` marad, miközben már van owner. A retry hívás
 * a 4. lépésen átmegy (no-op `already owner`), majd az 5. status-write-tel
 * lezárja a recovery-t. NEM blocking, csak átmeneti inkonzisztencia.
 *
 * Ha a hívónak két különböző usert kell owner-ré promote-olnia, az elsőhöz
 * használja ezt az action-t, a másodikhoz a normál
 * `change_organization_member_role`-t (immár orphan-mentes orgon működik).
 */
async function transferOrphanedOrgOwnership(ctx) {
    const { databases, env, callerUser, payload, res, fail, log, error, sdk } = ctx;
    const { organizationId, newOwnerUserId } = payload || {};

    if (!organizationId || !newOwnerUserId) {
        return fail(res, 400, 'missing_fields', { required: ['organizationId', 'newOwnerUserId'] });
    }

    // 1. Globális admin guard. NEM `userHasOrgPermission()` — az orphan-guard
    // különben fail-closed-at adna minden hívóra. A `hasGlobalAdminLabel`
    // helper a `permissions.js`-ből egységesíti a 3 hívási helyen szétszórt
    // `Array.isArray + includes('admin')` mintát (Codex simplify Q6).
    if (!permissions.hasGlobalAdminLabel(callerUser)) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'global.admin',
            scope: 'global',
            note: 'A `transfer_orphaned_org_ownership` művelethez globális admin label szükséges (`users.labels: ["admin"]`).'
        });
    }

    // 2. Org létezik + orphan állapot.
    let orgDoc;
    try {
        orgDoc = await databases.getDocument(
            env.databaseId,
            env.organizationsCollectionId,
            organizationId
        );
    } catch (err) {
        return fail(res, 404, 'organization_not_found');
    }
    if (orgDoc.status !== 'orphaned') {
        return fail(res, 409, 'organization_not_orphaned', {
            currentStatus: orgDoc.status || null,
            note: 'A művelet kizárólag `status === "orphaned"` orgon érvényes. Aktív orgnál a normál `change_organization_member_role` action használandó.'
        });
    }

    // 3. newOwnerUserId tagja-e az orgnak. Az orphan org-on belül kell egy
    // tagot előléptetni — különben a recovery semmit sem érne.
    let targetMembership;
    try {
        const list = await databases.listDocuments(
            env.databaseId,
            env.membershipsCollectionId,
            [
                sdk.Query.equal('organizationId', organizationId),
                sdk.Query.equal('userId', newOwnerUserId),
                sdk.Query.limit(1)
            ]
        );
        if (list.documents.length === 0) {
            return fail(res, 404, 'target_not_member', {
                note: 'A `newOwnerUserId` jelenleg nem tagja a szervezetnek. Hívd meg, vagy add hozzá az `organizationMemberships`-hez közvetlenül.'
            });
        }
        targetMembership = list.documents[0];
    } catch (err) {
        error(`[TransferOrphanedOwnership] target lookup hiba: ${err.message}`);
        return fail(res, 500, 'target_lookup_failed');
    }

    // 4. Promote target membership-et owner-re. Idempotens (már owner → no-op).
    if (targetMembership.role !== 'owner') {
        try {
            await databases.updateDocument(
                env.databaseId,
                env.membershipsCollectionId,
                targetMembership.$id,
                { role: 'owner' }
            );
        } catch (err) {
            error(`[TransferOrphanedOwnership] role update hiba: ${err.message}`);
            return fail(res, 500, 'role_update_failed');
        }
    }

    // 5. Org status reset → active. A `userHasOrgPermission()` orphan-guard
    // most már átengedi a normál `org.*` flow-t.
    try {
        await _setOrgStatusActive(databases, env, organizationId);
    } catch (err) {
        error(`[TransferOrphanedOwnership] org status update hiba: ${err.message}`);
        return fail(res, 500, 'status_update_failed');
    }

    log(`[TransferOrphanedOwnership] org=${organizationId} new owner=${newOwnerUserId} (caller global-admin=${callerUser.id})`);
    return res.json({
        success: true,
        action: 'orphaned_ownership_transferred',
        organizationId,
        newOwnerUserId,
        previousStatus: 'orphaned',
        currentStatus: 'active'
    });
}

/**
 * ACTION='delete_my_account' (2026-05-10, [[Döntések/0013-self-service-account-management]]).
 *
 * Self-service fiók-törlés a `/settings/account` profile-screen "Veszélyes
 * zóna" gombjáról. Cross-org cascade + Appwrite user-account hard-delete.
 *
 * **Codex BLOCKER fix-ek**:
 *   - B1 (race-window): per-org sequential cleanup a `users.delete` ELŐTT.
 *     A `users.delete` után a `user-cascade-delete` event-driven CF-nek már
 *     semmit nem kell takarítania (zéró-membership user).
 *   - B2 (sole-member): a sole-owner ÉS sole-member ágat is blokkolja, hogy
 *     ne maradjon árva, üres org. A `leaveOrganization` mintát követi.
 *   - B3: a meglévő `user-cascade-delete` CF most már lebontja az
 *     `org_${orgId}_admins` team-eket is (ld. külön patch a CF-ben).
 *
 * **Lépések**:
 *   1. Caller user kötelező (self-service).
 *   2. Caller MINDEN org-membership listázása (paginált).
 *   3. Cross-org pre-check (FAIL-CLOSED): minden owner-role membership-en a
 *      másik-owner / másik-tag check. Ha valamelyikben nincs másik owner →
 *      `lastOwnerOrgs` (van más tag) vagy `soleOwnerOrgs` (egyedüli tag).
 *      Bármelyik nem üres → 409 `last_owner_in_orgs` + hint, NINCS cleanup.
 *   4. Per-org sequential cleanup — minden orgra a `leaveOrganization` mintát
 *      replikálja: STRICT team cleanup → office memberships → group memberships
 *      → org membership doc.
 *   5. `usersApi.delete(callerId)` — egy zéró-membership user-en. A
 *      `user-cascade-delete` event-driven CF lefut, de már semmit nem talál.
 */
async function deleteMyAccount(ctx) {
    const { databases, env, callerId, payload, sdk, log, error, res, fail, teamsApi, usersApi } = ctx;

    if (!callerId) {
        return fail(res, 401, 'unauthenticated');
    }
    // Defense-in-depth confirm token (a frontend a confirmation után küldi).
    // A meglévő strict email-typed dialog UI-szintű védelem; a backend-en
    // requestből explicit `confirm: true` flag-et várunk, hogy egy tévedésből
    // küldött payload (pl. CSRF, minified bug) NE törölje a user-t.
    if (!payload || payload.confirm !== true) {
        return fail(res, 400, 'confirm_required', {
            note: 'A delete_my_account payload-ban explicit `confirm: true` szükséges.'
        });
    }

    // 2. Caller MINDEN org-membership listázása (paginált, mintaként a
    //    `leaveOrganization` office-listing loop-jából).
    const callerMemberships = [];
    {
        let cursor;
        while (true) {
            const queries = [
                sdk.Query.equal('userId', callerId),
                sdk.Query.limit(CASCADE_BATCH_LIMIT)
            ];
            if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
            let resp;
            try {
                resp = await databases.listDocuments(env.databaseId, env.membershipsCollectionId, queries);
            } catch (e) {
                error(`[DeleteMyAccount] org memberships listing hiba: ${e.message}`);
                return fail(res, 500, 'memberships_list_failed');
            }
            if (resp.documents.length === 0) break;
            callerMemberships.push(...resp.documents);
            if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
            cursor = resp.documents[resp.documents.length - 1].$id;
        }
    }

    // 2.5. CF timeout védelem (Codex stop-time review MAJOR M2, 2026-05-10).
    //      Az `invite-to-organization` CF timeout 60s a meghívási flow miatt;
    //      a per-org cleanup soros (per-office team API + 2-3 collection paginált
    //      delete) kb. 1.5-3 mp/org. Egy 10-org cap biztos margin a 60s alatt.
    //      Ennél több → 409 `too_many_orgs` + hint: a user előbb manuálisan lép
    //      ki néhány orgból (`leave_organization` per-org flow), majd retry.
    const MAX_ORGS_PER_DELETE_CALL = 10;
    if (callerMemberships.length > MAX_ORGS_PER_DELETE_CALL) {
        return fail(res, 409, 'too_many_orgs', {
            orgCount: callerMemberships.length,
            max: MAX_ORGS_PER_DELETE_CALL,
            hint: 'leave_some_orgs_first',
            note: `Túl sok szervezetben vagy tag (${callerMemberships.length}). Először lépj ki ${callerMemberships.length - MAX_ORGS_PER_DELETE_CALL} szervezetből, majd próbáld újra a fiók-törlést.`
        });
    }

    // 3. Cross-org pre-check (FAIL-CLOSED). MINDEN owner-orgra ellenőrzünk,
    //    cleanup ELŐTT — különben részleges törlés után árva orgok maradnának.
    const lastOwnerOrgs = [];
    const soleOwnerOrgs = [];
    for (const m of callerMemberships) {
        if (m.role !== 'owner') continue;
        const orgId = m.organizationId;
        let otherOwners;
        try {
            otherOwners = await databases.listDocuments(env.databaseId, env.membershipsCollectionId, [
                sdk.Query.equal('organizationId', orgId),
                sdk.Query.equal('role', 'owner'),
                sdk.Query.notEqual('userId', callerId),
                sdk.Query.limit(1)
            ]);
        } catch (e) {
            error(`[DeleteMyAccount] other-owner scan hiba (${orgId}): ${e.message}`);
            return fail(res, 500, 'owner_scan_failed', { organizationId: orgId });
        }
        if (otherOwners.documents.length > 0) continue; // van másik owner, mehet

        // Egyedüli owner — van más tag?
        let otherMembers;
        try {
            otherMembers = await databases.listDocuments(env.databaseId, env.membershipsCollectionId, [
                sdk.Query.equal('organizationId', orgId),
                sdk.Query.notEqual('userId', callerId),
                sdk.Query.limit(1)
            ]);
        } catch (e) {
            error(`[DeleteMyAccount] other-member scan hiba (${orgId}): ${e.message}`);
            return fail(res, 500, 'owner_scan_failed', { organizationId: orgId });
        }

        if (otherMembers.documents.length > 0) {
            lastOwnerOrgs.push(orgId);
        } else {
            soleOwnerOrgs.push(orgId);
        }
    }

    if (lastOwnerOrgs.length > 0 || soleOwnerOrgs.length > 0) {
        return fail(res, 409, 'last_owner_in_orgs', {
            lastOwnerOrgs,
            soleOwnerOrgs,
            hint: 'transfer_or_delete',
            note: 'A felsorolt szervezetekben utolsó owner vagy. Először adj át tulajdonjogot, vagy töröld a szervezetet.'
        });
    }

    // 3.5. users.write scope preflight (Codex baseline P1 #3, 2026-05-10).
    //      A flow legkritikusabb hibapontja: ha a CF API key-ből hiányzik a
    //      `users.write` scope, a per-org cleanup végigfut, MINDEN membership
    //      törlődik, majd a végén az `usersApi.delete()` 401/403-zal elszáll →
    //      `user_delete_failed` 500 + ZOMBI USER (élő, zéró-membership). Megoldás:
    //      idempotens no-op `usersApi.updateName` (a meglévő nevet visszaírjuk)
    //      — ez ÍGY igényli a `users.write` scope-ot. A 3. lépés UTÁN fut, hogy
    //      a 409 ágon (transfer_or_delete) NE legyen felesleges _users write.
    let callerUserName;
    try {
        const callerInfo = await usersApi.get(callerId);
        callerUserName = callerInfo?.name || '';
    } catch (e) {
        error(`[DeleteMyAccount] caller user lookup hiba (users.read): ${e.message}`);
        return fail(res, 500, 'caller_lookup_failed');
    }
    try {
        await usersApi.updateName(callerId, callerUserName);
    } catch (e) {
        if (e?.code === 401 || e?.code === 403) {
            error(`[DeleteMyAccount] users.write scope hiányzik a CF API key-ből — cleanup ABORT`);
            return fail(res, 503, 'users_write_scope_missing', {
                note: 'A CF nem tudja törölni az Appwrite user account-ot a cleanup végén. Adminisztrátor figyelmébe: Functions → Invite To Organization → Settings → Scopes → users.write hozzáadása szükséges.'
            });
        }
        error(`[DeleteMyAccount] users.write preflight ismeretlen hiba: ${e.message}`);
        return fail(res, 500, 'preflight_failed', { message: e.message });
    }

    // 3.6. S.2.3 (2026-05-11) — `delete_my_account` attempt-throttle rate-limit.
    //      Codex Q7: semantic pre-checks (confirm/too_many_orgs/last_owner/users.write
    //      scope) UTÁN, cleanup ELŐTT — a 400/409/503 ágak NEM bumpolják a counter-t.
    //      5 perc window / max 3 attempt / 5 perc block (Codex stop-time MAJOR 3 fix):
    //      partial cleanup után a self-heal retry megengedhető (NEM 24h hard cooldown).
    {
        const rateLimited = await evaluateAndConsume(ctx, [
            { endpoint: 'delete_my_account', options: { subject: callerId }, tag: 'user' }
        ]);
        if (rateLimited) return fail(res, rateLimited.code, rateLimited.reason, rateLimited.payload);
    }

    // 4. Per-org sequential cleanup (Codex baseline P1 #2 / adversarial high #1, 2026-05-10).
    //    Sorrend: office-IDs → CAS owner re-check → ORG MEMBERSHIP DELETE ELSŐKÉNT
    //    → team cleanup → office/group cascade. Az org-membership ELSŐ delete-je
    //    az auth-vágás kritikus pontja: a `userHasOrgPermission` az
    //    `organizationMemberships`-en alapszik, ezért amíg ez áll, a caller másik
    //    flow-t indíthatna a half-failed cleanup közben. Az ELSŐ delete után
    //    semmilyen authority nincs, a többi cleanup kozmetikus residue-takarítás.
    const cleanupStats = [];
    for (const m of callerMemberships) {
        const orgId = m.organizationId;
        const stat = { organizationId: orgId, officeMemberships: 0, groupMemberships: 0, teams: { officeTeams: 0, orgTeam: false, orgAdminTeam: false }, anonymizeErrors: null };

        // 4a. Office-IDs listing — helper-extracted.
        let officeIds;
        try {
            officeIds = await listOfficeIdsForOrg(databases, env, sdk, orgId, CASCADE_BATCH_LIMIT);
        } catch (e) {
            error(`[DeleteMyAccount] office listing hiba (${orgId}): ${e.message}`);
            return fail(res, 500, 'partial_cleanup', { stage: 'office_list', organizationId: orgId, completedOrgs: cleanupStats });
        }

        // 4b. CAS owner re-check (csak owner-orgokra). A 3. lépés cross-org
        //     pre-check-je TOCTOU-rézbányás: ha közben másik owner kilép vagy
        //     demote-olódik, a callerből utolsó owner lesz, és a 4c delete utolsó
        //     ownert távolít el → ownerless org. Fresh-read közvetlenül a delete
        //     előtt (`limit(1)` elég a "van másik owner?" döntéshez).
        if (m.role === 'owner') {
            try {
                const otherOwnersFresh = await databases.listDocuments(env.databaseId, env.membershipsCollectionId, [
                    sdk.Query.equal('organizationId', orgId),
                    sdk.Query.equal('role', 'owner'),
                    sdk.Query.notEqual('userId', callerId),
                    sdk.Query.limit(1)
                ]);
                if (otherOwnersFresh.documents.length === 0) {
                    return fail(res, 409, 'cas_last_owner_in_org', {
                        organizationId: orgId,
                        hint: 'concurrent_owner_change',
                        completedOrgs: cleanupStats,
                        note: 'A 3. lépés óta másik owner elhagyta vagy demotálódott ennél az orgnál. Ismételd meg a fiók-törlést.'
                    });
                }
            } catch (e) {
                error(`[DeleteMyAccount] CAS owner re-check hiba (${orgId}): ${e.message}`);
                return fail(res, 500, 'partial_cleanup', { stage: 'cas_recheck', organizationId: orgId, completedOrgs: cleanupStats });
            }
        }

        // 4c. Org membership doc törlése ELSŐKÉNT (Codex adversarial medium).
        //     A `userHasOrgPermission` ettől hard-deny-ot ad, az auth-vágás megtörtént.
        //     A team + cascade utánfutás kozmetikus residue-takarítás.
        try {
            await databases.deleteDocument(env.databaseId, env.membershipsCollectionId, m.$id);
        } catch (e) {
            error(`[DeleteMyAccount] org membership delete hiba (${m.$id}): ${e.message}`);
            return fail(res, 500, 'partial_cleanup', { stage: 'org_membership', organizationId: orgId, completedOrgs: cleanupStats });
        }

        // 4d. Team cleanup (most már a caller nem tud authority-t használni).
        try {
            for (const oid of officeIds) {
                const r = await removeTeamMembership(teamsApi, buildOfficeTeamId(oid), callerId);
                if (r.removed > 0) stat.teams.officeTeams += r.removed;
            }
            const r = await removeTeamMembership(teamsApi, buildOrgTeamId(orgId), callerId);
            if (r.removed > 0) stat.teams.orgTeam = true;
            const ra = await removeTeamMembership(teamsApi, buildOrgAdminTeamId(orgId), callerId);
            if (ra.removed > 0) stat.teams.orgAdminTeam = true;
        } catch (teamErr) {
            error(`[DeleteMyAccount] team cleanup hiba (${orgId}, org-membership már törölve): ${teamErr.message}`);
            return fail(res, 500, 'partial_cleanup', { stage: 'team_cleanup', organizationId: orgId, message: teamErr.message, completedOrgs: cleanupStats });
        }

        // 4d.5) S.7.9 (2026-05-15) — GDPR Art. 17 self-anonymize a target-org-on.
        //       Best-effort: partial-failure NEM blokkolja a flow-t (a user már
        //       team-en kívül + org-membership törölve). Self-anonymize, NEM
        //       kér extra auth-ot a core-tól. NEM minősül `partial_cleanup`-nak,
        //       mert a tag-eltávolítás cél már elérve — csak a stale `read("user:X")`
        //       perm marad, ami admin re-anonymize-cal pótolható.
        try {
            // Time-budget 10s per-org (deleteMyAccount = up to 10 org × 10s
            // = 100s budget; reszervált a flow közben az `usersApi.delete` +
            // 4e/4f cascade-delete-hez). Harden Phase 6 verifying P1 fix.
            const r = await anonymizeUserAclCore(ctx, {
                organizationId: orgId,
                targetUserId: callerId,
                dryRun: false,
                callerId,
                maxRunMs: 10_000
            });
            if (r.orgNotFound || r.orgFetchFailed) {
                error(`[DeleteMyAccount] anonymize preflight hiba (${orgId}, NEM blokkol): orgNotFound=${!!r.orgNotFound} orgFetchFailed=${!!r.orgFetchFailed}`);
            } else if (r.stats) {
                stat.anonymizeErrors = r.stats.errorCount;
                if (r.stats.errorCount > 0) {
                    error(`[DeleteMyAccount] anonymize partial-failure (${orgId}): errorCount=${r.stats.errorCount} (NEM blokkol)`);
                }
            }
        } catch (anonErr) {
            error(`[DeleteMyAccount] anonymize hiba (${orgId}, NEM blokkol): ${anonErr.message}`);
        }

        // 4e. Office memberships cascade (callerId + org-szűrt, paginált)
        try {
            while (true) {
                const resp = await databases.listDocuments(env.databaseId, env.officeMembershipsCollectionId, [
                    sdk.Query.equal('organizationId', orgId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ]);
                if (resp.documents.length === 0) break;
                let anyFailed = false;
                for (const om of resp.documents) {
                    try {
                        await databases.deleteDocument(env.databaseId, env.officeMembershipsCollectionId, om.$id);
                        stat.officeMemberships++;
                    } catch (delErr) {
                        anyFailed = true;
                        error(`[DeleteMyAccount] office membership delete hiba (${om.$id}): ${delErr.message}`);
                    }
                }
                if (anyFailed) {
                    return fail(res, 500, 'partial_cleanup', { stage: 'office_memberships', organizationId: orgId, completedOrgs: cleanupStats });
                }
                if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
            }
        } catch (e) {
            error(`[DeleteMyAccount] office memberships listing hiba (${orgId}): ${e.message}`);
            return fail(res, 500, 'partial_cleanup', { stage: 'office_memberships_list', organizationId: orgId, completedOrgs: cleanupStats });
        }

        // 4f. Group memberships cascade (callerId + org-szűrt)
        try {
            while (true) {
                const resp = await databases.listDocuments(env.databaseId, env.groupMembershipsCollectionId, [
                    sdk.Query.equal('organizationId', orgId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ]);
                if (resp.documents.length === 0) break;
                let anyFailed = false;
                for (const gm of resp.documents) {
                    try {
                        await databases.deleteDocument(env.databaseId, env.groupMembershipsCollectionId, gm.$id);
                        stat.groupMemberships++;
                    } catch (delErr) {
                        anyFailed = true;
                        error(`[DeleteMyAccount] group membership delete hiba (${gm.$id}): ${delErr.message}`);
                    }
                }
                if (anyFailed) {
                    return fail(res, 500, 'partial_cleanup', { stage: 'group_memberships', organizationId: orgId, completedOrgs: cleanupStats });
                }
                if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
            }
        } catch (e) {
            error(`[DeleteMyAccount] group memberships listing hiba (${orgId}): ${e.message}`);
            return fail(res, 500, 'partial_cleanup', { stage: 'group_memberships_list', organizationId: orgId, completedOrgs: cleanupStats });
        }

        cleanupStats.push(stat);
        log(`[DeleteMyAccount] caller=${callerId} org=${orgId} cleanup OK (office=${stat.officeMemberships}, group=${stat.groupMemberships})`);
    }

    // 5. users.delete(callerId) — zéró-membership user-en. A
    //    `user-cascade-delete` event-driven CF lefut, de már semmit nem talál.
    try {
        await usersApi.delete(callerId);
    } catch (e) {
        // Ha a delete bukott, az org-cleanup már megtörtént — a user
        // technikailag már nem tudja használni a fiókját (membership-jei
        // törölve). De az Appwrite account még él. Manuális intervenció
        // szükséges; a hívó retry-elhet.
        error(`[DeleteMyAccount] users.delete bukott a cleanup után: ${e.message}`);
        return fail(res, 500, 'user_delete_failed', {
            message: e.message,
            note: 'A szervezet-tagságok törölve, de a user-fiók delete bukott. Retry vagy manuális admin-action szükséges.',
            completedOrgs: cleanupStats
        });
    }

    log(`[DeleteMyAccount] caller=${callerId} fiók törölve, ${cleanupStats.length} org cleanup-pal.`);

    return res.json({
        success: true,
        action: 'account_deleted',
        leftOrgs: cleanupStats.map(s => s.organizationId),
        cleanupStats
    });
}

module.exports = {
    bootstrapOrCreateOrganization,
    updateOrganization,
    deleteOrganization,
    changeOrganizationMemberRole,
    removeOrganizationMember,
    deleteMyAccount,
    transferOrphanedOrgOwnership
};
