/**
 * Maestro Shared — Munkafolyamat konfiguráció
 *
 * Állapotok, markerek, időtartamok, állapot megjelenítés, csapat–mező leképezés.
 * Egyetlen igazságforrás a plugin és a dashboard számára.
 */

// ─── Állapotok ──────────────────────────────────────────────────────────────

/**
 * Munkafolyamat állapotok enumerációja.
 * @enum {number}
 */
export const WORKFLOW_STATES = {
    DESIGNING: 0,           // Tervezés alatt
    DESIGN_APPROVAL: 1,     // Elrendezés jóváhagyása
    WAITING_FOR_START: 2,   // Elindításra vár
    EDITORIAL_APPROVAL: 3,  // Szerkesztői jóváhagyás
    CONTENT_REVISION: 4,    // Tartalmi javítás (Korrektúra & Képcsere)
    FINAL_APPROVAL: 5,      // Végleges jóváhagyás
    PRINTABLE: 6,           // Nyomdakész
    ARCHIVABLE: 7           // Archiválható
};

// ─── Markerek ───────────────────────────────────────────────────────────────

/**
 * Jelölő (Marker) bitmaszkok.
 * @enum {number}
 */
export const MARKERS = {
    NONE: 0,
    IGNORE: 1          // Kimarad — a cikk ideiglenesen ki van hagyva a kiadványból
};

// ─── Állapot megjelenítés ───────────────────────────────────────────────────

/**
 * Állapot címkék (magyar nyelvű megjelenítési nevek).
 * @type {Object.<number, string>}
 */
export const STATUS_LABELS = {
    [WORKFLOW_STATES.DESIGNING]:          'Tervezés',
    [WORKFLOW_STATES.DESIGN_APPROVAL]:    'Terv ellenőrzés',
    [WORKFLOW_STATES.WAITING_FOR_START]:  'Elindításra vár',
    [WORKFLOW_STATES.EDITORIAL_APPROVAL]: 'Szerkesztői ellenőrzés',
    [WORKFLOW_STATES.CONTENT_REVISION]:   'Korrektúrázás',
    [WORKFLOW_STATES.FINAL_APPROVAL]:     'Végső ellenőrzés',
    [WORKFLOW_STATES.PRINTABLE]:          'Nyomdakész',
    [WORKFLOW_STATES.ARCHIVABLE]:         'Archiválható'
};

/**
 * Állapot színek (hex értékek).
 * A plugin CSS változókra fordítja ezeket, a dashboard közvetlenül használja.
 * @type {Object.<number, string>}
 */
export const STATUS_COLORS = {
    [WORKFLOW_STATES.DESIGNING]:          '#FFEA00',
    [WORKFLOW_STATES.DESIGN_APPROVAL]:    '#A4E700',
    [WORKFLOW_STATES.WAITING_FOR_START]:  '#FF9F1C',
    [WORKFLOW_STATES.EDITORIAL_APPROVAL]: '#FF3300',
    [WORKFLOW_STATES.CONTENT_REVISION]:   '#00E5FF',
    [WORKFLOW_STATES.FINAL_APPROVAL]:     '#4096EE',
    [WORKFLOW_STATES.PRINTABLE]:          '#FF40B0',
    [WORKFLOW_STATES.ARCHIVABLE]:         '#B366FF'
};

// ─── Állapot időtartamok (sürgősség-számításhoz) ────────────────────────────

/**
 * Az egyes állapotok becsült időtartama.
 * Formula: állapot idő = perPage × oldalszám + fixed
 *
 * @type {Object.<number, { perPage: number, fixed: number }>}
 */
export const STATE_DURATIONS = {
    [WORKFLOW_STATES.DESIGNING]:          { perPage: 60, fixed: 0 },
    [WORKFLOW_STATES.DESIGN_APPROVAL]:    { perPage: 30, fixed: 15 },
    [WORKFLOW_STATES.WAITING_FOR_START]:  { perPage: 10, fixed: 15 },
    [WORKFLOW_STATES.EDITORIAL_APPROVAL]: { perPage: 30, fixed: 15 },
    [WORKFLOW_STATES.CONTENT_REVISION]:   { perPage: 30, fixed: 10 },
    [WORKFLOW_STATES.FINAL_APPROVAL]:     { perPage: 10, fixed: 15 },
    [WORKFLOW_STATES.PRINTABLE]:          { perPage: 10, fixed: 5 }
};

// ─── Csapat → cikk mező leképezés ──────────────────────────────────────────

/**
 * Csapat slug → cikk contributor mezőnév.
 * @type {Object.<string, string>}
 */
export const TEAM_ARTICLE_FIELD = {
    'designers':        'designerId',
    'art_directors':    'artDirectorId',
    'editors':          'editorId',
    'managing_editors': 'managingEditorId',
    'proofwriters':     'proofwriterId',
    'writers':          'writerId',
    'image_editors':    'imageEditorId'
};

// ─── Label segédfüggvények ──────────────────────────────────────────────────

/**
 * Normalizál egy slug-ot az összehasonlításhoz (underscore eltávolítás).
 * @param {string} value
 * @returns {string}
 */
const normalizeSlug = (value) => value.replace(/_/g, '').toLowerCase();

/**
 * Ellenőrzi, hogy a felhasználói label-ek között megtalálható-e a team slug.
 * Normalizált összehasonlítást végez (underscore-mentes).
 *
 * @param {string[]} userLabels - A felhasználó Appwrite label-jei.
 * @param {string} slug - A team slug (pl. "art_directors").
 * @returns {boolean}
 */
export function labelMatchesSlug(userLabels, slug) {
    const normalizedSlug = normalizeSlug(slug);
    return userLabels.some(label => normalizeSlug(label) === normalizedSlug);
}
