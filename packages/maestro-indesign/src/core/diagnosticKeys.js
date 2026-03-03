/**
 * Tiny dependency-free module exporting diagnostic storage keys.
 * Kept minimal so it can be imported early (module-level) without loading other deps.
 */
export const DIAGNOSTIC_KEYS = {
    error: 'maestro.lastError',
    rejection: 'maestro.lastRejection'
};

export default DIAGNOSTIC_KEYS;
