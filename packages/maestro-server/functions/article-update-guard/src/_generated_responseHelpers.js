/**
 * AUTO-GENERATED FILE — DO NOT EDIT.
 * Source: packages/maestro-shared/responseHelpers.js
 * Regenerate: yarn build:cf-response-helpers
 *
 * A kanonikus ESM forrás CommonJS pillanatképe. CF deploy-időben a
 * workspace yarn link NEM oldódik fel, ezért minden CF saját másolatot
 * tart. Generálás: scripts/build-cf-response-helpers.mjs (S.13.3 Phase 2.1).
 */
/**
 * Maestro Shared — CF response info-disclosure védelem helper (S.13.3 Phase 2).
 *
 * A `fail(res, statusCode, reason, extra)` és kapcsolódó utility-k centralized
 * minta — minden CF response-bódyból eltávolítja a raw `err.message` /
 * `err.stack` / `err.cause` mezőket. ASVS V7 + V13.
 *
 * **PHASE 2 (jelenlegi)**: kanonikus ESM modul, CF-eknek CommonJS inline-port
 * (`_generated_responseHelpers.js` minden CF-ben). Phase 2.0a: 1 demo CF
 * (`update-article`). Phase 2.0b-c + 2.1: maradék CF-ek (validate-publication-
 * update, user-cascade-delete, set-publication-root-path, resend-webhook,
 * orphan-sweeper, cleanup-*, migrate-legacy-paths, cascade-delete,
 * validate-article-creation).
 *
 * Plus a `invite-to-organization`-ban már Phase 1.0+1.5 inline minta él
 * (helpers/util.js fail() + recordError helper-szintű strip) — későbbi
 * refactor-ral cserélhető shared importtal (de NEM most, túl nagy scope).
 *
 * Build-generator (S.7.7b precedens) Phase 2.1-ben tervezett — automatikusan
 * generálja a CF-eknek CommonJS-portolt másolatot + drift-guard.
 */

const { redactValue } = require('./_generated_piiRedaction.js');
// ESM-only kanonikus modul. A `redactValue` ESM-import a `piiRedaction.js`-ből.
// A CF-eknek CommonJS inline-portolt másolat kell (helpers/responseHelpers.js
// minden CF-en belül, require('./piiRedaction.js')-szel a CF-szintű
// piiRedaction.js port-ot hívja).
//
// **DRIFT KOCKÁZAT**: a CF CommonJS inline-portolt `helpers/responseHelpers.js`
// és `helpers/piiRedaction.js` másolatban a `require` natívan működik.
// Két helyen kell szinkronban tartani amíg a build-generator pattern nem
// teljes (Phase 2.1-be tervezve).

const SENSITIVE_RESPONSE_FIELDS = new Set(['error', 'message', 'details', 'stack', 'cause']);

/**
 * Cycle-safe deep-strip: top + nested `error`/`message`/`details`/`stack`/`cause`
 * kulcs törlése (array + object minden mélységben). A `redactValue` cycle-safe
 * (WeakSet) UTÁNA fut, de a `stripSensitive` SELF infinite loop-ot okozhatott
 * volna ciklikus `extra`-n (Codex S.13.3 adversarial A4 fix).
 */
function stripSensitive(value, seen) {
    if (Array.isArray(value)) {
        if (!seen) seen = new WeakSet();
        if (seen.has(value)) return '[circular]';
        seen.add(value);
        return value.map(v => stripSensitive(v, seen));
    }
    if (value !== null && typeof value === 'object') {
        if (!seen) seen = new WeakSet();
        if (seen.has(value)) return '[circular]';
        seen.add(value);
        const out = {};
        for (const key of Object.keys(value)) {
            if (SENSITIVE_RESPONSE_FIELDS.has(key)) continue;
            out[key] = stripSensitive(value[key], seen);
        }
        return out;
    }
    return value;
}

// Reason whitelist regex — alfanumerikus + underscore (camelCase OK).
// Codex S.13.3 adversarial A5 fix: dynamic reason bypass elleni védelem.
const REASON_REGEX = /^[A-Za-z0-9_]+$/;

function normalizeReason(reason) {
    if (typeof reason === 'string' && REASON_REGEX.test(reason)) return reason;
    return 'invalid_error_code';
}

/**
 * JSON válasz hibakóddal — reason normalize + sensitive-field strip + PII deep-redact.
 *
 * 1. `normalizeReason(reason)` — whitelist regex, különben `'invalid_error_code'`.
 * 2. `stripSensitive(extra)` — minden nested sensitive kulcs törlése (cycle-safe).
 * 3. `redactValue(...)` — a többi mezőből email/JWT/Bearer/long-token deep-redact.
 *
 * **Spread-order fix** (Codex verifying #2 B5.1): a `reason: safeReason`
 * a `...redacted` spread UTÁN, hogy az `extra.reason` (ha valaha is accidentally
 * átadva) NE tudja overwrite-olni a normalized reason-t.
 */
function fail(res, statusCode, reason, extra = {}) {
    const safeReason = normalizeReason(reason);
    const cleaned = stripSensitive(extra);
    const redacted = redactValue(cleaned, 0);
    return res.json({ success: false, ...redacted, reason: safeReason }, statusCode);
}

/**
 * `success: true` response body sensitive-field strip. NEM globális
 * blacklist (Codex adversarial A2/A6 figyelmeztetés: `customMessage`
 * user-intent legitim üzleti adat lehet) — csak az ismert sensitive
 * top + nested kulcsokat strip-eli (`error`/`message`/`details`/`stack`/`cause`).
 */
function okJson(res, body) {
    const cleaned = stripSensitive(body);
    const redacted = redactValue(cleaned, 0);
    return res.json(redacted, 200);
}

/**
 * Factory: létrehozza a per-action `recordError(entry)` helper-t a stats
 * objektum + maxErrors körül. A bizonyított minta a `invite-to-organization`
 * `schemas.js` 3 definíciójából (Phase 1.5). Belőle destructure-pattern
 * strip-eli a sensitive top-level mezőket.
 */
function createRecordError(stats, maxErrors) {
    if (!stats.errors) stats.errors = [];
    if (typeof stats.errorCount !== 'number') stats.errorCount = 0;

    return function recordError(entry) {
        stats.errorCount++;
        if (stats.errors.length < maxErrors) {
            const { message, error, details, stack, cause, ...safeEntry } = entry || {};
            stats.errors.push(safeEntry);
        } else {
            stats.errorsTruncated = true;
        }
    };
}

module.exports = {
    fail,
    okJson,
    createRecordError,
    stripSensitive,
    normalizeReason
};
