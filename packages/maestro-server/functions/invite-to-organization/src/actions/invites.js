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
    buildOrgAdminAclPerms,
    buildOrgTeamId,
    buildOrgAdminTeamId,
    ensureTeam,
    ensureTeamMembership
} = require('../teamHelpers.js');
const permissions = require('../permissions.js');
// ADR 0010 W2/W3 — meghívási flow redesign:
//   - sendOneInviteEmail: auto-send a sikeres createInvite után (best-effort)
//   - checkRateLimit: brute-force védelem az acceptInvite-on (IP-rate-limit)
const { sendOneInviteEmail, RESEND_COOLDOWN_MS } = require('./sendEmail.js');
const { checkRateLimit, evaluateAndConsume } = require('../helpers/rateLimit.js');
const { inviteSendScopes } = require('../helpers/inviteRateLimits.js');

const MAX_BATCH_INVITES = 20;
const MAX_CUSTOM_MESSAGE_LENGTH = 500;

/**
 * D.3 (2026-05-09) — invite audit-trail helper, Codex Konstrukció C CAS-gate
 * (G blokk, 2026-05-09 follow-up).
 *
 * A `acceptInvite`, `declineInvite` és `expireInvite` (opportunista expire)
 * destruktív kilépési ágain a helper egy `organizationInviteHistory` doc-ot
 * ír (snapshot-at-archive). Ezzel rekonstruálható: ki hívta meg X-et, mikor,
 * milyen role-lal, mi lett a végső sors.
 *
 * **CAS-gate (G blokk, Codex pre-review Konstrukció C)**:
 * A doc-ID INVITE-szintű terminal-claim (`invite.$id`, korábban
 * `${invite.$id}__${finalStatus}` volt). Ezzel egy invite csak EGY terminál
 * állapotba kerülhet — a párhuzamos `accepted` vs `expired` ág közül az első
 * nyer, a második `document_already_exists` 409-et kap.
 *
 * A hívóhely a return-ből látja az eredményt:
 *   - `created`: az archive sikeres, a hívó futtathatja a status-update-et / delete-et.
 *   - `already_exists`: race-loser. A hívó dönt:
 *       - `acceptInvite` main: log + folytat (membership már megvan, user-feeling: tag).
 *       - `declineInvite` main: 409 `already_terminated`.
 *       - opportunista expire ágak (`auto_expire_on_*`): SKIP a status update
 *         (a másik ág már átírta).
 *       - `_createInviteCore` recreate: re-read a latest invite-ot — ha még
 *         `pending`, 409 `invite_state_race_retry` (Codex stop-time MAJOR fix).
 *   - `env_missing`: az `ORGANIZATION_INVITE_HISTORY_COLLECTION_ID` env hiányzik.
 *     **G.3 (Phase 2, ADR 0011) hard-fail kontraktus**: a 4 critical-path action
 *     (`acceptInvite`, `declineInvite`, `createInvite`, `createBatchInvites`)
 *     az `_assertCasGateConfigured(ctx)` action-eleji guarddal 500
 *     `service_misconfigured`-ra fail-eli. A `_archiveInvite` `env_missing`
 *     return-je így csak az opportunista `_archiveAndUpdateExpiredInvite`
 *     ágon jut el — ott best-effort marad (a fő flow-t nem blokkolja).
 *   - `error`: write hiba (timeout, hálózat). **G.2 (Phase 2)**: a recovery
 *     probe `created` (idempotent) vagy `already_exists` (race-loser) jelzésre
 *     konvertálja, ha az írás backend-oldalon mégis lefutott. A hívó tartós
 *     hibára (`error`) best-effort továbbmegy — a final state (membership
 *     létrejön) fontosabb, mint a transient audit-rés.
 *
 * GDPR: a `token` raw értéket NEM tároljuk — SHA-256 hash kerül a `tokenHash`
 * mezőbe. Ez elég incident-korrelációhoz (egy konkrét tokenes report → hash
 * → lookup), de NEM lehet újrahasznosítani.
 *
 * **Phase 2 implementáció (2026-05-09 Session-4)**:
 *   - G.2 recovery probe: a 504/timeout után az `error` ág `getDocument`-tel
 *     megnézi, hogy a write backend-oldalon mégis lefutott-e — ha igen, a
 *     hívó `created` (idempotent) vagy `already_exists` (race-loser) jelzést
 *     kap a stale `error` helyett (lásd kód a `} catch (err) {` ágban).
 *   - G.3 history collection env required: a 4 critical-path action eleji
 *     `_assertCasGateConfigured(ctx)` 500 hard-fail-eli az env-hiányos
 *     futást, mielőtt bármi DB mutáció történne (lásd ADR 0011).
 *
 * @param {Object} ctx - CF ctx
 * @param {Object} invite - a teljes invite doc (a destrukció ELŐTT)
 * @param {'accepted'|'declined'|'expired'} finalStatus
 * @param {string} [finalReason] - opcionális magyarázat (pl. cleanup ok)
 * @param {string} [finalUserId] - acceptedByUserId / declinedByUserId
 * @returns {Promise<{ status: 'created' | 'already_exists' | 'env_missing' | 'error',
 *                     existingFinalStatus?: string, error?: Error }>}
 */
