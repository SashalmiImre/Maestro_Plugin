// B.0.3.e (2026-05-04) — Permission set CRUD + assign action-ok kiszervezve.
// Tartalmazza: create_permission_set, update_permission_set, archive/restore
// (közös handler ctx.action-on át), assign_permission_set_to_group,
// unassign_permission_set_from_group.
//
// Tilos import-irány: `actions/*` → `helpers/*` → `permissions.js` /
// `teamHelpers.js`. Visszafelé NEM (CommonJS ciklikus require).

const {
    NAME_MAX_LENGTH,
    SLUG_MAX_LENGTH,
    SLUG_REGEX,
    sanitizeString
} = require('../helpers/util.js');
const { buildOfficeAclPerms } = require('../teamHelpers.js');
const permissions = require('../permissions.js');

/**
 * ACTION='create_permission_set' (A.3.3, ADR 0008).
 *
 * Új permission set létrehozása egy szerkesztőségen belül.
 *
 * Validáció: `permissions[]` defense-in-depth `validatePermissionSetSlugs`-szal.
 * `org.*` slug → 400 `org_scope_slug_not_allowed`. Slug regex + slug-ütközés
 * `office_slug_unique` indexen.
 *
 * Auth: `permissionSet.create` office-scope (A.3.6).
 */
async function createPermissionSet(ctx) {
    const { databases, env, callerId, callerUser, payload, log, error, res, fail, sdk, permissionEnv, permissionContext } = ctx;
    const { editorialOfficeId } = payload;
    const sanitizedName = sanitizeString(payload.name, NAME_MAX_LENGTH);
    const sanitizedSlug = sanitizeString(payload.slug, SLUG_MAX_LENGTH);

    if (!editorialOfficeId || !sanitizedName || !sanitizedSlug) {
        return fail(res, 400, 'missing_fields', {
            required: ['editorialOfficeId', 'name', 'slug', 'permissions']
        });
    }

    // Codex review P1: a `permissions` mező KÖTELEZŐEN jelen legyen.
    // Nem default-oljuk üres tömbre (ami egy üres permission set-et
    // hagyna a DB-ben — input-contract sértés az ADR 0008 A.3.3 szerint).
    if (payload.permissions === undefined || payload.permissions === null) {
        return fail(res, 400, 'missing_fields', { required: ['permissions'] });
    }
    if (!Array.isArray(payload.permissions)) {
        return fail(res, 400, 'invalid_field_type', {
            field: 'permissions',
            hint: 'A permissions mezőnek tömbnek kell lennie.'
        });
    }

    if (!SLUG_REGEX.test(sanitizedSlug)) {
        return fail(res, 400, 'invalid_slug', {
            hint: 'slug must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/'
        });
    }

    // Action-szintű env var guard (lazy: csak itt kötelező).
    if (!env.permissionSetsCollectionId) {
        return fail(res, 500, 'misconfigured', {
            missing: ['PERMISSION_SETS_COLLECTION_ID']
        });
    }

    // Permission slug validáció — Codex review: defense-in-depth.
    const slugCheck = permissions.validatePermissionSetSlugs(payload.permissions);
    if (!slugCheck.valid) {
        // Az első `org_scope_slug_not_allowed` hiba a hívó számára kritikus
        // (security boundary), ezért ezt explicit reason-ként visszaadjuk.
        const orgScopeError = slugCheck.errors.find(e => e.code === 'org_scope_slug_not_allowed');
        if (orgScopeError) {
            return fail(res, 400, 'org_scope_slug_not_allowed', {
                slugs: slugCheck.errors.filter(e => e.code === 'org_scope_slug_not_allowed').map(e => e.slug),
                details: slugCheck.errors
            });
        }
        return fail(res, 400, 'invalid_permissions', { errors: slugCheck.errors });
    }

    // Description validáció (opcionális, nullable, max 500).
    const DESCRIPTION_MAX = 500;
    let descriptionValue = null;
    if (payload.description !== undefined && payload.description !== null) {
        if (typeof payload.description !== 'string') {
            return fail(res, 400, 'invalid_description');
        }
        const trimmed = payload.description.trim().slice(0, DESCRIPTION_MAX);
        descriptionValue = trimmed.length === 0 ? null : trimmed;
    }

    // Office lookup → organizationId.
    let officeDoc;
    try {
        officeDoc = await databases.getDocument(env.databaseId, env.officesCollectionId, editorialOfficeId);
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'office_not_found');
        error(`[CreatePermSet] office fetch hiba: ${err.message}`);
        return fail(res, 500, 'office_fetch_failed');
    }

    // A.3.6 — `permissionSet.create` office-scope permission guard.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'permissionSet.create',
        editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'permissionSet.create',
            scope: 'office'
        });
    }

    // Create — slug-ütközés a `office_slug_unique` indexen.
    let newDoc;
    try {
        newDoc = await databases.createDocument(
            env.databaseId,
            env.permissionSetsCollectionId,
            sdk.ID.unique(),
            {
                name: sanitizedName,
                slug: sanitizedSlug,
                description: descriptionValue,
                permissions: [...new Set(payload.permissions)], // de-dup defense
                editorialOfficeId,
                organizationId: officeDoc.organizationId,
                createdByUserId: callerId
            },
            buildOfficeAclPerms(editorialOfficeId)
        );
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
            return fail(res, 409, 'permission_set_slug_taken');
        }
        error(`[CreatePermSet] create hiba: ${err.message}`);
        return fail(res, 500, 'permission_set_create_failed');
    }

    log(`[CreatePermSet] User ${callerId} létrehozta a "${sanitizedName}" (${sanitizedSlug}) permission setet az office ${editorialOfficeId}-ban (${newDoc.permissions.length} slug)`);

    return res.json({
        success: true,
        action: 'created',
        permissionSet: newDoc
    });
}

