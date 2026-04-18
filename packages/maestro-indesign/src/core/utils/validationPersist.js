/**
 * @file validationPersist.js
 * @description Közös helperek a validationsokat perzisztáló hookoknak
 * (useOverlapValidation, useWorkflowValidation).
 *
 * - `fetchAllValidationRows`: lapozott lekérés a SYSTEM_VALIDATIONS collection-ből,
 *   withRetry + rows/documents fallback.
 * - `queuePersist`: per-kulcs Promise-lánc, ami sorba fűzi a perzisztálásokat.
 *   Megakadályozza, hogy ugyanarra a kulcsra (publicationId/articleId + source)
 *   két párhuzamos hívás egymás fetch/write műveletét összekeverje.
 */

import { tables, DATABASE_ID, COLLECTIONS, Query } from "../config/appwriteConfig.js";
import { withRetry } from "./promiseUtils.js";
import { logError } from "./logger.js";
import { DATA_QUERY_CONFIG } from "./constants.js";

/**
 * Lapozva lekéri a SYSTEM_VALIDATIONS collection sorait a megadott szűrőkkel.
 * PAGE_SIZE-os kötegekben halad, amíg az utolsó köteg kisebb, mint PAGE_SIZE.
 *
 * @param {Array} baseQueries - Appwrite query feltételek.
 * @param {string} [operationName="fetchValidationRows"] - withRetry / log címke.
 * @returns {Promise<Array>} Az összes talált sor.
 */
export async function fetchAllValidationRows(baseQueries, operationName = "fetchValidationRows") {
    const allRows = [];
    let offset = 0;

    while (true) {
        const response = await withRetry(
            () => tables.listRows({
                databaseId: DATABASE_ID,
                tableId: COLLECTIONS.SYSTEM_VALIDATIONS,
                queries: [
                    ...baseQueries,
                    Query.limit(DATA_QUERY_CONFIG.PAGE_SIZE),
                    Query.offset(offset)
                ]
            }),
            { operationName }
        );

        const items = response?.rows || response?.documents;
        if (!Array.isArray(items)) {
            logError(`[${operationName}] Hibás válasz a tables.listRows-tól:`, response);
            break;
        }

        allRows.push(...items);

        if (items.length < DATA_QUERY_CONFIG.PAGE_SIZE) break;
        offset += DATA_QUERY_CONFIG.PAGE_SIZE;
    }

    return allRows;
}

// ---------------------------------------------------------------------------
// Per-kulcs perzisztálási queue (race védelem)
// ---------------------------------------------------------------------------

const persistChains = new Map();

/**
 * Sorba fűz egy perzisztálási műveletet egy kulcs (pl. `structure::pubId`) alatt.
 * Ugyanarra a kulcsra érkező további hívások megvárják az előző lezárását.
 *
 * Hiba esetén a chain-t tovább folytatjuk (nem terheljük az újabb hívókat
 * a korábbi hibával).
 *
 * @param {string} key - Egyedi kulcs (javasolt: `${source}::${id}`).
 * @param {() => Promise<T>} fn - A futtatandó aszinkron művelet.
 * @returns {Promise<T>}
 */
export function queuePersist(key, fn) {
    const previous = persistChains.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);

    // Az utolsó elemet tároljuk — ha több hívás jön, egymás után fűződnek.
    persistChains.set(key, current);

    // Ha ez volt az utolsó az adott kulcsra, takarítsunk a Map-ből.
    current.finally(() => {
        if (persistChains.get(key) === current) {
            persistChains.delete(key);
        }
    });

    return current;
}
