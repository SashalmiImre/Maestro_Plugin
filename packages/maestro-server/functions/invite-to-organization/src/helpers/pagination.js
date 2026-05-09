// H.1 (Phase 2, 2026-05-09) — cursor-pagináción alapuló listAll helper.
//
// A 2026-05-09 session-3 előtt 4 hívóhelyen (`backfill_tenant_acl`,
// `backfill_admin_team_acl`, `backfill_organization_status`, plusz egy
// in-loop `processCollection` cascade) a `cursorAfter`-ciklus mintát
// inline duplikáltuk. Single-source extract egy 100-soros modulba —
// minden új backfill action ezt használja, hogy a paginated listáknál
// ne vétsünk batch-méret/cursor-step driftet.
//
// Két forma:
//   - `listAllByQuery(...)`: gyűjtő — minden doc memóriába kerül. Kisebb
//      org-okra (≤ pár ezer rekord) jó. Nagy orgokon checkpoint pattern
//      (E.6) szükséges, ott a `paginateByQuery` formát kell használni.
//   - `paginateByQuery(...)`: streaming — page-enként hív processzort,
//      a feldolgozó `false`-t adhat vissza early-stop jelzéseként. E.6
//      checkpoint-pattern alapja: a feldolgozó page-enként commitálja a
//      progress-cursort egy DB-rekordba, hogy timeout után a következő
//      futás onnan folytassa.
//
// **Kontraktus**: a `queries` paramétert az SDK-tól kapjuk (NEM ez a
// modul build-eli a Query-t, mert az sdk-példány CF-pre kötött); a hívó
// adja a már összeállított `sdk.Query.equal(...)` stb. tömböt. A modul
// CSAK a paging-ot intézi (limit + cursorAfter).

const DEFAULT_BATCH_LIMIT = 100;

/**
 * @param {Object}   databases       - `sdk.Databases(client)` példány
 * @param {string}   databaseId      - target Appwrite DB id
 * @param {string}   collectionId    - target collection id
 * @param {Array}    queries         - előre-összeállított `sdk.Query.*` tömb
 * @param {Object}   sdk             - `node-appwrite` modul (Query.limit/cursorAfter)
 * @param {Object}   [options]
 * @param {number}   [options.batchSize=100] - per-page limit (Appwrite max 100)
 * @returns {Promise<Array>} — minden megfelelő doc, sorrendben
 */
async function listAllByQuery(databases, databaseId, collectionId, queries, sdk, options = {}) {
    const batchSize = options.batchSize || DEFAULT_BATCH_LIMIT;
    const out = [];
    let cursor = null;
    while (true) {
        const q = [...queries, sdk.Query.limit(batchSize)];
        if (cursor) q.push(sdk.Query.cursorAfter(cursor));
        const batch = await databases.listDocuments(databaseId, collectionId, q);
        out.push(...batch.documents);
        if (batch.documents.length < batchSize) break;
        cursor = batch.documents[batch.documents.length - 1].$id;
    }
    return out;
}

/**
 * Page-enkénti streaming feldolgozó. A processor visszaadhat:
 *   - `false` (vagy `{ stop: true }`)  → early-stop, a loop kilép
 *   - bármi mást               → továbbmegy a következő oldalra
 *
 * E.6 (Phase 2, 2026-05-09) — időkeret-figyelés a CF timeout előtti
 * graceful kilépéshez: ha `options.maxRunMs` meg van adva, a `startedAt`-
 * től elkapott elapsed-et minden iteráció elején nézzük; ha túlhalad, a
 * loop kilép `incomplete: true` jelzéssel + a current cursorral. A hívó
 * iteratíven hívhatja a következő futást az `lastCursor`-tól (checkpoint
 * pattern alapja). A `startedAt` opcionális — ha nincs megadva, a hívás
 * pillanata a kezdés.
 *
 * @param {Object}   databases
 * @param {string}   databaseId
 * @param {string}   collectionId
 * @param {Array}    queries
 * @param {Object}   sdk
 * @param {Function} processor       - async (docs, ctx) => false|{stop:true}|any
 *   ctx: `{ pageIndex, cursorBefore, lastDocId, totalSoFar }`
 * @param {Object}   [options]
 * @param {number}   [options.batchSize=100]
 * @param {number}   [options.maxRunMs]   - kilép, ha az elapsed túlhalad
 * @param {number}   [options.startedAt]  - Date.now() kezdés (default: hívás)
 * @param {string}   [options.fromCursor] - resume-cursor (előző hívás `lastCursor`-ja)
 * @returns {Promise<{ pages: number, total: number, lastCursor: string|null, incomplete: boolean }>}
 */
async function paginateByQuery(databases, databaseId, collectionId, queries, sdk, processor, options = {}) {
    const batchSize = options.batchSize || DEFAULT_BATCH_LIMIT;
    const maxRunMs = options.maxRunMs;
    const startedAt = options.startedAt || Date.now();
    let cursor = options.fromCursor || null;
    let pagesProcessed = 0;
    let total = 0;
    let incomplete = false;

    while (true) {
        if (maxRunMs && (Date.now() - startedAt) > maxRunMs) {
            incomplete = true;
            break;
        }
        const q = [...queries, sdk.Query.limit(batchSize)];
        const cursorBefore = cursor;
        if (cursor) q.push(sdk.Query.cursorAfter(cursor));
        const batch = await databases.listDocuments(databaseId, collectionId, q);

        if (!batch.documents || batch.documents.length === 0) break;
        total += batch.documents.length;

        const lastDocId = batch.documents[batch.documents.length - 1].$id;
        const result = await processor(batch.documents, {
            pageIndex: pagesProcessed,
            cursorBefore,
            lastDocId,
            totalSoFar: total
        });
        // Csak akkor advance-oljuk a `lastCursor`-t és a `pagesProcessed`-et,
        // ha a processor ténylegesen lefutott a teljes oldalra. Egy early-stop
        // jelzés (`false` / `{stop:true}`) esetén a current cursor az ELŐZŐ
        // page lastDocId-ja, mert ezen az oldalon a feldolgozás megszakadt
        // (resume innen kezdődik az új futáson).
        if (result === false || (result && result.stop === true)) break;

        cursor = lastDocId;
        pagesProcessed++;
        if (batch.documents.length < batchSize) break;
    }

    return { pages: pagesProcessed, total, lastCursor: cursor, incomplete };
}

module.exports = {
    DEFAULT_BATCH_LIMIT,
    listAllByQuery,
    paginateByQuery
};
