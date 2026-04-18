const sdk = require("node-appwrite");

/**
 * Appwrite Function: Cascade Delete
 *
 * Article vagy publication törlésekor automatikusan kitörli az összes kapcsolódó adatot.
 *
 * Article törlés → UserValidations, SystemValidations + thumbnail fájlok.
 * Publication törlés → Articles (→ rekurzívan triggereli az article ágat), Deadlines, Layouts.
 *
 * A collection típust a trigger event-ből detektálja (req.headers['x-appwrite-event']).
 *
 * Trigger: databases.*.collections.{articles|publications}.documents.*.delete
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs 'databases.read', 'databases.write' és 'storage.read', 'storage.write' jogosultsággal.
 * - DATABASE_ID: Az adatbázis azonosítója.
 * - ARTICLES_COLLECTION_ID: Az Articles collection azonosítója.
 * - USER_VALIDATIONS_COLLECTION_ID: A UserValidations collection azonosítója.
 * - SYSTEM_VALIDATIONS_COLLECTION_ID: A SystemValidations collection azonosítója.
 * - DEADLINES_COLLECTION_ID: A Deadlines collection azonosítója.
 * - LAYOUTS_COLLECTION_ID: A Layouts collection azonosítója.
 * - THUMBNAILS_BUCKET_ID: A thumbnails Storage bucket azonosítója.
 */

const BATCH_LIMIT = 100;

/**
 * Egy collection összes, adott mezőértékhez tartozó dokumentumát törli.
 * Paginációval kezeli a nagy mennyiségű dokumentumot.
 *
 * @param {sdk.Databases} databases - Appwrite Databases példány
 * @param {string} collectionId - A collection azonosítója
 * @param {string} fieldName - A szűrő mező neve (pl. 'articleId', 'publicationId')
 * @param {string} fieldValue - A szűrő mező értéke (a törölt dokumentum ID-ja)
 * @param {Function} log - Logolás
 * @param {Function} error - Hibalogolás
 * @returns {{ found: number, deleted: number }} Statisztika
 */
async function deleteRelatedDocuments(databases, collectionId, fieldName, fieldValue, log, error) {
    let totalFound = 0;
    let totalDeleted = 0;

    // Lapozás: addig kérünk le dokumentumokat, amíg van mit törölni
    while (true) {
        const response = await databases.listDocuments(
            process.env.DATABASE_ID,
            collectionId,
            [
                sdk.Query.equal(fieldName, fieldValue),
                sdk.Query.limit(BATCH_LIMIT)
            ]
        );

        if (response.documents.length === 0) break;

        totalFound += response.documents.length;

        const deleteResults = await Promise.allSettled(
            response.documents.map(doc =>
                databases.deleteDocument(process.env.DATABASE_ID, collectionId, doc.$id)
            )
        );

        let batchDeleted = 0;
        for (const result of deleteResults) {
            if (result.status === 'fulfilled') {
                batchDeleted++;
            } else {
                error(`[${collectionId}] Törlés sikertelen: ${result.reason?.message}`);
            }
        }
        totalDeleted += batchDeleted;

        // Ha egyetlen törlés sem sikerült, kilépünk a végtelen ciklus elkerülésére
        if (batchDeleted === 0) break;
    }

    return { found: totalFound, deleted: totalDeleted };
}

/**
 * A törölt article thumbnail fájljait törli a Storage-ból.
 * A payload `thumbnails` mezőjéből olvassa ki a fileId-kat (JSON tömb: [{ fileId, page }]).
 *
 * @param {sdk.Storage} storage - Appwrite Storage példány
 * @param {string} thumbnailsJson - A thumbnails mező értéke (JSON string)
 * @param {Function} log - Logolás
 * @param {Function} error - Hibalogolás
 * @returns {{ found: number, deleted: number }} Statisztika
 */
async function deleteThumbnails(storage, thumbnailsJson, log, error) {
    let thumbnails;
    try {
        thumbnails = JSON.parse(thumbnailsJson);
    } catch (e) {
        error(`[Thumbnails] Érvénytelen JSON: ${e.message}`);
        return { found: 0, deleted: 0 };
    }

    if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
        return { found: 0, deleted: 0 };
    }

    const bucketId = process.env.THUMBNAILS_BUCKET_ID;
    if (!bucketId) {
        log('[Thumbnails] Kihagyva — nincs THUMBNAILS_BUCKET_ID konfigurálva');
        return { found: thumbnails.length, deleted: 0, skipped: true };
    }

    let deleted = 0;
    const deleteResults = await Promise.allSettled(
        thumbnails.map(({ fileId }) =>
            storage.deleteFile(bucketId, fileId)
        )
    );

    for (const result of deleteResults) {
        if (result.status === 'fulfilled') {
            deleted++;
        } else {
            error(`[Thumbnails] Törlés sikertelen: ${result.reason?.message}`);
        }
    }

    return { found: thumbnails.length, deleted };
}

