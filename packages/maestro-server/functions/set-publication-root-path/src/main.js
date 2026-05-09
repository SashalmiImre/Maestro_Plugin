const sdk = require("node-appwrite");

/**
 * Appwrite Function: Set Publication Root Path
 *
 * Szinkron HTTP endpoint — a Plugin folder picker modaljából hívott szűk
 * hatókörű írás a `publications.rootPath` mezőre. A Plugin `users` role
 * NEM rendelkezik direkt `publications.update` joggal (Fázis 9), ezért
 * minden rootPath beállítás ezen a CF-en keresztül történik.
 *
 * **Szemantika**: kizárólag null → nem-null kanonikus írás. Ha a rootPath
 * már be van állítva (nem üres), a CF elutasít (`root_path_already_set`).
 * Nincs idempotens "ugyanaz az érték" ág — a Plugin oldali UX a beállított
 * rootPath mezőt eleve read-only-ra teszi.
 *
 * Ellenőrzések (sorrendben, fail-closed):
 *  1. Payload parse + alap validáció (`publicationId`, `rootPath`)
 *  2. Auth (`x-appwrite-user-id` header)
 *  3. SDK init + env var validáció
 *  4. Kanonikus rootPath formátum validáció (hossz + struktúra)
 *  5. Fresh publication doc fetch
 *  6. Scope mezők jelenléte (`organizationId` + `editorialOfficeId`)
 *  7. Jogosultság: office admin VAGY org owner/admin
 *  7b. Phase 1.6 orphan-guard: az org `status === 'orphaned' | 'archived'` → 403
 *  8. Null check — csak akkor írunk, ha a rootPath még nincs beállítva
 *  9. DB write
 *
 * Trigger: HTTP endpoint, `execute: ["users"]`
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - DATABASE_ID
 * - PUBLICATIONS_COLLECTION_ID
 * - EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID
 * - ORGANIZATION_MEMBERSHIPS_COLLECTION_ID
 * - ORGANIZATIONS_COLLECTION_ID (Phase 1.6 orphan-guard, opcionális — ha
 *   hiányzik, `lookup_failed` sentinel → fail-closed 403)
 * - APPWRITE_API_KEY (fallback, ha az x-appwrite-key header hiányzik)
 * - APPWRITE_ENDPOINT
 * - APPWRITE_FUNCTION_PROJECT_ID (Appwrite runtime automatikusan beállítja)
 */

// Régi, natív útvonalra utaló prefixek — ezeket a CF elutasítja.
// Ld. `maestro-indesign/src/core/utils/constants.js` MOUNT_PREFIX.
const LEGACY_MOUNT_PREFIXES = ['/Volumes', 'C:/Volumes'];

// Explicit hossz-limit — védelem a CPU-szivárgás ellen (split/regex mind a
// `trimmed.length` függvényében fut). Az Appwrite string attribute limit
// helyett üzleti szabály: 1024 char bőven elég minden reális útvonalra.
const MAX_ROOT_PATH_LENGTH = 1024;

/**
 * Kanonikus rootPath formátum ellenőrzése.
 *
 * Kanonikus formátum: `/ShareName/opcionális/relatív/útvonal` — forward
 * slash, legalább egy szegmens, nincs platform-prefix, nincs path traversal.
 *
 * @param {unknown} value - A vizsgálandó érték.
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
function isCanonicalRootPath(value) {
    if (typeof value !== 'string') return { ok: false, reason: 'not_string' };
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, reason: 'empty' };
    if (trimmed.length > MAX_ROOT_PATH_LENGTH) return { ok: false, reason: 'too_long' };
    if (trimmed.includes('\\')) return { ok: false, reason: 'contains_backslash' };
    if (!trimmed.startsWith('/')) return { ok: false, reason: 'no_leading_slash' };
    // Drive betű (pl. `Z:/...`) — natív Windows formátum, kanonikusan tiltott.
    if (/^[a-zA-Z]:\//.test(trimmed)) return { ok: false, reason: 'drive_letter' };
    for (const pfx of LEGACY_MOUNT_PREFIXES) {
        if (trimmed === pfx || trimmed.startsWith(pfx + '/')) {
            return { ok: false, reason: 'legacy_mount_prefix' };
        }
    }
    const segments = trimmed.split('/').filter(Boolean);
    if (segments.length === 0) return { ok: false, reason: 'empty' };
    // Path traversal védelem — `.` vagy `..` szegmens tiltása.
    if (segments.some(s => s === '..' || s === '.')) {
        return { ok: false, reason: 'path_traversal' };
    }
    return { ok: true, value: trimmed };
}

async function findSingleMembership(databases, databaseId, collectionId, queries) {
    const result = await databases.listDocuments(databaseId, collectionId, [
        ...queries,
        sdk.Query.limit(1)
    ]);
    if ((result.total || 0) === 0) return null;
    return result.documents[0] || null;
}

// ── Phase 1.6 orphan-guard (single-source, H.2 Phase 2 2026-05-09) ───────────
//
// Az inline duplikáció helyét a `_generated_orphanGuard.js` veszi át; a
// kanonikus forrás `packages/maestro-shared/orphanGuard.js`, regeneráció:
// `yarn build:cf-orphan-guard`. Az `invite-to-organization` `permissions.js`
// belső `getOrgStatus()` (per-request cache) NEM cserélődött erre — más
// kontextus, más invariánsok.
const { getOrgStatus, isOrgWriteBlocked } = require('./_generated_orphanGuard.js');

function fail(res, statusCode, reason, extra = {}) {
    return res.json({ success: false, reason, ...extra }, statusCode);
}

/**
 * Jogosultság-megtagadás válasz (403) strukturált payload-dal, amit a kliens
 * `PermissionDeniedError`-ba tud mappelni.
 */
