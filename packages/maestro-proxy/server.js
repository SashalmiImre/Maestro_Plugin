const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
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

// Body parser — POST form adatokhoz (jelszó-visszaállítás)
app.use(express.urlencoded({ extended: false }));

// CORS headers - allow all origins for UXP plugin
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Appwrite-Project',
        'X-Appwrite-Key',
        'X-Appwrite-Response-Format',
        'X-Fallback-Cookies'
    ]
}));

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

        // 1. Inject Cookies from x-fallback-cookies query parameter
        const fallbackAuthenticationCookies = searchParameters.get('x-fallback-cookies');
        if (fallbackAuthenticationCookies) {
            try {
                const cookies = JSON.parse(fallbackAuthenticationCookies);
                const cookieHeader = Object.entries(cookies)
                    .map(([key, value]) => `${key}=${value}`)
                    .join('; ');

                if (cookieHeader) {
                    proxyReq.setHeader('Cookie', cookieHeader);
                    console.log(`[Proxy] 🍪 Injected Cookies for ${targetUrl.pathname}`);
                }
            } catch (error) {
                // If not JSON, treat as a direct cookie string
                proxyReq.setHeader('Cookie', fallbackAuthenticationCookies);
            }
        }

        // 2. Inject Appwrite Package Name
        const appwritePackageName = searchParameters.get('x-appwrite-package-name');
        if (appwritePackageName) {
            proxyReq.setHeader('X-Appwrite-Package-Name', appwritePackageName);
            console.log(`[Proxy] 📦 Injected Package Name: ${appwritePackageName}`);
        }
    } catch (error) {
        console.error('[Proxy] Authentication injection failed:', error);
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
    console.log(`[Proxy] ${req.method} ${req.url} -> Appwrite`);
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

// Realtime (WebSocket) route — ws proxy-val, végtelen timeout
app.use(['/v1/realtime', '/maestro-proxy/v1/realtime'], wsProxy);

// Minden egyéb /v1/* kérés — http proxy-val, normál timeout
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
