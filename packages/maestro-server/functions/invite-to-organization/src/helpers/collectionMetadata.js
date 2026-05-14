// S.7.7b (2026-05-15) — R.S.7.6 close.
//
// Collection-meta whitelist + `documentSecurity` flag verify helper a
// `verify_collection_document_security` action számára. ADR 0014 Layer 1
// prerequisite check: ha a collection `documentSecurity` flag NEM `true`, a
// doc-szintű ACL (Layer 2 `Permission.read(team:office_X)` + Layer 3
// `withCreator`) IGNORÁLÓDIK — collection-szintű `read("users")` cross-tenant
// szivárgás marad.
//
// **REQUIRED set**: a S.7.7 frontend ACL fix 6 user-data collection-je. Ezek
// bármelyikén `documentSecurity !== true` → `criticalFail: true` → deploy
// bail. **Optional diagnostic set**: a server-side `createDocument`-mintán
// futó tenant collection-ök (organizations, memberships, stb.) — kontroll-
// drift észlelhető, de NEM blokkolja a S.7.7 production deploy-t.
//
// Codex pre-review (2026-05-15) Q1 NEEDS-WORK fix: a default scope HARDCOLT
// a 6 REQUIRED collection-re — a caller-passed `collections` paraméter csak
// override-olhatja whitelistből, NEM tudja "véletlenül" 5/6-re csökkenteni.

'use strict';

// 6 user-data collection — ezek a S.7.7 frontend ACL fix scope-ja.
// Sorrend determinisztikus output rendezéshez (Codex MINOR fix).
const REQUIRED_SECURED_COLLECTIONS = Object.freeze([
    Object.freeze({ alias: 'articles',          envVar: 'ARTICLES_COLLECTION_ID',           envKey: 'articlesCollectionId' }),
    Object.freeze({ alias: 'publications',      envVar: 'PUBLICATIONS_COLLECTION_ID',       envKey: 'publicationsCollectionId' }),
    Object.freeze({ alias: 'layouts',           envVar: 'LAYOUTS_COLLECTION_ID',            envKey: 'layoutsCollectionId' }),
    Object.freeze({ alias: 'deadlines',         envVar: 'DEADLINES_COLLECTION_ID',          envKey: 'deadlinesCollectionId' }),
    Object.freeze({ alias: 'userValidations',   envVar: 'USER_VALIDATIONS_COLLECTION_ID',   envKey: 'userValidationsCollectionId' }),
    Object.freeze({ alias: 'systemValidations', envVar: 'SYSTEM_VALIDATIONS_COLLECTION_ID', envKey: 'systemValidationsCollectionId' })
]);

// Opcionális diagnostic collection-ök — server-side CF createDocument-ekkel
// jönnek létre, de a `documentSecurity` drift-monitoringhoz hasznos verify.
// NEM blokkolja a `criticalFail`-t (Codex BLOCKER fix).
const OPTIONAL_DIAGNOSTIC_COLLECTIONS = Object.freeze([
    Object.freeze({ alias: 'organizations',              envVar: 'ORGANIZATIONS_COLLECTION_ID',              envKey: 'organizationsCollectionId' }),
    Object.freeze({ alias: 'organizationMemberships',    envVar: 'ORGANIZATION_MEMBERSHIPS_COLLECTION_ID',   envKey: 'membershipsCollectionId' }),
    Object.freeze({ alias: 'editorialOffices',           envVar: 'EDITORIAL_OFFICES_COLLECTION_ID',          envKey: 'officesCollectionId' }),
    Object.freeze({ alias: 'editorialOfficeMemberships', envVar: 'EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID', envKey: 'officeMembershipsCollectionId' }),
    Object.freeze({ alias: 'groups',                     envVar: 'GROUPS_COLLECTION_ID',                     envKey: 'groupsCollectionId' }),
    Object.freeze({ alias: 'groupMemberships',           envVar: 'GROUP_MEMBERSHIPS_COLLECTION_ID',          envKey: 'groupMembershipsCollectionId' })
]);

