// B.0.3.c (2026-05-04) — Invite flow action-ok kiszervezve külön modulba.
// Tartalmazza: create (admin meghívó küldés), accept (invitee elfogadás),
// list_my_invites (#41), decline_invite (#41). A `leave_organization`
// SZÁNDÉKOSAN nem itt — `actions/offices.js` (B.0.3.g) fogja tartalmazni,
// mert minden membership-cleanup logika ott él egy helyen.

const crypto = require('crypto');
const {
    EMAIL_REGEX,
    INVITE_VALIDITY_DAYS,
    INVITE_VALIDITY_DAYS_OPTIONS,
    INVITE_VALIDITY_DAYS_DEFAULT,
    TOKEN_BYTES
} = require('../helpers/util.js');
const {
    buildOrgAclPerms,
    buildOrgTeamId,
    ensureTeamMembership
} = require('../teamHelpers.js');
const permissions = require('../permissions.js');
// ADR 0010 W2/W3 — meghívási flow redesign:
//   - sendOneInviteEmail: auto-send a sikeres createInvite után (best-effort)
//   - checkRateLimit: brute-force védelem az acceptInvite-on (IP-rate-limit)
const { sendOneInviteEmail, RESEND_COOLDOWN_MS } = require('./sendEmail.js');
const { checkRateLimit } = require('../helpers/rateLimit.js');

const MAX_BATCH_INVITES = 20;
const MAX_CUSTOM_MESSAGE_LENGTH = 500;

/**
 * D.3 (2026-05-09) — invite audit-trail helper.
 *
 * A `acceptInvite` (3 helyen: main / idempotens / race-winner), `declineInvite`
 * és `expireInvite` (opportunista expire) destruktív kilépési ágain a
 * helper egy `organizationInviteHistory` doc-ot ír (snapshot-at-archive).
 * Ezzel rekonstruálható: ki hívta meg X-et, mikor, milyen role-lal, mi lett
 * a végső sors (accepted/declined/expired).
 *
 * GDPR (Codex tervi review 2026-05-09): a `token` raw értéket NEM tároljuk —
 * SHA-256 hash kerül a `tokenHash` mezőbe. Ez elég incident-korrelációhoz
 * (egy konkrét tokenes report → hash → lookup), de NEM lehet újrahasznosítani.
 *
 * Best-effort: ha az `organizationInviteHistory` collection nincs beállítva
 * (env var hiányzik) vagy a write bukik → loggolunk, nem blokkoljuk a
 * destruktív flow-t. A history rekord elveszhet, de a fő lifecycle (accept /
 * decline / expire) megy tovább.
 *
 * @param {Object} ctx - CF ctx
 * @param {Object} invite - a teljes invite doc (a destrukció ELŐTT)
 * @param {'accepted'|'declined'|'expired'} finalStatus
 * @param {string} [finalReason] - opcionális magyarázat (pl. cleanup ok)
 * @param {string} [finalUserId] - acceptedByUserId / declinedByUserId
 */
async function _archiveInvite(ctx, invite, finalStatus, finalReason, finalUserId) {
    const { databases, env, log, error } = ctx;
    const inviteHistoryCollectionId = env.organizationInviteHistoryCollectionId;
    if (!inviteHistoryCollectionId) {
        log(`[ArchiveInvite] SKIP — ORGANIZATION_INVITE_HISTORY_COLLECTION_ID env var nincs beállítva (invite=${invite.$id})`);
        return;
    }

    try {
        const tokenHash = invite.token
            ? crypto.createHash('sha256').update(invite.token).digest('hex')
            : null;

        const finalAt = new Date().toISOString();
        const payload = {
            organizationId: invite.organizationId,
            email: invite.email,
            role: invite.role,
            tokenHash, // SHA-256, NEM raw token
            expiresAt: invite.expiresAt,
            customMessage: invite.customMessage || null,
            invitedByUserId: invite.invitedByUserId || null,
            invitedByUserName: invite.invitedByUserName || null,
            invitedByUserEmail: invite.invitedByUserEmail || null,
            invitedAt: invite.$createdAt,
            sendCount: invite.sendCount || 0,
            lastSentAt: invite.lastSentAt || null,
            lastDeliveryStatus: invite.lastDeliveryStatus || null,
            finalStatus,
            finalReason: finalReason || null,
            finalAt
        };
        // Codex simplify Q1 (2026-05-09): per-finalStatus mező direkt
        // assign — 3 ternary spread helyett 1 if-cascade.
        if (finalStatus === 'accepted') payload.acceptedByUserId = finalUserId || null;
        else if (finalStatus === 'declined') payload.declinedByUserId = finalUserId || null;
        else if (finalStatus === 'expired') payload.expiredAt = finalAt;

        // Codex MINOR fix (2026-05-09) — deterministic doc ID a retry-idempotenciához.
        // A korábbi `ID.unique()` minden hívásra új ID-t adott, ami a delete bukás
        // utáni retry-on duplikált history rekordokat eredményezhetett. Most az
        // `${invite.$id}__${finalStatus}` kompozit ID — egy invite egy
        // finalStatus-szal csak EGYSZER kerül a history-be. Egy második (idempotens)
        // hívás `document_already_exists` 409-cel jön → log skip.
        //
        // Codex adversarial review fix (2026-05-09 MINOR): Appwrite custom doc ID
        // limit 36 char. Tipikus invite.$id `ID.unique()` ~20 char, `__accepted`
        // 10 char = 30 char OK; DE egy custom (Phase 2) hosszabb invite ID
        // overflow-t okozhatna. SHA-1 hash fallback ha a kompozit > 36 char —
        // így a deterministic ID megőrződik, és a `(inviteId + finalStatus)`
        // egyértelműen leképezhető. A hash-bázis hosszabb (40 char), ezért a
        // 32-re vágjuk → `inv_<32 char>` formátum.
        const compositeId = `${invite.$id}__${finalStatus}`;
        const deterministicId = compositeId.length <= 36
            ? compositeId
            : `inv_${crypto.createHash('sha1').update(compositeId).digest('hex').slice(0, 32)}`;
        try {
            await databases.createDocument(
                env.databaseId,
                inviteHistoryCollectionId,
                deterministicId,
                payload,
                buildOrgAclPerms(invite.organizationId)
            );
            log(`[ArchiveInvite] invite=${invite.$id} → history (finalStatus=${finalStatus})`);
        } catch (createErr) {
            if (createErr?.type === 'document_already_exists' || /already exist/i.test(createErr?.message || '')) {
                log(`[ArchiveInvite] invite=${invite.$id} history (finalStatus=${finalStatus}) — már archiválva, idempotens skip`);
                return;
            }
            throw createErr;
        }
    } catch (err) {
        error(`[ArchiveInvite] write hiba (non-blocking, invite=${invite.$id}): ${err.message}`);
    }
}

