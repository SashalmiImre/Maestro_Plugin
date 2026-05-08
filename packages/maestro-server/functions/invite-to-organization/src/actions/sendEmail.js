// ADR 0010 — Meghívási flow redesign / W3 (e-mail kiküldés)
//
// SKELETON — nem hívja még a Resend API-t (a `RESEND_API_KEY` env var még nincs
// élesben, és a függőséget se telepítettük). A struktúra implementáció-kész:
// a Stitch merge utáni W3 fázisban a `dependencies.resend` package.json-be kerül,
// és az alábbi `// TODO(W3 live):` jelölésű blokkok aktiválhatóak.
//
// Felelősségek:
//   1. Single invite e-mail kiküldés Resend SDK-n át (`send_invite_email`).
//   2. Multi-invite batch (`send_invite_email_batch`) — a frontend-ből jövő
//      max 20 e-mail listát Promise.all 10-es csomagokban dolgozza fel.
//   3. Template rendering (`templates/invite-email.html` + `.txt` placeholder
//      helyettesítés).
//   4. Invite rekord `lastDeliveryStatus`, `sendCount`, `lastSentAt`,
//      `lastDeliveryError` mezők frissítése a kiküldés eredménye szerint.
//
// Bounce/delivery webhook NEM ide tartozik — külön CF function (`resend-webhook`).

const fs = require('fs');
const path = require('path');

// TODO(W3 live): const { Resend } = require('resend');

const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'templates');
const HTML_TEMPLATE = fs.readFileSync(path.join(TEMPLATE_DIR, 'invite-email.html'), 'utf-8');
const TEXT_TEMPLATE = fs.readFileSync(path.join(TEMPLATE_DIR, 'invite-email.txt'), 'utf-8');

const FROM_ADDRESS = 'Maestro <noreply@maestro.emago.hu>';
const REPLY_TO = null; // opcionálisan beállítható, ha admin közvetlen választ akar

// Magyar role címke (CF szerveren generálódik, hogy az e-mail nyelvi
// renderelés ne kerüljön kliens-oldalra).
function roleLabelHu(role) {
    if (role === 'admin') return 'Admin';
    if (role === 'member') return 'Tag';
    return role;
}

