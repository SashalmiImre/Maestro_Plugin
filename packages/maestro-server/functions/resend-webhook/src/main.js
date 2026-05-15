// ADR 0010 W3 — Resend bounce/delivery webhook handler.
//
// Public endpoint: bárki posztolhat ide, ezért HMAC verify KÖTELEZŐ.
// Resend Dashboard → Webhooks → URL:
//   https://api.maestro.emago.hu/v1/functions/resend-webhook/executions
//   (lásd ADR 0005 Dashboard custom domain)
//
// HMAC secret env var: `RESEND_WEBHOOK_SECRET` (a Resend webhook setup
// oldalán generált, formátum: `whsec_...`).
//
// SKELETON — a payload-szignatúra verifikáció kész, de:
//   - A webhook URL még nincs Resend-ben beállítva (W3 élesítéskor)
//   - A `RESEND_WEBHOOK_SECRET` env var még nincs az Appwrite Function-be
//     felvéve
//   - Az Appwrite Function-höz `Execute Access: Any` permission kell
//     (a Resend HMAC verifikálja a payload-ot, nem az Appwrite IAM)
//
// Resend webhook események:
//   email.sent, email.delivered, email.delivery_delayed, email.bounced,
//   email.complained, email.opened, email.clicked
// Itt csak a delivery-state eseményeket kezeljük (sent / delivered /
// bounced / complained / delivery_delayed). Az opened/clicked a Resend
// dashboardon analytics célra használható, de a UI delivery-status badge
// szempontjából irreleváns.

const sdk = require('node-appwrite');
const crypto = require('crypto');

// S.13.2+S.13.3 Phase 2.2 — PII-redaction log wrap (shared piiRedaction.js).
const { wrapLogger } = require('./_generated_piiRedaction.js');

// ─── Svix HMAC verifikáció ─────────────────────────────────────────────
//
// A Resend a Svix-en át küldi a webhookot — három header:
//   - svix-id: egyedi message-ID
//   - svix-timestamp: kibocsátás Unix timestamp (másodperc)
//   - svix-signature: "v1,sig1 v1,sig2 ..." (lehet több, ha a webhook secret
//     éppen rotálódik)
//
// Aláírt payload formátum: `${id}.${timestamp}.${rawBody}`
// HMAC-SHA256 → base64
// @see https://docs.svix.com/receiving/verifying-payloads/how-manual

const SIGNATURE_HEADER = 'svix-signature';
const TIMESTAMP_HEADER = 'svix-timestamp';
const ID_HEADER = 'svix-id';
const TIMESTAMP_TOLERANCE_SEC = 5 * 60; // 5 perc clock-skew tolerancia