/**
 * `expiryDays` payload-mező validálása. Whitelist (1 / 3 / 7), default 7.
 * Visszaadja a validált napok számát, vagy null-t ha az érték érvénytelen.
 */
function normalizeExpiryDays(value) {
    if (value === undefined || value === null || value === '') {
        return INVITE_VALIDITY_DAYS_DEFAULT;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || !INVITE_VALIDITY_DAYS_OPTIONS.includes(num)) {
        return null;
    }
    return num;
}

/**
 * `customMessage` sanitizáció — opcionális string, max 500 karakter.
 * Visszaad: null (üres / nem string) | trimmed string. Ha túl hosszú: null + caller dönt.
 */
function normalizeCustomMessage(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_CUSTOM_MESSAGE_LENGTH) return undefined; // sentinel: too long
    return trimmed;
}

/**
 * ADR 0010 W2 — Belső core helper: egyetlen invite létrehozása.
 *
 * **NEM** ír `res.json`-t — ezt a hívó (createInvite single vagy
 * createBatchInvites) végzi. Permission check **MÁR megtörtént** a hívóban.
 *
 * Returns:
 *   { ok: true, action: 'created'|'existing', inviteId, token, expiresAt, role, email, organizationId }
 *   { ok: false, reason: string, statusCode: number, extra?: object }
 */
async function _createInviteCore(ctx, params) {
    const { databases, env, callerId, log, sdk } = ctx;
    const { organizationId, email, role, expiryDays, customMessage } = params;

    // 1) Idempotencia: létezik-e már pending invite ugyanerre az email+org párra?
    const existingPending = await databases.listDocuments(
        env.databaseId,
        env.invitesCollectionId,
        [
            sdk.Query.equal('organizationId', organizationId),
            sdk.Query.equal('email', email),
            sdk.Query.equal('status', 'pending'),
            sdk.Query.limit(1)
        ]
    );

    if (existingPending.documents.length > 0) {
        let existing = existingPending.documents[0];
        if (new Date(existing.expiresAt) > new Date()) {
            // 2026-05-09 (Codex stop-time #2 + #3 fix — customMessage durability + render fallback):
            // ha az admin új `customMessage`-et adott meg az `existing` ágon,
            // persistáljuk az invite doc-on is. Eddig csak az e-mail rendert
            // override-oltuk (241f15c), de a tárolt érték a régi maradt →
            // a `send_invite_email` action vagy a UI a régi szöveget mutatja.
            // Üres string === explicit "nincs üzenet"; null/undefined ===
            // "ne változtass". A customMessage paraméter már normalizált
            // (`normalizeCustomMessage` `null`-ozza az üres trimmed-stringet).
            //
            // A 299e0fe simplification eltávolította a `customMessageOverride`
            // propagálást a `sendOneInviteEmail`-ig, ezzel csak az
            // `updateDocument` sikere garantálta a friss render-tartalmat.
            // Codex stop-time #3 jelezte: ha az update bukik, a render
            // STALE doc-ra esik vissza → fix: a catch ágon IN-MEMORY
            // patch-eljük az `existing` objektumot, így a hívó (és
            // `_autoSendInviteEmail`) friss `customMessage`-t lát perszisztens
            // doc-update nélkül is. Persistálási drift külön TODO az audit-
            // trail collection-ben (deferred A) lesz teljesen megoldva.
            if (customMessage !== undefined && customMessage !== existing.customMessage) {
                try {
                    existing = await databases.updateDocument(
                        env.databaseId,
                        env.invitesCollectionId,
                        existing.$id,
                        { customMessage: customMessage }
                    );
                    log(`[CreateCore] Idempotens — customMessage frissítve: invite ${existing.$id}`);
                } catch (updateErr) {
                    // Non-blocking persistálás, DE in-memory patch-eljük az
                    // `existing` objektumot, hogy a render friss-re menjen.
                    log(`[CreateCore] Idempotens — customMessage update bukott (in-memory patch alkalmazva): ${updateErr.message}`);
                    existing = { ...existing, customMessage: customMessage };
                }
            }
            log(`[CreateCore] Idempotens — meglévő pending invite ${existing.$id} (${email})`);
            return {
                ok: true,
                action: 'existing',
                inviteId: existing.$id,
                token: existing.token,
                expiresAt: existing.expiresAt,
                role: existing.role,
                email: existing.email,
                organizationId,
                // 2026-05-09 (E2E smoke #2 fix): a hívó (createInvite /
                // createBatchInvites) auto-send-elhet az idempotens ágon is,
                // 60s cooldown védelemmel. Ehhez kell a teljes invite doc
                // (lastSentAt, customMessage stb.).
                invite: existing
            };
        }
        // Lejárt — frissítjük expired-re és új invite-ot hozunk létre
        await databases.updateDocument(env.databaseId, env.invitesCollectionId, existing.$id, {
            status: 'expired'
        });
        log(`[CreateCore] Lejárt invite ${existing.$id} expired-re állítva`);
        // D.3 expired audit-gap fix (Codex MAJOR 2026-05-09): a lejárt invite
        // archiválása a history-be — különben az `auto_expire_on_recreate`
        // ágon elveszne a finalStatus rekord.
        await _archiveInvite(ctx, existing, 'expired', 'auto_expire_on_recreate');
    }

    // 2) Token + expiry generálás
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();

    // 3) Invite rekord létrehozása race-védelemmel.
    //    A composite unique index `(organizationId, email, status='pending')`
    //    miatt két párhuzamos request közül egyik 409-et kap.
    let invite;
    try {
        invite = await databases.createDocument(
            env.databaseId,
            env.invitesCollectionId,
            sdk.ID.unique(),
            {
                organizationId,
                email,
                token,
                role,
                status: 'pending',
                expiresAt,
                invitedByUserId: callerId,
                customMessage: customMessage || null,
                // ADR 0010 W2 — kiküldés-status mezők. Default `pending` ↔ még nem
                // sendOlt; a sendOneInviteEmail() majd átírja `sent`/`failed`-re.
                lastDeliveryStatus: 'pending',
                sendCount: 0
            },
            buildOrgAclPerms(organizationId)
        );
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
            const raceWinner = await databases.listDocuments(
                env.databaseId,
                env.invitesCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('email', email),
                    sdk.Query.equal('status', 'pending'),
                    sdk.Query.limit(1)
                ]
            );
            if (raceWinner.documents.length > 0) {
                let existing = raceWinner.documents[0];
                // 2026-05-09 (Codex stop-time #2 + #3): customMessage durability
                // a race-winner ágon is, IN-MEMORY patch fallback-kel.
                // (Lásd a fő existing-ágon a hosszabb komment.)
                if (customMessage !== undefined && customMessage !== existing.customMessage) {
                    try {
                        existing = await databases.updateDocument(
                            env.databaseId,
                            env.invitesCollectionId,
                            existing.$id,
                            { customMessage: customMessage }
                        );
                        log(`[CreateCore] Race — customMessage frissítve: invite ${existing.$id}`);
                    } catch (updateErr) {
                        log(`[CreateCore] Race — customMessage update bukott (in-memory patch alkalmazva): ${updateErr.message}`);
                        existing = { ...existing, customMessage: customMessage };
                    }
                }
                log(`[CreateCore] Race — meglévő pending invite ${existing.$id} (${email})`);
                return {
                    ok: true,
                    action: 'existing',
                    inviteId: existing.$id,
                    token: existing.token,
                    expiresAt: existing.expiresAt,
                    role: existing.role,
                    email: existing.email,
                    organizationId,
                    invite: existing  // 2026-05-09 — auto-send-hez
                };
            }
        }
        throw err;
    }

    log(`[CreateCore] Új invite ${invite.$id} ${organizationId} → ${email} (role=${role}, expiryDays=${expiryDays})`);

    return {
        ok: true,
        action: 'created',
        inviteId: invite.$id,
        token,
        expiresAt,
        role,
        email,
        organizationId,
        invite // teljes invite doc — auto-send-hez kell
    };
}