/**
 * ACTION='update_permission_set' (A.3.3).
 *
 * Permission set szerkesztése. A `slug` immutable (mint a `groups`-nál).
 * Frissíthető: name (max 100 char), description (nullable), permissions[]
 * (validálva mint create-nél).
 *
 * Codex review P2: opcionális `expectedUpdatedAt` TOCTOU guard.
 */
async function updatePermissionSet(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, log, permissionEnv, permissionContext } = ctx;
    const { permissionSetId } = payload;

    if (!permissionSetId) {
        return fail(res, 400, 'missing_fields', { required: ['permissionSetId'] });
    }
    if (payload.slug !== undefined) {
        return fail(res, 400, 'slug_immutable', {
            hint: 'A permission set slug-ja immutable. Az `update_permission_set` csak name/description/permissions mezőket fogad.'
        });
    }

    if (!env.permissionSetsCollectionId) {
        return fail(res, 500, 'misconfigured', {
            missing: ['PERMISSION_SETS_COLLECTION_ID']
        });
    }

    // Doc fetch + caller jogosultság (org owner/admin).
    let setDoc;
    try {
        setDoc = await databases.getDocument(env.databaseId, env.permissionSetsCollectionId, permissionSetId);
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'permission_set_not_found');
        error(`[UpdatePermSet] fetch hiba: ${err.message}`);
        return fail(res, 500, 'permission_set_fetch_failed');
    }

    // Codex review P2: opcionális TOCTOU guard `expectedUpdatedAt`-tal.
    // A kliens átadhatja a fresh `$updatedAt`-et — eltérés esetén
    // `concurrent_modification` 409, hogy a felhasználó újratöltse és
    // megerősítse. Mintáját az `activate_publication` (A.2.2) adja.
    if (payload.expectedUpdatedAt && payload.expectedUpdatedAt !== setDoc.$updatedAt) {
        return fail(res, 409, 'concurrent_modification', {
            actual: setDoc.$updatedAt,
            expected: payload.expectedUpdatedAt
        });
    }

    // A.3.6 — `permissionSet.edit` office-scope permission guard.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'permissionSet.edit',
        setDoc.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'permissionSet.edit',
            scope: 'office'
        });
    }

    // Update payload összeállítás — selective.
    const updateFields = {};

    if (payload.name !== undefined) {
        const sanitizedName = sanitizeString(payload.name, NAME_MAX_LENGTH);
        if (!sanitizedName) return fail(res, 400, 'invalid_name');
        updateFields.name = sanitizedName;
    }

    if (payload.description !== undefined) {
        const DESCRIPTION_MAX = 500;
        if (payload.description === null) {
            updateFields.description = null;
        } else if (typeof payload.description !== 'string') {
            return fail(res, 400, 'invalid_description');
        } else {
            const trimmed = payload.description.trim().slice(0, DESCRIPTION_MAX);
            updateFields.description = trimmed.length === 0 ? null : trimmed;
        }
    }

    if (payload.permissions !== undefined) {
        const slugCheck = permissions.validatePermissionSetSlugs(payload.permissions);
        if (!slugCheck.valid) {
            const orgScopeError = slugCheck.errors.find(e => e.code === 'org_scope_slug_not_allowed');
            if (orgScopeError) {
                return fail(res, 400, 'org_scope_slug_not_allowed', {
                    slugs: slugCheck.errors.filter(e => e.code === 'org_scope_slug_not_allowed').map(e => e.slug),
                    details: slugCheck.errors
                });
            }
            return fail(res, 400, 'invalid_permissions', { errors: slugCheck.errors });
        }
        updateFields.permissions = [...new Set(payload.permissions)];
    }

    if (Object.keys(updateFields).length === 0) {
        return res.json({ success: true, action: 'noop', permissionSet: setDoc });
    }

    // Restore-edge case: ha update közben `archivedAt`-t küldenek (nem
    // szabad — a restore_permission_set action a kanonikus). Ezt a
    // CF csendben elnyeli, mert az `updateFields`-ben nem szerepel.

    let updated;
    try {
        updated = await databases.updateDocument(
            env.databaseId,
            env.permissionSetsCollectionId,
            permissionSetId,
            updateFields
        );
    } catch (err) {
        error(`[UpdatePermSet] update hiba: ${err.message}`);
        return fail(res, 500, 'permission_set_update_failed');
    }

    log(`[UpdatePermSet] User ${callerId} frissítette a permission setet ${permissionSetId} (${Object.keys(updateFields).join(', ')})`);

    return res.json({
        success: true,
        action: 'updated',
        permissionSet: updated
    });
}