function getHeader(headers, name) {
    if (!headers) return null;
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function verifySvixSignature(rawBody, headers, secret) {
    const sigHeader = getHeader(headers, SIGNATURE_HEADER);
    const timestamp = getHeader(headers, TIMESTAMP_HEADER);
    const id = getHeader(headers, ID_HEADER);
    if (!sigHeader || !timestamp || !id) {
        return { valid: false, reason: 'missing_headers' };
    }

    // Timestamp tolerancia — replay-attack védelem
    const tsNum = parseInt(timestamp, 10);
    if (!Number.isFinite(tsNum)) {
        return { valid: false, reason: 'invalid_timestamp' };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > TIMESTAMP_TOLERANCE_SEC) {
        return { valid: false, reason: 'stale_timestamp' };
    }

    // Secret formátum: `whsec_<base64>` — a prefix-et le kell venni, és
    // a maradékot base64-ből bytes-ra dekódolni
    const cleanSecret = secret.replace(/^whsec_/, '');
    let secretBytes;
    try {
        secretBytes = Buffer.from(cleanSecret, 'base64');
    } catch {
        return { valid: false, reason: 'invalid_secret' };
    }

    const signedPayload = `${id}.${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', secretBytes).update(signedPayload).digest('base64');

    // A header tartalmazhat több aláírást szóközzel elválasztva — bármelyikkel
    // egyezés elég
    const signatures = sigHeader.split(' ').map(s => {
        const parts = s.split(',');
        return parts.length === 2 ? parts[1] : null;
    }).filter(Boolean);

    const matches = signatures.some(sig => {
        try {
            const sigBuf = Buffer.from(sig);
            const expBuf = Buffer.from(expected);
            return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
        } catch {
            return false;
        }
    });

    return { valid: matches, reason: matches ? null : 'signature_mismatch' };
}

// ─── Resend event → invite delivery status mapping ─────────────────────

const STATUS_MAP = {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.delivery_delayed': 'sent',
    'email.bounced': 'bounced',
    'email.complained': 'failed'
};

// ─── Function entry point ──────────────────────────────────────────────

module.exports = async ({ req, res, log: rawLog, error: rawError }) => {
    const { log, error } = wrapLogger(rawLog, rawError);
    // Appwrite dynamic API key: a `function.scopes` alapján a függvényhíváskor
    // a `x-appwrite-key` headerben érkezik egy frissen generált, scope-szűkített
    // kulcs. Ez biztonságosabb mint egy hardcoded `APPWRITE_API_KEY` env var,
    // ezért a header-fallback-en első helyen.
    const env = {
        endpoint: process.env.APPWRITE_FUNCTION_API_ENDPOINT || 'https://cloud.appwrite.io/v1',
        projectId: process.env.APPWRITE_FUNCTION_PROJECT_ID,
        apiKey: req?.headers?.['x-appwrite-key'] || process.env.APPWRITE_API_KEY || '',
        databaseId: process.env.APPWRITE_DATABASE_ID || process.env.DATABASE_ID,
        invitesCollectionId: process.env.INVITES_COLLECTION_ID || process.env.ORGANIZATION_INVITES_COLLECTION_ID || 'organizationInvites',
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET
    };

    if (!env.webhookSecret) {
        error('[Webhook] RESEND_WEBHOOK_SECRET nincs beállítva');
        return res.json({ success: false, error: 'webhook_not_configured' }, 500);
    }

    // 1) HMAC verify — a Resend / Svix-aláírás kötelező. A `req.bodyRaw`
    // a teljes raw body (Appwrite Function infrastruktúra biztosítja).
    const rawBody = typeof req.bodyRaw === 'string'
        ? req.bodyRaw
        : (req.body ? JSON.stringify(req.body) : '');
    const verification = verifySvixSignature(rawBody, req.headers || {}, env.webhookSecret);
    if (!verification.valid) {
        log(`[Webhook] HMAC verify failed: ${verification.reason}`);
        return res.json({ success: false, error: 'invalid_signature', reason: verification.reason }, 401);
    }

    // 2) Payload parse
    let payload;
    try {
        payload = typeof req.body === 'object' && req.body !== null
            ? req.body
            : JSON.parse(rawBody);
    } catch {
        return res.json({ success: false, error: 'invalid_json' }, 400);
    }

    const { type, data } = payload || {};
    if (!type || !data) {
        return res.json({ success: false, error: 'malformed_payload' }, 400);
    }

    // 3) Csak delivery-state eseményeket dolgozunk fel
    const newStatus = STATUS_MAP[type];
    if (!newStatus) {
        log(`[Webhook] ignored event type: ${type}`);
        return res.json({ success: true, ignored: type });
    }

    // 4) Az invite_id Resend `tags` mezőben jön (a `sendEmail.js` írja)
    const tags = Array.isArray(data.tags) ? data.tags : [];
    const inviteIdTag = tags.find(t => t?.name === 'invite_id');
    const inviteId = inviteIdTag?.value;
    if (!inviteId) {
        log(`[Webhook] no invite_id tag in event ${type}, skipping`);
        return res.json({ success: true, skipped: 'no_invite_id' });
    }

    // 5) Invite update (server SDK API key-jel)
    const client = new sdk.Client()
        .setEndpoint(env.endpoint)
        .setProject(env.projectId)
        .setKey(env.apiKey);
    const databases = new sdk.Databases(client);

    const updates = { lastDeliveryStatus: newStatus };
    if (newStatus === 'bounced' || newStatus === 'failed') {
        const errorMsg = data.bounce?.diagnosticCode
            || data.complaint?.feedbackType
            || data.reason
            || type;
        updates.lastDeliveryError = String(errorMsg).substring(0, 512);
    }

    try {
        await databases.updateDocument(env.databaseId, env.invitesCollectionId, inviteId, updates);
        log(`[Webhook] invite=${inviteId} status=${newStatus}`);
    } catch (err) {
        // Ha az invite időközben törölődött, a Resend sok-sok eventet küldhet —
        // log-oljuk, de NE 500-ozzunk vissza, különben a Resend újrapróbálná.
        if (err?.code === 404 || /not_found|not found/i.test(err?.message || '')) {
            log(`[Webhook] invite ${inviteId} not found (already deleted?) — ack`);
            return res.json({ success: true, skipped: 'invite_not_found' });
        }
        error(`[Webhook] invite update failed: ${err.message}`);
        return res.json({ success: false, error: 'invite_update_failed' }, 500);
    }

    return res.json({ success: true, inviteId, status: newStatus });
};