/**
 * 2026-05-09 (E2E smoke #2 fix): cooldown-checked auto-send az idempotens
 * (action='existing') ágra. A `created` esetén lastSentAt=null → mindig megy,
 * `existing` esetén pedig csak ha a 60s cooldown letelt.
 *
 * D.5.2 (2026-05-09): a return type egységes objektum lett — `{ status, sendCount? }`.
 * A `sendCount` a `sendOneInviteEmail` post-increment értékét tükrözi (vagy a
 * meglévő `invite.sendCount`-ot cooldown / skipped ágon, hogy a frontend a
 * helyes „N. próbálkozás" badge-et tudja mutatni). Status értékek:
 *   - `'sent'`: e-mail kiment (deliveryStatus=sent)
 *   - `'failed'`: kiment-próba bukott (deliveryStatus=failed)
 *   - `'cooldown'`: cooldown alatt vagyunk, skipped (deliveryStatus=cooldown)
 *   - `'skipped'`: nincs invite doc (régi action vagy hibás return)
 *
 * 2026-05-09 (iteration-guardian roast #6 simplification): a
 * `customMessageOverride` propagáció REDUNDÁNS — a `_createInviteCore`
 * `existing` ágon az `updateDocument({customMessage})` (44c7753 durability
 * fix) frissíti a doc-ot, és a friss `result.invite.customMessage` már a
 * legújabb értéket tartja. A render azt olvassa.
 */
async function _maybeAutoSendInviteEmail(ctx, result, organizationName, inviterName, inviterEmail) {
    if (!result.invite) return { status: 'skipped' };
    if (result.action === 'existing' && result.invite.lastSentAt) {
        const elapsed = Date.now() - new Date(result.invite.lastSentAt).getTime();
        if (elapsed < RESEND_COOLDOWN_MS) {
            ctx.log?.(`[AutoSend] Cooldown — invite ${result.invite.$id} (${result.invite.email}), letelt: ${Math.ceil((RESEND_COOLDOWN_MS - elapsed)/1000)}s múlva`);
            return { status: 'cooldown', sendCount: result.invite.sendCount || 0 };
        }
    }
    const sendResult = await _autoSendInviteEmail(ctx, result.invite, organizationName, inviterName, inviterEmail);
    return {
        status: sendResult.success ? 'sent' : 'failed',
        ...(typeof sendResult.sendCount === 'number' ? { sendCount: sendResult.sendCount } : {})
    };
}

/**
 * Auto-send wrapper: best-effort e-mail küldés a frissen létrehozott invite-ra.
 * Hibát NEM propagál — a sendOneInviteEmail saját maga frissíti a `lastDeliveryStatus`-t
 * `failed`-re és tárolja az error message-et.
 *
 * @returns {Promise<{success: boolean, error?: string, skeleton?: boolean}>}
 */
