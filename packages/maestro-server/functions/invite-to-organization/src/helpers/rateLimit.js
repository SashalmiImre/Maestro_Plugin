// ADR 0010 — IP-rate-limit middleware az `accept_invite` endpoint-on.
//
// Cél: token-szivárgás esetén DoS-szerű támadások kivédése.
// — 5 próbálkozás per IP / 15 perc, utána 1 órás IP-block.
//
// NEM "X rontás után elveszik a meghívó" elvű — az DoS-vektort nyitna a
// meghívottra (tetszőleges támadó kiéghette volna a meghívását).
//
// SKELETON — a helper logikája kész, de a middleware-be még be kell
// kötni az `actions/invites.js` `acceptInvite`-ot. Az új collection-ök
// (`ipRateLimitCounters`, `ipRateLimitBlocks`) Appwrite Cloud-on
// manuálisan felveendők (séma a kommentben).
//
// ─── Új collection-ök sémája ───────────────────────────────────────────
//
// ipRateLimitCounters:
//   - $id (custom)               composite kulcs: `${ip}::${endpoint}::${windowStart}`
//   - ip (string, 64)            indexed
//   - endpoint (string, 32)      indexed — pl. 'accept_invite'
//   - windowStart (datetime)     indexed — a 15 perces ablak kezdete (UTC, kerekített)
//   - count (integer, min 0)     hány próbálkozás ebben az ablakban
//
// ipRateLimitBlocks:
//   - $id (custom)               composite kulcs: `${ip}::${endpoint}`
//   - ip (string, 64)            indexed
//   - endpoint (string, 32)      indexed
//   - blockedAt (datetime)
//   - blockedUntil (datetime)    indexed — ezután lejár az IP-block
//
// ─── Cleanup stratégia ─────────────────────────────────────────────────
//
// A counter-doc-okat egy cron CF takarítja (vagy a `cleanup-orphaned-locks`
// mintáját követve egy új `cleanup-rate-limit-data` function). 24 óránál
// régebbi `windowStart`-os counter-okat és lejárt `blockedUntil`-os blokk-
// okat törli.

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;          // 15 perc
const RATE_LIMIT_MAX_ATTEMPTS = 5;                    // 6. próbálkozásnál blokkol
const BLOCK_DURATION_MS = 60 * 60 * 1000;             // 1 óra block

/**
 * Az X-Forwarded-For header első IP-jét adja vissza (a többszörös
 * proxy-rétegen keresztül a leghitelesebb a kliens IP-je).
 *
 * Ha nincs X-Forwarded-For (közvetlen Appwrite hívás localhost-ról vagy
 * fejlesztői környezetből), `null`-t ad — ilyenkor a rate-limit nem
 * alkalmazható és a request átengedett (best-effort).
 */
function extractClientIp(req) {
    const headers = req?.headers || {};
    const xff = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
    if (!xff || typeof xff !== 'string') return null;
    const ips = xff.split(',').map(s => s.trim()).filter(Boolean);
    return ips[0] || null;
}

/**
 * 15 perces ablakra kerekített ISO timestamp (UTC).
 * Pl. 13:42 → 13:30, 13:50 → 13:45, 14:00 → 14:00.
 */
function currentWindowStart() {
    const now = Date.now();
    const aligned = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
    return new Date(aligned).toISOString();
}

/**
 * Ellenőrzi, hogy az IP éppen blokkolt-e.
 * @returns {Promise<string|null>} blockedUntil ISO timestamp ha blokkolt, null ha nem
 */
async function isIpBlocked(ctx, ip, endpoint) {
    const { databases, env, sdk } = ctx;
    try {
        const result = await databases.listDocuments(
            env.databaseId,
            env.ipRateLimitBlocksCollectionId,
            [
                sdk.Query.equal('ip', ip),
                sdk.Query.equal('endpoint', endpoint),
                sdk.Query.greaterThan('blockedUntil', new Date().toISOString()),
                sdk.Query.limit(1)
            ]
        );
        if (result.documents.length === 0) return null;
        return result.documents[0].blockedUntil;
    } catch (err) {
        ctx.log(`[RateLimit] isIpBlocked error (non-blocking): ${err.message}`);
        return null;
    }
}

