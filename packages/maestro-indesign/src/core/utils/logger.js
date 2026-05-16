/**
 * @fileoverview Naplózási (Logging) segédprogram.
 * Console wrapper PII-redaction-nal az egységes, biztonságos logoláshoz.
 *
 * S.13.2 (2026-05-15, R.S.13.2 Phase 1 partial close) — minden log-call
 * args-ja átfut a `redactArgs()` redact-pass-en (email-maszkolás, JWT/Bearer/
 * token pattern-detect, password/secret/cookie key-policy full-redact). ASVS V7
 * + CIS Controls 8. Phase 2 zárja le a teljes lefedettséget (maradék CF-ek,
 * build-generator, coverage-check). Részletek: `_docs/Komponensek/LoggingMonitoring.md`.
 *
 * Dev opt-out: `LOG_REDACT_DISABLE=true` env var, csak `NODE_ENV !== 'production'`
 * alatt aktiv (production-leak guard a `isRedactionDisabled()`-ben).
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

import { redactArgs, isRedactionDisabled } from 'maestro-shared/piiRedaction.js';

/**
 * KRITIKUS (Codex pre-review hidden risk #1): a `redactArgs` egy array-t ad
 * vissza, így spread-szel kell behívni a `console.*`-ba. NEM
 * `console.log(redactArgs(args))` — az egyetlen array argumentummal logolna.
 *
 * Codex adversarial #2: a `console.log.bind(console)` UXP host-on potenciálisan
 * NEM működik (host-injected non-bindable function), és module-load-time
 * elszállna → plugin startup failure. Lazy try/catch invocation a fallback
 * mintán: első hívás bindelt referenciát próbál, sikertelenség esetén közvetlen
 * `console.method(...)` hívás. (Statikus kódból sem a bind sem a direct nem
 * bizonyítható UXP-on — runtime smoke-teszttel verifikálható.)
 */
function callConsole(method, args) {
    const c = (typeof console !== 'undefined' && console) ? console : null;
    if (!c || typeof c[method] !== 'function') return;
    try {
        c[method](...args);
    } catch {
        try {
            Function.prototype.apply.call(c[method], c, args);
        } catch {
            // Végső no-op — egy log-call NE fagyassza meg a Plugin runtime-ot.
        }
    }
}

function safe(method, args) {
    if (isRedactionDisabled()) {
        callConsole(method, args);
        return;
    }
    callConsole(method, redactArgs(args));
}

/**
 * Üzenet naplózása a konzolra.
 * @param {...any} args - Naplózandó argumentumok.
 */
export const log = (...args) => {
    safe('log', args);
};

/**
 * Hiba naplózása a konzolra.
 * @param {...any} args - Naplózandó argumentumok.
 */
export const logError = (...args) => {
    safe('error', args);
};

/**
 * Figyelmeztetés naplózása a konzolra.
 * @param {...any} args - Naplózandó argumentumok.
 */
export const logWarn = (...args) => {
    safe('warn', args);
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
        safe('log', args);
    }
};
