const sdk = require("node-appwrite");
const crypto = require("crypto");

/**
 * Appwrite Function: Invite To Organization
 *
 * Szerver-oldali tenant management. A 4 tenant collection
 * (organizations, organizationMemberships, editorialOffices,
 * editorialOfficeMemberships) + organizationInvites collectionökre
 * a kliens NEM rendelkezik direkt írási joggal — minden írás ezen a
 * CF-en keresztül történik API key-jel.
 *
 * Három action:
 *
 *   ACTION='bootstrap_organization' — új org + első office + owner/admin
 *     membership atomikus létrehozása. Az OnboardingRoute hívja első
 *     belépéskor. A CF létrehozza mind a 4 rekordot az API key-jel.
 *     Ha bármelyik lépés elszáll, a már létrehozott rekordokat visszatörli.
 *
 *   ACTION='create' — admin meghívót küld egy e-mail címre.
 *     - Caller jogosultság: csak `owner` vagy `admin` role az adott orgban.
 *     - Idempotencia: ha már van pending invite ugyanerre az email+org párra,
 *       a meglévő tokent adja vissza (nem hoz létre duplikátumot).
 *     - Token: crypto.randomBytes(32).toString('hex') → 64 char.
 *     - Lejárati idő: 7 nap.
 *     - FÁZIS 6: itt kerül majd be a `messaging.createEmail()` hívás. B.5-ben
 *       a frontend admin UI (még nincs) vagy az Appwrite Console kapja a
 *       linket, és manuálisan küldi tovább a meghívottnak.
 *
 *   ACTION='accept' — invitee elfogadja a meghívót.
 *     - Caller user kötelező (`x-appwrite-user-id` header).
 *     - Token lookup → status check → expiry check → e-mail egyezés check.
 *     - Membership létrehozás API key-jel (a collection create permission
 *       üres, tehát csak a server SDK tud írni).
 *     - Invite status frissítése `accepted`-re.
 *     - Idempotens: ha a user már tagja az orgnak, csak az invite státusz
 *       frissül és sikeres választ adunk vissza.
 *
 * Trigger: nincs (HTTP, `execute: ["users"]`)
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY
 * - DATABASE_ID
 * - ORGANIZATIONS_COLLECTION_ID
 * - ORGANIZATION_MEMBERSHIPS_COLLECTION_ID
 * - EDITORIAL_OFFICES_COLLECTION_ID
 * - EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID
 * - ORGANIZATION_INVITES_COLLECTION_ID
 */

const INVITE_VALIDITY_DAYS = 7;
const TOKEN_BYTES = 32;

// Egyszerű e-mail formátum-ellenőrzés (a részletes validáció B.10-ben kézzel)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Slug formátum: kisbetű, szám, kötőjel. A frontend is ugyanezt alkalmazza.
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 128;

/**
 * JSON válasz hibakóddal — egyszerű wrapper a `res.json` köré.
 */
function fail(res, statusCode, reason, extra = {}) {
    return res.json({ success: false, reason, ...extra }, statusCode);
}

/**
 * Trimelt, hosszra szűrt string vagy null, ha üres.
 */
function sanitizeString(value, maxLength) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > maxLength) return null;
    return trimmed;
}

