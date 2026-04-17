/**
 * Maestro Shared — Publikáció aktiválási validátor
 *
 * Egy publikáció akkor aktiválható, ha:
 *   1. Van workflow rendelve hozzá (workflowId nem null)
 *   2. Legalább egy határidő létezik
 *   3. A határidők a teljes coverageStart..coverageEnd tartományt lefedik
 *   4. A határidők nem fednek át egymással
 *   5. A határidők formátuma érvényes (dátum + idő)
 *
 * A 2–5. pontokat a `validateDeadlines` helper kezeli — ez csak kiegészíti
 * a workflowId + "nincs határidő" ellenőrzéssel. A CF inline másolja ezt
 * a logikát a CommonJS minta miatt (ld. invite-to-organization).
 *
 * A rootPath NEM feltétele az aktiválásnak — létrehozáskor és aktiváláskor
 * is lehet null. A Plugin az aktivált, rootPath-nélküli kiadványokat narancs
 * „Konfiguráció szükséges" állapotban jeleníti meg (#33), és a user a
 * Plugin folder pickerével állítja be utólag (#34). Aktiválás előtti
 * rootPath-követelmény deadlockot okozna: a Plugin csak aktivált pubokat
 * lát, így a picker soha nem lenne elérhető.
 */

import { validateDeadlines } from './deadlineValidator.js';

/**
 * Publikáció aktiválási előfeltételek ellenőrzése.
 *
 * @param {Object} publication - { workflowId, coverageStart, coverageEnd, ... }
 * @param {Array}  deadlines   - a publikációhoz tartozó határidők tömbje
 * @returns {{ isValid: boolean, errors: string[] }}
 */
export function validatePublicationActivation(publication, deadlines) {
    const errors = [];

    if (!publication?.workflowId) {
        errors.push('A kiadványhoz workflow-t kell választani.');
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
