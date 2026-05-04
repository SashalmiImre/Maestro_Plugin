// B.0.3.d (2026-05-04) — Group CRUD action-ok kiszervezve külön modulba.
// Tartalmazza: add_group_member, remove_group_member, create_group,
// update_group_metadata (alias: rename_group), archive_group, restore_group,
// delete_group. A komment-anyag és logika 1:1 átkerült a `main.js`-ből,
// csak a változó-források cseréltek (globális zárolt scope helyett `ctx`).

const crypto = require('crypto');
const {
    NAME_MAX_LENGTH,
    SLUG_MAX_LENGTH,
    sanitizeString,
    slugifyName
} = require('../helpers/util.js');
const {
    CASCADE_BATCH_LIMIT,
    MAX_REFERENCES_PER_SCAN,
    PARSE_ERROR
} = require('../helpers/constants.js');
const { deleteByQuery } = require('../helpers/cascade.js');
const {
    workflowReferencesSlug,
    contributorJsonReferencesSlug
} = require('../helpers/compiledValidator.js');
const { buildOfficeAclPerms } = require('../teamHelpers.js');
const permissions = require('../permissions.js');

/**
 * ACTION='add_group_member' (A.3.6) — userHasPermission('group.member.add')
 * office-scope. Idempotens (`already_member`). Target user verifikált + office-tag.
 */
async function addGroupMember(ctx) {
    const { databases, env, callerId, callerUser, payload, log, res, fail, sdk, usersApi, permissionEnv, permissionContext } = ctx;
    const { groupId, userId } = payload;
    if (!groupId || !userId) {
        return fail(res, 400, 'missing_fields', { required: ['groupId', 'userId'] });
    }

    // 1. Group lookup — scope feloldás (orgId, officeId)
    let group;
    try {
        group = await databases.getDocument(env.databaseId, env.groupsCollectionId, groupId);
    } catch (err) {
        return fail(res, 404, 'group_not_found');
    }

    // 2. A.3.6 — `group.member.add` office-scope permission guard.
    //    Az ADR 0008 szerint owner/admin org-role automatikusan minden
    //    33 office-scope slugot megad, így a régi role-check
    //    visszafelé-kompatibilis — a new permission-set rendszerben
    //    a member is engedélyezhető, ha a group-ja `permissionSets`
    //    `group.member.add` slugot tartalmaz.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'group.member.add',
        group.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'group.member.add',
            scope: 'office'
        });
    }

    // 3. Target user lookup — userName/userEmail denormalizálás + aktív/verifikált check
    let targetUser;
    try {
        targetUser = await usersApi.get(userId);
    } catch (err) {
        return fail(res, 404, 'target_user_not_found');
    }

    if (targetUser.status === false) {
        return fail(res, 403, 'target_user_inactive');
    }
    if (!targetUser.emailVerification) {
        return fail(res, 403, 'target_user_not_verified');
    }

    // 4. Target user szerkesztőségi tagság ellenőrzés — csak a group
    //    szerkesztőségéhez tartozó user adható a csoporthoz
    const targetOfficeMembership = await databases.listDocuments(
        env.databaseId,
        env.officeMembershipsCollectionId,
        [
            sdk.Query.equal('editorialOfficeId', group.editorialOfficeId),
            sdk.Query.equal('userId', userId),
            sdk.Query.limit(1)
        ]
    );
    if (targetOfficeMembership.documents.length === 0) {
        return fail(res, 403, 'target_user_not_office_member', {
            editorialOfficeId: group.editorialOfficeId
        });
    }

    // 5. GroupMembership létrehozás (idempotens) — office ACL scope-pal
    try {
        const gmDoc = await databases.createDocument(
            env.databaseId,
            env.groupMembershipsCollectionId,
            sdk.ID.unique(),
            {
                groupId,
                userId,
                editorialOfficeId: group.editorialOfficeId,
                organizationId: group.organizationId,
                role: 'member',
                addedByUserId: callerId,
                userName: targetUser.name || '',
                userEmail: targetUser.email || ''
            },
            buildOfficeAclPerms(group.editorialOfficeId)
        );
        log(`[AddGroupMember] User ${userId} hozzáadva a group ${groupId}-hoz (${group.slug})`);
        return res.json({
            success: true,
            action: 'added',
            groupMembershipId: gmDoc.$id,
            groupId,
            userId
        });
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
            log(`[AddGroupMember] Idempotens — user ${userId} már tagja a group ${groupId}-nak`);
            return res.json({
                success: true,
                action: 'already_member',
                groupId,
                userId
            });
        }
        throw err;
    }
}

/**
 * ACTION='remove_group_member' (A.3.6 + A.2.5).
 *
 * userHasPermission('group.member.remove'). Idempotens (`already_removed`).
 * A.2.5 warning scan: ha a remove után a csoport üres lett ÉS a slug aktív
 * pub `compiledWorkflowSnapshot.requiredGroupSlugs[]`-ben szerepel, a
 * response `warnings: [{ code: 'empty_required_group', ... }]`. A művelet
 * engedett (snapshot védi a runtime-ot), best-effort scan.
 */
