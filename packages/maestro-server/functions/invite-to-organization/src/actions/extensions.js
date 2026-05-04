// B.3.1 + B.3.2 (ADR 0007 Phase 0, 2026-05-04) — Workflow extension CRUD action-ok.
// Tartalmazza: create_workflow_extension, update_workflow_extension,
// archive_workflow_extension. A `restore_workflow_extension` SZÁNDÉKOSAN
// kimaradt — Codex tervi review (2026-05-04) scope-drift védelmében: a
// Feladatok.md / ADR 0007 csak az archive-ot említi; Phase 1+ fogja eldönteni,
// hogy szükséges-e külön restore action vagy az `update_workflow_extension`
// `archivedAt: null` payload-dal implicit visszaállít.
//
// Tilos import-irány: `actions/*` → `helpers/*` → `permissions.js` /
// `teamHelpers.js`. Visszafelé NEM (CommonJS ciklikus require csendben
// fél-inicializált exports-ot ad).

const acorn = require('acorn');

const {
    SLUG_REGEX,
    SLUG_MAX_LENGTH,
    sanitizeString
} = require('../helpers/util.js');
const {
    EXTENSION_KIND_VALUES,
    EXTENSION_SCOPE_VALUES,
    EXTENSION_SCOPE_DEFAULT,
    EXTENSION_NAME_MAX_LENGTH,
    EXTENSION_CODE_MAX_LENGTH,
    WORKFLOW_VISIBILITY_DEFAULT
} = require('../helpers/constants.js');
const { buildExtensionAclPerms } = require('../teamHelpers.js');
const permissions = require('../permissions.js');

// ── Lokális helper-ek ────────────────────────────────────────────────────────

/**
 * MAESTRO_EXTENSION_GLOBAL_NAME inline duplikátum (drift-rizikó).
 *
 * SYNC WITH: packages/maestro-shared/extensionContract.js
 *   (`MAESTRO_EXTENSION_GLOBAL_NAME` export, kanonikus érték `maestroExtension`).
 *
 * Phase 2 (A.7.5) megoldás: scripts/build-cf-extension-contract.mjs ESM → CJS
 * generátor — A.7.1 / A.7.3 mintát követve (build:cf-extension-contract +
 * check:cf-extension-contract yarn scriptek). A B.3 inline duplikációval
 * indul (Codex tervi review szándékos átmenet, dokumentált drift-komment).
 */
const MAESTRO_EXTENSION_GLOBAL_NAME = 'maestroExtension';

/**
 * Egységes extension `code` validátor (B.3.2 contract-validation).
 *
 * Lépések fail-fast sorrendben:
 *   1. típus-check: `code` string-nek kell lennie.
 *   2. üres / csak whitespace tiltott (a CF write-path defense-in-depth).
 *   3. hossz cap: `EXTENSION_CODE_MAX_LENGTH` (256 KB) — a schema 1 MB-ot
 *      enged, de a Phase 0 tipikus extension 5-50 KB; a 256 KB szigorúbb
 *      operatív cap (Codex tervi review).
 *   4. acorn ECMA3 pre-parse: az ExtendScript runtime ES3-as variánsa,
 *      ezért `ecmaVersion: 3` a legközelebbi node-oldali parse. `locations: true`
 *      hogy a runtime hibák line/column pozícióval jöjjenek.
 *   5. **AST-szintű ellenőrzés** (Codex adversarial review B.3 P1):
 *      regex önmagában (vagy a teljes parse) NEM bizonyítja, hogy van egy
 *      callable top-level `function maestroExtension(...)` deklaráció — egy
 *      stringbe ágyazott magic-text (pl. `var x = "function maestroExtension"`)
 *      vagy egy másik függvénybe ágyazott deklaráció átmenne. A Program.body
 *      tetején keresünk pontosan egy `FunctionDeclaration`-t, amelynek
 *      `id.name === 'maestroExtension'`. A futtatott runtime (`app.doScript`)
 *      a globális scope-ban hívja meg, ezért a top-level kötelező.
 *
 * @returns {{ valid: boolean, errors: Array<{code, message}> }}
 *   `valid: true` esetén az `errors` üres. A hívó CF action a
 *   `400 invalid_extension_code` reason-t ad vissza, az `errors`-t a
 *   payload-ba teszi (UI a 4-es lépés error-ban a parse-position-t mutatja).
 */