async function _archiveInvite(ctx, invite, finalStatus, finalReason, finalUserId) {
    const { databases, env, log, error } = ctx;
    const inviteHistoryCollectionId = env.organizationInviteHistoryCollectionId;
    if (!inviteHistoryCollectionId) {
        // G.3 (Phase 2, 2026-05-09): a CAS-gate hard-fail kontraktus szerint
        // a hívó az `env_missing`-et 500 `service_misconfigured`-ként kezeli
        // (NEM best-effort tovább). A return-jelzés diagnostikai célú, hogy
        // a hívó megfelelő hibakódot adjon vissza.
        error(`[ArchiveInvite] CAS-gate misconfigured — ORGANIZATION_INVITE_HISTORY_COLLECTION_ID env hiányzik (invite=${invite.$id})`);
        return { status: 'env_missing' };
    }

    // `deterministicId` a try-blokkon kívül, hogy a recovery probe is lássa.
    const deterministicId = invite.$id;

    // Per-attempt UUID a 504 recovery probe correlation-jéhez (ADR 0011 Harden
    // Ph3): csak ha az `existing.attemptId` matchel, írhatjuk saját siker
    // jelzéssel. Legacy doc (attemptId hiányzik) → konzervatív race-loser.
    const currentAttemptId = crypto.randomUUID();

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
            finalAt,
            attemptId: currentAttemptId
        };
        // Codex simplify Q1 (2026-05-09): per-finalStatus mező direkt
        // assign — 3 ternary spread helyett 1 if-cascade.
        if (finalStatus === 'accepted') payload.acceptedByUserId = finalUserId || null;
        else if (finalStatus === 'declined') payload.declinedByUserId = finalUserId || null;
        else if (finalStatus === 'expired') payload.expiredAt = finalAt;

        // G blokk (2026-05-09 follow-up) — invite-szintű terminal-claim doc-ID.
        // A korábbi `${invite.$id}__${finalStatus}` finalStatus-postfix-ű ID
        // két KÜLÖNBÖZŐ doc-ot engedett meg `accepted` vs `expired` race
        // esetén → audit-inkonzisztencia. A jelenlegi minta egyetlen doc-ot
        // enged meg invite-szinten — az első ág nyer, a második 409-et kap.
        try {
            await databases.createDocument(
                env.databaseId,
                inviteHistoryCollectionId,
                deterministicId,
                payload,
                // Q1 ACL (E blokk, 2026-05-09 follow-up): a history doc is
                // CSAK az admin-team tagjai (owner+admin) számára olvasható.
                buildOrgAdminAclPerms(invite.organizationId)
            );
            log(`[ArchiveInvite] invite=${invite.$id} → history (finalStatus=${finalStatus}) — claimed`);
            return { status: 'created' };
        } catch (createErr) {
            if (createErr?.type === 'document_already_exists' || /already exist/i.test(createErr?.message || '')) {
                // CAS race-loser: egy másik ág már elcsípte a terminal claim-et.
                // Best-effort: probe-oljuk az existing finalStatus-t, hogy a
                // hívó tudja, hogy ugyanazon vagy más finalStatus-szal nyert-e
                // a másik ág (mind a kettő érvényes — ugyanakkor stale info,
                // mert race két accept-éra elkapja az egyik 'accepted'-t).
                let existingFinalStatus = null;
                try {
                    const existing = await databases.getDocument(
                        env.databaseId, inviteHistoryCollectionId, deterministicId
                    );
                    existingFinalStatus = existing?.finalStatus || null;
                } catch (probeErr) {
                    // Lookup hiba — ne blokkoljunk a probe miatt.
                }
                log(`[ArchiveInvite] invite=${invite.$id} history (attempted=${finalStatus}, winner=${existingFinalStatus || '?'}) — race-loser, skip`);
                return { status: 'already_exists', existingFinalStatus };
            }
            throw createErr;
        }
    } catch (err) {
        // 504 recovery probe — saját siker CSAK attemptId-match esetén
        // (különben a racer nyert vagy a saját write meg sem érkezett).
        error(`[ArchiveInvite] write hiba (recovery probe következik, invite=${invite.$id}): ${err.message}`);
        try {
            const existing = await databases.getDocument(
                env.databaseId, inviteHistoryCollectionId, deterministicId
            );
            if (existing && existing.finalStatus) {
                if (existing.attemptId === currentAttemptId) {
                    log(`[ArchiveInvite] recovery probe: invite=${invite.$id} attemptId match (${finalStatus}) — saját write committed`);
                    return { status: 'created', recovered: true };
                }
                log(`[ArchiveInvite] recovery probe: invite=${invite.$id} doc megvan más attemptId-vel (winner=${existing.finalStatus}) — race-loser`);
                return { status: 'already_exists', existingFinalStatus: existing.finalStatus, recovered: true };
            }
        } catch (probeErr) {
            // Probe is bukott — valódi tartós hiba.
        }
        return { status: 'error', error: err };
    }
}