/**
 * ACTION='archive_permission_set' / 'restore_permission_set' (A.3.3).
 *
 * Soft-delete (`archivedAt` set/null). Idempotens. NINCS blocker-set
 * (Codex review (b) opció): a junction docok intaktak; az archived
 * permission set-et a `userHasPermission()` snapshot-build a
 * `archivedAt === null` szűrővel hagyja figyelmen kívül.
 *
 * Auth: `permissionSet.archive` (közös slug archive/restore-ra).
 */
async function archiveOrRestorePermissionSet(ctx) {
    const { databases, env, callerId, callerUser, action, payload, error, res, fail, log, permissionEnv, permissionContext } = ctx;
    const { permissionSetId } = payload;
    const isArchive = action === 'archive_permission_set';

    if (!permissionSetId) {
        return fail(res, 400, 'missing_fields', { required: ['permissionSetId'] });
    }
    if (!env.permissionSetsCollectionId) {
        return fail(res, 500, 'misconfigured', {
            missing: ['PERMISSION_SETS_COLLECTION_ID']
        });
    }

    let setDoc;
    try {
        setDoc = await databases.getDocument(env.databaseId, env.permissionSetsCollectionId, permissionSetId);
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'permission_set_not_found');
        error(`[${isArchive ? 'Archive' : 'Restore'}PermSet] fetch hiba: ${err.message}`);
        return fail(res, 500, 'permission_set_fetch_failed');
    }

    // Codex review P2: opcionális TOCTOU guard.
    if (payload.expectedUpdatedAt && payload.expectedUpdatedAt !== setDoc.$updatedAt) {
        return fail(res, 409, 'concurrent_modification', {
            actual: setDoc.$updatedAt,
            expected: payload.expectedUpdatedAt
        });
    }

    // Idempotens állapot-check.
    const isCurrentlyArchived = setDoc.archivedAt !== null && setDoc.archivedAt !== undefined;
    if (isArchive && isCurrentlyArchived) {
        return res.json({
            success: true,
            action: 'already_archived',
            permissionSet: setDoc
        });
    }
    if (!isArchive && !isCurrentlyArchived) {
        return res.json({
            success: true,
            action: 'already_active',
            permissionSet: setDoc
        });
    }

    // A.3.6 — `permissionSet.archive` office-scope permission guard
    //          (archive és restore közös slug).
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'permissionSet.archive',
        setDoc.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'permissionSet.archive',
            scope: 'office'
        });
    }

    let updated;
    try {
        updated = await databases.updateDocument(
            env.databaseId,
            env.permissionSetsCollectionId,
            permissionSetId,
            { archivedAt: isArchive ? new Date().toISOString() : null }
        );
    } catch (err) {
        const msg = err?.message || '';
        // Codex review (nit): szűkített detektálás — Appwrite konkrét
        // hibatípusait keressük, nem általános regex match-et az
        // `archivedAt` szóra (ami egyéb hibaüzenetben is előfordulhat).
        const isSchemaMissing = err?.type === 'document_invalid_structure'
            || /unknown attribute|invalid attribute/i.test(msg);
        if (isSchemaMissing) {
            return fail(res, 422, 'schema_missing', {
                hint: 'A permissionSets.archivedAt mező hiányzik. Futtasd a bootstrap_permission_sets_schema action-t.'
            });
        }
        error(`[${isArchive ? 'Archive' : 'Restore'}PermSet] update hiba: ${err.message}`);
        return fail(res, 500, isArchive ? 'permission_set_archive_failed' : 'permission_set_restore_failed');
    }

    log(`[${isArchive ? 'Archive' : 'Restore'}PermSet] User ${callerId} ${isArchive ? 'archiválta' : 'visszaállította'} a permission setet ${permissionSetId} (slug=${setDoc.slug})`);

    return res.json({
        success: true,
        action: isArchive ? 'archived' : 'restored',
        permissionSet: updated
    });
}

