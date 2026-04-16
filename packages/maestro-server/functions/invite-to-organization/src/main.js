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
 *   ACTION='create_workflow' — admin új workflow-t hoz létre egy szerkesztőség
 *     számára (default workflow klón). A név unique az office-on belül.
 *     - Caller jogosultság: org owner/admin (office → org lookup).
 *     - Payload: { editorialOfficeId, name }
 *     - Return: { success: true, workflowId, name }
 *
 *   ACTION='update_workflow' — admin frissíti a workflow compiled + graph JSON-t.
 *     - Caller jogosultság: org owner/admin (office → org lookup).
 *     - Payload: { editorialOfficeId, compiled, graph, version }
 *     - Optimistic concurrency: doc.version !== payload.version → version_conflict.
 *     - Return: { success: true, version: newVersion }
 *
 *   ACTION='create_editorial_office' — org owner/admin új szerkesztőséget hoz
 *     létre egy meglévő szervezetben. Az action létrehozza a caller-hez tartozó
 *     office-tagságot (admin role), 7 alapértelmezett csoportot, és mindegyikhez
 *     a caller groupMembership-jét. Opcionális `sourceWorkflowId`: ha megadva és
 *     a forrás ugyanabban az org-ban van, a compiled JSON klónozódik egy új
 *     workflow doc-ba az új office alá, és az office.workflowId beáll. Ha nincs
 *     megadva, az office workflow nélkül jön létre — a user a #30 Workflow tab-on
 *     rendelheti hozzá. A slug a névből auto-generálódik (Hungarian transliteráció).
 *     - Payload: { organizationId, name, sourceWorkflowId? }
 *     - Return: { success: true, editorialOfficeId, workflowId, groupsSeeded }
 *
 *   ACTION='delete_editorial_office' — org owner/admin törli a szerkesztőséget
 *     az összes alárendelt publikációval, workflow-val, csoporttal, csoport-
 *     tagsággal és office-tagsággal együtt. A publikációkat doc-onként törli,
 *     így a cascade-delete CF elkapja az event-et és takarítja az articles/
 *     layouts/deadlines (→ validations + thumbnails) rekurzívan.
 *     - Payload: { editorialOfficeId }
 *     - Return: { success: true, deletedCollections: {...} }
 *
 *   ACTION='delete_organization' — kizárólag az org `owner` role-lal
 *     rendelkező tagja törölheti az egész szervezetet. Minden alárendelt
 *     office-ra futtatja a delete_editorial_office kaszkádot, majd takarítja
 *     az organizationInvites + organizationMemberships collectiont, végül az
 *     org dokumentumot.
 *     - Payload: { organizationId }
 *     - Return: { success: true, deletedOffices, officeStats, orgCleanup }
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
 * - PUBLICATIONS_COLLECTION_ID (Fázis 8 — a delete_* action-ökhöz)
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
    'add_group_member', 'remove_group_member',
    'create_workflow', 'update_workflow', 'update_organization',
    'create_editorial_office',
    'delete_organization', 'delete_editorial_office'
]);

// Kaszkád törlés batch mérete — lapozás a nagy dokumentum-mennyiségek kezeléséhez.
const CASCADE_BATCH_LIMIT = 100;

/**
 * Egy collection összes, adott mezőértékhez tartozó dokumentumát törli.
 * Lapozással dolgozik, minden batch-et Promise.allSettled-lel párhuzamosít.
 *
 * **Fail-closed**: ha bármely dokumentum törlése sikertelen, a függvény
 * dob a batch feldolgozás után (miután az összes aktuális batch művelet
 * lefutott — nem „all-or-nothing", hanem „fuss amennyi megy, aztán dobj").
 * Ez garantálja, hogy a hívó NEM törli a szülő doc-ot részleges gyerek
 * cleanup után.
 *
 * @param {sdk.Databases} databases
 * @param {string} databaseId
 * @param {string} collectionId
 * @param {string} fieldName — szűrő mező neve (pl. 'editorialOfficeId')
 * @param {string} fieldValue — szűrő mező értéke
 * @returns {Promise<{ found: number, deleted: number }>}
 * @throws {Error} ha bármely dokumentum törlése sikertelen
 */
