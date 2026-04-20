const sdk = require('node-appwrite');

/**
 * Appwrite Function: Cleanup Archived Workflows
 *
 * Időszakos (naponta) hard-delete: a soft-delete-elt workflow-k (a user
 * az `archive_workflow` action-nel állította `archivedAt = now()`-ra)
 * közül a `RETENTION_DAYS`-nél (default 7) régebbieket véglegesen
 * törli, feltéve hogy NEM hivatkozik rájuk egyetlen olyan publikáció
 * sem, amelynek nincs `compiledWorkflowSnapshot`-ja (azaz nem-aktivált
 * vagy legacy snapshot-nélküli aktív).
 *
 * Miért csak snapshot-nélküliek blokkolnak?
 *   - Aktivált publikáció a `compiledWorkflowSnapshot`-ból futtatja a
 *     workflow-t (ld. Feladat #37). A live workflow doc törlése ezt
 *     nem érinti.
 *   - Nem-aktivált publikáció viszont a live `workflowId` → `workflows`
 *     doc lookup-ra támaszkodik; ha a workflow eltűnik, a publikáció
 *     nem aktiválható, vagy error-be fut a Plugin/Dashboard.
 *
 * Trigger: Schedule (0 5 * * * — naponta 5:00 UTC).
 * Runtime: Node.js 18.0+.
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY (databases.read + databases.write scope)
 * - APPWRITE_ENDPOINT
 * - DATABASE_ID
 * - WORKFLOWS_COLLECTION_ID
 * - PUBLICATIONS_COLLECTION_ID
 * - ARCHIVED_RETENTION_DAYS (opcionális; default 7)
 */

const DEFAULT_RETENTION_DAYS = 7;
const BATCH_LIMIT = 100;
const BLOCK_SCAN_BATCH_LIMIT = 100;

module.exports = async function ({ req, res, log, error }) {
    try {
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const databases = new sdk.Databases(client);

        const databaseId = process.env.DATABASE_ID;
        const workflowsCollectionId = process.env.WORKFLOWS_COLLECTION_ID;
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;

        if (!databaseId || !workflowsCollectionId || !publicationsCollectionId) {
            error('Hiányzó env var: DATABASE_ID / WORKFLOWS_COLLECTION_ID / PUBLICATIONS_COLLECTION_ID');
            return res.json({ success: false, error: 'misconfigured' }, 500);
        }

        const retentionDays = Number(process.env.ARCHIVED_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
        const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

        log(`[CleanupArchivedWorkflows] cutoff=${cutoffIso} (retention=${retentionDays}d)`);

        // 1. Archivált workflow-k listázása (páginalva a limit alatti batch-eket is átérve).
        const eligibleWorkflows = [];
        let wfCursor = null;
        while (true) {
            const queries = [
                sdk.Query.isNotNull('archivedAt'),
                sdk.Query.lessThan('archivedAt', cutoffIso),
                sdk.Query.select(['$id', 'name', 'editorialOfficeId', 'organizationId', 'archivedAt']),
                sdk.Query.limit(BATCH_LIMIT)
            ];
            if (wfCursor) queries.push(sdk.Query.cursorAfter(wfCursor));
            const batch = await databases.listDocuments(databaseId, workflowsCollectionId, queries);
            if (batch.documents.length === 0) break;
            eligibleWorkflows.push(...batch.documents);
            if (batch.documents.length < BATCH_LIMIT) break;
            wfCursor = batch.documents[batch.documents.length - 1].$id;
        }

        if (eligibleWorkflows.length === 0) {
            log('Nincs hard-delete-re érett archivált workflow');
            return res.json({ success: true, action: 'none', eligibleCount: 0 });
        }

        log(`${eligibleWorkflows.length} archivált workflow érett — referencia-check...`);

        let deleted = 0;
        let skipped = 0;
        const skippedDetails = [];

        for (const wf of eligibleWorkflows) {
            // 2. Blocking scan — snapshot-NÉLKÜLI publikációk.
            //    Appwrite nem támogat natívan `isNull` + workflowId kombinációt
            //    egy query-ben (a `compiledWorkflowSnapshot` longtext, nem
            //    szűrhető common-way-ben), ezért a workflowId-ra hivatkozó
            //    összes publikációt lekérjük és kliens-oldalon szűrünk.
            const blockers = [];
            let pubCursor = null;
            let totalRefs = 0;

            scanLoop:
            while (true) {
                const queries = [
                    sdk.Query.equal('workflowId', wf.$id),
                    sdk.Query.select(['$id', 'name', 'isActivated', 'compiledWorkflowSnapshot']),
                    sdk.Query.limit(BLOCK_SCAN_BATCH_LIMIT)
                ];
                if (pubCursor) queries.push(sdk.Query.cursorAfter(pubCursor));

                const batch = await databases.listDocuments(databaseId, publicationsCollectionId, queries);
                if (batch.documents.length === 0) break;

                for (const pub of batch.documents) {
                    totalRefs++;
                    const hasSnapshot = typeof pub.compiledWorkflowSnapshot === 'string'
                        && pub.compiledWorkflowSnapshot.trim().length > 0;
                    if (!hasSnapshot) {
                        blockers.push({ $id: pub.$id, name: pub.name, isActivated: !!pub.isActivated });
                        // Korai kilépés: 1 blocker is elég a skip-hez (cap
                        // memóriát, nem futtatjuk végig a teljes listát).
                        if (blockers.length >= 5) break scanLoop;
                    }
                }
                if (batch.documents.length < BLOCK_SCAN_BATCH_LIMIT) break;
                pubCursor = batch.documents[batch.documents.length - 1].$id;
            }

            if (blockers.length > 0) {
                skipped++;
                skippedDetails.push({
                    workflowId: wf.$id,
                    name: wf.name,
                    reason: 'has_snapshotless_publications',
                    sampleBlockers: blockers,
                    totalRefsScanned: totalRefs
                });
                log(`[skip] ${wf.$id} (${wf.name}) — ${blockers.length}+ snapshot-nélküli publikáció hivatkozik rá`);
                continue;
            }

            // 3. Hard-delete (a `cascade-delete` CF itt NEM fut, mert csak
            // az articles + publications delete-re van bekötve — a workflow-k
            // nincsenek cascade-láncban, az üzleti kapcsolat a publications
            // workflowId-jára vonatkozik, és az aktív publikációkat a snapshot
            // védi).
            try {
                await databases.deleteDocument(databaseId, workflowsCollectionId, wf.$id);
                deleted++;
                log(`[delete] ${wf.$id} (${wf.name}) archived ${wf.archivedAt}`);
            } catch (delErr) {
                error(`[${wf.$id}] deleteDocument hiba: ${delErr.message}`);
                skipped++;
                skippedDetails.push({
                    workflowId: wf.$id,
                    name: wf.name,
                    reason: 'delete_failed',
                    error: delErr.message
                });
            }
        }

        log(`Összesítés: ${deleted} törölve, ${skipped} kihagyva (${eligibleWorkflows.length} érett)`);

        return res.json({
            success: true,
            action: deleted > 0 ? 'cleaned' : 'none',
            eligibleCount: eligibleWorkflows.length,
            deletedCount: deleted,
            skippedCount: skipped,
            skippedDetails: skippedDetails.slice(0, 50) // cap payload
        });
    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