async function _autoSendInviteEmail(ctx, inviteDoc, organizationName, inviterName, inviterEmail) {
    try {
        return await sendOneInviteEmail(ctx, inviteDoc, {
            organizationName: organizationName || 'a szervezeted',
            inviterName,
            inviterEmail,
            // 2026-05-09 (iteration-guardian roast #6 simplification): a
            // friss invite-doc tartja a friss `customMessage`-t (a
            // `_createInviteCore` `existing` ágon updateDocument-tel
            // frissítettük 44c7753-ban). Nem kell külön override.
            customMessage: inviteDoc.customMessage || '',
            dashboardUrl: ctx.env.dashboardUrl
        });
    } catch (err) {
        ctx.error?.(`[AutoSend] sendOneInviteEmail dobott (non-blocking): ${err.message}`);
        return { success: false, error: err.message };
    }
}

/**
 * ACTION='create' — admin meghívó küldés (single, ADR 0010 W2/W3).
 *
 * Bővítések 2026-05-08 ADR 0010-hez:
 *   - `expiryDays` payload (1 / 3 / 7, default 7)
 *   - `customMessage` payload (max 500 karakter)
 *   - **Auto-send**: sikeres invite után best-effort sendOneInviteEmail() hívás
 *
 * Permission: `org.member.invite` org-scope guard (owner+admin).
 */
async function createInvite(ctx) {
    const { databases, env, callerId, callerUser, payload, log, res, fail, permissionEnv, permissionContext, usersApi } = ctx;
    const { organizationId } = payload;
    const email = typeof payload.email === 'string'
        ? payload.email.trim().toLowerCase()
        : payload.email;
    const role = payload.role || 'member';

    if (!organizationId || !email) {
        return fail(res, 400, 'missing_fields', { required: ['organizationId', 'email'] });
    }
    if (!EMAIL_REGEX.test(email)) {
        return fail(res, 400, 'invalid_email');
    }
    if (role !== 'admin' && role !== 'member') {
        return fail(res, 400, 'invalid_role', { allowed: ['admin', 'member'] });
    }

    const expiryDays = normalizeExpiryDays(payload.expiryDays);
    if (expiryDays === null) {
        return fail(res, 400, 'invalid_expiry_days', { allowed: INVITE_VALIDITY_DAYS_OPTIONS });
    }
    const customMessage = normalizeCustomMessage(payload.customMessage ?? payload.message);
    if (customMessage === undefined) {
        return fail(res, 400, 'message_too_long', { max: MAX_CUSTOM_MESSAGE_LENGTH });
    }

    // Permission guard: `org.member.invite` (owner + admin)
    const allowed = await permissions.userHasOrgPermission(
        databases,
        permissionEnv,
        callerUser,
        'org.member.invite',
        organizationId,
        permissionContext.orgRoleByOrg,
        permissionContext.orgStatusByOrg // D.2.4 orphan-guard cache
    );
    if (!allowed) {
        log(`[Create] Caller ${callerId} — nincs org.member.invite jogosultság az org ${organizationId}-ra`);
        return fail(res, 403, 'insufficient_permission', {
            slug: 'org.member.invite',
            scope: 'org'
        });
    }

    // Core create
    const result = await _createInviteCore(ctx, {
        organizationId, email, role, expiryDays, customMessage
    });

    // Auto-send: 2026-05-09 E2E smoke #2 fix — az 'existing' ágon is auto-send,
    // a `_maybeAutoSendInviteEmail` 60s cooldown-nal védi a spam ellen. A user
    // mentális modellje: „rákattintok a Send-re, megy az e-mail" — a korábbi
    // semmittevés idempotens ágon zavart okozott (lásd execution log
    // 21:58:45-kor: `[CreateCore] Idempotens` után NINCS [SendEmail] log).
    // D.5.2 — `_maybeAutoSendInviteEmail` mostantól `{ status, sendCount? }`-ot ad.
    let autoSend = null;
    if (result.invite) {
        // Org és inviter denormalizáció az e-mailhez
        let organizationName = 'a szervezeted';
        let inviterName = null;
        let inviterEmail = null;
        try {
            const org = await databases.getDocument(env.databaseId, env.organizationsCollectionId, organizationId);
            organizationName = org.name || organizationName;
        } catch (err) {
            log(`[Create] org lookup hiba (non-blocking): ${err.message}`);
        }
        if (callerUser) {
            inviterName = callerUser.name || null;
            inviterEmail = callerUser.email || null;
        } else {
            try {
                const inviter = await usersApi.get(callerId);
                inviterName = inviter.name || null;
                inviterEmail = inviter.email || null;
            } catch (err) {
                log(`[Create] inviter lookup hiba (non-blocking): ${err.message}`);
            }
        }
        autoSend = await _maybeAutoSendInviteEmail(ctx, result, organizationName, inviterName, inviterEmail);
    }

    return res.json({
        success: true,
        action: result.action,
        inviteId: result.inviteId,
        token: result.token,
        expiresAt: result.expiresAt,
        role: result.role,
        email: result.email,
        organizationId: result.organizationId,
        ...(autoSend?.status ? { deliveryStatus: autoSend.status } : {}),
        ...(typeof autoSend?.sendCount === 'number' ? { sendCount: autoSend.sendCount } : {})
    });
}

/**
 * ACTION='create_batch_invites' — multi-invite (max 20, ADR 0010 W2).
 *
 * Frontend egy modalon belül több e-mailt küldhet egyszerre. A CF iterál
 * 10-es Promise.all batchekben (rate-limit barát, sub-second), és visszaad
 * egy per-email status listát.
 *
 * Permission check egyszer történik az org-ra (org.member.invite).
 */