async function deleteByQuery(databases, databaseId, collectionId, fieldName, fieldValue) {
    let totalFound = 0;
    let totalDeleted = 0;
    const failures = [];

    while (true) {
        const response = await databases.listDocuments(
            databaseId,
            collectionId,
            [
                sdk.Query.equal(fieldName, fieldValue),
                sdk.Query.limit(CASCADE_BATCH_LIMIT)
            ]
        );
        if (response.documents.length === 0) break;

        totalFound += response.documents.length;

        const deleteResults = await Promise.allSettled(
            response.documents.map(doc =>
                databases.deleteDocument(databaseId, collectionId, doc.$id)
            )
        );

        let batchDeleted = 0;
        for (let i = 0; i < deleteResults.length; i++) {
            const result = deleteResults[i];
            if (result.status === 'fulfilled') {
                batchDeleted++;
            } else {
                failures.push({
                    docId: response.documents[i].$id,
                    message: result.reason?.message || String(result.reason)
                });
            }
        }
        totalDeleted += batchDeleted;

        // Ha egy batch egyetlen törlése sem sikerült, a következő listDocuments
        // ugyanazokat a dokumentumokat adná vissza → végtelen ciklus. Kilépünk,
        // a failures lista lejjebb dob.
        if (batchDeleted === 0) break;

        // Ha az utolsó batch nem telt meg, nincs több dokumentum → kilépünk
        // egy felesleges listDocuments hívás nélkül.
        if (response.documents.length < CASCADE_BATCH_LIMIT) break;
    }

    if (failures.length > 0) {
        const err = new Error(
            `deleteByQuery: ${failures.length}/${totalFound} törlés sikertelen a(z) "${collectionId}" collectionben (${fieldName}=${fieldValue}). Első hiba: ${failures[0].message}`
        );
        err.collectionId = collectionId;
        err.failures = failures;
        throw err;
    }

    return { found: totalFound, deleted: totalDeleted };
}

/**
 * Szerkesztőség-szintű kaszkád törlés — a publikációkat doc-onként törli
 * (a cascade-delete CF kapja el a publication.delete event-et és takarítja
 * az articles/layouts/deadlines-t rekurzívan), a többi office-kötött
 * collectiont pedig deleteByQuery-vel iratja ki.
 *
 * NEM törli magát az office dokumentumot — ezt a hívó intézi, hogy a
 * delete_organization ág is ezen a helper-en keresztül takaríthassa
 * az office-ait a saját lépéseiben.
 *
 * **Fail-closed**: bármely lépés hibája esetén dob, és a hívó NEM
 * törölheti az office doc-ot (különben árva gyerekek maradnának).
 * A hívó responsibility, hogy `try/catch`-el kezelje.
 *
 * @returns {Promise<{ publications, workflows, groups, groupMemberships, officeMemberships }>}
 * @throws {Error} ha bármely gyerek dokumentum törlése sikertelen
 */
async function cascadeDeleteOffice(databases, officeId, env, log) {
    const {
        databaseId,
        publicationsCollectionId,
        workflowsCollectionId,
        groupsCollectionId,
        groupMembershipsCollectionId,
        officeMembershipsCollectionId
    } = env;

    // 1) Publikációk — doc-onkénti deleteDocument, hogy a cascade-delete CF
    //    kapja el a publication.delete event-et (articles → layouts → deadlines,
    //    majd article.delete → validations + thumbnails).
    //
    //    Fail-closed: az első sikertelen törlés után azonnal dobunk —
    //    a részleges törlés nem vezethet árva office-szintű cleanup-hoz.
    let pubFound = 0;
    let pubDeleted = 0;
    while (true) {
        const response = await databases.listDocuments(
            databaseId,
            publicationsCollectionId,
            [
                sdk.Query.equal('editorialOfficeId', officeId),
                sdk.Query.limit(CASCADE_BATCH_LIMIT)
            ]
        );
        if (response.documents.length === 0) break;

        pubFound += response.documents.length;

        // Szekvenciális törlés — a cascade-delete CF nehéz munka, ne indítsuk
        // egyszerre 100 párhuzamos kaszkádot, az rate limit-be futna.
        // Az első hiba → throw (fail-closed).
        for (const doc of response.documents) {
            try {
                await databases.deleteDocument(databaseId, publicationsCollectionId, doc.$id);
                pubDeleted++;
            } catch (err) {
                const wrapped = new Error(
                    `cascadeDeleteOffice: publikáció ${doc.$id} ("${doc.name || '?'}") törlése sikertelen: ${err.message}`
                );
                wrapped.cause = err;
                wrapped.collectionId = publicationsCollectionId;
                wrapped.docId = doc.$id;
                throw wrapped;
            }
        }

        if (response.documents.length < CASCADE_BATCH_LIMIT) break;
    }

    // 2) A többi office-kötött collection — parallel deleteByQuery.
    //    Promise.all: ha bármelyik dob, a többi in-flight is befejeződik,
    //    de a wrapper rejection propagál, és NEM jutunk el az office doc
    //    törléséhez.
    const [workflows, groups, groupMemberships, officeMemberships] = await Promise.all([
        deleteByQuery(databases, databaseId, workflowsCollectionId, 'editorialOfficeId', officeId),
        deleteByQuery(databases, databaseId, groupsCollectionId, 'editorialOfficeId', officeId),
        deleteByQuery(databases, databaseId, groupMembershipsCollectionId, 'editorialOfficeId', officeId),
        deleteByQuery(databases, databaseId, officeMembershipsCollectionId, 'editorialOfficeId', officeId)
    ]);

    log(`[CascadeOffice ${officeId}] pubs=${pubDeleted}/${pubFound}, workflows=${workflows.deleted}/${workflows.found}, groups=${groups.deleted}/${groups.found}, groupMemberships=${groupMemberships.deleted}/${groupMemberships.found}, officeMemberships=${officeMemberships.deleted}/${officeMemberships.found}`);

    return {
        publications: { found: pubFound, deleted: pubDeleted },
        workflows,
        groups,
        groupMemberships,
        officeMemberships
    };
}

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
 * Hungarian ékezetes karakterek ASCII-ra fordítása a slug-képzéshez.
 */
