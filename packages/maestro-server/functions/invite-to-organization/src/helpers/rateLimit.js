// ADR 0010 — IP/subject-rate-limit middleware az `accept_invite` és S.2.2/S.2.3/S.2.6
// rate-limit endpoint-okon.
//
// S.2.1 (2026-05-11): `acceptInvite` IP-rate-limit verifikálva.
// S.2.2/S.2.3/S.2.6 (2026-05-11) refactor: per-endpoint config map + subject
// paraméter + dry-run/consume separáció + weighted increment.
//
// ─── API ─────────────────────────────────────────────────────────────────
//
// 1) `evaluateRateLimit(ctx, endpoint, options)` — read-only counter-szintű,
//    de a would-exceed ágon PERZISZTENS block-doc-ot ír (Codex stop-time
//    MAJOR 1 fix). Returns: `{ blocked: boolean, retryAfter: ISOString|null }`.
//    NEM ír counter-doc-ot (nincs `appendCounter`).
//    Multi-scope flow: minden scope-ra evaluate, és csak akkor consume-olunk
//    ha mind clean (Codex pre-review M1 — lockout-amplifikáció elkerülése).
//
// 2) `consumeRateLimit(ctx, endpoint, options)` — counter +weight (`appendCounter`),
//    ha race miatt overflow → block-doc létrejön. Returns: ISO timestamp ha
//    újonnan blocked, else null.
//
// 3) `checkRateLimit(ctx, endpoint, options)` — backward-compat shim a
//    `acceptInvite`-hez. evaluate + consume atomic egy hívásban.
//
// ─── `subject` parameter (S.2.2+) ────────────────────────────────────────
//
// `options.subject` overrideolja az XFF-IP-t. A schema column neve `ip`, de
// funkcionálisan "subject identifier"-ként működik: IP, userId, vagy orgId.
// Az `endpoint` differenciálja a namespace-t — MINDEN query MINDIG endpoint-tel
// szűr (Codex M4: never query subject-only).
//
// Ha `options.subject === undefined` ÉS nincs XFF → null subject → best-effort
// skip (nem rate-limit). Ez `accept_invite` legacy viselkedés.
//
// ─── Endpoint config ─────────────────────────────────────────────────────
//
// `RATE_LIMIT_CONFIG` — Object.freeze, per-endpoint `{ windowMs, max, blockMs }`.
// Új endpoint hozzáadása: bővítsd a map-et, az endpoint string a `endpoint`
// schema column-ba megy (max 32 char).
//
// `invite_send_org_day` blockMs=1h (Codex M3 soft-throttle) — a 24h window
// fennmarad, de a block 1h-onként lejár, így legitim onboarding eseten a
// counter csökkenése után a flow visszaáll önmagától.
//
// `delete_my_account` attempt-throttle (5min/3/5min block — Codex stop-time
// MAJOR 3 fix). Partial cleanup utáni self-heal retry megengedhető.
//
// ─── Új collection-ök sémája (változatlan S.2.1 óta) ────────────────────
//
// ipRateLimitCounters (append-only):
//   - $id                        `sdk.ID.unique()` — random per-attempt doc
//   - ip (string, 64)            indexed — funkcionálisan "subject" (IP / userId / orgId)
//   - endpoint (string, 32)      indexed — pl. 'accept_invite', 'invite_send_ip'
//   - windowStart (datetime)     indexed — az endpoint windowMs-éhez kerekített
//   - count (integer, min 0)     súlyozott increment (1 vagy weight, pl. batch email-count)
//
// ipRateLimitBlocks (idempotent upsert):
//   - $id                        determinisztikus: `rlb_${sha256(subject + '\0' + endpoint).slice(0, 32)}`
//                                — Appwrite-safe `[A-Za-z0-9._-]{1,36}`, NUL-separator collision-mentes
//   - ip (string, 64)            indexed
//   - endpoint (string, 32)      indexed
//   - blockedAt (datetime)
//   - blockedUntil (datetime)    indexed — ezután lejár a block
//
// ─── Cleanup stratégia (S.2.5 deferred) ──────────────────────────────────
//
// A counter- és block-doc-okat egy cron CF takarítja (TBD `cleanup-rate-limits`,
// S.2.5). 24h-nál régebbi counter-okat és lejárt blockedUntil-os block-okat
// töröl.