function validateExtensionCode(code) {
    if (typeof code !== 'string') {
        return {
            valid: false,
            errors: [{
                code: 'invalid_code_type',
                message: `Az extension code-nak string-nek kell lennie (kapott: ${typeof code}).`
            }]
        };
    }
    if (code.trim() === '') {
        return {
            valid: false,
            errors: [{
                code: 'empty_code',
                message: 'Az extension code nem lehet üres.'
            }]
        };
    }
    if (code.length > EXTENSION_CODE_MAX_LENGTH) {
        return {
            valid: false,
            errors: [{
                code: 'code_too_long',
                message: `Az extension code legfeljebb ${EXTENSION_CODE_MAX_LENGTH} karakter lehet (kapott: ${code.length}). A Phase 0 tipikus extension 5-50 KB; ha tényleg ennyi kód kell, bontsd több extension-re.`
            }]
        };
    }

    // ECMA3 közel áll az ExtendScript dialektushoz. A `sourceType: 'script'`
    // (default) globális scope-ban várja a `maestroExtension` deklarációt;
    // `module` mode tiltaná. `locations: true` hogy az AST-walking és a
    // hiba-pozíció is megfelelően működjön.
    let ast;
    try {
        ast = acorn.parse(code, {
            ecmaVersion: 3,
            sourceType: 'script',
            locations: true
        });
    } catch (parseErr) {
        return {
            valid: false,
            errors: [{
                code: 'syntax_error',
                message: `ExtendScript szintaxis hiba: ${parseErr.message}`,
                line: parseErr.loc?.line ?? null,
                column: parseErr.loc?.column ?? null
            }]
        };
    }

    // AST-szintű kötelező invariáns: a Program.body tetején van EGY
    // `FunctionDeclaration` `id.name === 'maestroExtension'`-szel. A
    // duplikátumot (ami a runtime-ban silent felülírná az elsőt) is
    // hibaként jelezzük — Codex P1 fix.
    const topLevelExtensionDecls = (ast.body || []).filter(node =>
        node.type === 'FunctionDeclaration'
        && node.id?.name === MAESTRO_EXTENSION_GLOBAL_NAME
    );
    if (topLevelExtensionDecls.length === 0) {
        return {
            valid: false,
            errors: [{
                code: 'missing_maestro_extension_function',
                message: `Az extension code-ban kötelező egy top-level "function ${MAESTRO_EXTENSION_GLOBAL_NAME}(input) { ... }" deklaráció — ez a Plugin runtime egyetlen belépési pontja. (Egy másik függvénybe ágyazott vagy var/expression-ben tárolt változat NEM elég.)`
            }]
        };
    }
    if (topLevelExtensionDecls.length > 1) {
        return {
            valid: false,
            errors: [{
                code: 'duplicate_maestro_extension_function',
                message: `Az extension code-ban pontosan EGY top-level "function ${MAESTRO_EXTENSION_GLOBAL_NAME}(...)" deklaráció lehet (kapott: ${topLevelExtensionDecls.length}). A duplikátumokat a runtime silent felülírná az utolsóval — fail-fast jobb.`,
                line: topLevelExtensionDecls[1].loc?.start?.line ?? null,
                column: topLevelExtensionDecls[1].loc?.start?.column ?? null
            }]
        };
    }
    return { valid: true, errors: [] };
}

/**
 * A `visibility` Phase 0-ban CSAK `editorial_office` lehet az extension-eken.
 * Codex tervi review (2026-05-04): non-default visibility-hez `extension.share`
 * slug kellene (nincs A.3.6 óta), különben egy `extension.create`-jogú user
 * `public` extension-t hozhatna létre — privilege-eszkalációs felület. A
 * Phase 1+ az ADR 0007 hatáskörébe tartozó share-flow-val rendezi.
 */
