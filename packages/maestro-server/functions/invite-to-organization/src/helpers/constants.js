/**
 * Maestro Server — Megosztott konstansok (Fázis 1 helper-extract, 2026-05-02).
 *
 * Ez a modul azokat a konstansokat tartalmazza, amelyeket a `main.js` és a
 * `helpers/*` modulok egyaránt használnak. A komment-anyag a kanonikus
 * `main.js`-ben volt, onnan költözött át változatlanul.
 *
 * A `SLUG_REGEX`, `SLUG_MAX_LENGTH`, `NAME_MAX_LENGTH` SZÁNDÉKOSAN a `main.js`-ben
 * marad, mert a `slugifyName` / `sanitizeString` utility-k ott élnek és csak a
 * `main.js` actionjeiben használtak.
 */

// Kaszkád törlés batch mérete — lapozás a nagy dokumentum-mennyiségek kezeléséhez.
const CASCADE_BATCH_LIMIT = 100;

// Scan-eredmény felső korlát forrásonként (delete_group referencia-check).
// Ha egy scan eléri, a hátralévő lapokat nem olvassuk — az admin UI-nak ennyi
// példa bőven elég a "használatban van" állapot érzékeltetéséhez, és a payload
// + memória bounded marad pathologikus (tízezer+ hivatkozás) esetekben is.
const MAX_REFERENCES_PER_SCAN = 50;

// Workflow láthatóság enum — Feladat #80 (2026-04-20) óta 3-way: a `public`
// scope-pal a workflow a teljes platformon elérhető (minden authentikált
// user láthatja). A 2-way MVP (#30) `editorial_office` / `organization`
// szemantikája változatlan.
const WORKFLOW_VISIBILITY_VALUES = ['organization', 'editorial_office', 'public'];
const WORKFLOW_VISIBILITY_DEFAULT = 'editorial_office';

// Sentinel a `contributorJsonReferencesSlug` parse-hibás visszatéréséhez —
// fail-closed jelzés a hívóknak (delete_group/archive_group blocker scan).
const PARSE_ERROR = 'parse_error';

module.exports = {
    CASCADE_BATCH_LIMIT,
    MAX_REFERENCES_PER_SCAN,
    WORKFLOW_VISIBILITY_VALUES,
    WORKFLOW_VISIBILITY_DEFAULT,
    PARSE_ERROR
};
