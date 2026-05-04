// B.0.3.f (2026-05-04) — Workflow CRUD action-ok kiszervezve külön modulba.
// Tartalmazza: create_workflow, update_workflow, update_workflow_metadata,
// archive/restore_workflow (közös handler ctx.action-on át), delete_workflow,
// duplicate_workflow. A `create_publication_with_workflow`,
// `assign_workflow_to_publication`, `activate_publication` action-ok az
// `actions/publications.js` (B.0.3.h) hatáskörbe tartoznak.

const {
    NAME_MAX_LENGTH,
    DEFAULT_WORKFLOW,
    sanitizeString
} = require('../helpers/util.js');
const {
    CASCADE_BATCH_LIMIT,
    MAX_REFERENCES_PER_SCAN,
    WORKFLOW_VISIBILITY_VALUES,
    WORKFLOW_VISIBILITY_DEFAULT
} = require('../helpers/constants.js');
const {
    validateCompiledSlugs,
    buildCompiledValidationFailure
} = require('../helpers/compiledValidator.js');
const { createWorkflowDoc } = require('../helpers/workflowDoc.js');
const { buildWorkflowAclPerms } = require('../teamHelpers.js');
const permissions = require('../permissions.js');

/**
 * ACTION='create_workflow' (#30 + A.3.6) — új workflow létrehozása.
 *
 * Auth: `workflow.create` office-scope. Non-default visibility-hez
 * `workflow.share` is szükséges (Codex final review ship-blocker fix).
 * Hard contract validáció a default klónra (defense-in-depth).
 */
async function createWorkflow(ctx) {
    const { databases, env, callerId, callerUser, payload, log, error, res, fail, sdk, permissionEnv, permissionContext } = ctx;
    const { editorialOfficeId } = payload;
    const sanitizedName = sanitizeString(payload.name, NAME_MAX_LENGTH);

    // Visibility whitelist check — ha a kliens kap érvénytelen értéket,
    // fail-fast (ne tároljunk szemetet a DB-ben).
    const visibility = payload.visibility !== undefined
        ? payload.visibility
        : WORKFLOW_VISIBILITY_DEFAULT;
    if (!WORKFLOW_VISIBILITY_VALUES.includes(visibility)) {
        return fail(res, 400, 'invalid_visibility', {
            allowed: WORKFLOW_VISIBILITY_VALUES
        });
    }

    if (!editorialOfficeId || !sanitizedName) {
        return fail(res, 400, 'missing_fields', {
            required: ['editorialOfficeId', 'name']
        });
    }

    // 1. Office lookup → organizationId
    let office;
    try {
        office = await databases.listDocuments(
            env.databaseId,
            env.officesCollectionId,
            [
                sdk.Query.equal('$id', editorialOfficeId),
                sdk.Query.limit(1)
            ]
        );
    } catch (err) {
        return fail(res, 404, 'office_not_found');
    }
    if (office.documents.length === 0) {
        return fail(res, 404, 'office_not_found');
    }
    const orgId = office.documents[0].organizationId;

    // 2. A.3.6 — `workflow.create` office-scope permission guard.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'workflow.create',
        editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'workflow.create',
            scope: 'office'
        });
    }

    // 2.5. A.3.6 — Non-default `visibility` esetén `workflow.share`
    //   slug is szükséges. Anélkül egy `workflow.create` jogosult
    //   user `organization` vagy `public` scope-ú workflow-t
    //   hozhatna létre, ami megkerülné az `update_workflow_metadata`
    //   visibility-gate-jét (Codex final review ship-blocker fix).
    //   A creator ownership ezen a ponton természetesen az alany
    //   maga lesz, így a visibility-tágítás joga `workflow.share`-re
    //   redukálódik (azaz ownership-fallback nincs, mert a
    //   workflow még nem létezik).
    if (visibility !== WORKFLOW_VISIBILITY_DEFAULT) {
        const allowedShare = await permissions.userHasPermission(
            databases,
            permissionEnv,
            callerUser,
            'workflow.share',
            editorialOfficeId,
            permissionContext.snapshotsByOffice,
            permissionContext.orgRoleByOrg
        );
        if (!allowedShare) {
            return fail(res, 403, 'insufficient_permission', {
                slug: 'workflow.share',
                scope: 'office',
                field: 'visibility',
                note: `A "${visibility}" scope-ú workflow létrehozásához workflow.share jog szükséges. Default scope (${WORKFLOW_VISIBILITY_DEFAULT}) workflow.share nélkül létrehozható.`
            });
        }
    }

    // 3. Név unique check az office-on belül
    const nameClash = await databases.listDocuments(
        env.databaseId,
        env.workflowsCollectionId,
        [
            sdk.Query.equal('editorialOfficeId', editorialOfficeId),
            sdk.Query.equal('name', sanitizedName),
            sdk.Query.limit(1)
        ]
    );
    if (nameClash.documents.length > 0) {
        return fail(res, 400, 'name_taken', { name: sanitizedName });
    }

    // 4. Compiled JSON: default workflow klón, de frissen version=1
    const compiledClone = JSON.parse(JSON.stringify(DEFAULT_WORKFLOW));
    compiledClone.version = 1;

    // 4.5. A.2.1 — Hard contract validáció a default klónra.
    // Defense-in-depth: a default workflow JSON garantáltan
    // konzisztens (a build pipeline nem ellenőrzi), de ha valaki
    // hibás default-ot commit-ol, itt fail-fast a `create_workflow`.
    const createValidation = validateCompiledSlugs(compiledClone);
    if (!createValidation.valid) {
        error(`[CreateWorkflow] DEFAULT_WORKFLOW invariáns sértés: ${JSON.stringify(createValidation.errors)}`);
        return fail(res, 500, 'invalid_default_workflow', buildCompiledValidationFailure(createValidation));
    }

    // 5. Workflow doc létrehozás — az ID automatikus (nem `wf-${officeId}`,
    // mert egy office-on belül több workflow is létezhet).
    // A `createWorkflowDoc` helper schema-safe fallback-et ad a rollout
    // ablakra (ha a `bootstrap_workflow_schema` még nem futott le).
    let newWorkflowDoc;
    try {
        newWorkflowDoc = await createWorkflowDoc(
            databases,
            env.databaseId,
            env.workflowsCollectionId,
            sdk.ID.unique(),
            {
                editorialOfficeId,
                organizationId: orgId,
                name: sanitizedName,
                version: 1,
                compiled: JSON.stringify(compiledClone),
                updatedByUserId: callerId
            },
            visibility,
            callerId,
            buildWorkflowAclPerms(visibility, orgId, editorialOfficeId),
            log
        );
    } catch (createErr) {
        error(`[CreateWorkflow] createDocument hiba: ${createErr.message}`);
        return fail(res, 500, 'create_failed');
    }

    log(`[CreateWorkflow] User ${callerId} új workflow-t hozott létre: id=${newWorkflowDoc.$id}, name="${sanitizedName}", office=${editorialOfficeId}, visibility=${visibility}`);

    return res.json({
        success: true,
        action: 'created',
        workflowId: newWorkflowDoc.$id,
        name: sanitizedName,
        visibility,
        createdBy: callerId
    });
}

