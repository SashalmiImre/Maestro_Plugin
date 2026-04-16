/**
 * Maestro Shared — Publikáció aktiválási validátor
 *
 * Egy publikáció akkor aktiválható, ha:
 *   1. Van workflow rendelve hozzá (workflowId nem null)
 *   2. Be van állítva a natív gyökérmappa (rootPath — létrehozáskor opcionális,
 *      aktiváláshoz kötelező, mert a Plugin ezen keresztül oldja fel a cikkek
 *      fájlútvonalát)
 *   3. Legalább egy határidő létezik
 *   4. A határidők a teljes coverageStart..coverageEnd tartományt lefedik
 *   5. A határidők nem fednek át egymással
 *   6. A határidők formátuma érvényes (dátum + idő)
 *
 * A 3–6. pontokat a `validateDeadlines` helper kezeli — ez csak kiegészíti
 * a workflowId + rootPath + "nincs határidő" ellenőrzéssel. A CF inline
 * másolja ezt a logikát a CommonJS minta miatt (ld. invite-to-organization).
 */

import { validateDeadlines } from './deadlineValidator.js';

/**
 * Publikáció aktiválási előfeltételek ellenőrzése.
 *
 * @param {Object} publication - { workflowId, rootPath, coverageStart, coverageEnd, ... }
 * @param {Array}  deadlines   - a publikációhoz tartozó határidők tömbje
 * @returns {{ isValid: boolean, errors: string[] }}
 */
export function validatePublicationActivation(publication, deadlines) {
    const errors = [];

    if (!publication?.workflowId) {
        errors.push('A kiadványhoz workflow-t kell választani.');
    }

    if (!publication?.rootPath || !publication.rootPath.trim()) {
        errors.push('A kiadvány gyökérmappáját a Pluginból kell beállítani aktiválás előtt.');
    }

    if (!deadlines || deadlines.length === 0) {
        errors.push('Legalább egy határidőt meg kell adni.');
    } else {
        const result = validateDeadlines(publication, deadlines);
        if (!result.isValid) {
            errors.push(...result.errors);
        }
    }

    return { isValid: errors.length === 0, errors };
}
