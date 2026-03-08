const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const sdk = require('node-appwrite');
const Groq = require('groq-sdk');

/**
 * Maestro CORS Proxy Server
 *
 * Provides a secure middle layer for UXP plugins to communicate with Appwrite Cloud,
 * handling authentication injection and CORS headers.
 */

const app = express();
const port = process.env.PORT || 3000;

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

// --- Közös HTML sablon ---

/** Alap stílusok az összes Maestro oldalhoz. */
const BASE_STYLES = `
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #1a1a1a;
        color: #e0e0e0;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
    }
    .card {
        background: #2a2a2a;
        border-radius: 12px;
        padding: 40px;
        text-align: center;
        max-width: 400px;
        width: 100%;
        box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    }
    .icon {
        font-size: 48px;
        margin-bottom: 16px;
    }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { font-size: 14px; color: #999; margin: 0; line-height: 1.5; }
    .brand { font-size: 12px; color: #555; margin-top: 24px; }
`;

/**
 * Eredmény oldal HTML sablon (siker/hiba visszajelzés).
 */
function resultHTML(title, message, isSuccess) {
    const color = isSuccess ? '#2d7d46' : '#d7373f';
    const icon = isSuccess ? '&#10003;' : '&#10007;';
    return `<!DOCTYPE html>
<html lang="hu">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maestro — ${title}</title>
    <style>${BASE_STYLES}
        .icon { color: ${color}; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">${icon}</div>
        <h1>${title}</h1>
        <p>${message}</p>
        <div class="brand">Maestro</div>
    </div>
</body>
</html>`;
}

// --- Email Verification Endpoint ---

/**
 * Email verificációs callback endpoint.
 *
 * Az Appwrite `account.createVerification()` által küldött emailben lévő link
 * ide irányít. A Server SDK-val közvetlenül megerősítjük a felhasználó email címét.
 *
 * Env vars: APPWRITE_PROJECT_ID, APPWRITE_API_KEY
 */
app.get('/verify', async (req, res) => {
    const { userId, secret } = req.query;

    if (!userId || !secret) {
        return res.status(400).send(resultHTML(
            'Hibás hivatkozás',
            'A megerősítő link érvénytelen vagy hiányos. Próbálj újra regisztrálni.',
            false
        ));
    }

    try {
        const client = new sdk.Client()
            .setEndpoint('https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const users = new sdk.Users(client);
        await users.updateEmailVerification({ userId, emailVerification: true });

        console.log(`[Verify] Email megerősítve: userId=${userId}`);
        res.send(resultHTML(
            'Email sikeresen megerősítve!',
            'Most már bejelentkezhetsz az InDesign pluginban. Ezt az oldalt bezárhatod.',
            true
        ));
    } catch (error) {
        console.error(`[Verify] Hiba: userId=${userId}`, error.message);
        res.status(500).send(resultHTML(
            'A megerősítés sikertelen',
            'Hiba történt az email megerősítése során. Próbálj újra regisztrálni.',
            false
        ));
    }
});

// --- Password Recovery Endpoints ---

/**
 * Jelszó-visszaállítás form megjelenítése.
 *
 * Az Appwrite `account.createRecovery()` által küldött emailben lévő link
 * ide irányít. HTML formot jelenítünk meg az új jelszó megadásához.
 */
app.get('/reset-password', (req, res) => {
    const { userId, secret } = req.query;

    if (!userId || !secret) {
        return res.status(400).send(resultHTML(
            'Hibás hivatkozás',
            'A jelszó-visszaállító link érvénytelen vagy hiányos. Próbáld újra a pluginból.',
            false
        ));
    }

    res.send(resetPasswordFormHTML(userId, secret));
});

/**
 * Jelszó-visszaállítás feldolgozása.
 *
 * A form POST-olja ide az új jelszót. Az Appwrite REST API-n keresztül
 * frissítjük a jelszót (a userId + secret kombináció az autentikáció).
 */
app.post('/reset-password', async (req, res) => {
    const { userId, secret, password, passwordConfirm } = req.body;

    if (!userId || !secret || !password || !passwordConfirm) {
        return res.status(400).send(resultHTML(
            'Hiányos adatok',
            'Minden mező kitöltése kötelező.',
            false
        ));
    }

    if (password.length < 8) {
        return res.status(400).send(resultHTML(
            'Túl rövid jelszó',
            'A jelszónak legalább 8 karakter hosszúnak kell lennie.',
            false
        ));
    }

    if (password !== passwordConfirm) {
        return res.status(400).send(resultHTML(
            'A jelszavak nem egyeznek',
            'A megadott jelszavak nem egyeznek. Próbáld újra.',
            false
        ));
    }

    try {
        // Appwrite REST API — PUT /v1/account/recovery
        // Nem igényel API key-t, a userId + secret kombináció az autentikáció
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        let response;
        try {
            response = await fetch('https://cloud.appwrite.io/v1/account/recovery', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Appwrite-Project': process.env.APPWRITE_PROJECT_ID,
                },
                body: JSON.stringify({ userId, secret, password }),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `HTTP ${response.status}`);
        }

        console.log(`[Recovery] Jelszó sikeresen módosítva: userId=${userId}`);
        res.send(resultHTML(
            'Jelszó sikeresen módosítva!',
            'Most már bejelentkezhetsz az InDesign pluginban az új jelszóddal. Ezt az oldalt bezárhatod.',
            true
        ));
    } catch (error) {
        console.error(`[Recovery] Hiba: userId=${userId}`, error.message);
        const isAbort = error.name === 'AbortError';
        res.status(500).send(resultHTML(
            'A jelszó módosítása sikertelen',
            isAbort
                ? 'A szerver nem válaszolt időben. Próbáld újra a pluginból.'
                : 'Hiba történt a jelszó módosítása során. Próbáld újra a pluginból.',
            false
        ));
    }
});

