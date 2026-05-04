// B.0.3.h (2026-05-04) — Publication action-ok kiszervezve külön modulba.
// Tartalmazza: create_publication_with_workflow (A.2.10 atomic create+assign),
// assign_workflow_to_publication (A.2.3 autoseed), activate_publication
// (A.2.2 + A.2.4 snapshot rögzítés). Ezek a B.0.3 split utolsó action-csoportja.

const {
    WORKFLOW_VISIBILITY_VALUES,
    WORKFLOW_VISIBILITY_DEFAULT
} = require('../helpers/constants.js');
const {
    seedGroupsFromWorkflow,
    findEmptyRequiredGroupSlugs
} = require('../helpers/groupSeed.js');
const { validateDeadlinesInline } = require('../helpers/deadlineValidator.js');
const { buildExtensionSnapshot } = require('../helpers/extensionSnapshot.js');
const { buildOfficeAclPerms } = require('../teamHelpers.js');
const permissions = require('../permissions.js');

/**
 * ACTION='create_publication_with_workflow' (A.2.10 atomic).
 *
 * Atomic publikáció-létrehozás workflow-hozzárendeléssel + autoseed.
 * Codex stop-time review: az utólagos `assign_workflow_to_publication`
 * call kliens-oldali tranziens ablakot teremt (createPub → assign között
 * a publikáció workflowId nélkül látható Realtime-on át, más tab/derived
 * state csendben null/wrong workflow-val futna).
 *
 * Auth: dual permission check — `publication.create` + `publication.workflow.assign`.
 * A workflow scope (3-way visibility) szerver-szinten validált. Rollback ha
 * az autoseed bukik (deleteDocument a frissen létrehozott publikációra).
 */
