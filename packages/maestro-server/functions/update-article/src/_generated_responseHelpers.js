/**
 * AUTO-GENERATED CommonJS port a kanonikus `maestro-shared/responseHelpers.js`-ből
 * (S.13.3 Phase 2 wrap az update-article CF-en).
 *
 * **DRIFT KOCKÁZAT**: ez a fájl LOGIKAILAG ekvivalens, CommonJS-portolt
 * másolat. Phase 2.1: build-generator (S.7.7b precedens) automatikusan
 * generálja és drift-guard-dal ellenőrzi.
 *
 * A kanonikus modul docblock-ja a teljes spec-et adja
 * (`packages/maestro-shared/responseHelpers.js`).
 */

const { redactValue } = require('./_generated_piiRedaction.js');

const SENSITIVE_RESPONSE_FIELDS = new Set(['error', 'message', 'details', 'stack', 'cause']);

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

const REASON_REGEX = /^[A-Za-z0-9_]+$/;

function normalizeReason(reason) {
    if (typeof reason === 'string' && REASON_REGEX.test(reason)) return reason;
    return 'invalid_error_code';
}

function fail(res, statusCode, reason, extra = {}) {
    const safeReason = normalizeReason(reason);
    const cleaned = stripSensitive(extra);
    const redacted = redactValue(cleaned, 0);
    return res.json({ success: false, ...redacted, reason: safeReason }, statusCode);
}

function okJson(res, body) {
    const cleaned = stripSensitive(body);
    const redacted = redactValue(cleaned, 0);
    return res.json(redacted, 200);
}

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
