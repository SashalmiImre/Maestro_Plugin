/**
 * Maestro Server — Deadline-validáció (Fázis 1 helper-extract, 2026-05-02).
 *
 * `validateDeadlinesInline` — A.2.2 pre-aktiválási check. Ugyanaz a logika,
 * mint a `validate-publication-update` CF §5-ben — a két forrás SZINKRONBAN
 * MARAD (manuális, nincs build pipeline).
 *
 * Ellenőrzi, hogy a deadline-ok érvényesek (formátum, oldalszám-tartomány),
 * nincs köztük átfedés, és teljes lefedést adnak a publikáció `coverageStart..
 * coverageEnd` tartományára.
 */

/**
 * @param {Object} publication — `{ coverageStart, coverageEnd }` mezőket olvas
 * @param {Array<{ startPage, endPage, datetime }>} deadlines
 * @returns {{ isValid: boolean, errors: string[] }}
 */
function validateDeadlinesInline(publication, deadlines) {
    const errors = [];
    if (!deadlines || deadlines.length === 0) return { isValid: true, errors };

    const coverageStart = publication?.coverageStart;
    const coverageEnd = publication?.coverageEnd;
    deadlines.forEach((d, i) => {
        const label = `${i + 1}. határidő`;
        if (d.startPage == null || d.endPage == null) {
            errors.push(`${label}: Hiányzó kezdő- vagy végoldal.`);
        } else {
            if (d.startPage > d.endPage) errors.push(`${label}: A kezdőoldal nem lehet nagyobb, mint a végoldal.`);
            if (coverageStart != null && d.startPage < coverageStart) errors.push(`${label}: A kezdőoldal kisebb, mint a kiadvány kezdőoldala.`);
            if (coverageEnd != null && d.endPage > coverageEnd) errors.push(`${label}: A végoldal nagyobb, mint a kiadvány végoldala.`);
        }
        if (!d.datetime || isNaN(new Date(d.datetime).getTime())) {
            errors.push(`${label}: Érvénytelen dátum/idő.`);
        }
    });

    const validRanges = deadlines.filter(d => d.startPage != null && d.endPage != null && d.startPage <= d.endPage);
    for (let i = 0; i < validRanges.length; i++) {
        for (let j = i + 1; j < validRanges.length; j++) {
            const a = validRanges[i], b = validRanges[j];
            if (a.startPage <= b.endPage && b.startPage <= a.endPage) {
                errors.push(`Átfedés a ${a.startPage}–${a.endPage} és ${b.startPage}–${b.endPage} oldalak tartománya között.`);
            }
        }
    }

    if (coverageStart != null && coverageEnd != null && validRanges.length > 0) {
        const sorted = [...validRanges].sort((a, b) => a.startPage - b.startPage);
        let expectedStart = coverageStart;
        const uncovered = [];
        for (const r of sorted) {
            if (r.startPage > expectedStart) uncovered.push(`${expectedStart}–${r.startPage - 1}`);
            expectedStart = Math.max(expectedStart, r.endPage + 1);
        }
        if (expectedStart <= coverageEnd) uncovered.push(`${expectedStart}–${coverageEnd}`);
        if (uncovered.length > 0) errors.push(`Nem fedett oldalak: ${uncovered.join(', ')}.`);
    }
    return { isValid: errors.length === 0, errors };
}

module.exports = {
    validateDeadlinesInline
};
