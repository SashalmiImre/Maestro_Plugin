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
    fetchUserIdentity
} = require('../helpers/util.js');
const { CASCADE_BATCH_LIMIT, WORKFLOW_VISIBILITY_DEFAULT } = require('../helpers/constants.js');
const { deleteByQuery, cascadeDeleteOffice } = require('../helpers/cascade.js');
const { createWorkflowDoc } = require('../helpers/workflowDoc.js');
const { seedDefaultPermissionSets } = require('../helpers/groupSeed.js');
const {
    buildOrgTeamId,
    buildOfficeTeamId,
    buildOfficeAclPerms,
    buildWorkflowAclPerms,
    ensureTeam,
    ensureTeamMembership,
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

            log(`[Bootstrap] Idempotens — caller ${callerId} már tagja az org ${existingOrgId}-nak, új rekord nem jött létre`);
            return res.json({
                success: true,
                action: 'existing',
                organizationId: existingOrgId,
                editorialOfficeId: existingOfficeId
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
    let newOrgId = null;
    try {
        const newOrg = await databases.createDocument(
            env.databaseId,
            env.organizationsCollectionId,
            sdk.ID.unique(),
            {
                name: orgName,
                slug: orgSlug,
                ownerUserId: callerId
            }
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
            }
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

    // ─────────────────────────────────────────────────────────────
    // Office nélküli flow (2026-04-20): ha a kliens nem adott meg
    // office mezőket, itt korai return-nel kilépünk — a 3–7. lépés
    // (office + team + 7 default group + workflow seed) kimarad. A
    // user 0 office-szal landol az új orgban, a Dashboard onboarding
    // splash felajánlja a `create_editorial_office` action-t az első
    // szerkesztőség létrehozásához.
    // ─────────────────────────────────────────────────────────────
    if (!hasOffice) {
        log(`[Bootstrap] User ${callerId} új szervezetet hozott létre (action=${action}, office=none): org=${newOrgId}`);
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
            permissionSetsSeeded: 0
        });
    }

    // 3. editorialOffices
    let newOfficeId = null;
    try {
        const office = await databases.createDocument(
            env.databaseId,
            env.officesCollectionId,
            sdk.ID.unique(),
            {
                organizationId: newOrgId,
                name: officeName,
                slug: officeSlug
                // workflowId: a 7. lépésben (workflow seeding) töltjük ki
            }
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
            }
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

    log(`[Bootstrap] User ${callerId} új szervezetet hozott létre (action=${action}): org=${newOrgId}, office=${newOfficeId}, workflow=${newWorkflowId || 'FAILED'}`);

    return res.json({
        success: true,
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
    const { databases, env, callerId, callerUser, payload, log, error, res, fail, sdk, permissionEnv, permissionContext } = ctx;
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
        ...(orgStatusReset ? { orgStatusReset: true } : {})
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

module.exports = {
    bootstrapOrCreateOrganization,
    updateOrganization,
    deleteOrganization,
    changeOrganizationMemberRole,
    transferOrphanedOrgOwnership
};
