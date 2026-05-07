// B.0.3.c (2026-05-04) — Invite flow action-ok kiszervezve külön modulba.
// Tartalmazza: create (admin meghívó küldés), accept (invitee elfogadás),
// list_my_invites (#41), decline_invite (#41). A `leave_organization`
// SZÁNDÉKOSAN nem itt — `actions/offices.js` (B.0.3.g) fogja tartalmazni,
// mert minden membership-cleanup logika ott él egy helyen.

const crypto = require('crypto');
const {
    EMAIL_REGEX,
    INVITE_VALIDITY_DAYS,
    TOKEN_BYTES
} = require('../helpers/util.js');
const {
    buildOrgAclPerms,
    buildOrgTeamId,
    ensureTeamMembership
} = require('../teamHelpers.js');
const permissions = require('../permissions.js');

/**
 * ACTION='create' — admin meghívó küldés.
 *
 * 1. A.3.6 — `org.member.invite` org-scope permission guard (owner+admin).
 * 2. Idempotencia: ha létezik pending invite ugyanerre az email+org-ra
 *    a lejárat előtt, a meglévő tokent adjuk vissza. Lejárt invite →
 *    `expired`, új invite generálva.
 * 3. Token: crypto.randomBytes(32).toString('hex') — 64 char.
 * 4. Expiry: now + 7 nap ISO.
 * 5. Race: composite unique index → újraolvasás idempotens válaszhoz.
 *
 * NINCS messaging.* hívás (Fázis 6 hatáskör).
 */
async function createInvite(ctx) {
    const { databases, env, callerId, callerUser, payload, log, res, fail, sdk, permissionEnv, permissionContext } = ctx;
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

    // 1. A.3.6 — `org.member.invite` org-scope permission guard
    //    (owner + admin egyaránt jogosult; az `ADMIN_EXCLUDED_ORG_SLUGS`
    //    nem tartalmazza ezt a slugot).
    const allowed = await permissions.userHasOrgPermission(
        databases,
        permissionEnv,
        callerUser,
        'org.member.invite',
        organizationId,
        permissionContext.orgRoleByOrg
    );
    if (!allowed) {
        log(`[Create] Caller ${callerId} — nincs org.member.invite jogosultság az org ${organizationId}-ra`);
        return fail(res, 403, 'insufficient_permission', {
            slug: 'org.member.invite',
            scope: 'org'
        });
    }

    // 2. Idempotencia: létezik-e már pending invite ugyanerre az email+org párra?
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
        const existing = existingPending.documents[0];
        // Lejárat ellenőrzés — ha még él, visszaadjuk a meglévő tokent
        if (new Date(existing.expiresAt) > new Date()) {
            log(`[Create] Idempotens — meglévő pending invite ${existing.$id} visszaadva`);
            return res.json({
                success: true,
                action: 'existing',
                inviteId: existing.$id,
                token: existing.token,
                expiresAt: existing.expiresAt
            });
        }
        // Lejárt — frissítjük expired-re és új invite-ot hozunk létre
        await databases.updateDocument(env.databaseId, env.invitesCollectionId, existing.$id, {
            status: 'expired'
        });
        log(`[Create] Lejárt invite ${existing.$id} expired-re állítva`);
    }

    // 3. Token + expiry generálás
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_VALIDITY_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // 4. Invite rekord létrehozása
    //
    // Race condition védelem: a `organizationInvites` collectionön
    // létezik egy composite unique index `(organizationId, email,
    // status)` kulcson. Ha két admin párhuzamosan küld meghívót
    // ugyanarra az email+org párra, mindkettő átmehet a fenti
    // idempotencia check-en, de a DB insert ütközni fog. Ilyenkor
    // a már létrejött rekordot újra lekérdezzük és idempotens
    // success-szel visszaadjuk — a hívó szemszögéből nincs különbség
    // „én hoztam létre" és „valaki más hozta létre velem egy időben"
    // között.
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
                invitedByUserId: callerId
            },
            buildOrgAclPerms(organizationId)
        );
    } catch (err) {
        if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
            // Újraolvassuk — a másik kérés már létrehozta
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
                const existing = raceWinner.documents[0];
                log(`[Create] Race — meglévő pending invite ${existing.$id} visszaadva`);
                return res.json({
                    success: true,
                    action: 'existing',
                    inviteId: existing.$id,
                    token: existing.token,
                    expiresAt: existing.expiresAt
                });
            }
            // Nem találtuk meg — a unique violation máshonnan jött, dobjuk tovább
        }
        throw err;
    }

    log(`[Create] Új invite ${invite.$id} az org ${organizationId} → ${email} (role=${role})`);

    // FÁZIS 6: itt jön majd a messaging.createEmail() hívás.
    // Most a frontend megkapja a tokent és építi a linket.

    return res.json({
        success: true,
        action: 'created',
        inviteId: invite.$id,
        token,
        expiresAt,
        role,
        email,
        organizationId
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
 * 7. Invite status frissítés `accepted`-re.
 */
async function acceptInvite(ctx) {
    const { databases, env, callerId, payload, log, error, res, fail, sdk, usersApi, teamsApi } = ctx;
    const { token } = payload;
    if (!token) {
        return fail(res, 400, 'missing_fields', { required: ['token'] });
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
        await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
            status: 'accepted'
        });
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
                // Még frissítjük az invite-ot is accepted-re, hogy a
                // status ne ragadjon pending-en.
                try {
                    await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
                        status: 'accepted'
                    });
                } catch (updateErr) {
                    log(`[Accept] Race — invite status frissítés hiba: ${updateErr.message}`);
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

    // 8. Invite státusz frissítés
    await databases.updateDocument(env.databaseId, env.invitesCollectionId, invite.$id, {
        status: 'accepted'
    });

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
    acceptInvite,
    listMyInvites,
    declineInvite
};
