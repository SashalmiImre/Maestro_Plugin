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
 * @enum {string}
 */
export const VALIDATION_TYPES = {
    ERROR: 'error',
    WARNING: 'warning',
    INFO: 'info'
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