/**
 * ACTION='update_workflow' — workflow compiled + graph JSON frissítés.
 *
 * Auth: `workflow.edit` (A.3.6). Optimistic concurrency (`version` mező).
 * Hard contract validáció (`validateCompiledSlugs`). Opcionális rename.
 */
async function updateWorkflow(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
    const { editorialOfficeId, workflowId, compiled, graph, version } = payload;
    const renameTo = payload.name !== undefined
        ? sanitizeString(payload.name, NAME_MAX_LENGTH)
        : null;

    if (!editorialOfficeId || !compiled || version == null) {
        return fail(res, 400, 'missing_fields', {
            required: ['editorialOfficeId', 'compiled', 'version']
        });
    }
    if (payload.name !== undefined && !renameTo) {
        return fail(res, 400, 'invalid_name');
    }

    // 1. Office lookup → organizationId
    let office;
    try {
        office = await databases.listDocuments(
            env.databaseId,
            env.officesCollectionId,
            [
                sdk.Query.equal('$id', editorialOfficeId),
                sdk.Query.limit(1)
            ]
        );
    } catch (err) {
        return fail(res, 404, 'office_not_found');
    }
    if (office.documents.length === 0) {
        return fail(res, 404, 'office_not_found');
    }

    // 2. A.3.6 — `workflow.edit` office-scope permission guard.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'workflow.edit',
        editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'workflow.edit',
            scope: 'office'
        });
    }

    // 3. Workflow doc betöltés — elsődleges: explicit workflowId,
    // fallback: office első workflow-ja (backward compat).
    let workflowDoc;
    if (workflowId) {
        try {
            workflowDoc = await databases.getDocument(
                env.databaseId,
                env.workflowsCollectionId,
                workflowId
            );
        } catch (err) {
            return fail(res, 404, 'workflow_not_found');
        }
        // Cross-tenant scope check — a payload officeId-nak egyeznie
        // kell a doc editorialOfficeId-jával.
        if (workflowDoc.editorialOfficeId !== editorialOfficeId) {
            return fail(res, 403, 'scope_mismatch');
        }
    } else {
        const workflowResult = await databases.listDocuments(
            env.databaseId,
            env.workflowsCollectionId,
            [
                sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                sdk.Query.limit(1)
            ]
        );
        if (workflowResult.documents.length === 0) {
            return fail(res, 404, 'workflow_not_found');
        }
        workflowDoc = workflowResult.documents[0];
    }

    // 4. Optimistic concurrency check
    const currentCompiled = typeof workflowDoc.compiled === 'string'
        ? JSON.parse(workflowDoc.compiled)
        : workflowDoc.compiled;
    const currentVersion = currentCompiled?.version ?? workflowDoc.version ?? 1;

    if (currentVersion !== version) {
        return fail(res, 409, 'version_conflict', {
            currentVersion,
            requestedVersion: version
        });
    }

    // 5. Rename unique check (csak ha változik)
    if (renameTo && renameTo !== workflowDoc.name) {
        const nameClash = await databases.listDocuments(
            env.databaseId,
            env.workflowsCollectionId,
            [
                sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                sdk.Query.equal('name', renameTo),
                sdk.Query.limit(1)
            ]
        );
        const clashDoc = nameClash.documents[0];
        if (clashDoc && clashDoc.$id !== workflowDoc.$id) {
            return fail(res, 400, 'name_taken', { name: renameTo });
        }
    }

    // 6. Compiled JSON frissítése a verzióval
    const newVersion = currentVersion + 1;
    let updatedCompiled;
    try {
        updatedCompiled = typeof compiled === 'string'
            ? JSON.parse(compiled)
            : compiled;
    } catch (parseErr) {
        error(`[UpdateWorkflow] compiled JSON parse hiba (workflow=${workflowDoc.$id}): ${parseErr.message}`);
        return fail(res, 400, 'invalid_compiled_json', { error: parseErr.message });
    }
    updatedCompiled.version = newVersion;

    // 6.5. A.2.1 — Hard contract validáció a write-path védvonalként.
    // A kliens-oldali `validateCompiledSlugs` (Designer save flow)
    // garantálja az invariánst, de DevTools-ból vagy direkt CF
    // hívásból is lehet érvénytelen compiled-et küldeni → 400 fail-fast.
    const slugValidation = validateCompiledSlugs(updatedCompiled);
    if (!slugValidation.valid) {
        log(`[UpdateWorkflow] Hard contract sértés (workflow=${workflowDoc.$id}, by ${callerId}): ${slugValidation.errors.length} hiba.`);
        return fail(res, 400, 'unknown_group_slug', buildCompiledValidationFailure(slugValidation));
    }

    const updateData = {
        compiled: JSON.stringify(updatedCompiled),
        updatedByUserId: callerId
    };
    if (graph !== undefined) {
        updateData.graph = typeof graph === 'string' ? graph : JSON.stringify(graph);
    }
    if (renameTo && renameTo !== workflowDoc.name) {
        updateData.name = renameTo;
    }

    await databases.updateDocument(
        env.databaseId,
        env.workflowsCollectionId,
        workflowDoc.$id,
        updateData
    );

    log(`[UpdateWorkflow] Workflow ${workflowDoc.$id} (office ${editorialOfficeId}) frissítve: v${currentVersion} → v${newVersion}${renameTo && renameTo !== workflowDoc.name ? `, név: "${workflowDoc.name}" → "${renameTo}"` : ''} (by ${callerId})`);

    return res.json({
        success: true,
        version: newVersion,
        workflowId: workflowDoc.$id,
        name: renameTo || workflowDoc.name
    });
}

