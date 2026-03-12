const sdk = require("node-appwrite");

/**
 * Appwrite Function: Cascade Delete Article
 *
 * Egy article törlésekor automatikusan kitörli az összes kapcsolódó adatot
 * a többi collection-ből: ArticleMessages, UserValidations, Validations.
 *
 * Trigger: databases.*.collections.*.documents.*.delete
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs 'databases.read' és 'databases.write' jogosultsággal.
 * - DATABASE_ID: Az adatbázis azonosítója.
 * - ARTICLE_MESSAGES_COLLECTION_ID: Az ArticleMessages collection azonosítója.
 * - USER_VALIDATIONS_COLLECTION_ID: A UserValidations collection azonosítója.
 * - VALIDATIONS_COLLECTION_ID: A Validations (rendszer) collection azonosítója.
 */

const BATCH_LIMIT = 100;

/**
 * Egy collection összes, adott articleId-hez tartozó dokumentumát törli.
 * Pagination-nel kezeli a nagy mennyiségű dokumentumot.
 *
 * @param {sdk.Databases} databases - Appwrite Databases példány
 * @param {string} collectionId - A collection azonosítója
 * @param {string} articleId - A törölt article azonosítója
 * @param {Function} log - Logolás
 * @param {Function} error - Hibalogolás
 * @returns {{ found: number, deleted: number }} Statisztika
 */
async function deleteRelatedDocuments(databases, collectionId, articleId, log, error) {
    let totalFound = 0;
    let totalDeleted = 0;

    // Lapozás: addig kérünk le dokumentumokat, amíg van mit törölni
    while (true) {
        const response = await databases.listDocuments(
            process.env.DATABASE_ID,
            collectionId,
            [
                sdk.Query.equal('articleId', articleId),
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

        for (const result of deleteResults) {
            if (result.status === 'fulfilled') {
                totalDeleted++;
            } else {
                error(`[${collectionId}] Törlés sikertelen: ${result.reason?.message}`);
            }
        }
    }

    return { found: totalFound, deleted: totalDeleted };
}

module.exports = async function ({ req, res, log, error }) {
    const client = new sdk.Client();

    client
        .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new sdk.Databases(client);

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

        const deletedArticleId = payload.$id;

        if (!deletedArticleId) {
            error('Hiányzó article ID az event payload-ból');
            return res.json({ success: false, error: 'Missing article ID' }, 400);
        }

        log(`Article törölve: ${deletedArticleId} — kapcsolódó adatok takarítása...`);

        // Mindhárom collection takarítása párhuzamosan
        const collections = [
            { id: process.env.ARTICLE_MESSAGES_COLLECTION_ID, name: 'ArticleMessages' },
            { id: process.env.USER_VALIDATIONS_COLLECTION_ID, name: 'UserValidations' },
            { id: process.env.VALIDATIONS_COLLECTION_ID, name: 'Validations' }
        ];

        const results = await Promise.allSettled(
            collections.map(async (col) => {
                if (!col.id) {
                    log(`[${col.name}] Kihagyva — nincs collection ID konfigurálva`);
                    return { collection: col.name, found: 0, deleted: 0, skipped: true };
                }

                const stats = await deleteRelatedDocuments(databases, col.id, deletedArticleId, log, error);
                log(`[${col.name}] ${stats.deleted}/${stats.found} dokumentum törölve`);
                return { collection: col.name, ...stats };
            })
        );

        // Összesítés
        const summary = results.map(r => {
            if (r.status === 'fulfilled') return r.value;
            return { collection: '?', error: r.reason?.message };
        });

        log(`Cascade delete kész (article: ${deletedArticleId}): ${JSON.stringify(summary)}`);

        return res.json({
            success: true,
            articleId: deletedArticleId,
            collections: summary
        });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