const crypto = require('crypto');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Endpoint config map. Frozen — runtime mutation tiltva (Codex NIT).
const RATE_LIMIT_CONFIG = Object.freeze({
    'accept_invite':       { windowMs: 15 * MIN, max: 5,   blockMs: 1 * HOUR },
    'invite_send_ip':      { windowMs: 15 * MIN, max: 30,  blockMs: 1 * HOUR },
    'invite_send_user':    { windowMs: 1 * DAY,  max: 50,  blockMs: 1 * HOUR },
    'invite_send_org_day': { windowMs: 1 * DAY,  max: 200, blockMs: 1 * HOUR },
    // Codex stop-time MAJOR 3 fix: a `delete_my_account` cooldown attempt-throttle,
    // NEM 24h hard cooldown. A self-heal retry (partial cleanup után) megengedhető:
    // 5 perc / 3 attempt / 5 perc block ad enough idő egy kézi retry-ra, de spam-et
    // (paralel/loop) megakadályoz.
    'delete_my_account':   { windowMs: 5 * MIN,  max: 3,   blockMs: 5 * MIN  },
});

/**
 * Az X-Forwarded-For header első IP-jét adja vissza. Ha nincs → null
 * (best-effort skip). User/org-scope rate-limit-ek `options.subject`-tel
 * mennek, NEM XFF-függőek.
 */
function extractClientIp(req) {
    const headers = req?.headers || {};
    const xff = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
    if (!xff || typeof xff !== 'string') return null;
    const ips = xff.split(',').map(s => s.trim()).filter(Boolean);
    return ips[0] || null;
}

/**
 * Window-méretre kerekített ISO timestamp (UTC). Pl. 15min window 13:42 → 13:30.
 * 24h window 13:42 → 00:00 (mai nap).
 */
function alignedWindowStart(windowMs) {
    const now = Date.now();
    const aligned = Math.floor(now / windowMs) * windowMs;
    return new Date(aligned).toISOString();
}

/**
 * Logoláshoz használt rövid hash a subject-ből (Codex MINOR — S.13.2 future-proof).
 * Nem kriptografikus garancia, csak a `log()`-ban ne lebegjen tisztán a userId/IP.
 */
function hashSubject(subject) {
    if (!subject || typeof subject !== 'string') return 'unknown';
    return crypto.createHash('sha256').update(subject).digest('hex').slice(0, 12);
}

function getConfig(endpoint) {
    const cfg = RATE_LIMIT_CONFIG[endpoint];
    if (!cfg) {
        // Server-side bug, NEM user-facing policy (Codex NIT 2). A CF dispatcher
        // 500-zal megdől — drift a config és a hívó között.
        throw new Error(`[RateLimit] Unknown endpoint: ${endpoint}`);
    }
    return cfg;
}

/**
 * Ellenőrzi, hogy a subject éppen blocked-e az adott endpoint-on. NEM ír.
 *
 * @returns {Promise<string|null>} blockedUntil ISO timestamp ha blocked, null ha nem
 */
async function isSubjectBlocked(ctx, subject, endpoint) {
    const { databases, env, sdk } = ctx;
    try {
        const result = await databases.listDocuments(
            env.databaseId,
            env.ipRateLimitBlocksCollectionId,
            [
                sdk.Query.equal('ip', subject),
                sdk.Query.equal('endpoint', endpoint),
                sdk.Query.greaterThan('blockedUntil', new Date().toISOString()),
                sdk.Query.limit(1)
            ]
        );
        if (result.documents.length === 0) return null;
        return result.documents[0].blockedUntil;
    } catch (err) {
        ctx.log(`[RateLimit] isSubjectBlocked error (non-blocking): ${err.message}`);
        return null;
    }
}

/**
 * Az adott (subject, endpoint, windowStart) triplethez tartozó counter-érték
 * lekérdezése. A counter doc-okat `consumeCounter` írja, `count` field a súly.
 *
 * Lapozott olvasás (limit=100): 24h window × max 200 → max ~200 doc/scope.
 *
 * @returns {Promise<number>} az aktuális counter érték (best-effort, hiba esetén 0)
 */
async function readCounter(ctx, subject, endpoint, windowStart) {
    const { databases, env, sdk, log } = ctx;
    const COUNTER_PAGE_LIMIT = 100;
    let total = 0;
    let cursor;
    try {
        while (true) {
            const queries = [
                sdk.Query.equal('ip', subject),
                sdk.Query.equal('endpoint', endpoint),
                sdk.Query.equal('windowStart', windowStart),
                sdk.Query.limit(COUNTER_PAGE_LIMIT)
            ];
            if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
            const result = await databases.listDocuments(
                env.databaseId,
                env.ipRateLimitCountersCollectionId,
                queries
            );
            for (const doc of result.documents) {
                total += (typeof doc.count === 'number' && doc.count > 0) ? doc.count : 1;
            }
            if (result.documents.length < COUNTER_PAGE_LIMIT) break;
            cursor = result.documents[result.documents.length - 1].$id;
        }
        return total;
    } catch (err) {
        log(`[RateLimit] readCounter error: ${err.message}`);
        return 0;
    }
}