/**
 * ACTION='update_workflow_metadata' — név + visibility + description (compiled
 * JSON érintés nélkül, verzió-bump nélkül).
 *
 * Auth: `workflow.edit` (a 2-es lépésben). A visibility-mező változtatása
 * KIEGÉSZÍTŐ guardot kap: `createdBy === callerId` ownership (+ `isStillOfficeMember`
 * Codex Critical fix) VAGY `workflow.share` slug.
 *
 * Visibility-szűkítés (#80) → `visibility_shrinkage_warning` + orphanedPublications
 * + `force: true` flow. ACL újraszámolás (`buildWorkflowAclPerms`).
 */
async function updateWorkflowMetadata(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
    const { editorialOfficeId, workflowId } = payload;
    const renameTo = payload.name !== undefined
        ? sanitizeString(payload.name, NAME_MAX_LENGTH)
        : null;
    const visibility = payload.visibility;
    // #80 description field — nullable textarea, `null` szándékos
    // törlés (trim → "" → null), `undefined` = no-op.
    const DESCRIPTION_MAX_LENGTH = 500;
    let descriptionUpdate = undefined;
    if (payload.description !== undefined) {
        if (payload.description === null) {
            descriptionUpdate = null;
        } else if (typeof payload.description !== 'string') {
            return fail(res, 400, 'invalid_description');
        } else {
            const trimmed = payload.description.trim().slice(0, DESCRIPTION_MAX_LENGTH);
            descriptionUpdate = trimmed.length === 0 ? null : trimmed;
        }
    }

    if (!editorialOfficeId || !workflowId) {
        return fail(res, 400, 'missing_fields', {
            required: ['editorialOfficeId', 'workflowId']
        });
    }
    if (payload.name !== undefined && !renameTo) {
        return fail(res, 400, 'invalid_name');
    }
    if (visibility !== undefined && !WORKFLOW_VISIBILITY_VALUES.includes(visibility)) {
        return fail(res, 400, 'invalid_visibility', {
            allowed: WORKFLOW_VISIBILITY_VALUES
        });
    }
    if (!renameTo && visibility === undefined && descriptionUpdate === undefined) {
        return fail(res, 400, 'nothing_to_update');
    }

    // 1. Office lookup → organizationId
    let office;
    try {
        office = await databases.listDocuments(
            env.databaseId,
            env.officesCollectionId,
            [
                sdk.Query.equal('$id', editorialOfficeId),
                sdk.Query.limit(1)
            ]
        );
    } catch (err) {
        return fail(res, 404, 'office_not_found');
    }
    if (office.documents.length === 0) {
        return fail(res, 404, 'office_not_found');
    }
    const orgId = office.documents[0].organizationId;

    // 2. A.3.6 — `workflow.edit` office-scope permission guard.
    //    A visibility-mező változtatása ezen kívül egy második
    //    `workflow.share` slug-guardot kap a 5-pre lépésben (vagy
    //    `createdBy === callerId` ownership ad fallback jogot).
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'workflow.edit',
        editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'workflow.edit',
            scope: 'office'
        });
    }

    // 3. Workflow doc betöltés + scope match
    let workflowDoc;
    try {
        workflowDoc = await databases.getDocument(
            env.databaseId,
            env.workflowsCollectionId,
            workflowId
        );
    } catch (err) {
        return fail(res, 404, 'workflow_not_found');
    }
    if (workflowDoc.editorialOfficeId !== editorialOfficeId) {
        return fail(res, 403, 'scope_mismatch');
    }

    // 4. Rename unique check (csak ha változik)
    if (renameTo && renameTo !== workflowDoc.name) {
        const nameClash = await databases.listDocuments(
            env.databaseId,
            env.workflowsCollectionId,
            [
                sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                sdk.Query.equal('name', renameTo),
                sdk.Query.limit(1)
            ]
        );
        const clashDoc = nameClash.documents[0];
        if (clashDoc && clashDoc.$id !== workflowDoc.$id) {
            return fail(res, 400, 'name_taken', { name: renameTo });
        }
    }

    // 5. Update payload összeállítás (csak a változó mezők)
    const updateData = { updatedByUserId: callerId };
    if (renameTo && renameTo !== workflowDoc.name) {
        updateData.name = renameTo;
    }
    if (visibility !== undefined && visibility !== workflowDoc.visibility) {
        updateData.visibility = visibility;
    }
    if (descriptionUpdate !== undefined && descriptionUpdate !== (workflowDoc.description ?? null)) {
        updateData.description = descriptionUpdate;
    }

    // Ha minden mező no-op (rename to same / visibility to same /
    // description to same), success válasz (idempotens), nem kell
    // DB hit.
    if (Object.keys(updateData).length === 1) {
        return res.json({
            success: true,
            workflowId: workflowDoc.$id,
            name: workflowDoc.name,
            visibility: workflowDoc.visibility,
            description: workflowDoc.description ?? null,
            action: 'noop'
        });
    }

    // 5-pre. A.3.6 — Visibility váltás `workflow.share` slug VAGY
    //   `createdBy === callerId` ownership.
    //
    //   Az ADR 0008 38-slug taxonómiájában a `workflow.share` slug a
    //   visibility (scope) változtatás kanonikus engedélye. Két út
    //   nyitva: (a) a creator (`createdBy === callerId`) ownership
    //   automatikus jogot ad a saját workflow-jára (#81 minta), (b)
    //   a `workflow.share` slugja explicit jog (org owner/admin a
    //   helper override-jával automatikusan kapja).
    //
    //   A rename/description továbbra is `workflow.edit` joggal megy
    //   (a 2-es lépésben már gate-elve) — ez egy KIEGÉSZÍTŐ guard
    //   csak a visibility-mezőre, mert az ADR slug-szegregálja a
    //   metadata-szerkesztés és a scope-megosztás jogát.
    if (updateData.visibility) {
        // Codex adversarial 2026-05-02 Critical fix: a `createdBy ===
        // callerId` ownership csak akkor érvényes, ha a caller még
        // office-tag (kilépett creator nem maradhat scope-tágító).
        // A `permissions.isStillOfficeMember` shared helper a
        // `permissions.js`-ben (fail-closed env/DB hibára).
        const isCreator = workflowDoc.createdBy === callerId;
        let allowedShare = isCreator && await permissions.isStillOfficeMember(
            databases, permissionEnv, callerId, editorialOfficeId
        );
        if (!allowedShare) {
            allowedShare = await permissions.userHasPermission(
                databases,
                permissionEnv,
                callerUser,
                'workflow.share',
                editorialOfficeId,
                permissionContext.snapshotsByOffice,
                permissionContext.orgRoleByOrg
            );
        }
        if (!allowedShare) {
            return fail(res, 403, 'insufficient_permission', {
                slug: 'workflow.share',
                scope: 'office',
                field: 'visibility',
                requiresOwnership: true,
                note: 'A scope (visibility) változtatáshoz workflow.share jog vagy createdBy ownership (+ office-tagság) szükséges.'
            });
        }
    }

    // 5a. #80 — Visibility szűkítés warning scan (a #30 blocking
    // logika helyett). A user döntése alapján a szűkítés nem blokkol:
    // az aktív publikációk `compiledWorkflowSnapshot` alapján
    // tovább futnak, a korábbi másolatok megmaradnak, de az új scope
    // határain kívüli szerkesztőségek már nem indíthatnak új
    // publikációt ezzel a workflow-val. A CF figyelmezteti a klienst
    // a szűkülő scope-on kívüli publikációk listájával, a kliens
    // popup-ot mutat, majd `force: true` flag-gel újraküldi a hívást,
    // ha a user jóváhagyta.
    //
    // Szűkítés irány: public → {organization|editorial_office}, vagy
    // organization → editorial_office.
    if (
        updateData.visibility
        && updateData.visibility !== workflowDoc.visibility
        && !payload.force
    ) {
        const currentVisibility = workflowDoc.visibility;
        const newVisibility = updateData.visibility;
        const isShrinking =
            (currentVisibility === 'public' && newVisibility !== 'public')
            || (currentVisibility === 'organization' && newVisibility === 'editorial_office');

        if (isShrinking) {
            if (!env.publicationsCollectionId) {
                error('[UpdateWorkflowMetadata] PUBLICATIONS_COLLECTION_ID env var hiányzik');
                return fail(res, 500, 'env_missing', {
                    required: 'PUBLICATIONS_COLLECTION_ID'
                });
            }

            const orphanedPublications = [];
            let shrinkageCursor = null;

            shrinkageScanLoop:
            while (true) {
                const queries = [
                    sdk.Query.equal('workflowId', workflowId),
                    sdk.Query.select(['$id', 'name', 'editorialOfficeId', 'organizationId']),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ];
                if (shrinkageCursor) queries.push(sdk.Query.cursorAfter(shrinkageCursor));

                const batch = await databases.listDocuments(
                    env.databaseId,
                    env.publicationsCollectionId,
                    queries
                );
                if (batch.documents.length === 0) break;
                for (const doc of batch.documents) {
                    const isInNewScope =
                        (newVisibility === 'public')
                        || (newVisibility === 'organization' && doc.organizationId === orgId)
                        || (newVisibility === 'editorial_office' && doc.editorialOfficeId === editorialOfficeId);
                    if (isInNewScope) continue;
                    orphanedPublications.push({
                        $id: doc.$id,
                        name: doc.name,
                        organizationId: doc.organizationId,
                        editorialOfficeId: doc.editorialOfficeId
                    });
                    if (orphanedPublications.length >= MAX_REFERENCES_PER_SCAN) {
                        break shrinkageScanLoop;
                    }
                }
                if (batch.documents.length < CASCADE_BATCH_LIMIT) break;
                shrinkageCursor = batch.documents[batch.documents.length - 1].$id;
            }

            if (orphanedPublications.length > 0) {
                return res.json({
                    success: false,
                    reason: 'visibility_shrinkage_warning',
                    from: currentVisibility,
                    to: newVisibility,
                    orphanedPublications,
                    count: orphanedPublications.length,
                    note: 'Az aktív publikációk a compiledWorkflowSnapshot alapján tovább futnak, és a korábbi másolatok is megmaradnak. A szűkített scope-on kívüli szerkesztőségek új publikációt már nem indíthatnak ezzel a workflow-val. Confirm-hoz küldd újra a hívást `force: true` flag-gel.'
                });
            }
        }
    }

    // 5b. #80 — ACL újraszámolás visibility-váltásnál. A
    // `buildWorkflowAclPerms` a scope alapján ad read-permission-t
    // (office/org team vagy users). Ha a visibility nem változik, a
    // perms paramétert nem adjuk át (Appwrite megőrzi a meglévőt).
    const updatePerms = updateData.visibility
        ? buildWorkflowAclPerms(updateData.visibility, orgId, editorialOfficeId)
        : undefined;

    await databases.updateDocument(
        env.databaseId,
        env.workflowsCollectionId,
        workflowDoc.$id,
        updateData,
        updatePerms
    );

    log(`[UpdateWorkflowMetadata] Workflow ${workflowDoc.$id}: ${Object.keys(updateData).filter(k => k !== 'updatedByUserId').join(',')} változott (by ${callerId})`);

    return res.json({
        success: true,
        workflowId: workflowDoc.$id,
        name: updateData.name || workflowDoc.name,
        visibility: updateData.visibility || workflowDoc.visibility,
        description: 'description' in updateData
            ? updateData.description
            : (workflowDoc.description ?? null)
    });
}

