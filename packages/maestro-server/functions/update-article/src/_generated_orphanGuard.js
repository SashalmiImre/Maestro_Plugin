/**
 * AUTO-GENERATED FILE — DO NOT EDIT.
 * Source: packages/maestro-shared/orphanGuard.js
 * Regenerate: yarn build:cf-orphan-guard
 *
 * A `packages/maestro-shared/orphanGuard.js` (ESM) a kanonikus forrás.
 * Ez a fájl egy CommonJS pillanatkép, hogy a CF deploy-időben elérhető
 * legyen (a workspace yarn link nem oldódik fel a CF runtime-on). A
 * generálást a `scripts/build-cf-orphan-guard.mjs` végzi (H.2, 2026-05-09).
 */
// Single-source orphan-guard helper az `organizations.status` enum-ot olvasó
// CF-eknek. Vanilla ES (named exports, no top-level await): a generator
// `_generated_orphanGuard.js`-ként emit-eli a CF-mappákba (build-cf-orphan-guard.mjs).
// Az `invite-to-organization/permissions.js` `getOrgStatus()` _belső_ verziója
// per-request cache + `env`-paraméterrel — más invariánsok, NEM cserélődik erre.
//
// Konvenciók:
//   - `null` return: legacy active (60+ legacy org backwards-compat).
//   - `'lookup_failed'`: env-hiány VAGY DB-hiba — fail-closed (NEM implicit active).

const ORG_STATUS = Object.freeze({
    ACTIVE: 'active',
    ORPHANED: 'orphaned',
    ARCHIVED: 'archived'
});

const ORG_STATUS_LOOKUP_FAILED = 'lookup_failed';

const _DENY_CACHEABLE_STATES = new Set([
    ORG_STATUS.ORPHANED,
    ORG_STATUS.ARCHIVED
]);

function isOrgWriteBlocked(status) {
    return _DENY_CACHEABLE_STATES.has(status) || status === ORG_STATUS_LOOKUP_FAILED;
}

// Csak DENY state-eket cache-elünk. Allow states (`active`, `null`) fresh-read,
// hogy az `active → orphaned` átmenet a warm CF-instance-okon azonnal hasson —
// a 30s allow-cache fail-open window volt (Harden Ph3, ADR 0011).
const _ORG_STATUS_CACHE = new Map();
const _ORG_STATUS_CACHE_TTL_MS = 30000;
const _ORG_STATUS_CACHE_MAX_ENTRIES = 1000;

function clearOrgStatusCache(organizationId) {
    if (organizationId) _ORG_STATUS_CACHE.delete(organizationId);
    else _ORG_STATUS_CACHE.clear();
}

/**
 * @param {Object}   databases               - `sdk.Databases(client)` példány
 * @param {string}   databaseId
 * @param {string}   organizationsCollectionId
 * @param {string}   organizationId
 * @param {Object}   sdk                     - `node-appwrite` modul (Query.select)
 * @returns {Promise<'active'|'orphaned'|'archived'|null|'lookup_failed'>}
 */
async function getOrgStatus(databases, databaseId, organizationsCollectionId, organizationId, sdk) {
    if (!organizationId) return null;
    if (!databaseId || !organizationsCollectionId) {
        return ORG_STATUS_LOOKUP_FAILED;
    }

    const cached = _ORG_STATUS_CACHE.get(organizationId);
    if (cached && (Date.now() - cached.at) < _ORG_STATUS_CACHE_TTL_MS) {
        return cached.value;
    }
    if (cached) _ORG_STATUS_CACHE.delete(organizationId);

    try {
        const orgDoc = await databases.getDocument(
            databaseId,
            organizationsCollectionId,
            organizationId,
            [sdk.Query.select(['$id', 'status'])]
        );
        const value = orgDoc?.status || null;
        if (_DENY_CACHEABLE_STATES.has(value)) {
            // Egyszerű FIFO eviction a CF warm-process unbounded-növekedés ellen.
            if (_ORG_STATUS_CACHE.size >= _ORG_STATUS_CACHE_MAX_ENTRIES) {
                const oldest = _ORG_STATUS_CACHE.keys().next().value;
                if (oldest !== undefined) _ORG_STATUS_CACHE.delete(oldest);
            }
            _ORG_STATUS_CACHE.set(organizationId, { value, at: Date.now() });
        }
        return value;
    } catch (e) {
        return ORG_STATUS_LOOKUP_FAILED;
    }
}

module.exports = {
    ORG_STATUS_LOOKUP_FAILED,
    ORG_STATUS,
    isOrgWriteBlocked,
    clearOrgStatusCache,
    getOrgStatus
};
