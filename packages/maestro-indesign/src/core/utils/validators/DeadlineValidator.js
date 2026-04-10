/**
 * @fileoverview Validátor a nyomdai határidők ellenőrzéséhez.
 *
 * Lokálisan hívott validátor (nem a validationRunner-en keresztül).
 * A DeadlinesSection komponens hívja minden módosításkor,
 * és az eredmény alapján blokkolja a kilépést a PublicationProperties-ből.
 *
 * Az összes validációs logika a `maestro-shared/deadlineValidator`-ban él,
 * ez az osztály csak a `ValidatorBase` interfészbe illeszti be (runner-kompatibilitás
 * és statikus formátum-ellenőrző helper-ek megtartása a UI réteg számára).
 */

import { ValidatorBase } from "./ValidatorBase.js";
import {
    validateDeadlines,
    isValidDate,
    isValidTime,
    isValidDatetime
} from "maestro-shared/deadlineValidator.js";

export class DeadlineValidator extends ValidatorBase {
    constructor() {
        super(ValidatorBase.SCOPES.PUBLICATION);
    }

    /**
     * Határidők validálása a kiadvány kontextusában.
     *
     * @param {Object} publication - A kiadvány objektum (coverageStart, coverageEnd)
     * @param {Array} deadlines - A határidők tömbje ({ startPage, endPage, datetime })
     * @returns {Object} Validációs eredmény { isValid, errors[], warnings[] }
     */
    async validate(publication, deadlines) {
        const result = validateDeadlines(publication, deadlines);
        return result.isValid
            ? this.success(result.warnings)
            : this.failure(result.errors, result.warnings);
    }

    // A statikus helper-ek a shared modulból származnak — a UI réteg (DeadlinesSection)
    // változatlanul hívhatja őket `DeadlineValidator.isValidDate(...)` formában.
    static isValidDate(dateStr) {
        return isValidDate(dateStr);
    }

    static isValidTime(timeStr) {
        return isValidTime(timeStr);
    }

    static isValidDatetime(isoString) {
        return isValidDatetime(isoString);
    }
}