async function removeGroupMember(ctx) {
    const { databases, env, callerUser, payload, log, res, fail, sdk, permissionEnv, permissionContext } = ctx;
    const { groupId, userId } = payload;
    if (!groupId || !userId) {
        return fail(res, 400, 'missing_fields', { required: ['groupId', 'userId'] });
    }

    // 1. Group lookup — scope feloldás
    let group;
    try {
        group = await databases.getDocument(env.databaseId, env.groupsCollectionId, groupId);
    } catch (err) {
        return fail(res, 404, 'group_not_found');
    }

    // 2. A.3.6 — `group.member.remove` office-scope permission guard.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'group.member.remove',
        group.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'group.member.remove',
            scope: 'office'
        });
    }

    // 3. GroupMembership keresés és törlés
    const existing = await databases.listDocuments(
        env.databaseId,
        env.groupMembershipsCollectionId,
        [
            sdk.Query.equal('groupId', groupId),
            sdk.Query.equal('userId', userId),
            sdk.Query.limit(1)
        ]
    );

    if (existing.documents.length === 0) {
        log(`[RemoveGroupMember] Idempotens — user ${userId} nem tagja a group ${groupId}-nak`);
        return res.json({
            success: true,
            action: 'already_removed',
            groupId,
            userId
        });
    }

    await databases.deleteDocument(env.databaseId, env.groupMembershipsCollectionId, existing.documents[0].$id);
    log(`[RemoveGroupMember] User ${userId} eltávolítva a group ${groupId}-ból (${group.slug})`);

    // 4. A.2.5 — warning detekció: ha az eltávolítás után a csoport
    //    üres lett ÉS a slug egy aktív pub `compiledWorkflowSnapshot.
    //    requiredGroupSlugs[]`-ben szerepel, jelzünk a kliensnek.
    //    A művelet engedett (snapshot védi a runtime-ot), de az UI
    //    bannerként megjeleníti az érintett pubokat.
    //
    //    Best-effort: a scan hibája nem blokkolja a removal sikerét.
    //    A `publications` env hiánya esetén csendben skip-pelünk.
    const warnings = [];
    if (env.publicationsCollectionId) {
        try {
            // 4a. Maradt-e tag a csoportban?
            const remainingMembers = await databases.listDocuments(
                env.databaseId,
                env.groupMembershipsCollectionId,
                [
                    sdk.Query.equal('groupId', groupId),
                    sdk.Query.select(['$id']),
                    sdk.Query.limit(1)
                ]
            );
            if (remainingMembers.documents.length === 0) {
                // 4b. Aktív pubok scan-je `compiledWorkflowSnapshot`
                //    `requiredGroupSlugs[]`-szel.
                const affectedPublications = [];
                let pubCursor = null;
                affectedPubScan:
                while (true) {
                    const queries = [
                        sdk.Query.equal('organizationId', group.organizationId),
                        sdk.Query.equal('isActivated', true),
                        sdk.Query.select(['$id', 'name', 'editorialOfficeId', 'compiledWorkflowSnapshot']),
                        sdk.Query.limit(CASCADE_BATCH_LIMIT)
                    ];
                    if (pubCursor) queries.push(sdk.Query.cursorAfter(pubCursor));

                    const pubBatch = await databases.listDocuments(
                        env.databaseId,
                        env.publicationsCollectionId,
                        queries
                    );
                    if (pubBatch.documents.length === 0) break;
                    for (const pub of pubBatch.documents) {
                        if (!pub.compiledWorkflowSnapshot || typeof pub.compiledWorkflowSnapshot !== 'string') continue;
                        let snapshot;
                        try { snapshot = JSON.parse(pub.compiledWorkflowSnapshot); } catch { continue; }
                        const requiredSlugs = Array.isArray(snapshot?.requiredGroupSlugs)
                            ? snapshot.requiredGroupSlugs.map(e => e?.slug).filter(s => typeof s === 'string')
                            : [];
                        if (requiredSlugs.includes(group.slug)) {
                            affectedPublications.push({
                                $id: pub.$id,
                                name: pub.name,
                                editorialOfficeId: pub.editorialOfficeId
                            });
                            if (affectedPublications.length >= MAX_REFERENCES_PER_SCAN) break affectedPubScan;
                        }
                    }
                    if (pubBatch.documents.length < CASCADE_BATCH_LIMIT) break;
                    pubCursor = pubBatch.documents[pubBatch.documents.length - 1].$id;
                }

                if (affectedPublications.length > 0) {
                    warnings.push({
                        code: 'empty_required_group',
                        slug: group.slug,
                        groupId,
                        affectedPublications,
                        note: 'Az utolsó tag eltávolítása után a csoport üres, és aktív publikáció(k) workflow-ja kötelezőként hivatkozza. A futó publikációk a snapshot alapján tovább működnek; új tag hozzáadása ajánlott.'
                    });
                    log(`[RemoveGroupMember] WARNING: empty_required_group slug="${group.slug}", affectedPubs=${affectedPublications.length}`);
                }
            }
        } catch (warnErr) {
            log(`[RemoveGroupMember] warning scan hiba (nem blokkoló): ${warnErr.message}`);
        }
    }

    return res.json({
        success: true,
        action: 'removed',
        groupId,
        userId,
        warnings
    });
}

/**
 * ACTION='create_group' (A.3.6) — új custom csoport létrehozása.
 *
 * userHasPermission('group.create'). Slug auto-generálás `slugifyName(name)`-ből,
 * 3 próba random suffix-szel ütközés esetén. Caller seed membership (best-effort,
 * skip ha nem office-tag). TOCTOU: display name uniqueness elfogadott
 * kompromisszum, slug az unique index véd.
 */
