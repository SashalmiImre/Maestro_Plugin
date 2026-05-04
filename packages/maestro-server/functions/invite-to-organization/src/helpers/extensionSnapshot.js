// B.3.3 (ADR 0007 Phase 0, 2026-05-04) — Workflow extension snapshot helper.
//
// Az `activate_publication` (és a `validate-publication-update` post-event CF
// inline duplikációja) ezt a helpert használja a `compiledExtensionSnapshot`
// mező összerakásához. A snapshot célja: az aktivált publikáció a workflow
// `compiled` JSON-ban hivatkozott extension-ök kódját pillanatképként rögzíti,
// így a runtime immune marad utólagos `update_workflow_extension` változásokra
// (a `compiledWorkflowSnapshot` mintáját követi, ld. Feladat #37).
//
// SYNC WITH: a `validate-publication-update` CF inline `extractExtensionRefs`
// + `buildExtensionSnapshot` duplikációja (külön CF, NEM tud importolni a
// `invite-to-organization`-ból). Drift-rizikó kommentelve a duplikátum-fájlon.
//
// Tilos import-irány: `helpers/*` → `permissions.js` / `teamHelpers.js`.

const {
    EXTENSION_SNAPSHOT_MAX_BYTES
} = require('./constants.js');

const EXTENSION_REF_PREFIX = 'ext.';

/**
 * Egy workflow `compiled` JSON-ben szereplő extension-hivatkozás-string
 * felbontása `{slug}` alakra. NEM kanonikus (a shared `parseExtensionRef`
 * az), itt egyszerű prefix-strip — a Designer save-time + B.3 CF write-path
 * már garantálta a slug-formátumot.
 *
 * @param {string} ref - workflow JSON string-hivatkozás (pl. `"ext.foo"`)
 * @returns {string|null} a slug, vagy null ha a ref nem `ext.<slug>` alakú string
 */
function parseExtRef(ref) {
    if (typeof ref !== 'string') return null;
    if (!ref.startsWith(EXTENSION_REF_PREFIX)) return null;
    const slug = ref.slice(EXTENSION_REF_PREFIX.length);
    return slug.length > 0 ? slug : null;
}

/**
 * Workflow `compiled` JSON scan: extract minden `ext.<slug>` hivatkozást a
 * `validations[]` (state → `onEntry`/`requiredToEnter`/`requiredToExit`) és
 * `commands[]` (state → `[{id, allowedGroups}]`) struktúrákból.
 *
 * **Kind-konzisztencia invariáns** (Codex tervi review 2026-05-04):
 * - `validations.*` listáiban csak `kind: 'validator'` extension lehet.
 * - `commands.*` listáiban csak `kind: 'command'` extension lehet.
 *
 * A return két különálló `Set<slug>` — a hívó később `kind` ellenőrzéshez
 * használja, és a hiányzó / kind-inkonzisztens slugokat a 422 error-be teszi.
 *
 * **Validation item shape** (defaultWorkflow.json + workflow Designer):
 *   - egyszerű string: `"file_accessible"` vagy `"ext.foo"` — a teljes slug
 *   - object: `{ validator: 'slug', options: {...} }` — a `validator` mező értéke
 *
 * **Command item shape**: `{ id: 'cmd_slug' | 'ext.foo', allowedGroups: [] }`.
 *
 * @param {object} compiled - parsed workflow compiled JSON
 * @returns {{ validatorSlugs: Set<string>, commandSlugs: Set<string> }}
 */
function extractExtensionRefs(compiled) {
    const validatorSlugs = new Set();
    const commandSlugs = new Set();

    if (!compiled || typeof compiled !== 'object') {
        return { validatorSlugs, commandSlugs };
    }

    // 1. validations (state → { onEntry, requiredToEnter, requiredToExit })
    const validations = compiled.validations;
    if (validations && typeof validations === 'object') {
        for (const stateName of Object.keys(validations)) {
            const stateGroup = validations[stateName];
            if (!stateGroup || typeof stateGroup !== 'object') continue;
            for (const lane of ['onEntry', 'requiredToEnter', 'requiredToExit']) {
                const items = stateGroup[lane];
                if (!Array.isArray(items)) continue;
                for (const item of items) {
                    if (typeof item === 'string') {
                        const slug = parseExtRef(item);
                        if (slug) validatorSlugs.add(slug);
                    } else if (item && typeof item === 'object'
                        && typeof item.validator === 'string') {
                        const slug = parseExtRef(item.validator);
                        if (slug) validatorSlugs.add(slug);
                    }
                }
            }
        }
    }

    // 2. commands (state → [{ id, allowedGroups }])
    const commands = compiled.commands;
    if (commands && typeof commands === 'object') {
        for (const stateName of Object.keys(commands)) {
            const stateList = commands[stateName];
            if (!Array.isArray(stateList)) continue;
            for (const item of stateList) {
                if (typeof item === 'string') {
                    const slug = parseExtRef(item);
                    if (slug) commandSlugs.add(slug);
                } else if (item && typeof item === 'object'
                    && typeof item.id === 'string') {
                    const slug = parseExtRef(item.id);
                    if (slug) commandSlugs.add(slug);
                }
            }
        }
    }

    return { validatorSlugs, commandSlugs };
}