async function createBatchInvites(ctx) {
    const { databases, env, callerId, callerUser, payload, log, res, fail, permissionEnv, permissionContext, usersApi } = ctx;
    const { organizationId, emails } = payload;
    const role = payload.role || 'member';

    if (!organizationId || !Array.isArray(emails) || emails.length === 0) {
        return fail(res, 400, 'missing_fields', { required: ['organizationId', 'emails[]'] });
    }
    if (emails.length > MAX_BATCH_INVITES) {
        return fail(res, 400, 'batch_too_large', { max: MAX_BATCH_INVITES, given: emails.length });
    }
    if (role !== 'admin' && role !== 'member') {
        return fail(res, 400, 'invalid_role', { allowed: ['admin', 'member'] });
    }

    const expiryDays = normalizeExpiryDays(payload.expiryDays);
    if (expiryDays === null) {
        return fail(res, 400, 'invalid_expiry_days', { allowed: INVITE_VALIDITY_DAYS_OPTIONS });
    }
    const customMessage = normalizeCustomMessage(payload.customMessage ?? payload.message);
    if (customMessage === undefined) {
        return fail(res, 400, 'message_too_long', { max: MAX_CUSTOM_MESSAGE_LENGTH });
    }

    // Permission guard egyszer
    const allowed = await permissions.userHasOrgPermission(
        databases,
        permissionEnv,
        callerUser,
        'org.member.invite',
        organizationId,
        permissionContext.orgRoleByOrg,
        permissionContext.orgStatusByOrg // D.2.4 orphan-guard cache
    );
    if (!allowed) {
        log(`[CreateBatch] Caller ${callerId} — nincs org.member.invite jogosultság az org ${organizationId}-ra`);
        return fail(res, 403, 'insufficient_permission', {
            slug: 'org.member.invite',
            scope: 'org'
        });
    }

    // Org + inviter cache (egy fetch per batch — lookup költség minimalizálás)
    let organizationName = 'a szervezeted';
    let inviterName = null;
    let inviterEmail = null;
    try {
        const org = await databases.getDocument(env.databaseId, env.organizationsCollectionId, organizationId);
        organizationName = org.name || organizationName;
    } catch (err) {
        log(`[CreateBatch] org lookup hiba (non-blocking): ${err.message}`);
    }
    if (callerUser) {
        inviterName = callerUser.name || null;
        inviterEmail = callerUser.email || null;
    } else {
        try {
            const inviter = await usersApi.get(callerId);
            inviterName = inviter.name || null;
            inviterEmail = inviter.email || null;
        } catch (err) {
            log(`[CreateBatch] inviter lookup hiba (non-blocking): ${err.message}`);
        }
    }

    // Normalize + dedup emaileket
    const normalizedEmails = [];
    const seen = new Set();
    for (const raw of emails) {
        if (typeof raw !== 'string') continue;
        const normalized = raw.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        normalizedEmails.push(normalized);
    }

    // 10-es Promise.all batchekben
    const BATCH_SIZE = 10;
    const results = [];
    for (let i = 0; i < normalizedEmails.length; i += BATCH_SIZE) {
        const slice = normalizedEmails.slice(i, i + BATCH_SIZE);
        const sliceResults = await Promise.all(slice.map(async (email) => {
            if (!EMAIL_REGEX.test(email)) {
                return { email, status: 'error', reason: 'invalid_email' };
            }
            try {
                const result = await _createInviteCore(ctx, {
                    organizationId, email, role, expiryDays, customMessage
                });
                // 2026-05-09 E2E smoke #2 fix — `existing` action-ön is auto-send,
                // 60s cooldown-nal. (Lásd `_maybeAutoSendInviteEmail`.)
                // 2026-05-09 simplification (iteration-guardian #6): a fresh
                // invite-doc már tartja az új customMessage-t, nem kell override.
                // D.5.2 — autoSend mostantól `{ status, sendCount? }` objektum.
                const autoSend = await _maybeAutoSendInviteEmail(ctx, result, organizationName, inviterName, inviterEmail);
                return {
                    email,
                    status: 'ok',
                    action: result.action,
                    inviteId: result.inviteId,
                    expiresAt: result.expiresAt,
                    ...(autoSend?.status && autoSend.status !== 'skipped' ? { deliveryStatus: autoSend.status } : {}),
                    ...(typeof autoSend?.sendCount === 'number' ? { sendCount: autoSend.sendCount } : {})
                };
            } catch (err) {
                ctx.error?.(`[CreateBatch] ${email} hiba: ${err.message}`);
                return { email, status: 'error', reason: err.message || 'create_failed' };
            }
        }));
        results.push(...sliceResults);
    }

    const successCount = results.filter(r => r.status === 'ok').length;
    const failCount = results.length - successCount;

    log(`[CreateBatch] org=${organizationId} ${successCount}/${results.length} sikeres (${failCount} hiba)`);

    return res.json({
        success: true,
        action: 'batch_created',
        total: results.length,
        successCount,
        failCount,
        results
    });
}

/**
 * ACTION='accept' — invitee oldal.
 *
 * 1. Token lookup → 404 `invite_not_found`.
 * 2. Status check → 410 `invite_not_pending`.
 * 3. Expiry check → auto-expire + 410 `invite_expired`.
 * 4. E-mail match (`usersApi.get(callerId)` → caller.email vs invite.email).
 * 5. Membership létrehozás API key-jel (race-védelmes idempotens flow).
 * 6. Invitee az org team-be (best-effort).
 * 7. Invite TÖRLÉS (Codex review 2026-05-08 BLOCKER 2 fix — a `pending →
 *    accepted` updateDocument a `(organizationId, email, status)` unique
 *    indexen ütközött, ezért a membership létrehozása után az invite
 *    egyszerűen disposable, deleteDocument-tel takarítjuk).
 */
