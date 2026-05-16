const sdk = require("node-appwrite");

// S.13.2+S.13.3 Phase 2.2 — PII-redaction log wrap + response info-disclosure védelem.
const { wrapLogger } = require('./_generated_piiRedaction.js');
const { fail } = require('./_generated_responseHelpers.js');

/**
 * Appwrite Function: Cleanup Orphaned Locks
 *
 * Időszakos (naponta) takarítás: árva zárolások feloldása.
 *
 * Árva zárolás keletkezik, ha:
 * - A plugin crashel vagy az InDesign váratlanul leáll
 * - A felhasználó nem megfelelően zárja be az alkalmazást
 * - A lock owner felhasználó törlésre került
 *
 * Logika:
 * 1. Listázza az összes zárolt cikket (lockOwnerId != null)
 * 2. Ellenőrzi, hogy a lock owner felhasználó létezik-e még
 * 3. A 24 óránál régebbi zárolásokat ($updatedAt alapján) automatikusan feloldja
 *
 * Trigger: Schedule (0 3 * * * — naponta 3:00 UTC)
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs (databases.*, users.read jogosultságok)
 * - DATABASE_ID
 * - ARTICLES_COLLECTION_ID
 */

const SERVER_CLEANUP_ID = 'server-cleanup';
const LOCK_MAX_AGE_HOURS = 24;
const BATCH_LIMIT = 100;

module.exports = async function ({ req, res, log: rawLog, error: rawError }) {
    const { log, error } = wrapLogger(rawLog, rawError);
    try {
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const databases = new sdk.Databases(client);
        const usersApi = new sdk.Users(client);

        const databaseId = process.env.DATABASE_ID;
        const articlesCollectionId = process.env.ARTICLES_COLLECTION_ID;
        const maxAgeHours = Number(process.env.LOCK_MAX_AGE_HOURS) || LOCK_MAX_AGE_HOURS;

        // Zárolt cikkek lekérése
        const lockedArticles = await databases.listDocuments(databaseId, articlesCollectionId, [
            sdk.Query.isNotNull('lockOwnerId'),
            sdk.Query.limit(BATCH_LIMIT)
        ]);

        if (lockedArticles.documents.length === 0) {
            log('Nincs zárolt cikk');
            return res.json({ success: true, action: 'none', lockedCount: 0 });
        }

        log(`${lockedArticles.documents.length} zárolt cikk található — ellenőrzés...`);

        let cleared = 0;

        for (const article of lockedArticles.documents) {
            let shouldClear = false;
            let reason = '';

            // 1. Lock owner létezik-e
            try {
                await usersApi.get(article.lockOwnerId);
            } catch (e) {
                if (e.code === 404) {
                    shouldClear = true;
                    reason = `owner nem létezik (${article.lockOwnerId})`;
                }
            }

            // 2. Kor ellenőrzés ($updatedAt alapján)
            if (!shouldClear) {
                const updatedAt = new Date(article.$updatedAt);
                const ageHours = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);

                if (ageHours > maxAgeHours) {
                    shouldClear = true;
                    reason = `${Math.round(ageHours)}h régi (limit: ${maxAgeHours}h)`;
                }
            }

            if (shouldClear) {
                try {
                    await databases.updateDocument(databaseId, articlesCollectionId, article.$id, {
                        lockType: null,
                        lockOwnerId: null,
                        modifiedByClientId: SERVER_CLEANUP_ID
                    });
                    cleared++;
                    log(`Lock feloldva: article=${article.$id}, ok: ${reason}`);
                } catch (e) {
                    error(`Lock feloldás sikertelen: article=${article.$id}, hiba: ${e.message}`);
                }
            }
        }

        log(`Összesítés: ${cleared}/${lockedArticles.documents.length} lock feloldva`);

        return res.json({
            success: true,
            action: cleared > 0 ? 'cleaned' : 'none',
            lockedCount: lockedArticles.documents.length,
            clearedCount: cleared
        });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return fail(res, 500, 'internal_error', {
            executionId: req?.headers?.['x-appwrite-execution-id']
        });
    }
};
