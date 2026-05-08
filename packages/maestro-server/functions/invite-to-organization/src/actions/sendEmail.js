// ADR 0010 — Meghívási flow redesign / W3 (e-mail kiküldés)
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
//
// **Live mód**: `env.resendApiKey` jelen → Resend SDK hívás éles.
// **Skeleton fallback**: env hiányzik → log warn, invite-ot `lastDeliveryStatus='pending'`-en
//   hagyja, success-szel tér vissza (admin kézzel másolhatja a linket).

const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const permissions = require('../permissions.js');

// MAJOR 6 (Codex review 2026-05-08) — backend cooldown a manuális resend
// gombra. 60 másodpercen belül ugyanarra az invite-ra nem küldünk újra.
const RESEND_COOLDOWN_MS = 60 * 1000;

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

    // BLOCKER 3 (Codex review 2026-05-08) — DASHBOARD_URL hiánya esetén
    // hard-fail: ne küldjünk olyan e-mailt, amelyben a link relatív
    // (``/invite?token=…``) — a kattintás visszairányítaná a Resend domain-re.
    if (!dashboardUrl || !/^https?:\/\//i.test(dashboardUrl)) {
        const errMsg = 'invalid_dashboard_url';
        error(`[SendEmail] DASHBOARD_URL hiányzik vagy érvénytelen ("${dashboardUrl}") — invite=${invite.$id}`);
        try {
            await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
                lastDeliveryStatus: 'failed',
                lastDeliveryError: errMsg,
                lastSentAt: new Date().toISOString()
            });
        } catch (updateErr) {
            error(`[SendEmail] status update failed (DASHBOARD_URL invalid): ${updateErr.message}`);
        }
        return { success: false, error: errMsg };
    }

    const inviteLink = `${dashboardUrl.replace(/\/$/, '')}/invite?token=${invite.token}`;
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

    // Skeleton fallback: ha nincs API kulcs, NE küldjünk semmit (admin
    // kézzel másolhatja a linket a UsersTab pending invites listán).
    if (!env.resendApiKey) {
        log(`[SendEmail] SKELETON (RESEND_API_KEY hiányzik) — to=${invite.email} subject="${subject}"`);
        return { success: true, skeleton: true };
    }

    // BLOCKER 2 (Codex review 2026-05-08) — két külön try-blokk:
    //   (1) Resend SDK hívás — ha hibázik, a `failed` status szerinti írás
    //       jelzi a UI-nak.
    //   (2) DB bookkeeping — sikeres provider call után KÜLÖN try, hogy
    //       egy update-hiba NE minősítsen tévesen `failed`-re egy ténylegesen
    //       kiküldött e-mailt (ld. duplikált resend és félrevezető UI).
    const resend = new Resend(env.resendApiKey);
    let resendId = null;
    try {
        const result = await resend.emails.send({
            from: FROM_ADDRESS,
            to: invite.email,
            subject,
            html,
            text,
            tags: [
                { name: 'invite_id', value: invite.$id },
                { name: 'organization_id', value: invite.organizationId }
            ]
        });
        resendId = result?.data?.id || null;
        log(`[SendEmail] Resend OK invite=${invite.$id} email=${invite.email} resend_id=${resendId}`);
    } catch (err) {
        const errMsg = err?.message || 'unknown_error';
        // Provider hiba — bookkeeping külön try, hogy ne dupla-eskedjen
        try {
            await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
                lastDeliveryStatus: 'failed',
                sendCount: (invite.sendCount || 0) + 1,
                lastSentAt: new Date().toISOString(),
                lastDeliveryError: errMsg.substring(0, 512)
            });
        } catch (updateErr) {
            error(`[SendEmail] status update failed (after Resend error): ${updateErr.message}`);
        }
        error(`[SendEmail] FAILED invite=${invite.$id} email=${invite.email} err=${errMsg}`);
        return { success: false, error: errMsg };
    }

    // (2) Bookkeeping — sikeres küldés után. Ha ez is bukik, az e-mail
    // AKKOR IS sikeres, csak a UI nem mutatja a "Kiküldve" badge-et.
    // Ezt NEM minősítjük failed-re (ld. BLOCKER 2).
    try {
        await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
            lastDeliveryStatus: 'sent',
            sendCount: (invite.sendCount || 0) + 1,
            lastSentAt: new Date().toISOString(),
            lastDeliveryError: null
        });
    } catch (updateErr) {
        // A mail már elment — log-warning, de visszaadjuk success: true-t.
        // Az adminnak max nem mutatja a UI a "Kiküldve" badge-et, de
        // duplikált resend nem indul.
        error(`[SendEmail] post-send status update failed (e-mail kiment ${resendId}): ${updateErr.message}`);
    }
    return { success: true, resendId };
}

