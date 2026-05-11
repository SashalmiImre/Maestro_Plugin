const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const proxyAddr = require('proxy-addr');
const Groq = require('groq-sdk');

/**
 * Maestro CORS Proxy Server
 *
 * Provides a secure middle layer for UXP plugins to communicate with Appwrite Cloud,
 * handling authentication injection and CORS headers.
 *
 * Fő felelősségek:
 * - HTTP reverse proxy (API kérések → Appwrite Cloud)
 * - WebSocket proxy (Realtime események, auth injection a query param-okból)
 * - TCP Keep-Alive + WebSocket ping frame-ek az idle timeout ellen
 * - EPIPE/ECONNRESET zajszűrés
 * - Graceful shutdown (SIGTERM)
 */

const app = express();
const port = process.env.PORT || 3000;

// --- WebSocket Socket Tracking ---
const activeWsSockets = new Set();
const WS_PING_INTERVAL_MS = 15000; // 15 másodpercenként
const WS_PING_FRAME = Buffer.from([0x89, 0x00]); // WebSocket ping frame (FIN + opcode 9, no payload)

/** Zajszűrő: EPIPE/ECONNRESET nem valódi hibák, hanem normális socket lifecycle események */
const isSocketNoise = (error) =>
    error && (error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ECONNABORTED');

// Security: Hide Express signature
app.disable('x-powered-by');

// S.1.3 — `trust proxy` szükséges hogy az `express-rate-limit` a valódi kliens IP-t lássa
// (`req.ip`), különben minden klienst a Railway/Cloudflare edge IP-re vonna össze (self-DoS).
// Default: 1 hop (Railway). Override-olható `TRUST_PROXY` env var-ral.
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined ? Number(process.env.TRUST_PROXY) : 1;
app.set('trust proxy', TRUST_PROXY);

// --- S.1 Security helpers ---

/**
 * Engedett HTTP/HTTPS origin-ek (CORS allowlist).
 * UXP plugin a `null` origin-t küldi — külön middleware kezeli (lásd `nullOriginGuard`).
 */
const ALLOWED_ORIGINS = new Set([
    'https://maestro.emago.hu',  // Dashboard prod
    'http://localhost:5173'      // Dashboard dev (Vite)
]);

/** A `null` origin kizárólag ezeken a path-eken engedett (UXP Realtime WebSocket workaround). */
const NULL_ORIGIN_ALLOWED_PATHS = ['/v1/realtime', '/maestro-proxy/v1/realtime'];

/** `x-fallback-cookies` query-paramot kizárólag ezen path-eken fogadjuk el. */
const FALLBACK_COOKIES_ALLOWED_PATHS = ['/v1/realtime', '/maestro-proxy/v1/realtime'];

/** PII-szivárgás védelem: log előtt ezeket a query-paramokat maszkoljuk. */
const REDACT_QUERY_KEYS = new Set([
    'x-fallback-cookies', 'cookie', 'cookies', 'token', 'secret',
    'key', 'apikey', 'api_key', 'password', 'pwd', 'email',
    'jwt', 'session', 'sessionid', 'authorization', 'auth'
]);

/** Cookie kulcsnév whitelist a fallback-cookie payload-ban (Appwrite session minta). */
const FALLBACK_COOKIE_KEY_PATTERN = /^a_session(_[a-z0-9]+)?(_legacy)?$/i;

/** 4 KB cap a `x-fallback-cookies` query-param payload-ra. */
const FALLBACK_COOKIES_MAX_BYTES = 4 * 1024;

/** Cookie érték RFC 6265 cookie-octet: minden non-CTL ASCII printable kivéve space/`"`/`,`/`;`/`\\`. */
const COOKIE_VALUE_OCTET = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** Regex fallback a `REDACT_QUERY_KEYS` Set-ből generálva — mindig szinkronban. */
const REDACT_QUERY_REGEX = new RegExp(
    `([?&])(${[...REDACT_QUERY_KEYS].map(k => k.replace(/[-_]/g, '[-_]')).join('|')})=[^&]*`,
    'gi'
);

/** Path matching segment-boundary check (NEM `/v1/realtimeevil`). */
function pathMatchesAny(pathName, allowedPaths) {
    return allowedPaths.some(p => pathName === p || pathName.startsWith(p + '/'));
}

/** Maszkolja a PII-érzékeny query-paramokat a request URL-ben (logoláshoz). */
function redactUrl(rawUrl) {
    try {
        const url = new URL(rawUrl, 'http://local');
        if (!url.search) return rawUrl; // gyors út: nincs query
        let dirty = false;
        for (const key of url.searchParams.keys()) {
            if (REDACT_QUERY_KEYS.has(key.toLowerCase())) {
                url.searchParams.set(key, '[REDACTED]');
                dirty = true;
            }
        }
        return dirty ? url.pathname + url.search : rawUrl;
    } catch {
        // Rosszul formált URL — Set-ből generált regex fallback
        return rawUrl.replace(REDACT_QUERY_REGEX, '$1$2=[REDACTED]');
    }
}

// --- WS upgrade rate-limit (memory-store, multi-instance limitations dokumentálva) ---
const WS_UPGRADE_WINDOW_MS = 60 * 1000;  // 1 perc ablak
const WS_UPGRADE_MAX = 60;               // 60 upgrade / perc / IP
const wsUpgradeRateLimit = new Map();    // ip → {count, windowStart}

/** Egy IP-re per-perc 60 WS upgrade. True ha engedett, false ha limit elérve. */
function checkWsUpgradeRateLimit(ip) {
    const now = Date.now();
    const entry = wsUpgradeRateLimit.get(ip);
    if (!entry || now - entry.windowStart >= WS_UPGRADE_WINDOW_MS) {
        wsUpgradeRateLimit.set(ip, { count: 1, windowStart: now });
        return true;
    }
    if (entry.count >= WS_UPGRADE_MAX) return false;
    entry.count++;
    return true;
}

/** Periodikus takarítás: lejárt windows-okkal rendelkező IP-k törlése (memory leak ellen). */
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of wsUpgradeRateLimit.entries()) {
        if (now - entry.windowStart >= WS_UPGRADE_WINDOW_MS) {
            wsUpgradeRateLimit.delete(ip);
        }
    }
}, WS_UPGRADE_WINDOW_MS).unref();