/**
 * Counter-doc upsert. Ha még nincs az adott IP+endpoint+window párra,
 * létrehozza count=1-gyel. Ha van, increment.
 *
 * Race condition védelem: a custom `$id` (`${ip}::${endpoint}::${windowStart}`)
 * unique, két párhuzamos request közül az egyik kap `document_already_exists`
 * hibát → fallback get + update. Ez nem teljesen atomikus (két párhuzamos
 * update double-count-olhat), de a 5-ös limit + 1 órás block toleráns
 * a +/-1 hibára.
 *
 * @returns {Promise<number>} a counter értéke (0 ha hiba történt — best-effort)
 */
async function incrementCounter(ctx, ip, endpoint) {
    const { databases, env, sdk, log } = ctx;
    const windowStart = currentWindowStart();
    const docId = `${ip}::${endpoint}::${windowStart}`;

    try {
        const created = await databases.createDocument(
            env.databaseId,
            env.ipRateLimitCountersCollectionId,
            docId,
            { ip, endpoint, windowStart, count: 1 }
        );
        return created.count;
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique|duplicate/i.test(err?.message || '')) {
            try {
                const existing = await databases.getDocument(
                    env.databaseId,
                    env.ipRateLimitCountersCollectionId,
                    docId
                );
                const updated = await databases.updateDocument(
                    env.databaseId,
                    env.ipRateLimitCountersCollectionId,
                    docId,
                    { count: existing.count + 1 }
                );
                return updated.count;
            } catch (innerErr) {
                log(`[RateLimit] counter update fallback failed: ${innerErr.message}`);
                return 0;
            }
        }
        log(`[RateLimit] counter create error: ${err.message}`);
        return 0;
    }
}

/**
 * IP-block létrehozás vagy hosszabbítás.
 */
async function blockIp(ctx, ip, endpoint) {
    const { databases, env, log } = ctx;
    const blockedAt = new Date().toISOString();
    const blockedUntil = new Date(Date.now() + BLOCK_DURATION_MS).toISOString();
    const docId = `${ip}::${endpoint}`;

    try {
        await databases.createDocument(
            env.databaseId,
            env.ipRateLimitBlocksCollectionId,
            docId,
            { ip, endpoint, blockedAt, blockedUntil }
        );
        log(`[RateLimit] IP ${ip} blokkolva ${BLOCK_DURATION_MS / 60000} percre (${endpoint})`);
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique|duplicate/i.test(err?.message || '')) {
            try {
                await databases.updateDocument(
                    env.databaseId,
                    env.ipRateLimitBlocksCollectionId,
                    docId,
                    { blockedAt, blockedUntil }
                );
                log(`[RateLimit] IP ${ip} block hosszabbítva (${endpoint})`);
            } catch (innerErr) {
                log(`[RateLimit] block update fallback failed: ${innerErr.message}`);
            }
        } else {
            log(`[RateLimit] block create error (non-blocking): ${err.message}`);
        }
    }
}

/**
 * Rate-limit guard. Az `actions/invites.js` `acceptInvite` legelején meghívva:
 *
 *   const limited = await checkRateLimit(ctx, 'accept_invite');
 *   if (limited) {
 *       return fail(res, 429, 'rate_limited', { retryAfter: limited });
 *   }
 *
 * @returns {Promise<string|null>} blockedUntil ISO timestamp (ha rate-limited),
 *   vagy null (ha minden OK)
 */
async function checkRateLimit(ctx, endpoint) {
    const ip = extractClientIp(ctx.req);
    if (!ip) {
        ctx.log(`[RateLimit] no client IP for ${endpoint}, skipping (best-effort)`);
        return null;
    }

    // 1) Aktív IP-block check
    const blockedUntil = await isIpBlocked(ctx, ip, endpoint);
    if (blockedUntil) {
        ctx.log(`[RateLimit] IP ${ip} blocked until ${blockedUntil} (${endpoint})`);
        return blockedUntil;
    }

    // 2) Counter increment
    const count = await incrementCounter(ctx, ip, endpoint);

    // 3) Threshold check — a 6. próbálkozásnál (count > 5) blokkolunk
    if (count > RATE_LIMIT_MAX_ATTEMPTS) {
        await blockIp(ctx, ip, endpoint);
        return new Date(Date.now() + BLOCK_DURATION_MS).toISOString();
    }

    return null;
}

module.exports = {
    checkRateLimit,
    extractClientIp,
    currentWindowStart,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_ATTEMPTS,
    BLOCK_DURATION_MS
};