const HUN_ACCENT_MAP = {
    'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ö': 'o', 'ő': 'o',
    'ú': 'u', 'ü': 'u', 'ű': 'u'
};

/**
 * Egyszerű slugify: kisbetű, magyar transliteráció, nem-alfanumerikus → '-',
 * több kötőjel egyesítve, végek levágva, SLUG_MAX_LENGTH-ra vágva.
 * Ha a kimenet üres vagy nem felel meg SLUG_REGEX-nek, random fallback-et ad.
 */
function slugifyName(name) {
    const lower = String(name).toLowerCase();
    const trans = lower.replace(/[áéíóöőúüű]/g, ch => HUN_ACCENT_MAP[ch] || ch);
    const base = trans.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const truncated = base.slice(0, SLUG_MAX_LENGTH);
    if (!truncated || !SLUG_REGEX.test(truncated)) {
        return `office-${crypto.randomBytes(3).toString('hex')}`;
    }
    return truncated;
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
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
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
        // Fázis 8 — a delete_organization / delete_editorial_office action-ök
        // igénylik a publications collectiont (doc-onként deleteDocument, hogy
        // a cascade-delete CF elkapja a publication.delete event-et). Ez csak
        // a delete ágakban kötelező — NEM tesszük a globális guard-ba, hogy a
        // meglévő action-ök (bootstrap/invite/workflow) tovább működjenek, ha
        // az env var még nincs beállítva a Console-on.
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;

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

        // ════════════════════════════════════════════════════════
        // ACTION = 'create_workflow'
        // ════════════════════════════════════════════════════════
        //
        // Új workflow létrehozása egy meglévő szerkesztőséghez. Owner/admin only.
        // A Dashboard Workflow Designer „+ Új workflow" gombja hívja.
        if (action === 'create_workflow') {
            const { editorialOfficeId } = payload;
            const sanitizedName = sanitizeString(payload.name, NAME_MAX_LENGTH);

            if (!editorialOfficeId || !sanitizedName) {
                return fail(res, 400, 'missing_fields', {
                    required: ['editorialOfficeId', 'name']
                });
            }

            // 1. Office lookup → organizationId
            let office;
            try {
                office = await databases.listDocuments(
                    databaseId,
                    officesCollectionId,
                    [
                        sdk.Query.equal('$id', editorialOfficeId),
                        sdk.Query.limit(1)
                    ]
                );
            } catch (err) {
                return fail(res, 404, 'office_not_found');
            }
            if (office.documents.length === 0) {
                return fail(res, 404, 'office_not_found');
            }
            const orgId = office.documents[0].organizationId;

            // 2. Caller jogosultság: org owner/admin
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', orgId),
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

            // 3. Név unique check az office-on belül
            const nameClash = await databases.listDocuments(
                databaseId,
                workflowsCollectionId,
                [
                    sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                    sdk.Query.equal('name', sanitizedName),
                    sdk.Query.limit(1)
                ]
            );
            if (nameClash.documents.length > 0) {
                return fail(res, 400, 'name_taken', { name: sanitizedName });
            }

            // 4. Compiled JSON: default workflow klón, de frissen version=1
            const compiledClone = JSON.parse(JSON.stringify(DEFAULT_WORKFLOW));
            compiledClone.version = 1;

            // 5. Workflow doc létrehozás — az ID automatikus (nem `wf-${officeId}`,
            // mert egy office-on belül több workflow is létezhet)
            let newWorkflowDoc;
            try {
                newWorkflowDoc = await databases.createDocument(
                    databaseId,
                    workflowsCollectionId,
                    sdk.ID.unique(),
                    {
                        editorialOfficeId,
                        organizationId: orgId,
                        name: sanitizedName,
                        version: 1,
                        compiled: JSON.stringify(compiledClone),
                        updatedByUserId: callerId
                    }
                );
            } catch (createErr) {
                error(`[CreateWorkflow] createDocument hiba: ${createErr.message}`);
                return fail(res, 500, 'create_failed');
            }

            log(`[CreateWorkflow] User ${callerId} új workflow-t hozott létre: id=${newWorkflowDoc.$id}, name="${sanitizedName}", office=${editorialOfficeId}`);

            return res.json({
                success: true,
                action: 'created',
                workflowId: newWorkflowDoc.$id,
                name: sanitizedName
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'create_editorial_office'
        // ════════════════════════════════════════════════════════
        //
        // Új szerkesztőség létrehozása egy meglévő szervezeten belül.
        // A bootstrap_organization 3–7. lépéseit replikálja (office doc +
        // officeMembership admin role + 7 default group + caller groupMembership-k
        // + opcionális workflow klón), külön org létrehozás nélkül.
        //
        // Caller: a szervezet `owner` vagy `admin` role-lal rendelkező tagja.
        //
        // Rollback: minden lépés hibája esetén a korábbi rekordokat best-effort
        // visszatöröljük (mint a bootstrap_organization).
        if (action === 'create_editorial_office') {
            const { organizationId } = payload;
            const sanitizedName = sanitizeString(payload.name, NAME_MAX_LENGTH);
            const sourceWorkflowId = typeof payload.sourceWorkflowId === 'string' && payload.sourceWorkflowId
                ? payload.sourceWorkflowId
                : null;

            if (!organizationId || !sanitizedName) {
                return fail(res, 400, 'missing_fields', {
                    required: ['organizationId', 'name']
                });
            }

            // 1. Caller jogosultság — org owner/admin.
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.select(['role']),
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

            // 2. Opcionális workflow forrás validáció — még az office létrehozás
            //    ELŐTT, hogy invalid source esetén ne kelljen rollback-elni.
            let sourceWorkflowDoc = null;
            if (sourceWorkflowId) {
                try {
                    sourceWorkflowDoc = await databases.getDocument(
                        databaseId,
                        workflowsCollectionId,
                        sourceWorkflowId
                    );
                } catch (err) {
                    if (err?.code === 404) return fail(res, 404, 'source_workflow_not_found');
                    error(`[CreateOffice] source workflow fetch hiba: ${err.message}`);
                    return fail(res, 500, 'source_workflow_fetch_failed');
                }
                if (sourceWorkflowDoc.organizationId !== organizationId) {
                    return fail(res, 403, 'source_workflow_scope_mismatch');
                }
            }

            // 3. Office létrehozás — slug auto-generálás + ütközéskor retry
            //    random suffix-szel. Max 3 próba.
            const baseSlug = slugifyName(sanitizedName);
            let newOfficeId = null;
            let usedSlug = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                const candidateSlug = attempt === 0
                    ? baseSlug
                    : `${baseSlug.slice(0, SLUG_MAX_LENGTH - 5)}-${crypto.randomBytes(2).toString('hex')}`;
                try {
                    const officeDoc = await databases.createDocument(
                        databaseId,
                        officesCollectionId,
                        sdk.ID.unique(),
                        {
                            organizationId,
                            name: sanitizedName,
                            slug: candidateSlug
                        }
                    );
                    newOfficeId = officeDoc.$id;
                    usedSlug = candidateSlug;
                    break;
                } catch (err) {
                    const isUnique = err?.type === 'document_already_exists' || /unique/i.test(err?.message || '');
                    if (isUnique && attempt < 2) continue;
                    error(`[CreateOffice] office create hiba (slug=${candidateSlug}, attempt=${attempt}): ${err.message}`);
                    if (isUnique) return fail(res, 409, 'office_slug_taken');
                    return fail(res, 500, 'office_create_failed');
                }
            }

            // 4. officeMembership — admin role a caller-hez.
            let newOfficeMembershipId = null;
            try {
                const memDoc = await databases.createDocument(
                    databaseId,
                    officeMembershipsCollectionId,
                    sdk.ID.unique(),
                    {
                        editorialOfficeId: newOfficeId,
                        organizationId,
                        userId: callerId,
                        role: 'admin'
                    }
                );
                newOfficeMembershipId = memDoc.$id;
            } catch (err) {
                error(`[CreateOffice] officeMembership create hiba: ${err.message}`);
                try { await databases.deleteDocument(databaseId, officesCollectionId, newOfficeId); }
                catch (e) { error(`[CreateOffice] office rollback sikertelen: ${e.message}`); }
                return fail(res, 500, 'office_membership_create_failed');
            }

            // 5. 7 default group az új office-hoz.
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
                            organizationId,
                            createdByUserId: callerId
                        }
                    );
                    createdGroupIds.push(groupDoc.$id);
                }
            } catch (err) {
                error(`[CreateOffice] groups create hiba (${createdGroupIds.length}/${DEFAULT_GROUPS.length} kész): ${err.message}`);
                for (const gId of createdGroupIds) {
                    try { await databases.deleteDocument(databaseId, groupsCollectionId, gId); }
                    catch (e) { error(`[CreateOffice] group rollback sikertelen (${gId}): ${e.message}`); }
                }
                try { await databases.deleteDocument(databaseId, officeMembershipsCollectionId, newOfficeMembershipId); }
                catch (e) { error(`[CreateOffice] officeMembership rollback sikertelen: ${e.message}`); }
                try { await databases.deleteDocument(databaseId, officesCollectionId, newOfficeId); }
                catch (e) { error(`[CreateOffice] office rollback sikertelen: ${e.message}`); }
                return fail(res, 500, 'groups_create_failed');
            }

            // 6. groupMemberships — a caller tagja lesz mindegyiknek.
            let callerUser;
            try {
                callerUser = await usersApi.get(callerId);
            } catch (e) {
                log(`[CreateOffice] Caller user lookup hiba (groupMemberships userName/userEmail): ${e.message}`);
                callerUser = { name: '', email: '' };
            }

            const createdGmIds = [];
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
                            organizationId,
                            role: 'member',
                            addedByUserId: callerId,
                            userName: callerUser.name || '',
                            userEmail: callerUser.email || ''
                        }
                    );
                    createdGmIds.push(gmDoc.$id);
                }
            } catch (err) {
                error(`[CreateOffice] groupMemberships create hiba (${createdGmIds.length}/${createdGroupIds.length} kész): ${err.message}`);
                for (const gmId of createdGmIds) {
                    try { await databases.deleteDocument(databaseId, groupMembershipsCollectionId, gmId); }
                    catch (e) { error(`[CreateOffice] groupMembership rollback sikertelen (${gmId}): ${e.message}`); }
                }
                for (const gId of createdGroupIds) {
                    try { await databases.deleteDocument(databaseId, groupsCollectionId, gId); }
                    catch (e) { error(`[CreateOffice] group rollback sikertelen (${gId}): ${e.message}`); }
                }
                try { await databases.deleteDocument(databaseId, officeMembershipsCollectionId, newOfficeMembershipId); }
                catch (e) { error(`[CreateOffice] officeMembership rollback sikertelen: ${e.message}`); }
                try { await databases.deleteDocument(databaseId, officesCollectionId, newOfficeId); }
                catch (e) { error(`[CreateOffice] office rollback sikertelen: ${e.message}`); }
                return fail(res, 500, 'group_memberships_create_failed');
            }

            // 7. Opcionális workflow klón. Nem kritikus — ha elhasal, az office
            //    workflow nélkül marad (felhasználó később #30-ban rendelhet hozzá).
            let newWorkflowId = null;
            if (sourceWorkflowDoc) {
                try {
                    const workflowDoc = await databases.createDocument(
                        databaseId,
                        workflowsCollectionId,
                        sdk.ID.unique(),
                        {
                            editorialOfficeId: newOfficeId,
                            organizationId,
                            name: sourceWorkflowDoc.name || 'Alapértelmezett workflow',
                            version: 1,
                            compiled: typeof sourceWorkflowDoc.compiled === 'string'
                                ? sourceWorkflowDoc.compiled
                                : JSON.stringify(sourceWorkflowDoc.compiled),
                            updatedByUserId: callerId
                        }
                    );
                    newWorkflowId = workflowDoc.$id;
                    await databases.updateDocument(
                        databaseId,
                        officesCollectionId,
                        newOfficeId,
                        { workflowId: newWorkflowId }
                    );
                } catch (err) {
                    error(`[CreateOffice] workflow klón hiba: ${err.message}`);
                }
            }

            log(`[CreateOffice] User ${callerId} új office-t hozott létre: id=${newOfficeId} ("${sanitizedName}", slug=${usedSlug}), org=${organizationId}, groups=${createdGroupIds.length}, memberships=${createdGmIds.length}, workflow=${newWorkflowId || 'none'}`);

            return res.json({
                success: true,
                action: 'created',
                editorialOfficeId: newOfficeId,
                organizationId,
                name: sanitizedName,
                slug: usedSlug,
                workflowId: newWorkflowId,
                groupsSeeded: createdGroupIds.length,
                workflowSeeded: !!newWorkflowId
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'update_workflow'
        // ════════════════════════════════════════════════════════
        //
        // Workflow compiled + graph JSON frissítése optimistic concurrency-vel.
        // A Dashboard Workflow Designer hívja mentéskor.
        //
        // Opcionális `workflowId`: ha meg van adva, a konkrét doc-ot célozza
        // (multi-workflow support). Ha nincs, az office első workflow-ját módosítja
        // (backward compat — bootstrap scenariókhoz).
        // Opcionális `name`: workflow átnevezés (unique check az office-on belül).
        if (action === 'update_workflow') {
            const { editorialOfficeId, workflowId, compiled, graph, version } = payload;
            const renameTo = payload.name !== undefined
                ? sanitizeString(payload.name, NAME_MAX_LENGTH)
                : null;

            if (!editorialOfficeId || !compiled || version == null) {
                return fail(res, 400, 'missing_fields', {
                    required: ['editorialOfficeId', 'compiled', 'version']
                });
            }
            if (payload.name !== undefined && !renameTo) {
                return fail(res, 400, 'invalid_name');
            }

            // 1. Office lookup → organizationId
            let office;
            try {
                office = await databases.listDocuments(
                    databaseId,
                    officesCollectionId,
                    [
                        sdk.Query.equal('$id', editorialOfficeId),
                        sdk.Query.limit(1)
                    ]
                );
            } catch (err) {
                return fail(res, 404, 'office_not_found');
            }
            if (office.documents.length === 0) {
                return fail(res, 404, 'office_not_found');
            }
            const orgId = office.documents[0].organizationId;

            // 2. Caller jogosultság: org owner/admin
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', orgId),
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

            // 3. Workflow doc betöltés — elsődleges: explicit workflowId,
            // fallback: office első workflow-ja (backward compat).
            let workflowDoc;
            if (workflowId) {
                try {
                    workflowDoc = await databases.getDocument(
                        databaseId,
                        workflowsCollectionId,
                        workflowId
                    );
                } catch (err) {
                    return fail(res, 404, 'workflow_not_found');
                }
                // Cross-tenant scope check — a payload officeId-nak egyeznie
                // kell a doc editorialOfficeId-jával.
                if (workflowDoc.editorialOfficeId !== editorialOfficeId) {
                    return fail(res, 403, 'scope_mismatch');
                }
            } else {
                const workflowResult = await databases.listDocuments(
                    databaseId,
                    workflowsCollectionId,
                    [
                        sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                        sdk.Query.limit(1)
                    ]
                );
                if (workflowResult.documents.length === 0) {
                    return fail(res, 404, 'workflow_not_found');
                }
                workflowDoc = workflowResult.documents[0];
            }

            // 4. Optimistic concurrency check
            const currentCompiled = typeof workflowDoc.compiled === 'string'
                ? JSON.parse(workflowDoc.compiled)
                : workflowDoc.compiled;
            const currentVersion = currentCompiled?.version ?? workflowDoc.version ?? 1;

            if (currentVersion !== version) {
                return fail(res, 409, 'version_conflict', {
                    currentVersion,
                    requestedVersion: version
                });
            }

            // 5. Rename unique check (csak ha változik)
            if (renameTo && renameTo !== workflowDoc.name) {
                const nameClash = await databases.listDocuments(
                    databaseId,
                    workflowsCollectionId,
                    [
                        sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                        sdk.Query.equal('name', renameTo),
                        sdk.Query.limit(1)
                    ]
                );
                const clashDoc = nameClash.documents[0];
                if (clashDoc && clashDoc.$id !== workflowDoc.$id) {
                    return fail(res, 400, 'name_taken', { name: renameTo });
                }
            }

            // 6. Compiled JSON frissítése a verzióval
            const newVersion = currentVersion + 1;
            const updatedCompiled = typeof compiled === 'string'
                ? JSON.parse(compiled)
                : compiled;
            updatedCompiled.version = newVersion;

            const updateData = {
                compiled: JSON.stringify(updatedCompiled),
                updatedByUserId: callerId
            };
            if (graph !== undefined) {
                updateData.graph = typeof graph === 'string' ? graph : JSON.stringify(graph);
            }
            if (renameTo && renameTo !== workflowDoc.name) {
                updateData.name = renameTo;
            }

            await databases.updateDocument(
                databaseId,
                workflowsCollectionId,
                workflowDoc.$id,
                updateData
            );

            log(`[UpdateWorkflow] Workflow ${workflowDoc.$id} (office ${editorialOfficeId}) frissítve: v${currentVersion} → v${newVersion}${renameTo && renameTo !== workflowDoc.name ? `, név: "${workflowDoc.name}" → "${renameTo}"` : ''} (by ${callerId})`);

            return res.json({
                success: true,
                version: newVersion,
                workflowId: workflowDoc.$id,
                name: renameTo || workflowDoc.name
            });
        }

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'update_organization'
        // ════════════════════════════════════════════════════════════════
        if (action === 'update_organization') {
            const { organizationId, name } = payload;

            if (!organizationId || !name) {
                return fail(res, 400, 'missing_fields', {
                    required: ['organizationId', 'name']
                });
            }

            const sanitizedName = sanitizeString(name, NAME_MAX_LENGTH);
            if (!sanitizedName) {
                return fail(res, 400, 'invalid_name');
            }

            // Caller jogosultság: org owner/admin
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
                return fail(res, 403, 'not_a_member');
            }

            const callerRole = callerMembership.documents[0].role;
            if (callerRole !== 'owner' && callerRole !== 'admin') {
                return fail(res, 403, 'insufficient_role', { yourRole: callerRole });
            }

            // Org dokumentum frissítése
            try {
                await databases.updateDocument(
                    databaseId,
                    organizationsCollectionId,
                    organizationId,
                    { name: sanitizedName }
                );
            } catch (updateErr) {
                error(`[UpdateOrg] updateDocument hiba: ${updateErr.message}`);
                return fail(res, 500, 'update_failed');
            }

            log(`[UpdateOrg] User ${callerId} átnevezte org ${organizationId} → "${sanitizedName}"`);

            return res.json({
                success: true,
                action: 'updated',
                organizationId,
                name: sanitizedName
            });
        }

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'delete_editorial_office'
        // ════════════════════════════════════════════════════════════════
        //
        // Szerkesztőség kaszkád törlés: publications (→ cascade-delete CF
        // takarítja az articles/layouts/deadlines-t), workflows, groups,
        // groupMemberships, editorialOfficeMemberships, majd maga az office.
        //
        // Caller: a szervezet `owner` vagy `admin` role-lal rendelkező tagja.
        //
        // Fail-closed: ha bármely gyerek cleanup-lépés elhasal, az office
        // dokumentumot NEM töröljük — inkább árva gyerek nélküli retry,
        // mint elveszett tulajdonosi lánc.
        if (action === 'delete_editorial_office') {
            // Delete action-szintű env var guard — a PUBLICATIONS_COLLECTION_ID
            // csak ehhez az action-höz kell, ne blokkolja a többi flow-t.
            if (!publicationsCollectionId) {
                error('[DeleteOffice] PUBLICATIONS_COLLECTION_ID nincs beállítva.');
                return fail(res, 500, 'misconfigured', { missing: ['PUBLICATIONS_COLLECTION_ID'] });
            }

            const { editorialOfficeId } = payload;
            if (!editorialOfficeId || typeof editorialOfficeId !== 'string') {
                return fail(res, 400, 'missing_fields', { required: ['editorialOfficeId'] });
            }

            // 1) Office létezés check
            let officeDoc;
            try {
                officeDoc = await databases.getDocument(
                    databaseId,
                    officesCollectionId,
                    editorialOfficeId
                );
            } catch (fetchErr) {
                if (fetchErr.code === 404) return fail(res, 404, 'office_not_found');
                error(`[DeleteOffice] getDocument hiba: ${fetchErr.message}`);
                return fail(res, 500, 'office_fetch_failed');
            }

            const officeOrgId = officeDoc.organizationId;

            // 2) Caller jogosultság — org owner/admin
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', officeOrgId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.select(['role']),
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

            // 3) Kaszkád takarítás a helper-rel — fail-closed.
            const envIds = {
                databaseId,
                publicationsCollectionId,
                workflowsCollectionId,
                groupsCollectionId,
                groupMembershipsCollectionId,
                officeMembershipsCollectionId
            };

            let stats;
            try {
                stats = await cascadeDeleteOffice(databases, editorialOfficeId, envIds, log);
            } catch (cascadeErr) {
                error(`[DeleteOffice] Kaszkád hiba (${editorialOfficeId}) [collection=${cascadeErr.collectionId || 'n/a'}]: ${cascadeErr.message}`);
                return fail(res, 500, 'cascade_failed', {
                    message: cascadeErr.message
                });
            }

            // 4) Az office dokumentum törlése — csak akkor, ha minden gyerek
            //    cleanup sikeres volt.
            try {
                await databases.deleteDocument(databaseId, officesCollectionId, editorialOfficeId);
            } catch (deleteErr) {
                error(`[DeleteOffice] office doc törlés: ${deleteErr.message}`);
                return fail(res, 500, 'office_delete_failed');
            }

            log(`[DeleteOffice] User ${callerId} törölte office ${editorialOfficeId} ("${officeDoc.name}") + kaszkád`);

            return res.json({
                success: true,
                action: 'deleted',
                editorialOfficeId,
                deletedCollections: stats
            });
        }

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'delete_organization'
        // ════════════════════════════════════════════════════════════════
        //
        // Szervezet kaszkád törlés: minden alárendelt office-ot végigvesz
        // (→ cascadeDeleteOffice), majd az org-szintű collection-öket
        // (organizationInvites, organizationMemberships), végül az org-ot.
        //
        // Caller: kizárólag a szervezet `owner` role-lal rendelkező tagja
        // (admin NEM törölhet org-ot — ez szándékos, magas blast radius).
        //
        // Fail-closed: ha bármely office kaszkád hibát dob, azonnal leállunk,
        // és NEM nyúlunk az org-szintű cleanup-hoz vagy az org doc-hoz.
        // A részleges törlés után a user retry-olhat (idempotens), vagy a
        // maradék árva office-t az Appwrite Console-ból takaríthatja.
        if (action === 'delete_organization') {
            // Delete action-szintű env var guard — lásd delete_editorial_office.
            if (!publicationsCollectionId) {
                error('[DeleteOrg] PUBLICATIONS_COLLECTION_ID nincs beállítva.');
                return fail(res, 500, 'misconfigured', { missing: ['PUBLICATIONS_COLLECTION_ID'] });
            }

            const { organizationId } = payload;
            if (!organizationId || typeof organizationId !== 'string') {
                return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
            }

            // 1) Org létezés check
            let orgDoc;
            try {
                orgDoc = await databases.getDocument(
                    databaseId,
                    organizationsCollectionId,
                    organizationId
                );
            } catch (fetchErr) {
                if (fetchErr.code === 404) return fail(res, 404, 'organization_not_found');
                error(`[DeleteOrg] getDocument hiba: ${fetchErr.message}`);
                return fail(res, 500, 'organization_fetch_failed');
            }

            // 2) Caller jogosultság — owner-only
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.select(['role']),
                    sdk.Query.limit(1)
                ]
            );
            if (callerMembership.documents.length === 0) {
                return fail(res, 403, 'not_a_member');
            }
            const callerRole = callerMembership.documents[0].role;
            if (callerRole !== 'owner') {
                return fail(res, 403, 'insufficient_role', {
                    yourRole: callerRole,
                    required: 'owner'
                });
            }

            const envIds = {
                databaseId,
                publicationsCollectionId,
                workflowsCollectionId,
                groupsCollectionId,
                groupMembershipsCollectionId,
                officeMembershipsCollectionId
            };

            // 3) Lapozott office-törlés: a következő batch-et mindig frissen
            //    listázzuk, így (a) nem kell tudni előre, hány office van, és
            //    (b) az imént törölt office-ok már nem szerepelnek a listában,
            //    tehát a ciklus természetesen kiürül. Fail-closed: az első
            //    office kaszkád hiba dobja a futást.
            const officeStats = [];
            while (true) {
                let officesBatch;
                try {
                    const response = await databases.listDocuments(
                        databaseId,
                        officesCollectionId,
                        [
                            sdk.Query.equal('organizationId', organizationId),
                            sdk.Query.limit(CASCADE_BATCH_LIMIT)
                        ]
                    );
                    officesBatch = response.documents;
                } catch (listErr) {
                    error(`[DeleteOrg] office listing: ${listErr.message}`);
                    return fail(res, 500, 'office_list_failed', { message: listErr.message });
                }

                if (officesBatch.length === 0) break;

                for (const office of officesBatch) {
                    let stats;
                    try {
                        stats = await cascadeDeleteOffice(databases, office.$id, envIds, log);
                    } catch (cascadeErr) {
                        error(`[DeleteOrg] office ${office.$id} ("${office.name}") kaszkád hiba [collection=${cascadeErr.collectionId || 'n/a'}]: ${cascadeErr.message}`);
                        return fail(res, 500, 'cascade_failed', {
                            message: cascadeErr.message,
                            officeId: office.$id,
                            completedOffices: officeStats
                        });
                    }

                    try {
                        await databases.deleteDocument(databaseId, officesCollectionId, office.$id);
                    } catch (deleteErr) {
                        error(`[DeleteOrg] office doc ${office.$id} törlés: ${deleteErr.message}`);
                        return fail(res, 500, 'office_delete_failed', {
                            officeId: office.$id,
                            message: deleteErr.message,
                            completedOffices: officeStats
                        });
                    }

                    officeStats.push({ officeId: office.$id, name: office.name, stats });
                }

                if (officesBatch.length < CASCADE_BATCH_LIMIT) break;
            }

            // 4) Invites takarítás (a memberships-et NEM itt — lásd lentebb).
            //    Az invites doksik törlése nem befolyásolja a caller retry
            //    képességét (a caller jog `organizationMemberships`-ből jön),
            //    ezért biztonsággal előre vehetők.
            let invitesCleanup;
            try {
                invitesCleanup = await deleteByQuery(databases, databaseId, invitesCollectionId, 'organizationId', organizationId);
            } catch (cleanupErr) {
                error(`[DeleteOrg] invites cleanup: ${cleanupErr.message}`);
                return fail(res, 500, 'org_cleanup_failed', { message: cleanupErr.message });
            }

            // 5) Org dokumentum törlése — a memberships ELŐTT.
            //    Ha a memberships-et előbb törölnénk és ez a lépés elhasalna,
            //    a caller elvesztené a `owner` membership-ét és a retry
            //    `not_a_member` hibával elakadna → árva szervezet. Az org doc
            //    törlés után a caller membership-e redundáns (az org már nem
            //    létezik), így a cleanup sikertelensége csak kozmetikus
            //    inkonzisztenciát hagy.
            try {
                await databases.deleteDocument(databaseId, organizationsCollectionId, organizationId);
            } catch (deleteErr) {
                error(`[DeleteOrg] org doc törlés: ${deleteErr.message}`);
                return fail(res, 500, 'organization_delete_failed');
            }

            // 6) Memberships takarítás — az org doc már nincs, a caller
            //    membership-e már nem ad semmilyen retry-lehetőséget.
            //    Ha ez elbukik, a maradék memberships árvák maradnak
            //    (nem létező orgId-ra mutatnak), manuális cleanup kell.
            let membershipsCleanup;
            try {
                membershipsCleanup = await deleteByQuery(databases, databaseId, membershipsCollectionId, 'organizationId', organizationId);
            } catch (cleanupErr) {
                error(`[DeleteOrg] memberships cleanup az org doc törlése után elbukott: ${cleanupErr.message}`);
                // Ponton a szervezet már törölve van — a user-nek nem dobunk
                // hibát, csak hard log-ba tesszük a failure-t, hogy az ops
                // oldalon észrevehető legyen.
                membershipsCleanup = { found: null, deleted: null, error: cleanupErr.message };
            }
            const orgCleanup = { invites: invitesCleanup, memberships: membershipsCleanup };

            log(`[DeleteOrg] User ${callerId} törölte org ${organizationId} ("${orgDoc.name}") — ${officeStats.length} office kaszkád + org cleanup`);

            return res.json({
                success: true,
                action: 'deleted',
                organizationId,
                deletedOffices: officeStats.length,
                officeStats,
                orgCleanup
            });
        }

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
