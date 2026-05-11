// B.0.3.a (2026-05-04) — Schema bootstrap action-ok kiszervezve külön modulba.
// A 4 `bootstrap_*_schema` action + a `backfill_tenant_acl` migrációs action
// CommonJS modulként él itt. A komment-anyag és a logika 1:1-ben átkerült a
// `main.js`-ből, csak a változó-források cseréltek (a globális zárolt scope
// helyett a handler `ctx` paraméterében kapja meg minden függőségét).
//
// Tilos import-irány: `actions/*` → `helpers/*` → `permissions.js` /
// `teamHelpers.js`. Visszafelé NEM (CommonJS ciklikus require csendben
// fél-inicializált exports-ot ad).

const {
    WORKFLOW_VISIBILITY_VALUES,
    WORKFLOW_VISIBILITY_DEFAULT,
    CASCADE_BATCH_LIMIT,
    EXTENSION_KIND_VALUES,
    EXTENSION_SCOPE_VALUES,
    EXTENSION_SCOPE_DEFAULT
} = require('../helpers/constants.js');
const {
    buildOrgTeamId,
    buildOrgAdminTeamId,
    buildOfficeTeamId,
    buildOrgAclPerms,
    buildOrgAdminAclPerms,
    buildOfficeAclPerms,
    ensureTeam,
    ensureTeamMembership
} = require('../teamHelpers.js');
const {
    isAlreadyExists,
    requireOwnerAnywhere,
    fetchUserIdentity
} = require('../helpers/util.js');
const {
    listAllByQuery,
    paginateByQuery
} = require('../helpers/pagination.js');

/**
 * ACTION='bootstrap_workflow_schema' (#30 + #80) — owner-only schema-bővítés
 * a `workflows` collectionön: `visibility` enum, `createdBy`, `description`,
 * `archivedAt` + 2 fulltext index. Idempotens (409 → skip).
 */