async function createPublicationWithWorkflow(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
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
    if (!env.publicationsCollectionId) {
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
            env.databaseId,
            env.officesCollectionId,
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
        workflowDoc = await databases.getDocument(env.databaseId, env.workflowsCollectionId, workflowId);
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
            env.databaseId,
            env.publicationsCollectionId,
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
            { databaseId: env.databaseId, groupsCollectionId: env.groupsCollectionId },
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
            await databases.deleteDocument(env.databaseId, env.publicationsCollectionId, pubDoc.$id);
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

/**
 * ACTION='assign_workflow_to_publication' (A.2.3).
 *
 * Workflow hozzárendelése egy publikációhoz + autoseed a workflow
 * `requiredGroupSlugs[]`-ban szereplő összes csoportra. NEM követeli
 * meg a min. 1 tagot — az csak az `activate_publication`-nél kötelező.
 *
 * Auth: `publication.workflow.assign` office-scope (A.3.6) + 3-way
 * workflow visibility scope match. Aktivált pub workflow-cseréje
 * 409 `publication_active_workflow_locked`. Optimistic concurrency
 * (`expectedUpdatedAt`).
 */
async function assignWorkflowToPublication(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
    const { publicationId, workflowId, expectedUpdatedAt } = payload;
    if (!publicationId || !workflowId) {
        return fail(res, 400, 'missing_fields', {
            required: ['publicationId', 'workflowId']
        });
    }
    if (!env.publicationsCollectionId) {
        return fail(res, 500, 'misconfigured', {
            missing: ['PUBLICATIONS_COLLECTION_ID']
        });
    }

    // 1) Pub fetch
    let pubDoc;
    try {
        pubDoc = await databases.getDocument(env.databaseId, env.publicationsCollectionId, publicationId);
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
        workflowDoc = await databases.getDocument(env.databaseId, env.workflowsCollectionId, workflowId);
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
            { databaseId: env.databaseId, groupsCollectionId: env.groupsCollectionId },
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
            env.databaseId,
            env.publicationsCollectionId,
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

/**
 * ACTION='activate_publication' (A.2.2 + A.2.4).
 *
 * Publikáció aktiválása. Lépések:
 *   1. Caller office-membership a pub office-ában (auth gate).
 *   2. Pre-aktiválási validáció: workflowId set + deadline-fedés
 *      (inline `validateDeadlinesInline`).
 *   3. Autoseed a workflow `requiredGroupSlugs[]`-ra (idempotens).
 *   4. Empty check: minden slug-ra legalább 1 `groupMembership`
 *      → 409 `empty_required_groups` + a hiányzó slug-ok listája.
 *   5. Atomic update: `isActivated: true, activatedAt, compiledWorkflowSnapshot,
 *      modifiedByClientId: SERVER_GUARD_ID`. A SERVER_GUARD sentinel
 *      a post-event `validate-publication-update` guard-ot skip-pel.
 *
 * Snapshot (A.2.4): a `compiledWorkflowSnapshot` mezőbe a workflow teljes
 * `compiled` JSON-ját írjuk — a `requiredGroupSlugs[]` mezővel együtt.
 * Idempotens: ha a pub már aktiválva van + snapshot azonos a workflow
 * jelenlegi `compiled`-jével → `already_activated` success.
 *
 * **TOCTOU NOTE**: opcionális `expectedUpdatedAt` paraméter optimistic
 * concurrency-hez (a dashboard frontend a save flow-ban átadja).
 *
 * Action-szintű env var: `DEADLINES_COLLECTION_ID` (process.env-ből
 * lazy lookup, mint az inline kódban).
 */
async function activatePublication(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
    const { publicationId, expectedUpdatedAt } = payload;
    if (!publicationId) {
        return fail(res, 400, 'missing_fields', {
            required: ['publicationId']
        });
    }
    const missingActivateEnvs = [];
    if (!env.publicationsCollectionId) missingActivateEnvs.push('PUBLICATIONS_COLLECTION_ID');
    const deadlinesCollectionId = process.env.DEADLINES_COLLECTION_ID;
    if (!deadlinesCollectionId) missingActivateEnvs.push('DEADLINES_COLLECTION_ID');
    if (missingActivateEnvs.length > 0) {
        return fail(res, 500, 'misconfigured', { missing: missingActivateEnvs });
    }

    // 1) Pub fetch
    let pubDoc;
    try {
        pubDoc = await databases.getDocument(env.databaseId, env.publicationsCollectionId, publicationId);
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
            databases.getDocument(env.databaseId, env.workflowsCollectionId, pubDoc.workflowId),
            databases.listDocuments(
                env.databaseId,
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

    // 6) Compiled parse — autoseed + empty-check + extension-snapshot
    //    scan ezt használja. A B.3 előtt parse az idempotens-check után
    //    futott, de mostantól a parse-result kell az extension-scan-hez
    //    az idempotens-egyezés kiértékelése előtt is (`compiledExtensionSnapshot`
    //    egyezést is figyelembe kell venni — a workflow extension-jei
    //    változhatnak a parent workflow `compiled` változatlanul maradása
    //    mellett, így ugyanaz a `compiledStr` ≠ ugyanaz az extension-snapshot).
    let compiled;
    try {
        compiled = JSON.parse(compiledStr);
    } catch (parseErr) {
        error(`[ActivatePub] workflow compiled parse hiba: ${parseErr.message}`);
        return fail(res, 500, 'workflow_compiled_invalid');
    }

    // 7) Extension-snapshot összerakás (B.3.3) — fail-fast 422 hiányzó
    //    extension / kind-mismatch / aggregate méret-cap esetén.
    const extResult = await buildExtensionSnapshot(
        databases,
        {
            databaseId: env.databaseId,
            workflowExtensionsCollectionId: env.workflowExtensionsCollectionId
        },
        sdk,
        compiled,
        pubDoc.editorialOfficeId
    );
    if (!extResult.ok) {
        return fail(res, extResult.status, extResult.reason, extResult.payload);
    }
    const extensionSnapshotStr = extResult.snapshot;

    // 8) Idempotens early-return — már aktiválva ugyanezzel a
    //    workflow-snapshottal ÉS extension-snapshottal. A két mező AND-elődik:
    //    egy extension `code` változás (ugyanaz a workflow `compiled`)
    //    újra-aktiváló kérést érdemel az új extension-pillanatkép rögzítéséhez.
    const alreadyActivatedSame =
        pubDoc.isActivated === true
        && pubDoc.compiledWorkflowSnapshot === compiledStr
        && pubDoc.compiledExtensionSnapshot === extensionSnapshotStr;
    if (alreadyActivatedSame) {
        return res.json({
            success: true,
            action: 'already_activated',
            publicationId,
            workflowId: pubDoc.workflowId,
            activatedAt: pubDoc.activatedAt,
            publication: pubDoc
        });
    }

    // 9) Autoseed (idempotens — `assign_workflow_to_publication` már
    //    valószínűleg lefuttatta; a workflow azóta változhatott).
    let autoseed;
    try {
        autoseed = await seedGroupsFromWorkflow(
            databases,
            { databaseId: env.databaseId, groupsCollectionId: env.groupsCollectionId },
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

    // 10) Empty check
    const requiredSlugs = Array.isArray(compiled.requiredGroupSlugs)
        ? compiled.requiredGroupSlugs.map(e => e?.slug).filter(s => typeof s === 'string')
        : [];
    const emptySlugs = await findEmptyRequiredGroupSlugs(
        databases,
        {
            databaseId: env.databaseId,
            groupsCollectionId: env.groupsCollectionId,
            groupMembershipsCollectionId: env.groupMembershipsCollectionId
        },
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

    // 11) Atomic update — isActivated + workflow snapshot + extension snapshot.
    //     SERVER_GUARD sentinel a post-event `validate-publication-update`-nek
    //     (skip a state-snapshot guard-ra is, B.3.3).
    const SERVER_GUARD_ID = 'server-guard';
    const nowIso = new Date().toISOString();
    let updatedPubDoc;
    try {
        updatedPubDoc = await databases.updateDocument(
            env.databaseId,
            env.publicationsCollectionId,
            publicationId,
            {
                isActivated: true,
                activatedAt: nowIso,
                compiledWorkflowSnapshot: compiledStr,
                compiledExtensionSnapshot: extensionSnapshotStr,
                modifiedByClientId: SERVER_GUARD_ID
            }
        );
    } catch (updErr) {
        error(`[ActivatePub] pub update hiba (pub=${publicationId}): ${updErr.message}`);
        return fail(res, 500, 'activation_update_failed');
    }

    log(`[ActivatePub] User ${callerId} aktiválta: pub=${publicationId}, workflow=${pubDoc.workflowId}, snapshot.size=${compiledStr.length}, extSnapshot.size=${extensionSnapshotStr.length}, extRefs=[validators=${extResult.refs.validatorSlugs.length},commands=${extResult.refs.commandSlugs.length}], autoseed.created=${autoseed.created.length}`);

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

module.exports = {
    createPublicationWithWorkflow,
    assignWorkflowToPublication,
    activatePublication
};
