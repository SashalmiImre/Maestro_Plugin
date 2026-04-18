const sdk = require("node-appwrite");

/**
 * Appwrite Function: Cleanup Orphaned Thumbnails
 *
 * Időszakos (hetente) takarítás: árva thumbnail fájlok törlése a Storage-ból.
 *
 * Árva thumbnail keletkezik, ha:
 * - A kliens crashel a feltöltés és a DB frissítés között
 * - A cascade-delete function nem fut le (Appwrite event nem triggerelt)
 * - Manuális DB módosítás törli a thumbnail hivatkozásokat
 *
 * Logika:
 * 1. Listázza a thumbnails bucket összes fájlját (paginálva)
 * 2. Listázza az articles gyűjtemény összes thumbnails mezőjét (paginálva)
 * 3. Összeveti a két halmazt → nem hivatkozott fájlokat töröl
 *
 * Trigger: Schedule (0 4 * * 0 — hetente vasárnap 4:00 UTC)
 * Runtime: Node.js 18.0+
 * Timeout: 120s
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs (databases.read, files.read, files.write)
 * - DATABASE_ID
 * - ARTICLES_COLLECTION_ID
 * - THUMBNAILS_BUCKET_ID
 */

const BATCH_LIMIT = 100;

module.exports = async function ({ req, res, log, error }) {
    try {
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const databases = new sdk.Databases(client);
        const storage = new sdk.Storage(client);

        const databaseId = process.env.DATABASE_ID;
        const articlesCollectionId = process.env.ARTICLES_COLLECTION_ID;
        const bucketId = process.env.THUMBNAILS_BUCKET_ID;

        if (!bucketId) {
            log('THUMBNAILS_BUCKET_ID nincs konfigurálva — kihagyva');
            return res.json({ success: true, action: 'skipped', reason: 'No bucket configured' });
        }

        // ── 1. Storage fájlok összegyűjtése (paginálva) ──
        const allFileIds = new Set();
        let cursor = undefined;

        while (true) {
            const queries = [sdk.Query.limit(BATCH_LIMIT)];
            if (cursor) queries.push(sdk.Query.cursorAfter(cursor));

            const files = await storage.listFiles(bucketId, queries);
            for (const file of files.files) {
                allFileIds.add(file.$id);
            }

            if (files.files.length < BATCH_LIMIT) break;
            cursor = files.files[files.files.length - 1].$id;
        }

        log(`Storage: ${allFileIds.size} fájl a thumbnails bucket-ben`);

        if (allFileIds.size === 0) {
            return res.json({ success: true, action: 'none', storageCount: 0 });
        }

        // ── 2. Hivatkozott fileId-k összegyűjtése az articles-ből (paginálva) ──
        const referencedIds = new Set();
        cursor = undefined;

        while (true) {
            const queries = [sdk.Query.limit(BATCH_LIMIT)];
            if (cursor) queries.push(sdk.Query.cursorAfter(cursor));

            const articles = await databases.listDocuments(databaseId, articlesCollectionId, queries);
            for (const article of articles.documents) {
                if (article.thumbnails) {
                    try {
                        const thumbs = JSON.parse(article.thumbnails);
                        if (Array.isArray(thumbs)) {
                            for (const t of thumbs) {
                                if (t.fileId) referencedIds.add(t.fileId);
                            }
                        }
                    } catch (e) {
                        // Hibás JSON → teljes futás megszakítása (biztonságos: nem törlünk semmit)
                        error(`Hibás thumbnails JSON a(z) ${article.$id} cikkben — törlés kihagyva a teljes futásra`);
                        return res.json({
                            success: false,
                            action: 'aborted',
                            reason: `Malformed thumbnails JSON in article ${article.$id}`,
                            storageCount: allFileIds.size
                        });
                    }
                }
            }

            if (articles.documents.length < BATCH_LIMIT) break;
            cursor = articles.documents[articles.documents.length - 1].$id;
        }

        log(`DB: ${referencedIds.size} hivatkozott thumbnail fileId`);

        // ── 3. Árva fájlok azonosítása és törlése ──
        const orphanedIds = [...allFileIds].filter(id => !referencedIds.has(id));

        if (orphanedIds.length === 0) {
            log('Nincs árva thumbnail');
            return res.json({
                success: true,
                action: 'none',
                storageCount: allFileIds.size,
                referencedCount: referencedIds.size
            });
        }

        log(`${orphanedIds.length} árva thumbnail fájl — törlés...`);

        let deleted = 0;
        for (const fileId of orphanedIds) {
            try {
                await storage.deleteFile(bucketId, fileId);
                deleted++;
            } catch (e) {
                error(`Törlés sikertelen: ${fileId} — ${e.message}`);
            }
        }

        log(`Összesítés: ${deleted}/${orphanedIds.length} árva thumbnail törölve`);

        return res.json({
            success: true,
            action: 'cleaned',
            storageCount: allFileIds.size,
            referencedCount: referencedIds.size,
            orphanedCount: orphanedIds.length,
            deletedCount: deleted
        });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
