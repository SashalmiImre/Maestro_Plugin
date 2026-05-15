/**
 * AUTO-GENERATED FILE — DO NOT EDIT.
 * Source: packages/maestro-shared/piiRedaction.js
 * Regenerate: yarn build:cf-response-helpers
 *
 * A kanonikus ESM forrás CommonJS pillanatképe. CF deploy-időben a
 * workspace yarn link NEM oldódik fel, ezért minden CF saját másolatot
 * tart. Generálás: scripts/build-cf-response-helpers.mjs (S.13.3 Phase 2.1).
 */
/**
 * Maestro Shared — PII-redaction helper (S.13.2, R.S.13.2 Phase 1 partial close).
 *
 * **PHASE 1 PARTIAL ROLLOUT — NEM production-szintű teljes PII-redaction**
 * (Codex adversarial #1 finding 2026-05-15). A rendszer-szintű
 * centralized-log védelem CSAK akkor érvényes, ha minden CF (~10-15
 * függvény) wrap-elve van. Jelenleg: Plugin logger + 1 demo CF
 * (`invite-to-organization`). A maradék CF-ek (user-cascade-delete,
 * validate-publication-update, update-article, resend-webhook, stb.)
 * RAW log-olnak — Phase 2 zárja le a teljes lefedettséget.
 *
 * Threat model: a `log()` / `error()` helper-ek nyers email-t, JWT-t,
 * Appwrite session-tokent, bearer-credentials-t, password-mezőt, cookie-t
 * írhatnak a centralized server log-ba (Appwrite Console mások-által-elérhető,
 * Railway log-aggregation, fél-publikus). Forensics / GDPR Art. 32 megköveteli
 * a PII redaction-t at-rest.
 *
 * Scope (Phase 1, JELENLEGI):
 * - Plugin `logger.js` (`packages/maestro-indesign/src/core/utils/logger.js`)
 * - CF `invite-to-organization` (`packages/maestro-server/functions/invite-to-organization`)
 *   — a leggyakrabban hívott CF, legtöbb PII-t logol.
 * - Dashboard NEM (CLAUDE.md: `console.*` policy-elfogadott; browser console
 *   nem centralized log sink).
 *
 * Scope (Phase 2 — külön iteráció, R.S.13.2 → Closed prerekvizit):
 * - Maradék CF-ek (~10-15 függvény) wrap-je.
 * - Build-generator S.7.7b precedens-szel automatikusan generált CommonJS
 *   inline-másolat + drift-guard.
 * - Coverage-check script (`scripts/check-cf-log-wrap.mjs`): fail-el, ha
 *   bármely CF main.js `({ req, res, log, error })`-t használ wrapping nélkül.
 * - `LONG_TOKEN_REGEX` false-positive finomítás: jelenleg minden 32+ hex /
 *   40+ alfanumerikus blokk REDACTED, ami md5/sha hash, content-hash,
 *   deterministic doc-hash false-positive-ot okoz incidens-korrelációkor.
 *   Phase 2: key-aware mode (csak `token`/`secret`/stb. kulcs alatt aktív
 *   long-token regex), vagy allowlist (`hash`, `checksum`, `docId`).
 *
 * **DRIFT KOCKÁZAT**: a CF (CommonJS) inline-másolat él a
 * `packages/maestro-server/functions/invite-to-organization/src/helpers/piiRedaction.js`-ben.
 * Két helyen kell szinkronban tartani amíg a build-generator pattern nem
 * teljes (Phase 2). Lásd `permissions.js` ekvivalens DRIFT-WARNING.
 */

// ────────────────────────────────────────────────────────────────────────────
// Konstansok
// ────────────────────────────────────────────────────────────────────────────

/**
 * Object-kulcs nevek, amelyek full-redact-et kapnak (case-insensitive substring
 * match). A redactValue() ezeket teljes "***REDACTED***" string-re cseréli,
 * az érték típusától és tartalmától függetlenül.
 *
 * Codex pre-review tanács: erősebb key-policy mint a value-detection
 * (false-negative-csökkentés — egy kulcs neve egyértelmű intent-jel).
 */
const FULL_REDACT_KEY_PATTERNS = [
    'password', 'secret', 'apikey', 'api_key', 'api-key',
    'authorization', 'cookie', 'set-cookie',
    'x-appwrite-key', 'x-appwrite-session',
    'refresh'
];

/**
 * Kulcs nevek, amelyek "tokenazonosítás" módot kapnak — az érték utolsó 4
 * char-ja látható, a többi `***`. Incident-triage-hez kell (a 7474619 init-
 * commit-incidensben az utolsó 4 char jelölte a leaked API key-t).
 */
const TOKEN_LAST4_KEY_PATTERNS = [
    'token', 'jwt', 'sessionid', 'session_id', 'invitetoken'
];

/**
 * Email regex (RFC 5321-szerű, egyszerűsített). A redactString() használja
 * a string-belső email-pattern-detect-hez.
 */