/**
 * Counter-doc append a `weight` értékkel. Race-mentes: minden hívás új doc-ot
 * ír. A `weight` mezővel összegezhető batch invite-eknél (Resend cost-cap).
 */
async function appendCounter(ctx, subject, endpoint, windowStart, weight) {
    const { databases, env, sdk, log } = ctx;
    try {
        await databases.createDocument(
            env.databaseId,
            env.ipRateLimitCountersCollectionId,
            sdk.ID.unique(),
            { ip: subject, endpoint, windowStart, count: weight }
        );
    } catch (err) {
        log(`[RateLimit] appendCounter error: ${err.message}`);
    }
}

/**
 * Block-doc létrehozás vagy hosszabbítás. `blockedUntil = now + blockMs`.
 * Composite docId: `${subject}::${endpoint}` (egy subject/endpoint párhoz
 * egy block doc).
 */
/**
 * Determinisztikus Appwrite-safe block docId.
 *
 * Appwrite custom ID: `[A-Za-z0-9._-]{1,36}`. A `${subject}::${endpoint}` mintát
 * NEM lehet (`:` tiltott, plusz subject+endpoint > 36 char könnyen). Helyette:
 * `rlb_${sha256(subject + '\0' + endpoint).slice(0, 32)}` — `rlb_` (4) + hex (32) = 36.
 *
 * A NUL separator garantálja, hogy `(subject='a', endpoint='bc')` és
 * `(subject='ab', endpoint='c')` NEM ütközik. Determinisztikus → upsert pattern
 * (createDocument + updateDocument fallback) ugyanazon docId-re.
 */
function blockDocId(subject, endpoint) {
    const hash = crypto.createHash('sha256').update(`${subject}\0${endpoint}`).digest('hex').slice(0, 32);
    return `rlb_${hash}`;
}

/**
 * Block-doc létrehozás vagy hosszabbítás. Idempotens — race-safe (két paralel
 * `createBlock` ugyanarra a subject/endpoint párra: első CREATE win, második
 * `document_already_exists` → `updateDocument` fallback).
 *
 * @returns {Promise<string|null>} `blockedUntil` ISO ha persisted, `null` ha minden
 *   írás bukott (a hívó tudja, hogy NEM perzisztens a block).
 */
async function createBlock(ctx, subject, endpoint, blockMs) {
    const { databases, env, log, error } = ctx;
    const blockedAt = new Date().toISOString();
    const blockedUntil = new Date(Date.now() + blockMs).toISOString();
    const docId = blockDocId(subject, endpoint);

    try {
        await databases.createDocument(
            env.databaseId,
            env.ipRateLimitBlocksCollectionId,
            docId,
            { ip: subject, endpoint, blockedAt, blockedUntil }
        );
        log(`[RateLimit] subject=${hashSubject(subject)} blokkolva ${Math.round(blockMs / MIN)} percre (${endpoint})`);
        return blockedUntil;
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique|duplicate/i.test(err?.message || '')) {
            try {
                await databases.updateDocument(
                    env.databaseId,
                    env.ipRateLimitBlocksCollectionId,
                    docId,
                    { blockedAt, blockedUntil }
                );
                log(`[RateLimit] subject=${hashSubject(subject)} block hosszabbítva (${endpoint})`);
                return blockedUntil;
            } catch (innerErr) {
                error?.(`[RateLimit] block update fallback failed: ${innerErr.message}`);
                return null;
            }
        }
        error?.(`[RateLimit] block create failed (non-persistent): ${err.message}`);
        return null;
    }
}

/**
 * Subject resolution: explicit `options.subject` → XFF-IP fallback (legacy).
 * Ha mindkettő hiányzik → null (best-effort skip).
 */
function resolveSubject(ctx, options) {
    if (typeof options.subject === 'string' && options.subject) {
        return options.subject;
    }
    return extractClientIp(ctx.req);
}

