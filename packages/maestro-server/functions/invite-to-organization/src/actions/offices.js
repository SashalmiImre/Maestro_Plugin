// B.0.3.g (2026-05-04) — Editorial office action-ok kiszervezve külön modulba.
// Tartalmazza: leave_organization (caller saját kilépése — minden membership-
// cleanup logika itt él egy helyen), create_editorial_office,
// update_editorial_office, delete_editorial_office.

const crypto = require('crypto');
const {
    NAME_MAX_LENGTH,
    SLUG_MAX_LENGTH,
    sanitizeString,
    slugifyName
} = require('../helpers/util.js');
const {
    CASCADE_BATCH_LIMIT,
    WORKFLOW_VISIBILITY_DEFAULT
} = require('../helpers/constants.js');
const { cascadeDeleteOffice } = require('../helpers/cascade.js');
const { seedDefaultPermissionSets } = require('../helpers/groupSeed.js');
const { createWorkflowDoc } = require('../helpers/workflowDoc.js');
const {
    buildOfficeTeamId,
    buildOrgTeamId,
    buildOfficeAclPerms,
    buildWorkflowAclPerms,
    ensureTeam,
    ensureTeamMembership,
    removeTeamMembership,
    deleteTeamIfExists
} = require('../teamHelpers.js');
const permissions = require('../permissions.js');

/**
 * ACTION='leave_organization' (#41).
 *
 * Caller saját kilépése egy szervezetből. A teljes scope-takarítás a caller
 * saját rekordjaira korlátozott:
 *   - organizationMemberships (a caller 1 doca az adott orgban)
 *   - editorialOfficeMemberships (a caller minden office-tagsága az org alatt)
 *   - groupMemberships (a caller minden csoporttagsága az org-on belül)
 *   - Appwrite Team membership-ek (`org_${orgId}` + per-office)
 *
 * Last-owner blokk: `last_owner_block` ha van más tag, `last_member_block`
 * ha caller az egyedüli (UI a delete_organization flow-t kínálja).
 *
 * STRICT team cleanup: a DB delete ELŐTT, hogy a Realtime push-csatornák
 * azonnal záródjanak (ghost ACL access elkerülése).
 */
async function leaveOrganization(ctx) {
    const { databases, env, callerId, payload, error, res, fail, sdk, log, teamsApi } = ctx;
    const { organizationId } = payload;
    if (!organizationId || typeof organizationId !== 'string') {
        return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
    }

    // 1) Caller org membership lekérése — kötelező.
    let callerMembership;
    try {
        const result = await databases.listDocuments(
            env.databaseId,
            env.membershipsCollectionId,
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
                env.databaseId,
                env.membershipsCollectionId,
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
                    env.databaseId,
                    env.membershipsCollectionId,
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
            resp = await databases.listDocuments(env.databaseId, env.officesCollectionId, queries);
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
                env.databaseId,
                env.officeMembershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('userId', callerId),
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
                env.databaseId,
                env.groupMembershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('userId', callerId),
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
            env.databaseId,
            env.membershipsCollectionId,
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

/**
 * ACTION='create_editorial_office'.
 *
 * Új szerkesztőség létrehozása egy meglévő szervezeten belül.
 * A `bootstrap_organization` 3-7. lépéseit replikálja:
 *   - office doc + officeMembership admin role
 *   - default permission set seed (A.3.2)
 *   - opcionális workflow klón
 *
 * Caller: a szervezet `owner` vagy `admin` role-lal rendelkező tagja.
 * **A.3.6 tudatos kivétel**: az `office.create` slug az ADR taxonómiájában
 * office-scope-ba tartozna, de az új office még nem létezik — a régi
 * org-role check logikailag ekvivalens (Codex 2026-05-02 strategy review).
 *
 * Rollback (LIFO): minden lépés hibája esetén a korábbi rekordokat
 * best-effort visszatöröljük.
 */
async function createEditorialOffice(ctx) {
    const { databases, env, callerId, payload, error, res, fail, sdk, log, teamsApi } = ctx;
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
        env.databaseId,
        env.membershipsCollectionId,
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
                env.databaseId,
                env.workflowsCollectionId,
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
                env.databaseId,
                env.officesCollectionId,
                sdk.ID.unique(),
                {
                    organizationId,
                    name: sanitizedName,
                    slug: candidateSlug
                }
            );
            newOfficeId = officeDoc.$id;
            usedSlug = candidateSlug;
            rollbackSteps.push(() => databases.deleteDocument(env.databaseId, env.officesCollectionId, newOfficeId));
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
            env.databaseId,
            env.officeMembershipsCollectionId,
            sdk.ID.unique(),
            {
                editorialOfficeId: newOfficeId,
                organizationId,
                userId: callerId,
                role: 'admin'
            }
        );
        newOfficeMembershipId = memDoc.$id;
        rollbackSteps.push(() => databases.deleteDocument(env.databaseId, env.officeMembershipsCollectionId, newOfficeMembershipId));
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
        { databaseId: env.databaseId, permissionSetsCollectionId: env.permissionSetsCollectionId },
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
                env.databaseId,
                env.workflowsCollectionId,
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
                env.databaseId,
                env.officesCollectionId,
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

/**
 * ACTION='update_editorial_office' — szerkesztőség átnevezése.
 *
 * A slug változatlan marad (cikk/publikáció nem hivatkozik rá). Uniqueness:
 * ugyanazon org-on belül nem lehet két azonos `name` (case-distinct OK,
 * a UI látja a pontos ütközést). Auth: `office.rename` (A.3.6).
 */
async function updateEditorialOffice(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
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
            env.databaseId,
            env.officesCollectionId,
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
            env.databaseId,
            env.officesCollectionId,
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
            env.databaseId,
            env.officesCollectionId,
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

/**
 * ACTION='delete_editorial_office' (Fázis 8).
 *
 * Szerkesztőség kaszkád törlés: publications (→ cascade-delete CF takarítja
 * az articles/layouts/deadlines-t), workflows, groups, groupMemberships,
 * editorialOfficeMemberships, majd maga az office.
 *
 * Auth: `office.delete` office-scope (A.3.6). Fail-closed: ha bármely gyerek
 * cleanup-lépés elhasal, az office dokumentumot NEM töröljük.
 */
async function deleteEditorialOffice(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, log, teamsApi, permissionEnv, permissionContext } = ctx;

    // Delete action-szintű env var guard — a PUBLICATIONS_COLLECTION_ID
    // csak ehhez az action-höz kell, ne blokkolja a többi flow-t.
    if (!env.publicationsCollectionId) {
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
            env.databaseId,
            env.officesCollectionId,
            editorialOfficeId
        );
    } catch (fetchErr) {
        if (fetchErr.code === 404) return fail(res, 404, 'office_not_found');
        error(`[DeleteOffice] getDocument hiba: ${fetchErr.message}`);
        return fail(res, 500, 'office_fetch_failed');
    }

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
        databaseId: env.databaseId,
        publicationsCollectionId: env.publicationsCollectionId,
        workflowsCollectionId: env.workflowsCollectionId,
        groupsCollectionId: env.groupsCollectionId,
        groupMembershipsCollectionId: env.groupMembershipsCollectionId,
        officeMembershipsCollectionId: env.officeMembershipsCollectionId
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
        await databases.deleteDocument(env.databaseId, env.officesCollectionId, editorialOfficeId);
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

module.exports = {
    leaveOrganization,
    createEditorialOffice,
    updateEditorialOffice,
    deleteEditorialOffice
};