/**
 * Escapes special characters for safe embedding in HTML attribute values.
 * @param {string} str - The raw string to escape.
 * @returns {string} The escaped string.
 */
function escapeAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

/**
 * HTML sablon a jelszó-visszaállító formhoz.
 */
function resetPasswordFormHTML(userId, secret) {
    return `<!DOCTYPE html>
<html lang="hu">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Maestro — Új jelszó beállítása</title>
    <style>${BASE_STYLES}
        .icon { color: #3b82f6; }
        .form-group {
            margin-bottom: 16px;
            text-align: left;
        }
        label {
            display: block;
            font-size: 12px;
            color: #999;
            margin-bottom: 4px;
        }
        input[type="password"] {
            width: 100%;
            padding: 10px 12px;
            background: #1a1a1a;
            border: 1px solid #444;
            border-radius: 6px;
            color: #e0e0e0;
            font-size: 14px;
            box-sizing: border-box;
            outline: none;
            transition: border-color 0.2s;
        }
        input[type="password"]:focus {
            border-color: #3b82f6;
        }
        button {
            width: 100%;
            padding: 12px;
            background: #3b82f6;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 8px;
            transition: background 0.2s;
        }
        button:hover { background: #2563eb; }
        button:disabled { background: #555; cursor: not-allowed; }
        .error { color: #d7373f; font-size: 12px; margin-top: 8px; display: none; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">&#128274;</div>
        <h1>Új jelszó beállítása</h1>
        <p style="margin-bottom: 24px;">Add meg az új jelszavadat.</p>

        <form method="POST" action="/reset-password" id="resetForm">
            <input type="hidden" name="userId" value="${escapeAttr(userId)}">
            <input type="hidden" name="secret" value="${escapeAttr(secret)}">

            <div class="form-group">
                <label for="password">Új jelszó (min. 8 karakter)</label>
                <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
            </div>

            <div class="form-group">
                <label for="passwordConfirm">Jelszó megerősítés</label>
                <input type="password" id="passwordConfirm" name="passwordConfirm" required minlength="8" autocomplete="new-password">
            </div>

            <div class="error" id="errorMsg"></div>

            <button type="submit">Jelszó módosítása</button>
        </form>

        <div class="brand">Maestro</div>
    </div>

    <script>
        document.getElementById('resetForm').addEventListener('submit', function(e) {
            var pw = document.getElementById('password').value;
            var pwc = document.getElementById('passwordConfirm').value;
            var err = document.getElementById('errorMsg');

            if (pw.length < 8) {
                e.preventDefault();
                err.textContent = 'A jelszónak legalább 8 karakter hosszúnak kell lennie!';
                err.style.display = 'block';
                return;
            }

            if (pw !== pwc) {
                e.preventDefault();
                err.textContent = 'A jelszavak nem egyeznek!';
                err.style.display = 'block';
                return;
            }

            err.style.display = 'none';
        });
    </script>
</body>
</html>`;
}

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
        console.log(`[Proxy] 🔌 WebSocket Upgrade`);

        socket.on('close', () => {
            const now = Date.now();
            console.log(`[Proxy] 🔓 WebSocket Closed`);

            if (lastDisconnectTime) {
                const diffMs = now - lastDisconnectTime;
                const diffSec = (diffMs / 1000).toFixed(1);
                console.log(`[Proxy] ⏱️ Idő az előző szakadás óta: ${diffSec} másodperc`);
            } else {
                console.log(`[Proxy] ⏱️ Első szakadás rögzítve`);
            }

            lastDisconnectTime = now;
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
    console.log(`✅ Maestro CORS Proxy running on port ${port}`);
    console.log(`   Health check: http://localhost:${port}/v1/health`);
});