// (S.1 Codex verifying review MAJOR fix)
// Express maga compile-olja a `trust proxy` setting-et (hop-count, string, function),
// majd `app.get('trust proxy fn')`-en keresztül elérhető a resolved function.
// Ez `(ip, distance) => boolean` formátumú, a `proxy-addr` lib által fogadott —
// így a `req.ip` resolution-ja és a WS upgrade IP-detection ugyanazon szemantikán
// fut (egyszerű XFF-first parsing spoofolható volt malicious kliens által).
const trustFn = app.get('trust proxy fn');

/** Kliens IP extrakció Express `trust proxy`-egyenértékű módon. */
function extractClientIp(req) {
    try {
        return proxyAddr(req, trustFn) || req.socket?.remoteAddress || 'unknown';
    } catch {
        return req.socket?.remoteAddress || 'unknown';
    }
}

/**
 * Validálja a `x-fallback-cookies` query-param tartalmát.
 * @returns {string|null} `Cookie` header érték vagy `null` ha érvénytelen.
 */
function validateAndBuildCookieHeader(rawValue) {
    if (typeof rawValue !== 'string' || rawValue.length === 0) return null;
    if (Buffer.byteLength(rawValue, 'utf8') > FALLBACK_COOKIES_MAX_BYTES) return null;
    let parsed;
    try { parsed = JSON.parse(rawValue); } catch { return null; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const pairs = [];
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof key !== 'string' || !FALLBACK_COOKIE_KEY_PATTERN.test(key)) return null;
        if (typeof value !== 'string') return null;
        // Cookie érték RFC 6265 cookie-octet (base64/base64url engedett, kivéve CTLs / whitespace / DQUOTE / `,` / `;` / `\`).
        if (!COOKIE_VALUE_OCTET.test(value)) return null;
        pairs.push(`${key}=${value}`);
    }
    return pairs.length > 0 ? pairs.join('; ') : null;
}

// (S.1 Codex MAJOR 2) — globális `express.urlencoded()` body parser eltávolítva.
// A `/reset-password` POST route 410 Gone-nel válaszol body-feldolgozás nélkül,
// más POST endpoint pedig route-szintű parserrel jön (`express.json({limit:...})`).
// A rate-limit middleware-eket NEM blokkolja parse-cost.