const EMAIL_REGEX = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/**
 * JWT regex (3 base64-blokk pont-szeparátorral, `eyJ` prefix).
 */
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/**
 * Bearer auth-header regex.
 */
const BEARER_REGEX = /Bearer\s+([A-Za-z0-9._\-+/=]+)/g;

/**
 * Hosszú hex/base64 random-token (Appwrite session-prefix, custom token-ök).
 * Konzervatív: 32+ karakter long random.
 */
const LONG_TOKEN_REGEX = /\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9_-]{40,}\b/g;

const FULL_REDACT_PLACEHOLDER = '***REDACTED***';
const MAX_DEPTH = 3;
const MAX_KEYS_PER_OBJECT = 100;

// ────────────────────────────────────────────────────────────────────────────
// String-szintű redact-helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Email-maszkolás: `first_letter + *** + @domain`. Pl. `john@example.com`
 * → `j***@example.com`. NEM RFC 5321 minden edge-case-re (quoted local-part
 * stb.), de production log-okhoz elég.
 */
function redactEmail(str) {
    if (typeof str !== 'string') return str;
    return str.replace(EMAIL_REGEX, '$1***$2');
}

/**
 * Token-elhúzás: az utolsó 4 char látható, a többi `***`. Pl.
 * `abc123def456ghi789xyz8d5f` → `...8d5f`. Incident-triage minimum
 * (7474619 precedens).
 */
function redactTokenLast4(str) {
    if (typeof str !== 'string' || str.length < 8) return FULL_REDACT_PLACEHOLDER;
    return `...${str.slice(-4)}`;
}

/**
 * Smart string-redact: a redactValue() string-ágon hívja. Email + JWT +
 * Bearer + long-hex/base64 pattern-eket detect-eli és cseréli a string-en
 * belül.
 */
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
    // Appwrite SDK / fetch-error pattern: `err.response` (data, status, headers)
    // tartalmaz nem-PII diagnosztikai metaadatot, de PII-pattern is lehet
    // benne (`response.data.email`, `response.headers['set-cookie']`). A
    // generic Error special-case ezt nélkül kihagyná — Codex stop-time M1 fix.
    if (err.response !== undefined) {
        out.response = redactValue(err.response, depth + 1, seen);
    }
    return out;
}

/**
 * Rekurzív value-redact. Stringekre redactString-et hív, object-ekre
 * mélységre megy max 3-ig, kulcsnévre policy-t alkalmaz (full-redact /
 * last-4 / smart-detect). Cycle-detection WeakSet-tel.
 */
function redactValue(value, depth = 0, seen) {
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

    // Error special-case (Codex hidden risk #2): Error.message / .stack /
    // .cause NEM enumerable, sima object-iteration átugorná.
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

/**
 * Logger argumentum-lista redact-pass. Egy `log('[Foo]', { email })` hívás
 * args-ja `['[Foo]', { email }]` — minden elemet rekurzívan átfut.
 *
 * KRITIKUS használat (Codex hidden risk #1): `log(...redactArgs(args))`,
 * NEM `log(redactArgs(args))` — a return egy array, és spread-elve kell
 * visszaadni a console.* / runtime log() függvénynek.
 */
function redactArgs(args) {
    if (!Array.isArray(args)) return args;
    return args.map(a => redactValue(a, 0, new WeakSet()));
}

/**
 * Dev opt-out flag a redaction kikapcsolásához (debug-flow). Csak
 * `NODE_ENV !== 'production'` mellett aktiv — produktív környezetben
 * silently no-op (a production-leak risk ellen).
 */
function isRedactionDisabled() {
    if (typeof process === 'undefined' || !process.env) return false;
    if (process.env.NODE_ENV === 'production') return false;
    return process.env.LOG_REDACT_DISABLE === 'true';
}

/**
 * S.13.3 Phase 2.1 — centralized logger wrap helper. A CF main.js-ek
 * `module.exports = async ({ log: rawLog, error: rawError }) => {...}`
 * signature-en belül 5-soros per-CF wrap-pattern (Phase 2.0a/b/c) helyett
 * egyetlen helper-call:
 *
 *     const { log, error } = wrapLogger(rawLog, rawError);
 *
 * Production (`isRedactionDisabled() === false` — default): a redactArgs
 * spread-pattern wrap-eli mindkét függvényt. Dev opt-out flag esetén
 * a raw referenciákat adja vissza (perf-friendly no-op).
 */
function wrapLogger(rawLog, rawError) {
    if (isRedactionDisabled()) {
        return { log: rawLog, error: rawError };
    }
    return {
        log: (...args) => rawLog(...redactArgs(args)),
        error: (...args) => rawError(...redactArgs(args))
    };
}

module.exports = {
    redactEmail,
    redactTokenLast4,
    redactString,
    redactValue,
    redactArgs,
    isRedactionDisabled,
    wrapLogger
};
