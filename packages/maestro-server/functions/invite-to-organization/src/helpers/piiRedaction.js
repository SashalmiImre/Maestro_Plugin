/**
 * PII-redaction helper — CommonJS inline-portolt másolat
 * (S.13.2, R.S.13.2 Phase 1 partial close).
 *
 * **DRIFT KOCKÁZAT**: ez a fájl LOGIKAILAG ekvivalens, CommonJS-portolt
 * másolat a kanonikus shared modulból: `packages/maestro-shared/piiRedaction.js`.
 * NEM fájl-szintű 1:1 (ESM `export function` → CommonJS `module.exports`),
 * de a redaction-logika, konstansok, regex-ek és kulcs-policy-k azonosak.
 * Phase 2 (külön iteráció): build-generator pattern (S.7.7b precedens)
 * automatikusan generálja és drift-guard-dal ellenőrzi. ADDIG: manuálisan
 * kell szinkronban tartani.
 *
 * Phase 2 scope (a kanonikus shared modul docblock-ja a teljes listát adja):
 * maradék CF-ek wrap, build-generator, coverage-check script, LONG_TOKEN_REGEX
 * false-positive finomítás (key-aware mode).
 *
 * Hivatkozott komment-anyag a forrás-modulban. Logika változatlan.
 */

// ────────────────────────────────────────────────────────────────────────────
// Konstansok
// ────────────────────────────────────────────────────────────────────────────

const FULL_REDACT_KEY_PATTERNS = [
    'password', 'secret', 'apikey', 'api_key', 'api-key',
    'authorization', 'cookie', 'set-cookie',
    'x-appwrite-key', 'x-appwrite-session',
    'refresh'
];

const TOKEN_LAST4_KEY_PATTERNS = [
    'token', 'jwt', 'sessionid', 'session_id', 'invitetoken'
];

const EMAIL_REGEX = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BEARER_REGEX = /Bearer\s+([A-Za-z0-9._\-+/=]+)/g;
const LONG_TOKEN_REGEX = /\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9_-]{40,}\b/g;

const FULL_REDACT_PLACEHOLDER = '***REDACTED***';
const MAX_DEPTH = 3;
const MAX_KEYS_PER_OBJECT = 100;

// ────────────────────────────────────────────────────────────────────────────
// String-szintű redact-helpers
// ────────────────────────────────────────────────────────────────────────────

function redactEmail(str) {
    if (typeof str !== 'string') return str;
    return str.replace(EMAIL_REGEX, '$1***$2');
}

function redactTokenLast4(str) {
    if (typeof str !== 'string' || str.length < 8) return FULL_REDACT_PLACEHOLDER;
    return `...${str.slice(-4)}`;
}

function redactString(str) {
    if (typeof str !== 'string') return str;
    let out = str;
    out = out.replace(JWT_REGEX, FULL_REDACT_PLACEHOLDER);
    out = out.replace(BEARER_REGEX, 'Bearer ' + FULL_REDACT_PLACEHOLDER);
    out = redactEmail(out);
    out = out.replace(LONG_TOKEN_REGEX, FULL_REDACT_PLACEHOLDER);
    return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Object-szintű redact (rekurzív, depth-limited, cycle-safe)
// ────────────────────────────────────────────────────────────────────────────

function matchKeyPolicy(key) {
    if (typeof key !== 'string') return 'none';
    const k = key.toLowerCase();
    for (const p of FULL_REDACT_KEY_PATTERNS) {
        if (k.includes(p)) return 'full';
    }
    for (const p of TOKEN_LAST4_KEY_PATTERNS) {
        if (k === p || k.endsWith(p)) return 'last4';
    }
    return 'none';
}

function redactErrorObject(err, depth, seen) {
    if (!err) return err;
    const out = {
        name: err.name || 'Error',
        message: redactValue(err.message, depth + 1, seen),
        stack: typeof err.stack === 'string' ? redactString(err.stack) : err.stack
    };
    if (err.cause !== undefined) {
        out.cause = redactValue(err.cause, depth + 1, seen);
    }
    // Appwrite SDK / fetch-error pattern: lásd shared modul komment.
    if (err.response !== undefined) {
        out.response = redactValue(err.response, depth + 1, seen);
    }
    return out;
}

function redactValue(value, depth, seen) {
    if (depth === undefined) depth = 0;
    if (value === null || value === undefined) return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
    if (typeof value === 'function' || typeof value === 'symbol') return value;
    if (typeof value === 'string') return redactString(value);

    if (depth >= MAX_DEPTH) return '[max-depth]';

    if (!seen) seen = new WeakSet();
    if (typeof value === 'object') {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
    }

    if (value instanceof Error) {
        return redactErrorObject(value, depth, seen);
    }

    if (Array.isArray(value)) {
        return value.slice(0, MAX_KEYS_PER_OBJECT).map(v => redactValue(v, depth + 1, seen));
    }

    if (typeof value === 'object') {
        const out = {};
        let count = 0;
        for (const key of Object.keys(value)) {
            if (count++ >= MAX_KEYS_PER_OBJECT) {
                out['__truncated__'] = `+${Object.keys(value).length - MAX_KEYS_PER_OBJECT}`;
                break;
            }
            const policy = matchKeyPolicy(key);
            if (policy === 'full') {
                out[key] = FULL_REDACT_PLACEHOLDER;
            } else if (policy === 'last4') {
                out[key] = typeof value[key] === 'string' ? redactTokenLast4(value[key]) : redactValue(value[key], depth + 1, seen);
            } else {
                out[key] = redactValue(value[key], depth + 1, seen);
            }
        }
        return out;
    }

    return value;
}

function redactArgs(args) {
    if (!Array.isArray(args)) return args;
    return args.map(a => redactValue(a, 0, new WeakSet()));
}

function isRedactionDisabled() {
    if (typeof process === 'undefined' || !process.env) return false;
    if (process.env.NODE_ENV === 'production') return false;
    return process.env.LOG_REDACT_DISABLE === 'true';
}

module.exports = {
    redactEmail,
    redactTokenLast4,
    redactString,
    redactValue,
    redactArgs,
    isRedactionDisabled
};