// --- S.1.1 CORS — default-deny allowlist ---
app.use(cors({
    origin(origin, cb) {
        // Same-origin / curl / health-check: nincs Origin header
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
        // UXP plugin `null` origin — külön middleware (nullOriginGuard) érvényesíti
        if (origin === 'null') return cb(null, true);
        return cb(new Error('CORS_ORIGIN_DENIED'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Appwrite-Project',
        'X-Appwrite-Key',
        'X-Appwrite-Response-Format',
        'X-Fallback-Cookies',
        'X-Maestro-Client'
    ]
}));

// CORS hiba-handler — 403 JSON válasz a default 500 helyett
app.use((err, req, res, next) => {
    if (err && err.message === 'CORS_ORIGIN_DENIED') {
        return res.status(403).json({ error: 'CORS origin not allowed', code: 'cors_origin_denied' });
    }
    return next(err);
});

// --- S.1.2 `null` origin secondary guard ---
// A UXP plugin sandbox `null` origin-t küld. Csak a Realtime WS upgrade path-en engedett,
// és csak `X-Maestro-Client: indesign-plugin` header mellett.
// Megjegyzés: ez best-effort kliens-azonosító — Codex review szerint nem-böngészős klienssel
// spoofolható. Phase 2: per-deployment shared-secret HMAC + timestamp (S.1 follow-up).
app.use((req, res, next) => {
    if (req.headers.origin !== 'null') return next();
    if (!pathMatchesAny(req.path, NULL_ORIGIN_ALLOWED_PATHS)) {
        return res.status(403).json({ error: 'null origin not permitted on this path', code: 'null_origin_path_denied' });
    }
    if (req.headers['x-maestro-client'] !== 'indesign-plugin') {
        return res.status(403).json({ error: 'null origin requires X-Maestro-Client header', code: 'null_origin_client_required' });
    }
    next();
});

// --- S.1.3 Rate-limit ---
// Memory-store (S.1 elfogadható egyetlen Railway instance-szal, dokumentált Redis upgrade path).
// Sorrend kritikus: auth path-ek a default `/v1/*` előtt mountolva.
function makeLimiter(windowMs, max, code = 'rate_limit_exceeded') {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests', code }
    });
}

app.use(['/v1/account/sessions/email', '/maestro-proxy/v1/account/sessions/email'],
    makeLimiter(15 * 60 * 1000, 5));                                  // 5 / 15 perc / IP
app.use(['/v1/account/sessions', '/maestro-proxy/v1/account/sessions'],
    makeLimiter(15 * 60 * 1000, 20));                                 // 20 / 15 perc / IP
app.use(['/v1/account/recovery', '/maestro-proxy/v1/account/recovery'],
    makeLimiter(60 * 60 * 1000, 5));                                  // 5 / óra / IP
app.use(['/v1/account/verification', '/maestro-proxy/v1/account/verification'],
    makeLimiter(60 * 60 * 1000, 10));                                 // 10 / óra / IP
app.use(['/v1/account', '/maestro-proxy/v1/account'],
    makeLimiter(60 * 60 * 1000, 20));                                 // 20 / óra / IP (általános account)
app.use(['/v1/realtime', '/maestro-proxy/v1/realtime'],
    makeLimiter(60 * 1000, 60));                                      // 60 upgrade / perc / IP
app.use(['/v1', '/maestro-proxy/v1'],
    makeLimiter(15 * 60 * 1000, 300));                                // 300 / 15 perc / IP (default)

// Health endpoint - handles both paths
app.get(['/v1/health', '/maestro-proxy/v1/health'], (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        message: 'Maestro CORS Proxy is running'
    });
});

// --- AI Klaszterezés Endpoint ---

/**
 * Szövegkeret-klaszterezés AI segítségével.
 *
 * A plugin elküldi a deduplikált story-kat (pozíció, betűméret, szövegrészlet),
 * az AI pedig logikai cikkekbe csoportosítja és típusosztályozza őket.
 *
 * Env var: GROQ_API_KEY (ha nincs beállítva, 501-et ad vissza → plugin fallback).
 */