/**
 * ACTION='archive_workflow' / 'restore_workflow' (#81).
 *
 * Soft-delete (`archivedAt = now()`) / restore (`null`). Idempotens.
 * 7 nap után a `cleanup-archived-workflows` cron hard-delete (snapshot-tal
 * védett aktív pub-ok NEM blokkolnak, snapshot-nélküliek igen).
 *
 * Auth: `workflow.archive` slug VAGY `createdBy === callerId` (+ `isStillOfficeMember`
 * Codex Critical fix — kilépett creator nem maradhat jogosult).
 */
async function archiveOrRestoreWorkflow(ctx) {
    const { databases, env, callerId, callerUser, action, payload, error, res, fail, log, permissionEnv, permissionContext } = ctx;
    const { editorialOfficeId, workflowId } = payload;
    const isArchive = action === 'archive_workflow';

    if (!editorialOfficeId || !workflowId) {
        return fail(res, 400, 'missing_fields', {
            required: ['editorialOfficeId', 'workflowId']
        });
    }

    // 1. Workflow doc + scope match (a permission guard előtt, hogy
    //    a `createdBy` ownership fallback eldönthető legyen).
    let workflowDoc;
    try {
        workflowDoc = await databases.getDocument(
            env.databaseId,
            env.workflowsCollectionId,
            workflowId
        );
    } catch (err) {
        return fail(res, 404, 'workflow_not_found');
    }
    if (workflowDoc.editorialOfficeId !== editorialOfficeId) {
        return fail(res, 403, 'scope_mismatch');
    }

    // 2. Office lookup ellenőrzés (404 detekt) — ha az office nem
    //    létezik, scope_mismatch helyett pontosabb hiba a UI-nak.
    try {
        await databases.getDocument(
            env.databaseId,
            env.officesCollectionId,
            editorialOfficeId
        );
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'office_not_found');
        error(`[ArchiveWorkflow] office lookup threw: ${err.message} (code=${err.code}, type=${err.type})`);
        return fail(res, 500, 'office_fetch_failed');
    }

    // 3. A.3.6 — `workflow.archive` office-scope permission guard,
    //    `createdBy === callerId` ownership fallback-kel (#81 minta).
    //    A creator a saját workflow-ját akkor is archiválhatja /
    //    visszaállíthatja, ha nincs explicit `workflow.archive` slugja —
    //    DE csak akkor, ha még office-tag (Codex adversarial 2026-05-02:
    //    egy kilépett creator a workflow-jára nem maradhat jogosult,
    //    különben a `createdBy` mező egy soha-le-nem-járó privilege-
    //    eszkalációs felület lenne). A `permissions.isStillOfficeMember`
    //    shared helper a `permissions.js`-ben (fail-closed env/DB hibára).
    const isCreator = workflowDoc.createdBy === callerId;
    let allowed = isCreator && await permissions.isStillOfficeMember(
        databases, permissionEnv, callerId, editorialOfficeId
    );
    if (!allowed) {
        allowed = await permissions.userHasPermission(
            databases,
            permissionEnv,
            callerUser,
            'workflow.archive',
            editorialOfficeId,
            permissionContext.snapshotsByOffice,
            permissionContext.orgRoleByOrg
        );
    }
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'workflow.archive',
            scope: 'office',
            requiresOwnership: true,
            note: 'Csak a workflow tulajdonosa (createdBy + még office-tag) vagy `workflow.archive` jogosultsággal rendelkező felhasználó végezheti ezt a műveletet.'
        });
    }

    // 5. Idempotens státusz check
    const currentlyArchived = !!workflowDoc.archivedAt;
    if (isArchive && currentlyArchived) {
        return res.json({
            success: true,
            action: 'already_archived',
            workflowId: workflowDoc.$id,
            archivedAt: workflowDoc.archivedAt
        });
    }
    if (!isArchive && !currentlyArchived) {
        return res.json({
            success: true,
            action: 'already_active',
            workflowId: workflowDoc.$id
        });
    }

    // 6. Update — archivedAt állítás (null-ra vagy now()-ra).
    const nowIso = new Date().toISOString();
    const updateData = {
        archivedAt: isArchive ? nowIso : null,
        updatedByUserId: callerId
    };

    try {
        await databases.updateDocument(
            env.databaseId,
            env.workflowsCollectionId,
            workflowDoc.$id,
            updateData
        );
    } catch (updateErr) {
        error(`[${isArchive ? 'ArchiveWorkflow' : 'RestoreWorkflow'}] updateDocument hiba (${workflowId}): ${updateErr.message}`);
        return fail(res, 500, isArchive ? 'archive_failed' : 'restore_failed');
    }

    log(`[${isArchive ? 'ArchiveWorkflow' : 'RestoreWorkflow'}] User ${callerId} ${isArchive ? 'archiválta' : 'visszaállította'} a workflow-t: id=${workflowId}, name="${workflowDoc.name}"`);

    return res.json({
        success: true,
        action: isArchive ? 'archived' : 'restored',
        workflowId: workflowDoc.$id,
        archivedAt: isArchive ? nowIso : null
    });
}

