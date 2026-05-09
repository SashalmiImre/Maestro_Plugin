/**
 * H.2 (Phase 2, 2026-05-09) — single-source orphan-guard helper.
 *
 * Az `organizations.status` 3-érték enumot olvasó CF-ek (`set-publication-root-path`,
 * `update-article`, `validate-publication-update` audit-only) Phase 1.6 fail-closed
 * írás-blokkolójához. A korábbi inline mása a 2 fő CF-ben drift-veszélyes — ez a
 * shared modul a kanonikus forrás, a `scripts/build-cf-orphan-guard.mjs` generálja
 * a CF-mappákba `_generated_orphanGuard.js`-ként a `compiledValidator.js` mintájára.
 *
 * **Vanilla ES kötelező** — csak named-export function / const. Top-level await,
 * dynamic import-call, ESM module-meta tilos. A generator post-transform
 * token-guarddal véd a drift ellen.
 *
 * **Signature kontraktus** (SDK-paraméter): a hívó saját sdk-példányát adja át.
 * Az `invite-to-organization` `permissions.js` `getOrgStatus()` _belső_ verziója
 * (per-request cache + `env`-paraméter) NEM cserélődik erre — más kontextus,
 * más invariánsok.
 *
 * Konvenciók:
 *   - `null` return → legacy active (60+ legacy org backwards-compat).
 *   - `'lookup_failed'` → env-hiány VAGY DB-hiba sentinel — fail-closed.
 *   - Codex MAJOR fix (2026-05-09): NE legyen implicit `active` fallback DB-hibára.
 */

export const ORG_STATUS = Object.freeze({
    ACTIVE: 'active',
    ORPHANED: 'orphaned',
    ARCHIVED: 'archived'
});

export const ORG_STATUS_LOOKUP_FAILED = 'lookup_failed';

export function isOrgWriteBlocked(status) {
    return status === ORG_STATUS.ORPHANED
        || status === ORG_STATUS.ARCHIVED
        || status === ORG_STATUS_LOOKUP_FAILED;
}

// F.9 (Phase 2, 2026-05-09) — module-szintű hot-path cache.
//
// A `update-article` és `set-publication-root-path` CF-eken minden hívás
// extra `getDocument`-et futtatott a Phase 1.6 orphan-guard-on. Egy CF
// warm-szakasz alatt (perces-órás) ugyanaz az org-status sokszor lekérdezésre
// kerül — a TTL-cache ezt egy szintetikus DB-readre redukálja per-org.
//
// Invalidálás: a `transfer_orphaned_org_ownership` (recovery flow, másik CF)
// `orphaned → active` transition után az itt rögzült érték elavul. A 30s
// TTL elfogadható késleltetés (admin-felügyelt recovery; a user retry-olja a
// blokkolt írást, vagy a 30s-on belül a CF cold-startol).
//
// `lookup_failed` szándékosan NEM cache-elt — transient (env-flap, DB-glitch),
// a következő hívás újraprobálkozik.
const _ORG_STATUS_CACHE = new Map();
const _ORG_STATUS_CACHE_TTL_MS = 30000;

export function clearOrgStatusCache(organizationId) {
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
export async function getOrgStatus(databases, databaseId, organizationsCollectionId, organizationId, sdk) {
    if (!organizationId) return null;
    if (!databaseId || !organizationsCollectionId) {
        return ORG_STATUS_LOOKUP_FAILED;
    }

    // F.9 hot-path cache — TTL-alapú, transient hibákra fallback DB-fetch.
    const cached = _ORG_STATUS_CACHE.get(organizationId);
    if (cached && (Date.now() - cached.at) < _ORG_STATUS_CACHE_TTL_MS) {
        return cached.value;
    }

    try {
        const orgDoc = await databases.getDocument(
            databaseId,
            organizationsCollectionId,
            organizationId,
            [sdk.Query.select(['$id', 'status'])]
        );
        const value = orgDoc?.status || null;
        _ORG_STATUS_CACHE.set(organizationId, { value, at: Date.now() });
        return value;
    } catch (e) {
        // Transient hibát NEM cache-elünk.
        return ORG_STATUS_LOOKUP_FAILED;
    }
}