// Whitelist all known aliases — strict reject ismeretlen alias-ra (Codex MAJOR fix).
const ALL_KNOWN_ALIASES = Object.freeze(new Set([
    ...REQUIRED_SECURED_COLLECTIONS.map(c => c.alias),
    ...OPTIONAL_DIAGNOSTIC_COLLECTIONS.map(c => c.alias)
]));

// Alias → metadata Map. `required: true` jelöli a deploy-blocker scope-ot.
const ALIAS_TO_META = (() => {
    const m = new Map();
    for (const c of REQUIRED_SECURED_COLLECTIONS) m.set(c.alias, Object.freeze({ ...c, required: true }));
    for (const c of OPTIONAL_DIAGNOSTIC_COLLECTIONS) m.set(c.alias, Object.freeze({ ...c, required: false }));
    return m;
})();

/**
 * Whitelist validation: caller-passed alias-tömb vs ismert kulcsok.
 * Codex MAJOR fix: ismeretlen alias-t NEM engedünk át (random Appwrite
 * Console collection enum prevention).
 *
 * @param {unknown} aliases - caller-passed lista (lehet bármilyen érték)
 * @returns {string[]} unknown aliases (üres tömb ha mind valid)
 */
function findUnknownAliases(aliases) {
    if (!Array.isArray(aliases)) return [];
    return aliases.filter(a => typeof a !== 'string' || !ALL_KNOWN_ALIASES.has(a));
}

/**
 * Resolve alias → collection ID env-en keresztül.
 *
 * Codex MAJOR fix: a missing env var explicit külön hibakód-osztály
 * (NEM "collection not found" — az konfigurációs hiba, NEM Appwrite-state).
 *
 * @param {string} alias - whitelistezett alias
 * @param {Object} env - ctx.env objektum
 * @returns {{ collectionId: string | null, envVar: string, missingEnv: boolean }}
 * @throws ha az alias ismeretlen (NEM várt: a hívó már whitelistezte)
 */
function resolveCollectionId(alias, env) {
    const meta = ALIAS_TO_META.get(alias);
    if (!meta) {
        throw new Error(`resolveCollectionId: unknown alias '${alias}'`);
    }
    const collectionId = env && typeof env === 'object' ? env[meta.envKey] : null;
    const missingEnv = !collectionId || typeof collectionId !== 'string' || collectionId.length === 0;
    return {
        collectionId: missingEnv ? null : collectionId,
        envVar: meta.envVar,
        missingEnv
    };
}

/**
 * Paralel `databases.getCollection` lookup minden megadott alias-ra.
 * Determinisztikus output rendezés (input alias-sorrend megőrzött — Codex MINOR fix).
 *
 * Hibakód-osztályok (Codex MAJOR fix — szétválasztva):
 *   - `missingEnv: true` → CF env var hiányzik (configuration failure)
 *   - `exists: false` + `error.code: 404` → collection NEM létezik Appwrite-on
 *   - `error: {code, message}` → egyéb SDK hiba (perm denied, network)
 *
 * `criticalFail` (Codex BLOCKER fix): CSAK a REQUIRED-set kifogásai blokkolnak.
 * Optional diagnostic drift NEM blokkolja a deploy-t.
 *
 * @param {Object} params
 * @param {Object} params.databases - sdk.Databases példány
 * @param {Object} params.env - ctx.env (collection ID-kkel)
 * @param {string[]} params.aliases - whitelistezett alias-tömb
 * @returns {Promise<{ results: Array, summary: Object, criticalFail: boolean }>}
 */