/**
 * ACTION='send_invite_email' — egyetlen meghívóhoz e-mail újraküldés
 * (admin "Újraküldés" gomb). NEM auto-flow — a `createInvite` saját
 * maga hívja a `sendOneInviteEmail` belső helpert, NEM ezt az action-t.
 *
 * Codex review 2026-05-08:
 *   BLOCKER 1: `org.member.invite` permission check + invite status / expiry guard.
 *   MAJOR 6: 60s cooldown a `lastSentAt` alapján.
 */
async function sendInviteEmail(ctx) {
    const { databases, env, callerId, callerUser, payload, res, fail, log, permissionEnv, permissionContext } = ctx;
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

    // BLOCKER 1 — `org.member.invite` permission guard. A frontend
    // `resendInviteEmail` az invite-ot tartó org-on belül futtatja, de a
    // backend nem feltételezhet jogosultságot — minden caller-t ellenőrzünk.
    const allowed = await permissions.userHasOrgPermission(
        databases,
        permissionEnv,
        callerUser,
        'org.member.invite',
        invite.organizationId,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        log(`[SendEmail] Caller ${callerId} — nincs org.member.invite jogosultság az org ${invite.organizationId}-ra`);
        return fail(res, 403, 'insufficient_permission', {
            slug: 'org.member.invite',
            scope: 'org'
        });
    }

    // BLOCKER 1 (folytatás) — csak `pending` és nem lejárt invite mehet
    // resend-ágon. Lejárt / accepted / declined / expired esetén a UI-nak
    // jeleznie kell hogy a meghívó már nem aktív.
    if (invite.status !== 'pending') {
        return fail(res, 409, 'invite_not_pending', { status: invite.status });
    }
    if (new Date(invite.expiresAt) < new Date()) {
        return fail(res, 410, 'invite_expired');
    }

    // MAJOR 6 — cooldown a manuális resend gombra (60s).
    if (invite.lastSentAt) {
        const elapsed = Date.now() - new Date(invite.lastSentAt).getTime();
        if (elapsed < RESEND_COOLDOWN_MS) {
            const retryInSec = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
            return fail(res, 429, 'resend_cooldown', { retryAfterSec: retryInSec });
        }
    }

    // Org + inviter denormalizációhoz — ezeket a CF saját maga szedi össze.
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

// `sendInviteEmailBatch` action TÖRÖLVE (Codex review 2026-05-08 BLOCKER 1):
// authz nélkül futott + ki nem használt. A multi-invite flow a
// `actions/invites.js` `createBatchInvites` action-ön át megy, ami belsőleg
// minden createolt invite-ra hívja a `sendOneInviteEmail`-t — annak az org-
// szintű permission-check már megtörtént a hívóban.

module.exports = {
    sendInviteEmail,
    // ADR 0010 W3 — actions/invites.js auto-send flow használja:
    sendOneInviteEmail,
    // 2026-05-09 (E2E smoke #2 fix): a createBatchInvites idempotens
    // ágán is meghívjuk a sendOneInviteEmail-t, de a 60s cooldown-t
    // ott is alkalmaznunk kell. A konstans single-source-on van itt.
    RESEND_COOLDOWN_MS,
    // Helper export-ok teszteléshez:
    _renderTemplate: renderTemplate,
    _formatDateHu: formatDateHu,
    _roleLabelHu: roleLabelHu
};
