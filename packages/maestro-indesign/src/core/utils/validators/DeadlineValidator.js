/**
 * @fileoverview Validátor a nyomdai határidők ellenőrzéséhez.
 *
 * Lokálisan hívott validátor (nem a validationRunner-en keresztül).
 * A DeadlinesSection komponens hívja minden módosításkor,
 * és az eredmény alapján blokkolja a kilépést a PublicationProperties-ből.
 *
 * Ellenőrzések:
 * 1. Tartomány: Kezdőoldal ≤ végoldal, és a kiadvány terjedelmén belül
 * 2. Átfedés: Két tartomány nem fedhet át egymással
 * 3. Lefedettség: Az összes tartománynak le kell fednie a kiadvány teljes terjedelmét
 * 4. Datetime: Érvényes dátum/idő megléte
 */

import { ValidatorBase } from "./ValidatorBase.js";

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
        const errors = [];
        const warnings = [];

        if (!deadlines || deadlines.length === 0) {
            // Üres határidő lista → nem hiba, de figyelmeztetés
            warnings.push('Nincsenek határidők megadva.');
            return this.success(warnings);
        }

        const coverageStart = publication?.coverageStart;
        const coverageEnd = publication?.coverageEnd;

        // Formátum és tartomány ellenőrzés minden határidőre
        deadlines.forEach((deadline, index) => {
            const label = `${index + 1}. határidő`;

            if (deadline.startPage == null || deadline.endPage == null) {
                errors.push(`${label}: Hiányzó kezdő- vagy végoldal.`);
            } else {
                if (deadline.startPage > deadline.endPage) {
                    errors.push(`${label}: A kezdőoldal (${deadline.startPage}) nem lehet nagyobb, mint a végoldal (${deadline.endPage}).`);
                }
                if (coverageStart != null && deadline.startPage < coverageStart) {
                    errors.push(`${label}: A kezdőoldal (${deadline.startPage}) nem lehet kisebb, mint a kiadvány kezdőoldala (${coverageStart}).`);
                }
                if (coverageEnd != null && deadline.endPage > coverageEnd) {
                    errors.push(`${label}: A végoldal (${deadline.endPage}) nem lehet nagyobb, mint a kiadvány végoldala (${coverageEnd}).`);
                }
            }

            if (!deadline.datetime) {
                errors.push(`${label}: Hiányzó dátum és időpont.`);
            } else if (!DeadlineValidator.isValidDatetime(deadline.datetime)) {
                errors.push(`${label}: Érvénytelen dátum/idő formátum.`);
            }
        });

        // Tartomány validációk (csak ha az alapvető mezők rendben vannak)
        const validRanges = deadlines.filter(d =>
            d.startPage != null && d.endPage != null && d.startPage <= d.endPage
        );

        // Átfedés ellenőrzés
        for (let i = 0; i < validRanges.length; i++) {
            for (let j = i + 1; j < validRanges.length; j++) {
                const a = validRanges[i];
                const b = validRanges[j];

                if (a.startPage <= b.endPage && b.startPage <= a.endPage) {
                    errors.push(
                        `Átfedés a ${a.startPage}–${a.endPage}. és a ${b.startPage}–${b.endPage}. oldalak tartománya között.`
                    );
                }
            }
        }

        // Lefedettség ellenőrzés (csak ha van érvényes coverage)
        if (coverageStart != null && coverageEnd != null && validRanges.length > 0) {
            const sortedRanges = [...validRanges].sort((a, b) => a.startPage - b.startPage);
            const uncoveredPages = [];
            let expectedStart = coverageStart;

            for (const range of sortedRanges) {
                if (range.startPage > expectedStart) {
                    uncoveredPages.push(`${expectedStart}–${range.startPage - 1}`);
                }
                expectedStart = Math.max(expectedStart, range.endPage + 1);
            }

            if (expectedStart <= coverageEnd) {
                uncoveredPages.push(`${expectedStart}–${coverageEnd}`);
            }

            if (uncoveredPages.length > 0) {
                errors.push(`Nem fedett oldalak: ${uncoveredPages.join(', ')}. oldal.`);
            }
        }

        return errors.length > 0 ? this.failure(errors, warnings) : this.success(warnings);
    }

    /**
     * ISO 8601 datetime string érvényességének ellenőrzése.
     * @param {string} isoString - Az ellenőrizendő datetime string
     * @returns {boolean}
     */
    static isValidDatetime(isoString) {
        if (typeof isoString !== 'string') return false;
        const date = new Date(isoString);
        return !isNaN(date.getTime());
    }

    /**
     * Dátum formátum ellenőrzése (ÉÉÉÉ.HH.NN).
     * A UI réteg használja a mezőszintű validációhoz.
     * @param {string} dateStr - Az ellenőrizendő dátum string
     * @returns {boolean}
     */
    static isValidDate(dateStr) {
        const match = dateStr.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
        if (!match) return false;

        const year = parseInt(match[1], 10);
        const month = parseInt(match[2], 10);
        const day = parseInt(match[3], 10);

        if (month < 1 || month > 12) return false;
        if (day < 1 || day > 31) return false;

        // Hónap-specifikus napszám ellenőrzés
        const daysInMonth = new Date(year, month, 0).getDate();
        return day <= daysInMonth;
    }

    /**
     * Idő formátum ellenőrzése (ÓÓ:PP).
     * A UI réteg használja a mezőszintű validációhoz.
     * @param {string} timeStr - Az ellenőrizendő idő string
     * @returns {boolean}
     */
    static isValidTime(timeStr) {
        const match = timeStr.match(/^(\d{2}):(\d{2})$/);
        if (!match) return false;

        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);

        return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
    }
}