function assertVisibilityOrFail(ctx, visibility) {
    if (visibility !== undefined && visibility !== WORKFLOW_VISIBILITY_DEFAULT) {
        return ctx.fail(ctx.res, 400, 'unsupported_visibility', {
            allowed: [WORKFLOW_VISIBILITY_DEFAULT],
            note: `Phase 0 (ADR 0007) csak ${WORKFLOW_VISIBILITY_DEFAULT} visibility-t enged. A non-default scope-hoz Phase 1+ extension.share permission slug kell.`
        });
    }
    return null;
}

// ── ACTION='create_workflow_extension' (B.3.1) ──────────────────────────────

/**
 * Új workflow extension létrehozása.
 *
 * Auth: `extension.create` office-scope. Validáció: slug regex + name +
 * code shape (acorn ECMA3 pre-parse). Slug-ütközés: `office_slug_unique`
 * indexen → 409 `extension_slug_taken`. ACL: `buildExtensionAclPerms`.
 */
async function createWorkflowExtension(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, sdk, log, permissionEnv, permissionContext } = ctx;
    const { editorialOfficeId, kind } = payload;
    const sanitizedName = sanitizeString(payload.name, EXTENSION_NAME_MAX_LENGTH);
    const sanitizedSlug = sanitizeString(payload.slug, SLUG_MAX_LENGTH);
    const scope = payload.scope !== undefined ? payload.scope : EXTENSION_SCOPE_DEFAULT;
    const visibility = payload.visibility !== undefined ? payload.visibility : WORKFLOW_VISIBILITY_DEFAULT;

    if (!editorialOfficeId || !sanitizedName || !sanitizedSlug || !kind || payload.code === undefined) {
        return fail(res, 400, 'missing_fields', {
            required: ['editorialOfficeId', 'name', 'slug', 'kind', 'code']
        });
    }

    // Visibility Phase 0 fail-closed.
    const visibilityDenied = assertVisibilityOrFail(ctx, payload.visibility);
    if (visibilityDenied) return visibilityDenied;

    // Slug regex check (a sanitizeString a hosszat már levágta NULL-ra ha túl
    // hosszú — itt a SLUG_REGEX-szel adunk pontos hibát a UI-nak).
    if (!SLUG_REGEX.test(sanitizedSlug)) {
        return fail(res, 400, 'invalid_slug', {
            hint: 'slug must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/'
        });
    }

    // Enum validáció — a séma a `kind`-on enum-attribútumot kényszerít,
    // de fail-fast jobb kliens hibát adni (és a séma 500-ja helyett a CF
    // 400-at küld, hogy a UI különbséget tegyen "rossz payload" és
    // "deploy nincs kész" között).
    if (!EXTENSION_KIND_VALUES.includes(kind)) {
        return fail(res, 400, 'invalid_kind', {
            allowed: EXTENSION_KIND_VALUES
        });
    }
    if (!EXTENSION_SCOPE_VALUES.includes(scope)) {
        return fail(res, 400, 'invalid_scope', {
            allowed: EXTENSION_SCOPE_VALUES
        });
    }

    // Code contract-validation (B.3.2).
    const codeCheck = validateExtensionCode(payload.code);
    if (!codeCheck.valid) {
        return fail(res, 400, 'invalid_extension_code', {
            errors: codeCheck.errors
        });
    }

    // Auth a fetch ELŐTT — különben a 404/403 különbség office létezés-
    // oracle lenne unauthorized hívónak.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'extension.create',
        editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'extension.create',
            scope: 'office'
        });
    }

    // Office lookup → organizationId.
    let officeDoc;
    try {
        officeDoc = await databases.getDocument(env.databaseId, env.officesCollectionId, editorialOfficeId);
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'office_not_found');
        error(`[CreateWorkflowExtension] office fetch hiba: ${err.message}`);
        return fail(res, 500, 'office_fetch_failed');
    }

    // Doc create — `office_slug_unique` index 409.
    let newDoc;
    try {
        newDoc = await databases.createDocument(
            env.databaseId,
            env.workflowExtensionsCollectionId,
            sdk.ID.unique(),
            {
                name: sanitizedName,
                slug: sanitizedSlug,
                kind,
                scope,
                code: payload.code,
                visibility,
                editorialOfficeId,
                organizationId: officeDoc.organizationId,
                createdByUserId: callerId
            },
            buildExtensionAclPerms(visibility, officeDoc.organizationId, editorialOfficeId)
        );
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
            return fail(res, 409, 'extension_slug_taken', { slug: sanitizedSlug });
        }
        error(`[CreateWorkflowExtension] create hiba: ${err.message}`);
        return fail(res, 500, 'extension_create_failed');
    }

    log(`[CreateWorkflowExtension] User ${callerId} létrehozta a "${sanitizedName}" (${sanitizedSlug}) ${kind} extension-t az office ${editorialOfficeId}-ban (code.size=${payload.code.length})`);

    return res.json({
        success: true,
        action: 'created',
        extension: newDoc
    });
}

