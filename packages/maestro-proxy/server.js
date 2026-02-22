const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

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
// Start the server
const server = app.listen(port, () => {
    console.log(`✅ Maestro CORS Proxy running on port ${port}`);
    console.log(`   Health check: http://localhost:${port}/v1/health`);
});