/**
 * G blokk CAS-gate compose-helper (Simplify Quality #1, 2026-05-09).
 *
 * A 4 opportunista expire-ág (`_createInviteCore`, `acceptInvite` expiry,
 * `listMyInvites`, `declineInvite` expiry) ugyanazt a "claim-then-update"
 * mintát futtatta: ELŐSZÖR archive (terminal-claim), CSAK ha NEM race-loser
 * → `status='expired'` update. A négy ismétlés egy helyre tömörítve, a
 * hívóhely 1-2 sorra szűkül.
 *
 * @param {Object} ctx - CF ctx
 * @param {Object} invite - a teljes invite doc
 * @param {string} reason - finalReason a history-be (auto_expire_on_*)
 * @param {string} contextLabel - log-prefix (pl. '[Accept]', '[ListMyInvites]')
 * @returns {Promise<{ updated: boolean, archiveStatus: string, existingFinalStatus?: string }>}
 *   - updated: a status-update lefutott-e (true ha created/env_missing/error,
 *     false ha already_exists race-loser)
 *   - archiveStatus: a `_archiveInvite` return.status mező
 */
/**
 * G.3 (Phase 2, 2026-05-09) — CAS-gate hard-fail action-eleji guard.
 *
 * A `_archiveInvite()` history-kollekció env-jét a critical-path action-ek
 * (acceptInvite, declineInvite, _createInviteCore) az ELSŐ DB-mutáció ELŐTT
 * ellenőrzik. Ha hiányzik → 500 `service_misconfigured` — NEM mehet tovább
 * a flow audit-rés mellett. A return ugyanaz mint a `requireOwnerAnywhere`-é:
 * `null` ha OK, vagy a `fail()` által épített response objektum.
 *
 * Az opportunista expire (`_archiveAndUpdateExpiredInvite`) NEM használja —
 * ott az archive bukása a fő flow-t nem blokkolja, és az env-hiány a
 * critical-path action-ön már lefulladt volna.
 */
