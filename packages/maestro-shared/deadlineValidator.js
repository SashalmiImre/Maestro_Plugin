/**
 * Maestro Shared — Határidő validátor helper függvények
 *
 * Tiszta, keretrendszer-független validációs logika a nyomdai határidőkhöz.
 * Mind a Plugin `DeadlineValidator` (ValidatorBase-en át), mind a Dashboard
 * `PublicationSettingsModal` közvetlenül ezeket a függvényeket használja —
 * így egyetlen igazságforrásból származik a formátum és a tartalmi validáció.
 *
 * Adatmodell:
 *   deadline = {
 *     startPage: int,
 *     endPage: int,
 *     datetime: ISO string ("YYYY-MM-DDTHH:MM:SS.sss+00:00")
 *   }
 *
 * Ellenőrzések:
 *   1. Tartomány: startPage ≤ endPage, és a kiadvány fedésén belül
 *   2. Átfedés: Két tartomány nem fedheti egymást
 *   3. Lefedettség: A tartományoknak le kell fedniük a teljes kiadványt
 *   4. Datetime: Érvényes ISO 8601 formátum
 */

/**
 * ISO 8601 datetime string érvényességének ellenőrzése.
 *
 * Figyelmeztetés: a `new Date()` clamp-el (pl. "2024-01-01T25:00:00" →
 * "2024-01-02T01:00:00"), ezért ez a függvény szemantikai érvényességet
 * nem garantál — csak azt, hogy a string Date-té parse-olható.
 * Formátum-szintű ellenőrzéshez használd az `isValidDate`/`isValidTime`-ot.
 *
 * @param {string} isoString
 * @returns {boolean}
 */
export function isValidDatetime(isoString) {
    if (typeof isoString !== 'string') return false;
    const date = new Date(isoString);
    return !isNaN(date.getTime());
}

/**
 * Dátum formátum ellenőrzése (ÉÉÉÉ.HH.NN).
 * A UI réteg használja a mezőszintű validációhoz.
 * @param {string} dateStr
 * @returns {boolean}
 */
export function isValidDate(dateStr) {
    if (typeof dateStr !== 'string') return false;
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
 * @param {string} timeStr
 * @returns {boolean}
 */
export function isValidTime(timeStr) {
    if (typeof timeStr !== 'string') return false;
    const match = timeStr.match(/^(\d{2}):(\d{2})$/);
    if (!match) return false;

    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);

    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/**
 * ISO datetime string → dátum rész ("ÉÉÉÉ.HH.NN").
 * @param {string} isoString
 * @returns {string} üres string, ha a bemenet érvénytelen
 */
export function getDateFromDatetime(isoString) {
    if (!isoString) return '';
    const match = String(isoString).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
}

/**
 * ISO datetime string → idő rész ("ÓÓ:PP").
 * @param {string} isoString
 * @returns {string} üres string, ha a bemenet érvénytelen
 */
export function getTimeFromDatetime(isoString) {
    if (!isoString) return '';
    const match = String(isoString).match(/T(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : '';
}

/**
 * Dátum ("ÉÉÉÉ.HH.NN") + idő ("ÓÓ:PP") → ISO datetime string.
 * @param {string} datePart
 * @param {string} timePart
 * @returns {string|null} null, ha bármelyik rész érvénytelen
 */
export function buildDatetime(datePart, timePart) {
    const dateMatch = typeof datePart === 'string' ? datePart.match(/^(\d{4})\.(\d{2})\.(\d{2})$/) : null;
    const timeMatch = typeof timePart === 'string' ? timePart.match(/^(\d{2}):(\d{2})$/) : null;
    if (!dateMatch || !timeMatch) return null;
    return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${timeMatch[1]}:${timeMatch[2]}:00.000+00:00`;
}

/**
 * Teljes határidő lista validációja a kiadvány kontextusában.
 *
 * @param {Object} publication - A kiadvány objektum (coverageStart, coverageEnd)
 * @param {Array}  deadlines   - A határidők tömbje ({ startPage, endPage, datetime })
 * @returns {{ isValid: boolean, errors: string[], warnings: string[] }}
 */
export function validateDeadlines(publication, deadlines) {
    const errors = [];
    const warnings = [];

    if (!deadlines || deadlines.length === 0) {
        warnings.push('Nincsenek határidők megadva.');
        return { isValid: true, errors, warnings };
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
        } else if (!isValidDatetime(deadline.datetime)) {
            errors.push(`${label}: Érvénytelen dátum/idő formátum.`);
        }
    });

    // Tartomány validációk (csak ha az alapvető mezők rendben vannak)
    const validRanges = deadlines.filter(
        (d) => d.startPage != null && d.endPage != null && d.startPage <= d.endPage
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

    return {
        isValid: errors.length === 0,
        errors,
        warnings
    };
}