/**
 * Office-szűrt extension lookup a `workflowExtensions` collection-ből.
 * `archivedAt: null` szűrőt nem teszünk a query-be (Appwrite `Query.isNull`
 * kompatibilitás miatt fail-fast a hívóban — a `archivedAt`-ot a callback
 * kéri vissza, és a hívó dönti el, hogy egy archivált extension-t használhat-e).
 *
 * **Slug paginalt batch lookup** — Appwrite `Query.equal` egy értékre szűr,
 * ezért egy `Query.contains('slug', [...])` jellegű set-lookup nincs; helyette
 * a paginált listDocuments minden office-szintű extension-t betölt, és a
 * Set-szűrést memóriában végezzük. Az office-szintű extension-szám
 * (várhatóan ≤ 100) bőven elfér egyetlen lapozási körben.
 *
 * @param {object} databases
 * @param {object} env - { databaseId, workflowExtensionsCollectionId }
 * @param {object} sdk - node-appwrite SDK
 * @param {string} editorialOfficeId
 * @param {Set<string>} requestedSlugs - a slug halmaz, amit szűrünk
 * @returns {Promise<Map<string, object>>} slug → extension doc (csak nem-archivált)
 */
async function fetchExtensionsForOffice(databases, env, sdk, editorialOfficeId, requestedSlugs) {
    if (requestedSlugs.size === 0) return new Map();

    const result = new Map();
    let cursor = null;
    while (true) {
        const queries = [
            sdk.Query.equal('editorialOfficeId', editorialOfficeId),
            sdk.Query.limit(100)
        ];
        if (cursor) queries.push(sdk.Query.cursorAfter(cursor));

        const batch = await databases.listDocuments(
            env.databaseId,
            env.workflowExtensionsCollectionId,
            queries
        );
        if (batch.documents.length === 0) break;
        for (const doc of batch.documents) {
            if (requestedSlugs.has(doc.slug) && !doc.archivedAt) {
                result.set(doc.slug, doc);
            }
        }
        if (batch.documents.length < 100) break;
        cursor = batch.documents[batch.documents.length - 1].$id;
    }
    return result;
}

/**
 * Workflow `compiled` JSON-ből → `compiledExtensionSnapshot` JSON string.
 *
 * Lépések fail-fast sorrendben:
 *   1. `extractExtensionRefs(compiled)` — minden `ext.<slug>` hivatkozás
 *      kigyűjtése `{validatorSlugs, commandSlugs}` Set-ekbe.
 *   2. Egységes union halmaz a fetch-hez (egy DB lookup, ne kétszeres).
 *   3. `fetchExtensionsForOffice` — office-szűrt + nem-archivált extension-ök
 *      (slug → doc map).
 *   4. **Hiányzó hivatkozás → 422 fail-fast** (`missing_extension_references`).
 *      A kiméletlen aktiváló-policy-t Codex tervi review (2026-05-04) erősítette
 *      meg: a `compiledWorkflowSnapshot` runtime-konzisztenciája nem
 *      maradhat fenn, ha hivatkozott extension-kód hiányzik.
 *   5. **Kind-konzisztencia invariáns** — a `validations[]` slug-jainak
 *      `kind: 'validator'`, a `commands[]`-nek `kind: 'command'`. Eltérés
 *      → 422 `extension_kind_mismatch`.
 *   6. JSON map serializálás `{[slug]: { name, kind, scope, code }}` —
 *      a `code` mezőt a runtime futtatja, a többi metadata a UI-nak +
 *      a guard logikának kell.
 *   7. Aggregate méret-cap: `EXTENSION_SNAPSHOT_MAX_BYTES`. A schema 1 MB-ot
 *      enged, a 800 KB margin a snapshot-mező egyéb felhasználására (jövőbeli
 *      Phase 1+ paramSchema, kompatibilitási header).
 *
 * @returns {Promise<{ ok: true, snapshot: string, refs: object } | { ok: false, status: number, reason: string, payload: object }>}
 *   Normalizált eredmény — a hívó `if (!result.ok) return fail(...)`.
 */