async function createGroup(ctx) {
    const { databases, env, callerId, callerUser, payload, log, error, res, fail, sdk, usersApi, permissionEnv, permissionContext } = ctx;
    const { editorialOfficeId } = payload;
    const sanitizedName = sanitizeString(payload.name, NAME_MAX_LENGTH);

    if (!editorialOfficeId || !sanitizedName) {
        return fail(res, 400, 'missing_fields', {
            required: ['editorialOfficeId', 'name']
        });
    }

    // 1) Office lookup → organizationId
    let officeDoc;
    try {
        officeDoc = await databases.getDocument(env.databaseId, env.officesCollectionId, editorialOfficeId);
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'office_not_found');
        error(`[CreateGroup] office fetch hiba: ${err.message}`);
        return fail(res, 500, 'office_fetch_failed');
    }

    // 2) A.3.6 — `group.create` office-scope permission guard.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'group.create',
        editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'group.create',
            scope: 'office'
        });
    }

    // 3) Display name uniqueness az office-on belül
    const nameConflict = await databases.listDocuments(
        env.databaseId,
        env.groupsCollectionId,
        [
            sdk.Query.equal('editorialOfficeId', editorialOfficeId),
            sdk.Query.equal('name', sanitizedName),
            sdk.Query.limit(1)
        ]
    );
    if (nameConflict.documents.length > 0) {
        return fail(res, 409, 'name_taken');
    }

    // 4) Group létrehozás — slug auto-generálás + ütközéskor retry random
    //    suffix-szel (office-scope unique a slug az Appwrite compound indexen).
    const baseSlug = slugifyName(sanitizedName);
    let newGroupDoc = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const candidateSlug = attempt === 0
            ? baseSlug
            : `${baseSlug.slice(0, SLUG_MAX_LENGTH - 5)}-${crypto.randomBytes(2).toString('hex')}`;
        try {
            newGroupDoc = await databases.createDocument(
                env.databaseId,
                env.groupsCollectionId,
                sdk.ID.unique(),
                {
                    organizationId: officeDoc.organizationId,
                    editorialOfficeId,
                    name: sanitizedName,
                    slug: candidateSlug,
                    createdByUserId: callerId
                },
                buildOfficeAclPerms(editorialOfficeId)
            );
            break;
        } catch (err) {
            const isUnique = err?.type === 'document_already_exists' || /unique/i.test(err?.message || '');
            if (isUnique && attempt < 2) continue;
            error(`[CreateGroup] group create hiba (slug=${candidateSlug}, attempt=${attempt}): ${err.message}`);
            if (isUnique) return fail(res, 409, 'group_slug_taken');
            return fail(res, 500, 'group_create_failed');
        }
    }

    // 5) Caller seed membership — így nincs árva csoport. Ha a caller nem
    //    office-tag (org admin de nem office tag), skip-eljük a seed-et,
    //    de a group létrejön — a későbbi add_group_member eléri.
    const callerOfficeMembership = await databases.listDocuments(
        env.databaseId,
        env.officeMembershipsCollectionId,
        [
            sdk.Query.equal('editorialOfficeId', editorialOfficeId),
            sdk.Query.equal('userId', callerId),
            sdk.Query.limit(1)
        ]
    );
    let seedMembershipId = null;
    if (callerOfficeMembership.documents.length > 0) {
        try {
            let callerUserDoc = null;
            try { callerUserDoc = await usersApi.get(callerId); } catch { /* non-blocking */ }
            const memDoc = await databases.createDocument(
                env.databaseId,
                env.groupMembershipsCollectionId,
                sdk.ID.unique(),
                {
                    groupId: newGroupDoc.$id,
                    userId: callerId,
                    editorialOfficeId,
                    organizationId: officeDoc.organizationId,
                    role: 'member',
                    addedByUserId: callerId,
                    userName: callerUserDoc?.name || '',
                    userEmail: callerUserDoc?.email || ''
                },
                buildOfficeAclPerms(editorialOfficeId)
            );
            seedMembershipId = memDoc.$id;
        } catch (err) {
            // Seed bukás nem rollback-eli a groupot — a UI-ban látható,
            // hozzá lehet adni kézzel.
            error(`[CreateGroup] seed membership hiba (group=${newGroupDoc.$id}): ${err.message}`);
        }
    }

    log(`[CreateGroup] User ${callerId} létrehozta "${sanitizedName}" (${newGroupDoc.slug}) csoportot az office ${editorialOfficeId}-ban`);

    return res.json({
        success: true,
        action: 'created',
        group: newGroupDoc,
        seedMembershipId
    });
}

/**
 * ACTION='update_group_metadata' (alias: 'rename_group') — A.2.6 (ADR 0008).
 *
 * Csoport metaadat szerkesztés. A `slug` SOHA nem változik (immutable, ID-szerepben
 * hivatkozza a workflow compiled JSON). Szerkeszthető mezők: `label` (DB-ben `name`),
 * `description`, `color`, `isContributorGroup`, `isLeaderGroup`. Aktív payload kulcs
 * hiánya = no-op az adott mezőre (selective update).
 *
 * Backward compat: a `rename_group` alias változatlanul fogadja a
 * `{ groupId, name }` payloadot. Az új mezők csak akkor frissülnek,
 * ha a séma elérhető (`bootstrap_groups_schema` lefutott) — a
 * schema-safe fallback a `name` mezőt mindenképp frissíti.
 */