async function acceptInvite(ctx) {
    const { databases, env, callerId, payload, log, error, res, fail, sdk, usersApi, teamsApi } = ctx;
    const { token } = payload;
    if (!token) {
        return fail(res, 400, 'missing_fields', { required: ['token'] });
    }

    // ADR 0010 W2 — IP-rate-limit (5 attempt / 15 perc, 1h block).
    // Token-szivárgás esetén egy támadó tetszőleges tokent próbálhat
    // guess-elni — a 256-bit token bruteforce-olhatatlan, de DDoS-szerű
    // próbálkozást így is fogjuk vissza. Ha nincs X-Forwarded-For
    // header (pl. közvetlen Appwrite hívás), a checkRateLimit null-t
    // ad — best-effort átengedés.
    const blockedUntil = await checkRateLimit(ctx, 'accept_invite');
    if (blockedUntil) {
        return fail(res, 429, 'rate_limited', { retryAfter: blockedUntil });
    }

    // 1. Token lookup
    const inviteResult = await databases.listDocuments(
        env.databaseId,
        env.invitesCollectionId,
        [sdk.Query.equal('token', token), sdk.Query.limit(1)]
    );

    if (inviteResult.documents.length === 0) {
        return fail(res, 404, 'invite_not_found');
    }

    const invite = inviteResult.documents[0];

    // 2. Status check
    if (invite.status !== 'pending') {
        return fail(res, 410, 'invite_not_pending', { status: invite.status });
    }

    // 3. Expiry check
    if (new Date(invite.expiresAt) < new Date()) {
        await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
            status: 'expired'
        });
        log(`[Accept] Invite ${invite.$id} lejárt — expired-re állítva`);
        // D.3 expired audit-gap fix (Codex MAJOR 2026-05-09): accept-attempt
        // közben lejárt → history archive (különben a finalStatus elveszik).
        await _archiveInvite(ctx, invite, 'expired', 'auto_expire_on_accept_attempt');
        return fail(res, 410, 'invite_expired');
    }

    // 4. E-mail egyezés ellenőrzése (a tokent ne lehessen ellopni)
    let callerUserDoc;
    try {
        callerUserDoc = await usersApi.get(callerId);
    } catch (e) {
        error(`[Accept] Caller user lookup hiba (${callerId}): ${e.message}`);
        return fail(res, 500, 'caller_lookup_failed');
    }

    const callerEmail = (callerUserDoc.email || '').trim().toLowerCase();
    const inviteEmail = (invite.email || '').trim().toLowerCase();
    if (callerEmail !== inviteEmail) {
        log(`[Accept] E-mail eltérés — caller=${callerUserDoc.email}, invite=${invite.email}`);
        return fail(res, 403, 'email_mismatch');
    }

    // 5. Duplikátum check — ha már van membership, csak az invite-ot frissítjük
    const existingMembership = await databases.listDocuments(
        env.databaseId,
        env.membershipsCollectionId,
        [
            sdk.Query.equal('organizationId', invite.organizationId),
            sdk.Query.equal('userId', callerId),
            sdk.Query.limit(1)
        ]
    );

    if (existingMembership.documents.length > 0) {
        // 2026-05-08 (Codex review BLOCKER 2 fix): a `pending → accepted`
        // updateDocument a `(organizationId, email, status)` unique indexen
        // ütközhet, ha ugyanahhoz a párhoz már létezik `accepted` rekord
        // (több korábbi meghívás, már egy elfogadott). A membership a
        // source of truth — az invite-rekord eldobható. DELETE flow:
        // ha a delete bukik (permission / network), a user TAG marad
        // (idempotens), és egy következő accept-call vagy cron-cleanup
        // pótolja.
        // D.3 — audit-trail: a delete ELŐTT mentjük a history-ba.
        await _archiveInvite(ctx, invite, 'accepted', 'idempotent_already_member', callerId);
        try {
            await databases.deleteDocument(env.databaseId, env.invitesCollectionId, invite.$id);
        } catch (deleteErr) {
            log(`[Accept] Idempotens — invite ${invite.$id} delete hiba (non-blocking): ${deleteErr.message}`);
        }
        log(`[Accept] Idempotens — user ${callerId} már tagja az org ${invite.organizationId}-nak`);
        return res.json({
            success: true,
            action: 'already_member',
            organizationId: invite.organizationId,
            membershipId: existingMembership.documents[0].$id,
            role: existingMembership.documents[0].role
        });
    }

    // 6. Membership létrehozás API key-jel — a collection create ACL
    // üres, tehát csak a server SDK tud ide írni. Nincs szükség sentinel
    // mezőre.
    //
    // Race condition védelem: az `organizationMemberships` collectionön
    // létezik egy composite unique index `(organizationId, userId)`-n.
    // Ha két elfogadás (pl. dupla klikk, retry) párhuzamosan fut, a
    // fenti duplikátum check mindkét esetben 0-t adhat vissza, de a
    // DB insert ütközni fog. Ilyenkor újraolvassuk a membershipet és
    // idempotens `already_member` választ adunk vissza.
    let membership;
    try {
        membership = await databases.createDocument(
            env.databaseId,
            env.membershipsCollectionId,
            sdk.ID.unique(),
            {
                organizationId: invite.organizationId,
                userId: callerId,
                role: invite.role || 'member',
                addedByUserId: invite.invitedByUserId,
                // 2026-05-07 denormalizáció (snapshot-at-join). A `callerUserDoc`-ot
                // amúgy is lekértük az e-mail-egyezés ellenőrzéshez (228-241.
                // sor) — a mezőket onnan közvetlenül átvesszük, nincs külön
                // `usersApi.get` hívás.
                userName: callerUserDoc.name || null,
                userEmail: callerUserDoc.email || null
            }
        );
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
            const raceWinner = await databases.listDocuments(
                env.databaseId,
                env.membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', invite.organizationId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.limit(1)
                ]
            );
            if (raceWinner.documents.length > 0) {
                const existing = raceWinner.documents[0];
                // 2026-05-08 (Codex review BLOCKER 2 fix): a status-update
                // ugyanazon a unique indexen ütközhet, mint a fő ágon — a
                // race-loser hívás itt ugyanúgy DELETE-tel takarít. Ha
                // bukik, non-blocking — a membership már megvan, ami a
                // source of truth.
                // D.3 — audit-trail: a delete ELŐTT mentjük a history-ba.
                await _archiveInvite(ctx, invite, 'accepted', 'race_winner_already_member', callerId);
                try {
                    await databases.deleteDocument(env.databaseId, env.invitesCollectionId, invite.$id);
                } catch (deleteErr) {
                    log(`[Accept] Race — invite ${invite.$id} delete hiba (non-blocking): ${deleteErr.message}`);
                }
                log(`[Accept] Race — user ${callerId} már tagja az org ${invite.organizationId}-nak`);
                return res.json({
                    success: true,
                    action: 'already_member',
                    organizationId: invite.organizationId,
                    membershipId: existing.$id,
                    role: existing.role
                });
            }
        }
        throw err;
    }

    // 7. Invitee hozzáadás az org team-hez (tenant ACL scope kiterjesztés).
    // Ha a team még nem létezik (legacy org backfill előtt), skip — a
    // `backfill_tenant_acl` action majd pótolja.
    try {
        await ensureTeamMembership(
            teamsApi,
            buildOrgTeamId(invite.organizationId),
            callerId,
            [invite.role || 'member']
        );
    } catch (err) {
        error(`[Accept] org team membership hiba (non-blocking): ${err.message}`);
    }

    // 8. Invite cleanup (Codex review 2026-05-08 BLOCKER 2 fix)
    //
    // A korábbi `updateDocument(status='accepted')` a
    // `(organizationId, email, status)` unique indexen ütközött, ha
    // ugyanahhoz az `(org, email)` párhoz már létezett egy `accepted`
    // rekord (pl. több korábbi meghívás-iteráció). Megoldás: az invite
    // egyszerűen TÖRÖLŐDIK az accept után — a membership a source of truth.
    //
    // D.3 (2026-05-09) — audit-trail: a delete ELŐTT mentjük a history-ba,
    // hogy az invite metadata (ki hívta, mikor, milyen role-lal) a token
    // SHA-256 hash-szel együtt rekonstruálható legyen.
    //
    // Ha a delete bukik (permission / network), a user TAG marad —
    // a következő accept-call az 5-ös idempotens-membership ágon fogja
    // pótolni a cleanup-ot.
    await _archiveInvite(ctx, invite, 'accepted', null, callerId);
    try {
        await databases.deleteDocument(env.databaseId, env.invitesCollectionId, invite.$id);
    } catch (deleteErr) {
        error(`[Accept] invite ${invite.$id} delete hiba (non-blocking — membership létrejött): ${deleteErr.message}`);
    }

    log(`[Accept] User ${callerId} elfogadta az invite ${invite.$id}-t → membership ${membership.$id}`);

    return res.json({
        success: true,
        action: 'accepted',
        organizationId: invite.organizationId,
        membershipId: membership.$id,
        role: membership.role
    });
}