/**
 * ACTION='delete_workflow' — hard-delete (a Plugin DataContext Realtime
 * handler reagál a `.delete` eventre, a `workflows[]`-ből eltávolítja).
 *
 * Blocking: nem törölhető, ha bármely publikáció a workflow-ra hivatkozik
 * (`publications.workflowId`). Organization-visibility esetén az egész org-ot
 * scan-eli. Auth: `workflow.archive` slug (közös delete/archive slug).
 */
async function deleteWorkflow(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
    const { editorialOfficeId, workflowId } = payload;

    if (!editorialOfficeId || !workflowId) {
        return fail(res, 400, 'missing_fields', {
            required: ['editorialOfficeId', 'workflowId']
        });
    }
    if (!env.publicationsCollectionId) {
        error('[DeleteWorkflow] PUBLICATIONS_COLLECTION_ID env var hiányzik');
        return fail(res, 500, 'env_missing', {
            required: 'PUBLICATIONS_COLLECTION_ID'
        });
    }

    // 1. Office lookup → organizationId
    let office;
    try {
        office = await databases.listDocuments(
            env.databaseId,
            env.officesCollectionId,
            [
                sdk.Query.equal('$id', editorialOfficeId),
                sdk.Query.limit(1)
            ]
        );
    } catch (err) {
        return fail(res, 404, 'office_not_found');
    }
    if (office.documents.length === 0) {
        return fail(res, 404, 'office_not_found');
    }
    const orgId = office.documents[0].organizationId;

    // 2. A.3.6 — `workflow.archive` office-scope permission guard
    //    (a hard-delete az ADR 38-as taxonómiájában az archive-bal
    //    közös slugot használ; külön `workflow.delete` slug nincs).
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'workflow.archive',
        editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'workflow.archive',
            scope: 'office'
        });
    }

    // 3. Workflow doc betöltés + scope match
    let workflowDoc;
    try {
        workflowDoc = await databases.getDocument(
            env.databaseId,
            env.workflowsCollectionId,
            workflowId
        );
    } catch (err) {
        return fail(res, 404, 'workflow_not_found');
    }
    if (workflowDoc.editorialOfficeId !== editorialOfficeId) {
        return fail(res, 403, 'scope_mismatch');
    }

    // 4. Publikáció-hivatkozás scan — visibility-függő scope:
    //   - `public`: minden szervezet publikációit nézzük (cross-org, csak
    //     `workflowId` egyezés alapján). A `create_publication_with_workflow`
    //     és `assign_workflow_to_publication` engedi `public` workflow
    //     cross-org használatát, ezért a delete-blockernek is lefedettnek
    //     kell lennie minden hivatkozó publikációra. Bug-fix 2026-05-04
    //     (B.0.3.f review által felvetett, de preexisting).
    //   - `organization`: az org összes office-án belül (cross-office).
    //   - `editorial_office`: csak a saját office.
    //   - **invalid / null visibility**: fail-closed = `public`
    //     scope (LEGSZÉLESEBB scan). A delete-blocker célja minden
    //     hivatkozó publikációt megtalálni; ha a visibility legacy /
    //     korrupt / manuális Console-edit miatt ismeretlen, akkor a
    //     legszigorúbb védelem a teljes scan, NEM az office-szűkítés
    //     (Codex review P2, 2026-05-04). A `WORKFLOW_VISIBILITY_DEFAULT`
    //     (`editorial_office`) csak read-time fallback más helyeken,
    //     itt write-blocking szempontból téves lenne.
    //
    // Pagination + match-cap a MAX_REFERENCES_PER_SCAN-nel (bounded payload
    // + memória). A `select`-be bekerült az `organizationId` is, hogy a
    // `public` ágon a hívó UI azonosítani tudja a más szervezet pubját.
    const wfVisibility = WORKFLOW_VISIBILITY_VALUES.includes(workflowDoc.visibility)
        ? workflowDoc.visibility
        : 'public';
    const usedByPublications = [];
    let cursor = null;

    pubScanLoop:
    while (true) {
        const queries = [
            sdk.Query.equal('workflowId', workflowId),
            sdk.Query.select(['$id', 'name', 'editorialOfficeId', 'organizationId']),
            sdk.Query.limit(CASCADE_BATCH_LIMIT)
        ];
        if (wfVisibility === 'organization') {
            queries.push(sdk.Query.equal('organizationId', orgId));
        } else if (wfVisibility === 'editorial_office') {
            queries.push(sdk.Query.equal('editorialOfficeId', editorialOfficeId));
        }
        // `public` (vagy invalid → public fallback): nincs scope-szűrő —
        // a `workflowId` egyezés bármely szervezet publikációját megtalálja.
        if (cursor) queries.push(sdk.Query.cursorAfter(cursor));

        const batch = await databases.listDocuments(
            env.databaseId,
            env.publicationsCollectionId,
            queries
        );
        if (batch.documents.length === 0) break;
        for (const doc of batch.documents) {
            usedByPublications.push({
                $id: doc.$id,
                name: doc.name,
                editorialOfficeId: doc.editorialOfficeId,
                organizationId: doc.organizationId
            });
            if (usedByPublications.length >= MAX_REFERENCES_PER_SCAN) {
                break pubScanLoop;
            }
        }
        if (batch.documents.length < CASCADE_BATCH_LIMIT) break;
        cursor = batch.documents[batch.documents.length - 1].$id;
    }

    if (usedByPublications.length > 0) {
        return fail(res, 400, 'workflow_in_use', {
            usedByPublications,
            count: usedByPublications.length
        });
    }

    // 5. Törlés (a Plugin DataContext Realtime handlere reagál a .delete
    // event-re, a `workflows[]`-ből eltávolítja).
    try {
        await databases.deleteDocument(
            env.databaseId,
            env.workflowsCollectionId,
            workflowId
        );
    } catch (delErr) {
        error(`[DeleteWorkflow] deleteDocument hiba (${workflowId}): ${delErr.message}`);
        return fail(res, 500, 'delete_failed');
    }

    log(`[DeleteWorkflow] User ${callerId} törölte a workflow-t: id=${workflowId}, name="${workflowDoc.name}", office=${editorialOfficeId}`);

    return res.json({
        success: true,
        action: 'deleted',
        workflowId,
        name: workflowDoc.name
    });
}