async function updateGroupMetadata(ctx) {
    const { databases, env, callerId, callerUser, payload, log, error, res, fail, sdk, permissionEnv, permissionContext } = ctx;
    const { groupId } = payload;

    // `label` és `name` aliasok — a frontend `label`-t küld
    // (UI-konvenció), a CF a DB-mező `name` szerint ír. Mindkét
    // payload kulcs elfogadott, hogy a régi és az új kliens is
    // működjön.
    const labelInput = payload.label !== undefined ? payload.label : payload.name;
    let nameUpdate = undefined;
    if (labelInput !== undefined) {
        const sanitizedLabel = sanitizeString(labelInput, NAME_MAX_LENGTH);
        if (!sanitizedLabel) {
            return fail(res, 400, 'invalid_label');
        }
        nameUpdate = sanitizedLabel;
    }

    // description (max 500 char, nullable). `null` = explicit törlés
    // (UI-ban a textarea üresre állítható), `undefined` = no-op.
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

    // color: CSS hex (#rrggbb / #rrggbbaa / shorthand #rgb). Nullable.
    let colorUpdate = undefined;
    if (payload.color !== undefined) {
        if (payload.color === null) {
            colorUpdate = null;
        } else if (typeof payload.color !== 'string') {
            return fail(res, 400, 'invalid_color');
        } else {
            const trimmed = payload.color.trim();
            if (!/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
                return fail(res, 400, 'invalid_color', {
                    hint: 'CSS hex (e.g. #FFAA00 or #FA0)'
                });
            }
            colorUpdate = trimmed;
        }
    }

    // isContributorGroup / isLeaderGroup — boolean flag-ek.
    let isContributorGroupUpdate = undefined;
    if (payload.isContributorGroup !== undefined) {
        if (typeof payload.isContributorGroup !== 'boolean') {
            return fail(res, 400, 'invalid_flag', { field: 'isContributorGroup' });
        }
        isContributorGroupUpdate = payload.isContributorGroup;
    }
    let isLeaderGroupUpdate = undefined;
    if (payload.isLeaderGroup !== undefined) {
        if (typeof payload.isLeaderGroup !== 'boolean') {
            return fail(res, 400, 'invalid_flag', { field: 'isLeaderGroup' });
        }
        isLeaderGroupUpdate = payload.isLeaderGroup;
    }

    if (!groupId) {
        return fail(res, 400, 'missing_fields', { required: ['groupId'] });
    }

    // Slug-immutable enforcement: a kliens-payload soha nem írhatja
    // át a slug-ot (DevTools / direkt CF hívás bypass ellen).
    if (payload.slug !== undefined) {
        return fail(res, 400, 'slug_immutable', {
            note: 'A csoport slug-ja az ID — workflow-hivatkozás stabilitása. Slug-átnevezés Phase 2.'
        });
    }

    const hasAnyUpdate =
        nameUpdate !== undefined
        || descriptionUpdate !== undefined
        || colorUpdate !== undefined
        || isContributorGroupUpdate !== undefined
        || isLeaderGroupUpdate !== undefined;
    if (!hasAnyUpdate) {
        return fail(res, 400, 'nothing_to_update');
    }

    // 1) Group lookup → scope feloldás
    let groupDoc;
    try {
        groupDoc = await databases.getDocument(env.databaseId, env.groupsCollectionId, groupId);
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'group_not_found');
        error(`[UpdateGroupMetadata] group fetch hiba: ${err.message}`);
        return fail(res, 500, 'group_fetch_failed');
    }

    // 2) A.3.6 — `group.rename` office-scope permission guard.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'group.rename',
        groupDoc.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'group.rename',
            scope: 'office'
        });
    }

    // 3) Uniqueness — csak akkor, ha label változik (`name` mező).
    if (nameUpdate !== undefined && nameUpdate !== groupDoc.name) {
        const nameConflict = await databases.listDocuments(
            env.databaseId,
            env.groupsCollectionId,
            [
                sdk.Query.equal('editorialOfficeId', groupDoc.editorialOfficeId),
                sdk.Query.equal('name', nameUpdate),
                sdk.Query.limit(1)
            ]
        );
        const conflict = nameConflict.documents.find(d => d.$id !== groupId);
        if (conflict) {
            return fail(res, 409, 'name_taken');
        }
    }

    // 4) Update payload — csak a tényleg változó mezők.
    const updateData = {};
    if (nameUpdate !== undefined && nameUpdate !== groupDoc.name) {
        updateData.name = nameUpdate;
    }
    if (descriptionUpdate !== undefined && descriptionUpdate !== (groupDoc.description ?? null)) {
        updateData.description = descriptionUpdate;
    }
    if (colorUpdate !== undefined && colorUpdate !== (groupDoc.color ?? null)) {
        updateData.color = colorUpdate;
    }
    if (isContributorGroupUpdate !== undefined && isContributorGroupUpdate !== (groupDoc.isContributorGroup ?? false)) {
        updateData.isContributorGroup = isContributorGroupUpdate;
    }
    if (isLeaderGroupUpdate !== undefined && isLeaderGroupUpdate !== (groupDoc.isLeaderGroup ?? false)) {
        updateData.isLeaderGroup = isLeaderGroupUpdate;
    }

    if (Object.keys(updateData).length === 0) {
        return res.json({
            success: true,
            action: 'noop',
            groupId,
            slug: groupDoc.slug
        });
    }

    // 5) Frissítés. Két szemantika:
    //   (a) `rename_group` legacy alias VAGY az új action, de a kliens
    //       CSAK `name` mezőt frissít → schema-safe fallback: ha az új
    //       mezők hiányoznak a sémából, a `name` még működik.
    //   (b) `update_group_metadata` action ÉS a kliens új mezőt is kér →
    //       fail-fast 422 `schema_missing`. Részleges siker (`name` ment,
    //       a többi eldobódik) kerülve, hogy a UI ne kapjon hamisan
    //       sikeres választ.
    const onlyNameRequested =
        Object.keys(updateData).length === 1 && 'name' in updateData;
    try {
        await databases.updateDocument(
            env.databaseId,
            env.groupsCollectionId,
            groupId,
            updateData
        );
    } catch (err) {
        const isSchemaMissing =
            (err?.type === 'document_invalid_structure' || err?.code === 400)
            && /unknown attribute|description|color|isContributorGroup|isLeaderGroup/i.test(err?.message || '');
        if (isSchemaMissing) {
            if (onlyNameRequested) {
                // Tiszta legacy use-case: csak `name`/`label` érkezett.
                // Ezt mindig sikeresnek vesszük, ahogy a régi
                // `rename_group` viselkedett.
                try {
                    await databases.updateDocument(
                        env.databaseId,
                        env.groupsCollectionId,
                        groupId,
                        { name: updateData.name }
                    );
                    log(`[UpdateGroupMetadata] legacy rename (${groupId}, "${groupDoc.name}" → "${updateData.name}")`);
                    return res.json({
                        success: true,
                        action: 'renamed',
                        groupId,
                        slug: groupDoc.slug,
                        name: updateData.name
                    });
                } catch (fallbackErr) {
                    error(`[UpdateGroupMetadata] legacy rename hiba (${groupId}): ${fallbackErr.message}`);
                    return fail(res, 500, 'update_failed');
                }
            }
            // Vegyes update + hiányzó schema — explicit hiba, ne lopja
            // el a részleges sikerrel a felhasználó beavatkozási lehetőségét.
            return fail(res, 422, 'schema_missing', {
                required: ['description', 'color', 'isContributorGroup', 'isLeaderGroup'],
                hint: 'Futtasd: bootstrap_groups_schema'
            });
        }
        error(`[UpdateGroupMetadata] updateDocument hiba (${groupId}): ${err.message}`);
        return fail(res, 500, 'update_failed');
    }

    log(`[UpdateGroupMetadata] User ${callerId} frissítette group ${groupId} (${groupDoc.slug}): mezők=[${Object.keys(updateData).join(',')}]`);

    return res.json({
        success: true,
        action: 'updated',
        groupId,
        slug: groupDoc.slug,
        name: updateData.name ?? groupDoc.name,
        description: 'description' in updateData
            ? updateData.description
            : (groupDoc.description ?? null),
        color: 'color' in updateData
            ? updateData.color
            : (groupDoc.color ?? null),
        isContributorGroup: 'isContributorGroup' in updateData
            ? updateData.isContributorGroup
            : (groupDoc.isContributorGroup ?? false),
        isLeaderGroup: 'isLeaderGroup' in updateData
            ? updateData.isLeaderGroup
            : (groupDoc.isLeaderGroup ?? false)
    });
}