/**
 * ACTION='list_my_invites' (#41 — Maestro beállítások).
 *
 * A meghívott (még nem org-tag) user nem tudja a saját pending
 * invite-ját olvasni közvetlenül: az `organizationInvites` ACL
 * `read("team:org_${orgId}")`-re szűkül, és ő még nincs benne a
 * team-ben (az csak az `accept` után). Ezt az action-t ezért az
 * API key-jel futtatjuk, és kizárólag a caller saját e-mail
 * címére regisztrált pending invite-okat adja vissza, denormalizált
 * org-név + meghívó név mezőkkel a UI listához.
 *
 * Read-only — nem módosít DB-t, nem küld e-mailt.
 */
async function listMyInvites(ctx) {
    const { databases, env, callerId, log, error, res, fail, sdk, usersApi } = ctx;

    // 1) Caller user lekérés az e-mail kinyeréséhez.
    let callerUserDoc;
    try {
        callerUserDoc = await usersApi.get(callerId);
    } catch (e) {
        error(`[ListMyInvites] caller user lookup hiba (${callerId}): ${e.message}`);
        return fail(res, 500, 'caller_lookup_failed');
    }
    const callerEmail = (callerUserDoc.email || '').trim().toLowerCase();
    if (!callerEmail) {
        return fail(res, 400, 'missing_caller_email');
    }

    // 2) Pending invite-ok lekérése. Az e-mail összehasonlítás
    //    case-insensitive a Modal/Server `EMAIL_REGEX` normalizálás
    //    miatt (a `create` action lower-case-elve menti).
    let invitesResp;
    try {
        invitesResp = await databases.listDocuments(
            env.databaseId,
            env.invitesCollectionId,
            [
                sdk.Query.equal('email', callerEmail),
                sdk.Query.equal('status', 'pending'),
                sdk.Query.orderDesc('$createdAt'),
                sdk.Query.limit(100)
            ]
        );
    } catch (e) {
        error(`[ListMyInvites] invites listing hiba: ${e.message}`);
        return fail(res, 500, 'invites_list_failed');
    }

    const now = Date.now();
    // Lejárt invite-ok auto-expire — kvázi opportunista "látogatáskor
    // takarítjuk" megközelítés. Best-effort: hiba esetén nem dobunk,
    // a UI úgyis a `expired`-re elnémul, és a következő call újra
    // próbálkozik.
    const validInvites = [];
    for (const inv of invitesResp.documents) {
        if (new Date(inv.expiresAt).getTime() < now) {
            try {
                await databases.updateDocument(env.databaseId, env.invitesCollectionId, inv.$id, {
                    status: 'expired'
                });
                // D.3 expired audit-gap fix (Codex MAJOR 2026-05-09): opportunista
                // expire során a history rekord is létrejön — különben a passzív
                // listing alatti expire-ok elvesznének az audit-trailből.
                await _archiveInvite(ctx, inv, 'expired', 'auto_expire_on_list');
            } catch (expErr) {
                log(`[ListMyInvites] invite expire frissítés sikertelen (non-blocking, ${inv.$id}): ${expErr.message}`);
            }
            continue;
        }
        validInvites.push(inv);
    }

    // 3) Denormalizáció: org név + meghívó user név.
    //    A duplikátumokat egy Map-pel kezeljük, hogy az ismétlődő
    //    org/user lekérések cache-eljenek a per-request scope-ban.
    const orgCache = new Map();
    const userCache = new Map();

    async function fetchOrg(orgId) {
        if (!orgId) return null;
        if (orgCache.has(orgId)) return orgCache.get(orgId);
        try {
            const doc = await databases.getDocument(env.databaseId, env.organizationsCollectionId, orgId);
            orgCache.set(orgId, doc);
            return doc;
        } catch (e) {
            orgCache.set(orgId, null);
            return null;
        }
    }

    async function fetchInviter(userId) {
        if (!userId) return null;
        if (userCache.has(userId)) return userCache.get(userId);
        try {
            const u = await usersApi.get(userId);
            userCache.set(userId, u);
            return u;
        } catch (e) {
            userCache.set(userId, null);
            return null;
        }
    }

    const enriched = [];
    for (const inv of validInvites) {
        const [org, inviter] = await Promise.all([
            fetchOrg(inv.organizationId),
            fetchInviter(inv.invitedByUserId)
        ]);
        enriched.push({
            $id: inv.$id,
            token: inv.token,
            email: inv.email,
            role: inv.role || 'member',
            organizationId: inv.organizationId,
            organizationName: org?.name || null,
            invitedByUserId: inv.invitedByUserId,
            invitedByName: inviter?.name || inviter?.email || null,
            expiresAt: inv.expiresAt,
            createdAt: inv.$createdAt
        });
    }

    log(`[ListMyInvites] User ${callerId} (${callerEmail}) → ${enriched.length} pending invite (összes lapozott pending: ${invitesResp.documents.length})`);

    return res.json({
        success: true,
        action: 'listed',
        invites: enriched
    });
}