/**
 * Counter-szintű evaluation: blocked vagy fognak-e blokkolódni `weight` increment után?
 * Multi-scope flow első lépése.
 *
 * **NEM ír** counter-doc-ot (nincs `appendCounter`), DE a would-exceed ágon
 * PERZISZTENS block-doc-ot ír (Codex stop-time MAJOR 1 fix — különben a normál
 * szekvenciális overflow soha nem hozna létre block-doc-ot). Idempotens block
 * (composite docId, updateDocument fallback) — race-safe két paralel hívóra.
 *
 * @param {object} ctx CF context
 * @param {string} endpoint RATE_LIMIT_CONFIG key
 * @param {object} [options] { subject?: string, weight?: number }
 * @returns {Promise<{ blocked: boolean, retryAfter: string|null }>}
 */
async function evaluateRateLimit(ctx, endpoint, options = {}) {
    const config = getConfig(endpoint);
    const subject = resolveSubject(ctx, options);
    const weight = Math.max(1, options.weight || 1);

    if (!subject) {
        // Best-effort: XFF nélkül (és explicit subject nélkül) átengedjük.
        return { blocked: false, retryAfter: null };
    }

    // 1) Active block?
    const blockedUntil = await isSubjectBlocked(ctx, subject, endpoint);
    if (blockedUntil) {
        return { blocked: true, retryAfter: blockedUntil };
    }

    // 2) Would-exceed check — a consume utáni állapot átlépné a max-ot. Codex
    //    stop-time MAJOR 1: a dry-run blokkol, a hívó 429-cel kilép, a consume
    //    NEM fut, ezért a block-doc soha NEM persistálódik normál crossing-on.
    //    Fix: a would-exceed ágon ITT (a dry-run-ban) MEGEMELJÜK a blockot
    //    perzisztensen, így a következő attempt is `isSubjectBlocked` → blocked
    //    ágra esik. Multi-scope flow konzisztens: az első would-exceed scope-on
    //    blockoljuk, a többi scope-on NINCS consume (lockout-amplifikáció kerül).
    //
    //    Race: két paralel hívó dry-run-on egyszerre would-exceed → mindkettő
    //    createBlock hívás → idempotens (composite docId, updateDocument fallback).
    const windowStart = alignedWindowStart(config.windowMs);
    const current = await readCounter(ctx, subject, endpoint, windowStart);
    if (current + weight > config.max) {
        const persistedUntil = await createBlock(ctx, subject, endpoint, config.blockMs);
        // Ha createBlock NEM perzisztens (write-bukott), a futás vissza-pontján
        // adunk egy fallback ISO timestamp-et — a hívó akkor is megkapja a 429-et,
        // és a következő attempt re-evaluálja a counter-overflow-t.
        const retryAfter = persistedUntil || new Date(Date.now() + config.blockMs).toISOString();
        return { blocked: true, retryAfter };
    }

    return { blocked: false, retryAfter: null };
}

/**
 * CONSUME: counter +weight, és ha az új érték >max → block-doc létrejön.
 * NEM ellenőrzi a meglévő block-ot — a hívó dryRun-on már átment.
 *
 * @returns {Promise<string|null>} blockedUntil ISO ha újonnan blocked, else null
 */
async function consumeRateLimit(ctx, endpoint, options = {}) {
    const config = getConfig(endpoint);
    const subject = resolveSubject(ctx, options);
    const weight = Math.max(1, options.weight || 1);

    if (!subject) return null;

    const windowStart = alignedWindowStart(config.windowMs);
    await appendCounter(ctx, subject, endpoint, windowStart, weight);

    const newTotal = await readCounter(ctx, subject, endpoint, windowStart);
    if (newTotal > config.max) {
        return await createBlock(ctx, subject, endpoint, config.blockMs);
    }
    return null;
}

/**
 * Backward-compat shim: dryRun + consume egyetlen hívásban.
 *
 * Használat (legacy, S.2.1):
 *   const limited = await checkRateLimit(ctx, 'accept_invite');
 *   if (limited) return fail(res, 429, 'rate_limited', { retryAfter: limited });
 *
 * Új multi-scope flow esetén HASZNÁLD a `evaluateRateLimit` + `consumeRateLimit`
 * párost (lockout-amplifikáció elkerülése — Codex M1).
 *
 * @returns {Promise<string|null>} blockedUntil ISO ha rate-limited, null ha OK
 */
async function checkRateLimit(ctx, endpoint, options = {}) {
    const evaluation = await evaluateRateLimit(ctx, endpoint, options);
    if (evaluation.blocked) return evaluation.retryAfter;
    return await consumeRateLimit(ctx, endpoint, options);
}

module.exports = {
    checkRateLimit,
    evaluateRateLimit,
    consumeRateLimit,
    extractClientIp,
    hashSubject,
    RATE_LIMIT_CONFIG
};
