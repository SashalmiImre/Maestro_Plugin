/**
 * @fileoverview Naplózási (Logging) segédprogram.
 * Egyszerű console wrapper az egységes logoláshoz.
 *
 * @module utils/logger
 *
 * @example
 * import { log, logError, logWarn } from './utils/logger.js';
 *
 * log('[MyComponent] Valami történt:', data);
 * logError('[MyComponent] Hiba történt:', error);
 * logWarn('[MyComponent] Figyelmeztetés:', message);
 */

/**
 * Üzenet naplózása a konzolra.
 * @param {...any} args - Naplózandó argumentumok.
 */
export const log = (...args) => {
    console.log(...args);
};

/**
 * Hiba naplózása a konzolra.
 * @param {...any} args - Naplózandó argumentumok.
 */
export const logError = (...args) => {
    console.error(...args);
};

/**
 * Figyelmeztetés naplózása a konzolra.
 * @param {...any} args - Naplózandó argumentumok.
 */
export const logWarn = (...args) => {
    console.warn(...args);
};
