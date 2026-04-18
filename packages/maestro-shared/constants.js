/**
 * Maestro Shared — Közös konstansok
 *
 * Platform-független enumerációk, amiket mindkét projekt használ.
 */

/**
 * Zárolás típusok.
 * @enum {string}
 */
export const LOCK_TYPE = {
    USER: 'user',
    SYSTEM: 'system'
};

/**
 * Validáció típusok (felhasználói validációk severity szintjei).
 * A SUCCESS a Plugin-oldali `isResolved` megjelenítéshez használt — a DB-ben
 * nem fordul elő, de az UI state-kalkuláció ismeri.
 * @enum {string}
 */
export const VALIDATION_TYPES = {
    ERROR: 'error',
    WARNING: 'warning',
    INFO: 'info',
    SUCCESS: 'success'
};

/**
 * Jelölő (Marker) bitmaszkok.
 * A cikk megjelenítési állapotát jelölik (pl. kimarad a kiadványból).
 * @enum {number}
 */
export const MARKERS = {
    NONE: 0,
    IGNORE: 1
};

/**
 * Workflow láthatóság (#30).
 * - ORGANIZATION: az adott org bármely office-ának tagjai látják
 * - EDITORIAL_OFFICE: csak az adott office tagjai látják (default)
 *
 * @enum {string}
 */
export const WORKFLOW_VISIBILITY = {
    ORGANIZATION: 'organization',
    EDITORIAL_OFFICE: 'editorial_office'
};

export const WORKFLOW_VISIBILITY_VALUES = [
    WORKFLOW_VISIBILITY.ORGANIZATION,
    WORKFLOW_VISIBILITY.EDITORIAL_OFFICE
];

export const WORKFLOW_VISIBILITY_DEFAULT = WORKFLOW_VISIBILITY.EDITORIAL_OFFICE;