/**
 * ACTION='archive_group' / 'restore_group' — A.2.7 (ADR 0008).
 *
 * Soft-delete a csoporton (`archivedAt = now()` set/null). Idempotens.
 * Az archive ág ugyanazt a blocker-set-et alkalmazza, mint a `delete_group`
 * (különben az archív gomb megkerülhetné a hivatkozás-blokkolást):
 *   1. Nem-archivált workflow `requiredGroupSlugs[]` / state-mezők
 *   2. Aktív publikáció `compiledWorkflowSnapshot`
 *   3. `articles.contributors` / `publications.defaultContributors` JSON kulcsok
 *
 * A `restore_group` nem fut blocker-checket. Auth: org owner/admin.
 */
async function archiveOrRestoreGroup(ctx) {
    const { databases, env, callerId, callerUser, action, payload, log, error, res, fail, sdk, permissionEnv, permissionContext } = ctx;
    const { groupId } = payload;
    const isArchive = action === 'archive_group';

    if (!groupId) {
        return fail(res, 400, 'missing_fields', { required: ['groupId'] });
    }

    // Action-szintű env var guard a blocker-scan-hez (csak archive
    // ágon kötelező; restore feltétel nélküli). A `defaultContributors`
    // és `articles.contributors` JSON kulcs scan-jéhez kötelezőek.
    if (isArchive) {
        const missingForArchive = [];
        if (!env.publicationsCollectionId) missingForArchive.push('PUBLICATIONS_COLLECTION_ID');
        if (!env.articlesCollectionId) missingForArchive.push('ARTICLES_COLLECTION_ID');
        if (missingForArchive.length > 0) {
            error(`[ArchiveGroup] Hiányzó env var(ok): ${missingForArchive.join(', ')}`);
            return fail(res, 500, 'misconfigured', { missing: missingForArchive });
        }
    }

    // 1) Group lookup
    let groupDoc;
    try {
        groupDoc = await databases.getDocument(env.databaseId, env.groupsCollectionId, groupId);
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'group_not_found');
        error(`[${isArchive ? 'ArchiveGroup' : 'RestoreGroup'}] group fetch hiba: ${err.message}`);
        return fail(res, 500, 'group_fetch_failed');
    }

    // 2) A.3.6 — `group.delete` office-scope permission guard
    //    (archive/restore közös slug, ADR 0008 38-slug taxonómia).
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'group.delete',
        groupDoc.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'group.delete',
            scope: 'office'
        });
    }

    // 3) Idempotens státusz check
    const currentlyArchived = !!groupDoc.archivedAt;
    if (isArchive && currentlyArchived) {
        return res.json({
            success: true,
            action: 'already_archived',
            groupId,
            archivedAt: groupDoc.archivedAt
        });
    }
    if (!isArchive && !currentlyArchived) {
        return res.json({
            success: true,
            action: 'already_active',
            groupId
        });
    }

    // 4) Csak archiválás → blocker-check (nem-archivált workflow +
    // aktív publikáció snapshot + contributor JSON kulcsok). Ugyanaz
    // a blocker-set, mint a `delete_group`-ban — különben az archív
    // gombbal megkerülhető lenne a hivatkozás-blokkolás (silent
    // soft-delete + contributor stranded slug data-loss).
    if (isArchive) {
        const targetSlug = groupDoc.slug;
        const usedInWorkflows = [];
        const usedInActivePublications = [];
        const usedInPublications = [];
        const usedInArticles = [];

        // 4a) Nem-archivált workflow-k a teljes orgban (org-scope
        // workflow is hivatkozhat erre az office-on kívülről).
        let wfCursor = null;
        wfLoop:
        while (true) {
            const queries = [
                sdk.Query.equal('organizationId', groupDoc.organizationId),
                sdk.Query.isNull('archivedAt'),
                sdk.Query.select(['$id', 'name', 'compiled', 'editorialOfficeId']),
                sdk.Query.limit(CASCADE_BATCH_LIMIT)
            ];
            if (wfCursor) queries.push(sdk.Query.cursorAfter(wfCursor));

            let wfBatch;
            try {
                wfBatch = await databases.listDocuments(env.databaseId, env.workflowsCollectionId, queries);
            } catch (queryErr) {
                // `archivedAt` mező hiányában az isNull query 400-zal
                // bukik. Schema-safe fallback: scan archivedAt szűrő nélkül.
                if (queryErr?.code === 400 || /unknown attribute|archivedAt/i.test(queryErr?.message || '')) {
                    log(`[ArchiveGroup] archivedAt mező nem elérhető — workflow scan szűrő nélkül.`);
                    const fallbackQueries = [
                        sdk.Query.equal('organizationId', groupDoc.organizationId),
                        sdk.Query.select(['$id', 'name', 'compiled', 'editorialOfficeId', 'archivedAt']),
                        sdk.Query.limit(CASCADE_BATCH_LIMIT)
                    ];
                    if (wfCursor) fallbackQueries.push(sdk.Query.cursorAfter(wfCursor));
                    wfBatch = await databases.listDocuments(env.databaseId, env.workflowsCollectionId, fallbackQueries);
                    wfBatch.documents = wfBatch.documents.filter(d => !d.archivedAt);
                } else {
                    throw queryErr;
                }
            }
            if (wfBatch.documents.length === 0) break;
            for (const wf of wfBatch.documents) {
                if (!wf.compiled || typeof wf.compiled !== 'string') continue;
                let compiled;
                try {
                    compiled = JSON.parse(wf.compiled);
                } catch {
                    // Fail-closed parse-hiba (harden Codex MUST FIX):
                    // sérült compiled-es workflow blocker-listára kerül,
                    // különben elnyelné a slug-hivatkozást és a csoport
                    // archiválható lenne data-loss veszéllyel.
                    usedInWorkflows.push({ $id: wf.$id, name: wf.name, parseError: true });
                    if (usedInWorkflows.length >= MAX_REFERENCES_PER_SCAN) break wfLoop;
                    continue;
                }
                if (workflowReferencesSlug(compiled, targetSlug)) {
                    usedInWorkflows.push({ $id: wf.$id, name: wf.name });
                    if (usedInWorkflows.length >= MAX_REFERENCES_PER_SCAN) break wfLoop;
                }
            }
            if (wfBatch.documents.length < CASCADE_BATCH_LIMIT) break;
            wfCursor = wfBatch.documents[wfBatch.documents.length - 1].$id;
        }

        // 4b) Aktív publikációk + snapshot scan. A snapshot-ban
        // rögzített `requiredGroupSlugs[]` az autoritatív futás-idejű
        // forrás — ha ott a slug, a runtime arra építhet (autoseed
        // tag-listához, leader bypass-hoz).
        let activePubCursor = null;
        activePubLoop:
        while (true) {
            const queries = [
                sdk.Query.equal('organizationId', groupDoc.organizationId),
                sdk.Query.equal('isActivated', true),
                sdk.Query.select(['$id', 'name', 'compiledWorkflowSnapshot']),
                sdk.Query.limit(CASCADE_BATCH_LIMIT)
            ];
            if (activePubCursor) queries.push(sdk.Query.cursorAfter(activePubCursor));

            const pubBatch = await databases.listDocuments(env.databaseId, env.publicationsCollectionId, queries);
            if (pubBatch.documents.length === 0) break;
            for (const pub of pubBatch.documents) {
                if (!pub.compiledWorkflowSnapshot || typeof pub.compiledWorkflowSnapshot !== 'string') {
                    continue;
                }
                let snapshot;
                try {
                    snapshot = JSON.parse(pub.compiledWorkflowSnapshot);
                } catch {
                    // Fail-closed parse-hiba: korrupt snapshot blocker.
                    usedInActivePublications.push({ $id: pub.$id, name: pub.name, parseError: true });
                    if (usedInActivePublications.length >= MAX_REFERENCES_PER_SCAN) break activePubLoop;
                    continue;
                }
                if (workflowReferencesSlug(snapshot, targetSlug)) {
                    usedInActivePublications.push({ $id: pub.$id, name: pub.name });
                    if (usedInActivePublications.length >= MAX_REFERENCES_PER_SCAN) break activePubLoop;
                }
            }
            if (pubBatch.documents.length < CASCADE_BATCH_LIMIT) break;
            activePubCursor = pubBatch.documents[pubBatch.documents.length - 1].$id;
        }

        // 4c) `defaultContributors` JSON-kulcs scan — slug→userId
        //    mapping. Ha a slug ott van, az archiválás stranded
        //    JSON-t hagyna (a UI-ban már nem látható csoport, de
        //    a `defaultContributors[slug]` még a userId-t tartalmazza).
        let pubContributorCursor = null;
        pubContribLoop:
        while (true) {
            const queries = [
                sdk.Query.equal('editorialOfficeId', groupDoc.editorialOfficeId),
                sdk.Query.select(['$id', 'name', 'defaultContributors']),
                sdk.Query.limit(CASCADE_BATCH_LIMIT)
            ];
            if (pubContributorCursor) queries.push(sdk.Query.cursorAfter(pubContributorCursor));

            const pubBatch = await databases.listDocuments(env.databaseId, env.publicationsCollectionId, queries);
            if (pubBatch.documents.length === 0) break;
            for (const pub of pubBatch.documents) {
                const pubRef = contributorJsonReferencesSlug(pub.defaultContributors, targetSlug);
                if (pubRef) {
                    usedInPublications.push({
                        $id: pub.$id, name: pub.name,
                        ...(pubRef === PARSE_ERROR ? { parseError: true } : {})
                    });
                    if (usedInPublications.length >= MAX_REFERENCES_PER_SCAN) break pubContribLoop;
                }
            }
            if (pubBatch.documents.length < CASCADE_BATCH_LIMIT) break;
            pubContributorCursor = pubBatch.documents[pubBatch.documents.length - 1].$id;
        }

        // 4d) Cikkek `contributors` JSON-kulcs scan — ugyanaz a logika.
        let artCursor = null;
        artLoop:
        while (true) {
            const queries = [
                sdk.Query.equal('editorialOfficeId', groupDoc.editorialOfficeId),
                sdk.Query.select(['$id', 'name', 'contributors']),
                sdk.Query.limit(CASCADE_BATCH_LIMIT)
            ];
            if (artCursor) queries.push(sdk.Query.cursorAfter(artCursor));

            const artBatch = await databases.listDocuments(env.databaseId, env.articlesCollectionId, queries);
            if (artBatch.documents.length === 0) break;
            for (const art of artBatch.documents) {
                const artRef = contributorJsonReferencesSlug(art.contributors, targetSlug);
                if (artRef) {
                    usedInArticles.push({
                        $id: art.$id, name: art.name,
                        ...(artRef === PARSE_ERROR ? { parseError: true } : {})
                    });
                    if (usedInArticles.length >= MAX_REFERENCES_PER_SCAN) break artLoop;
                }
            }
            if (artBatch.documents.length < CASCADE_BATCH_LIMIT) break;
            artCursor = artBatch.documents[artBatch.documents.length - 1].$id;
        }

        if (
            usedInWorkflows.length > 0
            || usedInActivePublications.length > 0
            || usedInPublications.length > 0
            || usedInArticles.length > 0
        ) {
            return fail(res, 409, 'group_in_use', {
                slug: targetSlug,
                workflows: usedInWorkflows,
                activePublications: usedInActivePublications,
                publications: usedInPublications,
                articles: usedInArticles
            });
        }
    }

    // 5) Update — archivedAt set vagy null.
    const nowIso = new Date().toISOString();
    try {
        await databases.updateDocument(
            env.databaseId,
            env.groupsCollectionId,
            groupId,
            { archivedAt: isArchive ? nowIso : null }
        );
    } catch (err) {
        const isSchemaMissing =
            (err?.type === 'document_invalid_structure' || err?.code === 400)
            && /unknown attribute|archivedAt/i.test(err?.message || '');
        if (isSchemaMissing) {
            return fail(res, 422, 'schema_missing', {
                required: ['archivedAt'],
                hint: 'Futtasd: bootstrap_groups_schema'
            });
        }
        error(`[${isArchive ? 'ArchiveGroup' : 'RestoreGroup'}] updateDocument hiba (${groupId}): ${err.message}`);
        return fail(res, 500, isArchive ? 'archive_failed' : 'restore_failed');
    }

    log(`[${isArchive ? 'ArchiveGroup' : 'RestoreGroup'}] User ${callerId} ${isArchive ? 'archiválta' : 'visszaállította'} a csoportot: id=${groupId}, slug="${groupDoc.slug}"`);

    return res.json({
        success: true,
        action: isArchive ? 'archived' : 'restored',
        groupId,
        slug: groupDoc.slug,
        archivedAt: isArchive ? nowIso : null
    });
}