app.post(
    ['/api/cluster-article', '/maestro-proxy/api/cluster-article'],
    express.json({ limit: '500kb' }),
    async (req, res) => {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            return res.status(501).json({ error: 'AI szolgáltatás nincs konfigurálva' });
        }

        const { stories } = req.body;
        if (!stories || !Array.isArray(stories) || stories.length === 0) {
            return res.status(400).json({ error: 'Hiányzó vagy érvénytelen stories adat' });
        }

        // Validate each story object structure
        for (let i = 0; i < stories.length; i++) {
            const s = stories[i];

            // Check if story is an object
            if (typeof s !== 'object' || s === null) {
                console.error(`[AI] Klaszterezés hiba: story[${i}] is not an object`);
                return res.status(400).json({ error: `Invalid story at index ${i}: not an object` });
            }

            // Check required string/number properties
            if (typeof s.storyId !== 'string' && typeof s.storyId !== 'number') {
                console.error(`[AI] Klaszterezés hiba: story[${i}].storyId is not string/number`);
                return res.status(400).json({ error: `Invalid story at index ${i}: storyId must be string or number` });
            }

            // If storyId is numeric, ensure it's finite
            if (typeof s.storyId === 'number' && !Number.isFinite(s.storyId)) {
                console.error(`[AI] Klaszterezés hiba: story[${i}].storyId is NaN or Infinity`);
                return res.status(400).json({ error: `Invalid story at index ${i}: storyId must be a finite number` });
            }

            if (typeof s.pageIdx !== 'number') {
                console.error(`[AI] Klaszterezés hiba: story[${i}].pageIdx is not a number`);
                return res.status(400).json({ error: `Invalid story at index ${i}: pageIdx must be a number` });
            }

            // Ensure pageIdx is finite
            if (!Number.isFinite(s.pageIdx)) {
                console.error(`[AI] Klaszterezés hiba: story[${i}].pageIdx is NaN or Infinity`);
                return res.status(400).json({ error: `Invalid story at index ${i}: pageIdx must be a finite number` });
            }

            if (typeof s.text !== 'string') {
                console.error(`[AI] Klaszterezés hiba: story[${i}].text is not a string`);
                return res.status(400).json({ error: `Invalid story at index ${i}: text must be a string` });
            }

            // Check bounds array
            if (!Array.isArray(s.bounds) || s.bounds.length < 4) {
                console.error(`[AI] Klaszterezés hiba: story[${i}].bounds is not an array with length >= 4`);
                return res.status(400).json({ error: `Invalid story at index ${i}: bounds must be an array with at least 4 elements` });
            }

            for (let j = 0; j < 4; j++) {
                if (typeof s.bounds[j] !== 'number') {
                    console.error(`[AI] Klaszterezés hiba: story[${i}].bounds[${j}] is not a number`);
                    return res.status(400).json({ error: `Invalid story at index ${i}: bounds must contain numeric values` });
                }

                // Ensure bounds element is finite
                if (!Number.isFinite(s.bounds[j])) {
                    console.error(`[AI] Klaszterezés hiba: story[${i}].bounds[${j}] is NaN or Infinity`);
                    return res.status(400).json({ error: `Invalid story at index ${i}: bounds values must be finite numbers` });
                }
            }

            // Check numeric properties
            if (typeof s.charCount !== 'number') {
                console.error(`[AI] Klaszterezés hiba: story[${i}].charCount is not a number`);
                return res.status(400).json({ error: `Invalid story at index ${i}: charCount must be a number` });
            }

            // Ensure charCount is finite
            if (!Number.isFinite(s.charCount)) {
                console.error(`[AI] Klaszterezés hiba: story[${i}].charCount is NaN or Infinity`);
                return res.status(400).json({ error: `Invalid story at index ${i}: charCount must be a finite number` });
            }

            if (typeof s.fontSize !== 'number') {
                console.error(`[AI] Klaszterezés hiba: story[${i}].fontSize is not a number`);
                return res.status(400).json({ error: `Invalid story at index ${i}: fontSize must be a number` });
            }

            // Ensure fontSize is finite
            if (!Number.isFinite(s.fontSize)) {
                console.error(`[AI] Klaszterezés hiba: story[${i}].fontSize is NaN or Infinity`);
                return res.status(400).json({ error: `Invalid story at index ${i}: fontSize must be a finite number` });
            }

            // styleName is optional, but if present must be string
            if (s.styleName !== undefined && typeof s.styleName !== 'string') {
                console.error(`[AI] Klaszterezés hiba: story[${i}].styleName is not a string`);
                return res.status(400).json({ error: `Invalid story at index ${i}: styleName must be a string` });
            }
        }

        try {
            const groq = new Groq({ apiKey });

            // Story-k kompakt szöveges formátuma a prompthoz
            const storyLines = stories.map(s =>
                `[story:${s.storyId}] oldal:${s.pageIdx} ` +
                `pos:(${Math.round(s.bounds[1])},${Math.round(s.bounds[0])})–` +
                `(${Math.round(s.bounds[3])},${Math.round(s.bounds[2])}) ` +
                `${s.charCount}kar ${s.fontSize}pt` +
                (s.styleName ? ` stílus:"${s.styleName}"` : '') +
                `\n"${s.text}"`
            ).join('\n\n');

            const prompt = `Egy magyar magazin oldalpárjának szöveg-story-jait kapod. Minden story egy vagy több összefűzött szövegkeretből áll (az InDesign threading miatt).

Feladatod:
1. Csoportosítsd a story-kat logikai cikkekbe (klaszterekbe)
2. Minden story-hoz rendelj típust

STORY-K:
${storyLines}

KLASZTEREZÉSI SZABÁLYOK:
- Tematikusan összetartozó szövegek egy klaszterbe (pl. egy celebről szóló cím + leírás + képaláírás)
- Különböző személyekről/témákról szóló szövegek KÜLÖN klaszterbe
- A fő oldal-cím és bevezető szöveg (ha van) külön klaszter
- Rövid, önálló szövegek (pl. idézet rovat, képaláírás) lehetnek külön klaszter
- Pozíció figyelembevétele: közeli szövegek valószínűbben összetartoznak
- FONTOS: Rövid névfeliratok (pl. "Drew Barrymore", "Céline Dion") MINDIG ahhoz a klaszterhez tartoznak, amelyik az adott személyről szóló szöveget tartalmazza — NE legyenek önálló klaszterben!
- FONTOS: Rövid feliratok (pl. "Édesanyja persze csak jót akart", "Megküzdött a babapofiért") MINDIG a legközelebbi, tartalmilag kapcsolódó story-val egy klaszterbe kerülnek!

TÍPUSOK (pontosan egyet rendelj minden story-hoz):
- CIM: főcím vagy egy minicikk címe (jellemzően nagy betűméret, rövid szöveg)
- LEAD: bevezető szöveg (a fő cím utáni összefoglaló)
- KENYERSZOVEG: fő szövegtörzs
- KEPALAIRAS: képaláírás (rövid, jellemzően kis betűméret)
- KERETES: keretes cikk (önálló dobozban lévő szöveg)
- KOZCIM: alcím
- KIEMELES: kiemelt idézet vagy szöveg (pull quote)

Válaszolj KIZÁRÓLAG érvényes JSON-nel, semmilyen más szöveggel:
{"clusters":[{"storyIds":["id1","id2"],"types":{"id1":"CIM","id2":"KENYERSZOVEG"}}]}`;

            const completion = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                max_tokens: 4096,
                temperature: 0,
                messages: [{ role: 'user', content: prompt }]
            });

            // Validate AI response structure
            if (!completion.choices || !Array.isArray(completion.choices) || completion.choices.length === 0) {
                console.error('[AI] Klaszterezés hiba: No choices in AI response');
                return res.status(500).json({ error: 'Invalid AI response' });
            }

            // Null-safety check for message object
            const choice = completion.choices[0];
            if (!choice || typeof choice !== 'object') {
                console.error('[AI] Klaszterezés hiba: choice is not an object');
                return res.status(500).json({ error: 'Invalid AI response' });
            }

            const message = choice.message;
            if (!message || typeof message !== 'object') {
                console.error('[AI] Klaszterezés hiba: message is not an object');
                return res.status(500).json({ error: 'Invalid AI response' });
            }

            const responseText = message.content;
            if (typeof responseText !== 'string') {
                console.error('[AI] Klaszterezés hiba: Response text is not a string');
                return res.status(500).json({ error: 'Invalid AI response' });
            }

            // JSON kinyerése — ha markdown code block-ba csomagolta, kivágjuk
            let parsed;
            try {
                const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
                const jsonStr = jsonMatch ? jsonMatch[1].trim() : responseText.trim();
                parsed = JSON.parse(jsonStr);
            } catch (parseError) {
                console.error('[AI] Klaszterezés hiba: JSON parse failed:', parseError);
                return res.status(500).json({ error: 'Invalid AI response' });
            }

            // Validate parsed response structure
            if (!parsed.clusters || !Array.isArray(parsed.clusters)) {
                console.error('[AI] Klaszterezés hiba: parsed.clusters is not an array');
                return res.status(500).json({ error: 'Invalid AI response' });
            }

            console.log(`[AI] Klaszterezés: ${stories.length} story → ${parsed.clusters.length} klaszter`);
            res.json(parsed);

        } catch (error) {
            console.error('[AI] Klaszterezés hiba:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
);

// --- Tördelő AI (Layout Analysis) ---

const layoutAIRouter = require('./routes/layoutAI');
app.use(layoutAIRouter);

// --- Legacy Auth Callback Redirects ---
//
// A korábbi Plugin verziókban az Appwrite `account.createVerification()` és
// `account.createRecovery()` hívások ide, a proxy `/verify` és `/reset-password`
// HTML form endpointjaira mutattak. A Fázis 1 / B.6 óta a Plugin a Dashboard
// `/verify` és `/reset-password` route-jait használja. Ezek a redirectek a
// user inboxokban levő régi email linkek backward-compat fedezetét adják —
// ugyanazzal a `userId+secret` query string-gel átirányítanak a Dashboardra.
//
// A cél URL a `DASHBOARD_URL` env változóból származik (Railway / emago.hu
// deployment-enként állítható) — staging vagy domain-migráció esetén így
// nem kerülnek userId+secret token-ek rossz frontendre. Fallback a production
// Dashboard domain, amely B.4 óta élesben működik.

const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://maestro.emago.hu').replace(/\/+$/, '');

app.get(['/verify', '/maestro-proxy/verify'], (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    res.redirect(302, `${DASHBOARD_URL}/verify${qs ? '?' + qs : ''}`);
});

app.get(['/reset-password', '/maestro-proxy/reset-password'], (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    res.redirect(302, `${DASHBOARD_URL}/reset-password${qs ? '?' + qs : ''}`);
});

/**
 * A régi HTML form POST-ja értelmetlen egy GET redirect után (a body nem
 * továbbítható új GET-re). 410 Gone válasz tájékoztatja a usert, hogy
 * kattintson újra a friss Dashboard linkre az emailben.
 */
app.post(['/reset-password', '/maestro-proxy/reset-password'], (req, res) => {
    res.status(410).send('Ez a form elavult. Kérlek kattints újra a jelszó-visszaállító linkre az emailben.');
});

// --- Authentication Injection Logic ---

/**
 * Extracts authentication data from query parameters and injects them as headers into the proxy request.
 *
 * UXP Clients send authentication data (cookies and package names) in query parameters
 * because WebSocket headers are not fully supported in the UXP environment.
 * This function ensures Appwrite receives these as proper security headers.
 *
 * @param {Object} proxyReq - The outgoing proxy request object.
 * @param {Object} req - The incoming source request object.
 */
function injectAuthenticationFromQueryParams(proxyReq, req) {
    try {
        const targetUrl = new URL(req.url, 'http://localhost');
        const searchParameters = targetUrl.searchParams;

        // S.1.6 — x-fallback-cookies CSAK Realtime WS upgrade path-en + validált JSON.
        // Raw-string fallback eltávolítva (korábban silently propagált malformed payload-ot).
        // Segment-boundary check (NEM `/v1/realtimeevil`).
        const isRealtimePath = pathMatchesAny(targetUrl.pathname, FALLBACK_COOKIES_ALLOWED_PATHS);
        if (isRealtimePath) {
            const fallbackCookies = searchParameters.get('x-fallback-cookies');
            if (fallbackCookies) {
                const cookieHeader = validateAndBuildCookieHeader(fallbackCookies);
                if (cookieHeader) {
                    proxyReq.setHeader('Cookie', cookieHeader);
                    console.log(`[Proxy] WS auth cookies injected (${targetUrl.pathname})`);
                } else {
                    console.warn(`[Proxy] x-fallback-cookies rejected (validation failed) ${targetUrl.pathname}`);
                }
            }
        }

        // Appwrite Package Name — bárhol engedett, de szigorú string-validáció
        const appwritePackageName = searchParameters.get('x-appwrite-package-name');
        if (appwritePackageName
            && typeof appwritePackageName === 'string'
            && appwritePackageName.length <= 200
            && /^[A-Za-z0-9._-]+$/.test(appwritePackageName)
        ) {
            proxyReq.setHeader('X-Appwrite-Package-Name', appwritePackageName);
        }
    } catch (error) {
        console.error('[Proxy] Authentication injection failed:', error.message);
    }
}
// Shared proxy configuration
const baseProxyOptions = {
    target: 'https://cloud.appwrite.io',
    changeOrigin: true,
    xfwd: false, // Do not add X-Forwarded headers to avoid detection
    headers: {
        'Host': 'cloud.appwrite.io',
        'Origin': 'https://emago.hu' // Matches the Appwrite Web Platform allowed origin
    },
    pathRewrite: (path) => path.replace('/maestro-proxy', ''), // Strip prefix if present

    onError: (error, req, res) => {
        // Zajszűrés: EPIPE/ECONNRESET normális socket lifecycle események
        if (isSocketNoise(error)) return;

        console.error('[Proxy Error]', error.message);

        // WebSocket error-nél a "res" valójában egy Socket objektum, aminek nincs status() metódusa
        if (res && typeof res.status === 'function' && !res.headersSent) {
            res.status(502).json({
                error: 'Proxy communication error',
                message: error.message
            });
        }
    }
};

/**
 * Shared proxy request preparation.
 * Removes tracking headers, sets Host, injects auth, and logs the request.
 */
function prepareProxyRequest(proxyReq, req) {
    proxyReq.removeHeader('x-forwarded-host');
    proxyReq.removeHeader('x-forwarded-proto');
    proxyReq.removeHeader('x-forwarded-for');
    proxyReq.setHeader('Host', 'cloud.appwrite.io');
    injectAuthenticationFromQueryParams(proxyReq, req);
    // S.1.4 — PII-redacted log (cookie/token/email query-paramok maszkolva)
    console.log(`[Proxy] ${req.method} ${redactUrl(req.url)} -> Appwrite`);
}

// HTTP Proxy — normál API kérésekhez (30s timeout)
const httpProxy = createProxyMiddleware({
    ...baseProxyOptions,
    ws: false,
    proxyTimeout: 30000,  // 30s proxy→Appwrite timeout
    timeout: 30000,       // 30s kliens→proxy timeout
    onProxyReq: prepareProxyRequest
});

// WebSocket Proxy — Realtime kapcsolatokhoz (nincs timeout)
let lastDisconnectTime = null;
const wsProxy = createProxyMiddleware({
    ...baseProxyOptions,
    ws: true,
    proxyTimeout: 0,  // Nincs proxy→Appwrite timeout (WebSocket örökké nyitva)
    timeout: 0,       // Nincs kliens→proxy timeout
    onProxyReq: prepareProxyRequest,

    /**
     * Handles WebSocket upgrade requests - CRITICAL for Realtime authentication!
     * onProxyReq does NOT fire for WebSocket upgrades, so this hook is required.
     */
    onProxyReqWs: (proxyReq, req, socket) => {
        prepareProxyRequest(proxyReq, req);
        console.log(`[Proxy] [WS] WebSocket Upgrade — aktív kapcsolatok: ${activeWsSockets.size + 1}`);

        // TCP Keep-Alive a client socket-en (megakadályozza az OS idle timeout-ot)
        socket.setKeepAlive(true, 30000);

        // Socket tracking (ping frame-ekhez)
        activeWsSockets.add(socket);

        socket.on('close', () => {
            activeWsSockets.delete(socket);
            const now = Date.now();
            console.log(`[Proxy] [WS] WebSocket Closed — aktív: ${activeWsSockets.size}`);

            if (lastDisconnectTime) {
                const diffMs = now - lastDisconnectTime;
                const diffSec = (diffMs / 1000).toFixed(1);
                console.log(`[Proxy] [WS] Idő az előző szakadás óta: ${diffSec}s`);
            }
            lastDisconnectTime = now;
        });

        socket.on('error', (err) => {
            if (!isSocketNoise(err)) {
                console.error('[Proxy] [WS] Socket error:', err.message);
            }
            activeWsSockets.delete(socket);
        });
    }
});

// (S.1 Codex BLOCKER) — a WS upgrade event NEM megy át az Express middleware láncon,
// ezért a CORS / nullOriginGuard / express-rate-limit a WS-re bypassolható volt.
// Megoldás: NE mountoljuk az `wsProxy`-t app.use-ra (az auto-subscribe az `upgrade` event-re).
// Helyette explicit `server.on('upgrade', wsUpgradeHandler)` gate (lent, `server.listen` után),
// amely path/origin/`X-Maestro-Client`/rate-limit ellenőrzés után hívja `wsProxy.upgrade()`-et.

// Minden /v1/* HTTP kérés — http proxy-val, normál timeout
app.use(['/v1', '/maestro-proxy/v1'], httpProxy);

// 404 Handler for unknown routes
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// Start the server
const server = app.listen(port, () => {
    console.log(`[Proxy] Maestro CORS Proxy running on port ${port}`);
    console.log(`[Proxy] Health check: http://localhost:${port}/v1/health`);
});

// --- TCP Keep-Alive ---
// A Railway/Apache idle timeout ellen (alapértelmezett Node.js 5s → 65s)
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000; // keepAliveTimeout-nál kicsit nagyobb (Node.js ajánlás)

// --- S.1.2 / S.1.3 / S.1.6 WS Upgrade Gate (Codex BLOCKER fix) ---
// A WebSocket upgrade event NEM megy át az Express middleware láncon, ezért explicit
// gate kell amely a CORS / null-origin / rate-limit kontrollokat reprodukálja:
//   1. Path: csak `NULL_ORIGIN_ALLOWED_PATHS` (`/v1/realtime`)
//   2. Origin: HTTP-rel azonos allowlist (`ALLOWED_ORIGINS` + `null` secondary guard)
//   3. `null` origin → `X-Maestro-Client: indesign-plugin` header kötelező
//   4. Rate-limit: per-IP 60 upgrade / perc (memory-store)
// 403/429 esetén plain HTTP response + socket destroy.
function denyUpgrade(socket, statusCode, message) {
    try {
        const reasonLine = statusCode === 403 ? '403 Forbidden' : '429 Too Many Requests';
        socket.write(`HTTP/1.1 ${reasonLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}\r\n`);
        // (Codex verifying NIT) flush-garancia — graceful FIN után 50ms-mal destroy
        socket.end();
    } catch (e) { /* socket may already be destroyed */ }
    setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
    }, 50).unref();
}