/**
 * ACTION='assign_permission_set_to_group' (A.3.4).
 *
 * M:n junction (`groupPermissionSets`) doc create. A `group_set_unique`
 * index megvédi a duplikátumtól — idempotens (`already_assigned`). Race
 * védelem: ha a 409 utáni verifying lookup üres / hiba, `assignment_state_unknown`
 * kód a kliens retry-jához.
 *
 * Cross-office check (`office_mismatch`). Best-effort warning archivált
 * permission set hozzárendelésekor.
 *
 * Auth: `permissionSet.assign` (közös slug assign/unassign-re).
 */
async function assignPermissionSetToGroup(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
    const { groupId, permissionSetId } = payload;

    if (!groupId || !permissionSetId) {
        return fail(res, 400, 'missing_fields', {
            required: ['groupId', 'permissionSetId']
        });
    }
    if (!env.permissionSetsCollectionId || !env.groupPermissionSetsCollectionId) {
        return fail(res, 500, 'misconfigured', {
            missing: [
                !env.permissionSetsCollectionId ? 'PERMISSION_SETS_COLLECTION_ID' : null,
                !env.groupPermissionSetsCollectionId ? 'GROUP_PERMISSION_SETS_COLLECTION_ID' : null
            ].filter(Boolean)
        });
    }

    // Group + permission set fetch párhuzamosan (két független lookup).
    let groupDoc, setDoc;
    try {
        [groupDoc, setDoc] = await Promise.all([
            databases.getDocument(env.databaseId, env.groupsCollectionId, groupId),
            databases.getDocument(env.databaseId, env.permissionSetsCollectionId, permissionSetId)
        ]);
    } catch (err) {
        if (err?.code === 404) {
            return fail(res, 404, 'group_or_permission_set_not_found', {
                message: err.message
            });
        }
        error(`[AssignPermSet] fetch hiba: ${err.message}`);
        return fail(res, 500, 'lookup_failed');
    }

    // Cross-office check.
    if (groupDoc.editorialOfficeId !== setDoc.editorialOfficeId) {
        return fail(res, 400, 'office_mismatch', {
            groupOfficeId: groupDoc.editorialOfficeId,
            permissionSetOfficeId: setDoc.editorialOfficeId
        });
    }

    // A.3.6 — `permissionSet.assign` office-scope permission guard.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'permissionSet.assign',
        groupDoc.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'permissionSet.assign',
            scope: 'office'
        });
    }

    // Junction doc create — `group_set_unique` index idempotens.
    let junctionDoc;
    try {
        junctionDoc = await databases.createDocument(
            env.databaseId,
            env.groupPermissionSetsCollectionId,
            sdk.ID.unique(),
            {
                groupId,
                permissionSetId,
                editorialOfficeId: groupDoc.editorialOfficeId,
                organizationId: groupDoc.organizationId
            },
            buildOfficeAclPerms(groupDoc.editorialOfficeId)
        );
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
            // Idempotens — visszaadjuk a meglévő junction doc-ot.
            // **Race-szivárgás védelem** (Codex adversarial review nit):
            // a `group_set_unique` 409-et adott, de mire a fallback
            // listDocuments lefut, a junction törlődhetett (másik admin
            // unassign-eli). Eltérő `action` azonosítja a két ágat:
            //   - `already_assigned` + valós junction doc: idempotens success
            //   - `assignment_state_unknown`: 409 + lookup üres / hiba →
            //     a kliens újrapróbálja az assign-t vagy frissíti a state-et.
            try {
                const existing = await databases.listDocuments(
                    env.databaseId,
                    env.groupPermissionSetsCollectionId,
                    [
                        sdk.Query.equal('groupId', groupId),
                        sdk.Query.equal('permissionSetId', permissionSetId),
                        sdk.Query.limit(1)
                    ]
                );
                if (existing.documents.length > 0) {
                    return res.json({
                        success: true,
                        action: 'already_assigned',
                        junction: existing.documents[0]
                    });
                }
                return res.json({
                    success: true,
                    action: 'assignment_state_unknown',
                    note: 'A junction doc 409-et adott, de a verifikáló lookup nem találta — race közben törölhették. A kliens frissítse a state-et és próbálkozzon újra.'
                });
            } catch (lookupErr) {
                error(`[AssignPermSet] verifying lookup hiba: ${lookupErr.message}`);
                return res.json({
                    success: true,
                    action: 'assignment_state_unknown',
                    note: 'A junction doc 409-et adott, de a verifikáló lookup hibát adott. A kliens frissítse a state-et és próbálkozzon újra.'
                });
            }
        }
        error(`[AssignPermSet] junction create hiba: ${err.message}`);
        return fail(res, 500, 'junction_create_failed');
    }

    log(`[AssignPermSet] User ${callerId} hozzárendelte a permission set ${setDoc.slug}-t a group ${groupDoc.slug}-hoz (office ${groupDoc.editorialOfficeId})`);

    // Best-effort warning ha a permission set archivált — a kliens UI
    // banner-rel jelezheti, hogy a hozzárendelés érvényes lesz a restore után.
    const warnings = [];
    if (setDoc.archivedAt) {
        warnings.push({
            code: 'permission_set_archived',
            message: 'A permission set archivált — a hozzárendelés rögzítve, de a userHasPermission() jelenleg figyelmen kívül hagyja. Restore után automatikusan érvényessé válik.'
        });
    }

    return res.json({
        success: true,
        action: 'assigned',
        junction: junctionDoc,
        warnings
    });
}

