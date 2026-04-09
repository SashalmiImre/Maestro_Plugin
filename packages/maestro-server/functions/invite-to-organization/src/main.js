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
 * Action-ök:
 *
 *   ACTION='bootstrap_organization' — új org + első office + owner/admin
 *     membership + 7 alapértelmezett csoport + csoporttagságok atomikus
 *     létrehozása. Az OnboardingRoute hívja első belépéskor. A CF létrehozza
 *     az összes rekordot az API key-jel. Ha bármelyik lépés elszáll, a már
 *     létrehozott rekordokat visszatörli (best-effort).
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
 *   ACTION='add_group_member' — admin hozzáad egy usert egy csoporthoz.
 *     - Caller jogosultság: org owner/admin.
 *     - Payload: { groupId, userId }
 *     - Idempotens: ha már létezik a membership, success-t ad vissza.
 *
 *   ACTION='remove_group_member' — admin eltávolít egy usert egy csoportból.
 *     - Caller jogosultság: org owner/admin.
 *     - Payload: { groupId, userId }
 *     - Idempotens: ha nem létezik, success `already_removed`.
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
 * - GROUPS_COLLECTION_ID
 * - GROUP_MEMBERSHIPS_COLLECTION_ID
 * - WORKFLOWS_COLLECTION_ID
 */

/**
 * Alapértelmezett workflow compiled JSON — új office bootstrap-nél seed-elődik.
 * Inline másolat a maestro-shared/defaultWorkflow.json-ből.
 */
const DEFAULT_WORKFLOW = require('./defaultWorkflow.json');

const INVITE_VALIDITY_DAYS = 7;
const TOKEN_BYTES = 32;

// Egyszerű e-mail formátum-ellenőrzés (a részletes validáció B.10-ben kézzel)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Érvényes action-ök halmaza
const VALID_ACTIONS = new Set([
    'bootstrap_organization', 'create', 'accept',
    'add_group_member', 'remove_group_member'
]);

/**
 * Alapértelmezett csoportok — bootstrap_organization hozza létre mindegyiket
 * az új szerkesztőséghez. A slug-ok megegyeznek a régi Appwrite Team slug-okkal.
 * Inline másolat a maestro-shared/groups.js-ből (a CF CommonJS, nem tud ES importot).
 */
