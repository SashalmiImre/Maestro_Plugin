const sdk = require("node-appwrite");

/**
 * Appwrite Function: Validate Publication Update
 *
 * Szerver-oldali validáció kiadvány létrehozásakor és módosításakor.
 *
 * Ellenőrzések:
 * 1. Default contributor ID-k — létező felhasználókra mutatnak-e
 * 2. rootPath formátum — kanonikus-e (nem /Volumes-szal kezdődik, nincs drive letter)
 *
 * Érvénytelen contributor → nullázás.
 * rootPath probléma → csak logolás (nem javítjuk, lehet migráció folyamatban).
 *
 * Trigger: databases.*.collections.publications.documents.*.create
 *          databases.*.collections.publications.documents.*.update
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs (databases.*, users.* jogosultságok)
 * - DATABASE_ID
 * - PUBLICATIONS_COLLECTION_ID
 */

const SERVER_GUARD_ID = 'server-guard';

// Kiadvány default contributor mezők
const DEFAULT_CONTRIBUTOR_FIELDS = [
    'defaultWriterId',
    'defaultEditorId',
    'defaultDesignerId',
    'defaultImageEditorId',
    'defaultArtDirectorId',
    'defaultManagingEditorId',
    'defaultProofwriterId'
];

// Legacy útvonal felismerés
const MOUNT_PREFIXES = ['/Volumes', 'C:/Volumes'];

/**
 * Ellenőrzi, hogy a rootPath régi (legacy) formátumú-e.
 * @param {string} rootPath
 * @returns {boolean}
 */
function isLegacyRootPath(rootPath) {
    if (!rootPath) return false;
    const normalized = rootPath.replace(/\\/g, '/');
    for (const pfx of MOUNT_PREFIXES) {
        if (normalized.startsWith(pfx + '/') || normalized === pfx) return true;
    }
    return /^[a-zA-Z]:\//.test(normalized);
}

module.exports = async function ({ req, res, log, error }) {
    try {
        // Event payload feldolgozása
        let payload = {};
        if (req.body) {
            try {
                payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            } catch (e) {
                error(`Payload parse hiba: ${e.message}`);
                return res.json({ success: false, reason: 'Invalid payload' });
            }
        }

        if (!payload.$id) {
            return res.json({ success: true, action: 'skipped', reason: 'No document ID' });
        }

        // Sentinel guard — saját korrekciós update kihagyása
        if (payload.modifiedByClientId === SERVER_GUARD_ID) {
            return res.json({ success: true, action: 'skipped', reason: 'Server guard update' });
        }

        // ── SDK inicializálás ──
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const databases = new sdk.Databases(client);
        const usersApi = new sdk.Users(client);

        const databaseId = process.env.DATABASE_ID;
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;

        // Friss dokumentum lekérése
        let freshDoc;
        try {
            freshDoc = await databases.getDocument(databaseId, publicationsCollectionId, payload.$id);
        } catch (e) {
            if (e.code === 404) {
                return res.json({ success: true, action: 'skipped', reason: 'Document deleted' });
            }
            throw e;
        }

        if (freshDoc.modifiedByClientId === SERVER_GUARD_ID) {
            return res.json({ success: true, action: 'skipped', reason: 'Server guard update (fresh)' });
        }

        const corrections = {};

        // ── 1. Default contributor ID-k validáció ──
        for (const field of DEFAULT_CONTRIBUTOR_FIELDS) {
            const userId = freshDoc[field];
            if (!userId) continue;

            try {
                await usersApi.get(userId);
            } catch (e) {
                if (e.code === 404) {
                    corrections[field] = null;
                    log(`[Contributor] ${field}=${userId} — nem létező felhasználó → nullázva`);
                }
            }
        }

        // ── 2. rootPath formátum ellenőrzés ──
        if (freshDoc.rootPath && isLegacyRootPath(freshDoc.rootPath)) {
            log(`[rootPath] Legacy formátum észlelve: "${freshDoc.rootPath}" — migráció szükséges`);
            // Nem javítjuk automatikusan — a kliens lazy migrációja vagy a
            // migrate-legacy-paths function kezeli
        }

        // ── 3. Korrekciók alkalmazása ──
        if (Object.keys(corrections).length > 0) {
            corrections.modifiedByClientId = SERVER_GUARD_ID;

            await databases.updateDocument(
                databaseId,
                publicationsCollectionId,
                payload.$id,
                corrections
            );

            log(`Korrekciók alkalmazva: ${JSON.stringify(corrections)}`);

            return res.json({
                success: true,
                action: 'corrected',
                corrections
            });
        }

        return res.json({ success: true, action: 'validated' });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