/**
 * ACTION='decline_invite' (#41).
 *
 * Pending invite elutasítása. Token + e-mail match védelem (mint
 * az `accept` action-nél), majd status='declined' set. Idempotens:
 * ha már declined / accepted / expired, megfelelő hibakód.
 */
async function declineInvite(ctx) {
    const { databases, env, callerId, payload, log, error, res, fail, sdk, usersApi } = ctx;
    const { token } = payload;
    if (!token || typeof token !== 'string') {
        return fail(res, 400, 'missing_fields', { required: ['token'] });
    }

    // 1) Token lookup
    let invite;
    try {
        const result = await databases.listDocuments(
            env.databaseId,
            env.invitesCollectionId,
            [sdk.Query.equal('token', token), sdk.Query.limit(1)]
        );
        if (result.documents.length === 0) {
            return fail(res, 404, 'invite_not_found');
        }
        invite = result.documents[0];
    } catch (e) {
        error(`[DeclineInvite] token lookup hiba: ${e.message}`);
        return fail(res, 500, 'invite_lookup_failed');
    }

    // 2) Status check — csak pending-ből lehet declined-ra váltani.
    if (invite.status !== 'pending') {
        return fail(res, 410, 'invite_not_pending', { status: invite.status });
    }

    // 3) Expiry check — lejárt invite-ot nem utasítunk el (értelmetlen),
    //    de auto-expire-oljuk, mint az accept-nél.
    if (new Date(invite.expiresAt) < new Date()) {
        try {
            await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
                status: 'expired'
            });
            // D.3 expired audit-gap fix (Codex MAJOR 2026-05-09): decline-attempt
            // közben lejárt → history archive.
            await _archiveInvite(ctx, invite, 'expired', 'auto_expire_on_decline_attempt');
        } catch (e) {
            log(`[DeclineInvite] expire frissítés sikertelen: ${e.message}`);
        }
        return fail(res, 410, 'invite_expired');
    }

    // 4) E-mail egyezés ellenőrzése — mint az accept-nél.
    let callerUserDoc;
    try {
        callerUserDoc = await usersApi.get(callerId);
    } catch (e) {
        error(`[DeclineInvite] caller user lookup hiba (${callerId}): ${e.message}`);
        return fail(res, 500, 'caller_lookup_failed');
    }

    const callerEmail = (callerUserDoc.email || '').trim().toLowerCase();
    const inviteEmail = (invite.email || '').trim().toLowerCase();
    if (callerEmail !== inviteEmail) {
        log(`[DeclineInvite] e-mail eltérés — caller=${callerUserDoc.email}, invite=${invite.email}`);
        return fail(res, 403, 'email_mismatch');
    }

    // 5) Status update
    try {
        await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
            status: 'declined'
        });
    } catch (e) {
        error(`[DeclineInvite] status update hiba: ${e.message}`);
        return fail(res, 500, 'invite_update_failed');
    }

    // D.3 — audit-trail: a status-update UTÁN, a doc megmarad. Best-effort,
    // a history-be kerül a metadata.
    await _archiveInvite(ctx, invite, 'declined', null, callerId);

    log(`[DeclineInvite] User ${callerId} elutasította invite ${invite.$id}-t (org=${invite.organizationId})`);

    return res.json({
        success: true,
        action: 'declined',
        inviteId: invite.$id,
        organizationId: invite.organizationId
    });
}

module.exports = {
    createInvite,
    createBatchInvites,
    acceptInvite,
    listMyInvites,
    declineInvite
};