async function bootstrapWorkflowSchema(ctx) {
    const { databases, env, callerId, log, error, res, fail } = ctx;

    // 1. Caller legalább egy org owner-e (single-source helper, B.1 simplify pass).
    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    const created = [];
    const updated = [];
    const skipped = [];
    const indexesPending = [];

    // 2. visibility enum attribútum.
    // Appwrite 1.9+: a `required=true` és `default` kombináció
    // hibát dob (`attribute_default_unsupported`). `required=false`
    // + default → új doc explicit vagy default értéket kap,
    // legacy row-ok null-ja a consumer fallback-en át `editorial_office`.
    // Ha már létezik (#30 deploy), updateEnumAttribute-tal bővítjük a
    // `public` értékkel (Feladat #80). Ha az Appwrite nem engedi
    // (pl. deprecated method), a user a Console-ban bővíti.
    try {
        await databases.createEnumAttribute(
            env.databaseId,
            env.workflowsCollectionId,
            'visibility',
            WORKFLOW_VISIBILITY_VALUES,
            false,                         // required
            WORKFLOW_VISIBILITY_DEFAULT,   // default
            false                          // array
        );
        created.push('visibility');
    } catch (err) {
        if (isAlreadyExists(err)) {
            // Már létezik — próbáljuk bővíteni a `public` értékkel (#80).
            try {
                await databases.updateEnumAttribute(
                    env.databaseId,
                    env.workflowsCollectionId,
                    'visibility',
                    WORKFLOW_VISIBILITY_VALUES,
                    false,
                    WORKFLOW_VISIBILITY_DEFAULT
                );
                updated.push('visibility(public added)');
            } catch (updateErr) {
                // Nem halálos: a user manuálisan bővítheti a Console-on.
                const msg = updateErr?.message || String(updateErr);
                log(`[BootstrapWorkflowSchema] visibility update nem ment: ${msg} — Console-ban bővítsd a 'public' értékkel.`);
                skipped.push(`visibility (update_failed: ${msg})`);
            }
        } else {
            error(`[BootstrapWorkflowSchema] visibility létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_visibility_failed', { error: err.message });
        }
    }

    // 3. createdBy string attribútum (user $id = 36 char)
    try {
        await databases.createStringAttribute(
            env.databaseId,
            env.workflowsCollectionId,
            'createdBy',
            36,                            // size
            false,                         // required — legacy row-okon null
            null,                          // default
            false                          // array
        );
        created.push('createdBy');
    } catch (err) {
        if (isAlreadyExists(err)) {
            skipped.push('createdBy');
        } else {
            error(`[BootstrapWorkflowSchema] createdBy létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_createdby_failed', { error: err.message });
        }
    }

    // 4. #80 — description string attribútum (szabadszavas keresőhöz
    // fulltext indexelt, max 500 char — egy-két mondatos workflow
    // leírás, hosszabb szöveg más mezőkbe).
    try {
        await databases.createStringAttribute(
            env.databaseId,
            env.workflowsCollectionId,
            'description',
            500,                           // size
            false,                         // required
            null,                          // default
            false                          // array
        );
        created.push('description');
    } catch (err) {
        if (isAlreadyExists(err)) {
            skipped.push('description');
        } else {
            error(`[BootstrapWorkflowSchema] description létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_description_failed', { error: err.message });
        }
    }

    // 5. #80 — archivedAt datetime attribútum (soft-delete marker).
    // Null → aktív workflow, nem-null → archivált (N napos türelmi
    // idő, lásd Feladatok.md #81 cron hard-delete).
    try {
        await databases.createDatetimeAttribute(
            env.databaseId,
            env.workflowsCollectionId,
            'archivedAt',
            false,                         // required
            null,                          // default
            false                          // array
        );
        created.push('archivedAt');
    } catch (err) {
        if (isAlreadyExists(err)) {
            skipped.push('archivedAt');
        } else {
            error(`[BootstrapWorkflowSchema] archivedAt létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_archivedat_failed', { error: err.message });
        }
    }

    // 6. #80 — fulltext indexek a szabadszavas kereséshez (name +
    // description). Appwrite egyetlen fulltext indexben csak egy
    // attribute-ot támogat, ezért külön-külön. Ha az attribute még
    // nem `available` (aszinkron processing), az index létrehozás
    // 400-at/409-et ad — a user futtassa újra az action-t 10s múlva.
    const fulltextIndexes = [
        { key: 'name_fulltext', attr: 'name' },
        { key: 'description_fulltext', attr: 'description' }
    ];
    for (const { key, attr } of fulltextIndexes) {
        try {
            await databases.createIndex(
                env.databaseId,
                env.workflowsCollectionId,
                key,
                'fulltext',
                [attr]
            );
            created.push(`index:${key}`);
        } catch (err) {
            const msg = err?.message || '';
            if (isAlreadyExists(err)) {
                skipped.push(`index:${key}`);
            } else if (err?.code === 400 && /not available|processing|unknown attribute/i.test(msg)) {
                // Attribute még nem elérhető — a user futtassa újra az action-t.
                // (Korábbi `||` elírás minden 400-as hibát erre az ágra terelt —
                // az érvénytelen index név / inkompatibilis attr-típus stb.
                // hibákat is csendben elnyelte. 2026-05-04 fix: a 3 sibling
                // action-nel egyező `&&` szigorúbb feltétel.)
                indexesPending.push(key);
            } else {
                error(`[BootstrapWorkflowSchema] index:${key} létrehozás hiba: ${err.message}`);
                return fail(res, 500, 'schema_index_failed', { index: key, error: err.message });
            }
        }
    }

    log(`[BootstrapWorkflowSchema] User ${callerId}: created=[${created.join(',')}] updated=[${updated.join(',')}] skipped=[${skipped.join(',')}] indexesPending=[${indexesPending.join(',')}]`);

    const note = indexesPending.length > 0
        ? `Az attribútumok feldolgozása ~5-10s. Futtasd újra az action-t amíg az indexesPending lista kiürül. A create_workflow hívás előtt várj, amíg a visibility + description + archivedAt available státuszú.`
        : 'Az attribútumok feldolgozása ~5-10s. Várj a create_workflow hívás előtt.';

    return res.json({
        success: true,
        created,
        updated,
        skipped,
        indexesPending,
        note
    });
}

/**
 * ACTION='bootstrap_publication_schema' (#36 + B.3.3 + 2026-05-07 retrofit) —
 * owner-only schema-bővítés a `publications` collectionön:
 *   - `compiledWorkflowSnapshot` és `compiledExtensionSnapshot` (string ~1 MB,
 *     nullable). Aktiváláskor a workflow `compiled` JSON pillanatképét +
 *     a workflow által hivatkozott extension-ök kódját tároljuk — onnantól
 *     a publikáció élete a snapshoton fut.
 *   - `modifiedByClientId` (string 36, nullable). A CF create/update
 *     write-path (A.2.10 atomic, A.2.3 assign, B.3.3 activate) ezt a mezőt
 *     ÍRJA, a `validate-publication-update` CF a SERVER_GUARD pattern-hez
 *     OLVASSA. Az attribútum a `articles` collection-en már létezik
 *     ugyanezekkel a paraméterekkel — drift-fix a `publications`-re,
 *     mert a Console-ban manuálisan létrehozott séma kimaradt.
 *
 * Manuálisan triggerelendő (curl vagy Console). Idempotens.
 */
async function bootstrapPublicationSchema(ctx) {
    const { databases, env, callerId, log, error, res, fail } = ctx;

    // 1. Caller legalább egy org owner-e (single-source helper, B.1 simplify pass).
    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    // 2. publicationsCollectionId env var kötelező
    if (!env.publicationsCollectionId) {
        return fail(res, 500, 'misconfigured', {
            missing: ['PUBLICATIONS_COLLECTION_ID']
        });
    }

    const created = [];
    const skipped = [];

    // 3. compiledWorkflowSnapshot + compiledExtensionSnapshot string attribútumok.
    // Size: 1_000_000 char (~1 MB). A workflows.compiled jelenlegi mérete
    // ~12 KB (8 állapotos default workflow); a sapka bőven fedi a bővítést.
    // Az extension-snapshot tipikus mérete 5-50 KB × workflow által hivatkozott
    // extension count; a CF write-path egy szigorúbb operatív cap-et tesz
    // (`EXTENSION_SNAPSHOT_MAX_BYTES = 800 KB`, lásd actions/publications.js).
    // Nullable mindkettő — legacy aktivált publikációkon null marad.
    const snapshotAttrs = [
        // #36 — workflow snapshot (Phase 5)
        { name: 'compiledWorkflowSnapshot' },
        // B.3.3 (ADR 0007 Phase 0, 2026-05-04) — extension snapshot
        { name: 'compiledExtensionSnapshot' }
    ];

    for (const attr of snapshotAttrs) {
        try {
            await databases.createStringAttribute(
                env.databaseId,
                env.publicationsCollectionId,
                attr.name,
                1000000,                       // size (~1 MB)
                false,                         // required
                null,                          // default
                false                          // array
            );
            created.push(attr.name);
        } catch (err) {
            if (isAlreadyExists(err)) {
                skipped.push(attr.name);
            } else {
                error(`[BootstrapPublicationSchema] ${attr.name} létrehozás hiba: ${err.message}`);
                return fail(res, 500, 'schema_snapshot_failed', {
                    attribute: attr.name,
                    error: err.message
                });
            }
        }
    }

    // 4. modifiedByClientId — string(36), nullable. A CF write-path (A.2.10
    //    atomic create, A.2.3 assign, B.3.3 activate) explicit beírja a
    //    `callerId`-t (vagy SERVER_GUARD_ID-t a guard-flow-kban), és a
    //    `validate-publication-update` Realtime-event handler erre alapoz
    //    a self-echo szűréshez + szerver-oldali write detektáláshoz.
    //    Drift-fix: a `articles`-en 2026-01-30 óta megvan, a `publications`-en
    //    a manuális Console séma kihagyta — emiatt új publikáció create
    //    `Invalid document structure: Unknown attribute "modifiedByClientId"`
    //    500-as hibát adott (2026-05-07).
    try {
        await databases.createStringAttribute(
            env.databaseId,
            env.publicationsCollectionId,
            'modifiedByClientId',
            36,                                // size (Appwrite user $id)
            false,                             // required
            null,                              // default
            false                              // array
        );
        created.push('modifiedByClientId');
    } catch (err) {
        if (isAlreadyExists(err)) {
            skipped.push('modifiedByClientId');
        } else {
            error(`[BootstrapPublicationSchema] modifiedByClientId létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_modified_by_client_failed', {
                attribute: 'modifiedByClientId',
                error: err.message
            });
        }
    }

    log(`[BootstrapPublicationSchema] User ${callerId}: created=[${created.join(',')}] skipped=[${skipped.join(',')}]`);

    return res.json({
        success: true,
        created,
        skipped,
        note: 'Az attribútumok feldolgozása ~5-10s. Várj a publikáció aktiválás előtt.'
    });
}

/**
 * ACTION='bootstrap_groups_schema' (A.2.6 / A.2.7) — owner-only schema-bővítés
 * a `groups` collectionön: `description`, `color`, `isContributorGroup`,
 * `isLeaderGroup`, `archivedAt` + `office_slug_unique` index. Idempotens.
 * Ha az `update_group_metadata` action `schema_missing` errort ad, ezt kell
 * egyszer manuálisan futtatni.
 */
async function bootstrapGroupsSchema(ctx) {
    const { databases, env, callerId, log, error, res, fail } = ctx;

    // 1. Caller legalább egy org owner-e (single-source helper, B.1 simplify pass).
    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    const created = [];
    const skipped = [];

    // 2. description string attr (max 500 char, nullable)
    try {
        await databases.createStringAttribute(
            env.databaseId,
            env.groupsCollectionId,
            'description',
            500,
            false,
            null,
            false
        );
        created.push('description');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('description');
        else {
            error(`[BootstrapGroupsSchema] description létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_description_failed', { error: err.message });
        }
    }

    // 3. color string attr (max 9 char: #rrggbbaa hex), nullable
    try {
        await databases.createStringAttribute(
            env.databaseId,
            env.groupsCollectionId,
            'color',
            9,
            false,
            null,
            false
        );
        created.push('color');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('color');
        else {
            error(`[BootstrapGroupsSchema] color létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_color_failed', { error: err.message });
        }
    }

    // 4. isContributorGroup boolean attr — false default (legacy
    // csoportokon nincs érték; a workflow autoseed flag-et ad).
    try {
        await databases.createBooleanAttribute(
            env.databaseId,
            env.groupsCollectionId,
            'isContributorGroup',
            false,
            false,
            false
        );
        created.push('isContributorGroup');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('isContributorGroup');
        else {
            error(`[BootstrapGroupsSchema] isContributorGroup létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_iscontributor_failed', { error: err.message });
        }
    }

    // 5. isLeaderGroup boolean attr
    try {
        await databases.createBooleanAttribute(
            env.databaseId,
            env.groupsCollectionId,
            'isLeaderGroup',
            false,
            false,
            false
        );
        created.push('isLeaderGroup');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('isLeaderGroup');
        else {
            error(`[BootstrapGroupsSchema] isLeaderGroup létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_isleader_failed', { error: err.message });
        }
    }

    // 6. archivedAt datetime attr — soft-delete marker az `archive_group`
    // action-höz. Null = aktív, nem-null = archivált.
    try {
        await databases.createDatetimeAttribute(
            env.databaseId,
            env.groupsCollectionId,
            'archivedAt',
            false,
            null,
            false
        );
        created.push('archivedAt');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('archivedAt');
        else {
            error(`[BootstrapGroupsSchema] archivedAt létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_archivedat_failed', { error: err.message });
        }
    }

    // 7. (office_slug_unique) — A.2.2/A.2.3 előfeltétel. Az autoseed
    // (`seedGroupsFromWorkflow`) `document_already_exists` skip-pe
    // CSAK akkor véd duplikátum ellen, ha a DB-ben tényleges unique
    // index van az `(editorialOfficeId, slug)` páron. Ezt eddig csak
    // a `_docs/workflow-designer/DATA_MODEL.md` dokumentálta — most
    // a CF kötelezően létrehozza, hogy a két paralel autoseed ne
    // hozhasson létre `editors`-t kétszer ugyanabban az office-ban.
    //
    // Az index létrehozása aszinkron — első futáson 400 `not available`
    // lehet, ha a `slug` attr még processing-ben van. A `pending` lista
    // erre jelez, a user retry-ol.
    const indexesPending = [];
    try {
        await databases.createIndex(
            env.databaseId,
            env.groupsCollectionId,
            'office_slug_unique',
            'unique',
            ['editorialOfficeId', 'slug']
        );
        created.push('index:office_slug_unique');
    } catch (err) {
        const msg = err?.message || '';
        if (isAlreadyExists(err)) {
            skipped.push('index:office_slug_unique');
        } else if (err?.code === 400 && /not available|processing|unknown attribute/i.test(msg)) {
            indexesPending.push('office_slug_unique');
        } else {
            error(`[BootstrapGroupsSchema] index:office_slug_unique létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_index_failed', { error: err.message });
        }
    }

    log(`[BootstrapGroupsSchema] User ${callerId}: created=[${created.join(',')}] skipped=[${skipped.join(',')}] indexesPending=[${indexesPending.join(',')}]`);

    return res.json({
        success: true,
        created,
        skipped,
        indexesPending,
        note: indexesPending.length > 0
            ? 'Az attribútumok feldolgozása ~5-10s. Futtasd újra az action-t, amíg az indexesPending lista kiürül — a unique index NÉLKÜL az autoseed duplikátum csoportot hozhat létre.'
            : 'A schema kész. A `update_group_metadata` action és az autoseed flow használhatja az új mezőket + a unique index védi a duplikátumtól.'
    });
}

/**
 * ACTION='bootstrap_permission_sets_schema' (A.1, ADR 0008) — owner-only
 * idempotens schema-create a `permissionSets` + `groupPermissionSets`
 * collectionökre. Doc-szintű ACL (`documentSecurity: true`); a Console-on
 * deploy után ellenőrizendő, hogy a `rowSecurity` flag aktív.
 */
async function bootstrapPermissionSetsSchema(ctx) {
    const { databases, env, callerId, log, error, res, fail } = ctx;

    // 1. Caller legalább egy org owner-e (single-source helper, B.1 simplify pass).
    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    // 2. Action-szintű env var guard (csak itt kötelező).
    const missingActionEnvVars = [];
    if (!env.permissionSetsCollectionId) {
        missingActionEnvVars.push('PERMISSION_SETS_COLLECTION_ID');
    }
    if (!env.groupPermissionSetsCollectionId) {
        missingActionEnvVars.push('GROUP_PERMISSION_SETS_COLLECTION_ID');
    }
    if (missingActionEnvVars.length > 0) {
        return fail(res, 500, 'misconfigured', {
            missing: missingActionEnvVars
        });
    }

    const created = [];
    const skipped = [];
    const indexesPending = [];

    // ── Lokális helperek (csak ezen az action-en belül) ──────────
    // A 3 ismétlődő boilerplate egységesítése: collection-create,
    // attribute-create-loop, index-create-loop. Az `isAlreadyExists`
    // a `helpers/util.js`-ből jön (B.1 simplify pass single-source extract).
    const ensureCollection = async (colId, label) => {
        try {
            await databases.createCollection(env.databaseId, colId, label, [], true, true);
            created.push(`collection:${label}`);
            return true;
        } catch (err) {
            if (isAlreadyExists(err)) {
                skipped.push(`collection:${label}`);
                return true;
            }
            error(`[BootstrapPermissionSetsSchema] ${label} collection létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_collection_failed', { collection: label, error: err.message });
        }
    };

    const ensureAttributes = async (colId, label, attrs) => {
        for (const attr of attrs) {
            try {
                if (attr.kind === 'datetime') {
                    await databases.createDatetimeAttribute(env.databaseId, colId, attr.name, attr.required, null, false);
                } else {
                    await databases.createStringAttribute(env.databaseId, colId, attr.name, attr.size, attr.required, null, attr.array === true);
                }
                created.push(`${label}.${attr.name}`);
            } catch (err) {
                if (isAlreadyExists(err)) {
                    skipped.push(`${label}.${attr.name}`);
                } else {
                    error(`[BootstrapPermissionSetsSchema] ${label}.${attr.name} attribútum hiba: ${err.message}`);
                    return fail(res, 500, 'schema_attribute_failed', { collection: label, attribute: attr.name, error: err.message });
                }
            }
        }
        return true;
    };

    const ensureIndexes = async (colId, label, indexes) => {
        for (const idx of indexes) {
            try {
                await databases.createIndex(env.databaseId, colId, idx.key, idx.type, idx.attrs);
                created.push(`${label}.index:${idx.key}`);
            } catch (err) {
                const msg = err?.message || '';
                if (isAlreadyExists(err)) {
                    skipped.push(`${label}.index:${idx.key}`);
                } else if (err?.code === 400 && /not available|processing|unknown attribute/i.test(msg)) {
                    // Az aszinkron attribute-feldolgozás 400-at pending-re
                    // tesszük, egyéb 400 (érvénytelen index név, inkompatibilis
                    // attribute típus stb.) propagáljon — ne nyelje el a driftet.
                    indexesPending.push(`${label}.${idx.key}`);
                } else {
                    error(`[BootstrapPermissionSetsSchema] ${label}.index:${idx.key} hiba: ${err.message}`);
                    return fail(res, 500, 'schema_index_failed', { collection: label, index: idx.key, error: err.message });
                }
            }
        }
        return true;
    };

    // ── permissionSets ──────────────────────────────────────────
    // A `permissions` egy string tömb — egy slug max 100 char
    // (`<resource>.<sub>.<action>` formátum bőven elfér). Az
    // `archivedAt` nullable (soft-delete marker).
    const permissionSetsAttrs = [
        { name: 'name',              kind: 'string',   size: 100,  required: true },
        { name: 'slug',              kind: 'string',   size: 100,  required: true },
        { name: 'description',       kind: 'string',   size: 500,  required: false },
        { name: 'permissions',       kind: 'string',   size: 100,  required: true,  array: true },
        { name: 'editorialOfficeId', kind: 'string',   size: 36,   required: true },
        { name: 'organizationId',    kind: 'string',   size: 36,   required: true },
        { name: 'archivedAt',        kind: 'datetime',             required: false },
        { name: 'createdByUserId',   kind: 'string',   size: 36,   required: false }
    ];
    // Az `office_slug_unique` egy office-on belül slug-ütközést
    // akadályoz; az `office_idx` / `org_idx` a Realtime + listing
    // query-khez kell.
    const permissionSetsIndexes = [
        { key: 'office_slug_unique', type: 'unique', attrs: ['editorialOfficeId', 'slug'] },
        { key: 'office_idx',         type: 'key',    attrs: ['editorialOfficeId'] },
        { key: 'org_idx',            type: 'key',    attrs: ['organizationId'] }
    ];

    const psCol = await ensureCollection(env.permissionSetsCollectionId, 'permissionSets');
    if (psCol !== true) return psCol;
    const psAttrs = await ensureAttributes(env.permissionSetsCollectionId, 'permissionSets', permissionSetsAttrs);
    if (psAttrs !== true) return psAttrs;
    const psIdx = await ensureIndexes(env.permissionSetsCollectionId, 'permissionSets', permissionSetsIndexes);
    if (psIdx !== true) return psIdx;

    // ── groupPermissionSets (m:n junction) ──────────────────────
    const groupPermissionSetsAttrs = [
        { name: 'groupId',           kind: 'string', size: 36, required: true },
        { name: 'permissionSetId',   kind: 'string', size: 36, required: true },
        { name: 'editorialOfficeId', kind: 'string', size: 36, required: true },
        { name: 'organizationId',    kind: 'string', size: 36, required: true }
    ];
    // A `group_set_unique` (groupId, permissionSetId) páronként egy
    // junction doc-ot enged — duplikátum-blokk. A többi index a
    // Realtime/lookup útvonalakhoz.
    const groupPermissionSetsIndexes = [
        { key: 'group_set_unique', type: 'unique', attrs: ['groupId', 'permissionSetId'] },
        { key: 'office_idx',       type: 'key',    attrs: ['editorialOfficeId'] },
        { key: 'group_idx',        type: 'key',    attrs: ['groupId'] },
        { key: 'set_idx',          type: 'key',    attrs: ['permissionSetId'] }
    ];

    const gpsCol = await ensureCollection(env.groupPermissionSetsCollectionId, 'groupPermissionSets');
    if (gpsCol !== true) return gpsCol;
    const gpsAttrs = await ensureAttributes(env.groupPermissionSetsCollectionId, 'groupPermissionSets', groupPermissionSetsAttrs);
    if (gpsAttrs !== true) return gpsAttrs;
    const gpsIdx = await ensureIndexes(env.groupPermissionSetsCollectionId, 'groupPermissionSets', groupPermissionSetsIndexes);
    if (gpsIdx !== true) return gpsIdx;

    log(`[BootstrapPermissionSetsSchema] User ${callerId}: created=[${created.join(',')}] skipped=[${skipped.join(',')}] indexesPending=[${indexesPending.join(',')}]`);

    const note = indexesPending.length > 0
        ? 'Az attribútumok feldolgozása ~5-10s. Futtasd újra az action-t amíg az indexesPending lista kiürül.'
        : 'A schema kész. A.3.2-A.3.5 implementálva: bootstrap_organization + create_editorial_office automatikusan seedeli a default permission set-eket. CRUD action-ök (create_permission_set, update_permission_set, archive/restore_permission_set, assign/unassign_permission_set_to_group) elérhetőek. Következő lépés (A.3.6, külön commit): meglévő CF guardok lecserélése userHasPermission()-re.';

    return res.json({
        success: true,
        created,
        skipped,
        indexesPending,
        note
    });
}

/**
 * ACTION='bootstrap_workflow_extension_schema' (B.1.1, ADR 0007 Phase 0) —
 * owner-only idempotens schema-create a `workflowExtensions` collectionre.
 * Doc-szintű ACL (`documentSecurity: true`); a Console-on deploy után
 * ellenőrizendő, hogy a `rowSecurity` flag aktív (különben a doc-szintű
 * `buildExtensionAclPerms()` ACL nem érvényesül a Realtime push-on).
 *
 * Phase 0 hatókör-szűkítés (B.0.4): a `paramSchema` mező SZÁNDÉKOSAN
 * kimaradt — a Phase 0 MVP nem támogat per-workflow extension-paraméter-
 * átadást, az ExtendScript `code` önálló logikát kódol kötött I/O
 * kontraktussal. A mező a Phase 1+ schema-frissítésben jön (additive,
 * "nincs migráció" alapelv).
 */
async function bootstrapWorkflowExtensionSchema(ctx) {
    const { databases, env, callerId, log, error, res, fail } = ctx;

    // 1. Caller legalább egy org owner-e (single-source helper, B.1 simplify pass).
    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    // 2. Action-szintű env var guard. A `WORKFLOW_EXTENSIONS_COLLECTION_ID`
    // Phase 0-ban CSAK ennél az action-nél kötelező — a B.3 új CRUD
    // action-jeinek érkezésekor a `main.js` globális fail-fast-ba emeli
    // (a `PERMISSION_SETS_COLLECTION_ID` evolúciójának mintájára, A.3.6).
    if (!env.workflowExtensionsCollectionId) {
        return fail(res, 500, 'misconfigured', {
            missing: ['WORKFLOW_EXTENSIONS_COLLECTION_ID']
        });
    }

    const created = [];
    const skipped = [];
    const indexesPending = [];

    // 3. Collection idempotens létrehozása `documentSecurity: true` flag-gel.
    // Pattern: `bootstrapPermissionSetsSchema` (A.1) — collection-szintű
    // perms üres, doc-szintű team ACL ad olvasási jogot
    // (`buildExtensionAclPerms`).
    try {
        await databases.createCollection(
            env.databaseId,
            env.workflowExtensionsCollectionId,
            'workflowExtensions',
            [],
            true,   // documentSecurity
            true    // enabled
        );
        created.push('collection:workflowExtensions');
    } catch (err) {
        if (isAlreadyExists(err)) {
            skipped.push('collection:workflowExtensions');
        } else {
            error(`[BootstrapWorkflowExtensionSchema] collection létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_collection_failed', { error: err.message });
        }
    }

    // 4. Attribútumok. A `name` 100 char (UI-ban látszik); a `slug` 64 char
    // (`ext.<slug>` hivatkozás a workflow JSON-ban); a `code` 1_000_000 char
    // (~1 MB, az ExtendScript forrás bőven elfér — tipikus 5-50 KB).
    // Az `archivedAt` nullable (soft-delete marker, a meglévő workflow-k
    // mintája). A `paramSchema` SZÁNDÉKOSAN kimaradt (B.0.1 / B.0.4).
    // A `scope` enum Phase 0-ban CSAK `['article']` (fail-closed séma); a
    // Phase 1+ `publication` érték utólagos `updateEnumAttribute`-tal kerül be,
    // a `bootstrap_workflow_schema` `public` visibility late-add mintáját
    // követve (Codex adversarial review B.1 2026-05-04 Medium fix).
    const extensionAttrs = [
        { name: 'name',              kind: 'string',   size: 100,  required: true },
        { name: 'slug',              kind: 'string',   size: 64,   required: true },
        { name: 'kind',              kind: 'enum',     values: EXTENSION_KIND_VALUES,     required: true,  default: null },
        { name: 'scope',             kind: 'enum',     values: EXTENSION_SCOPE_VALUES,    required: false, default: EXTENSION_SCOPE_DEFAULT },
        { name: 'code',              kind: 'string',   size: 1_000_000, required: true },
        { name: 'visibility',        kind: 'enum',     values: WORKFLOW_VISIBILITY_VALUES, required: false, default: WORKFLOW_VISIBILITY_DEFAULT },
        { name: 'archivedAt',        kind: 'datetime', required: false },
        { name: 'editorialOfficeId', kind: 'string',   size: 36,   required: true },
        { name: 'organizationId',    kind: 'string',   size: 36,   required: true },
        { name: 'createdByUserId',   kind: 'string',   size: 36,   required: false }
    ];

    for (const attr of extensionAttrs) {
        try {
            if (attr.kind === 'datetime') {
                await databases.createDatetimeAttribute(
                    env.databaseId, env.workflowExtensionsCollectionId,
                    attr.name, attr.required, null, false
                );
            } else if (attr.kind === 'enum') {
                // Appwrite 1.9+: `required=true` + `default` kombináció
                // hibát dob (`attribute_default_unsupported`). A `kind`
                // mezőnél (required: true) ezért default=null;
                // a `scope` és `visibility` (required: false) kap default-ot.
                await databases.createEnumAttribute(
                    env.databaseId, env.workflowExtensionsCollectionId,
                    attr.name, attr.values, attr.required,
                    attr.default ?? null, false
                );
            } else {
                await databases.createStringAttribute(
                    env.databaseId, env.workflowExtensionsCollectionId,
                    attr.name, attr.size, attr.required, null, false
                );
            }
            created.push(`workflowExtensions.${attr.name}`);
        } catch (err) {
            if (isAlreadyExists(err)) {
                skipped.push(`workflowExtensions.${attr.name}`);
            } else {
                error(`[BootstrapWorkflowExtensionSchema] ${attr.name} attribútum hiba: ${err.message}`);
                return fail(res, 500, 'schema_attribute_failed', {
                    attribute: attr.name, error: err.message
                });
            }
        }
    }

    // 5. Indexek. Az `office_slug_unique` az autoseed/duplikátum-blokkhoz
    // (a workflow `ext.<slug>` resolverje office-szűkített Phase 0-ban,
    // ezért az office-szintű uniqueness elegendő). A `office_idx` és
    // `org_idx` a Realtime + listing query-khez szükséges.
    const extensionIndexes = [
        { key: 'office_slug_unique', type: 'unique', attrs: ['editorialOfficeId', 'slug'] },
        { key: 'office_idx',         type: 'key',    attrs: ['editorialOfficeId'] },
        { key: 'org_idx',            type: 'key',    attrs: ['organizationId'] }
    ];

    for (const idx of extensionIndexes) {
        try {
            await databases.createIndex(
                env.databaseId, env.workflowExtensionsCollectionId,
                idx.key, idx.type, idx.attrs
            );
            created.push(`workflowExtensions.index:${idx.key}`);
        } catch (err) {
            const msg = err?.message || '';
            if (isAlreadyExists(err)) {
                skipped.push(`workflowExtensions.index:${idx.key}`);
            } else if (err?.code === 400 && /not available|processing|unknown attribute/i.test(msg)) {
                // Az aszinkron attribute-feldolgozás 400-at pending-re tesszük;
                // egyéb 400 propagáljon (érvénytelen index név, inkompatibilis
                // attribute típus stb.).
                indexesPending.push(`workflowExtensions.${idx.key}`);
            } else {
                error(`[BootstrapWorkflowExtensionSchema] index:${idx.key} hiba: ${err.message}`);
                return fail(res, 500, 'schema_index_failed', {
                    index: idx.key, error: err.message
                });
            }
        }
    }

    log(`[BootstrapWorkflowExtensionSchema] User ${callerId}: created=[${created.join(',')}] skipped=[${skipped.join(',')}] indexesPending=[${indexesPending.join(',')}]`);

    const note = indexesPending.length > 0
        ? 'Az attribútumok feldolgozása ~5-10s. Futtasd újra az action-t amíg az indexesPending lista kiürül.'
        : 'A schema kész. Console-on ellenőrizendő: a `workflowExtensions` collection `rowSecurity` flag-je aktív (különben a doc-szintű team ACL nem érvényesül a Realtime push-on). Következő lépés (B.3): create/update/archive_workflow_extension CRUD action-ök az `actions/extensions.js` modulban.';

    return res.json({
        success: true,
        created,
        skipped,
        indexesPending,
        note
    });
}

/**
 * ACTION='backfill_tenant_acl' — scoped migrációs action (Feladat #60).
 * Caller a target org `owner`-e kell legyen. Az org + minden office team-jét
 * létrehozza, szinkronizálja a tagságot a memberships collectionökből, és
 * újraírja az ACL-t a `organizationInvites` + `groups` + `groupMemberships`
 * doc-okon.
 *
 * Idempotens: 409 → skip. Fail-open per-doc; egyedi hiba `errors[]`-be kerül.
 * Hard prerequisite: az org team `ensureTeam` siker — különben 500
 * `org_team_create_failed`. `dryRun: true` opcióval csak számolja.
 */
async function backfillTenantAcl(ctx) {
    const { databases, env, callerId, payload, log, error, res, fail, sdk, teamsApi } = ctx;
    const dryRun = payload.dryRun === true;
    const { organizationId: targetOrgId } = payload;

    if (!targetOrgId || typeof targetOrgId !== 'string') {
        return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
    }

    // Caller jogosultság: target org `owner` role.
    const ownerMembership = await databases.listDocuments(
        env.databaseId,
        env.membershipsCollectionId,
        [
            sdk.Query.equal('organizationId', targetOrgId),
            sdk.Query.equal('userId', callerId),
            sdk.Query.select(['role']),
            sdk.Query.limit(1)
        ]
    );
    if (ownerMembership.documents.length === 0) {
        return fail(res, 403, 'not_a_member');
    }
    if (ownerMembership.documents[0].role !== 'owner') {
        return fail(res, 403, 'insufficient_role', {
            yourRole: ownerMembership.documents[0].role,
            required: 'owner'
        });
    }

    // Target org fetch — name kell a team labelnek + létezés check.
    let targetOrg;
    try {
        targetOrg = await databases.getDocument(
            env.databaseId, env.organizationsCollectionId, targetOrgId
        );
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'organization_not_found');
        error(`[Backfill] org fetch hiba: ${err.message}`);
        return fail(res, 500, 'organization_fetch_failed');
    }

    const stats = {
        dryRun,
        organizationId: targetOrgId,
        organizations: { scanned: 0, teamsCreated: 0, memberships: 0 },
        offices: { scanned: 0, teamsCreated: 0, memberships: 0 },
        acl: { invites: 0, groups: 0, groupMemberships: 0 },
        errors: []
    };

    // H.1 (Phase 2, 2026-05-09): single-source `listAllByQuery` a
    // `helpers/pagination.js`-ből. Korábban inline-olt 11 sor — minden új
    // backfill action ezt használja, hogy a paging-step driftet ne kelljen
    // 4 helyen szinkronban tartani.
    const listAll = (collectionId, queries = []) =>
        listAllByQuery(databases, env.databaseId, collectionId, queries, sdk, { batchSize: CASCADE_BATCH_LIMIT });

    // ── 1) target organization: team + memberships + invites ACL
    //
    // Az org team HARD prerequisite az invite ACL rewrite-hoz.
    // Ha a team nem jön létre, a doksik `read(team:org_...)`-ra
    // kerülnének anélkül, hogy bárki tagja volna → minden user
    // elveszítené az invite láthatóságát, de a CF success-t adna.
    // Ezért: team create fail → abort az egész action 500-zal.
    {
        const org = targetOrg;
        stats.organizations.scanned++;
        const orgTeamId = buildOrgTeamId(org.$id);

        if (!dryRun) {
            try {
                const result = await ensureTeam(teamsApi, orgTeamId, `Org: ${org.name}`);
                if (result.created) stats.organizations.teamsCreated++;
            } catch (err) {
                error(`[Backfill] org team create hard-fail (${org.$id}): ${err.message}`);
                return fail(res, 500, 'org_team_create_failed', {
                    orgId: org.$id,
                    message: err.message,
                    hint: 'Org team create failure megakadályozta az ACL rewrite-ot az org invite-okra.'
                });
            }
        }

        let orgMembers;
        try {
            orgMembers = await listAll(
                env.membershipsCollectionId,
                [sdk.Query.equal('organizationId', org.$id)]
            );
        } catch (err) {
            stats.errors.push({ kind: 'org_members_list', orgId: org.$id, message: err.message });
            orgMembers = [];
        }

        for (const m of orgMembers) {
            if (dryRun) { stats.organizations.memberships++; continue; }
            try {
                const result = await ensureTeamMembership(
                    teamsApi, orgTeamId, m.userId, [m.role || 'member']
                );
                if (result.added) {
                    stats.organizations.memberships++;
                } else if (result.skipped === 'team_not_found') {
                    // A team-et épp most hoztuk létre — ha itt kap 404-et,
                    // a team időközben eltűnt (párhuzamos törlés?). Hard error.
                    stats.errors.push({
                        kind: 'org_membership', orgId: org.$id, userId: m.userId,
                        message: 'team_not_found after ensureTeam succeeded'
                    });
                }
            } catch (err) {
                stats.errors.push({
                    kind: 'org_membership', orgId: org.$id, userId: m.userId, message: err.message
                });
            }
        }

        // Invites ACL rewrite — most már safe, a team biztosan létezik.
        let invites;
        try {
            invites = await listAll(
                env.invitesCollectionId,
                [sdk.Query.equal('organizationId', org.$id)]
            );
        } catch (err) {
            stats.errors.push({ kind: 'invites_list', orgId: org.$id, message: err.message });
            invites = [];
        }
        const orgPerms = buildOrgAclPerms(org.$id);
        for (const inv of invites) {
            if (dryRun) { stats.acl.invites++; continue; }
            try {
                await databases.updateDocument(
                    env.databaseId, env.invitesCollectionId, inv.$id, {}, orgPerms
                );
                stats.acl.invites++;
            } catch (err) {
                stats.errors.push({
                    kind: 'invite_acl', inviteId: inv.$id, message: err.message
                });
            }
        }
    }

    // ── 2) target org editorialOffices: team + memberships + groups/groupMemberships ACL
    let offices;
    try {
        offices = await listAll(
            env.officesCollectionId,
            [sdk.Query.equal('organizationId', targetOrgId)]
        );
    } catch (err) {
        error(`[Backfill] offices list hiba: ${err.message}`);
        return fail(res, 500, 'scan_failed', { step: 'offices_list' });
    }
    for (const office of offices) {
        stats.offices.scanned++;
        const officeTeamId = buildOfficeTeamId(office.$id);

        if (!dryRun) {
            try {
                const result = await ensureTeam(teamsApi, officeTeamId, `Office: ${office.name}`);
                if (result.created) stats.offices.teamsCreated++;
            } catch (err) {
                stats.errors.push({ kind: 'office_team', officeId: office.$id, message: err.message });
                continue;
            }
        }

        let officeMembers;
        try {
            officeMembers = await listAll(
                env.officeMembershipsCollectionId,
                [sdk.Query.equal('editorialOfficeId', office.$id)]
            );
        } catch (err) {
            stats.errors.push({ kind: 'office_members_list', officeId: office.$id, message: err.message });
            officeMembers = [];
        }

        for (const m of officeMembers) {
            if (dryRun) { stats.offices.memberships++; continue; }
            try {
                const result = await ensureTeamMembership(
                    teamsApi, officeTeamId, m.userId, [m.role || 'member']
                );
                if (result.added) {
                    stats.offices.memberships++;
                } else if (result.skipped === 'team_not_found') {
                    stats.errors.push({
                        kind: 'office_membership', officeId: office.$id, userId: m.userId,
                        message: 'team_not_found after ensureTeam succeeded'
                    });
                }
            } catch (err) {
                stats.errors.push({
                    kind: 'office_membership', officeId: office.$id, userId: m.userId, message: err.message
                });
            }
        }

        const officePerms = buildOfficeAclPerms(office.$id);

        // Groups ACL rewrite
        let groups;
        try {
            groups = await listAll(
                env.groupsCollectionId,
                [sdk.Query.equal('editorialOfficeId', office.$id)]
            );
        } catch (err) {
            stats.errors.push({ kind: 'groups_list', officeId: office.$id, message: err.message });
            groups = [];
        }
        for (const g of groups) {
            if (dryRun) { stats.acl.groups++; continue; }
            try {
                await databases.updateDocument(
                    env.databaseId, env.groupsCollectionId, g.$id, {}, officePerms
                );
                stats.acl.groups++;
            } catch (err) {
                stats.errors.push({
                    kind: 'group_acl', groupId: g.$id, message: err.message
                });
            }
        }

        // GroupMemberships ACL rewrite
        let groupMembers;
        try {
            groupMembers = await listAll(
                env.groupMembershipsCollectionId,
                [sdk.Query.equal('editorialOfficeId', office.$id)]
            );
        } catch (err) {
            stats.errors.push({ kind: 'group_memberships_list', officeId: office.$id, message: err.message });
            groupMembers = [];
        }
        for (const gm of groupMembers) {
            if (dryRun) { stats.acl.groupMemberships++; continue; }
            try {
                await databases.updateDocument(
                    env.databaseId, env.groupMembershipsCollectionId, gm.$id, {}, officePerms
                );
                stats.acl.groupMemberships++;
            } catch (err) {
                stats.errors.push({
                    kind: 'group_membership_acl', gmId: gm.$id, message: err.message
                });
            }
        }
    }

    log(`[Backfill] User ${callerId} — org=${targetOrgId}, dryRun=${dryRun}, offices=${stats.offices.scanned}, errors=${stats.errors.length}`);

    return res.json({ success: true, action: 'backfilled', stats });
}

/**
 * ACTION='backfill_admin_team_acl' — Q1 ACL refactor scoped migráció
 * (E blokk, 2026-05-09 follow-up).
 *
 * Caller a target org `owner`-e. Az action:
 *  1. `org_${orgId}_admins` admin-team létrehozása (HARD prerequisite — ha
 *     bukik, abort 500). Idempotens (409 → skip).
 *  2. Tagság-szinkron: minden `organizationMemberships` rekord, ahol
 *     `role IN (owner, admin)` → `ensureTeamMembership(adminTeamId, userId, [role])`.
 *  3. ACL rewrite a `organizationInvites` doc-okon (org-scope) →
 *     `buildOrgAdminAclPerms`.
 *  4. ACL rewrite a `organizationInviteHistory` doc-okon (org-scope) →
 *     `buildOrgAdminAclPerms`. Ha az env var nincs beállítva, a lépést
 *     skipping-eljük (a Phase D.3 kód már `buildOrgAdminAclPerms`-szel írja
 *     az új doc-okat — csak a legacy backfill-utáni rekordok érintettek).
 *
 * Idempotens: 409 → skip; per-doc fail-open (errors[]). `dryRun: true`
 * opcióval csak számolja a változásokat.
 *
 * **Hard prerequisite minta (Codex baseline minta a `backfill_tenant_acl`
 * 893-916 sorából)**: ha az admin-team create elbukik, abort az egész action
 * 500-zal — különben a doksik dangling team-re kapnának ACL-t, és minden
 * admin elveszítené a láthatóságot.
 */
async function backfillAdminTeamAcl(ctx) {
    const { databases, env, callerId, payload, log, error, res, fail, sdk, teamsApi } = ctx;
    const dryRun = payload && payload.dryRun === true;
    const { organizationId: targetOrgId } = payload || {};

    if (!targetOrgId || typeof targetOrgId !== 'string') {
        return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
    }

    // Caller jogosultság: target org `owner`. (NEM `userHasOrgPermission`,
    // mert orphaned org-on is futtatható az ACL backfill — a caller-hez
    // direkt membership-check tisztább.)
    let ownerMembership;
    try {
        ownerMembership = await databases.listDocuments(
            env.databaseId,
            env.membershipsCollectionId,
            [
                sdk.Query.equal('organizationId', targetOrgId),
                sdk.Query.equal('userId', callerId),
                sdk.Query.select(['role']),
                sdk.Query.limit(1)
            ]
        );
    } catch (err) {
        error(`[BackfillAdminAcl] caller membership lookup hiba: ${err.message}`);
        return fail(res, 500, 'membership_lookup_failed');
    }
    if (ownerMembership.documents.length === 0) {
        return fail(res, 403, 'not_a_member');
    }
    if (ownerMembership.documents[0].role !== 'owner') {
        return fail(res, 403, 'insufficient_role', {
            yourRole: ownerMembership.documents[0].role,
            required: 'owner'
        });
    }

    // Target org létezés-check (és név a team labelhez).
    let targetOrg;
    try {
        targetOrg = await databases.getDocument(
            env.databaseId, env.organizationsCollectionId, targetOrgId
        );
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'organization_not_found');
        error(`[BackfillAdminAcl] org fetch hiba: ${err.message}`);
        return fail(res, 500, 'organization_fetch_failed');
    }

    const stats = {
        dryRun,
        organizationId: targetOrgId,
        adminTeam: { created: false, memberships: 0, staleRemoved: 0 },
        acl: { invites: 0, inviteHistory: 0 },
        skipped: { inviteHistory: false },
        errors: []
    };

    // ── 1) Admin-team HARD prerequisite ──
    const adminTeamId = buildOrgAdminTeamId(targetOrgId);
    if (!dryRun) {
        try {
            const result = await ensureTeam(teamsApi, adminTeamId, `Org admins: ${targetOrg.name}`);
            stats.adminTeam.created = result.created === true;
        } catch (err) {
            error(`[BackfillAdminAcl] admin-team create hard-fail (${targetOrgId}): ${err.message}`);
            return fail(res, 500, 'admin_team_create_failed', {
                orgId: targetOrgId,
                message: err.message,
                hint: 'Admin-team create failure megakadályozta az ACL rewrite-ot a Q1 collection-ökön.'
            });
        }
    }

    // Cursor-paginált helper a 3 backfill scan-hez (Codex stop-time MAJOR fix:
    // a korábbi single-batch limit a target org > CASCADE_BATCH_LIMIT
    // memberships / invites / history rekord esetén néma részleges backfill-t
    // adott — az újrafuttatás cursor nélkül ugyanazt az első oldalt érte el).
    //
    // H.1 (Phase 2, 2026-05-09): single-source `listAllByQuery` import
    // a `helpers/pagination.js`-ből — driftvédett a 4 hívóhely között.
    const listAll = (collectionId, queries) =>
        listAllByQuery(databases, env.databaseId, collectionId, queries, sdk, { batchSize: CASCADE_BATCH_LIMIT });

    // ── 2) Tagság-szinkron — owner+admin role-ú memberships ──
    //
    // Codex stop-time MAJOR fix: `Query.equal('role', ['owner','admin'])` array-
    // form (Appwrite SDK 23.x string-mezőn is támogatja az IN-szemantikát).
    // A korábbi `Query.contains` fallback hibás minta volt; primary path most
    // direkt array-equal.
    let privilegedMemberships;
    try {
        privilegedMemberships = await listAll(
            env.membershipsCollectionId,
            [
                sdk.Query.equal('organizationId', targetOrgId),
                sdk.Query.equal('role', ['owner', 'admin'])
            ]
        );
    } catch (err) {
        stats.errors.push({ kind: 'memberships_list', message: err.message });
        privilegedMemberships = [];
    }

    for (const m of privilegedMemberships) {
        if (dryRun) { stats.adminTeam.memberships++; continue; }
        try {
            const r = await ensureTeamMembership(
                teamsApi, adminTeamId, m.userId, [m.role]
            );
            if (r.added) {
                stats.adminTeam.memberships++;
            } else if (r.skipped === 'team_not_found') {
                // Az admin-team-et most hoztuk létre — ha 404, párhuzamos
                // törlés vagy belső hiba.
                stats.errors.push({
                    kind: 'admin_membership', userId: m.userId,
                    message: 'team_not_found after ensureTeam succeeded'
                });
            }
        } catch (err) {
            stats.errors.push({
                kind: 'admin_membership', userId: m.userId, message: err.message
            });
        }
    }

    // ── 2b) Stale tagok eltávolítása (reconcile) ──
    //
    // Harden Fázis 1+2 (Codex baseline #1 + adversarial BLOCKER 2): a tisztán
    // additív backfill nem védi az out-of-band membership-változásokat
    // (Console-ról közvetlenül törölt admin, vagy nem CF-en át demotált admin
    // → admin-team membership marad → továbbra is lát invite/history doc-ot).
    // A reconcile listázza az admin-team tagokat, és aki nincs a
    // `privilegedMemberships`-ben, az stale → eltávolítjuk.
    //
    // Simplify Efficiency #3: a stale-delete-eket 10-es chunked Promise.all-ban
    // futtatjuk (~10× speedup vs. szekvenciális loop) — egy nagy legacy org
    // 50 stale tag-jánál 5s helyett 500ms.
    const STALE_DELETE_CONCURRENCY = 10;
    if (!dryRun) {
        const privilegedUserIds = new Set(privilegedMemberships.map(m => m.userId));
        const staleQueue = [];
        try {
            let cursor = null;
            while (true) {
                const queries = [sdk.Query.limit(CASCADE_BATCH_LIMIT)];
                if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
                const memList = await teamsApi.listMemberships(adminTeamId, queries);
                const items = memList?.memberships || [];
                if (items.length === 0) break;
                for (const tm of items) {
                    if (!privilegedUserIds.has(tm.userId)) {
                        staleQueue.push(tm);
                    }
                }
                if (items.length < CASCADE_BATCH_LIMIT) break;
                cursor = items[items.length - 1].$id;
            }
        } catch (err) {
            stats.errors.push({ kind: 'admin_team_list', message: err.message });
        }

        for (let i = 0; i < staleQueue.length; i += STALE_DELETE_CONCURRENCY) {
            const slice = staleQueue.slice(i, i + STALE_DELETE_CONCURRENCY);
            await Promise.all(slice.map(async (tm) => {
                try {
                    await teamsApi.deleteMembership(adminTeamId, tm.$id);
                    stats.adminTeam.staleRemoved++;
                    log(`[BackfillAdminAcl] stale admin-team tag eltávolítva (userId=${tm.userId}, membershipId=${tm.$id})`);
                } catch (delErr) {
                    stats.errors.push({
                        kind: 'admin_stale_remove',
                        userId: tm.userId, membershipId: tm.$id,
                        message: delErr.message
                    });
                }
            }));
        }
    }

    // ── 3) ACL rewrite a `organizationInvites` doc-okra ──
    const adminPerms = buildOrgAdminAclPerms(targetOrgId);
    let invites;
    try {
        invites = await listAll(
            env.invitesCollectionId,
            [sdk.Query.equal('organizationId', targetOrgId)]
        );
    } catch (err) {
        stats.errors.push({ kind: 'invites_list', message: err.message });
        invites = [];
    }
    for (const inv of invites) {
        if (dryRun) { stats.acl.invites++; continue; }
        try {
            await databases.updateDocument(
                env.databaseId, env.invitesCollectionId, inv.$id, {}, adminPerms
            );
            stats.acl.invites++;
        } catch (err) {
            stats.errors.push({ kind: 'invite_acl', inviteId: inv.$id, message: err.message });
        }
    }

    // ── 4) ACL rewrite a `organizationInviteHistory` doc-okra ──
    if (env.organizationInviteHistoryCollectionId) {
        let history;
        try {
            history = await listAll(
                env.organizationInviteHistoryCollectionId,
                [sdk.Query.equal('organizationId', targetOrgId)]
            );
        } catch (err) {
            stats.errors.push({ kind: 'invite_history_list', message: err.message });
            history = [];
        }
        for (const h of history) {
            if (dryRun) { stats.acl.inviteHistory++; continue; }
            try {
                await databases.updateDocument(
                    env.databaseId, env.organizationInviteHistoryCollectionId, h.$id, {}, adminPerms
                );
                stats.acl.inviteHistory++;
            } catch (err) {
                stats.errors.push({
                    kind: 'invite_history_acl', historyId: h.$id, message: err.message
                });
            }
        }
    } else {
        stats.skipped.inviteHistory = true;
        log(`[BackfillAdminAcl] ORGANIZATION_INVITE_HISTORY_COLLECTION_ID env hiányzik — history ACL rewrite skipping`);
    }

    log(`[BackfillAdminAcl] User ${callerId} — org=${targetOrgId}, dryRun=${dryRun}, errors=${stats.errors.length}`);

    return res.json({ success: true, action: 'backfilled_admin_team_acl', stats });
}

/**
 * ACTION='backfill_membership_user_names' (2026-05-07) — global owner-only
 * migrációs action. Az `organizationMemberships` és `editorialOfficeMemberships`
 * collection-ök minden rekordjára `usersApi.get(userId)`-t hív, és írja a
 * `userName` + `userEmail` denormalizált mezőket — a 2026-05-07 schema
 * bővítés (snapshot-at-join) backfill-je.
 *
 * **Idempotens**: ha a rekordon mindkét mező MÁR ki van töltve (nem null,
 * nem üres), átugorjuk. Egy második futtatás csak az időközben létrejött
 * vagy meghibásodott rekordokra hat.
 *
 * **Failure-tolerant**: a `fetchUserIdentity` 404 / hálózati hiba esetén
 * `{ userName: null, userEmail: null }`-t ad vissza, és NEM dob errort.
 * A backfill ilyenkor nem írja át a mezőket (mert nincs új info), csak
 * `errors[]`-be sorolja a userId-t. A flow tovább megy.
 *
 * **Pagination**: `CASCADE_BATCH_LIMIT` (100/req) cursor-pagination, mind
 * a két collection-en. A `userIdentityCache` ctx-szintű cache-t reuse-olja
 * — ha ugyanaz a userId mindkét collectionben szerepel (tipikus org+office
 * tagság), egyetlen `usersApi.get` hívás van.
 *
 * **Auth**: `requireOwnerAnywhere` — a caller legalább egy szervezet
 * `owner`-e. Globális (cross-tenant) hatású, mint a `bootstrap_*_schema`
 * action-ök.
 *
 * **Payload**: `{ dryRun?: boolean }` — ha `true`, csak számolja, nem ír.
 * Hasznos staging-validációhoz.
 *
 * @param {Object} ctx
 * @returns {Promise<Object>} `{ success: true, stats: {...} }`
 */
async function backfillMembershipUserNames(ctx) {
    const { databases, env, callerId, payload, log, error, res, sdk, usersApi, userIdentityCache } = ctx;
    const dryRun = payload && payload.dryRun === true;

    // Auth — owner-anywhere (a `requireOwnerAnywhere` 403-mat ad vissza, ha nincs).
    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    const stats = {
        dryRun,
        organizationMemberships: { scanned: 0, updated: 0, skipped: 0, lookupFailed: 0 },
        editorialOfficeMemberships: { scanned: 0, updated: 0, skipped: 0, lookupFailed: 0 },
        errors: []
    };

    // Az updateDocument-pattern egy collection-en: paginated scan + idempotens
    // mező-update. A `kind` csak a stats-ban + log-ban különbözik.
    //
    // H.1 (Phase 2, 2026-05-09): `paginateByQuery` streaming wrapper a
    // korábbi inline cursor-loop helyett.
    const processCollection = async (collectionId, kind) => {
        const bucket = stats[kind];
        try {
            await paginateByQuery(
                databases, env.databaseId, collectionId, [], sdk,
                async (docs) => {
                    for (const doc of docs) {
                        bucket.scanned++;
                        // Idempotens: ha mindkét mező KI van töltve, skip.
                        const hasName = typeof doc.userName === 'string' && doc.userName.length > 0;
                        const hasEmail = typeof doc.userEmail === 'string' && doc.userEmail.length > 0;
                        if (hasName && hasEmail) {
                            bucket.skipped++;
                            continue;
                        }

                        if (!doc.userId) {
                            // Defensive — egy korrupt rekord nélkül `userId`-vel nem
                            // tudunk lookupolni. Skipoljuk, hibát logolunk.
                            stats.errors.push({
                                kind, phase: 'doc', $id: doc.$id, message: 'missing userId'
                            });
                            continue;
                        }

                        const identity = await fetchUserIdentity(usersApi, doc.userId, userIdentityCache, log);
                        if (!identity.userName && !identity.userEmail) {
                            // A user-lookup bukott (törölt user / hálózati hiba) —
                            // nem írunk null-t felül egy meglévő részleges adatra.
                            bucket.lookupFailed++;
                            continue;
                        }

                        if (dryRun) {
                            bucket.updated++;
                            continue;
                        }

                        try {
                            await databases.updateDocument(
                                env.databaseId,
                                collectionId,
                                doc.$id,
                                {
                                    userName: hasName ? doc.userName : (identity.userName || null),
                                    userEmail: hasEmail ? doc.userEmail : (identity.userEmail || null)
                                }
                            );
                            bucket.updated++;
                        } catch (err) {
                            stats.errors.push({
                                kind, phase: 'update', $id: doc.$id, message: err.message
                            });
                        }
                    }
                },
                { batchSize: CASCADE_BATCH_LIMIT }
            );
        } catch (err) {
            error(`[BackfillMembershipUserNames] ${kind} list hiba: ${err.message}`);
            stats.errors.push({ kind, phase: 'list', message: err.message });
        }
    };

    await processCollection(env.membershipsCollectionId, 'organizationMemberships');
    await processCollection(env.officeMembershipsCollectionId, 'editorialOfficeMemberships');

    log(`[BackfillMembershipUserNames] User ${callerId} — dryRun=${dryRun}, ` +
        `org={scanned:${stats.organizationMemberships.scanned},updated:${stats.organizationMemberships.updated},skipped:${stats.organizationMemberships.skipped},lookupFailed:${stats.organizationMemberships.lookupFailed}}, ` +
        `office={scanned:${stats.editorialOfficeMemberships.scanned},updated:${stats.editorialOfficeMemberships.updated},skipped:${stats.editorialOfficeMemberships.skipped},lookupFailed:${stats.editorialOfficeMemberships.lookupFailed}}, ` +
        `errors=${stats.errors.length}`);

    return res.json({ success: true, action: 'backfilled', stats });
}

/**
 * ACTION='bootstrap_invites_schema_v2' (ADR 0010 W2) — owner-only séma-bővítés
 * a meglévő `organizationInvites` collectionön.
 *
 * 4+1 új mező:
 *   - lastDeliveryStatus  string(32)  default='pending'  required=false
 *   - lastDeliveryError   string(512)                    required=false
 *   - sendCount           integer     default=0  min=0   required=false
 *   - lastSentAt          datetime                       required=false
 *   - customMessage       string(500)                    required=false  (ha még nincs)
 *
 * Idempotens (already_exists → skip).
 */
async function bootstrapInvitesSchemaV2(ctx) {
    const { databases, env, log, error, res, fail } = ctx;

    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    const created = [];
    const skipped = [];

    // 1) lastDeliveryStatus — Appwrite 1.9+: required=false + default OK
    try {
        await databases.createStringAttribute(
            env.databaseId, env.invitesCollectionId,
            'lastDeliveryStatus', 32, false, 'pending', false
        );
        created.push('lastDeliveryStatus');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('lastDeliveryStatus');
        else {
            error(`[BootstrapInvitesSchemaV2] lastDeliveryStatus hiba: ${err.message}`);
            return fail(res, 500, 'schema_lastDeliveryStatus_failed', { error: err.message });
        }
    }

    // 2) lastDeliveryError
    try {
        await databases.createStringAttribute(
            env.databaseId, env.invitesCollectionId,
            'lastDeliveryError', 512, false, null, false
        );
        created.push('lastDeliveryError');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('lastDeliveryError');
        else {
            error(`[BootstrapInvitesSchemaV2] lastDeliveryError hiba: ${err.message}`);
            return fail(res, 500, 'schema_lastDeliveryError_failed', { error: err.message });
        }
    }

    // 3) sendCount integer
    try {
        await databases.createIntegerAttribute(
            env.databaseId, env.invitesCollectionId,
            'sendCount', false, 0, undefined, 0, false
        );
        created.push('sendCount');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('sendCount');
        else {
            error(`[BootstrapInvitesSchemaV2] sendCount hiba: ${err.message}`);
            return fail(res, 500, 'schema_sendCount_failed', { error: err.message });
        }
    }

    // 4) lastSentAt datetime
    try {
        await databases.createDatetimeAttribute(
            env.databaseId, env.invitesCollectionId,
            'lastSentAt', false, null, false
        );
        created.push('lastSentAt');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('lastSentAt');
        else {
            error(`[BootstrapInvitesSchemaV2] lastSentAt hiba: ${err.message}`);
            return fail(res, 500, 'schema_lastSentAt_failed', { error: err.message });
        }
    }

    // 5) customMessage — ha valamiért nem létezik, vegyük fel.
    try {
        await databases.createStringAttribute(
            env.databaseId, env.invitesCollectionId,
            'customMessage', 500, false, null, false
        );
        created.push('customMessage');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('customMessage');
        else {
            error(`[BootstrapInvitesSchemaV2] customMessage hiba: ${err.message}`);
            return fail(res, 500, 'schema_customMessage_failed', { error: err.message });
        }
    }

    log(`[BootstrapInvitesSchemaV2] created=[${created.join(',')}] skipped=[${skipped.join(',')}]`);
    return res.json({ success: true, action: 'invites_schema_v2_bootstrapped', created, skipped });
}

/**
 * ACTION='bootstrap_rate_limit_schema' (ADR 0010 W2) — owner-only séma-bootstrap
 * a 2 új IP-rate-limit collectionnek.
 *
 * Collection-ök:
 *   - ipRateLimitCounters: { ip(64), endpoint(32), windowStart(datetime), count(int) }
 *   - ipRateLimitBlocks:   { ip(64), endpoint(32), blockedAt(datetime), blockedUntil(datetime) }
 *
 * Az env változók (`IP_RATE_LIMIT_COUNTERS_COLLECTION_ID`,
 * `IP_RATE_LIMIT_BLOCKS_COLLECTION_ID`) megadják a használandó collection
 * ID-t. Ha az env nincs beállítva → 400 `missing_env_var` error.
 *
 * A `helpers/rateLimit.js` counter append-only `sdk.ID.unique()` doc-ID-vel,
 * a block determinisztikus `rlb_${sha256(subject + '\0' + endpoint).slice(0, 32)}`
 * doc-ID-vel (S.2.2 Codex stop-time fix). A collection `documentSecurity=false`
 * és nincs ACL-szűrés — a CF API key-jel ír.
 */
async function bootstrapRateLimitSchema(ctx) {
    const { databases, env, log, error, res, fail } = ctx;

    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    if (!env.ipRateLimitCountersCollectionId || !env.ipRateLimitBlocksCollectionId) {
        return fail(res, 400, 'missing_env_var', {
            required: ['IP_RATE_LIMIT_COUNTERS_COLLECTION_ID', 'IP_RATE_LIMIT_BLOCKS_COLLECTION_ID']
        });
    }

    const created = [];
    const skipped = [];

    // ── 1) ipRateLimitCounters collection ──
    try {
        await databases.createCollection(
            env.databaseId,
            env.ipRateLimitCountersCollectionId,
            'IP Rate Limit Counters',
            [],     // permissions — csak server-side írás (API key)
            false,  // documentSecurity
            true    // enabled
        );
        created.push('collection:ipRateLimitCounters');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('collection:ipRateLimitCounters');
        else {
            error(`[BootstrapRateLimitSchema] counters collection hiba: ${err.message}`);
            return fail(res, 500, 'rate_counters_collection_failed', { error: err.message });
        }
    }

    const countersAttrs = [
        { name: 'ip', type: 'string', size: 64 },
        { name: 'endpoint', type: 'string', size: 32 },
        { name: 'windowStart', type: 'datetime' },
        { name: 'count', type: 'integer', min: 0, default: 0 }
    ];
    for (const attr of countersAttrs) {
        try {
            if (attr.type === 'string') {
                await databases.createStringAttribute(
                    env.databaseId, env.ipRateLimitCountersCollectionId,
                    attr.name, attr.size, false, null, false
                );
            } else if (attr.type === 'integer') {
                await databases.createIntegerAttribute(
                    env.databaseId, env.ipRateLimitCountersCollectionId,
                    attr.name, false, attr.default ?? 0, undefined, attr.min ?? 0, false
                );
            } else if (attr.type === 'datetime') {
                await databases.createDatetimeAttribute(
                    env.databaseId, env.ipRateLimitCountersCollectionId,
                    attr.name, false, null, false
                );
            }
            created.push(`counters.${attr.name}`);
        } catch (err) {
            if (isAlreadyExists(err)) skipped.push(`counters.${attr.name}`);
            else {
                error(`[BootstrapRateLimitSchema] counters.${attr.name} hiba: ${err.message}`);
                return fail(res, 500, 'rate_counters_attr_failed', { attr: attr.name, error: err.message });
            }
        }
    }

    // ── 2) ipRateLimitBlocks collection ──
    try {
        await databases.createCollection(
            env.databaseId,
            env.ipRateLimitBlocksCollectionId,
            'IP Rate Limit Blocks',
            [],
            false,
            true
        );
        created.push('collection:ipRateLimitBlocks');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('collection:ipRateLimitBlocks');
        else {
            error(`[BootstrapRateLimitSchema] blocks collection hiba: ${err.message}`);
            return fail(res, 500, 'rate_blocks_collection_failed', { error: err.message });
        }
    }

    const blocksAttrs = [
        { name: 'ip', type: 'string', size: 64 },
        { name: 'endpoint', type: 'string', size: 32 },
        { name: 'blockedAt', type: 'datetime' },
        { name: 'blockedUntil', type: 'datetime' }
    ];
    for (const attr of blocksAttrs) {
        try {
            if (attr.type === 'string') {
                await databases.createStringAttribute(
                    env.databaseId, env.ipRateLimitBlocksCollectionId,
                    attr.name, attr.size, false, null, false
                );
            } else if (attr.type === 'datetime') {
                await databases.createDatetimeAttribute(
                    env.databaseId, env.ipRateLimitBlocksCollectionId,
                    attr.name, false, null, false
                );
            }
            created.push(`blocks.${attr.name}`);
        } catch (err) {
            if (isAlreadyExists(err)) skipped.push(`blocks.${attr.name}`);
            else {
                error(`[BootstrapRateLimitSchema] blocks.${attr.name} hiba: ${err.message}`);
                return fail(res, 500, 'rate_blocks_attr_failed', { attr: attr.name, error: err.message });
            }
        }
    }

    // ── 3) Indexek (S.2.7 harden HIGH-3 fix, 2026-05-11) ──
    //
    // A `helpers/rateLimit.js` query-mintái nélkül a runtime full-scan-re menne:
    //   - readCounter:    equal(ip) + equal(endpoint) + equal(windowStart)
    //   - isSubjectBlocked: equal(ip) + equal(endpoint) + greaterThan(blockedUntil)
    //
    // Index nélkül a doc-szám növekedésével a CF timeout-ra fut, ami DoS-vektor
    // (rate-limit fail-open mellett még súlyosabb). Composite key index lefedi
    // mindkét fent használt query-formátumot.
    //
    // Aszinkron Appwrite attribute processing miatt 400 `not available` lehet
    // első futáskor — a user 10s múlva újrafuttatja (`indexesPending` lista).
    const indexesPending = [];
    const rateLimitIndexes = [
        // counter query: ip + endpoint + windowStart (összes szűrő mező)
        { coll: env.ipRateLimitCountersCollectionId, key: 'subject_endpoint_window', attrs: ['ip', 'endpoint', 'windowStart'] },
        // block query: ip + endpoint (egzakt match) + blockedUntil (range filter)
        { coll: env.ipRateLimitBlocksCollectionId, key: 'subject_endpoint_until', attrs: ['ip', 'endpoint', 'blockedUntil'] },
    ];
    for (const idx of rateLimitIndexes) {
        try {
            await databases.createIndex(env.databaseId, idx.coll, idx.key, 'key', idx.attrs);
            created.push(`index:${idx.key}`);
        } catch (err) {
            const msg = err?.message || '';
            if (isAlreadyExists(err)) {
                skipped.push(`index:${idx.key}`);
            } else if (err?.code === 400 && /not available|processing|unknown attribute/i.test(msg)) {
                indexesPending.push(idx.key);
            } else {
                error(`[BootstrapRateLimitSchema] index ${idx.key} hiba: ${err.message}`);
                return fail(res, 500, 'rate_index_failed', { idx: idx.key, error: err.message });
            }
        }
    }

    log(`[BootstrapRateLimitSchema] created=[${created.join(',')}] skipped=[${skipped.join(',')}] indexesPending=[${indexesPending.join(',')}]`);
    return res.json({ success: true, action: 'rate_limit_schema_bootstrapped', created, skipped, indexesPending });
}

/**
 * ACTION='bootstrap_organization_status_schema' (D.2.1, 2026-05-09) — owner-only
 * schema-bővítés a `organizations` collectionön egyetlen új mezővel:
 *   - `status` enum (`active` | `orphaned` | `archived`), default `active`
 *
 * Codex tervi review (2026-05-09): a `pending_owner_transfer` enum-érték
 * túlmodellezés most; az `active|orphaned|archived` 3-érték elég a Phase 1.5-höz.
 *
 * Idempotens (409 → skip). A backfill (legacy null-status orgokra) külön
 * action: `backfill_organization_status` — Codex BLOCKER ha skip-ped, mert a
 * meglévő 60+ org `null`-status maradna és a `userHasOrgPermission` orphan-
 * guardja kétértelmű állapotban dolgozna.
 *
 * Aszinkron Appwrite attribute processing miatt az index-create első futáson
 * 400-zal elbukhat (`indexesPending`) — a user 10s múlva újrafuttatja.
 */
async function bootstrapOrganizationStatusSchema(ctx) {
    const { databases, env, log, error, res, fail } = ctx;

    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    const created = [];
    const skipped = [];
    const indexesPending = [];

    // 1) `status` enum attribútum — `active` | `orphaned` | `archived`,
    // default `active`. Új org bootstrap-jén a `bootstrap_organization` és
    // `create_organization` action-ök automatikusan `active`-ot kapnak.
    try {
        await databases.createEnumAttribute(
            env.databaseId,
            env.organizationsCollectionId,
            'status',
            ['active', 'orphaned', 'archived'],
            false,        // required (false → default érvényes)
            'active',     // default
            false         // array
        );
        created.push('status');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('status');
        else {
            error(`[BootstrapOrgStatus] status enum hiba: ${err.message}`);
            return fail(res, 500, 'schema_status_failed', { error: err.message });
        }
    }

    // 2) Index a `status` mezőre — a `transfer_orphaned_org_ownership` és
    // jövőbeli admin tooling listázza orphan-orgot, ezért index gyorsít.
    try {
        await databases.createIndex(
            env.databaseId,
            env.organizationsCollectionId,
            'status_idx',
            'key',
            ['status']
        );
        created.push('status_idx');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('status_idx');
        else if (/attribute|not.*ready|pending/i.test(err.message || '')) {
            indexesPending.push('status_idx');
            log(`[BootstrapOrgStatus] status_idx pending — re-run 10s múlva: ${err.message}`);
        } else {
            error(`[BootstrapOrgStatus] status_idx hiba: ${err.message}`);
            return fail(res, 500, 'schema_status_idx_failed', { error: err.message });
        }
    }

    log(`[BootstrapOrgStatus] created=[${created.join(',')}] skipped=[${skipped.join(',')}] indexesPending=[${indexesPending.join(',')}]`);
    return res.json({
        success: true,
        action: 'organization_status_schema_bootstrapped',
        created,
        skipped,
        indexesPending: indexesPending.length > 0,
        ...(indexesPending.length > 0 ? { pendingIndexes: indexesPending } : {})
    });
}

/**
 * ACTION='backfill_organization_status' (D.2.5, 2026-05-09) — owner-only
 * migrációs action. A `bootstrap_organization_status_schema` után futtatandó:
 * a meglévő org-okra (`status` mező hiányzik vagy null) beírja az `active`-ot.
 *
 * Codex tervi review BLOCKER (Q5): a schema default csak az új doc-ra hat;
 * a legacy org-ok null-status maradnának, ami fail-open / fail-closed
 * választás közötti dilemmát teremtene a `userHasOrgPermission` helper-ben.
 *
 * Idempotens — paginated, csak null/missing-status org-ot ír felül.
 * `dryRun: true` payload csak számol, nem ír.
 */
async function backfillOrganizationStatus(ctx) {
    const { databases, env, payload, log, error, res, fail, sdk } = ctx;

    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    const dryRun = payload?.dryRun === true;
    const stats = { total: 0, alreadySet: 0, backfilled: 0, errors: [] };

    // H.1 (Phase 2, 2026-05-09): `paginateByQuery` streaming wrapper.
    // Codex simplify F6 (2026-05-09): `Query.isNull('status')` szűrő —
    // egy 1000+ orgú prod-on csak a backfill-elendő doc-okat lapozza.
    // Az `alreadySet` mindig 0 lesz (a kliens-oldali check defenzíven
    // belowmaradt, hátha az index még nem propagált).
    try {
        await paginateByQuery(
            databases,
            env.databaseId,
            env.organizationsCollectionId,
            [sdk.Query.isNull('status')],
            sdk,
            async (docs) => {
                stats.total += docs.length;
                for (const orgDoc of docs) {
                    if (orgDoc.status === 'active' || orgDoc.status === 'orphaned' || orgDoc.status === 'archived') {
                        stats.alreadySet++;
                        continue;
                    }
                    if (dryRun) {
                        stats.backfilled++;
                        continue;
                    }
                    try {
                        await databases.updateDocument(
                            env.databaseId,
                            env.organizationsCollectionId,
                            orgDoc.$id,
                            { status: 'active' }
                        );
                        stats.backfilled++;
                    } catch (err) {
                        stats.errors.push({ orgId: orgDoc.$id, error: err.message });
                        error(`[BackfillOrgStatus] update ${orgDoc.$id} hiba: ${err.message}`);
                    }
                }
            },
            { batchSize: CASCADE_BATCH_LIMIT }
        );
    } catch (err) {
        error(`[BackfillOrgStatus] listDocuments hiba: ${err.message}`);
        return fail(res, 500, 'org_list_failed', { error: err.message });
    }

    log(`[BackfillOrgStatus] dryRun=${dryRun} total=${stats.total} alreadySet=${stats.alreadySet} backfilled=${stats.backfilled} errors=${stats.errors.length}`);
    return res.json({ success: true, action: 'organization_status_backfilled', dryRun, stats });
}

/**
 * ACTION='bootstrap_organization_invite_history_schema' (D.3, 2026-05-09)
 *
 * Owner-only új collection: `organizationInviteHistory`. Audit-trail az
 * `acceptInvite`/`declineInvite`/`expireInvite` destruktív kilépési ágain
 * keletkező snapshot-okhoz. Codex tervi review (2026-05-09): a `token` raw
 * értékét NEM tároljuk — `tokenHash` (SHA-256). GDPR-kompromisszum:
 * incident-korreláció lehetséges (egy konkrét tokenes report → hash → lookup),
 * de újrahasznosítás NEM.
 *
 * Mezők:
 *   - organizationId (36)
 *   - email (320)
 *   - role (16) (member | admin)
 *   - tokenHash (64) — SHA-256 hex, NULLABLE (esetleg nem volt token)
 *   - expiresAt (datetime)
 *   - customMessage (500, nullable)
 *   - invitedByUserId (36, nullable)
 *   - invitedByUserName (128, nullable)
 *   - invitedByUserEmail (320, nullable)
 *   - invitedAt (datetime, az eredeti $createdAt)
 *   - sendCount (integer, default 0)
 *   - lastSentAt (datetime, nullable)
 *   - lastDeliveryStatus (32, nullable)
 *   - finalStatus (16) — accepted | declined | expired
 *   - finalReason (128, nullable)
 *   - finalAt (datetime)
 *   - acceptedByUserId (36, nullable)
 *   - declinedByUserId (36, nullable)
 *   - expiredAt (datetime, nullable)
 *
 * Indexek:
 *   - org_email_finalAt — `(organizationId, email, finalStatus, finalAt)` — UI listához
 *
 * Read ACL: `team:org_${orgId}` ([[Döntések/0003-tenant-team-acl]] mintára).
 * Write: kizárólag CF API key-jel.
 *
 * Idempotens (409 → skip). Action-szintű env var: `ORGANIZATION_INVITE_HISTORY_COLLECTION_ID`.
 */
async function bootstrapOrganizationInviteHistorySchema(ctx) {
    const { databases, env, log, error, res, fail } = ctx;

    const denied = await requireOwnerAnywhere(ctx);
    if (denied) return denied;

    const inviteHistoryCollectionId = env.organizationInviteHistoryCollectionId;
    if (!inviteHistoryCollectionId) {
        return fail(res, 500, 'misconfigured', { missing: ['ORGANIZATION_INVITE_HISTORY_COLLECTION_ID'] });
    }

    const created = [];
    const skipped = [];
    const indexesPending = [];

    // Codex baseline review (2026-05-09 MAJOR fix): collection idempotens
    // létrehozása a `bootstrapWorkflowExtensionSchema` mintáját követve.
    // Az attribútum-create-ek `collection_not_found` hibára futnak, ha a
    // collection nem létezik (a Console-szintű manuális create-et nem
    // feltételezhetjük). `documentSecurity: true` kötelező — a doc-szintű
    // ACL (`buildOrgAclPerms`) ad olvasási jogot az org-tagoknak.
    try {
        await databases.createCollection(
            env.databaseId,
            inviteHistoryCollectionId,
            'organizationInviteHistory',
            [],
            true,   // documentSecurity
            true    // enabled
        );
        created.push('collection:organizationInviteHistory');
    } catch (err) {
        if (isAlreadyExists(err)) {
            skipped.push('collection:organizationInviteHistory');
        } else {
            error(`[BootstrapInviteHistory] collection létrehozás hiba: ${err.message}`);
            return fail(res, 500, 'schema_collection_failed', { error: err.message });
        }
    }

    const stringFields = [
        ['organizationId', 36, true, null],
        ['email', 320, true, null],
        ['role', 16, true, null],
        ['tokenHash', 64, false, null],
        ['customMessage', 500, false, null],
        ['invitedByUserId', 36, false, null],
        ['invitedByUserName', 128, false, null],
        ['invitedByUserEmail', 320, false, null],
        ['lastDeliveryStatus', 32, false, null],
        ['finalStatus', 16, true, null],
        ['finalReason', 128, false, null],
        ['acceptedByUserId', 36, false, null],
        ['declinedByUserId', 36, false, null],
        // 504 recovery probe correlation (ADR 0011 Harden Ph3).
        ['attemptId', 36, false, null]
    ];
    for (const [name, size, required, defaultValue] of stringFields) {
        try {
            await databases.createStringAttribute(
                env.databaseId, inviteHistoryCollectionId,
                name, size, required, defaultValue, false
            );
            created.push(name);
        } catch (err) {
            if (isAlreadyExists(err)) skipped.push(name);
            else {
                error(`[BootstrapInviteHistory] ${name} hiba: ${err.message}`);
                return fail(res, 500, `schema_${name}_failed`, { error: err.message });
            }
        }
    }

    const datetimeFields = [
        ['expiresAt', true],
        ['invitedAt', true],
        ['lastSentAt', false],
        ['finalAt', true],
        ['expiredAt', false]
    ];
    for (const [name, required] of datetimeFields) {
        try {
            await databases.createDatetimeAttribute(
                env.databaseId, inviteHistoryCollectionId, name, required, null, false
            );
            created.push(name);
        } catch (err) {
            if (isAlreadyExists(err)) skipped.push(name);
            else {
                error(`[BootstrapInviteHistory] ${name} hiba: ${err.message}`);
                return fail(res, 500, `schema_${name}_failed`, { error: err.message });
            }
        }
    }

    try {
        await databases.createIntegerAttribute(
            env.databaseId, inviteHistoryCollectionId,
            'sendCount', false, 0, undefined, 0, false
        );
        created.push('sendCount');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('sendCount');
        else {
            error(`[BootstrapInviteHistory] sendCount hiba: ${err.message}`);
            return fail(res, 500, 'schema_sendCount_failed', { error: err.message });
        }
    }

    try {
        await databases.createIndex(
            env.databaseId,
            inviteHistoryCollectionId,
            'org_email_finalAt',
            'key',
            ['organizationId', 'email', 'finalStatus', 'finalAt']
        );
        created.push('org_email_finalAt');
    } catch (err) {
        if (isAlreadyExists(err)) skipped.push('org_email_finalAt');
        else if (/attribute|not.*ready|pending/i.test(err.message || '')) {
            indexesPending.push('org_email_finalAt');
            log(`[BootstrapInviteHistory] org_email_finalAt pending — re-run 10s múlva: ${err.message}`);
        } else {
            error(`[BootstrapInviteHistory] org_email_finalAt hiba: ${err.message}`);
            return fail(res, 500, 'schema_org_email_finalAt_failed', { error: err.message });
        }
    }

    log(`[BootstrapInviteHistory] created=[${created.join(',')}] skipped=[${skipped.join(',')}] indexesPending=[${indexesPending.join(',')}]`);
    return res.json({
        success: true,
        action: 'organization_invite_history_schema_bootstrapped',
        created,
        skipped,
        indexesPending: indexesPending.length > 0,
        ...(indexesPending.length > 0 ? { pendingIndexes: indexesPending } : {})
    });
}

module.exports = {
    bootstrapWorkflowSchema,
    bootstrapPublicationSchema,
    bootstrapGroupsSchema,
    bootstrapPermissionSetsSchema,
    bootstrapWorkflowExtensionSchema,
    backfillTenantAcl,
    backfillMembershipUserNames,
    // ADR 0010 W2 — meghívási flow redesign
    bootstrapInvitesSchemaV2,
    bootstrapRateLimitSchema,
    // D.2 (2026-05-09) — last-owner enforcement Phase 1.5
    bootstrapOrganizationStatusSchema,
    backfillOrganizationStatus,
    // D.3 (2026-05-09) — invite audit-trail collection
    bootstrapOrganizationInviteHistorySchema,
    // E (2026-05-09 follow-up) — Q1 ACL refactor admin-team
    backfillAdminTeamAcl
};