async function verifyDocumentSecurity({ databases, env, aliases }) {
    const databaseId = env && env.databaseId;
    if (!databaseId) {
        throw new Error('verifyDocumentSecurity: env.databaseId required');
    }

    const lookups = await Promise.all(aliases.map(async (alias) => {
        const { collectionId, envVar, missingEnv } = resolveCollectionId(alias, env);
        if (missingEnv) {
            return {
                alias,
                collectionId: null,
                envVar,
                missingEnv: true,
                exists: false,
                documentSecurity: null,
                enabled: null,
                name: null,
                error: null
            };
        }
        try {
            const col = await databases.getCollection(databaseId, collectionId);
            return {
                alias,
                collectionId,
                envVar,
                missingEnv: false,
                exists: true,
                documentSecurity: col && col.documentSecurity === true,
                enabled: col && col.enabled === true,
                name: (col && col.name) || null,
                error: null
            };
        } catch (err) {
            // Appwrite SDK error shape preserve (Harden Phase 6 verifying P3 fix,
            // 2026-05-15): `type` mező kell a 404 detekcióhoz, mert egyes
            // SDK / runtime kombinációkban a `code` HTTP-status int, máskor a
            // `type` az Appwrite-specifikus diszkriminátor (`collection_not_found`).
            // Mindkettőt preserve-eljük, és a summary loop bármelyiket elfogadja.
            return {
                alias,
                collectionId,
                envVar,
                missingEnv: false,
                exists: false,
                documentSecurity: null,
                enabled: null,
                name: null,
                error: {
                    code: (err && err.code) || null,
                    type: (err && err.type) || null,
                    message: (err && err.message) || String(err)
                }
            };
        }
    }));

    // Determinisztikus rendezés: Promise.all preserve-eli az input-sorrendet.
    const results = lookups;

    // Summary.
    // Harden Phase 1 baseline P2 fix (2026-05-15): a 404-es lookup-failure
    // a `missingCollection` ágba megy, NEM az `errors`-be. Egy delete-elt vagy
    // elgépelt collection ID a deploy-gate output-ban a "configured collection
    // ID does not exist" diagnostikai üzenetet érdemli (a `errors` ág
    // a generic perm-denied / network / 5xx hibákra). Appwrite SDK 404 →
    // `err.code === 404` (HTTP status) vagy `err.type === 'collection_not_found'`.
    let secured = 0, unsecured = 0, missingEnv = 0, missingCollection = 0, errors = 0;
    for (const r of results) {
        if (r.missingEnv) {
            missingEnv++;
        } else if (r.error) {
            if (r.error.code === 404 || r.error.type === 'collection_not_found') {
                missingCollection++;
            } else {
                errors++;
            }
        } else if (!r.exists) {
            // Defensive fallback — a mapper invariáns szerint a sikertelen lookup
            // `error`-t set-tel, így ez az ág gyakorlatban unreachable.
            missingCollection++;
        } else if (r.documentSecurity === true) {
            secured++;
        } else {
            unsecured++;
        }
    }
    const summary = {
        total: results.length,
        secured,
        unsecured,
        missingEnv,
        missingCollection,
        errors
    };

    // `criticalFail` CSAK REQUIRED-set kifogásai (Codex BLOCKER) — bármely fail-
    // osztály (missingEnv | error | !exists | documentSecurity !== true) trigger.
    const criticalFail = results.some(r => {
        const meta = ALIAS_TO_META.get(r.alias);
        if (!meta || !meta.required) return false;
        return r.missingEnv || r.error || !r.exists || r.documentSecurity !== true;
    });

    return { results, summary, criticalFail };
}

// Csak a külső consumer-ek (jelenleg `actions/schemas.js`) által ténylegesen
// használt szimbólumok exportja — encapsulation. `OPTIONAL_DIAGNOSTIC_COLLECTIONS`,
// `ALIAS_TO_META`, `resolveCollectionId` internal-only, a `verifyDocumentSecurity`
// belső hívja a `findUnknownAliases` viszont a hívóhelyen kell a 400 reject-hez.
module.exports = {
    REQUIRED_SECURED_COLLECTIONS,
    ALL_KNOWN_ALIASES,
    findUnknownAliases,
    verifyDocumentSecurity
};