/**
 * ACTION='unassign_permission_set_from_group' (A.3.4).
 *
 * Junction doc delete. Idempotens (`already_unassigned`).
 */
async function unassignPermissionSetFromGroup(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
    const { groupId, permissionSetId } = payload;

    if (!groupId || !permissionSetId) {
        return fail(res, 400, 'missing_fields', {
            required: ['groupId', 'permissionSetId']
        });
    }
    if (!env.groupPermissionSetsCollectionId) {
        return fail(res, 500, 'misconfigured', {
            missing: ['GROUP_PERMISSION_SETS_COLLECTION_ID']
        });
    }

    // Group fetch a caller auth-hoz (az office scope-hoz kell).
    let groupDoc;
    try {
        groupDoc = await databases.getDocument(env.databaseId, env.groupsCollectionId, groupId);
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'group_not_found');
        error(`[UnassignPermSet] group fetch hiba: ${err.message}`);
        return fail(res, 500, 'lookup_failed');
    }

    // A.3.6 — `permissionSet.assign` office-scope permission guard
    //          (assign és unassign közös slug).
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'permissionSet.assign',
        groupDoc.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'permissionSet.assign',
            scope: 'office'
        });
    }

    // Junction lookup + delete.
    let existing;
    try {
        existing = await databases.listDocuments(
            env.databaseId,
            env.groupPermissionSetsCollectionId,
            [
                sdk.Query.equal('groupId', groupId),
                sdk.Query.equal('permissionSetId', permissionSetId),
                sdk.Query.limit(1)
            ]
        );
    } catch (err) {
        error(`[UnassignPermSet] junction lookup hiba: ${err.message}`);
        return fail(res, 500, 'lookup_failed');
    }

    if (existing.documents.length === 0) {
        return res.json({ success: true, action: 'already_unassigned' });
    }

    try {
        await databases.deleteDocument(
            env.databaseId,
            env.groupPermissionSetsCollectionId,
            existing.documents[0].$id
        );
    } catch (err) {
        if (err?.code === 404) {
            return res.json({ success: true, action: 'already_unassigned' });
        }
        error(`[UnassignPermSet] junction delete hiba: ${err.message}`);
        return fail(res, 500, 'junction_delete_failed');
    }

    log(`[UnassignPermSet] User ${callerId} eltávolította a permission set ${permissionSetId}-t a group ${groupId}-ról`);

    return res.json({
        success: true,
        action: 'unassigned',
        junctionId: existing.documents[0].$id
    });
}

module.exports = {
    createPermissionSet,
    updatePermissionSet,
    archiveOrRestorePermissionSet,
    assignPermissionSetToGroup,
    unassignPermissionSetFromGroup
};