// ── ACTION='update_workflow_extension' (B.3.1) ──────────────────────────────

/**
 * Extension szerkesztése. A `slug` immutable (mint a többi domain-objektumnál).
 * Frissíthető: `name`, `kind`, `scope`, `code`, `visibility`, `archivedAt`.
 *
 * `archivedAt: null` engedett — Codex tervi review (2026-05-04): Phase 0-ban a
 * dedikált `restore_workflow_extension` kimaradt; az implicit visszaállítás
 * az `update_workflow_extension` payload `archivedAt: null` formában
 * (Phase 1+ vagy A.7.5 idején lehet külön action-é emelni).
 *
 * `expectedUpdatedAt` TOCTOU guard mintát követi.
 */
async function updateWorkflowExtension(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, log, permissionEnv, permissionContext } = ctx;
    const { extensionId } = payload;

    if (!extensionId) {
        return fail(res, 400, 'missing_fields', { required: ['extensionId'] });
    }
    if (payload.slug !== undefined) {
        return fail(res, 400, 'slug_immutable', {
            hint: 'Az extension slug-ja immutable. A frissíthető mezők: name, kind, scope, code, visibility, archivedAt.'
        });
    }

    // Doc fetch (auth-hoz a `editorialOfficeId` kell, és a TOCTOU guardhoz a
    // `$updatedAt`).
    let extensionDoc;
    try {
        extensionDoc = await databases.getDocument(
            env.databaseId, env.workflowExtensionsCollectionId, extensionId
        );
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'extension_not_found');
        error(`[UpdateWorkflowExtension] fetch hiba: ${err.message}`);
        return fail(res, 500, 'extension_fetch_failed');
    }

    // Auth — `extension.edit`. **A TOCTOU guard ELŐTT** (Codex verifying review
    // 2026-05-04 P1#3 follow-up): az `expectedUpdatedAt` mismatch 409 a fresh
    // `$updatedAt`-et közli az `actual` mezőben, ami egy unauthenticated
    // hívónak existence/timestamp oracle lenne. Az auth-otta priorizáljuk.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'extension.edit',
        extensionDoc.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'extension.edit',
            scope: 'office'
        });
    }

    // TOCTOU guard auth UTÁN — a fresh `$updatedAt` `actual` mezőjének
    // visszaadása csak jogosult hívónak engedett.
    if (payload.expectedUpdatedAt && payload.expectedUpdatedAt !== extensionDoc.$updatedAt) {
        return fail(res, 409, 'concurrent_modification', {
            actual: extensionDoc.$updatedAt,
            expected: payload.expectedUpdatedAt
        });
    }

    // Implicit restore (`archivedAt: null`) Codex adversarial review B.3 P1
    // fix: kettős auth. Egy `extension.edit`-jogú user, aki szándékosan NEM
    // kapott `extension.archive` slugot, NEM szabad, hogy a payload
    // `archivedAt: null`-jával implicit visszaállítson egy archivált
    // extension-t — különben a permission split a rendszer többi részén
    // (pl. permission set "tag-szintű" jogosultságok) tönkremenne.
    if (payload.archivedAt !== undefined) {
        const allowedArchive = await permissions.userHasPermission(
            databases,
            permissionEnv,
            callerUser,
            'extension.archive',
            extensionDoc.editorialOfficeId,
            permissionContext.snapshotsByOffice,
            permissionContext.orgRoleByOrg
        );
        if (!allowedArchive) {
            return fail(res, 403, 'insufficient_permission', {
                slug: 'extension.archive',
                scope: 'office',
                field: 'archivedAt',
                note: 'Az archivedAt mező módosítása (implicit restore) extension.archive jogosultságot is igényel az extension.edit mellé.'
            });
        }
    }

    // Selective update payload összeállítása.
    const updateFields = {};

    if (payload.name !== undefined) {
        const sanitizedName = sanitizeString(payload.name, EXTENSION_NAME_MAX_LENGTH);
        if (!sanitizedName) return fail(res, 400, 'invalid_name');
        updateFields.name = sanitizedName;
    }

    if (payload.kind !== undefined) {
        if (!EXTENSION_KIND_VALUES.includes(payload.kind)) {
            return fail(res, 400, 'invalid_kind', {
                allowed: EXTENSION_KIND_VALUES
            });
        }
        updateFields.kind = payload.kind;
    }

    if (payload.scope !== undefined) {
        if (!EXTENSION_SCOPE_VALUES.includes(payload.scope)) {
            return fail(res, 400, 'invalid_scope', {
                allowed: EXTENSION_SCOPE_VALUES
            });
        }
        updateFields.scope = payload.scope;
    }

    if (payload.code !== undefined) {
        const codeCheck = validateExtensionCode(payload.code);
        if (!codeCheck.valid) {
            return fail(res, 400, 'invalid_extension_code', {
                errors: codeCheck.errors
            });
        }
        updateFields.code = payload.code;
    }

    let visibilityChanged = false;
    if (payload.visibility !== undefined) {
        const visibilityDenied = assertVisibilityOrFail(ctx, payload.visibility);
        if (visibilityDenied) return visibilityDenied;
        if (payload.visibility !== extensionDoc.visibility) {
            updateFields.visibility = payload.visibility;
            visibilityChanged = true;
        }
    }

    if (payload.archivedAt !== undefined) {
        if (payload.archivedAt !== null) {
            return fail(res, 400, 'invalid_archivedAt', {
                hint: 'Csak null engedett (implicit restore). Az archive művelethez használd az archive_workflow_extension action-t.'
            });
        }
        updateFields.archivedAt = null;
    }

    if (Object.keys(updateFields).length === 0) {
        // Konzisztencia az `update_workflow_metadata`-val (ami `nothing_to_update`-et
        // ad). Codex tervi review (2026-05-04): ne adjunk silent `noop` success-t.
        return fail(res, 400, 'nothing_to_update');
    }

    // Visibility-váltás ACL újraszámolás (Phase 0-ban gyakorlatilag halott
    // ág a `unsupported_visibility` 400 miatt — defense-in-depth).
    let perms;
    if (visibilityChanged) {
        perms = buildExtensionAclPerms(
            updateFields.visibility,
            extensionDoc.organizationId,
            extensionDoc.editorialOfficeId
        );
    }

    let updated;
    try {
        updated = perms !== undefined
            ? await databases.updateDocument(
                env.databaseId,
                env.workflowExtensionsCollectionId,
                extensionId,
                updateFields,
                perms
            )
            : await databases.updateDocument(
                env.databaseId,
                env.workflowExtensionsCollectionId,
                extensionId,
                updateFields
            );
    } catch (err) {
        error(`[UpdateWorkflowExtension] update hiba: ${err.message}`);
        return fail(res, 500, 'extension_update_failed');
    }

    log(`[UpdateWorkflowExtension] User ${callerId} frissítette az extension-t ${extensionId} (${Object.keys(updateFields).join(', ')})`);

    return res.json({
        success: true,
        action: 'updated',
        extension: updated
    });
}