function permissionDenied(res, reason) {
    return res.json({
        success: false,
        permissionDenied: true,
        reason,
        requiredGroups: []
    }, 403);
}

module.exports = async function ({ req, res, log, error }) {
    try {
        // ── 1. Payload parse ──
        let payload = {};
        if (req.body) {
            try {
                payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            } catch (e) {
                error(`Payload parse hiba: ${e.message}`);
                return fail(res, 400, 'invalid_payload');
            }
        }

        const publicationId = payload.publicationId;
        const rawRootPath = payload.rootPath;

        if (!publicationId || typeof publicationId !== 'string') {
            return fail(res, 400, 'missing_publication_id');
        }

        // ── 2. Auth ──
        const userId = req.headers['x-appwrite-user-id'];
        if (!userId) {
            return fail(res, 401, 'unauthenticated');
        }

        // ── 3. SDK init + env var validáció ──
        const apiKey = req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY || '';
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(apiKey);

        const databases = new sdk.Databases(client);

        const databaseId = process.env.DATABASE_ID;
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;
        const officeMembershipsCollectionId = process.env.EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID;
        const orgMembershipsCollectionId = process.env.ORGANIZATION_MEMBERSHIPS_COLLECTION_ID;
        // Phase 1.6 orphan-guard: opcionális, hiányzás → `lookup_failed` → 403.
        const organizationsCollectionId = process.env.ORGANIZATIONS_COLLECTION_ID;

        const missingEnvVars = [];
        if (!databaseId) missingEnvVars.push('DATABASE_ID');
        if (!publicationsCollectionId) missingEnvVars.push('PUBLICATIONS_COLLECTION_ID');
        if (!officeMembershipsCollectionId) missingEnvVars.push('EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID');
        if (!orgMembershipsCollectionId) missingEnvVars.push('ORGANIZATION_MEMBERSHIPS_COLLECTION_ID');
        if (!apiKey) missingEnvVars.push('APPWRITE_API_KEY (vagy x-appwrite-key header)');
        if (missingEnvVars.length > 0) {
            error(`[Config] Hiányzó környezeti változók: ${missingEnvVars.join(', ')}`);
            return fail(res, 500, 'misconfigured', { missing: missingEnvVars });
        }

        // ── 4. Kanonikus rootPath formátum validáció ──
        const canonicalCheck = isCanonicalRootPath(rawRootPath);
        if (!canonicalCheck.ok) {
            return fail(res, 400, 'invalid_root_path', { detail: canonicalCheck.reason });
        }
        const rootPath = canonicalCheck.value;

        // ── 5. Fresh publication doc fetch ──
        let pub;
        try {
            pub = await databases.getDocument(databaseId, publicationsCollectionId, publicationId);
        } catch (e) {
            if (e.code === 404) {
                return fail(res, 404, 'publication_not_found');
            }
            error(`[DB] Publication fetch hiba: ${e.message}`);
            return fail(res, 500, 'publication_fetch_failed', { message: e.message });
        }

        // ── 6. Scope mezők jelenléte ──
        // Legacy wipe óta elvárható, hogy minden pub rendelkezik scope-pal.
        // Hiányzó scope → data integrity hiba, nem szerver bug → 422.
        if (!pub.organizationId || !pub.editorialOfficeId) {
            error(`[Scope] Publication ${publicationId} scope mezői hiányoznak: orgId=${pub.organizationId}, officeId=${pub.editorialOfficeId}`);
            return fail(res, 422, 'missing_scope');
        }

        // ── 7. Jogosultság: office admin VAGY org owner/admin ──
        // Auth ELŐRE kerül a null check elé — különben a 409
        // `root_path_already_set` válasz leakelné a pub állapotát bármely
        // auth'd hívónak, aki ismer/találgat egy publicationId-t.
        let officeMembership;
        try {
            officeMembership = await findSingleMembership(
                databases, databaseId, officeMembershipsCollectionId,
                [
                    sdk.Query.equal('editorialOfficeId', pub.editorialOfficeId),
                    sdk.Query.equal('userId', userId)
                ]
            );
        } catch (e) {
            error(`[Scope] Office membership lookup hiba: ${e.message} — fail-closed`);
            return permissionDenied(res, 'Szerkesztőség-tagság ellenőrzése sikertelen.');
        }

        const isOfficeAdmin = officeMembership?.role === 'admin';

        if (!isOfficeAdmin) {
            let orgMembership;
            try {
                orgMembership = await findSingleMembership(
                    databases, databaseId, orgMembershipsCollectionId,
                    [
                        sdk.Query.equal('organizationId', pub.organizationId),
                        sdk.Query.equal('userId', userId)
                    ]
                );
            } catch (e) {
                error(`[Scope] Org membership lookup hiba: ${e.message} — fail-closed`);
                return permissionDenied(res, 'Szervezet-tagság ellenőrzése sikertelen.');
            }

            const orgRole = orgMembership?.role;
            if (orgRole !== 'owner' && orgRole !== 'admin') {
                log(`[Scope] User ${userId} nem office admin és nem org owner/admin (office=${pub.editorialOfficeId}, org=${pub.organizationId})`);
                return permissionDenied(res, 'Nincs jogosultságod a kiadvány gyökérmappájának beállításához.');
            }
            log(`[Scope] User ${userId} engedélyezve org role-lal: ${orgRole}`);
        } else {
            log(`[Scope] User ${userId} engedélyezve office admin role-lal`);
        }

        // ── 7b. Phase 1.6 orphan-guard ──
        // Ha az org `status === 'orphaned' | 'archived'` (vagy a status-lookup
        // `lookup_failed` sentinel-t ad — env hiány vagy DB-hiba) → 403
        // `org_orphaned_write_blocked`. A `null` legacy active (60+ legacy
        // org backwards-compat, ld. Phase 1.5 minta). A guard a jogosultság-
        // ellenőrzés UTÁN, az adat-validity (null check) és a DB write ELŐTT
        // áll: a 403 választ a kliensnek mindenképp adunk a 409 helyett, ha
        // az org írásra le van zárva.
        const orgStatus = await getOrgStatus(
            databases, databaseId, organizationsCollectionId, pub.organizationId, sdk
        );
        if (isOrgWriteBlocked(orgStatus)) {
            log(`[Scope] Org ${pub.organizationId} status="${orgStatus}" → write blocked (Phase 1.6)`);
            return fail(res, 403, 'org_orphaned_write_blocked');
        }

        // ── 8. Null check — csak null → érték írás ──
        // Ide már CSAK jogosult hívó juthat el, így a 409 válasz
        // nem leakel pub-state-et külső találgatóknak. A `currentRootPath`-ot
        // sem küldjük vissza — a hívó a pub read API-val úgyis lekérdezi.
        if (pub.rootPath && String(pub.rootPath).trim() !== '') {
            return fail(res, 409, 'root_path_already_set');
        }

        // ── 9. DB write ──
        let updated;
        try {
            updated = await databases.updateDocument(
                databaseId, publicationsCollectionId, publicationId, { rootPath }
            );
        } catch (e) {
            error(`[DB] updateDocument hiba: ${e.message}`);
            if (e.code === 404) {
                return fail(res, 404, 'publication_not_found');
            }
            return fail(res, 500, 'write_failed', { message: e.message });
        }

        log(`[Done] Publication ${publicationId} rootPath beállítva: ${rootPath}`);
        return res.json({
            success: true,
            action: 'applied',
            document: updated
        });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, reason: 'internal_error', message: err.message }, 500);
    }
};