module.exports = async function ({ req, res, log, error }) {
    try {
        // ── Payload feldolgozása ──
        let payload = {};
        if (req.body) {
            try {
                payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            } catch (e) {
                error(`Payload parse hiba: ${e.message}`);
                return fail(res, 400, 'invalid_payload');
            }
        }

        const action = payload.action;
        if (action !== 'create' && action !== 'accept' && action !== 'bootstrap_organization') {
            return fail(res, 400, 'invalid_action', {
                hint: "expected 'bootstrap_organization', 'create' or 'accept'"
            });
        }

        // ── Caller user ID kötelező mindhárom ágon ──
        const callerId = req.headers['x-appwrite-user-id'];
        if (!callerId) {
            return fail(res, 401, 'unauthenticated');
        }

        // ── SDK init ──
        // A key elsődleges forrása a request `x-appwrite-key` header — az Appwrite
        // runtime automatikusan beinjektálja a function aktuális scope-jaival
        // generált dynamic API kulcsot. Így a CF mindig a naprakész scope-okkal
        // fut, és nem kell külön env var-ban kezelni a key-t.
        //
        // Fallback a `process.env.APPWRITE_API_KEY` env var-ra, ha valami miatt
        // a header hiányzik (pl. régebbi runtime vagy Appwrite Console-ból
        // „Execute function" gombbal).
        const apiKey = req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY || '';
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(apiKey);

        const databases = new sdk.Databases(client);
        const usersApi = new sdk.Users(client);

        const databaseId = process.env.DATABASE_ID;
        const organizationsCollectionId = process.env.ORGANIZATIONS_COLLECTION_ID;
        const membershipsCollectionId = process.env.ORGANIZATION_MEMBERSHIPS_COLLECTION_ID;
        const officesCollectionId = process.env.EDITORIAL_OFFICES_COLLECTION_ID;
        const officeMembershipsCollectionId = process.env.EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID;
        const invitesCollectionId = process.env.ORGANIZATION_INVITES_COLLECTION_ID;

        // ════════════════════════════════════════════════════════
        // ACTION = 'bootstrap_organization'
        // ════════════════════════════════════════════════════════
        //
        // Atomikus 4-collection write: organizations + organizationMemberships
        // (owner) + editorialOffices + editorialOfficeMemberships (admin).
        //
        // Rollback: ha a 2-3-4. lépésnél hiba van, a már létrehozott
        // rekordokat visszatöröljük (best-effort).
        if (action === 'bootstrap_organization') {
            const orgName = sanitizeString(payload.orgName, NAME_MAX_LENGTH);
            const orgSlug = sanitizeString(payload.orgSlug, SLUG_MAX_LENGTH);
            const officeName = sanitizeString(payload.officeName, NAME_MAX_LENGTH);
            const officeSlug = sanitizeString(payload.officeSlug, SLUG_MAX_LENGTH);

            if (!orgName || !orgSlug || !officeName || !officeSlug) {
                return fail(res, 400, 'missing_fields', {
                    required: ['orgName', 'orgSlug', 'officeName', 'officeSlug']
                });
            }

            if (!SLUG_REGEX.test(orgSlug) || !SLUG_REGEX.test(officeSlug)) {
                return fail(res, 400, 'invalid_slug', {
                    hint: 'slug must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/'
                });
            }

            // ── Idempotencia: ha a caller már tagja valamelyik orgnak, nem
            // hozunk létre újat. Ez véd a duplaklikkelés és a retry ellen
            // (pl. a kliens elhalt a válasz előtt és újraküldi a kérést).
            // Ugyanazt a success payload-ot adjuk vissza, mint az első futás.
            //
            // Az OnboardingRoute amúgy is csak `organizations.length === 0`
            // esetén éri el ezt az ágat — de a szerver-oldali guard zárja
            // ki azt az esetet, amikor a kliens state még nem frissült.
            const existingOrgMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.limit(1)
                ]
            );
            if (existingOrgMembership.documents.length > 0) {
                const existingOrgId = existingOrgMembership.documents[0].organizationId;

                // Office-t is próbáljuk felderíteni ugyanehhez a userhez —
                // ha nincs, visszaadjuk csak az orgId-t, és a kliens a
                // loadAndSetMemberships után úgy is az első tagot választja.
                let existingOfficeId = null;
                try {
                    const existingOfficeMembership = await databases.listDocuments(
                        databaseId,
                        officeMembershipsCollectionId,
                        [
                            sdk.Query.equal('userId', callerId),
                            sdk.Query.equal('organizationId', existingOrgId),
                            sdk.Query.limit(1)
                        ]
                    );
                    if (existingOfficeMembership.documents.length > 0) {
                        existingOfficeId = existingOfficeMembership.documents[0].editorialOfficeId;
                    }
                } catch (err) {
                    log(`[Bootstrap] Office membership lookup (idempotens ág) hiba: ${err.message}`);
                }

                log(`[Bootstrap] Idempotens — caller ${callerId} már tagja az org ${existingOrgId}-nak, új rekord nem jött létre`);
                return res.json({
                    success: true,
                    action: 'existing',
                    organizationId: existingOrgId,
                    editorialOfficeId: existingOfficeId
                });
            }

            // 1. organizations
            let newOrgId = null;
            try {
                const newOrg = await databases.createDocument(
                    databaseId,
                    organizationsCollectionId,
                    sdk.ID.unique(),
                    {
                        name: orgName,
                        slug: orgSlug,
                        ownerUserId: callerId
                    }
                );
                newOrgId = newOrg.$id;
            } catch (err) {
                if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
                    return fail(res, 409, 'org_slug_taken');
                }
                error(`[Bootstrap] organizations create hiba: ${err.message}`);
                return fail(res, 500, 'org_create_failed');
            }

            // 2. organizationMemberships — owner role
            let newMembershipId = null;
            try {
                const membership = await databases.createDocument(
                    databaseId,
                    membershipsCollectionId,
                    sdk.ID.unique(),
                    {
                        organizationId: newOrgId,
                        userId: callerId,
                        role: 'owner',
                        addedByUserId: callerId
                    }
                );
                newMembershipId = membership.$id;
            } catch (err) {
                error(`[Bootstrap] organizationMemberships create hiba: ${err.message}`);
                // Rollback: org törlés
                try {
                    await databases.deleteDocument(databaseId, organizationsCollectionId, newOrgId);
                } catch (rollbackErr) {
                    error(`[Bootstrap] org rollback sikertelen: ${rollbackErr.message}`);
                }
                return fail(res, 500, 'membership_create_failed');
            }

            // 3. editorialOffices
            let newOfficeId = null;
            try {
                const office = await databases.createDocument(
                    databaseId,
                    officesCollectionId,
                    sdk.ID.unique(),
                    {
                        organizationId: newOrgId,
                        name: officeName,
                        slug: officeSlug
                        // workflowId: null — Fázis 4 tölti fel
                    }
                );
                newOfficeId = office.$id;
            } catch (err) {
                error(`[Bootstrap] editorialOffices create hiba: ${err.message}`);
                // Rollback: membership + org törlés
                try {
                    await databases.deleteDocument(databaseId, membershipsCollectionId, newMembershipId);
                } catch (rollbackErr) {
                    error(`[Bootstrap] membership rollback sikertelen: ${rollbackErr.message}`);
                }
                try {
                    await databases.deleteDocument(databaseId, organizationsCollectionId, newOrgId);
                } catch (rollbackErr) {
                    error(`[Bootstrap] org rollback sikertelen: ${rollbackErr.message}`);
                }
                if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
                    return fail(res, 409, 'office_slug_taken');
                }
                return fail(res, 500, 'office_create_failed');
            }

            // 4. editorialOfficeMemberships — admin role
            try {
                await databases.createDocument(
                    databaseId,
                    officeMembershipsCollectionId,
                    sdk.ID.unique(),
                    {
                        editorialOfficeId: newOfficeId,
                        organizationId: newOrgId,
                        userId: callerId,
                        role: 'admin'
                    }
                );
            } catch (err) {
                error(`[Bootstrap] editorialOfficeMemberships create hiba: ${err.message}`);
                // Rollback: office + membership + org törlés
                try {
                    await databases.deleteDocument(databaseId, officesCollectionId, newOfficeId);
                } catch (rollbackErr) {
                    error(`[Bootstrap] office rollback sikertelen: ${rollbackErr.message}`);
                }
                try {
                    await databases.deleteDocument(databaseId, membershipsCollectionId, newMembershipId);
                } catch (rollbackErr) {
                    error(`[Bootstrap] membership rollback sikertelen: ${rollbackErr.message}`);
                }
                try {
                    await databases.deleteDocument(databaseId, organizationsCollectionId, newOrgId);
                } catch (rollbackErr) {
                    error(`[Bootstrap] org rollback sikertelen: ${rollbackErr.message}`);
                }
                return fail(res, 500, 'office_membership_create_failed');
            }

            log(`[Bootstrap] User ${callerId} új szervezetet hozott létre: org=${newOrgId}, office=${newOfficeId}`);

            return res.json({
                success: true,
                action: 'bootstrapped',
                organizationId: newOrgId,
                editorialOfficeId: newOfficeId
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'create'
        // ════════════════════════════════════════════════════════
        if (action === 'create') {
            const { organizationId, email } = payload;
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

            // 1. Caller jogosultság: létezik-e organizationMembership owner/admin role-lal?
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.limit(1)
                ]
            );

            if (callerMembership.documents.length === 0) {
                log(`[Create] Caller ${callerId} nem tagja az org ${organizationId}-nak`);
                return fail(res, 403, 'not_a_member');
            }

            const callerRole = callerMembership.documents[0].role;
            if (callerRole !== 'owner' && callerRole !== 'admin') {
                log(`[Create] Caller ${callerId} role=${callerRole} — csak owner/admin küldhet meghívót`);
                return fail(res, 403, 'insufficient_role', { yourRole: callerRole });
            }

            // 2. Idempotencia: létezik-e már pending invite ugyanerre az email+org párra?
            const existingPending = await databases.listDocuments(
                databaseId,
                invitesCollectionId,
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
                await databases.updateDocument(databaseId, invitesCollectionId, existing.$id, {
                    status: 'expired'
                });
                log(`[Create] Lejárt invite ${existing.$id} expired-re állítva`);
            }

            // 3. Token + expiry generálás
            const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
            const expiresAt = new Date(Date.now() + INVITE_VALIDITY_DAYS * 24 * 60 * 60 * 1000).toISOString();

            // 4. Invite rekord létrehozása
            const invite = await databases.createDocument(
                databaseId,
                invitesCollectionId,
                sdk.ID.unique(),
                {
                    organizationId,
                    email,
                    token,
                    role,
                    status: 'pending',
                    expiresAt,
                    invitedByUserId: callerId
                }
            );

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

        // ════════════════════════════════════════════════════════
        // ACTION = 'accept'
        // ════════════════════════════════════════════════════════
        if (action === 'accept') {
            const { token } = payload;
            if (!token) {
                return fail(res, 400, 'missing_fields', { required: ['token'] });
            }

            // 1. Token lookup
            const inviteResult = await databases.listDocuments(
                databaseId,
                invitesCollectionId,
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
                await databases.updateDocument(databaseId, invitesCollectionId, invite.$id, {
                    status: 'expired'
                });
                log(`[Accept] Invite ${invite.$id} lejárt — expired-re állítva`);
                return fail(res, 410, 'invite_expired');
            }

            // 4. E-mail egyezés ellenőrzése (a tokent ne lehessen ellopni)
            let callerUser;
            try {
                callerUser = await usersApi.get(callerId);
            } catch (e) {
                error(`[Accept] Caller user lookup hiba (${callerId}): ${e.message}`);
                return fail(res, 500, 'caller_lookup_failed');
            }

            const callerEmail = (callerUser.email || '').trim().toLowerCase();
            const inviteEmail = (invite.email || '').trim().toLowerCase();
            if (callerEmail !== inviteEmail) {
                log(`[Accept] E-mail eltérés — caller=${callerUser.email}, invite=${invite.email}`);
                return fail(res, 403, 'email_mismatch');
            }

            // 5. Duplikátum check — ha már van membership, csak az invite-ot frissítjük
            const existingMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', invite.organizationId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.limit(1)
                ]
            );

            if (existingMembership.documents.length > 0) {
                await databases.updateDocument(databaseId, invitesCollectionId, invite.$id, {
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
            const membership = await databases.createDocument(
                databaseId,
                membershipsCollectionId,
                sdk.ID.unique(),
                {
                    organizationId: invite.organizationId,
                    userId: callerId,
                    role: invite.role || 'member',
                    addedByUserId: invite.invitedByUserId
                }
            );

            // 7. Invite státusz frissítés
            await databases.updateDocument(databaseId, invitesCollectionId, invite.$id, {
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

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