const DEFAULT_GROUPS = [
    { slug: 'editors',          name: 'Szerkesztők' },
    { slug: 'designers',        name: 'Tervezők' },
    { slug: 'writers',          name: 'Szerzők' },
    { slug: 'image_editors',    name: 'Képszerkesztők' },
    { slug: 'art_directors',    name: 'Művészeti vezetők' },
    { slug: 'managing_editors', name: 'Vezetőszerkesztők' },
    { slug: 'proofwriters',     name: 'Korrektorok' }
];

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
        if (!VALID_ACTIONS.has(action)) {
            return fail(res, 400, 'invalid_action', {
                hint: `expected one of: ${[...VALID_ACTIONS].join(', ')}`
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
        const groupsCollectionId = process.env.GROUPS_COLLECTION_ID;
        const groupMembershipsCollectionId = process.env.GROUP_MEMBERSHIPS_COLLECTION_ID;
        const workflowsCollectionId = process.env.WORKFLOWS_COLLECTION_ID;

        // ── Fail-fast env var guard ──
        const missingEnvVars = [];
        if (!databaseId) missingEnvVars.push('DATABASE_ID');
        if (!organizationsCollectionId) missingEnvVars.push('ORGANIZATIONS_COLLECTION_ID');
        if (!membershipsCollectionId) missingEnvVars.push('ORGANIZATION_MEMBERSHIPS_COLLECTION_ID');
        if (!officesCollectionId) missingEnvVars.push('EDITORIAL_OFFICES_COLLECTION_ID');
        if (!officeMembershipsCollectionId) missingEnvVars.push('EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID');
        if (!invitesCollectionId) missingEnvVars.push('ORGANIZATION_INVITES_COLLECTION_ID');
        if (!groupsCollectionId) missingEnvVars.push('GROUPS_COLLECTION_ID');
        if (!groupMembershipsCollectionId) missingEnvVars.push('GROUP_MEMBERSHIPS_COLLECTION_ID');
        if (!workflowsCollectionId) missingEnvVars.push('WORKFLOWS_COLLECTION_ID');
        if (!apiKey) missingEnvVars.push('APPWRITE_API_KEY (vagy x-appwrite-key header)');
        if (missingEnvVars.length > 0) {
            error(`[Config] Hiányzó környezeti változók: ${missingEnvVars.join(', ')}`);
            return fail(res, 500, 'misconfigured', { missing: missingEnvVars });
        }

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
                        // workflowId: a 7. lépésben (workflow seeding) töltjük ki
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
            let newOfficeMembershipId;
            try {
                const officeMembershipDoc = await databases.createDocument(
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
                newOfficeMembershipId = officeMembershipDoc.$id;
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

            // 5. groups — 7 alapértelmezett csoport az új szerkesztőséghez
            const createdGroupIds = [];
            try {
                for (const groupDef of DEFAULT_GROUPS) {
                    const groupDoc = await databases.createDocument(
                        databaseId,
                        groupsCollectionId,
                        sdk.ID.unique(),
                        {
                            slug: groupDef.slug,
                            name: groupDef.name,
                            editorialOfficeId: newOfficeId,
                            organizationId: newOrgId,
                            createdByUserId: callerId
                        }
                    );
                    createdGroupIds.push(groupDoc.$id);
                }
            } catch (err) {
                error(`[Bootstrap] groups create hiba (${createdGroupIds.length}/${DEFAULT_GROUPS.length} kész): ${err.message}`);
                // Rollback: groups + officeMembership + office + membership + org
                for (const gId of createdGroupIds) {
                    try { await databases.deleteDocument(databaseId, groupsCollectionId, gId); }
                    catch (e) { error(`[Bootstrap] group rollback sikertelen (${gId}): ${e.message}`); }
                }
                if (newOfficeMembershipId) {
                    try { await databases.deleteDocument(databaseId, officeMembershipsCollectionId, newOfficeMembershipId); }
                    catch (e) { error(`[Bootstrap] officeMembership rollback sikertelen (${newOfficeMembershipId}): ${e.message}`); }
                }
                try { await databases.deleteDocument(databaseId, officesCollectionId, newOfficeId); }
                catch (e) { error(`[Bootstrap] office rollback sikertelen: ${e.message}`); }
                try { await databases.deleteDocument(databaseId, membershipsCollectionId, newMembershipId); }
                catch (e) { error(`[Bootstrap] membership rollback sikertelen: ${e.message}`); }
                try { await databases.deleteDocument(databaseId, organizationsCollectionId, newOrgId); }
                catch (e) { error(`[Bootstrap] org rollback sikertelen: ${e.message}`); }
                return fail(res, 500, 'groups_create_failed');
            }

            // 6. groupMemberships — a bootstrapping user tagja lesz minden csoportnak
            let callerUser;
            try {
                callerUser = await usersApi.get(callerId);
            } catch (e) {
                log(`[Bootstrap] Caller user lookup hiba (groupMemberships userName/userEmail): ${e.message}`);
                callerUser = { name: '', email: '' };
            }

            const createdGroupMembershipIds = [];
            try {
                for (const gId of createdGroupIds) {
                    const gmDoc = await databases.createDocument(
                        databaseId,
                        groupMembershipsCollectionId,
                        sdk.ID.unique(),
                        {
                            groupId: gId,
                            userId: callerId,
                            editorialOfficeId: newOfficeId,
                            organizationId: newOrgId,
                            role: 'member',
                            addedByUserId: callerId,
                            userName: callerUser.name || '',
                            userEmail: callerUser.email || ''
                        }
                    );
                    createdGroupMembershipIds.push(gmDoc.$id);
                }
            } catch (err) {
                error(`[Bootstrap] groupMemberships create hiba (${createdGroupMembershipIds.length}/${createdGroupIds.length} kész): ${err.message}`);
                // Rollback: groupMemberships + groups + előző lépések
                for (const gmId of createdGroupMembershipIds) {
                    try { await databases.deleteDocument(databaseId, groupMembershipsCollectionId, gmId); }
                    catch (e) { error(`[Bootstrap] groupMembership rollback sikertelen (${gmId}): ${e.message}`); }
                }
                for (const gId of createdGroupIds) {
                    try { await databases.deleteDocument(databaseId, groupsCollectionId, gId); }
                    catch (e) { error(`[Bootstrap] group rollback sikertelen (${gId}): ${e.message}`); }
                }
                if (newOfficeMembershipId) {
                    try { await databases.deleteDocument(databaseId, officeMembershipsCollectionId, newOfficeMembershipId); }
                    catch (e) { error(`[Bootstrap] officeMembership rollback sikertelen (${newOfficeMembershipId}): ${e.message}`); }
                }
                try { await databases.deleteDocument(databaseId, officesCollectionId, newOfficeId); }
                catch (e) { error(`[Bootstrap] office rollback sikertelen: ${e.message}`); }
                try { await databases.deleteDocument(databaseId, membershipsCollectionId, newMembershipId); }
                catch (e) { error(`[Bootstrap] membership rollback sikertelen: ${e.message}`); }
                try { await databases.deleteDocument(databaseId, organizationsCollectionId, newOrgId); }
                catch (e) { error(`[Bootstrap] org rollback sikertelen: ${e.message}`); }
                return fail(res, 500, 'group_memberships_create_failed');
            }

            // 7. workflows — alapértelmezett workflow seed az új szerkesztőséghez
            let newWorkflowId = null;
            try {
                const workflowDocId = `wf-${newOfficeId}`;
                const workflowDoc = await databases.createDocument(
                    databaseId,
                    workflowsCollectionId,
                    workflowDocId,
                    {
                        editorialOfficeId: newOfficeId,
                        organizationId: newOrgId,
                        name: 'Alapértelmezett workflow',
                        version: 1,
                        compiled: JSON.stringify(DEFAULT_WORKFLOW),
                        updatedByUserId: callerId
                    }
                );
                newWorkflowId = workflowDoc.$id;

                // Office doc frissítése a workflowId-val
                await databases.updateDocument(
                    databaseId,
                    officesCollectionId,
                    newOfficeId,
                    { workflowId: newWorkflowId }
                );
            } catch (err) {
                // A workflow seeding nem kritikus — az office működik nélküle is,
                // a Plugin/Dashboard fallback-et használ. Logolunk, de nem rollback-elünk.
                error(`[Bootstrap] workflow seed hiba: ${err.message}`);
            }

            log(`[Bootstrap] User ${callerId} új szervezetet hozott létre: org=${newOrgId}, office=${newOfficeId}, groups=${createdGroupIds.length}, memberships=${createdGroupMembershipIds.length}, workflow=${newWorkflowId || 'FAILED'}`);

            return res.json({
                success: true,
                action: 'bootstrapped',
                organizationId: newOrgId,
                editorialOfficeId: newOfficeId,
                groupsSeeded: true,
                workflowSeeded: !!newWorkflowId
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
            } catch (err) {
                if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
                    // Újraolvassuk — a másik kérés már létrehozta
                    const raceWinner = await databases.listDocuments(
                        databaseId,
                        invitesCollectionId,
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
            } catch (err) {
                if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
                    const raceWinner = await databases.listDocuments(
                        databaseId,
                        membershipsCollectionId,
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
                            await databases.updateDocument(databaseId, invitesCollectionId, invite.$id, {
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

        // ════════════════════════════════════════════════════════
        // ACTION = 'add_group_member'
        // ════════════════════════════════════════════════════════
        if (action === 'add_group_member') {
            const { groupId, userId } = payload;
            if (!groupId || !userId) {
                return fail(res, 400, 'missing_fields', { required: ['groupId', 'userId'] });
            }

            // 1. Group lookup — scope feloldás (orgId, officeId)
            let group;
            try {
                group = await databases.getDocument(databaseId, groupsCollectionId, groupId);
            } catch (err) {
                return fail(res, 404, 'group_not_found');
            }

            // 2. Caller jogosultság: org owner/admin
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', group.organizationId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.limit(1)
                ]
            );
            if (callerMembership.documents.length === 0) {
                return fail(res, 403, 'not_a_member');
            }
            const callerRole = callerMembership.documents[0].role;
            if (callerRole !== 'owner' && callerRole !== 'admin') {
                return fail(res, 403, 'insufficient_role', { yourRole: callerRole });
            }

            // 3. Target user lookup — userName/userEmail denormalizálás + aktív/verifikált check
            let targetUser;
            try {
                targetUser = await usersApi.get(userId);
            } catch (err) {
                return fail(res, 404, 'target_user_not_found');
            }

            if (targetUser.status === false) {
                return fail(res, 403, 'target_user_inactive');
            }
            if (!targetUser.emailVerification) {
                return fail(res, 403, 'target_user_not_verified');
            }

            // 4. Target user szerkesztőségi tagság ellenőrzés — csak a group
            //    szerkesztőségéhez tartozó user adható a csoporthoz
            const targetOfficeMembership = await databases.listDocuments(
                databaseId,
                officeMembershipsCollectionId,
                [
                    sdk.Query.equal('editorialOfficeId', group.editorialOfficeId),
                    sdk.Query.equal('userId', userId),
                    sdk.Query.limit(1)
                ]
            );
            if (targetOfficeMembership.documents.length === 0) {
                return fail(res, 403, 'target_user_not_office_member', {
                    editorialOfficeId: group.editorialOfficeId
                });
            }

            // 5. GroupMembership létrehozás (idempotens)
            try {
                const gmDoc = await databases.createDocument(
                    databaseId,
                    groupMembershipsCollectionId,
                    sdk.ID.unique(),
                    {
                        groupId,
                        userId,
                        editorialOfficeId: group.editorialOfficeId,
                        organizationId: group.organizationId,
                        role: 'member',
                        addedByUserId: callerId,
                        userName: targetUser.name || '',
                        userEmail: targetUser.email || ''
                    }
                );
                log(`[AddGroupMember] User ${userId} hozzáadva a group ${groupId}-hoz (${group.slug})`);
                return res.json({
                    success: true,
                    action: 'added',
                    groupMembershipId: gmDoc.$id,
                    groupId,
                    userId
                });
            } catch (err) {
                if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
                    log(`[AddGroupMember] Idempotens — user ${userId} már tagja a group ${groupId}-nak`);
                    return res.json({
                        success: true,
                        action: 'already_member',
                        groupId,
                        userId
                    });
                }
                throw err;
            }
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'remove_group_member'
        // ════════════════════════════════════════════════════════
        if (action === 'remove_group_member') {
            const { groupId, userId } = payload;
            if (!groupId || !userId) {
                return fail(res, 400, 'missing_fields', { required: ['groupId', 'userId'] });
            }

            // 1. Group lookup — scope feloldás
            let group;
            try {
                group = await databases.getDocument(databaseId, groupsCollectionId, groupId);
            } catch (err) {
                return fail(res, 404, 'group_not_found');
            }

            // 2. Caller jogosultság: org owner/admin
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', group.organizationId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.limit(1)
                ]
            );
            if (callerMembership.documents.length === 0) {
                return fail(res, 403, 'not_a_member');
            }
            const callerRole = callerMembership.documents[0].role;
            if (callerRole !== 'owner' && callerRole !== 'admin') {
                return fail(res, 403, 'insufficient_role', { yourRole: callerRole });
            }

            // 3. GroupMembership keresés és törlés
            const existing = await databases.listDocuments(
                databaseId,
                groupMembershipsCollectionId,
                [
                    sdk.Query.equal('groupId', groupId),
                    sdk.Query.equal('userId', userId),
                    sdk.Query.limit(1)
                ]
            );

            if (existing.documents.length === 0) {
                log(`[RemoveGroupMember] Idempotens — user ${userId} nem tagja a group ${groupId}-nak`);
                return res.json({
                    success: true,
                    action: 'already_removed',
                    groupId,
                    userId
                });
            }

            await databases.deleteDocument(databaseId, groupMembershipsCollectionId, existing.documents[0].$id);
            log(`[RemoveGroupMember] User ${userId} eltávolítva a group ${groupId}-ból (${group.slug})`);

            return res.json({
                success: true,
                action: 'removed',
                groupId,
                userId
            });
        }

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