function _assertCasGateConfigured(ctx) {
    const { env, res, fail: failFn, error } = ctx;
    if (!env.organizationInviteHistoryCollectionId) {
        error('[CAS-gate] ORGANIZATION_INVITE_HISTORY_COLLECTION_ID env hiányzik — service_misconfigured');
        return failFn(res, 500, 'service_misconfigured', {
            missing: 'ORGANIZATION_INVITE_HISTORY_COLLECTION_ID'
        });
    }
    return null;
}

async function _archiveAndUpdateExpiredInvite(ctx, invite, reason, contextLabel) {
    const { databases, env, log, error } = ctx;
    const archiveResult = await _archiveInvite(ctx, invite, 'expired', reason);
    if (archiveResult.status === 'already_exists') {
        log(`${contextLabel} invite ${invite.$id} race-loser (winner=${archiveResult.existingFinalStatus || '?'}) — status update skipping`);
        return {
            updated: false,
            archiveStatus: archiveResult.status,
            existingFinalStatus: archiveResult.existingFinalStatus
        };
    }
    // Csak `created` archive után update-elünk: transient hiba (`env_missing` /
    // `error`) esetén az invite `pending` marad, a következő opportunista
    // expire újrapróbálja — különben az audit-rés véglegesedne (ADR 0011).
    if (archiveResult.status !== 'created') {
        error(`${contextLabel} invite ${invite.$id} archive nem committed (status=${archiveResult.status}) — status update skipping, retry next time`);
        return {
            updated: false,
            archiveStatus: archiveResult.status
        };
    }
    await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
        status: 'expired'
    });
    log(`${contextLabel} invite ${invite.$id} expired-re állítva (archive=${archiveResult.status})`);
    return {
        updated: true,
        archiveStatus: archiveResult.status
    };
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
        // Lejárt — G blokk CAS-gate: ELŐSZÖR archive (terminal-claim),
        // CSAK ha NEM race-loser → status update.
        //
        // Codex stop-time MAJOR fix: race-loser után re-read kell a latest invite
        // state-jére. Ha még `pending` (másik ág archive-ja átment, status update
        // még nem), a create-flow túl korán futna és a unique-index ütközne →
        // 409 `invite_state_race_retry`, a hívó retry-olhatja.
        const archiveResult = await _archiveAndUpdateExpiredInvite(
            ctx, existing, 'auto_expire_on_recreate', '[CreateCore]'
        );
        if (!archiveResult.updated) {
            try {
                const latest = await databases.getDocument(
                    env.databaseId, env.invitesCollectionId, existing.$id
                );
                if (latest.status === 'pending') {
                    log(`[CreateCore] invite ${existing.$id} race-loser, latest still pending — retry kell`);
                    return { ok: false, reason: 'invite_state_race_retry', statusCode: 409 };
                }
            } catch (readErr) {
                log(`[CreateCore] invite ${existing.$id} race-loser, re-read bukott (${readErr.message}) — status update skipping`);
            }
        }
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
            // Q1 ACL (E blokk, 2026-05-09 follow-up): új invite-ot CSAK az
            // admin-team tagjai (owner+admin) látnak. Membereknek nincs read.
            buildOrgAdminAclPerms(organizationId)
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

    // G.3 (Phase 2, 2026-05-09) — CAS-gate konfig hard-fail. A `_createInviteCore`
    // opportunistán expire-elheti a stale invite-okat (audit-trail), és az
    // env nélkül ez bukna. Az invite-create flow-t NEM engedjük audit-rés mellett.
    const casDenied = _assertCasGateConfigured(ctx);
    if (casDenied) return casDenied;
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

    // S.2.2/S.2.6 — multi-scope rate-limit. Codex M1: evaluate all → consume after
    // all-pass (lockout-amplifikáció elkerülése). Codex M2: permission/validation
    // UTÁN, expensive work (createCore + email-send) ELŐTT.
    // S.2.7 harden HIGH-2: storage-down → 503 fail-closed (NEM email-küldés).
    const rateLimited = await evaluateAndConsume(ctx, inviteSendScopes(callerId, organizationId, 1));
    if (rateLimited) return fail(res, rateLimited.code, rateLimited.reason, rateLimited.payload);

    // Core create
    const result = await _createInviteCore(ctx, {
        organizationId, email, role, expiryDays, customMessage
    });

    // G blokk CAS-gate (2026-05-09 follow-up): a `_createInviteCore` `ok:false`
    // ágon visszaadhat `invite_state_race_retry`-t, ha az `existing` invite
    // expire-archive race-loser és a status update SKIP-pelt → a hívó retry-olhat.
    if (result.ok === false) {
        return fail(res, result.statusCode || 409, result.reason);
    }

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

    // G.3 (Phase 2, 2026-05-09) — CAS-gate konfig hard-fail (lásd `createInvite`).
    const casDenied = _assertCasGateConfigured(ctx);
    if (casDenied) return casDenied;
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

    // S.2.2/S.2.6 (2026-05-11, Codex stop-time MAJOR 2 fix) — a rate-limit ELŐTT
    // CSAK in-memory pre-filter (dedup + email-regex), drága DB/user-API lookup
    // (org + inviter) UTÁN. Így a 429 ágon NEM ég el a `getDocument`/`users.get`
    // cost.
    //
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

    // Email-regex single-pass split (simplify Efficiency F7) — valid/invalid külön
    // gyűjtés, a Promise.all CSAK validEmails-en fut (NEM kell redundáns regex-test).
    // Rate-limit weight = validEmails.length (Codex M2: malformed email NE égesse
    // az org-day quota-t).
    const validEmails = [];
    const earlyResults = [];
    for (const email of normalizedEmails) {
        if (EMAIL_REGEX.test(email)) validEmails.push(email);
        else earlyResults.push({ email, status: 'error', reason: 'invalid_email' });
    }
    if (validEmails.length === 0) {
        return fail(res, 400, 'no_valid_emails', { total: normalizedEmails.length });
    }
    const rateLimited = await evaluateAndConsume(ctx, inviteSendScopes(callerId, organizationId, validEmails.length));
    if (rateLimited) return fail(res, rateLimited.code, rateLimited.reason, rateLimited.payload);

    // Org + inviter cache (egy fetch per batch — lookup költség minimalizálás).
    // Rate-limit UTÁN: a 429 ág NEM fizet érte.
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

    // 10-es Promise.all batchekben — CSAK validEmails-en (invalid eredmények
    // earlyResults-ben). Simplify Efficiency F7: NEM kell redundáns EMAIL_REGEX
    // teszt a per-email Promise-on belül.
    const BATCH_SIZE = 10;
    const results = [...earlyResults];
    for (let i = 0; i < validEmails.length; i += BATCH_SIZE) {
        const slice = validEmails.slice(i, i + BATCH_SIZE);
        const sliceResults = await Promise.all(slice.map(async (email) => {
            try {
                const result = await _createInviteCore(ctx, {
                    organizationId, email, role, expiryDays, customMessage
                });
                // G blokk CAS-gate (2026-05-09 follow-up): race-retry batch ágon is.
                if (result.ok === false) {
                    return { email, status: 'error', reason: result.reason || 'race_retry' };
                }
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

    // G.3 (Phase 2, 2026-05-09) — CAS-gate konfig hard-fail az ELSŐ
    // DB-mutáció ELŐTT (membership/team-add/expire). Audit-rés mellett
    // NEM mehet tovább a flow.
    const casDenied = _assertCasGateConfigured(ctx);
    if (casDenied) return casDenied;

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

    // 3. Expiry check — G blokk CAS-gate: archive-then-update wrapper.
    if (new Date(invite.expiresAt) < new Date()) {
        await _archiveAndUpdateExpiredInvite(ctx, invite, 'auto_expire_on_accept_attempt', '[Accept]');
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

        // Harden Fázis 6 BLOCKER fix: ha az előző acceptInvite-call az 7b
        // admin-team ensure-en bukott el (membership létrejött, 500), az
        // invite-doc még pending (a 8. delete a 7b után fut). A retry erre
        // az ágra esik — itt RETRY-oljuk az admin-team add-et az admin role-os
        // existing membership-re. Idempotens (ensureTeam 409 = skip,
        // ensureTeamMembership 409 = already_member). Best-effort: ha újra
        // bukik, log + tovább (a következő retry vagy a backfill_admin_team_acl
        // pótolja — különben az idempotent ág végtelenül 500-at adna a usernek).
        const existingRole = existingMembership.documents[0].role;
        if (existingRole === 'owner' || existingRole === 'admin') {
            const adminTeamId = buildOrgAdminTeamId(invite.organizationId);
            try {
                await ensureTeam(teamsApi, adminTeamId, `Org admins: ${invite.organizationId}`);
                const r = await ensureTeamMembership(teamsApi, adminTeamId, callerId, [existingRole]);
                if (r.skipped === 'team_not_found') {
                    log(`[Accept] Idempotens admin-team retry: team_not_found az ensureTeam után — backfill pótolja`);
                }
            } catch (err) {
                log(`[Accept] Idempotens admin-team retry hiba (non-blocking — backfill pótolja): ${err.message}`);
            }
        }

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
            role: existingRole
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

                // Harden Fázis 6 BLOCKER fix (mint az idempotens-ágon): admin
                // role esetén az admin-team add idempotens retry — a Q1 ACL
                // beállítása race-winner ágon is futnia kell.
                if (existing.role === 'owner' || existing.role === 'admin') {
                    const adminTeamId = buildOrgAdminTeamId(invite.organizationId);
                    try {
                        await ensureTeam(teamsApi, adminTeamId, `Org admins: ${invite.organizationId}`);
                        const r = await ensureTeamMembership(teamsApi, adminTeamId, callerId, [existing.role]);
                        if (r.skipped === 'team_not_found') {
                            log(`[Accept] Race admin-team retry: team_not_found az ensureTeam után — backfill pótolja`);
                        }
                    } catch (adminErr) {
                        log(`[Accept] Race admin-team retry hiba (non-blocking — backfill pótolja): ${adminErr.message}`);
                    }
                }

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

    // 7b. Q1 ACL (E blokk, 2026-05-09 follow-up): ha az új tag admin role-lal
    //     érkezik, az admin-team-be is be kell venni — különben nem lát
    //     `organizationInvites` / `organizationInviteHistory` doc-ot.
    //
    // Harden Fázis 1+2 (Codex baseline #2 + #3): korábban best-effort volt;
    // ha az admin-team nem létezett (legacy org backfill előtt), a `team_not_found`
    // némán elnyelődött → admin user 'admin' role-t kapott, DE NEM látott
    // ACL-t. Most: `ensureTeam` ELŐSZÖR (idempotens, létrehozza ha hiányzik),
    // utána `ensureTeamMembership`. Ha bármelyik bukik, fail-closed (a user
    // retry-olhatja, és a backend invariáns lokálisan érvényesül).
    if (invite.role === 'admin') {
        const adminTeamId = buildOrgAdminTeamId(invite.organizationId);
        try {
            await ensureTeam(teamsApi, adminTeamId, `Org admins: ${invite.organizationId}`);
        } catch (err) {
            error(`[Accept] org admin-team ensure hiba: ${err.message}`);
            return fail(res, 500, 'admin_team_ensure_failed');
        }
        try {
            const r = await ensureTeamMembership(teamsApi, adminTeamId, callerId, ['admin']);
            if (r.skipped === 'team_not_found') {
                // Az ensureTeam fent sikerült, mégis 404 — párhuzamos törlés
                // vagy belső hiba. Fail-closed.
                error(`[Accept] org admin-team membership team_not_found az ensureTeam után — race`);
                return fail(res, 500, 'admin_team_membership_failed');
            }
        } catch (err) {
            error(`[Accept] org admin-team membership hiba: ${err.message}`);
            return fail(res, 500, 'admin_team_membership_failed');
        }
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
    // G blokk CAS-gate (2026-05-09 follow-up): a return-jelzést loggoljuk;
    // a delete és membership létrehozás már megtörtént (user-feeling: tag).
    // Ha az archive `already_exists`, egy párhuzamos expire/decline ág már
    // megnyerte a terminal-claim-et — audit-szempontból a másik
    // finalStatus marad érvényben, de a user-feeling konzisztens (tag).
    //
    // Ha a delete bukik (permission / network), a user TAG marad —
    // a következő accept-call az 5-ös idempotens-membership ágon fogja
    // pótolni a cleanup-ot.
    const archiveResult = await _archiveInvite(ctx, invite, 'accepted', null, callerId);
    if (archiveResult.status === 'already_exists') {
        log(`[Accept] CAS race — másik ág nyert (${archiveResult.existingFinalStatus || '?'}), de a membership létrejött; user-feeling konzisztens`);
    }
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
    // Lejárt invite-ok opportunista auto-expire (G blokk CAS-gate). Best-effort:
    // a wrapper hibája esetén log + skip, a következő call újra próbálkozik.
    const validInvites = [];
    for (const inv of invitesResp.documents) {
        if (new Date(inv.expiresAt).getTime() < now) {
            try {
                await _archiveAndUpdateExpiredInvite(ctx, inv, 'auto_expire_on_list', '[ListMyInvites]');
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

    // G.3 (Phase 2, 2026-05-09) — CAS-gate konfig hard-fail. Audit-rés
    // mellett NEM írunk `status='declined'`-et.
    const casDenied = _assertCasGateConfigured(ctx);
    if (casDenied) return casDenied;

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

    // 3) Expiry check — G blokk CAS-gate: archive-then-update wrapper. A 410
    //    válasz amúgy is megfelelő, ezért a wrapper hibája csak loggolódik.
    if (new Date(invite.expiresAt) < new Date()) {
        try {
            await _archiveAndUpdateExpiredInvite(ctx, invite, 'auto_expire_on_decline_attempt', '[DeclineInvite]');
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

    // 5) G blokk CAS-gate (2026-05-09 follow-up): ELŐSZÖR archive (terminal-
    //    claim), CSAK ha `created` → status update. `already_exists` =
    //    race-loser (egy párhuzamos accept/expire ág már lezárta) → 409
    //    `already_terminated`.
    const archiveResult = await _archiveInvite(ctx, invite, 'declined', null, callerId);
    if (archiveResult.status === 'already_exists') {
        log(`[DeclineInvite] CAS race-loser — másik ág nyert (${archiveResult.existingFinalStatus || '?'}) az invite ${invite.$id}-on`);
        return fail(res, 409, 'already_terminated', {
            existingFinalStatus: archiveResult.existingFinalStatus || null
        });
    }
    // `created` | `error` → status update fut. Az `env_missing` ágat az
    // action-eleji `_assertCasGateConfigured` már 500-ra fail-elte (G.3
    // hard-fail). A G.2 recovery probe az `error` ágat idempotent vagy
    // race-loser jelzésre konvertálja, ha az írás backend-oldalon mégis
    // lefutott.
    try {
        await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
            status: 'declined'
        });
    } catch (e) {
        error(`[DeclineInvite] status update hiba: ${e.message}`);
        return fail(res, 500, 'invite_update_failed');
    }

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