function formatDateHu(isoString) {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    // "2026. 05. 15." formátum (locale-független, hogy a CF runtime-tól ne függjön)
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}. ${mm}. ${dd}.`;
}

/**
 * Egyszerű handlebars-szerű placeholder-csere. Direkt nem viszünk be
 * teljes templating engine-t (handlebars, mustache) — ennyire egyszerű
 * a sablonunk, és minden új dep növeli a CF cold start időt.
 *
 * Támogatott:
 *   {{key}}                   — sima csere
 *   {{#if customMessage}} ... {{/if}}  — feltételes blokk (egyszintű, csak ha truthy)
 *
 * NEM támogatott (szándékosan): nested if, loops, partials, escaping.
 * A placeholderek értéke szerver-oldali — nincs XSS-vektor.
 */
function renderTemplate(template, vars) {
    let out = template;

    // Először a #if blokkok feldolgozása (mert a sima csere később törölné a {{#if}}-t)
    out = out.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) => {
        return vars[key] ? body : '';
    });

    // HTML kommentek között lévő {{#if}}/{{/if}} jelölők eltakarítása (a HTML
    // template kommentjében hagytunk magyarázó {{#if customMessage}}-t — ezt
    // is kitisztítjuk, hogy ne kerüljön az e-mailbe.)
    out = out.replace(/<!--\s*\{\{#if \w+\}\}\s*-->/g, '');
    out = out.replace(/<!--\s*\{\{\/if\}\}\s*-->/g, '');

    // Sima placeholder-csere
    out = out.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (vars[key] === undefined || vars[key] === null) return '';
        return String(vars[key]);
    });

    return out;
}

/**
 * Egy meghívóhoz tartozó render+küldés.
 * @param {Object} ctx — CF context (databases, env, log, error, sdk)
 * @param {Object} invite — invite document
 * @param {Object} options — { organizationName, inviterName, inviterEmail, customMessage, dashboardUrl }
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendOneInviteEmail(ctx, invite, options) {
    const { databases, env, log, error } = ctx;
    const { organizationName, inviterName, inviterEmail, customMessage, dashboardUrl } = options;

    const inviteLink = `${dashboardUrl}/invite?token=${invite.token}`;
    const expiresAtDate = new Date(invite.expiresAt);
    const now = Date.now();
    const expiryDays = Math.max(1, Math.round((expiresAtDate.getTime() - now) / (1000 * 60 * 60 * 24)));

    const vars = {
        organizationName,
        inviterName: inviterName || 'A szervezet adminisztrátora',
        inviterEmail: inviterEmail || '',
        role: roleLabelHu(invite.role || 'member'),
        customMessage: customMessage || '',
        inviteLink,
        expiresAtFormatted: formatDateHu(invite.expiresAt),
        expiryDays
    };

    const html = renderTemplate(HTML_TEMPLATE, vars);
    const text = renderTemplate(TEXT_TEMPLATE, vars);

    const subject = `Meghívást kaptál a(z) ${organizationName} szervezetbe — Maestro`;

    // TODO(W3 live): aktiválás után az alábbi blokk élesedik
    /*
    const resend = new Resend(env.resendApiKey);
    try {
        const result = await resend.emails.send({
            from: FROM_ADDRESS,
            to: invite.email,
            subject,
            html,
            text,
            // Resend metadata — bounce-webhook payloadban visszakapjuk
            tags: [
                { name: 'invite_id', value: invite.$id },
                { name: 'organization_id', value: invite.organizationId }
            ]
        });

        await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
            lastDeliveryStatus: 'sent',
            sendCount: (invite.sendCount || 0) + 1,
            lastSentAt: new Date().toISOString(),
            lastDeliveryError: null
        });

        log(`[SendEmail] OK invite=${invite.$id} email=${invite.email} resend_id=${result.data?.id}`);
        return { success: true };
    } catch (err) {
        const errMsg = err?.message || 'unknown_error';
        await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
            lastDeliveryStatus: 'failed',
            sendCount: (invite.sendCount || 0) + 1,
            lastSentAt: new Date().toISOString(),
            lastDeliveryError: errMsg.substring(0, 512)
        });
        error(`[SendEmail] FAILED invite=${invite.$id} email=${invite.email} err=${errMsg}`);
        return { success: false, error: errMsg };
    }
    */

    // SKELETON STUB — visszaadja hogy a struktúra működik, de nem küld semmit
    log(`[SendEmail] SKELETON — would send to=${invite.email} subject="${subject}" htmlBytes=${html.length}`);
    return { success: true, skeleton: true };
}

/**
 * ACTION='send_invite_email' — egyetlen meghívóhoz e-mail küldés.
 * (A `createInvite` action-ből hívható, vagy önállóan is — pl. resend gomb.)
 */
async function sendInviteEmail(ctx) {
    const { databases, env, payload, res, fail, sdk, log } = ctx;
    const { inviteId } = payload;

    if (!inviteId) {
        return fail(res, 400, 'missing_fields', { required: ['inviteId'] });
    }

    let invite;
    try {
        invite = await databases.getDocument(env.databaseId, env.invitesCollectionId, inviteId);
    } catch (err) {
        return fail(res, 404, 'invite_not_found');
    }

    // Org + inviter denormalizációhoz — ezeket a CF saját maga szedi össze, hogy
    // a frontend ne tudjon manipulálni az e-mail tartalmán.
    let organizationName = 'a szervezeted';
    try {
        const org = await databases.getDocument(env.databaseId, env.organizationsCollectionId, invite.organizationId);
        organizationName = org.name || organizationName;
    } catch (err) {
        log(`[SendEmail] org lookup hiba (non-blocking): ${err.message}`);
    }

    let inviterName = null;
    let inviterEmail = null;
    if (invite.invitedByUserId) {
        try {
            const inviter = await ctx.usersApi.get(invite.invitedByUserId);
            inviterName = inviter.name || null;
            inviterEmail = inviter.email || null;
        } catch (err) {
            log(`[SendEmail] inviter lookup hiba (non-blocking): ${err.message}`);
        }
    }

    const result = await sendOneInviteEmail(ctx, invite, {
        organizationName,
        inviterName,
        inviterEmail,
        customMessage: invite.customMessage || '',
        dashboardUrl: env.dashboardUrl
    });

    if (!result.success) {
        return fail(res, 502, 'email_send_failed', { error: result.error });
    }

    return res.json({
        success: true,
        action: 'sent',
        inviteId: invite.$id,
        skeleton: result.skeleton || false
    });
}

/**
 * ACTION='send_invite_email_batch' — több meghívóhoz párhuzamosan kiküldés.
 * Promise.all 10-es csomagokban hívja a `sendOneInviteEmail`-t — frontend
 * max 20 e-mail-t küldhet egy modalból (ADR 0010 W2).
 */
async function sendInviteEmailBatch(ctx) {
    const { databases, env, payload, res, fail, log } = ctx;
    const { inviteIds } = payload;

    if (!Array.isArray(inviteIds) || inviteIds.length === 0) {
        return fail(res, 400, 'missing_fields', { required: ['inviteIds[]'] });
    }
    if (inviteIds.length > 20) {
        return fail(res, 400, 'batch_too_large', { max: 20, given: inviteIds.length });
    }

    // Invite-ok lekérése + dedup org/inviter cache (több invite ugyanahhoz az
    // org-hoz / ugyanattól az inviter-tol — egyetlen lookup elég).
    const invites = [];
    const orgCache = new Map();
    const inviterCache = new Map();

    for (const id of inviteIds) {
        try {
            const inv = await databases.getDocument(env.databaseId, env.invitesCollectionId, id);
            invites.push(inv);
        } catch (err) {
            log(`[SendBatch] invite ${id} not found, skip`);
        }
    }

    async function fetchOrg(orgId) {
        if (orgCache.has(orgId)) return orgCache.get(orgId);
        try {
            const org = await databases.getDocument(env.databaseId, env.organizationsCollectionId, orgId);
            orgCache.set(orgId, org);
            return org;
        } catch {
            orgCache.set(orgId, null);
            return null;
        }
    }
    async function fetchInviter(uid) {
        if (!uid) return null;
        if (inviterCache.has(uid)) return inviterCache.get(uid);
        try {
            const u = await ctx.usersApi.get(uid);
            inviterCache.set(uid, u);
            return u;
        } catch {
            inviterCache.set(uid, null);
            return null;
        }
    }

    // 10-es batchekben Promise.all
    const results = [];
    const BATCH_SIZE = 10;
    for (let i = 0; i < invites.length; i += BATCH_SIZE) {
        const slice = invites.slice(i, i + BATCH_SIZE);
        const sliceResults = await Promise.all(slice.map(async (invite) => {
            const [org, inviter] = await Promise.all([
                fetchOrg(invite.organizationId),
                fetchInviter(invite.invitedByUserId)
            ]);
            const r = await sendOneInviteEmail(ctx, invite, {
                organizationName: org?.name || 'a szervezeted',
                inviterName: inviter?.name || null,
                inviterEmail: inviter?.email || null,
                customMessage: invite.customMessage || '',
                dashboardUrl: env.dashboardUrl
            });
            return { inviteId: invite.$id, email: invite.email, ...r };
        }));
        results.push(...sliceResults);
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    log(`[SendBatch] ${successCount}/${results.length} sikeres (${failCount} hiba)`);

    return res.json({
        success: true,
        action: 'batch_sent',
        total: results.length,
        successCount,
        failCount,
        results
    });
}

module.exports = {
    sendInviteEmail,
    sendInviteEmailBatch,
    // Helper export-ok teszteléshez:
    _renderTemplate: renderTemplate,
    _formatDateHu: formatDateHu,
    _roleLabelHu: roleLabelHu
};
