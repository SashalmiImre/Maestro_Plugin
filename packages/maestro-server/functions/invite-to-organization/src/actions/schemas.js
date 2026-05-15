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
    ensureTeamMembership,
    withCreator
} = require('../teamHelpers.js');
const {
    isAlreadyExists,
    requireOwnerAnywhere,
    requireOrgOwner,
    fetchUserIdentity,
    preserveUserReadPermissions
} = require('../helpers/util.js');
const {
    listAllByQuery,
    paginateByQuery
} = require('../helpers/pagination.js');
const {
    REQUIRED_SECURED_COLLECTIONS,
    ALL_KNOWN_ALIASES,
    findUnknownAliases,
    verifyDocumentSecurity
} = require('../helpers/collectionMetadata.js');

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

    // Caller jogosultság: target org `owner` role. Harden Phase 5 simplify
    // (2026-05-13): single-source `requireOrgOwner(ctx, orgId)` helper a
    // `helpers/util.js`-ben — 3 backfill action duplikációja megszüntetve.
    const denied = await requireOrgOwner(ctx, targetOrgId);
    if (denied) return denied;

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
            stats.errors.push({ kind: 'org_members_list', orgId: org.$id });
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
                stats.errors.push({ kind: 'org_membership', orgId: org.$id, userId: m.userId });
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
            stats.errors.push({ kind: 'invites_list', orgId: org.$id });
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
                stats.errors.push({ kind: 'invite_acl', inviteId: inv.$id });
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
                stats.errors.push({ kind: 'office_team', officeId: office.$id });
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
            stats.errors.push({ kind: 'office_members_list', officeId: office.$id });
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
                stats.errors.push({ kind: 'office_membership', officeId: office.$id, userId: m.userId });
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
            stats.errors.push({ kind: 'groups_list', officeId: office.$id });
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
                stats.errors.push({ kind: 'group_acl', groupId: g.$id });
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
            stats.errors.push({ kind: 'group_memberships_list', officeId: office.$id });
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
                stats.errors.push({ kind: 'group_membership_acl', gmId: gm.$id });
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
    // direkt membership-check tisztább.) Harden Phase 5 simplify (2026-05-13):
    // single-source `requireOrgOwner` helper, `backfillTenantAcl` és
    // `backfillAclPhase2` ugyanezt használja.
    const denied = await requireOrgOwner(ctx, targetOrgId);
    if (denied) return denied;

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
        stats.errors.push({ kind: 'memberships_list' });
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
            stats.errors.push({ kind: 'admin_membership', userId: m.userId });
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
            stats.errors.push({ kind: 'admin_team_list' });
        }

        for (let i = 0; i < staleQueue.length; i += STALE_DELETE_CONCURRENCY) {
            const slice = staleQueue.slice(i, i + STALE_DELETE_CONCURRENCY);
            await Promise.all(slice.map(async (tm) => {
                try {
                    await teamsApi.deleteMembership(adminTeamId, tm.$id);
                    stats.adminTeam.staleRemoved++;
                    log(`[BackfillAdminAcl] stale admin-team tag eltávolítva (userId=${tm.userId}, membershipId=${tm.$id})`);
                } catch (delErr) {
                    // S.13.3 Phase 1.5: NE szivárogtassunk raw delErr.message-et.
                    stats.errors.push({
                        kind: 'admin_stale_remove',
                        userId: tm.userId, membershipId: tm.$id
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
        stats.errors.push({ kind: 'invites_list' });
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
            stats.errors.push({ kind: 'invite_acl', inviteId: inv.$id });
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
            stats.errors.push({ kind: 'invite_history_list' });
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
                stats.errors.push({ kind: 'invite_history_acl', historyId: h.$id });
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
 * ACTION='backfill_acl_phase2' (S.7.2, 2026-05-12) — R.S.7.2 close.
 *
 * Az S.7.1 fix-csomag (2026-05-12) 8 `createDocument` hívásán
 * `withCreator(buildXxxAclPerms(...), callerId)` ACL-t alkalmaztunk, hogy a
 * frissen létrejövő doc-okon a cross-tenant Realtime push szivárgás
 * lezáruljon. A `document_already_exists` race-fallback ágon és a S.7.1 ELŐTT
 * létrejött legacy doc-okon a permissions üres / `read("users")` collection-
 * szintű örökölt — ezeket NEM korrigáltuk inline. Ez az action retroaktívan
 * `updateDocument(..., perms)`-szel pótolja a helyes team-szintű ACL-t.
 *
 * **Scope** (5 collection, S.7.1 fix-csomag tükörképe):
 *
 *   | # | Collection                  | Apply                                    |
 *   |---|-----------------------------|------------------------------------------|
 *   | 1 | organizations               | buildOrgAclPerms(targetOrgId)            |
 *   | 2 | organizationMemberships     | buildOrgAclPerms(targetOrgId)            |
 *   | 3 | editorialOffices            | buildOrgAclPerms(targetOrgId) — ORG-scope|
 *   | 4 | editorialOfficeMemberships  | buildOfficeAclPerms(office.$id)          |
 *   | 5 | publications                | buildOfficeAclPerms(office.$id)          |
 *
 * **user-read preservation** (Codex pre-review Q1 fix): a Phase 2 backfill
 * NEM vakon törli a doc-on lévő `read("user:X")` perm-eket (ADR 0014
 * defense-in-depth) — csak a team-szintű read-et alkalmazza ÚJRA, és a
 * meglévő user-read-eket átemeli. Friss S.7.1 doc-okon a `withCreator(...)`
 * `read(user(creatorId))` megmarad; legacy doc-okon ahol ilyen NEM volt,
 * csak a team-perm lesz aktív (Phase 3 GDPR Art. 17 stale anonymize-olás
 * külön action S.7.9-en — lásd ADR 0014).
 *
 * **Scope param** (Codex pre-review Q3 fix): a CF 60s timeout-ja egy nagy
 * orgon (100+ office × 50+ pub) szétesne single-pass-ban. Ezért a payload
 * `scope` mezője korlátozza a futást — `'all'` (default) vagy a fenti 5
 * collection bármelyikét célzó key. Az admin többször futtathatja
 * collection-enként.
 *
 * **Idempotens overwrite**: a backfill MINDIG újraírja a doc permissions-jét
 * (mint `backfillTenantAcl`). Egy második futtatás zaj-mentes (a már-helyes
 * doc-on `updateDocument` no-op szemantikája — a perms egyezik, csak az
 * `$updatedAt` mozdul). Ha a `databases.updateDocument` szigorúan equality-
 * check-elt diff-output volna, érdemes lenne előbb getDocument + diff, de a
 * jelenlegi Appwrite Cloud SDK mindenképp ír — szándékos egyszerűség.
 *
 * **Caller auth**: target org `owner` role (NEM `requireOwnerAnywhere`,
 * mert org-scope action — caller nem futtathat más org-on backfill-t).
 * Konzisztens `backfillTenantAcl` és `backfillAdminTeamAcl` mintájával.
 *
 * **Hibakezelés**: per-doc try/catch → errors[]-be sorolva, flow folytatódik
 * (Codex pre-review MINOR fix: `partialFailure: true` flag a stats-ban, ha
 * `errors.length > 0` — automatizált futtatók így megkülönböztetik a teljes-
 * sikert a részleges-sikertől).
 *
 * **Stats** (Codex pre-review MAJOR fix: `wouldRewrite` vs `rewritten`
 * szétválasztva dryRun esetén — különben félreérthető, mert dryRun NEM
 * rewrite):
 *
 *   { dryRun, organizationId, scope, partialFailure,
 *     organizations:               { scanned, wouldRewrite, rewritten },
 *     organizationMemberships:     { scanned, wouldRewrite, rewritten },
 *     editorialOffices:            { scanned, wouldRewrite, rewritten },
 *     editorialOfficeMemberships:  { scanned, wouldRewrite, rewritten },
 *     publications:                { scanned, wouldRewrite, rewritten },
 *     errors: [{kind, ...id, message}] }
 *
 * **Payload**: `{ action: 'backfill_acl_phase2', organizationId, dryRun?, scope? }`
 *   - `scope`: 'all' (default) | 'organizations' | 'organizationMemberships'
 *     | 'editorialOffices' | 'editorialOfficeMemberships' | 'publications'
 *
 * @param {Object} ctx
 * @returns {Promise<Object>} `{ success: true, action: 'backfilled_acl_phase2', stats }`
 */
async function backfillAclPhase2(ctx) {
    const { databases, env, callerId, payload, log, error, res, fail, sdk, teamsApi } = ctx;
    const dryRun = payload && payload.dryRun === true;
    const { organizationId: targetOrgId, scope: scopeRaw } = payload || {};

    const VALID_SCOPES = [
        'all',
        'organizations',
        'organizationMemberships',
        'editorialOffices',
        'editorialOfficeMemberships',
        'publications'
    ];
    // Harden SHOULD FIX #5 (Claude self-finding): trim a scope-string-et — egy
    // `scope: '  all  '` payload-t a `VALID_SCOPES.includes` strict-check 400-zal
    // ütött, ami félrevezető hiba. Üres / nem-string → default `'all'`.
    const scope = (typeof scopeRaw === 'string' ? scopeRaw.trim() : '') || 'all';

    if (!targetOrgId || typeof targetOrgId !== 'string') {
        return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
    }
    if (!VALID_SCOPES.includes(scope)) {
        return fail(res, 400, 'invalid_scope', { received: scope, allowed: VALID_SCOPES });
    }

    // Caller jogosultság: target org `owner`. Harden Phase 5 simplify
    // (2026-05-13): single-source `requireOrgOwner` helper a `helpers/util.js`-
    // ben, mind a 3 backfill action közös. NEM `userHasOrgPermission`, mert
    // orphaned org-on is futtatható az ACL backfill — a caller-hez direkt
    // membership-check tisztább. (Orphan org-on a
    // `transfer_orphaned_org_ownership` recovery flow után jut owner-hez a
    // caller; addig nincs miért backfill-elnie.)
    const denied = await requireOrgOwner(ctx, targetOrgId);
    if (denied) return denied;

    // Target org létezés-check + name fetch a team labelhez. Harden SHOULD FIX #4
    // (DRY, Claude self-finding): a `targetOrgDoc`-ot a `wantOrgs` ágban
    // újrahasználjuk a `$permissions` user-read preserve-hez — 1 extra
    // getDocument hívás megtakarítva.
    let targetOrgDoc;
    try {
        targetOrgDoc = await databases.getDocument(
            env.databaseId, env.organizationsCollectionId, targetOrgId
        );
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'organization_not_found');
        error(`[BackfillAclPhase2] org fetch hiba: ${err.message}`);
        return fail(res, 500, 'organization_fetch_failed');
    }

    const MAX_ERRORS = 100;
    const stats = {
        dryRun,
        organizationId: targetOrgId,
        scope,
        partialFailure: false,
        organizations:              { scanned: 0, wouldRewrite: 0, rewritten: 0 },
        organizationMemberships:    { scanned: 0, wouldRewrite: 0, rewritten: 0 },
        editorialOffices:           { scanned: 0, wouldRewrite: 0, rewritten: 0 },
        editorialOfficeMemberships: { scanned: 0, wouldRewrite: 0, rewritten: 0 },
        publications:               { scanned: 0, wouldRewrite: 0, rewritten: 0 },
        // Harden SHOULD FIX #6 (Codex adversarial #9): `errors[]` cap-pel megy,
        // különben egy nagy tenant tömeges-failure-je túllöki az Appwrite CF
        // ~6MB response-limit-jét, és pont a hibajelentés veszik el. Az
        // `errorCount` mindenképp aggregálja az összes-darabszámot, függetlenül
        // a cap-tól; az `errorsTruncated` jelzi, hogy a részletes lista
        // csonkolt.
        errorCount: 0,
        errorsTruncated: false,
        errors: []
    };

    // Per-doc / per-step error helper. A push-cap a stats szerződésen belül
    // (`MAX_ERRORS`); a `errorCount` továbbra is összes-darabszám.
    function recordError(entry) {
        stats.errorCount++;
        if (stats.errors.length < MAX_ERRORS) {
            // S.13.3 Phase 1.5: NE szivárogtassunk raw err.message / err.stack
            // / err.details mezőt a kliens-response-ba (success: true body
            // stats.errors[] array). Részletes hiba az error log-ban marad
            // (S.13.2 piiRedaction.js Phase 1 wrap).
            const { message, error, details, stack, cause, ...safeEntry } = entry || {};
            stats.errors.push(safeEntry);
        } else {
            stats.errorsTruncated = true;
        }
    }

    const listAll = (collectionId, queries = []) =>
        listAllByQuery(databases, env.databaseId, collectionId, queries, sdk, { batchSize: CASCADE_BATCH_LIMIT });

    // user-read preserve helper a `helpers/util.js`-ből (Harden Phase 5 Reuse #1
    // hoist, 2026-05-15). Egyetlen single-source ADR 0014 defense-in-depth-en.
    // (Korábban inline regex; phase3-vel közös.)
    const preserveUserReads = preserveUserReadPermissions;

    const orgPerms = buildOrgAclPerms(targetOrgId);
    const wantOrgs = scope === 'all' || scope === 'organizations';
    const wantMems = scope === 'all' || scope === 'organizationMemberships';
    const wantOffices = scope === 'all' || scope === 'editorialOffices';
    const wantOfficeMems = scope === 'all' || scope === 'editorialOfficeMemberships';
    const wantPubs = scope === 'all' || scope === 'publications';
    const wantAnyOffice = wantOffices || wantOfficeMems || wantPubs;

    // ── Office-listázás (egyetlen scan, újrahasznosítva) ──
    // Harden MUST FIX #1 (Codex baseline P1a) feloldja a per-office-loop minta
    // egyik felét: az `editorialOffices` doc-rewrite-hoz kell az office-lista,
    // és az ensureTeam prerequisite-hez (MUST FIX #2) is. A child collection-
    // ök (memberships, publications) viszont `organizationId`-szal listáznak
    // (orphan-safe scan), így NEM iterálnak az office-okon.
    //
    // Harden Phase 5 simplify (Efficiency #1): `Query.select(...)` projection
    // a 4 listAll-on csökkenti a memory-footprint-et 60-80%-kal nagy orgon
    // (10k doc × 25KB → ~5MB). `$id` + `$permissions` rendszer-mező a
    // SDK-által amúgy is visszajön, defensive explicit listing.
    let officesList = [];
    if (wantAnyOffice) {
        try {
            officesList = await listAll(
                env.officesCollectionId,
                [
                    sdk.Query.equal('organizationId', targetOrgId),
                    sdk.Query.select(['$id', '$permissions', 'name'])
                ]
            );
        } catch (err) {
            recordError({ kind: 'offices_list', message: err.message });
        }
    }

    // ── Team-existence HARD prerequisite ──
    // Harden MUST FIX #2 (Codex baseline P1b): a doc-szintű `read(team:X)`
    // ACL semmit nem ér, ha a team nem létezik — a backfill `success`-szel
    // térne vissza, miközben minden user-t kizártunk a doc-okból. `ensureTeam`
    // idempotens (409 → skip); ha a CREATE NEM-409 hibára esik, az org-team
    // ágon HARD-FAIL abort, az office-team ágon per-office skip + errors[].
    // (Konzisztens: `backfillTenantAcl:899-916` org-team HARD, :990-1002
    // office-team skipping.) Dry-run-on a team-ensure kihagyva — a stats
    // csak előrejelez.
    if (!dryRun) {
        if (wantOrgs || wantMems) {
            const orgTeamId = buildOrgTeamId(targetOrgId);
            try {
                await ensureTeam(teamsApi, orgTeamId, `Org: ${targetOrgDoc.name}`);
            } catch (err) {
                error(`[BackfillAclPhase2] org team ensure hard-fail (${targetOrgId}): ${err.message}`);
                return fail(res, 500, 'org_team_ensure_failed', {
                    orgId: targetOrgId,
                    message: err.message,
                    hint: 'Org team ensure failure megakadályozta az ACL rewrite-ot. Futtasd a `backfill_tenant_acl`-t előbb, vagy verify Console-on az `org_${id}` team-et.'
                });
            }
        }
        if (wantAnyOffice) {
            for (const office of officesList) {
                try {
                    await ensureTeam(teamsApi, buildOfficeTeamId(office.$id), `Office: ${office.name}`);
                } catch (err) {
                    recordError({ kind: 'office_team_ensure', officeId: office.$id });
                }
            }
        }
    }

    // ── Common rewrite-loop helper (Harden Phase 5 simplify, Quality #3) ──
    // Az 5 collection-scan ág (~150 sor) közeli-duplikációját ezzel az inline
    // higher-order helperrel egyesítjük. A `#1 organizations` egy single-doc
    // ág (NEM listAll) — külön marad. A 4 többi (#2-#5) `rewriteAclBatch`-en
    // át fut.
    //
    // A `buildPerms(doc)` callback adja vissza a doc-specifikus team-perm
    // tömböt — vagy `null`-t, ha az adott doc skip-elendő (pl. orphan
    // child-doc, `editorialOfficeId` missing). A skip-előtt a callback maga
    // hívja a `recordError`-t a megfelelő `kind`-dal.
    //
    // Args:
    //   docs         — előre listázott doc-tömb
    //   collectionId — env.<...>CollectionId
    //   statBucket   — stats.<collection>     (scanned/wouldRewrite/rewritten)
    //   buildPerms   — (doc) => Permission[]|null
    //   errorKind    — string prefix az updateDocument-fail rekordjához (pl. 'office')
    //   idField      — string key az error-rekord per-doc id-mezőjéhez
    async function rewriteAclBatch({ docs, collectionId, statBucket, buildPerms, errorKind, idField }) {
        for (const doc of docs) {
            statBucket.scanned++;
            if (dryRun) {
                statBucket.wouldRewrite++;
                continue;
            }
            const perms = buildPerms(doc);
            if (!perms) continue; // skip — buildPerms már loggolta a hibát
            try {
                const newPerms = [...perms, ...preserveUserReads(doc.$permissions)];
                await databases.updateDocument(env.databaseId, collectionId, doc.$id, {}, newPerms);
                statBucket.rewritten++;
            } catch (err) {
                recordError({ kind: `${errorKind}_acl`, [idField]: doc.$id, message: err.message });
            }
        }
    }

    // ── 1) organizations[targetOrgId] doc (single-doc, külön ág) ──
    if (wantOrgs) {
        stats.organizations.scanned = 1;
        if (dryRun) {
            stats.organizations.wouldRewrite = 1;
        } else {
            try {
                const newPerms = [...orgPerms, ...preserveUserReads(targetOrgDoc.$permissions)];
                await databases.updateDocument(
                    env.databaseId, env.organizationsCollectionId, targetOrgId, {}, newPerms
                );
                stats.organizations.rewritten++;
            } catch (err) {
                recordError({ kind: 'organization_acl', orgId: targetOrgId, message: err.message });
            }
        }
    }

    // ── 2) organizationMemberships per org ──
    if (wantMems) {
        let memberships = [];
        try {
            memberships = await listAll(env.membershipsCollectionId, [
                sdk.Query.equal('organizationId', targetOrgId),
                sdk.Query.select(['$id', '$permissions'])
            ]);
        } catch (err) {
            recordError({ kind: 'memberships_list', message: err.message });
        }
        await rewriteAclBatch({
            docs: memberships,
            collectionId: env.membershipsCollectionId,
            statBucket: stats.organizationMemberships,
            buildPerms: () => orgPerms,
            errorKind: 'membership',
            idField: 'membershipId'
        });
    }

    // ── 3) editorialOffices doc-rewrite (org-scope ACL) ──
    if (wantOffices) {
        await rewriteAclBatch({
            docs: officesList,
            collectionId: env.officesCollectionId,
            statBucket: stats.editorialOffices,
            buildPerms: () => orgPerms,
            errorKind: 'office',
            idField: 'officeId'
        });
    }

    // ── 4) editorialOfficeMemberships per org (orphan-safe scan) ──
    // Harden MUST FIX #1 (Codex baseline P1a): NEM per-office iteráció.
    // A doc `organizationId` mezővel listázunk, így a `editorialOfficeId`-vel
    // árva (törölt office-ra hivatkozó) doc is bekerül a scan-be. Per-doc
    // származtatjuk az office-perm-et a `om.editorialOfficeId`-ből;
    // missing/invalid esetén `buildPerms` `null`-t ad + recordError.
    if (wantOfficeMems) {
        let officeMems = [];
        try {
            officeMems = await listAll(env.officeMembershipsCollectionId, [
                sdk.Query.equal('organizationId', targetOrgId),
                sdk.Query.select(['$id', '$permissions', 'editorialOfficeId'])
            ]);
        } catch (err) {
            recordError({ kind: 'office_memberships_list', message: err.message });
        }
        await rewriteAclBatch({
            docs: officeMems,
            collectionId: env.officeMembershipsCollectionId,
            statBucket: stats.editorialOfficeMemberships,
            buildPerms: (om) => {
                const officeId = om.editorialOfficeId;
                if (!officeId || typeof officeId !== 'string') {
                    recordError({
                        kind: 'office_membership_missing_office',
                        omId: om.$id,
                        message: 'editorialOfficeId missing or invalid — orphan child doc, ACL rewrite skip'
                    });
                    return null;
                }
                return buildOfficeAclPerms(officeId);
            },
            errorKind: 'office_membership',
            idField: 'omId'
        });
    }

    // ── 5) publications per org (orphan-safe scan) ──
    // Harden MUST FIX #1 (Codex baseline P1a): mint #4 — `organizationId`-vel
    // listázunk, NEM `editorialOfficeId`-vel. Az env.publicationsCollectionId
    // opcionális — ha hiányzik (régebbi deploy), skipping a stat 0-rewrite-os
    // state-tel.
    if (wantPubs && env.publicationsCollectionId) {
        let pubs = [];
        try {
            pubs = await listAll(env.publicationsCollectionId, [
                sdk.Query.equal('organizationId', targetOrgId),
                sdk.Query.select(['$id', '$permissions', 'editorialOfficeId'])
            ]);
        } catch (err) {
            recordError({ kind: 'publications_list', message: err.message });
        }
        await rewriteAclBatch({
            docs: pubs,
            collectionId: env.publicationsCollectionId,
            statBucket: stats.publications,
            buildPerms: (p) => {
                const officeId = p.editorialOfficeId;
                if (!officeId || typeof officeId !== 'string') {
                    recordError({
                        kind: 'publication_missing_office',
                        pubId: p.$id,
                        message: 'editorialOfficeId missing or invalid — orphan child doc, ACL rewrite skip'
                    });
                    return null;
                }
                return buildOfficeAclPerms(officeId);
            },
            errorKind: 'publication',
            idField: 'pubId'
        });
    }

    stats.partialFailure = stats.errorCount > 0;

    // Codex pre-review MINOR fix: audit-log a caller + org + scope + dryRun
    // + per-collection stats. Az automatizált futtató (admin UI / shell-script)
    // ezt grep-elheti a CF logokból, és a `partialFailure: true` esetén
    // emelt-státusz retry-t indít. A teljes `stats` JSON.stringify-olva (kivéve
    // `errors`, hogy a log-line max 2-3 KB maradjon).
    log(`[BackfillAclPhase2] caller=${callerId} org=${targetOrgId} scope=${scope} dryRun=${dryRun} errorCount=${stats.errorCount} truncated=${stats.errorsTruncated} partial=${stats.partialFailure} counts=${JSON.stringify({
        organizations: stats.organizations,
        organizationMemberships: stats.organizationMemberships,
        editorialOffices: stats.editorialOffices,
        editorialOfficeMemberships: stats.editorialOfficeMemberships,
        publications: stats.publications
    })}`);

    // Harden MUST FIX #3 (Codex adversarial #5): `success: true` + `partialFailure:
    // true` kombináció false-positive szerződés egy automatizált futtatónak —
    // `success`-t csak akkor jelentjük, ha tényleg minden doc rewrite-elve. A
    // konzisztencia-trade-off: a régi `backfillTenantAcl`/`backfillAdminTeamAcl`
    // mind `success: true`-t adott errors[] mellett — itt szándékosan szakítunk
    // ezzel, az adversarial review felülbírál. A HTTP-status 200 marad
    // (Appwrite CF idiom; a body-mező hordozza a gépbarát szerződést).
    return res.json({
        success: stats.errorCount === 0,
        action: 'backfilled_acl_phase2',
        stats
    });
}

/**
 * ACTION='backfill_acl_phase3' (S.7.7c, 2026-05-15) — R.S.7.7 close.
 *
 * Legacy doc-ok (S.7.7 fix ELŐTT létrejött `articles`/`publications`/`layouts`/
 * `deadlines`/`userValidations`/`systemValidations`) retroaktív ACL korrekciója.
 * A S.7.7 (2026-05-14) fix-csomag CSAK a friss `createRow`/`createDocument`
 * hívásokra ad doc-szintű `withCreator(buildOfficeAclPerms(...))` ACL-t; a fix
 * előtt létrejött doc-ok üres `permissions`-szel hagyatkoznak a collection-
 * fallback-ra → cross-tenant `read("users")` szivárgás.
 *
 * **Scope** (6 user-data collection, S.7.7 fix-csomag tükörképe):
 *
 *   | # | Collection alias    | Office-resolution                                |
 *   |---|---------------------|--------------------------------------------------|
 *   | 1 | publications        | direkt `editorialOfficeId` mező                  |
 *   | 2 | articles            | `publicationId` → publications.editorialOfficeId |
 *   | 3 | layouts             | `publicationId` → publications.editorialOfficeId |
 *   | 4 | deadlines           | `publicationId` → publications.editorialOfficeId |
 *   | 5 | userValidations     | `articleId` → articles.publicationId → ...       |
 *   | 6 | systemValidations   | `articleId` → articles.publicationId → ...       |
 *
 * **Fallback policy** (Codex verifying C5 2026-05-14, KÖTELEZŐ):
 *   - Kategória 1: `doc.createdBy` érvényes user-$id + Auth user lookup SIKERES
 *     → `withCreator(buildOfficeAclPerms(office.$id), doc.createdBy)`
 *   - Kategória 2: `createdBy` hiányzik / invalid / Auth user 404 / transient
 *     → CSAK `buildOfficeAclPerms(office.$id)` — NINCS user-read fallback
 *       (NE inferáljunk `modifiedBy`-ból — ASVS V4.1.3 + ownership enforcement)
 *
 * **user-read preserve**: meglévő `read("user:*")` perm-eket regex átemeli
 * (mint phase2, ADR 0014 defense-in-depth). Codex pre-review MAJOR 2 fix:
 * CSAK `read("user:X")` formát preserve-eli — write/update/delete user perm-et
 * NEM.
 *
 * **Audit log** (Codex pre-review MAJOR 1 fix): minden kategória-2 doc per-
 * collection + per-$id `fallbackUsedDocs: [{alias, collectionId, docId,
 * fallbackReason}]` arrayba a response-ba + CF stdout. `fallbackReason` 4-féle
 * (`createdBy_missing` / `createdBy_invalid` / `auth_user_not_found` /
 * `auth_lookup_failed_transient`) — 404 vs transient NEM mosódik össze.
 * Cap: `MAX_FALLBACKS = 100` + `fallbackUsedDocsTruncated` flag.
 *
 * **Office-resolution failure policy** (Codex pre-review BLOCKER, KÖTELEZŐ):
 *   - Hiányzó `publicationId` (articles/layouts/deadlines) →
 *     `kind: 'missing_publication_link'`, NEM ACL-write
 *   - publication NEM létezik a pre-load Map-ben (törölt parent) →
 *     `kind: 'orphan_publication'`
 *   - Publication `editorialOfficeId` mező missing/invalid →
 *     `kind: 'publication_missing_office'`
 *   - userValidations/systemValidations: `articleId` missing →
 *     `kind: 'missing_article_link'`; article nem található →
 *     `kind: 'orphan_article'`; parent publication nem található →
 *     `kind: 'orphan_publication_via_article'`
 *
 * **Scope param** (CF 60s timeout-bypass nagy orgon): `'all'` (default) vagy
 * a 6 alias bármelyike. Az admin többször futtathatja collection-enként.
 *
 * **Idempotens overwrite** (mint phase2): 2. futtatás `$updatedAt`-ot mozdít,
 * de nem semantikusan változtat. Realtime push storm tolerable (300ms debounce).
 *
 * **Execution constraint** (Codex verifying C2 fix, 2026-05-15): **operator-
 * supervised only** — egy CF-invocation EGY `scope` payload-ot futtat, NEM
 * autonóm batch-en az összes 6 aliast. Az admin szekvenciálisan futtatja
 * scope-okat a runbook-szerint.
 *
 * **Accepted runtime tradeoffs** (Codex stop-time MAJOR 2+3, 2026-05-15):
 *   - `usersApi.get(createdBy)` per egyedi `createdBy` SDK-call: egy nagy org
 *     1000+ egyedi createdBy → ~100s, CF 60s timeout-ot átléphet. Mitigáció:
 *     scope-by-scope MANUÁLIS admin futtatás (a `scope` paraméterrel), és a
 *     `createdByAuthCache` (Map, lokális a function-invocation-höz — NEM durable,
 *     a 6 alias-scan KÖZÖSEN használja az adott CF-call alatt, de a következő
 *     invocation friss Map-pel kezd).
 *     Observable stop conditions (admin per-invocation figyelje):
 *       - max ~500 egyedi createdBy / scope-CF-call → biztosan gyors (<60s)
 *       - 500-1000 között → óvatos retry (a Codex pre-review MAJOR 2 bound)
 *       - >1000 → scope-bontás VAGY a Streaming-page-local refactor
 *       - timeout / elevated `auth_lookup_failed_transient` fallback >50% →
 *         admin abort + retry kisebb scope-pal
 *   - `articlesList` pre-load `articleId → publicationId` Map a 2 validation
 *     scope-on: nagy orgon 100k+ article = 100k Map-entry. `Query.select(['$id',
 *     'publicationId'])` projection-szel ~20B/entry → 100k = ~2MB (tolerable
 *     a CF memory-limit-en belül). Observable stop:
 *       - >50k article a target-orgon → admin futtassa a 4 non-validation scope-ot
 *         előbb, és csak utána a 2 validation-t külön
 *       - memory-pressure (CF OOM) → admin abort + streaming refactor escalation
 *     Streaming page-local join refactor halasztva (a kód-egyszerűségéért).
 *   Runbook a [[Komponensek/TenantIsolation#S.7.7c operations runbook]]-on.
 *
 * **Office team-ensure HARD prerequisite** (mint phase2): minden érintett
 * `office_${officeId}` team létezzen, különben doc-szintű `read(team:X)` ACL
 * semmit nem ér. `ensureTeam` idempotens (409 → skip); CREATE-fail per-office
 * skip + errors[].
 *
 * **Stats** (Codex pre-review MINOR fix: collection-alias szerint bontva,
 * `wouldRewrite` vs `rewritten` szétválasztva dryRun esetén, + `fallbackUsed`):
 *
 *   { dryRun, organizationId, scope, partialFailure, errorCount,
 *     errorsTruncated, fallbackUsedDocsCount, fallbackUsedDocsTruncated,
 *     publications:      { scanned, wouldRewrite, rewritten, skipped, fallbackUsed },
 *     articles:          { ... },
 *     layouts:           { ... },
 *     deadlines:         { ... },
 *     userValidations:   { ... },
 *     systemValidations: { ... },
 *     errors: [{kind, ...id, message}],
 *     fallbackUsedDocs: [{alias, collectionId, docId, fallbackReason}] }
 *
 * **Payload**: `{ action: 'backfill_acl_phase3', organizationId, dryRun?, scope? }`
 *
 * **Auth**: target org `owner` (mint `backfill_acl_phase2`, audit-trail +
 * ASVS V4.1.1 least privilege).
 *
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function backfillAclPhase3(ctx) {
    const { databases, env, callerId, payload, log, error, res, fail, sdk, teamsApi, usersApi } = ctx;
    const dryRun = payload && payload.dryRun === true;
    const { organizationId: targetOrgId, scope: scopeRaw } = payload || {};

    // 6 alias scope + 'all' (REQUIRED_SECURED_COLLECTIONS single-source — S.7.7b).
    const VALID_SCOPES = ['all', ...REQUIRED_SECURED_COLLECTIONS.map(c => c.alias)];
    // Trim a scope-string-et (mint phase2 SHOULD FIX #5 minta). Üres / nem-string → 'all'.
    const scope = (typeof scopeRaw === 'string' ? scopeRaw.trim() : '') || 'all';

    if (!targetOrgId || typeof targetOrgId !== 'string') {
        return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
    }
    if (!VALID_SCOPES.includes(scope)) {
        return fail(res, 400, 'invalid_scope', { received: scope, allowed: VALID_SCOPES });
    }

    const denied = await requireOrgOwner(ctx, targetOrgId);
    if (denied) return denied;

    // Target org létezés-check — defensive (a `requireOrgOwner` membership-doc-on
    // futott, de explicit org-fetch a `name` mezőhöz az office-team-ensure
    // title-jéhez kell).
    let targetOrgDoc;
    try {
        targetOrgDoc = await databases.getDocument(
            env.databaseId, env.organizationsCollectionId, targetOrgId
        );
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'organization_not_found');
        error(`[BackfillAclPhase3] org fetch hiba: ${err.message}`);
        return fail(res, 500, 'organization_fetch_failed');
    }

    const MAX_ERRORS = 100;
    const MAX_FALLBACKS = 100;
    const stats = {
        dryRun,
        organizationId: targetOrgId,
        scope,
        partialFailure: false,
        publications:      { scanned: 0, wouldRewrite: 0, rewritten: 0, skipped: 0, fallbackUsed: 0 },
        articles:          { scanned: 0, wouldRewrite: 0, rewritten: 0, skipped: 0, fallbackUsed: 0 },
        layouts:           { scanned: 0, wouldRewrite: 0, rewritten: 0, skipped: 0, fallbackUsed: 0 },
        deadlines:         { scanned: 0, wouldRewrite: 0, rewritten: 0, skipped: 0, fallbackUsed: 0 },
        userValidations:   { scanned: 0, wouldRewrite: 0, rewritten: 0, skipped: 0, fallbackUsed: 0 },
        systemValidations: { scanned: 0, wouldRewrite: 0, rewritten: 0, skipped: 0, fallbackUsed: 0 },
        errorCount: 0,
        errorsTruncated: false,
        errors: [],
        fallbackUsedDocsCount: 0,
        fallbackUsedDocsTruncated: false,
        fallbackUsedDocs: []
    };

    function recordError(entry) {
        stats.errorCount++;
        if (stats.errors.length < MAX_ERRORS) {
            // S.13.3 Phase 1.5: NE szivárogtassunk raw err.message / err.stack
            // / err.details mezőt a kliens-response-ba (success: true body
            // stats.errors[] array). Részletes hiba az error log-ban marad
            // (S.13.2 piiRedaction.js Phase 1 wrap).
            const { message, error, details, stack, cause, ...safeEntry } = entry || {};
            stats.errors.push(safeEntry);
        } else {
            stats.errorsTruncated = true;
        }
    }
    function recordFallback(entry) {
        stats.fallbackUsedDocsCount++;
        if (stats.fallbackUsedDocs.length < MAX_FALLBACKS) {
            stats.fallbackUsedDocs.push(entry);
        } else {
            stats.fallbackUsedDocsTruncated = true;
        }
    }

    const listAll = (collectionId, queries = []) =>
        listAllByQuery(databases, env.databaseId, collectionId, queries, sdk, { batchSize: CASCADE_BATCH_LIMIT });

    // user-read preserve helper a `helpers/util.js`-ből (Harden Phase 5 Reuse #1
    // hoist, 2026-05-15). Single-source phase2 + phase3 között.
    const preserveUserReads = preserveUserReadPermissions;

    // Want flags per alias
    const wantPubs = scope === 'all' || scope === 'publications';
    const wantArt  = scope === 'all' || scope === 'articles';
    const wantLay  = scope === 'all' || scope === 'layouts';
    const wantDl   = scope === 'all' || scope === 'deadlines';
    const wantUv   = scope === 'all' || scope === 'userValidations';
    const wantSv   = scope === 'all' || scope === 'systemValidations';

    // Pub pre-load minden non-empty scope-on kell (child collection-ök rajta resolve-elnek).
    const needPubPreload = wantPubs || wantArt || wantLay || wantDl || wantUv || wantSv;
    // Article pre-load csak a 2 validation-scope-on kell (articleId JOIN).
    const needArtPreload = wantUv || wantSv;

    // Collection-ID resolver — env hiánya scope-szintű skip + recordError.
    // A S.7.7b óta a 4 új env var opcionális; ha hiányzik, csak az érintett scope
    // skip-elt (NEM hard-fail az egész action-en, mert pl. csak `articles`-en hív
    // a caller).
    const collectionsByAlias = {
        publications:      env.publicationsCollectionId,
        articles:          env.articlesCollectionId,
        layouts:           env.layoutsCollectionId,
        deadlines:         env.deadlinesCollectionId,
        userValidations:   env.userValidationsCollectionId,
        systemValidations: env.systemValidationsCollectionId
    };
    function missingCollectionId(alias) {
        const id = collectionsByAlias[alias];
        if (!id || typeof id !== 'string' || id.length === 0) {
            recordError({
                kind: 'missing_env_collection_id',
                alias,
                message: `Env var hiányzik a '${alias}' collection ID-jához (set ${(REQUIRED_SECURED_COLLECTIONS.find(c => c.alias === alias) || {}).envVar || alias.toUpperCase()}_COLLECTION_ID).`
            });
            return true;
        }
        return false;
    }

    // ── Office target-org boundary pre-load: `validOfficesForTargetOrg` Set ──
    // Harden Phase 2 adversarial HIGH fix (2026-05-15): cross-tenant attack
    // vector prevention. A `publications.editorialOfficeId` mező NEM ellenőrzött
    // a target-orgra: egy korrupt vagy malicious pub-doc org-A-ban office-B-re
    // (másik org) mutathat — a backfill `read("team:office_B")` perm-eket adna
    // a doc-okra, cross-tenant escalation. MEGOLDÁS: target-org office-ID-k
    // pre-load Set-be, és minden office-ID-referenciát ellenőrzünk a Set-en
    // (ha NEM benne → recordError `cross_org_office_violation` + skip).
    let officesForTargetOrg = [];
    const validOfficesForTargetOrg = new Set();
    if (needPubPreload) {
        try {
            officesForTargetOrg = await listAll(
                env.officesCollectionId,
                [
                    sdk.Query.equal('organizationId', targetOrgId),
                    sdk.Query.select(['$id'])
                ]
            );
            for (const o of officesForTargetOrg) {
                if (o.$id && typeof o.$id === 'string') {
                    validOfficesForTargetOrg.add(o.$id);
                }
            }
        } catch (err) {
            recordError({ kind: 'offices_list', message: err.message });
        }
    }

    // ── Publication pre-load: `pubId → editorialOfficeId` Map ──
    // Single-pass `listAllByQuery` `Query.select` projection-szel (memory-friendly
    // nagy orgon: 10k pub × 25KB → ~5MB; projection-szel ~50KB).
    //
    // Harden adversarial HIGH fix: `editorialOfficeId` cross-tenant validation
    // — csak `validOfficesForTargetOrg`-tagokat fogadunk a Map-be. Egy korrupt
    // pub-doc office-B-re mutató referenciája NEM kerül a Map-be, recordError
    // jelzi a violation-t.
    let pubsList = [];
    const pubOfficeMap = new Map();
    if (needPubPreload && !missingCollectionId('publications')) {
        try {
            pubsList = await listAll(
                env.publicationsCollectionId,
                [
                    sdk.Query.equal('organizationId', targetOrgId),
                    sdk.Query.select(['$id', '$permissions', 'createdBy', 'editorialOfficeId'])
                ]
            );
            for (const p of pubsList) {
                if (p.editorialOfficeId && typeof p.editorialOfficeId === 'string') {
                    if (validOfficesForTargetOrg.has(p.editorialOfficeId)) {
                        pubOfficeMap.set(p.$id, p.editorialOfficeId);
                    } else {
                        // Cross-tenant office reference — BLOCK (security violation).
                        recordError({
                            kind: 'cross_org_office_violation',
                            pubId: p.$id,
                            officeId: p.editorialOfficeId,
                            message: 'publication.editorialOfficeId NEM tartozik target-orghoz (potential cross-tenant attack vector vagy data-corruption — ACL rewrite skip)'
                        });
                    }
                }
            }
        } catch (err) {
            recordError({ kind: 'publications_list', message: err.message });
        }
    }

    // ── Article pre-load: `articleId → publicationId` Map ──
    // CSAK validation-scope esetén (uv|sv) — `articleId → publicationId → office`
    // 2-step JOIN.
    let articlesList = [];
    const artPubMap = new Map();
    if (needArtPreload && !missingCollectionId('articles')) {
        try {
            articlesList = await listAll(
                env.articlesCollectionId,
                [
                    sdk.Query.equal('organizationId', targetOrgId),
                    sdk.Query.select(['$id', 'publicationId'])
                ]
            );
            for (const a of articlesList) {
                if (a.publicationId && typeof a.publicationId === 'string') {
                    artPubMap.set(a.$id, a.publicationId);
                }
            }
        } catch (err) {
            recordError({ kind: 'articles_list', message: err.message });
        }
    }

    // ── Office team-ensure HARD prerequisite (mint phase2) ──
    // pubOfficeMap-ből összegyűjtjük az érintett officeId Set-et, és mindegyikre
    // `ensureTeam(office_${officeId})` idempotens hívást futtatunk. Dry-run-on
    // a team-ensure kihagyva.
    //
    // Harden Phase 1 baseline P1 fix (2026-05-15): ha `ensureTeam` fail-el egy
    // office-on, a `failedOfficeTeams` Set jelzi — a doc-szintű rewrite-ban a
    // `resolveOffice` skip-eli (NEM ír `read("team:office_X")` perm-et nem-létező
    // team-re, ami lockout-ot okozna a real user-ekre).
    const failedOfficeTeams = new Set();
    if (!dryRun) {
        const officeIds = new Set();
        for (const officeId of pubOfficeMap.values()) {
            if (officeId) officeIds.add(officeId);
        }
        for (const officeId of officeIds) {
            try {
                await ensureTeam(teamsApi, buildOfficeTeamId(officeId), `Office: ${officeId}`);
            } catch (err) {
                failedOfficeTeams.add(officeId);
                recordError({ kind: 'office_team_ensure', officeId, message: err.message });
            }
        }
    }

    // ── Kategória 1 vs 2 fallback build per doc (Codex pre-review MAJOR 1 fix) ──
    //
    // Aszinkron `usersApi.get(createdBy)` lookup + lokális `createdByAuthCache`
    // (Map<userId, true|false|'transient'>). NEM reuse-oljuk a ctx `userIdentityCache`-t,
    // mert az `{userName, userEmail}` shape — itt csak Auth-létezik-e jel kell.
    //
    // Visszatérési érték: { perms: Permission[]|null, fallbackUsed: boolean,
    //                        fallbackReason: 'createdBy_missing' | 'createdBy_invalid' |
    //                                        'auth_user_not_found' |
    //                                        'auth_lookup_failed_transient' | null }
    // (Codex stop-time MAJOR 1 fix: 4-reason contract — a cache-hit 404
    // ugyanazt a `auth_user_not_found` reason-t adja, nem külön cached-jelet.)
    const createdByAuthCache = new Map();
    async function buildDocAcl({ alias, doc, officeId }) {
        const officePerms = buildOfficeAclPerms(officeId);
        const createdBy = doc.createdBy;
        if (createdBy === undefined || createdBy === null) {
            return { perms: officePerms, fallbackUsed: true, fallbackReason: 'createdBy_missing' };
        }
        if (typeof createdBy !== 'string' || createdBy.length === 0 || createdBy.trim() !== createdBy) {
            return { perms: officePerms, fallbackUsed: true, fallbackReason: 'createdBy_invalid' };
        }
        // Cache-check.
        // Codex stop-time MAJOR 1 fix (2026-05-15): a 4-reason contract egységes —
        // a cache-hit 404-re UGYANAZT a `auth_user_not_found` reason-t adjuk, mint
        // az első miss. A cache implementational detail, NEM audit-grain.
        if (createdByAuthCache.has(createdBy)) {
            const cached = createdByAuthCache.get(createdBy);
            if (cached === true) {
                return { perms: withCreator(officePerms, createdBy), fallbackUsed: false, fallbackReason: null };
            }
            return {
                perms: officePerms,
                fallbackUsed: true,
                fallbackReason: cached === 'transient' ? 'auth_lookup_failed_transient' : 'auth_user_not_found'
            };
        }
        // Cache miss — lookup
        try {
            await usersApi.get(createdBy);
            createdByAuthCache.set(createdBy, true);
            return { perms: withCreator(officePerms, createdBy), fallbackUsed: false, fallbackReason: null };
        } catch (err) {
            const is404 = err?.code === 404 || err?.type === 'user_not_found';
            createdByAuthCache.set(createdBy, is404 ? false : 'transient');
            return {
                perms: officePerms,
                fallbackUsed: true,
                fallbackReason: is404 ? 'auth_user_not_found' : 'auth_lookup_failed_transient'
            };
        }
    }

    // ── Common rewrite-loop helper (mint phase2 rewriteAclBatch, kibővítve
    // fallback-policy + audit-rekord-szal) ──
    async function rewriteAclBatchPhase3({ alias, docs, collectionId, statBucket, resolveOffice, errorKind, idField }) {
        for (const doc of docs) {
            statBucket.scanned++;
            const officeId = resolveOffice(doc);
            if (!officeId) {
                statBucket.skipped++;
                continue; // resolveOffice maga loggolta a BLOCKER hibát
            }
            // Harden Phase 5 Quality #4 fix (2026-05-15): a `failedOfficeTeams`
            // filter EGY helyen — post-resolve, pre-dryRun. A 3 resolveOffice
            // callback (publications + scanByPublicationLink + scanByArticleLink)
            // korábban DRY-fail-jelölést duplikált; itt egyetlen biztonsági
            // invariáns-pont (ADR 0014 Layer 2 prevent-lockout).
            if (failedOfficeTeams.has(officeId)) {
                statBucket.skipped++;
                recordError({
                    kind: 'office_team_unavailable',
                    alias,
                    [idField]: doc.$id,
                    officeId,
                    message: 'office team-ensure failed — doc skipped to avoid lockout'
                });
                continue;
            }
            if (dryRun) {
                statBucket.wouldRewrite++;
                continue;
            }
            const aclResult = await buildDocAcl({ alias, doc, officeId });
            if (!aclResult.perms) {
                statBucket.skipped++;
                continue;
            }
            if (aclResult.fallbackUsed) {
                statBucket.fallbackUsed++;
                recordFallback({
                    alias,
                    collectionId,
                    docId: doc.$id,
                    fallbackReason: aclResult.fallbackReason
                });
            }
            try {
                // Harden Phase 6 verifying P2 fix (2026-05-15): a `Set` dedupe-olja
                // a `read("user:X")` perm-et, ha a doc már tartalmazta — különben
                // a `withCreator` + `preserveUserReads` duplikát perm-et adna,
                // és az Appwrite `updateDocument` rejeject-elné (idempotens
                // re-run break).
                const newPerms = Array.from(new Set([...aclResult.perms, ...preserveUserReads(doc.$permissions)]));
                await databases.updateDocument(env.databaseId, collectionId, doc.$id, {}, newPerms);
                statBucket.rewritten++;
            } catch (err) {
                recordError({ kind: `${errorKind}_acl`, [idField]: doc.$id, message: err.message });
            }
        }
    }

    // ── 1) publications ── direkt `editorialOfficeId` mező
    if (wantPubs && !missingCollectionId('publications')) {
        await rewriteAclBatchPhase3({
            alias: 'publications',
            docs: pubsList,
            collectionId: env.publicationsCollectionId,
            statBucket: stats.publications,
            resolveOffice: (p) => {
                const officeId = p.editorialOfficeId;
                if (!officeId || typeof officeId !== 'string') {
                    recordError({
                        kind: 'publication_missing_office',
                        pubId: p.$id,
                        message: 'editorialOfficeId missing or invalid — orphan child doc'
                    });
                    return null;
                }
                // Harden adversarial HIGH fix: cross-tenant boundary defensive guard
                // (a pubOfficeMap-be már csak valid office-ok kerültek a pre-load alatt,
                // de a direkt resolve nem a Map-en megy — explicit check kell).
                if (!validOfficesForTargetOrg.has(officeId)) {
                    recordError({
                        kind: 'cross_org_office_violation',
                        pubId: p.$id,
                        officeId,
                        message: 'publication.editorialOfficeId NEM tartozik target-orghoz (potential cross-tenant — ACL rewrite skip)'
                    });
                    return null;
                }
                // `failedOfficeTeams` filter a `rewriteAclBatchPhase3`-ban (Phase 5
                // Quality #4 fix) — egyetlen biztonsági invariáns-pont.
                return officeId;
            },
            errorKind: 'publication',
            idField: 'pubId'
        });
    }

    // ── 2-4) articles / layouts / deadlines ── `publicationId → editorialOfficeId` JOIN
    async function scanByPublicationLink({ alias, collectionId, statBucket, errorKind, idField }) {
        if (missingCollectionId(alias)) return;
        let docs = [];
        try {
            docs = await listAll(
                collectionId,
                [
                    sdk.Query.equal('organizationId', targetOrgId),
                    sdk.Query.select(['$id', '$permissions', 'createdBy', 'publicationId'])
                ]
            );
        } catch (err) {
            recordError({ kind: `${alias}_list`, message: err.message });
            return;
        }
        await rewriteAclBatchPhase3({
            alias,
            docs,
            collectionId,
            statBucket,
            resolveOffice: (doc) => {
                const pubId = doc.publicationId;
                if (!pubId || typeof pubId !== 'string') {
                    recordError({
                        kind: 'missing_publication_link',
                        alias,
                        [idField]: doc.$id,
                        message: 'publicationId mező missing or invalid'
                    });
                    return null;
                }
                const officeId = pubOfficeMap.get(pubId);
                if (!officeId) {
                    recordError({
                        kind: 'orphan_publication',
                        alias,
                        [idField]: doc.$id,
                        pubId,
                        message: 'Parent publication NEM létezik a Map-ben (törölt, cross-org, vagy validOfficesForTargetOrg-en kívüli)'
                    });
                    return null;
                }
                // `failedOfficeTeams` filter a `rewriteAclBatchPhase3`-ban (Phase 5 Quality #4 fix).
                return officeId;
            },
            errorKind,
            idField
        });
    }

    if (wantArt) await scanByPublicationLink({ alias: 'articles',  collectionId: env.articlesCollectionId,  statBucket: stats.articles,  errorKind: 'article',  idField: 'articleId' });
    if (wantLay) await scanByPublicationLink({ alias: 'layouts',   collectionId: env.layoutsCollectionId,   statBucket: stats.layouts,   errorKind: 'layout',   idField: 'layoutId' });
    if (wantDl)  await scanByPublicationLink({ alias: 'deadlines', collectionId: env.deadlinesCollectionId, statBucket: stats.deadlines, errorKind: 'deadline', idField: 'deadlineId' });

    // ── 5-6) userValidations / systemValidations ── `articleId → publicationId → office` 2-step JOIN
    //
    // Harden Phase 6 verifying P1 fix (2026-05-15): a validation collection-ök
    // (`userValidations`, `systemValidations`) NEM tárolnak `organizationId`
    // mezőt (a frontend `useOverlapValidation` / `useWorkflowValidation` csak
    // `articleId`/`publicationId`/`source` + permissions-t írnak). Ezért a
    // query NEM filter-elhet org-ra — ehelyett a target-orgon belüli article-ID-kkal
    // batch-szerűen scan-elünk (`Query.equal('articleId', batch)`).
    async function scanByArticleLink({ alias, collectionId, statBucket, errorKind, idField }) {
        if (missingCollectionId(alias)) return;
        const articleIds = Array.from(artPubMap.keys());
        if (articleIds.length === 0) {
            return; // Nincs article a target-orgban — nem lehet hozzá tartozó validation
        }
        const BATCH = 25; // Appwrite Query.equal IN-batch limit (konzervatív)
        const docs = [];
        for (let i = 0; i < articleIds.length; i += BATCH) {
            const batch = articleIds.slice(i, i + BATCH);
            try {
                const batchDocs = await listAll(
                    collectionId,
                    [
                        sdk.Query.equal('articleId', batch),
                        sdk.Query.select(['$id', '$permissions', 'createdBy', 'articleId'])
                    ]
                );
                docs.push(...batchDocs);
            } catch (err) {
                recordError({
                    kind: `${alias}_list`,
                    message: err.message,
                    batchStartIndex: i,
                    batchSize: batch.length
                });
                // Folytatás a következő batch-szel (partial-failure tolerable).
            }
        }
        await rewriteAclBatchPhase3({
            alias,
            docs,
            collectionId,
            statBucket,
            resolveOffice: (doc) => {
                const artId = doc.articleId;
                if (!artId || typeof artId !== 'string') {
                    recordError({
                        kind: 'missing_article_link',
                        alias,
                        [idField]: doc.$id,
                        message: 'articleId mező missing or invalid'
                    });
                    return null;
                }
                const pubId = artPubMap.get(artId);
                if (!pubId) {
                    recordError({
                        kind: 'orphan_article',
                        alias,
                        [idField]: doc.$id,
                        artId,
                        message: 'Parent article NEM létezik a Map-ben (törölt vagy NEM target-org)'
                    });
                    return null;
                }
                const officeId = pubOfficeMap.get(pubId);
                if (!officeId) {
                    recordError({
                        kind: 'orphan_publication_via_article',
                        alias,
                        [idField]: doc.$id,
                        artId,
                        pubId,
                        message: 'Parent publication NEM létezik a Map-ben (törölt, cross-org, vagy validOfficesForTargetOrg-en kívüli)'
                    });
                    return null;
                }
                // `failedOfficeTeams` filter a `rewriteAclBatchPhase3`-ban (Phase 5 Quality #4 fix).
                return officeId;
            },
            errorKind,
            idField
        });
    }

    if (wantUv) await scanByArticleLink({ alias: 'userValidations',   collectionId: env.userValidationsCollectionId,   statBucket: stats.userValidations,   errorKind: 'user_validation',   idField: 'uvId' });
    if (wantSv) await scanByArticleLink({ alias: 'systemValidations', collectionId: env.systemValidationsCollectionId, statBucket: stats.systemValidations, errorKind: 'system_validation', idField: 'svId' });

    stats.partialFailure = stats.errorCount > 0;

    // Audit log (mint phase2): caller + org + scope + dryRun + per-collection counts + fallback count.
    log(`[BackfillAclPhase3] caller=${callerId} org=${targetOrgId} scope=${scope} dryRun=${dryRun} errorCount=${stats.errorCount} errorsTruncated=${stats.errorsTruncated} fallbackCount=${stats.fallbackUsedDocsCount} fallbackTruncated=${stats.fallbackUsedDocsTruncated} partial=${stats.partialFailure} counts=${JSON.stringify({
        publications: stats.publications,
        articles: stats.articles,
        layouts: stats.layouts,
        deadlines: stats.deadlines,
        userValidations: stats.userValidations,
        systemValidations: stats.systemValidations
    })}`);

    return res.json({
        success: stats.errorCount === 0,
        action: 'backfilled_acl_phase3',
        stats
    });
}

/**
 * ACTION='anonymize_user_acl' (S.7.9, 2026-05-15) — R.S.7.5 close.
 *
 * GDPR Art. 17 stale `withCreator` user-read cleanup. Az S.7.1 (2026-05-12)
 * bevezette a `withCreator(perms, callerId)` mintát — minden tenant-érintő
 * `createDocument` doc-szintű `Permission.read(user(callerId))` perm-et kap
 * a creator-race-resilience-hez. **STALE problem**: amikor a user kilép a
 * tenant-ből (`leave_organization`) vagy törli a fiókját (`delete_my_account`),
 * a `Permission.read(user:X)` perm a meglévő doc-okon **megmarad** —
 * `removeTeamMembership` NEM törli a doc-szintű perm-et. GDPR Art. 17
 * (right to be forgotten) sérülés-kockázat: a volt user a saját régi
 * history-jét továbbra is látja.
 *
 * **Q1 user-decision B** (2026-05-13 Harden Phase 7): külön action,
 * NEM a `backfill_acl_phase2`/phase3-ba építve. Indok: 1 felelősség per
 * action, eltérő cadence (backfill 1× a S.7.1 fix után, cleanup havonta/
 * évente vagy a self-service flow-on).
 *
 * **Scope** (12 collection, target-orgon belül):
 *
 *   | # | Collection                  | Org-id-filter                 |
 *   |---|-----------------------------|-------------------------------|
 *   | 1 | organizations (1 doc)        | direkt $id === targetOrgId    |
 *   | 2 | organizationMemberships      | Query.equal('organizationId') |
 *   | 3 | editorialOffices             | Query.equal('organizationId') |
 *   | 4 | editorialOfficeMemberships   | Query.equal('organizationId') |
 *   | 5 | publications                 | Query.equal('organizationId') |
 *   | 6 | articles                     | Query.equal('organizationId') |
 *   | 7 | layouts                      | Query.equal('organizationId') |
 *   | 8 | deadlines                    | Query.equal('organizationId') |
 *   | 9 | userValidations              | Query.equal('articleId', batch) — articleIds a target-org articles-ból (Codex BLOCKER fix) |
 *   | 10 | systemValidations           | mint #9                       |
 *   | 11 | organizationInvites          | Query.equal('organizationId') (csak ha env-collection-id beállítva) |
 *   | 12 | organizationInviteHistory    | Query.equal('organizationId') (csak ha env-collection-id beállítva) |
 *
 * **Algoritmus** (Q1 GO):
 *   - Per-doc: `currentPerms.filter(p => !PERM_PATTERN.test(p))`, ahol
 *     `PERM_PATTERN = /^.*\("user:${escapeRegex(targetUserId)}"\)$/` —
 *     strict end-anchored regex. Minden ACL-művelet (read|write|update|
 *     delete|create) target-user-id-jét eltávolítja. Codex MAJOR fix:
 *     `escapeRegex` a `targetUserId`-n a regex-metakaraktereket escape-eli.
 *   - Ha a filter ELTÁVOLÍTOTT legalább 1 perm-et → `updateDocument(...,
 *     filteredPerms)`. NEM no-op write (csak ha tényleg volt perm).
 *
 * **Set dedupe** (Codex Q8 GO, S.7.7c Verifying P2 minta): a `filteredPerms`
 * `Array.from(new Set(...))`-szel duplikáció-mentes.
 *
 * **Auth** (Q3 + Q5 GO — kettős):
 *   - Self-anonymize: `callerId === targetUserId` → NEM kér extra auth-ot
 *     (a self-service flow `leave_organization` / `delete_my_account`
 *     ezt a self-anonymize-pathway-en hívja).
 *   - Admin-anonymize: `callerId !== targetUserId` → `requireOrgOwner(ctx,
 *     organizationId)` auth (mint `backfill_acl_phase2`/phase3).
 *
 * **Audit** (Q6 GO): per-collection `scanned`/`anonymized`/`skipped`/`errors`
 * + caller + targetUserId + organizationId + dryRun + partialFailure flag.
 *
 * **Idempotens** (Q7 GO): 2. futtatás `filteredPerms.length === currentPerms.length`
 * → no-op (NEM hív `updateDocument`-et, megtakarít Realtime push storm-ot).
 * Eltér phase2/phase3-tól, mert ott rewrite-elnek (mindig $updatedAt mozdul);
 * itt csak akkor írunk, ha tényleg volt eltávolítandó perm.
 *
 * **Payload**: `{ action: 'anonymize_user_acl', organizationId, targetUserId, dryRun? }`
 *
 * **Accepted runtime tradeoffs** (Codex stop-time MAJOR 1, 2026-05-15):
 *   - Nagy org-on (10k+ doc, 100k+ article) a 12-collection scan + 25-batch
 *     validation-query CF 60s timeout-ot átléphet. Operational bound: max
 *     ~10k doc / org / flow synchron biztos lefutáshoz. Self-service flow-ban
 *     (`leaveOrganization` / `deleteMyAccount`) ezt fail-soft kezeljük —
 *     a tag-eltávolítás cél már elérve a team-cleanup-ban, az ACL-residual
 *     admin re-anonymize-cal pótolható később.
 *   - **Re-anonymize fallback path** (Codex MAJOR 2): admin manuálisan
 *     futtathatja az action-t `{organizationId, targetUserId}` payload-szal
 *     az admin-anonymize ágon (`requireOrgOwner` auth). Auditálható a
 *     stdout log `[AnonymizeUserAcl]` prefix-szel grep-elve a CF logokból
 *     (caller + targetUserId + org + errorCount + partial JSON).
 *   - **Partial-failure semantics** (Codex MAJOR 3): a stats `errors[]` cap
 *     100 + `errorsTruncated` flag + `partialFailure: errorCount > 0`. A
 *     `success` boolean csak akkor `true`, ha `errorCount === 0` —
 *     automatizált futtató megkülönbözteti a teljes-sikert a részlegestől.
 *   - **Optional collection skip** (Codex MINOR): a `organizationInviteHistory`
 *     env-var OPCIONÁLIS (history halasztott deploy). Ha hiányzik,
 *     `stats.skippedCollections[]` arrayba kerül + audit-log a stdout-on
 *     (NE legyen silent — admin tudja, hogy NEM volt scan-elve).
 *
 * @param {Object} ctx
 * @returns {Promise<Object>} `{ success: true, action: 'anonymized_user_acl', stats }`
 */
/**
 * Belső helper `anonymize_user_acl`-hez (S.7.9 Phase 4b refactor, 2026-05-15).
 *
 * Az action handler `anonymizeUserAcl(ctx)` és a self-service flow-k
 * (`leaveOrganization` az `offices.js`-ben, `deleteMyAccount` az `orgs.js`-ben)
 * KÖZÖSEN hívják a core-t. A core NEM csinál auth-check-et (a hívó dolga) és
 * NEM hív `res.json`-t (visszaadja a stats-ot). A thin wrapper `anonymizeUserAcl(ctx)`
 * felelős: payload-validation + auth + res.json csomagolás.
 *
 * @param {Object} ctx — handler context (databases, env, sdk, log, error)
 * @param {Object} params - { organizationId, targetUserId, dryRun }
 * @returns {Promise<{ success: boolean, stats: Object, orgNotFound?: boolean }>}
 */
async function anonymizeUserAclCore(ctx, { organizationId: targetOrgId, targetUserId, dryRun = false, callerId, maxRunMs = null }) {
    const { databases, env, log, error, sdk } = ctx;
    // Harden Phase 1 P1 + Phase 2 medium fix (2026-05-15): a callerId paraméter
    // explicit a params-ban — a `ctx.callerId` action-handler-szintű, de a core
    // a self-service flow-kból is hívható, ahol a hívó saját callerId-jét adja
    // át. A log-statement-en undefined-ReferenceError-t okozott korábban.
    const callerForLog = typeof callerId === 'string' && callerId.length > 0
        ? callerId
        : (ctx && ctx.callerId) || 'unknown';
    // Harden Phase 6 verifying P1 fix (2026-05-15): time-budget a self-service
    // flow-knak (`leave_organization` / `delete_my_account`). A platform timeout
    // 60s NEM catch-elhető — ha az anonymize közelít hozzá, a flow split-brain
    // állapotba kerülhet (team out, DB membership még in). A `maxRunMs` bound
    // partial-return-rel garantálja a flow-folytatást. Admin re-anonymize a
    // fallback path.
    const startTime = Date.now();
    const isOverBudget = () => maxRunMs !== null && (Date.now() - startTime > maxRunMs);

    // Target org létezés-check (defensive — a hívó esetleg már ellenőrizte).
    try {
        await databases.getDocument(env.databaseId, env.organizationsCollectionId, targetOrgId);
    } catch (err) {
        if (err?.code === 404) {
            return { success: false, stats: null, orgNotFound: true };
        }
        error(`[AnonymizeUserAclCore] org fetch hiba: ${err.message}`);
        return { success: false, stats: null, orgFetchFailed: true };
    }

    // PERM_PATTERN: strict end-anchored regex (Codex MAJOR fix — escapeRegex
    // a regex-metakaraktereket sanitálja). Match: minden ACL-művelet
    // (read|write|update|delete|create) "user:${targetUserId}" perm-en.
    const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const PERM_PATTERN = new RegExp(`^[a-z]+\\("user:${escapeRegex(targetUserId)}"\\)$`);

    const MAX_ERRORS = 100;
    const stats = {
        dryRun,
        organizationId: targetOrgId,
        targetUserId,
        partialFailure: false,
        // Codex stop-time MINOR fix (2026-05-15): silent-skip → explicit
        // `skippedCollections[]` audit-mező. Ha `organizationInviteHistory`
        // env-var hiányzik (halasztott deploy), itt jelez.
        skippedCollections: [],
        // Harden Phase 6 verifying P1 fix: a `maxRunMs` time-budget kivánás
        // jelölése. Ha `true`, a self-service hívó tudja, hogy partial-cleanup,
        // és admin re-anonymize szükséges a maradék collection-ekre.
        timeBudgetExceeded: false,
        organizations:              { scanned: 0, anonymized: 0, skipped: 0 },
        organizationMemberships:    { scanned: 0, anonymized: 0, skipped: 0 },
        editorialOffices:           { scanned: 0, anonymized: 0, skipped: 0 },
        editorialOfficeMemberships: { scanned: 0, anonymized: 0, skipped: 0 },
        publications:               { scanned: 0, anonymized: 0, skipped: 0 },
        articles:                   { scanned: 0, anonymized: 0, skipped: 0 },
        layouts:                    { scanned: 0, anonymized: 0, skipped: 0 },
        deadlines:                  { scanned: 0, anonymized: 0, skipped: 0 },
        userValidations:            { scanned: 0, anonymized: 0, skipped: 0 },
        systemValidations:          { scanned: 0, anonymized: 0, skipped: 0 },
        organizationInvites:        { scanned: 0, anonymized: 0, skipped: 0 },
        organizationInviteHistory:  { scanned: 0, anonymized: 0, skipped: 0 },
        errorCount: 0,
        errorsTruncated: false,
        errors: []
    };

    function recordError(entry) {
        stats.errorCount++;
        if (stats.errors.length < MAX_ERRORS) {
            // S.13.3 Phase 1.5: NE szivárogtassunk raw err.message / err.stack
            // / err.details mezőt a kliens-response-ba (success: true body
            // stats.errors[] array). Részletes hiba az error log-ban marad
            // (S.13.2 piiRedaction.js Phase 1 wrap).
            const { message, error, details, stack, cause, ...safeEntry } = entry || {};
            stats.errors.push(safeEntry);
        } else {
            stats.errorsTruncated = true;
        }
    }

    const listAll = (collectionId, queries = []) =>
        listAllByQuery(databases, env.databaseId, collectionId, queries, sdk, { batchSize: CASCADE_BATCH_LIMIT });

    // Per-doc anonymize loop. Q6 idempotens: csak akkor `updateDocument`,
    // ha legalább 1 perm eltávolítva. Q8 Set dedupe (S.7.7c Verifying P2).
    async function anonymizeDoc({ doc, collectionId, statBucket, errorKind, idField }) {
        statBucket.scanned++;
        const currentPerms = Array.isArray(doc.$permissions) ? doc.$permissions : [];
        const filteredPerms = currentPerms.filter(p => !PERM_PATTERN.test(p));
        if (filteredPerms.length === currentPerms.length) {
            statBucket.skipped++;
            return; // no-op (idempotens — semmi user:X perm-et nem találtunk)
        }
        if (dryRun) {
            statBucket.anonymized++;
            return;
        }
        try {
            const dedupedPerms = Array.from(new Set(filteredPerms));
            await databases.updateDocument(env.databaseId, collectionId, doc.$id, {}, dedupedPerms);
            statBucket.anonymized++;
        } catch (err) {
            recordError({ kind: `${errorKind}_acl`, [idField]: doc.$id, message: err.message });
        }
    }

    // ── 1) organizations (single-doc) ──
    try {
        const orgDoc = await databases.getDocument(env.databaseId, env.organizationsCollectionId, targetOrgId);
        await anonymizeDoc({
            doc: orgDoc,
            collectionId: env.organizationsCollectionId,
            statBucket: stats.organizations,
            errorKind: 'organization',
            idField: 'orgId'
        });
    } catch (err) {
        recordError({ kind: 'organization_fetch', message: err.message });
    }

    // Time-budget check helper — break-eli a scan-eket. A meglévő `recordError`
    // NEM jelez timeout-ot, csak a `stats.timeBudgetExceeded = true` flag-en
    // jut tudomásra a hívó.
    const checkBudget = () => {
        if (isOverBudget()) {
            stats.timeBudgetExceeded = true;
            return true;
        }
        return false;
    };

    // ── 2-8) Org-id-filter-elt collection-ök ──
    const orgIdScans = [
        { alias: 'organizationMemberships',    collectionId: env.membershipsCollectionId,            errorKind: 'org_membership',    idField: 'memId' },
        { alias: 'editorialOffices',           collectionId: env.officesCollectionId,                errorKind: 'office',            idField: 'officeId' },
        { alias: 'editorialOfficeMemberships', collectionId: env.officeMembershipsCollectionId,      errorKind: 'office_membership', idField: 'memId' },
        { alias: 'publications',               collectionId: env.publicationsCollectionId,           errorKind: 'publication',       idField: 'pubId' },
        { alias: 'articles',                   collectionId: env.articlesCollectionId,               errorKind: 'article',           idField: 'articleId' },
        { alias: 'layouts',                    collectionId: env.layoutsCollectionId,                errorKind: 'layout',            idField: 'layoutId' },
        { alias: 'deadlines',                  collectionId: env.deadlinesCollectionId,              errorKind: 'deadline',          idField: 'deadlineId' }
    ];
    for (const scan of orgIdScans) {
        if (checkBudget()) break;
        if (!scan.collectionId) {
            recordError({ kind: 'missing_env_collection_id', alias: scan.alias });
            continue;
        }
        try {
            const docs = await listAll(
                scan.collectionId,
                [
                    sdk.Query.equal('organizationId', targetOrgId),
                    sdk.Query.select(['$id', '$permissions'])
                ]
            );
            for (const doc of docs) {
                if (checkBudget()) break;
                await anonymizeDoc({
                    doc,
                    collectionId: scan.collectionId,
                    statBucket: stats[scan.alias],
                    errorKind: scan.errorKind,
                    idField: scan.idField
                });
            }
        } catch (err) {
            recordError({ kind: `${scan.alias}_list`, message: err.message });
        }
    }

    // ── 9-10) Validation collections (articleId batch-scan, Codex BLOCKER fix) ──
    // A validation collection-ök NEM tárolnak organizationId-t (S.7.7c Verifying
    // P1). Az `artPubMap` mintára: pre-load minden article-id-t a target-org-ból
    // és batch-szerűen scan-elünk a validation collection-ön.
    let targetArticleIds = [];
    if (env.articlesCollectionId) {
        try {
            const articles = await listAll(
                env.articlesCollectionId,
                [
                    sdk.Query.equal('organizationId', targetOrgId),
                    sdk.Query.select(['$id'])
                ]
            );
            targetArticleIds = articles.map(a => a.$id).filter(id => typeof id === 'string');
        } catch (err) {
            recordError({ kind: 'articles_id_list', message: err.message });
        }
    }
    const validationScans = [
        { alias: 'userValidations',   collectionId: env.userValidationsCollectionId,   errorKind: 'user_validation',   idField: 'uvId' },
        { alias: 'systemValidations', collectionId: env.systemValidationsCollectionId, errorKind: 'system_validation', idField: 'svId' }
    ];
    for (const scan of validationScans) {
        if (checkBudget()) break;
        if (!scan.collectionId) {
            recordError({ kind: 'missing_env_collection_id', alias: scan.alias });
            continue;
        }
        if (targetArticleIds.length === 0) continue;
        const BATCH = 25;
        for (let i = 0; i < targetArticleIds.length; i += BATCH) {
            if (checkBudget()) break;
            const batch = targetArticleIds.slice(i, i + BATCH);
            try {
                const docs = await listAll(
                    scan.collectionId,
                    [
                        sdk.Query.equal('articleId', batch),
                        sdk.Query.select(['$id', '$permissions'])
                    ]
                );
                for (const doc of docs) {
                    if (checkBudget()) break;
                    await anonymizeDoc({
                        doc,
                        collectionId: scan.collectionId,
                        statBucket: stats[scan.alias],
                        errorKind: scan.errorKind,
                        idField: scan.idField
                    });
                }
            } catch (err) {
                recordError({
                    kind: `${scan.alias}_list`,
                    message: err.message,
                    batchStartIndex: i,
                    batchSize: batch.length
                });
            }
        }
    }

    // ── 11-12) Invite-collection-ök (W3 admin-team scoped, defense-in-depth) ──
    const inviteScans = [
        { alias: 'organizationInvites',       collectionId: env.invitesCollectionId,                   errorKind: 'invite',         idField: 'inviteId' },
        { alias: 'organizationInviteHistory', collectionId: env.organizationInviteHistoryCollectionId, errorKind: 'invite_history', idField: 'historyId' }
    ];
    for (const scan of inviteScans) {
        if (checkBudget()) break;
        if (!scan.collectionId) {
            // Codex stop-time MINOR fix: explicit audit a silent-skip helyett.
            stats.skippedCollections.push({ alias: scan.alias, reason: 'env_var_missing' });
            continue;
        }
        try {
            const docs = await listAll(
                scan.collectionId,
                [
                    sdk.Query.equal('organizationId', targetOrgId),
                    sdk.Query.select(['$id', '$permissions'])
                ]
            );
            for (const doc of docs) {
                await anonymizeDoc({
                    doc,
                    collectionId: scan.collectionId,
                    statBucket: stats[scan.alias],
                    errorKind: scan.errorKind,
                    idField: scan.idField
                });
            }
        } catch (err) {
            recordError({ kind: `${scan.alias}_list`, message: err.message });
        }
    }

    stats.partialFailure = stats.errorCount > 0;

    log(`[AnonymizeUserAcl] caller=${callerForLog} target=${targetUserId} org=${targetOrgId} dryRun=${dryRun} errorCount=${stats.errorCount} partial=${stats.partialFailure} counts=${JSON.stringify({
        organizations: stats.organizations,
        organizationMemberships: stats.organizationMemberships,
        editorialOffices: stats.editorialOffices,
        editorialOfficeMemberships: stats.editorialOfficeMemberships,
        publications: stats.publications,
        articles: stats.articles,
        layouts: stats.layouts,
        deadlines: stats.deadlines,
        userValidations: stats.userValidations,
        systemValidations: stats.systemValidations,
        organizationInvites: stats.organizationInvites,
        organizationInviteHistory: stats.organizationInviteHistory
    })}`);

    return { success: stats.errorCount === 0, stats };
}

/**
 * ACTION='anonymize_user_acl' (S.7.9, 2026-05-15) — R.S.7.5 close.
 *
 * Thin wrapper a `anonymizeUserAclCore`-on. Payload validation + auth check
 * (self vs admin) + res.json csomagolás. A `leaveOrganization` és
 * `deleteMyAccount` self-service flow-k a core-t hívják KÖZVETLENÜL
 * (saját security guard-okkal already authorized).
 *
 * Lásd a core JSDoc-ot a fenti `anonymizeUserAclCore`-on.
 *
 * @param {Object} ctx
 * @returns {Promise<Object>} `{ success, action: 'anonymized_user_acl', stats }`
 */
async function anonymizeUserAcl(ctx) {
    const { callerId, payload, res, fail } = ctx;
    const dryRun = payload && payload.dryRun === true;
    const { organizationId: targetOrgId, targetUserId } = payload || {};

    if (!targetOrgId || typeof targetOrgId !== 'string') {
        return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
    }
    if (!targetUserId || typeof targetUserId !== 'string' || targetUserId.trim() !== targetUserId) {
        return fail(res, 400, 'missing_fields', { required: ['targetUserId'] });
    }

    // Auth (Harden Phase 2 HIGH fix, 2026-05-15): a public action ADMIN-ONLY —
    // self-path TILOS (a `callerId === targetUserId` ág korábban auth-gap volt:
    // egy authenticated user `targetUserId === callerId`-val ANY org-on
    // futtathatott anonymize-ot, beleértve azokat, ahol már nem tag).
    // Self-service GDPR cleanup CSAK a `leave_organization` / `delete_my_account`
    // flow-kból megengedett — azok a saját security guard-jaikkal autorizáltak,
    // és a `anonymizeUserAclCore`-t KÖZVETLENÜL hívják (NEM az action-en át).
    if (callerId === targetUserId) {
        return fail(res, 403, 'self_anonymize_disallowed', {
            hint: 'Self-service GDPR anonymize a leave_organization / delete_my_account flow-kból megengedett, NEM az anonymize_user_acl action közvetlen.'
        });
    }
    const denied = await requireOrgOwner(ctx, targetOrgId);
    if (denied) return denied;

    const result = await anonymizeUserAclCore(ctx, {
        organizationId: targetOrgId,
        targetUserId,
        dryRun,
        callerId
    });
    if (result.orgNotFound) return fail(res, 404, 'organization_not_found');
    if (result.orgFetchFailed) return fail(res, 500, 'organization_fetch_failed');

    return res.json({
        success: result.success,
        action: 'anonymized_user_acl',
        stats: result.stats
    });
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
                            stats.errors.push({ kind, phase: 'update', $id: doc.$id });
                        }
                    }
                },
                { batchSize: CASCADE_BATCH_LIMIT }
            );
        } catch (err) {
            error(`[BackfillMembershipUserNames] ${kind} list hiba: ${err.message}`);
            // S.13.3 Phase 1.5: NE szivárogtassunk raw err.message a kliens-response-ba.
            stats.errors.push({ kind, phase: 'list' });
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

    // 1) `status` enum attribútum — `provisioning` | `active` | `orphaned` | `archived`,
    // default `active`. Új org bootstrap-jén a `bootstrap_organization` és
    // `create_organization` action-ök automatikusan `active`-ot kapnak, KIVÉVE
    // ha az `ENABLE_PROVISIONING_GUARD` env-flag bekapcsolt → ekkor a flow
    // `'provisioning'`-szel indít és a flow-végen `'active'`-ra finalize-el
    // (S.7.8 phantom-org window mitigáció).
    //
    // S.7.8 Phase 1 (2026-05-15): az enum-bővítés `provisioning`-gal idempotens
    // — ha létezik (already exists), `updateEnumAttribute`-szel frissítjük a
    // 4-elem listára (Appwrite SDK `createEnumAttribute` NEM tudja BŐVÍTENI
    // a meglévő enum-ot, csak az `updateEnumAttribute` ad új elemeket).
    // Codex MAJOR fix (2026-05-15): a schema-bővítés MINDIG a CF action-eknél
    // ELŐBB kell deploy-olva legyen, különben a `bootstrap_organization`
    // `status: 'provisioning'` write 400 enum-validation-error-t adna élesben.
    const STATUS_ENUM = ['provisioning', 'active', 'orphaned', 'archived'];
    try {
        await databases.createEnumAttribute(
            env.databaseId,
            env.organizationsCollectionId,
            'status',
            STATUS_ENUM,
            false,        // required (false → default érvényes)
            'active',     // default
            false         // array
        );
        created.push('status');
    } catch (err) {
        if (isAlreadyExists(err)) {
            // Idempotens enum-bővítés — az új `provisioning` elem hozzáadása
            // a meglévő attribute-hoz. NEM no-op (a meglévő attribute-on
            // updateEnumAttribute frissít); a 2. futtatás zaj-mentes ha már
            // 4-elem.
            try {
                await databases.updateEnumAttribute(
                    env.databaseId,
                    env.organizationsCollectionId,
                    'status',
                    STATUS_ENUM,
                    false,        // required
                    'active',     // default
                    false         // array
                );
                skipped.push('status');
                log(`[BootstrapOrgStatus] status enum frissítve (provisioning hozzáadva): ${STATUS_ENUM.join(',')}`);
            } catch (updateErr) {
                error(`[BootstrapOrgStatus] status enum update hiba: ${updateErr.message}`);
                return fail(res, 500, 'schema_status_update_failed', { error: updateErr.message });
            }
        } else {
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
                        // S.13.3 (R.S.13.3 close, Phase 1): a `success: true` response
                        // `stats.errors[]` mezőbe NE szivárogtassunk raw err.message-et.
                        // Az orgId elég support-triage-hez, részletes hiba az error
                        // log-ban marad (PII-redacted Phase 1 wrap).
                        stats.errors.push({ orgId: orgDoc.$id });
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

/**
 * ACTION='verify_collection_document_security' (S.7.7b, 2026-05-15) — R.S.7.6 close.
 *
 * Olvassa a collection-meta `documentSecurity` flag-et a 6 user-data collection-en
 * (`articles`, `publications`, `layouts`, `deadlines`, `userValidations`,
 * `systemValidations`). Ha bármelyik flag NEM `true`, a S.7.7 frontend ACL fix
 * (doc-szintű `Permission.read(team:office_X)`) IGNORÁLÓDIK — collection-szintű
 * `read("users")` továbbra is rétegesen exponál cross-tenant.
 *
 * **ADR 0014 Layer 1 verify**: a 3-réteges defense-in-depth első rétege.
 * Layer 2 (`Permission.read(team:office_X)`) és Layer 3 (`withCreator`) NEM
 * tudnak segíteni, ha Layer 1 (collection `documentSecurity: true`) hiányzik.
 *
 * **Use case**: deploy-gate a S.7.7 production close ELŐTT (CF helper). Output
 * `criticalFail: true` → a deploy script bail-elhet és Appwrite Console-on
 * manuálisan kell beállítani a flag-et a hibás collection(ök)ön. S.13 logging
 * blokk később scheduled CF-re emelheti drift-monitoringra.
 *
 * **Read-only**: `databases.getCollection` lookup, nincs mutation. Biztonságos
 * gyakori futtatás.
 *
 * **Payload**:
 *   `{ action: 'verify_collection_document_security', organizationId, collections? }`
 *
 *   - `organizationId`: target org (auth scope, NEM olvas org-specific doc-ot).
 *   - `collections`: opcionális alias-tömb whitelistből. Default = a 6 required
 *     user-data collection (Codex Q1 NEEDS-WORK fix: hardcoded canonical scope).
 *     Whitelist = REQUIRED + OPTIONAL_DIAGNOSTIC (lásd `collectionMetadata.js`).
 *
 * **Auth**: target org `owner` (mint `backfill_acl_phase2`). Az action RO,
 * de a least-privilege + audit-trail (who-checked-what) ASVS V4.1.1.
 *
 * **Output**:
 *   `{ success: true, action: 'verified_collection_document_security',
 *      results: [{alias, collectionId, envVar, missingEnv, exists, documentSecurity,
 *                enabled, name, error: {code, message} | null}],
 *      summary: {total, secured, unsecured, missingEnv, missingCollection, errors},
 *      criticalFail: boolean }`
 *
 *   `criticalFail = true` ha BÁRMELY required collection: missingEnv, exists=false,
 *   vagy documentSecurity !== true (Codex BLOCKER fix: optional drift NEM blokkol).
 *
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function verifyCollectionDocumentSecurity(ctx) {
    const { databases, env, callerId, payload, log, res, fail } = ctx;
    const { organizationId: targetOrgId, collections: requestedRaw } = payload || {};

    if (!targetOrgId || typeof targetOrgId !== 'string') {
        return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
    }

    // Caller auth: target org owner (mint `backfill_acl_phase2`).
    const denied = await requireOrgOwner(ctx, targetOrgId);
    if (denied) return denied;

    // Default scope = REQUIRED user-data set (Codex Q1 fix: hardcoded canonical).
    //
    // Harden Phase 2 adversarial HIGH fix (2026-05-15): a caller-passed `collections`
    // paraméter NEM csökkentheti a verify scope-ot — különben egy `collections:
    // ['articles']` hívás `criticalFail: false`-t adna a másik 5 REQUIRED collection
    // ellenőrzése nélkül (false-pass deploy-gate, S.7.7 production close
    // védelem-megkerülés). MEGOLDÁS: a `collections` paraméter csak ADDITIVE —
    // a REQUIRED-set MINDIG benne van, a caller-passed alias-ok dedupe-olva
    // append-elődnek (csak az optional diagnostic alias-ok adnak új belépést).
    const defaultAliases = REQUIRED_SECURED_COLLECTIONS.map(c => c.alias);
    let aliases;
    if (requestedRaw === undefined || requestedRaw === null) {
        aliases = defaultAliases;
    } else if (!Array.isArray(requestedRaw)) {
        return fail(res, 400, 'invalid_collections', {
            hint: 'collections must be an array of alias strings (or omitted for default REQUIRED set)'
        });
    } else {
        const unknown = findUnknownAliases(requestedRaw);
        if (unknown.length > 0) {
            return fail(res, 400, 'unknown_collection_aliases', {
                unknown,
                allowed: [...ALL_KNOWN_ALIASES]
            });
        }
        // ADDITIVE: REQUIRED set MINDIG benne, caller-passed extras dedupe-olva.
        // Üres `collections: []` is OK — egyenértékű az omitted formával.
        const requiredSet = new Set(defaultAliases);
        const extras = requestedRaw.filter(a => !requiredSet.has(a));
        aliases = [...defaultAliases, ...extras];
    }

    let result;
    try {
        result = await verifyDocumentSecurity({ databases, env, aliases });
    } catch (err) {
        log(`[VerifyCollectionDocSec] hiba (caller=${callerId} org=${targetOrgId}): ${err.message}`);
        return fail(res, 500, 'verify_failed', { message: err.message });
    }

    // Audit log — caller + org + aliases + summary + criticalFail JSON.
    log(
        `[VerifyCollectionDocSec] caller=${callerId} org=${targetOrgId} `
        + `aliases=[${aliases.join(',')}] summary=${JSON.stringify(result.summary)} `
        + `criticalFail=${result.criticalFail}`
    );

    return res.json({
        success: true,
        action: 'verified_collection_document_security',
        results: result.results,
        summary: result.summary,
        criticalFail: result.criticalFail
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
    backfillAdminTeamAcl,
    // S.7.2 (2026-05-12) — R.S.7.2 close: legacy üres-permission doc-ok backfill-je
    // a S.7.1 fix-csomag 5 collection-én. Scope-paraméteres + user-read preserve.
    backfillAclPhase2,
    // S.7.7b (2026-05-15) — R.S.7.6 close: collection-meta `documentSecurity`
    // flag verify a 6 user-data collection-en (ADR 0014 Layer 1 prerequisite).
    // Read-only deploy-gate. Target-org-owner auth.
    verifyCollectionDocumentSecurity,
    // S.7.7c (2026-05-15) — R.S.7.7 close: legacy ACL backfill a 6 user-data
    // collection-en (publications + articles + layouts + deadlines + 2 validation).
    // Kategória 1/2 fallback policy + `fallbackUsedDocs` audit + 2-step JOIN
    // (articleId → publicationId → editorialOfficeId).
    backfillAclPhase3,
    // S.7.9 (2026-05-15) — R.S.7.5 close: GDPR Art. 17 stale `withCreator`
    // user-read cleanup a 12 collection-en. Self-anonymize + admin-anonymize
    // kettős auth. Idempotens (csak akkor ír, ha valódi perm eltávolítható).
    anonymizeUserAcl,
    // Core helper a self-service flow-knak (leave_organization + delete_my_account).
    // NEM hív res.json-t, visszaad {success, stats, orgNotFound?, orgFetchFailed?}.
    anonymizeUserAclCore
};