server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
        pathname = new URL(req.url, 'http://local').pathname;
    } catch {
        return denyUpgrade(socket, 403, 'malformed upgrade URL');
    }

    // 1. Path validation — csak `/v1/realtime` (segment-boundary)
    if (!pathMatchesAny(pathname, NULL_ORIGIN_ALLOWED_PATHS)) {
        return denyUpgrade(socket, 403, 'WS upgrade not permitted on this path');
    }

    // 2. Origin validation (CORS allowlist párhuzamos)
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !ALLOWED_ORIGINS.has(origin)) {
        return denyUpgrade(socket, 403, 'CORS origin not allowed');
    }

    // 3. null-origin secondary guard
    if (origin === 'null' && req.headers['x-maestro-client'] !== 'indesign-plugin') {
        return denyUpgrade(socket, 403, 'null origin requires X-Maestro-Client header');
    }

    // 4. Per-IP rate-limit (60 / perc / IP)
    const clientIp = extractClientIp(req);
    if (!checkWsUpgradeRateLimit(clientIp)) {
        return denyUpgrade(socket, 429, 'Too many WebSocket upgrade requests');
    }

    // Minden ellenőrzés zöld — proxy átadás
    wsProxy.upgrade(req, socket, head);
});

// --- WebSocket Ping Frames ---
// 15 másodpercenként ping frame küldése az aktív WebSocket socket-ekre,
// megakadályozva az Apache/Passenger/Railway idle timeout-ot.
const pingInterval = setInterval(() => {
    for (const socket of activeWsSockets) {
        if (socket.destroyed || socket.writableEnded) {
            activeWsSockets.delete(socket);
            continue;
        }
        try {
            socket.write(WS_PING_FRAME);
        } catch (e) {
            // Socket már lezárt, a close handler kitakarítja
            activeWsSockets.delete(socket);
        }
    }
}, WS_PING_INTERVAL_MS);

// --- Graceful Shutdown ---
function shutdown(signal) {
    console.log(`[Proxy] ${signal} received, shutting down...`);
    clearInterval(pingInterval);

    // Aktív WebSocket-ek lezárása
    for (const socket of activeWsSockets) {
        try { socket.destroy(); } catch (e) { /* ignore */ }
    }
    activeWsSockets.clear();

    server.close(() => {
        console.log('[Proxy] Server closed');
        process.exit(0);
    });

    // Ha 10s alatt nem záródik le, kilépés
    setTimeout(() => {
        console.error('[Proxy] Forced shutdown after timeout');
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
