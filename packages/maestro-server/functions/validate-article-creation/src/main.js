const sdk = require("node-appwrite");

/**
 * Appwrite Function: Validate Article Creation
 *
 * Szerver-oldali validáció új cikk létrehozásakor.
 *
 * Ellenőrzések:
 * 1. publicationId — létezik-e a Publications gyűjteményben
 * 2. state — érvényes workflow állapot-e (0-7)
 * 3. Contributor mezők — létező felhasználókra mutatnak-e
 * 4. filePath — nem üres, nem tartalmaz tiltott karaktereket
 *
 * Érvénytelen publicationId → a cikk törlődik (nincs szülő).
 * Egyéb hibák → mező nullázás / alapértékre állítás.
 *
 * Trigger: databases.*.collections.articles.documents.*.create
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs (databases.*, users.* jogosultságok)
 * - DATABASE_ID
 * - ARTICLES_COLLECTION_ID
 * - PUBLICATIONS_COLLECTION_ID
 * - CONFIG_COLLECTION_ID
 */

const SERVER_GUARD_ID = 'server-guard';
const CONFIG_DOCUMENT_ID = 'workflow_config';

// Tiltott karakterek a fájlnévben (Windows + InDesign kompatibilitás)
const FORBIDDEN_CHARS = /[\\/:*?"<>|]/;

// Contributor mezők
const CONTRIBUTOR_FIELDS = [
    'writerId', 'editorId', 'designerId',
    'imageEditorId', 'artDirectorId',
    'managingEditorId', 'proofwriterId'
];

/**
 * Érvényes állapotok betöltése a config-ból (vagy fallback).
 */
async function loadValidStates(databases, databaseId, configCollectionId, log) {
    try {
        const doc = await databases.getDocument(databaseId, configCollectionId, CONFIG_DOCUMENT_ID);
        return new Set(JSON.parse(doc.validStates || '[]'));
    } catch (e) {
        log(`[Config] Fallback valid states használata: ${e.message}`);
        return new Set([0, 1, 2, 3, 4, 5, 6, 7]);
    }
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

        // ── SDK inicializálás ──
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const databases = new sdk.Databases(client);
        const usersApi = new sdk.Users(client);

        const databaseId = process.env.DATABASE_ID;
        const articlesCollectionId = process.env.ARTICLES_COLLECTION_ID;
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;
        const configCollectionId = process.env.CONFIG_COLLECTION_ID;

        // ── 1. publicationId validáció ──
        if (!payload.publicationId) {
            log(`Cikk publicationId nélkül: ${payload.$id} → törlés`);
            await databases.deleteDocument(databaseId, articlesCollectionId, payload.$id);
            return res.json({ success: true, action: 'deleted', reason: 'Missing publicationId' });
        }

        try {
            await databases.getDocument(databaseId, publicationsCollectionId, payload.publicationId);
        } catch (e) {
            if (e.code === 404) {
                log(`Érvénytelen publicationId: ${payload.publicationId} → cikk törlése (${payload.$id})`);
                await databases.deleteDocument(databaseId, articlesCollectionId, payload.$id);
                return res.json({ success: true, action: 'deleted', reason: 'Invalid publicationId' });
            }
            throw e;
        }

        const corrections = {};

        // ── 2. Állapot validáció ──
        const validStates = await loadValidStates(databases, databaseId, configCollectionId, log);
        if (!validStates.has(Number(payload.state))) {
            corrections.state = 0;
            log(`Érvénytelen állapot (${payload.state}) → 0`);
        }

        // ── 3. Contributor mezők validáció ──
        for (const field of CONTRIBUTOR_FIELDS) {
            const userId = payload[field];
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

        // ── 4. filePath formátum validáció ──
        if (payload.filePath) {
            // A fájlnév részét ellenőrizzük (az utolsó path szegmens)
            const fileName = payload.filePath.split('/').pop();
            if (fileName && FORBIDDEN_CHARS.test(fileName)) {
                log(`[filePath] Tiltott karakter a fájlnévben: "${fileName}"`);
                // Nem javítjuk, mert a fájlrendszeren már létezhet — csak logoljuk
            }
        }

        // ── 5. Korrekciók alkalmazása ──
        if (Object.keys(corrections).length > 0) {
            corrections.modifiedByClientId = SERVER_GUARD_ID;

            await databases.updateDocument(
                databaseId,
                articlesCollectionId,
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