/**
 * Közös logika: collection-ök takarítása párhuzamosan, összesítéssel.
 *
 * @param {Array<{ id: string, name: string }>} collections - Törlendő collection-ök
 * @param {sdk.Databases} databases - Appwrite Databases példány
 * @param {string} fieldName - A szűrő mező neve
 * @param {string} fieldValue - A szűrő mező értéke
 * @param {Function} log - Logolás
 * @param {Function} error - Hibalogolás
 * @returns {Promise<Array>} Eredmények tömbje
 */
async function cleanupCollections(collections, databases, fieldName, fieldValue, log, error) {
    const promises = collections.map(async (col) => {
        if (!col.id) {
            log(`[${col.name}] Kihagyva — nincs collection ID konfigurálva`);
            return { collection: col.name, found: 0, deleted: 0, skipped: true };
        }

        const stats = await deleteRelatedDocuments(databases, col.id, fieldName, fieldValue, log, error);
        log(`[${col.name}] ${stats.deleted}/${stats.found} dokumentum törölve`);
        return { collection: col.name, ...stats };
    });

    return Promise.allSettled(promises);
}

// ═══════════════════════════════════════════════════════════════════════════
// Article törlés ág
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Article törlésekor: UserValidations, SystemValidations + thumbnailek takarítása.
 */
async function handleArticleDelete(payload, databases, storage, log, error) {
    const articleId = payload.$id;
    log(`Article törölve: ${articleId} — kapcsolódó adatok takarítása...`);

    const collections = [
        { id: process.env.USER_VALIDATIONS_COLLECTION_ID, name: 'UserValidations' },
        { id: process.env.SYSTEM_VALIDATIONS_COLLECTION_ID, name: 'SystemValidations' }
    ];

    // Collection takarítás + thumbnail törlés párhuzamosan
    const thumbnailPromise = (async () => {
        if (!payload.thumbnails) {
            log('[Thumbnails] Nincs thumbnail adat — kihagyva');
            return { collection: 'Thumbnails', found: 0, deleted: 0, skipped: true };
        }
        const stats = await deleteThumbnails(storage, payload.thumbnails, log, error);
        log(`[Thumbnails] ${stats.deleted}/${stats.found} fájl törölve`);
        return { collection: 'Thumbnails', ...stats };
    })();

    const [collectionResults, thumbnailResults] = await Promise.all([
        cleanupCollections(collections, databases, 'articleId', articleId, log, error),
        Promise.allSettled([thumbnailPromise])
    ]);

    return [...collectionResults, ...thumbnailResults];
}

// ═══════════════════════════════════════════════════════════════════════════
// Publication törlés ág
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Publication törlésekor: Articles, Deadlines, Layouts takarítása.
 * Az article törlés rekurzívan triggereli az article ágat (messages, validations, thumbnails).
 */
async function handlePublicationDelete(payload, databases, log, error) {
    const publicationId = payload.$id;
    log(`Publication törölve: ${publicationId} — kapcsolódó adatok takarítása...`);

    const collections = [
        { id: process.env.ARTICLES_COLLECTION_ID, name: 'Articles' },
        { id: process.env.DEADLINES_COLLECTION_ID, name: 'Deadlines' },
        { id: process.env.LAYOUTS_COLLECTION_ID, name: 'Layouts' }
    ];

    return cleanupCollections(collections, databases, 'publicationId', publicationId, log, error);
}

// ═══════════════════════════════════════════════════════════════════════════
// Belépési pont
// ═══════════════════════════════════════════════════════════════════════════

module.exports = async function ({ req, res, log, error }) {
    const client = new sdk.Client();

    client
        .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new sdk.Databases(client);
    const storage = new sdk.Storage(client);

    try {
        // Event payload feldolgozása
        let payload = {};
        if (req.body) {
            try {
                payload = JSON.parse(req.body);
            } catch (e) {
                payload = req.body;
            }
        }

        if (!payload.$id) {
            error('Hiányzó dokumentum ID az event payload-ból');
            return res.json({ success: false, error: 'Missing document ID' }, 400);
        }

        // Collection típus detektálása az event header-ből
        const event = req.headers['x-appwrite-event'] || '';
        const isPublication = event.includes('.collections.publications.');
        const isArticle = event.includes('.collections.articles.');

        if (!isPublication && !isArticle) {
            error(`Ismeretlen event típus: ${event}`);
            return res.json({ success: false, error: `Unknown event: ${event}` }, 400);
        }

        // Elágazás a típus alapján
        let results;
        if (isPublication) {
            results = await handlePublicationDelete(payload, databases, log, error);
        } else {
            results = await handleArticleDelete(payload, databases, storage, log, error);
        }

        // Összesítés
        const summary = results.map(r => {
            if (r.status === 'fulfilled') return r.value;
            return { collection: '?', error: r.reason?.message };
        });

        const type = isPublication ? 'publication' : 'article';
        log(`Cascade delete kész (${type}: ${payload.$id}): ${JSON.stringify(summary)}`);

        return res.json({
            success: true,
            type,
            documentId: payload.$id,
            collections: summary
        });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
