/**
 * @fileoverview Promise (aszinkron művelet) segédfüggvények.
 * 
 * @module utils/promiseUtils
 */

import { isServerError, isNetworkError } from "./errorUtils.js";
import { logWarn } from "./logger.js";
import { RETRY_CONFIG } from "./constants.js";

/**
 * Időkorlátot (timeout) ad egy Promise-hoz.
 * Ha a megadott Promise nem teljesül a határidőn belül, a visszatérési érték egy elutasított (rejected)
 * Promise lesz Timeout Error hibával.
 * 
 * Ezzel elkerülhető, hogy egy beragadt hálózati kérés vagy lassú művelet végtelen ideig
 * blokkolja az alkalmazást.
 * 
 * @param {Promise} promise - Az eredeti Promise, amit figyelni szeretnénk.
 * @param {number} [timeoutMs=10000] - Időkorlát ezredmásodpercben (alapértelmezett: 10000ms = 10s).
 * @param {string} [operationName="Operation"] - A művelet neve, ami bekerül a hibaüzenetbe a könnyebb debugolásért.
 * 
 * @returns {Promise} - Az eredeti Promise eredménye (ha időben teljesül), 
 *                    vagy egy elutasítás (Error) "timed out" üzenettel.
 * 
 * @example
 * try {
 *   const data = await withTimeout(
 *     fetch('https://api.example.com/data'), 
 *     5000, 
 *     'DataFetch'
 *   );
 * } catch (error) {
 *   console.error(error.message); // "DataFetch timed out after 5000ms"
 * }
 */
export const withTimeout = (promise, timeoutMs = 10000, operationName = "Operation") => {
    let timeoutId;

    // Egy Promise, ami 'timeoutMs' idő múlva rejectál (elutasít)
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`${operationName} időtúllépés ${timeoutMs}ms után`));
        }, timeoutMs);
    });

    // Versenyeztetjük az eredeti Promise-t és a timeout Promise-t
    // A timer mindig törlődik, függetlenül attól, hogy melyik nyer
    return Promise.race([promise, timeoutPromise]).then(
        (result) => {
            clearTimeout(timeoutId);
            return result;
        },
        (error) => {
            clearTimeout(timeoutId);
            throw error;
        }
    );
};

/**
 * Újrapróbálkozás exponenciális backoff-fal átmeneti szerver- és hálózati hibáknál.
 *
 * Csak átmeneti hibák esetén próbálkozik újra (502, 503, 504, hálózati hibák).
 * Üzleti logika hibák (401, 403, 404, 409 stb.) azonnal továbbdobódnak.
 *
 * @param {() => Promise} fn - Az újrapróbálandó aszinkron művelet (függvény, ami Promise-t ad vissza).
 * @param {Object} [options] - Konfigurációs opciók.
 * @param {number} [options.maxAttempts] - Maximum próbálkozások száma (alapértelmezett: RETRY_CONFIG.MAX_ATTEMPTS).
 * @param {number} [options.baseDelayMs] - Alap késleltetés ms-ben (alapértelmezett: RETRY_CONFIG.BASE_DELAY_MS).
 * @param {string} [options.operationName="Operation"] - A művelet neve a logoláshoz.
 * @returns {Promise} Az eredeti Promise eredménye, ha sikerül.
 * @throws {Error} Az utolsó hibát dobja, ha minden próbálkozás sikertelen.
 *
 * @example
 * const result = await withRetry(
 *   () => tables.updateRow({ databaseId, tableId, rowId, data }),
 *   { operationName: "updateValidation" }
 * );
 */
export const withRetry = async (fn, options = {}) => {
    const {
        maxAttempts = RETRY_CONFIG.MAX_ATTEMPTS,
        baseDelayMs = RETRY_CONFIG.BASE_DELAY_MS,
        operationName = "Operation"
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Csak átmeneti hibáknál próbálkozunk újra
            const isRetryable = isServerError(error) || isNetworkError(error);

            if (!isRetryable || attempt === maxAttempts) {
                throw error;
            }

            // Exponenciális backoff: baseDelay * 2^(attempt-1) → 1s, 2s, 4s...
            const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
            logWarn(
                `[withRetry] ${operationName} sikertelen (${attempt}/${maxAttempts}), ` +
                `újrapróbálás ${delayMs}ms múlva:`,
                error.message || error
            );

            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    // Biztonsági háló (elméletileg ide nem jutunk)
    throw lastError;
};