// ── ACTION='archive_workflow_extension' (B.3.1) ─────────────────────────────

/**
 * Soft-delete az extension-en — `archivedAt = now()`. Idempotens:
 * `already_archived` ha már archivált. NINCS blocker scan: az aktivált
 * publikációk a `compiledExtensionSnapshot`-ban tárolt verziót futtatják,
 * és a `extensionRegistry.js` resolver (B.4) a `archivedAt: null` szűrővel
 * szűri ki az archiváltakat a runtime-ról.
 *
 * **Restore**: az `update_workflow_extension` `archivedAt: null` payload-dal
 * implicit (Codex tervi review — dedikált `restore_workflow_extension` Phase 1+).
 *
 * Auth: `extension.archive` office-scope.
 */
async function archiveWorkflowExtension(ctx) {
    const { databases, env, callerId, callerUser, payload, error, res, fail, log, permissionEnv, permissionContext } = ctx;
    const { extensionId } = payload;

    if (!extensionId) {
        return fail(res, 400, 'missing_fields', { required: ['extensionId'] });
    }

    let extensionDoc;
    try {
        extensionDoc = await databases.getDocument(
            env.databaseId, env.workflowExtensionsCollectionId, extensionId
        );
    } catch (err) {
        if (err?.code === 404) return fail(res, 404, 'extension_not_found');
        error(`[ArchiveWorkflowExtension] fetch hiba: ${err.message}`);
        return fail(res, 500, 'extension_fetch_failed');
    }

    // Auth — `extension.archive` office-scope. **A TOCTOU guard ÉS az
    // idempotens `already_archived` ÉS minden válasz ELŐTT** (Codex
    // adversarial review B.3 P1 + P1#3 follow-up):
    //   1. Az idempotens fetch leak: egy nem-`extension.archive`-jogú user
    //      megtudhatná egy archivált extension létezését + tartalmát.
    //   2. A TOCTOU 409 `actual: $updatedAt` mismatch existence/timestamp
    //      oracle lenne unauthenticated callernek.
    // Mindkét leak-et a kora-auth lezárja.
    const allowed = await permissions.userHasPermission(
        databases,
        permissionEnv,
        callerUser,
        'extension.archive',
        extensionDoc.editorialOfficeId,
        permissionContext.snapshotsByOffice,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        return fail(res, 403, 'insufficient_permission', {
            slug: 'extension.archive',
            scope: 'office'
        });
    }

    // TOCTOU guard auth UTÁN.
    if (payload.expectedUpdatedAt && payload.expectedUpdatedAt !== extensionDoc.$updatedAt) {
        return fail(res, 409, 'concurrent_modification', {
            actual: extensionDoc.$updatedAt,
            expected: payload.expectedUpdatedAt
        });
    }

    // Idempotens állapot-check (auth + TOCTOU UTÁN).
    const isCurrentlyArchived = extensionDoc.archivedAt !== null && extensionDoc.archivedAt !== undefined;
    if (isCurrentlyArchived) {
        return res.json({
            success: true,
            action: 'already_archived',
            extension: extensionDoc
        });
    }

    let updated;
    try {
        updated = await databases.updateDocument(
            env.databaseId,
            env.workflowExtensionsCollectionId,
            extensionId,
            { archivedAt: new Date().toISOString() }
        );
    } catch (err) {
        error(`[ArchiveWorkflowExtension] update hiba: ${err.message}`);
        return fail(res, 500, 'extension_archive_failed');
    }

    log(`[ArchiveWorkflowExtension] User ${callerId} archiválta az extension-t ${extensionId} (slug=${extensionDoc.slug})`);

    return res.json({
        success: true,
        action: 'archived',
        extension: updated
    });
}

module.exports = {
    createWorkflowExtension,
    updateWorkflowExtension,
    archiveWorkflowExtension,
    // B.3.3 (activate_publication snapshot logikának reuse-ra)
    validateExtensionCode
};