/**
 * ACTION='delete_group' — hard-delete + kaszkád.
 *
 * Blocking: ugyanaz a 4-utas blocker-set, mint az `archive_group`-nál.
 * Ha átmegy: groupMemberships → group → compensating sweep.
 * A.2.8 óta nincs DEFAULT_GROUPS védelem — minden csoport workflow-driven.
 */
async function deleteGroup(ctx) {
    const { databases, env, callerId, callerUser, payload, log, error, res, fail, sdk, permissionEnv, permissionContext } = ctx;
    const { groupId } = payload;
    if (!groupId) {
        return fail(res, 400, 'missing_fields', { required: ['groupId'] });
    }

    // Action-szintű env var guard — a contributor scan nélkül a data-loss
    // kockázat valós, ezért a publications + articles collection ID-k
    // kötelezőek. Ha nincsenek beállítva, a Console admin figyelmeztetést
    // kap és a törlés blokkolódik.
    const missingForDelete = [];
    if (!env.publicationsCollectionId) missingForDelete.push('PUBLICATIONS_COLLECTION_ID');
    if (!env.articlesCollectionId) missingForDelete.push('ARTICLES_COLLECTION_ID');
    if (missingForDelete.length > 0) {
        error(`[DeleteGroup] Hiányzó env var(ok): ${missingForDelete.join(', ')}`);
        return fail(res, 500, 'misconfigured', { missing: missingForDelete });
    }

    // 1) Group lookup
    let groupDoc;
    try {
        groupDoc = await databases.getDocument(env.databaseId, env.groupsCollectionId, groupId);
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'group_not_found');
        error(`[DeleteGroup] group fetch hiba: ${err.message}`);
        return fail(res, 500, 'group_fetch_failed');
    }

    // 2) A.3.6 — `group.delete` office-scope permission guard.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'group.delete',
        groupDoc.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'group.delete',
            scope: 'office'
        });
    }

    // 3) Workflow hivatkozás ellenőrzés — az **org összes nem-archivált
    //    workflow-ja** (org-scope workflow office-on kívülről is hivatkoz-
    //    hat), compiled JSON-ban a slug string-keresés. A loop csak akkor
    //    áll le, ha (a) nincs több lap, (b) elértük a MAX_REFERENCES_PER_SCAN
    //    cap-et. A scan teljessége data-loss kritikus.
    const usedInWorkflows = [];
    const targetSlug = groupDoc.slug;
    let cursor = null;
    workflowLoop:
    while (true) {
        const queries = [
            sdk.Query.equal('organizationId', groupDoc.organizationId),
            sdk.Query.isNull('archivedAt'),
            sdk.Query.select(['$id', 'name', 'compiled', 'archivedAt']),
            sdk.Query.limit(CASCADE_BATCH_LIMIT)
        ];
        if (cursor) queries.push(sdk.Query.cursorAfter(cursor));

        let workflowBatch;
        try {
            workflowBatch = await databases.listDocuments(env.databaseId, env.workflowsCollectionId, queries);
        } catch (queryErr) {
            // Schema-safe fallback: ha az `archivedAt` mező még nem létezik,
            // az `isNull` query 400-zal bukik. Scan szűrő nélkül + manuális
            // szűrés.
            if (queryErr?.code === 400 || /unknown attribute|archivedAt/i.test(queryErr?.message || '')) {
                log(`[DeleteGroup] archivedAt mező nem elérhető — workflow scan szűrő nélkül.`);
                const fallbackQueries = [
                    sdk.Query.equal('organizationId', groupDoc.organizationId),
                    sdk.Query.select(['$id', 'name', 'compiled', 'archivedAt']),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ];
                if (cursor) fallbackQueries.push(sdk.Query.cursorAfter(cursor));
                workflowBatch = await databases.listDocuments(env.databaseId, env.workflowsCollectionId, fallbackQueries);
                workflowBatch.documents = workflowBatch.documents.filter(d => !d.archivedAt);
            } else {
                throw queryErr;
            }
        }
        if (workflowBatch.documents.length === 0) break;

        for (const wf of workflowBatch.documents) {
            if (!wf.compiled || typeof wf.compiled !== 'string') continue;
            let compiled;
            try {
                compiled = JSON.parse(wf.compiled);
            } catch {
                // Fail-closed parse-hiba: sérült workflow blocker.
                usedInWorkflows.push({ $id: wf.$id, name: wf.name, parseError: true });
                if (usedInWorkflows.length >= MAX_REFERENCES_PER_SCAN) break workflowLoop;
                continue;
            }
            if (workflowReferencesSlug(compiled, targetSlug)) {
                usedInWorkflows.push({ $id: wf.$id, name: wf.name });
                if (usedInWorkflows.length >= MAX_REFERENCES_PER_SCAN) break workflowLoop;
            }
        }

        if (workflowBatch.documents.length < CASCADE_BATCH_LIMIT) break;
        cursor = workflowBatch.documents[workflowBatch.documents.length - 1].$id;
    }

    // 3b) Aktív publikációk `compiledWorkflowSnapshot` scan — A.2.7
    // a runtime-autoritatív forrás. Ha a snapshot hivatkozza a slug-ot,
    // a futó publikáció állapot-átmenetei rajta múlhatnak.
    const usedInActivePublications = [];
    let pubCursor = null;
    activePubLoop:
    while (true) {
        const queries = [
            sdk.Query.equal('organizationId', groupDoc.organizationId),
            sdk.Query.equal('isActivated', true),
            sdk.Query.select(['$id', 'name', 'compiledWorkflowSnapshot']),
            sdk.Query.limit(CASCADE_BATCH_LIMIT)
        ];
        if (pubCursor) queries.push(sdk.Query.cursorAfter(pubCursor));

        const pubBatch = await databases.listDocuments(env.databaseId, env.publicationsCollectionId, queries);
        if (pubBatch.documents.length === 0) break;
        for (const pub of pubBatch.documents) {
            if (!pub.compiledWorkflowSnapshot || typeof pub.compiledWorkflowSnapshot !== 'string') continue;
            let snapshot;
            try {
                snapshot = JSON.parse(pub.compiledWorkflowSnapshot);
            } catch {
                // Fail-closed parse-hiba: korrupt snapshot blocker.
                usedInActivePublications.push({ $id: pub.$id, name: pub.name, parseError: true });
                if (usedInActivePublications.length >= MAX_REFERENCES_PER_SCAN) break activePubLoop;
                continue;
            }
            if (workflowReferencesSlug(snapshot, targetSlug)) {
                usedInActivePublications.push({ $id: pub.$id, name: pub.name });
                if (usedInActivePublications.length >= MAX_REFERENCES_PER_SCAN) break activePubLoop;
            }
        }
        if (pubBatch.documents.length < CASCADE_BATCH_LIMIT) break;
        pubCursor = pubBatch.documents[pubBatch.documents.length - 1].$id;
    }

    // 4) Publikációk defaultContributors scan — a slug JSON kulcsként
    //    szerepelhet. Teljes lapozás (data-loss critical), scan cap csak
    //    a már talált matchekre.
    const usedInPublications = [];
    let pubContributorCursor = null;
    pubLoop:
    while (true) {
        const queries = [
            sdk.Query.equal('editorialOfficeId', groupDoc.editorialOfficeId),
            sdk.Query.select(['$id', 'name', 'defaultContributors']),
            sdk.Query.limit(CASCADE_BATCH_LIMIT)
        ];
        if (pubContributorCursor) queries.push(sdk.Query.cursorAfter(pubContributorCursor));

        const pubBatch = await databases.listDocuments(env.databaseId, env.publicationsCollectionId, queries);
        if (pubBatch.documents.length === 0) break;

        for (const pub of pubBatch.documents) {
            const pubRef = contributorJsonReferencesSlug(pub.defaultContributors, targetSlug);
            if (pubRef) {
                usedInPublications.push({
                    $id: pub.$id, name: pub.name,
                    ...(pubRef === PARSE_ERROR ? { parseError: true } : {})
                });
                if (usedInPublications.length >= MAX_REFERENCES_PER_SCAN) break pubLoop;
            }
        }

        if (pubBatch.documents.length < CASCADE_BATCH_LIMIT) break;
        pubContributorCursor = pubBatch.documents[pubBatch.documents.length - 1].$id;
    }

    // 6) Cikkek contributors scan — ugyanez slug JSON kulcs alapján.
    //    Articles jóval több lehet, mint pub — teljes scan + cap a
    //    memória- és response-time védelemre.
    const usedInArticles = [];
    let artCursor = null;
    artLoop:
    while (true) {
        const queries = [
            sdk.Query.equal('editorialOfficeId', groupDoc.editorialOfficeId),
            sdk.Query.select(['$id', 'name', 'contributors']),
            sdk.Query.limit(CASCADE_BATCH_LIMIT)
        ];
        if (artCursor) queries.push(sdk.Query.cursorAfter(artCursor));

        const artBatch = await databases.listDocuments(env.databaseId, env.articlesCollectionId, queries);
        if (artBatch.documents.length === 0) break;

        for (const art of artBatch.documents) {
            const artRef = contributorJsonReferencesSlug(art.contributors, targetSlug);
            if (artRef) {
                usedInArticles.push({
                    $id: art.$id, name: art.name,
                    ...(artRef === PARSE_ERROR ? { parseError: true } : {})
                });
                if (usedInArticles.length >= MAX_REFERENCES_PER_SCAN) break artLoop;
            }
        }

        if (artBatch.documents.length < CASCADE_BATCH_LIMIT) break;
        artCursor = artBatch.documents[artBatch.documents.length - 1].$id;
    }

    if (
        usedInWorkflows.length > 0
        || usedInActivePublications.length > 0
        || usedInPublications.length > 0
        || usedInArticles.length > 0
    ) {
        return fail(res, 409, 'group_in_use', {
            slug: targetSlug,
            workflows: usedInWorkflows,
            activePublications: usedInActivePublications,
            publications: usedInPublications,
            articles: usedInArticles
        });
    }

    // 7) Kaszkád törlés — groupMemberships
    let deletedMemberships = 0;
    try {
        const cascadeResult = await deleteByQuery(
            databases,
            env.databaseId,
            env.groupMembershipsCollectionId,
            'groupId',
            groupId
        );
        deletedMemberships = cascadeResult.deleted;
    } catch (err) {
        error(`[DeleteGroup] groupMemberships kaszkád hiba (group=${groupId}): ${err.message}`);
        return fail(res, 500, 'cascade_delete_failed');
    }

    // 8) Group törlés
    try {
        await databases.deleteDocument(env.databaseId, env.groupsCollectionId, groupId);
    } catch (err) {
        error(`[DeleteGroup] group delete hiba: ${err.message}`);
        return fail(res, 500, 'delete_failed');
    }

    // 9) Compensating sweep — add_group_member race védelem.
    //    Az add_group_member flow előbb megy végig a validáción (group
    //    létezik) majd később hozza létre a membership-et; a két hívás
    //    között a delete_group befejezheti a cascade-et. Ilyen orphan
    //    membership-et itt kitakarítjuk, mielőtt success-t adunk vissza.
    //    Nem blokkoló: ha a sweep elbukik, a csoport már törölve.
    let orphanCleaned = 0;
    try {
        const sweepResult = await deleteByQuery(
            databases,
            env.databaseId,
            env.groupMembershipsCollectionId,
            'groupId',
            groupId
        );
        orphanCleaned = sweepResult.deleted;
        if (orphanCleaned > 0) {
            log(`[DeleteGroup] Compensating sweep: ${orphanCleaned} orphan membership törölve race miatt (group=${groupId}).`);
        }
    } catch (err) {
        error(`[DeleteGroup] compensating sweep hiba (nem blokkoló, group=${groupId}): ${err.message}`);
    }

    log(`[DeleteGroup] User ${callerId} törölte "${groupDoc.name}" (${targetSlug}) csoportot (memberships=${deletedMemberships + orphanCleaned})`);

    return res.json({
        success: true,
        action: 'deleted',
        groupId,
        deletedMemberships: deletedMemberships + orphanCleaned
    });
}

module.exports = {
    addGroupMember,
    removeGroupMember,
    createGroup,
    updateGroupMetadata,
    archiveOrRestoreGroup,
    deleteGroup
};