async function buildExtensionSnapshot(databases, env, sdk, compiled, editorialOfficeId) {
    const { validatorSlugs, commandSlugs } = extractExtensionRefs(compiled);
    const allSlugs = new Set([...validatorSlugs, ...commandSlugs]);

    if (allSlugs.size === 0) {
        // Nincs extension-hivatkozás — üres JSON map, hogy a snapshot mező
        // explicit "0 extension" állapotot rögzítsen (NEM null), ami
        // különbözik a B.3 előtti legacy (null) állapottól.
        return {
            ok: true,
            snapshot: '{}',
            refs: { validatorSlugs: [], commandSlugs: [] }
        };
    }

    const extensionsBySlug = await fetchExtensionsForOffice(
        databases, env, sdk, editorialOfficeId, allSlugs
    );

    // 4. Missing reference scan.
    const missing = [];
    for (const slug of allSlugs) {
        if (!extensionsBySlug.has(slug)) missing.push(slug);
    }
    if (missing.length > 0) {
        return {
            ok: false,
            status: 422,
            reason: 'missing_extension_references',
            payload: {
                missing,
                note: 'A workflow olyan extension-slugokra hivatkozik, amelyek nem találhatók (vagy archiváltak) ebben a szerkesztőségben. Hozd létre az extension-öket, vagy állítsd vissza az archiváltakat, mielőtt aktiválod a publikációt.'
            }
        };
    }

    // 5. Kind-konzisztencia invariáns.
    const kindMismatches = [];
    for (const slug of validatorSlugs) {
        const doc = extensionsBySlug.get(slug);
        if (doc.kind !== 'validator') {
            kindMismatches.push({
                slug,
                expected: 'validator',
                actual: doc.kind,
                lane: 'validations'
            });
        }
    }
    for (const slug of commandSlugs) {
        const doc = extensionsBySlug.get(slug);
        if (doc.kind !== 'command') {
            kindMismatches.push({
                slug,
                expected: 'command',
                actual: doc.kind,
                lane: 'commands'
            });
        }
    }
    if (kindMismatches.length > 0) {
        return {
            ok: false,
            status: 422,
            reason: 'extension_kind_mismatch',
            payload: {
                mismatches: kindMismatches,
                note: 'A workflow validations[] listájában csak validator-kind extension lehet, commands[] listájában csak command-kind. Javítsd a workflow-t vagy az extension `kind` mezőjét.'
            }
        };
    }

    // 6. JSON map serializálás. A slug-key sortolt, hogy a snapshot
    // determinisztikus legyen (idempotens aktiválás-egyezés string-comparison).
    const sortedSlugs = [...allSlugs].sort();
    const snapshotMap = {};
    for (const slug of sortedSlugs) {
        const doc = extensionsBySlug.get(slug);
        snapshotMap[slug] = {
            name: doc.name,
            kind: doc.kind,
            scope: doc.scope,
            code: doc.code
        };
    }
    const snapshot = JSON.stringify(snapshotMap);

    // 7. Aggregate méret-cap.
    if (snapshot.length > EXTENSION_SNAPSHOT_MAX_BYTES) {
        return {
            ok: false,
            status: 422,
            reason: 'extension_snapshot_too_large',
            payload: {
                snapshotBytes: snapshot.length,
                limitBytes: EXTENSION_SNAPSHOT_MAX_BYTES,
                slugCount: sortedSlugs.length,
                note: `A workflow által hivatkozott extension-ök együttes mérete (${snapshot.length} byte) meghaladja a snapshot-cap-et (${EXTENSION_SNAPSHOT_MAX_BYTES} byte). Csökkentsd valamelyik extension code méretét, vagy bontsd több részre.`
            }
        };
    }

    return {
        ok: true,
        snapshot,
        refs: {
            validatorSlugs: [...validatorSlugs],
            commandSlugs: [...commandSlugs]
        }
    };
}

module.exports = {
    extractExtensionRefs,
    fetchExtensionsForOffice,
    buildExtensionSnapshot,
    EXTENSION_REF_PREFIX
};