/**
 * ACTION='duplicate_workflow' (#81 cross-tenant).
 *
 * Cross-tenant workflow duplikálás. A forrás bárhol lehet (saját office,
 * saját org másik office-a, public). A duplikátum MINDIG `editorial_office`
 * scope-on indul, `createdBy = caller`. Auto-suffix `(másolat)`, `(másolat 2)`,
 * stb. (cap 20).
 *
 * Auth: `workflow.duplicate` (target office-on). Read-access a forrásra:
 * scope alapján. Archivált forrás → 400 `source_archived`.
 */
async function duplicateWorkflow(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
    const { editorialOfficeId, workflowId } = payload;
    const explicitName = payload.name !== undefined
        ? sanitizeString(payload.name, NAME_MAX_LENGTH)
        : null;

    if (!editorialOfficeId || !workflowId) {
        return fail(res, 400, 'missing_fields', {
            required: ['editorialOfficeId', 'workflowId']
        });
    }
    if (payload.name !== undefined && !explicitName) {
        return fail(res, 400, 'invalid_name');
    }

    // 1. Target office lookup → target organizationId
    let office;
    try {
        office = await databases.listDocuments(
            env.databaseId,
            env.officesCollectionId,
            [
                sdk.Query.equal('$id', editorialOfficeId),
                sdk.Query.limit(1)
            ]
        );
    } catch (err) {
        return fail(res, 404, 'office_not_found');
    }
    if (office.documents.length === 0) {
        return fail(res, 404, 'office_not_found');
    }
    const targetOrgId = office.documents[0].organizationId;

    // 2. A.3.6 — `workflow.duplicate` office-scope permission guard
    //    a TARGET office-on. Cross-tenant duplikát csak akkor
    //    kerülhet bele, ha a caller jogosult duplikálni ide.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'workflow.duplicate',
        editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'workflow.duplicate',
            scope: 'office'
        });
    }

    // 3. Forrás workflow lookup (bárhol lehet)
    let sourceDoc;
    try {
        sourceDoc = await databases.getDocument(
            env.databaseId,
            env.workflowsCollectionId,
            workflowId
        );
    } catch (err) {
        return fail(res, 404, 'workflow_not_found');
    }

    // Archivált forrás duplikálása blokkolva — ha szükséges, a user
    // először restore-olhatja (nincs semmi akadálya, csak explicit
    // lépés legyen).
    if (sourceDoc.archivedAt) {
        return fail(res, 400, 'source_archived', {
            workflowId: sourceDoc.$id,
            archivedAt: sourceDoc.archivedAt
        });
    }

    // 4. Read-access check a forrásra. A Team ACL a Realtime + kliens
    // olvasást szűri, de itt API key-jel olvasunk — a business-rule
    // check tehát expliciten itt zajlik.
    const sourceVisibility = WORKFLOW_VISIBILITY_VALUES.includes(sourceDoc.visibility)
        ? sourceDoc.visibility
        : WORKFLOW_VISIBILITY_DEFAULT;

    if (sourceVisibility === 'editorial_office') {
        // Csak a source office tagja olvashatja.
        const sourceOfficeMembership = await databases.listDocuments(
            env.databaseId,
            env.officeMembershipsCollectionId,
            [
                sdk.Query.equal('editorialOfficeId', sourceDoc.editorialOfficeId),
                sdk.Query.equal('userId', callerId),
                sdk.Query.limit(1)
            ]
        );
        if (sourceOfficeMembership.documents.length === 0) {
            return fail(res, 403, 'source_not_readable', {
                visibility: sourceVisibility,
                note: 'A forrás workflow editorial_office scope-ú, és a caller nem tagja a forrás-office-nak.'
            });
        }
    } else if (sourceVisibility === 'organization') {
        // Az adott org bármely tagja olvashatja.
        const sourceOrgMembership = await databases.listDocuments(
            env.databaseId,
            env.membershipsCollectionId,
            [
                sdk.Query.equal('organizationId', sourceDoc.organizationId),
                sdk.Query.equal('userId', callerId),
                sdk.Query.limit(1)
            ]
        );
        if (sourceOrgMembership.documents.length === 0) {
            return fail(res, 403, 'source_not_readable', {
                visibility: sourceVisibility,
                note: 'A forrás workflow organization scope-ú, és a caller nem tagja a forrás-szervezetnek.'
            });
        }
    }
    // `public` esetén minden authentikált user olvashatja → nincs check.

    // 5. Név meghatározás: explicit vagy `${forrás név} (másolat)`.
    //    Target office-on belül unique — ha ütközik, `(másolat 2)`,
    //    `(másolat 3)`, stb. (max 20 próbálkozás, fail-fast cap).
    const baseName = explicitName || `${sourceDoc.name} (másolat)`;
    let candidateName = baseName;
    let suffix = 2;
    const MAX_NAME_CANDIDATES = 20;
    while (suffix <= MAX_NAME_CANDIDATES + 1) {
        const clash = await databases.listDocuments(
            env.databaseId,
            env.workflowsCollectionId,
            [
                sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                sdk.Query.equal('name', candidateName),
                sdk.Query.limit(1)
            ]
        );
        if (clash.documents.length === 0) break;
        if (explicitName) {
            // Ha a user explicit nevet adott, ne próbáljunk suffix-et
            // hozzáfűzni — érvényes üzenetet kapjon.
            return fail(res, 400, 'name_taken', { name: candidateName });
        }
        candidateName = `${sourceDoc.name} (másolat ${suffix})`;
        suffix++;
    }
    if (suffix > MAX_NAME_CANDIDATES + 1) {
        return fail(res, 400, 'name_taken', {
            name: baseName,
            note: `Több mint ${MAX_NAME_CANDIDATES} hasonló nevű workflow van a target office-ban — adj meg explicit nevet.`
        });
    }

    // 6. Compiled klón — version reset (new doc, own version line)
    let compiledClone;
    try {
        const source = typeof sourceDoc.compiled === 'string'
            ? JSON.parse(sourceDoc.compiled)
            : sourceDoc.compiled;
        compiledClone = JSON.parse(JSON.stringify(source || {}));
        compiledClone.version = 1;
    } catch (parseErr) {
        error(`[DuplicateWorkflow] forrás compiled JSON parse hiba (${workflowId}): ${parseErr.message}`);
        return fail(res, 500, 'source_compiled_invalid');
    }

    // 6.5. A.2.1 — Hard contract validáció a klónra. A forrás
    // mentés-time validált, de futás közben sérülhetett (manuális
    // Console-edit, legacy import). Defense-in-depth: ne másoljunk
    // tovább érvénytelen compiled-et.
    const dupValidation = validateCompiledSlugs(compiledClone);
    if (!dupValidation.valid) {
        error(`[DuplicateWorkflow] forrás workflow ${workflowId} hard contract sértést tartalmaz: ${dupValidation.errors.length} hiba.`);
        return fail(res, 422, 'source_compiled_invalid_slugs', buildCompiledValidationFailure(dupValidation));
    }

    // 7. Új visibility FORCED `editorial_office` — cross-tenant
    // megosztás alaphelyzet. A user a duplikátumot később átkapcsolhatja
    // organization/public scope-ra az `update_workflow_metadata`-val.
    const newVisibility = WORKFLOW_VISIBILITY_DEFAULT;

    // 8. Új doc — target office + target org scope-jával
    let newDoc;
    try {
        newDoc = await createWorkflowDoc(
            databases,
            env.databaseId,
            env.workflowsCollectionId,
            sdk.ID.unique(),
            {
                editorialOfficeId,
                organizationId: targetOrgId,
                name: candidateName,
                version: 1,
                compiled: JSON.stringify(compiledClone),
                updatedByUserId: callerId
            },
            newVisibility,
            callerId,
            buildWorkflowAclPerms(newVisibility, targetOrgId, editorialOfficeId),
            log
        );
    } catch (createErr) {
        error(`[DuplicateWorkflow] createDocument hiba: ${createErr.message}`);
        return fail(res, 500, 'duplicate_failed');
    }

    log(`[DuplicateWorkflow] User ${callerId} duplikált: forrás=${workflowId} (${sourceVisibility}) → új=${newDoc.$id}, name="${candidateName}", target-office=${editorialOfficeId}, visibility=${newVisibility}`);

    return res.json({
        success: true,
        action: 'duplicated',
        workflowId: newDoc.$id,
        sourceWorkflowId: workflowId,
        name: candidateName,
        visibility: newVisibility,
        createdBy: callerId,
        crossTenant: sourceDoc.editorialOfficeId !== editorialOfficeId
    });
}

module.exports = {
    createWorkflow,
    updateWorkflow,
    updateWorkflowMetadata,
    archiveOrRestoreWorkflow,
    deleteWorkflow,
    duplicateWorkflow
};
