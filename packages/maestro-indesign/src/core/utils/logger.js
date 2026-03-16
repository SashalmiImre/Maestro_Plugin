/**
 * @fileoverview Naplózási (Logging) segédprogram.
 * Egyszerű console wrapper az egységes logoláshoz.
 *
 * Exportált függvények: log, logError, logWarn, logDebug
 *
 * @module utils/logger
 *
 * @example
 * import { log, logError, logWarn, logDebug } from './utils/logger.js';
 *
 * log('[MyComponent] Valami történt:', data);
 * logError('[MyComponent] Hiba történt:', error);
 * logWarn('[MyComponent] Figyelmeztetés:', message);
 * logDebug('[MyComponent] Debug info (csak dev módban):', data);
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

/**
 * Fejlesztési módú naplózás — csak dev build-ben logol.
 * Production build-ben a Webpack dead code elimination eltávolítja az if-blokkot,
 * de a függvényhívás és az argumentum-kiértékelés (pl. template literal interpoláció)
 * megmarad. Hot path-eken szükség esetén a hívó oldalon
 * `if (process.env.NODE_ENV !== 'production')` guard használható.
 * @param {...any} args - Naplózandó argumentumok.
 */
export const logDebug = (...args) => {
    if (process.env.NODE_ENV !== 'production') {
        console.log(...args);
    }
};
