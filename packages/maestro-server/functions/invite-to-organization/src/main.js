const sdk = require("node-appwrite");
const crypto = require("crypto");
const {
    buildOrgTeamId,
    buildOfficeTeamId,
    buildOrgAclPerms,
    buildOfficeAclPerms,
    buildWorkflowAclPerms,
    ensureTeam,
    ensureTeamMembership,
    removeTeamMembership,
    deleteTeamIfExists
} = require("./teamHelpers.js");

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
 *     létrehozott rekordokat visszatörli (best-effort). Idempotens: ha a
 *     caller már tagja egy orgnak, az existing rekordot adja vissza.
 *
 *   ACTION='create_organization' — ugyanaz a 7 lépéses create logika, de
 *     az idempotencia check kihagyva (#40, avatar dropdown „Új szervezet…").
 *     A user explicit új szervezetet akar, miközben már tagja egy meglévőnek.
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
 *   ACTION='update_editorial_office' — org owner/admin átnevezi a szerkesztőséget.
 *     A slug változatlan marad (stabilitás: office slug cikkek és publikációk
 *     nem követik). Uniqueness check: ugyanazon org-on belül nem lehet két
 *     azonos megjelenítendő nevű office.
 *     - Payload: { editorialOfficeId, name }
 *     - Return: { success: true, editorialOfficeId, name }
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
 * - PERMISSION_SETS_COLLECTION_ID (A.1 / ADR 0008 — csak a
 *   `bootstrap_permission_sets_schema` action-höz)
 * - GROUP_PERMISSION_SETS_COLLECTION_ID (A.1 / ADR 0008 — csak a
 *   `bootstrap_permission_sets_schema` action-höz)
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
    'bootstrap_organization', 'create_organization', 'create', 'accept',
    'list_my_invites', 'decline_invite', 'leave_organization',
    'add_group_member', 'remove_group_member',
    'create_group', 'rename_group', 'delete_group',
    'bootstrap_workflow_schema',
    'bootstrap_publication_schema',
    'bootstrap_permission_sets_schema',
    'create_workflow', 'update_workflow',
    'update_workflow_metadata',
    'delete_workflow', 'duplicate_workflow',
    'archive_workflow', 'restore_workflow',
    'update_organization',
    'create_editorial_office', 'update_editorial_office',
    'delete_organization', 'delete_editorial_office',
    'backfill_tenant_acl'
]);

// Workflow láthatóság enum — Feladat #80 (2026-04-20) óta 3-way: a `public`
// scope-pal a workflow a teljes platformon elérhető (minden authentikált
// user láthatja). A 2-way MVP (#30) `editorial_office` / `organization`
// szemantikája változatlan.
const WORKFLOW_VISIBILITY_VALUES = ['organization', 'editorial_office', 'public'];
const WORKFLOW_VISIBILITY_DEFAULT = 'editorial_office';

// Kaszkád törlés batch mérete — lapozás a nagy dokumentum-mennyiségek kezeléséhez.
const CASCADE_BATCH_LIMIT = 100;

// Scan-eredmény felső korlát forrásonként (delete_group referencia-check).
// Ha egy scan eléri, a hátralévő lapokat nem olvassuk — az admin UI-nak ennyi
// példa bőven elég a "használatban van" állapot érzékeltetéséhez, és a payload
// + memória bounded marad pathologikus (tízezer+ hivatkozás) esetekben is.
const MAX_REFERENCES_PER_SCAN = 50;

/**
 * Workflow doc létrehozás a #30-as mezőkkel (`visibility`, `createdBy`) és
 * #80 doc-szintű ACL-lel, schema-safe fallback-kel. Ha a
 * `bootstrap_workflow_schema` még nem futott le egy upgrade alatt álló
 * env-ben, az Appwrite `document_invalid_structure` (400) hibát dob az új
 * mezőkre — ilyenkor a helper a mezők nélkül retry-ol, hogy a seed +
 * interaktív create/duplicate flow ne essen ki (legacy kompatibilitás).
 *
 * Rollout-biztonság (#30 harden P1). A `visibility` paraméter kötelező, hogy
 * a hívó (seed: default; interaktív create: user-whitelisted; duplicate:
 * forrásról öröklött + fallback) adja, a `createdBy` mindig a callerId.
 *
 * A fallback CSAK a default visibility-re megengedett (null → `editorial_office`
 * olvasási szemantika: nincs adatvesztés). Ha a hívó `organization` / `public`
 * visibility-t kér és a schema még hiányzik, a hiba propagál — különben a user
 * által kért scope csendben `editorial_office`-ra degradálódna (silent downgrade).
 *
 * **Feladat #80**: `permissions` paraméter — doc-szintű ACL (read:
 * `team:office_${officeId}` / `team:org_${orgId}` / `users` a `visibility`
 * függvényében). A hívó a `buildWorkflowAclPerms(visibility, orgId, officeId)`
 * helperrel állítsa elő. A `rowSecurity: true` collection flag kötelező a
 * `workflows`-on, különben a collection-szintű `read("users")` felülírja.
 */
async function createWorkflowDoc(
    databases, databaseId, workflowsCollectionId, docId, baseFields, visibility, callerId, permissions, log
) {
    try {
        return await databases.createDocument(
            databaseId,
            workflowsCollectionId,
            docId,
            {
                ...baseFields,
                visibility,
                createdBy: callerId
            },
            permissions
        );
    } catch (err) {
        const msg = err?.message || '';
        const isSchemaMissing =
            (err?.type === 'document_invalid_structure' || err?.code === 400)
            && /visibility|createdBy|unknown attribute/i.test(msg);
        if (!isSchemaMissing) {
            throw err;
        }
        if (visibility !== WORKFLOW_VISIBILITY_DEFAULT) {
            // Nem tudjuk biztonságosan elmenteni a nem-default visibility-t —
            // az eredeti hiba terjedjen a hívóra (az `bootstrap_workflow_schema`
            // futtatása után retry-olható).
            throw err;
        }
        log(`[WorkflowDoc] Schema hiányos (visibility/createdBy) — legacy retry without #30 fields. docId=${docId}`);
        return databases.createDocument(
            databaseId,
            workflowsCollectionId,
            docId,
            baseFields,
            permissions
        );
    }
}

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
 * Workflow compiled JSON slug-hivatkozás ellenőrzés a `delete_group` action-höz.
 *
 * A compiled JSON több, eltérő alakú helyen hivatkozhat csoport slug-okra
 * (a defaultWorkflow.json schémája szerint):
 *   - `statePermissions[stateId]: string[]`              (ki mozgathatja onnan)
 *   - `leaderGroups: string[]`                           (ACL bypass)
 *   - `transitions[].allowedGroups: string[]`            (átmenet végrehajtás)
 *   - `commands[stateId][].allowedGroups: string[]`      (parancsok futtatása)
 *   - `elementPermissions[kind][field].groups: string[]` (UI elem szerkesztés,
 *     csak ha type === 'groups' — 'anyMember' / egyéb típusokat átugrunk)
 *   - `contributorGroups: [{ slug, label }]`             (contributor szerepkörök;
 *     tömb stringekből is elfogadott legacy/defensiv okból)
 *   - `capabilities[capId]: string[]`                    (pl. canAddArticlePlan)
 *
 * Bármely match → true. Ismeretlen / hiányzó mezőket csendben átugorjuk, hogy
 * verziózott schema bővítés ne crash-eljen.
 *
 * @param {Object} compiled - parsed workflow compiled JSON
 * @param {string} targetSlug - a törlendő csoport slug-ja
 * @returns {boolean} true, ha a slug bárhol szerepel
 */
function workflowReferencesSlug(compiled, targetSlug) {
    if (!compiled || typeof compiled !== 'object') return false;

    // leaderGroups: string[]
    if (Array.isArray(compiled.leaderGroups) && compiled.leaderGroups.includes(targetSlug)) {
        return true;
    }

    // contributorGroups: [{ slug, label }] — legacy string[] is elfogadott
    if (Array.isArray(compiled.contributorGroups)) {
        for (const entry of compiled.contributorGroups) {
            if (typeof entry === 'string' && entry === targetSlug) return true;
            if (entry && typeof entry === 'object' && entry.slug === targetSlug) return true;
        }
    }

    // statePermissions[stateId]: string[]
    if (compiled.statePermissions && typeof compiled.statePermissions === 'object') {
        for (const slugs of Object.values(compiled.statePermissions)) {
            if (Array.isArray(slugs) && slugs.includes(targetSlug)) return true;
        }
    }

    // transitions[].allowedGroups: string[]
    if (Array.isArray(compiled.transitions)) {
        for (const t of compiled.transitions) {
            if (t && Array.isArray(t.allowedGroups) && t.allowedGroups.includes(targetSlug)) {
                return true;
            }
        }
    }

    // commands[stateId][].allowedGroups: string[]
    if (compiled.commands && typeof compiled.commands === 'object') {
        for (const cmdList of Object.values(compiled.commands)) {
            if (!Array.isArray(cmdList)) continue;
            for (const cmd of cmdList) {
                if (cmd && Array.isArray(cmd.allowedGroups) && cmd.allowedGroups.includes(targetSlug)) {
                    return true;
                }
            }
        }
    }

    // elementPermissions[kind][field]: { type, groups? }
    if (compiled.elementPermissions && typeof compiled.elementPermissions === 'object') {
        for (const kind of Object.values(compiled.elementPermissions)) {
            if (!kind || typeof kind !== 'object') continue;
            for (const descriptor of Object.values(kind)) {
                if (!descriptor || typeof descriptor !== 'object') continue;
                if (descriptor.type === 'groups' && Array.isArray(descriptor.groups)
                    && descriptor.groups.includes(targetSlug)) {
                    return true;
                }
            }
        }
    }

    // capabilities[capId]: string[]
    if (compiled.capabilities && typeof compiled.capabilities === 'object') {
        for (const slugs of Object.values(compiled.capabilities)) {
            if (Array.isArray(slugs) && slugs.includes(targetSlug)) return true;
        }
    }

    return false;
}

/**
 * A `contributors` (articles) és `defaultContributors` (publications) JSON
 * longtext mezők kulcs-szinten tárolják a csoport slug-okat (pl.
 * `{"designers": "user_abc", "writers": null}`). Ha a csoportot töröljük és
 * ilyen kulcs még van, a stranded slug kulcs láthatatlanná válik a UI-ban
 * (a dashboard csak a létező csoportokat rendereli), így ezek a rekordok
 * data-loss állapotba kerülnek. Ez a helper vizsgálja, hogy a JSON string
 * bármilyen értékkel tartalmazza-e a target slug-ot kulcsként.
 *
 * hasOwnProperty: a `null` érték is reservation — a törlés-blokk ugyanúgy
 * jogos, mintha aktív userId lenne rendelve.
 *
 * @param {string|null|undefined} contributorsJson - a mező nyers értéke
 * @param {string} targetSlug - a törlendő csoport slug-ja
 * @returns {boolean} true, ha a slug kulcsként megjelenik a JSON-ban
 */
function contributorJsonReferencesSlug(contributorsJson, targetSlug) {
    if (!contributorsJson || typeof contributorsJson !== 'string') return false;
    let parsed;
    try {
        parsed = JSON.parse(contributorsJson);
    } catch {
        return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return Object.prototype.hasOwnProperty.call(parsed, targetSlug);
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
        const teamsApi = new sdk.Teams(client);

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
        // Fázis 9 — a delete_group action contributor-scan ellenőrzéshez kell
        // (articles.contributors JSON slug-kulcsokat tárol). Action-szintű guard.
        const articlesCollectionId = process.env.ARTICLES_COLLECTION_ID;
        // A.1 (ADR 0008) — a `bootstrap_permission_sets_schema` action két új
        // collectiont hoz létre. Mindkét env var **csak ezen az action-en**
        // kötelező, ezért action-szintű guard (mintha a publications/articles
        // env-ek). A többi meglévő action működése ettől független.
        const permissionSetsCollectionId = process.env.PERMISSION_SETS_COLLECTION_ID;
        const groupPermissionSetsCollectionId = process.env.GROUP_PERMISSION_SETS_COLLECTION_ID;

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
        // ACTION = 'bootstrap_organization' | 'create_organization'
        // ════════════════════════════════════════════════════════
        //
        // Atomikus 4-collection write: organizations + organizationMemberships
        // (owner) + editorialOffices + editorialOfficeMemberships (admin).
        //
        // Rollback: ha a 2-3-4. lépésnél hiba van, a már létrehozott
        // rekordokat visszatöröljük (best-effort).
        //
        // Mindkét action ugyanazt a 7 lépéses logikát futtatja. Eltérés:
        //   - bootstrap_organization (onboarding, első org): idempotens — ha
        //     a caller már tagja BÁRMELY orgnak, az existing org ID-t adja
        //     vissza (duplaklikk-védelem az első org létrehozásnál).
        //   - create_organization (avatar dropdown „Új szervezet…", #40):
        //     a caller már tagja egy orgnak, mégis explicit új-t akar — az
        //     idempotens ág kihagyva, minden hívás új szervezetet hoz létre.
        //     A frontend duplaklikk-védelmet a modal `isSubmitting` guardja
        //     adja, a slug ütközés (`org_slug_taken`) a szerveroldali unique
        //     index-en bukik el.
        if (action === 'bootstrap_organization' || action === 'create_organization') {
            const orgName = sanitizeString(payload.orgName, NAME_MAX_LENGTH);
            const orgSlug = sanitizeString(payload.orgSlug, SLUG_MAX_LENGTH);
            // Office mezők OPCIONÁLISAK (2026-04-20): a dashboard onboarding
            // flow már nem kényszerít auto-kreált „Általános" szerkesztőséget.
            // Ha a payload nem ad officeName/officeSlug-ot, a 3–7. lépés
            // (office + team + 7 default group + workflow seed) korai return-nel
            // kimarad, a user 0 office-szal landol az új orgban. A Dashboard
            // onboarding splash felajánlja a `create_editorial_office`-t.
            // Régi kliens (aki még ad office mezőket) továbbra is támogatott.
            const officeName = sanitizeString(payload.officeName, NAME_MAX_LENGTH);
            const officeSlug = sanitizeString(payload.officeSlug, SLUG_MAX_LENGTH);
            const hasOffice = !!(officeName && officeSlug);

            if (!orgName || !orgSlug) {
                return fail(res, 400, 'missing_fields', {
                    required: ['orgName', 'orgSlug']
                });
            }

            if (!SLUG_REGEX.test(orgSlug) || (hasOffice && !SLUG_REGEX.test(officeSlug))) {
                return fail(res, 400, 'invalid_slug', {
                    hint: 'slug must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/'
                });
            }

            // ── Idempotencia (csak bootstrap_organization-nél): ha a caller
            // már tagja valamelyik orgnak, nem hozunk létre újat. Ez véd a
            // duplaklikkelés és a retry ellen (pl. a kliens elhalt a válasz
            // előtt és újraküldi a kérést). Ugyanazt a success payload-ot
            // adjuk vissza, mint az első futás.
            //
            // A create_organization action SZÁNDÉKOSAN átugorja ezt — ott
            // a user explicit új szervezetet kér az avatar menüből, miközben
            // már van egy meglévő tagsága.
            if (action === 'bootstrap_organization') {
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
            }

            // Rollback-stack — LIFO: bármelyik hibapontnál visszafelé fut a
            // fordított sorrendben, így elkerüli a korábbi verzió 5x-ismétlődő
            // try/catch rollback láncát. Best-effort: minden lépés saját
            // catch-csel, hogy egy delete hiba ne szakítsa meg a többit.
            const rollbackSteps = [];
            const runRollback = async () => {
                for (let i = rollbackSteps.length - 1; i >= 0; i--) {
                    try { await rollbackSteps[i](); }
                    catch (e) { error(`[Bootstrap] rollback lépés hiba: ${e.message}`); }
                }
            };

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
                rollbackSteps.push(() => databases.deleteDocument(databaseId, organizationsCollectionId, newOrgId));
            } catch (err) {
                if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
                    return fail(res, 409, 'org_slug_taken');
                }
                error(`[Bootstrap] organizations create hiba: ${err.message}`);
                return fail(res, 500, 'org_create_failed');
            }

            // 1.5. Org team — tenant ACL alapja, idempotens
            const orgTeamId = buildOrgTeamId(newOrgId);
            try {
                const result = await ensureTeam(teamsApi, orgTeamId, `Org: ${orgName}`);
                if (result.created) {
                    rollbackSteps.push(() => teamsApi.delete(orgTeamId));
                }
            } catch (err) {
                error(`[Bootstrap] org team create hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'org_team_create_failed');
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
                rollbackSteps.push(() => databases.deleteDocument(databaseId, membershipsCollectionId, newMembershipId));
            } catch (err) {
                error(`[Bootstrap] organizationMemberships create hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'membership_create_failed');
            }

            // 2.5. Owner a team-be (team törlése cascade-eli a memberships-et → nincs külön rollback step)
            try {
                await ensureTeamMembership(teamsApi, orgTeamId, callerId, ['owner']);
            } catch (err) {
                error(`[Bootstrap] org team membership hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'org_team_membership_create_failed');
            }

            // ─────────────────────────────────────────────────────────────
            // Office nélküli flow (2026-04-20): ha a kliens nem adott meg
            // office mezőket, itt korai return-nel kilépünk — a 3–7. lépés
            // (office + team + 7 default group + workflow seed) kimarad. A
            // user 0 office-szal landol az új orgban, a Dashboard onboarding
            // splash felajánlja a `create_editorial_office` action-t az első
            // szerkesztőség létrehozásához.
            // ─────────────────────────────────────────────────────────────
            if (!hasOffice) {
                log(`[Bootstrap] User ${callerId} új szervezetet hozott létre (action=${action}, office=none): org=${newOrgId}`);
                return res.json({
                    success: true,
                    action: action === 'bootstrap_organization' ? 'bootstrapped' : 'created',
                    organizationId: newOrgId,
                    editorialOfficeId: null,
                    groupsSeeded: false,
                    workflowSeeded: false
                });
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
                rollbackSteps.push(() => databases.deleteDocument(databaseId, officesCollectionId, newOfficeId));
            } catch (err) {
                error(`[Bootstrap] editorialOffices create hiba: ${err.message}`);
                await runRollback();
                if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
                    return fail(res, 409, 'office_slug_taken');
                }
                return fail(res, 500, 'office_create_failed');
            }

            // 3.5. Office team
            const officeTeamId = buildOfficeTeamId(newOfficeId);
            try {
                const result = await ensureTeam(teamsApi, officeTeamId, `Office: ${officeName}`);
                if (result.created) {
                    rollbackSteps.push(() => teamsApi.delete(officeTeamId));
                }
            } catch (err) {
                error(`[Bootstrap] office team create hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'office_team_create_failed');
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
                rollbackSteps.push(() => databases.deleteDocument(databaseId, officeMembershipsCollectionId, newOfficeMembershipId));
            } catch (err) {
                error(`[Bootstrap] editorialOfficeMemberships create hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'office_membership_create_failed');
            }

            // 4.5. Admin az office team-be
            try {
                await ensureTeamMembership(teamsApi, officeTeamId, callerId, ['admin']);
            } catch (err) {
                error(`[Bootstrap] office team membership hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'office_team_membership_create_failed');
            }

            // 5. groups — 7 alapértelmezett csoport + office ACL tag
            const createdGroupIds = [];
            // Rollback step ELŐTT pusholunk, hogy a mid-loop hiba is takarítsa
            // a már létrehozott csoportokat (closure a mutable array-re).
            rollbackSteps.push(async () => {
                for (const gId of createdGroupIds) {
                    try { await databases.deleteDocument(databaseId, groupsCollectionId, gId); }
                    catch (e) { error(`[Bootstrap] group rollback sikertelen (${gId}): ${e.message}`); }
                }
            });
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
                        },
                        buildOfficeAclPerms(newOfficeId)
                    );
                    createdGroupIds.push(groupDoc.$id);
                }
            } catch (err) {
                error(`[Bootstrap] groups create hiba (${createdGroupIds.length}/${DEFAULT_GROUPS.length} kész): ${err.message}`);
                await runRollback();
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
            rollbackSteps.push(async () => {
                for (const gmId of createdGroupMembershipIds) {
                    try { await databases.deleteDocument(databaseId, groupMembershipsCollectionId, gmId); }
                    catch (e) { error(`[Bootstrap] groupMembership rollback sikertelen (${gmId}): ${e.message}`); }
                }
            });
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
                        },
                        buildOfficeAclPerms(newOfficeId)
                    );
                    createdGroupMembershipIds.push(gmDoc.$id);
                }
            } catch (err) {
                error(`[Bootstrap] groupMemberships create hiba (${createdGroupMembershipIds.length}/${createdGroupIds.length} kész): ${err.message}`);
                await runRollback();
                return fail(res, 500, 'group_memberships_create_failed');
            }

            // 7. workflows — alapértelmezett workflow seed az új szerkesztőséghez
            let newWorkflowId = null;
            try {
                const workflowDocId = `wf-${newOfficeId}`;
                const workflowDoc = await createWorkflowDoc(
                    databases,
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
                    },
                    WORKFLOW_VISIBILITY_DEFAULT,
                    callerId,
                    buildWorkflowAclPerms(WORKFLOW_VISIBILITY_DEFAULT, newOrgId, newOfficeId),
                    log
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

            log(`[Bootstrap] User ${callerId} új szervezetet hozott létre (action=${action}): org=${newOrgId}, office=${newOfficeId}, groups=${createdGroupIds.length}, memberships=${createdGroupMembershipIds.length}, workflow=${newWorkflowId || 'FAILED'}`);

            return res.json({
                success: true,
                action: action === 'bootstrap_organization' ? 'bootstrapped' : 'created',
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
                    },
                    buildOrgAclPerms(organizationId)
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
        // ACTION = 'list_my_invites'  (#41 — Maestro beállítások)
        // ════════════════════════════════════════════════════════
        //
        // A meghívott (még nem org-tag) user nem tudja a saját pending
        // invite-ját olvasni közvetlenül: az `organizationInvites` ACL
        // `read("team:org_${orgId}")`-re szűkül, és ő még nincs benne a
        // team-ben (az csak az `accept` után). Ezt az action-t ezért az
        // API key-jel futtatjuk, és kizárólag a caller saját e-mail
        // címére regisztrált pending invite-okat adja vissza, denormalizált
        // org-név + meghívó név mezőkkel a UI listához.
        //
        // Read-only — nem módosít DB-t, nem küld e-mailt.
        if (action === 'list_my_invites') {
            // 1) Caller user lekérés az e-mail kinyeréséhez.
            let callerUser;
            try {
                callerUser = await usersApi.get(callerId);
            } catch (e) {
                error(`[ListMyInvites] caller user lookup hiba (${callerId}): ${e.message}`);
                return fail(res, 500, 'caller_lookup_failed');
            }
            const callerEmail = (callerUser.email || '').trim().toLowerCase();
            if (!callerEmail) {
                return fail(res, 400, 'missing_caller_email');
            }

            // 2) Pending invite-ok lekérése. Az e-mail összehasonlítás
            //    case-insensitive a Modal/Server `EMAIL_REGEX` normalizálás
            //    miatt (a `create` action lower-case-elve menti).
            let invitesResp;
            try {
                invitesResp = await databases.listDocuments(
                    databaseId,
                    invitesCollectionId,
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
                        await databases.updateDocument(databaseId, invitesCollectionId, inv.$id, {
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
                    const doc = await databases.getDocument(databaseId, organizationsCollectionId, orgId);
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

        // ════════════════════════════════════════════════════════
        // ACTION = 'decline_invite'  (#41)
        // ════════════════════════════════════════════════════════
        //
        // Pending invite elutasítása. Token + e-mail match védelem (mint
        // az `accept` action-nél), majd status='declined' set. Idempotens:
        // ha már declined / accepted / expired, megfelelő hibakód.
        if (action === 'decline_invite') {
            const { token } = payload;
            if (!token || typeof token !== 'string') {
                return fail(res, 400, 'missing_fields', { required: ['token'] });
            }

            // 1) Token lookup
            let invite;
            try {
                const result = await databases.listDocuments(
                    databaseId,
                    invitesCollectionId,
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
                    await databases.updateDocument(databaseId, invitesCollectionId, invite.$id, {
                        status: 'expired'
                    });
                } catch (e) {
                    log(`[DeclineInvite] expire frissítés sikertelen: ${e.message}`);
                }
                return fail(res, 410, 'invite_expired');
            }

            // 4) E-mail egyezés ellenőrzése — mint az accept-nél.
            let callerUser;
            try {
                callerUser = await usersApi.get(callerId);
            } catch (e) {
                error(`[DeclineInvite] caller user lookup hiba (${callerId}): ${e.message}`);
                return fail(res, 500, 'caller_lookup_failed');
            }

            const callerEmail = (callerUser.email || '').trim().toLowerCase();
            const inviteEmail = (invite.email || '').trim().toLowerCase();
            if (callerEmail !== inviteEmail) {
                log(`[DeclineInvite] e-mail eltérés — caller=${callerUser.email}, invite=${invite.email}`);
                return fail(res, 403, 'email_mismatch');
            }

            // 5) Status update
            try {
                await databases.updateDocument(databaseId, invitesCollectionId, invite.$id, {
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

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'leave_organization'  (#41)
        // ════════════════════════════════════════════════════════════════
        //
        // Caller saját kilépése egy szervezetből. A teljes scope-takarítás
        // a caller saját rekordjaira korlátozott:
        //   - organizationMemberships (a caller 1 doca az adott orgban)
        //   - editorialOfficeMemberships (a caller minden office-tagsága az
        //     org alatt — több office is lehet)
        //   - groupMemberships (a caller minden csoporttagsága az org-on belül)
        //   - Appwrite Team membership-ek: `org_${orgId}` + per-office
        //     `office_${officeId}` (Realtime ACL push leszűkítés)
        //
        // Last-owner blokk: ha a caller az utolsó `owner` role-ú tag és van
        // legalább egy másik member (admin/member) → `last_owner_block`,
        // a usernek delegálnia kell előbb. Ha a caller az utolsó tag (semmi
        // egyéb membership), akkor is blokkoljuk — ilyenkor a UI a
        // `delete_organization` flow-t kínálja fel (szándékos disambiguation,
        // hogy a kilépés ne legyen árva-org generátor).
        if (action === 'leave_organization') {
            const { organizationId } = payload;
            if (!organizationId || typeof organizationId !== 'string') {
                return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
            }

            // 1) Caller org membership lekérése — kötelező.
            let callerMembership;
            try {
                const result = await databases.listDocuments(
                    databaseId,
                    membershipsCollectionId,
                    [
                        sdk.Query.equal('organizationId', organizationId),
                        sdk.Query.equal('userId', callerId),
                        sdk.Query.limit(1)
                    ]
                );
                if (result.documents.length === 0) {
                    return fail(res, 404, 'not_a_member');
                }
                callerMembership = result.documents[0];
            } catch (e) {
                error(`[LeaveOrg] caller membership lookup hiba: ${e.message}`);
                return fail(res, 500, 'membership_lookup_failed');
            }

            // 2) Last-owner blokk. Ha a caller owner, ellenőrizzük, hogy
            //    van-e másik owner. Ha nincs → blokkolva, de először
            //    eldöntjük, hogy egyedüli-e (ekkor `last_member_block`,
            //    a UI a delete_organization-t ajánlja fel).
            if (callerMembership.role === 'owner') {
                let otherOwners;
                try {
                    otherOwners = await databases.listDocuments(
                        databaseId,
                        membershipsCollectionId,
                        [
                            sdk.Query.equal('organizationId', organizationId),
                            sdk.Query.equal('role', 'owner'),
                            sdk.Query.notEqual('userId', callerId),
                            sdk.Query.limit(1)
                        ]
                    );
                } catch (e) {
                    error(`[LeaveOrg] other-owner scan hiba: ${e.message}`);
                    return fail(res, 500, 'owner_scan_failed');
                }

                if (otherOwners.documents.length === 0) {
                    // Egyedüli owner — most külön nézzük, hogy van-e bármilyen
                    // más tag. Ha van → owner-átruházás kell előtte. Ha nincs
                    // → org törlés a megoldás.
                    let otherMembers;
                    try {
                        otherMembers = await databases.listDocuments(
                            databaseId,
                            membershipsCollectionId,
                            [
                                sdk.Query.equal('organizationId', organizationId),
                                sdk.Query.notEqual('userId', callerId),
                                sdk.Query.limit(1)
                            ]
                        );
                    } catch (e) {
                        error(`[LeaveOrg] other-member scan hiba: ${e.message}`);
                        return fail(res, 500, 'owner_scan_failed');
                    }

                    if (otherMembers.documents.length > 0) {
                        return fail(res, 409, 'last_owner_block', {
                            hint: 'transfer_ownership_first'
                        });
                    }
                    return fail(res, 409, 'last_member_block', {
                        hint: 'delete_organization_instead'
                    });
                }
            }

            // 3) Az org alá tartozó office-ok listája — a per-office team
            //    cleanup-hoz kell. Lapozott listing.
            const officeIds = [];
            let cursor;
            while (true) {
                const queries = [
                    sdk.Query.equal('organizationId', organizationId),
                    sdk.Query.select(['$id']),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ];
                if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
                let resp;
                try {
                    resp = await databases.listDocuments(databaseId, officesCollectionId, queries);
                } catch (e) {
                    error(`[LeaveOrg] office listing hiba: ${e.message}`);
                    return fail(res, 500, 'office_list_failed');
                }
                if (resp.documents.length === 0) break;
                for (const o of resp.documents) officeIds.push(o.$id);
                if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
                cursor = resp.documents[resp.documents.length - 1].$id;
            }

            // 3.5) Team cleanup STRICT — a DB doc törlések ELŐTT fut le, mert
            //      Fázis 2 ACL óta a team membership szabályozza a Realtime + REST
            //      olvasási hozzáférést. Ha előbb DB-t törölnénk és a team cleanup
            //      elbukna, a user továbbra is kapna payload-ot már-törölt
            //      rekordokról (ghost ACL access). A sorrend fordított: előbb
            //      levágjuk a push-csatornákat, utána pusztítunk DB-ben.
            //
            //      Hiba esetén 500-zal leállunk — a DB még érintetlen, a user
            //      nyugodtan újrahívhat. A `removeTeamMembership` idempotens
            //      (409/404 skip), így a retry nem ír felül semmit.
            const teamCleanup = { officeTeams: 0, orgTeam: false };
            try {
                for (const oid of officeIds) {
                    const r = await removeTeamMembership(teamsApi, buildOfficeTeamId(oid), callerId);
                    if (r.removed > 0) teamCleanup.officeTeams += r.removed;
                }
                const r = await removeTeamMembership(teamsApi, buildOrgTeamId(organizationId), callerId);
                if (r.removed > 0) teamCleanup.orgTeam = true;
            } catch (teamErr) {
                error(`[LeaveOrg] team membership remove hiba — abort, DB érintetlen: ${teamErr.message}`);
                return fail(res, 500, 'team_cleanup_failed', { message: teamErr.message });
            }

            // 4) Caller saját office membership-ek törlése. Az
            //    `editorialOfficeMemberships` collection a `(officeId, userId)`
            //    composite indexen unique, de egy user több office-ban is lehet
            //    → lapozott törlés (analóg a lenti groupMemberships loop-pal).
            let officeMembershipsRemoved = 0;
            const officeFailures = [];
            try {
                while (true) {
                    const resp = await databases.listDocuments(
                        databaseId,
                        officeMembershipsCollectionId,
                        [
                            sdk.Query.equal('organizationId', organizationId),
                            sdk.Query.equal('userId', callerId),
                            sdk.Query.limit(CASCADE_BATCH_LIMIT)
                        ]
                    );
                    if (resp.documents.length === 0) break;
                    for (const m of resp.documents) {
                        try {
                            await databases.deleteDocument(databaseId, officeMembershipsCollectionId, m.$id);
                            officeMembershipsRemoved++;
                        } catch (delErr) {
                            officeFailures.push({ docId: m.$id, message: delErr.message });
                        }
                    }
                    // Végtelen-loop guard: ha bármelyik delete hibázott, kilépünk és
                    // lejjebb 500-zal elszállunk. Nélküle egy tartós delete-hiba +
                    // full-size page esetén (documents.length === CASCADE_BATCH_LIMIT)
                    // soha nem érne véget a ciklus.
                    if (officeFailures.length > 0) break;
                    if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
                }
            } catch (e) {
                error(`[LeaveOrg] office memberships listing hiba: ${e.message}`);
                return fail(res, 500, 'office_memberships_failed');
            }
            if (officeFailures.length > 0) {
                error(`[LeaveOrg] office membership delete failures: ${JSON.stringify(officeFailures)}`);
                return fail(res, 500, 'office_memberships_failed', { failures: officeFailures });
            }

            // 5) Caller saját groupMembership-ek törlése (org-szintű szűrés).
            let groupMembershipsRemoved = 0;
            const groupFailures = [];
            try {
                while (true) {
                    const resp = await databases.listDocuments(
                        databaseId,
                        groupMembershipsCollectionId,
                        [
                            sdk.Query.equal('organizationId', organizationId),
                            sdk.Query.equal('userId', callerId),
                            sdk.Query.limit(CASCADE_BATCH_LIMIT)
                        ]
                    );
                    if (resp.documents.length === 0) break;
                    for (const m of resp.documents) {
                        try {
                            await databases.deleteDocument(databaseId, groupMembershipsCollectionId, m.$id);
                            groupMembershipsRemoved++;
                        } catch (delErr) {
                            groupFailures.push({ docId: m.$id, message: delErr.message });
                        }
                    }
                    // Ld. office-memberships loop fenti guardja — azonos infinite-loop rizikó.
                    if (groupFailures.length > 0) break;
                    if (resp.documents.length < CASCADE_BATCH_LIMIT) break;
                }
            } catch (e) {
                error(`[LeaveOrg] group memberships listing hiba: ${e.message}`);
                return fail(res, 500, 'group_memberships_failed');
            }
            if (groupFailures.length > 0) {
                error(`[LeaveOrg] group membership delete failures: ${JSON.stringify(groupFailures)}`);
                return fail(res, 500, 'group_memberships_failed', { failures: groupFailures });
            }

            // 6) Org membership doc törlése — a fő rekord. Mostanra már
            //    minden gyerek-membership (office + group) le van bontva,
            //    az org doc-on a caller jogosultsága megszűnik.
            try {
                await databases.deleteDocument(
                    databaseId,
                    membershipsCollectionId,
                    callerMembership.$id
                );
            } catch (e) {
                error(`[LeaveOrg] org membership delete hiba (${callerMembership.$id}): ${e.message}`);
                return fail(res, 500, 'membership_delete_failed');
            }

            log(`[LeaveOrg] User ${callerId} kilépett org ${organizationId}-ból — office=${officeMembershipsRemoved}, groupMemberships=${groupMembershipsRemoved}, teams.office=${teamCleanup.officeTeams}, teams.org=${teamCleanup.orgTeam}`);

            return res.json({
                success: true,
                action: 'left',
                organizationId,
                removed: {
                    organizationMembership: 1,
                    editorialOfficeMemberships: officeMembershipsRemoved,
                    groupMemberships: groupMembershipsRemoved
                },
                teamCleanup
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

            // 5. GroupMembership létrehozás (idempotens) — office ACL scope-pal
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
                    },
                    buildOfficeAclPerms(group.editorialOfficeId)
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
        // ACTION = 'create_group'
        // ════════════════════════════════════════════════════════
        //
        // Új (custom) csoport létrehozása egy szerkesztőséghez. Owner/admin only.
        // A slug `slugifyName(name)`-ből származik, max 3 próba random suffix-szel
        // ütközés esetén. A caller automatikusan tagja lesz a csoportnak (seed
        // membership, hogy ne legyen árva csoport közvetlenül a létrehozás után).
        //
        // TOCTOU trade-off: ugyanaz mint a többi name/slug uniqueness action-nél —
        // párhuzamos két admin ugyanazzal a névvel race eshetőséget generálhat.
        // A slug szinten az Appwrite unique attribute megvéd; display name szinten
        // elfogadott kompromisszum (ld. update_editorial_office komment).
        if (action === 'create_group') {
            const { editorialOfficeId } = payload;
            const sanitizedName = sanitizeString(payload.name, NAME_MAX_LENGTH);

            if (!editorialOfficeId || !sanitizedName) {
                return fail(res, 400, 'missing_fields', {
                    required: ['editorialOfficeId', 'name']
                });
            }

            // 1) Office lookup → organizationId
            let officeDoc;
            try {
                officeDoc = await databases.getDocument(databaseId, officesCollectionId, editorialOfficeId);
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'office_not_found');
                error(`[CreateGroup] office fetch hiba: ${err.message}`);
                return fail(res, 500, 'office_fetch_failed');
            }

            // 2) Caller jogosultság — org owner/admin
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', officeDoc.organizationId),
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

            // 3) Display name uniqueness az office-on belül
            const nameConflict = await databases.listDocuments(
                databaseId,
                groupsCollectionId,
                [
                    sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                    sdk.Query.equal('name', sanitizedName),
                    sdk.Query.limit(1)
                ]
            );
            if (nameConflict.documents.length > 0) {
                return fail(res, 409, 'name_taken');
            }

            // 4) Group létrehozás — slug auto-generálás + ütközéskor retry random
            //    suffix-szel (office-scope unique a slug az Appwrite compound indexen).
            const baseSlug = slugifyName(sanitizedName);
            let newGroupDoc = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                const candidateSlug = attempt === 0
                    ? baseSlug
                    : `${baseSlug.slice(0, SLUG_MAX_LENGTH - 5)}-${crypto.randomBytes(2).toString('hex')}`;
                try {
                    newGroupDoc = await databases.createDocument(
                        databaseId,
                        groupsCollectionId,
                        sdk.ID.unique(),
                        {
                            organizationId: officeDoc.organizationId,
                            editorialOfficeId,
                            name: sanitizedName,
                            slug: candidateSlug,
                            createdByUserId: callerId
                        },
                        buildOfficeAclPerms(editorialOfficeId)
                    );
                    break;
                } catch (err) {
                    const isUnique = err?.type === 'document_already_exists' || /unique/i.test(err?.message || '');
                    if (isUnique && attempt < 2) continue;
                    error(`[CreateGroup] group create hiba (slug=${candidateSlug}, attempt=${attempt}): ${err.message}`);
                    if (isUnique) return fail(res, 409, 'group_slug_taken');
                    return fail(res, 500, 'group_create_failed');
                }
            }

            // 5) Caller seed membership — így nincs árva csoport. Ha a caller nem
            //    office-tag (org admin de nem office tag), skip-eljük a seed-et,
            //    de a group létrejön — a későbbi add_group_member eléri.
            const callerOfficeMembership = await databases.listDocuments(
                databaseId,
                officeMembershipsCollectionId,
                [
                    sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.limit(1)
                ]
            );
            let seedMembershipId = null;
            if (callerOfficeMembership.documents.length > 0) {
                try {
                    let callerUser = null;
                    try { callerUser = await usersApi.get(callerId); } catch { /* non-blocking */ }
                    const memDoc = await databases.createDocument(
                        databaseId,
                        groupMembershipsCollectionId,
                        sdk.ID.unique(),
                        {
                            groupId: newGroupDoc.$id,
                            userId: callerId,
                            editorialOfficeId,
                            organizationId: officeDoc.organizationId,
                            role: 'member',
                            addedByUserId: callerId,
                            userName: callerUser?.name || '',
                            userEmail: callerUser?.email || ''
                        },
                        buildOfficeAclPerms(editorialOfficeId)
                    );
                    seedMembershipId = memDoc.$id;
                } catch (err) {
                    // Seed bukás nem rollback-eli a groupot — a UI-ban látható,
                    // hozzá lehet adni kézzel.
                    error(`[CreateGroup] seed membership hiba (group=${newGroupDoc.$id}): ${err.message}`);
                }
            }

            log(`[CreateGroup] User ${callerId} létrehozta "${sanitizedName}" (${newGroupDoc.slug}) csoportot az office ${editorialOfficeId}-ban`);

            return res.json({
                success: true,
                action: 'created',
                group: newGroupDoc,
                seedMembershipId
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'rename_group'
        // ════════════════════════════════════════════════════════
        //
        // Csoport display name szerkesztése. A `slug` SOHA nem változik —
        // a workflow `compiled` JSON (statePermissions, leaderGroups,
        // elementPermissions, contributorGroups) slug-okra hivatkozik, slug
        // változás kaszkád-patch-et igényelne a workflowkon. Ez szándékos
        // invariáns: slug stabil, display name szabadon szerkeszthető.
        //
        // DEFAULT_GROUPS-ot is lehet átnevezni (csak a label változik, slug marad).
        if (action === 'rename_group') {
            const { groupId } = payload;
            const sanitizedName = sanitizeString(payload.name, NAME_MAX_LENGTH);

            if (!groupId || !sanitizedName) {
                return fail(res, 400, 'missing_fields', {
                    required: ['groupId', 'name']
                });
            }

            // 1) Group lookup → scope feloldás
            let groupDoc;
            try {
                groupDoc = await databases.getDocument(databaseId, groupsCollectionId, groupId);
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'group_not_found');
                error(`[RenameGroup] group fetch hiba: ${err.message}`);
                return fail(res, 500, 'group_fetch_failed');
            }

            // 2) Caller jogosultság — org owner/admin
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', groupDoc.organizationId),
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

            // 3) Uniqueness — ha nem self-match, office-on belül egyedi display name
            if (sanitizedName !== groupDoc.name) {
                const nameConflict = await databases.listDocuments(
                    databaseId,
                    groupsCollectionId,
                    [
                        sdk.Query.equal('editorialOfficeId', groupDoc.editorialOfficeId),
                        sdk.Query.equal('name', sanitizedName),
                        sdk.Query.limit(1)
                    ]
                );
                const conflict = nameConflict.documents.find(d => d.$id !== groupId);
                if (conflict) {
                    return fail(res, 409, 'name_taken');
                }
            }

            // 4) Frissítés — CSAK a name mező, slug változatlan
            try {
                await databases.updateDocument(
                    databaseId,
                    groupsCollectionId,
                    groupId,
                    { name: sanitizedName }
                );
            } catch (err) {
                error(`[RenameGroup] updateDocument hiba: ${err.message}`);
                return fail(res, 500, 'update_failed');
            }

            log(`[RenameGroup] User ${callerId} átnevezte group ${groupId} (${groupDoc.slug}) → "${sanitizedName}"`);

            return res.json({
                success: true,
                action: 'renamed',
                groupId,
                name: sanitizedName,
                slug: groupDoc.slug
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'delete_group'
        // ════════════════════════════════════════════════════════
        //
        // Csoport törlése. Blocking ellenőrzések:
        //   1. DEFAULT_GROUPS slug-ok NEM törölhetők (onboarding invariáns — a
        //      compiled workflow default állapotok ezekre hivatkoznak).
        //   2. Ha bármely workflow `compiled` JSON-ja hivatkozza a slug-ot
        //      (statePermissions, leaderGroups, elementPermissions,
        //      contributorGroups, transitions, commands, capabilities),
        //      `group_in_use` hibával elutasítjuk.
        //   3. Ha bármely publikáció `defaultContributors` vagy cikk
        //      `contributors` JSON-ja kulcsként tartalmazza a slug-ot,
        //      `group_in_use` hibával elutasítjuk. Enélkül a delete stranded
        //      JSON kulcsokat hagyna, amiket a UI nem lát (data loss).
        //
        // Ha átmegy, kaszkád törlés: groupMembership → group → compensating sweep
        // (a sweep elkapja az add_group_member race miatt közben befurakodott
        // orphan membership-eket, mielőtt success-t adunk vissza).
        if (action === 'delete_group') {
            const { groupId } = payload;
            if (!groupId) {
                return fail(res, 400, 'missing_fields', { required: ['groupId'] });
            }

            // Action-szintű env var guard — a contributor scan nélkül a data-loss
            // kockázat valós, ezért a publications + articles collection ID-k
            // kötelezőek. Ha nincsenek beállítva, a Console admin figyelmeztetést
            // kap és a törlés blokkolódik.
            const missingForDelete = [];
            if (!publicationsCollectionId) missingForDelete.push('PUBLICATIONS_COLLECTION_ID');
            if (!articlesCollectionId) missingForDelete.push('ARTICLES_COLLECTION_ID');
            if (missingForDelete.length > 0) {
                error(`[DeleteGroup] Hiányzó env var(ok): ${missingForDelete.join(', ')}`);
                return fail(res, 500, 'misconfigured', { missing: missingForDelete });
            }

            // 1) Group lookup
            let groupDoc;
            try {
                groupDoc = await databases.getDocument(databaseId, groupsCollectionId, groupId);
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'group_not_found');
                error(`[DeleteGroup] group fetch hiba: ${err.message}`);
                return fail(res, 500, 'group_fetch_failed');
            }

            // 2) Default group védelem
            const isDefault = groupDoc.isDefault === true
                || DEFAULT_GROUPS.some(g => g.slug === groupDoc.slug);
            if (isDefault) {
                return fail(res, 403, 'default_group_protected', { slug: groupDoc.slug });
            }

            // 3) Caller jogosultság — org owner/admin
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', groupDoc.organizationId),
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

            // 4) Workflow hivatkozás ellenőrzés — az office összes workflow-ja,
            //    compiled JSON-ban a slug string-keresés. A loop csak akkor áll le,
            //    ha (a) nincs több lap, (b) elértük a MAX_REFERENCES_PER_SCAN cap-et
            //    (van már elég match a UI-nak — blokkolunk). A scan teljessége
            //    data-loss kritikus: fals "nincs hivatkozás" → orphan slug marad.
            const usedInWorkflows = [];
            const targetSlug = groupDoc.slug;
            let cursor = null;
            workflowLoop:
            while (true) {
                const queries = [
                    sdk.Query.equal('editorialOfficeId', groupDoc.editorialOfficeId),
                    sdk.Query.select(['$id', 'name', 'compiled']),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ];
                if (cursor) queries.push(sdk.Query.cursorAfter(cursor));

                const workflowBatch = await databases.listDocuments(databaseId, workflowsCollectionId, queries);
                if (workflowBatch.documents.length === 0) break;

                for (const wf of workflowBatch.documents) {
                    if (!wf.compiled || typeof wf.compiled !== 'string') continue;
                    let compiled;
                    try {
                        compiled = JSON.parse(wf.compiled);
                    } catch {
                        continue;
                    }
                    if (workflowReferencesSlug(compiled, targetSlug)) {
                        usedInWorkflows.push({ $id: wf.$id, name: wf.name });
                        if (usedInWorkflows.length >= MAX_REFERENCES_PER_SCAN) break workflowLoop;
                    }
                }

                if (workflowBatch.documents.length < CASCADE_BATCH_LIMIT) break;
                cursor = workflowBatch.documents[workflowBatch.documents.length - 1].$id;
            }

            // 5) Publikációk defaultContributors scan — a slug JSON kulcsként
            //    szerepelhet. Teljes lapozás (data-loss critical), scan cap csak
            //    a már talált matchekre.
            const usedInPublications = [];
            let pubCursor = null;
            pubLoop:
            while (true) {
                const queries = [
                    sdk.Query.equal('editorialOfficeId', groupDoc.editorialOfficeId),
                    sdk.Query.select(['$id', 'name', 'defaultContributors']),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ];
                if (pubCursor) queries.push(sdk.Query.cursorAfter(pubCursor));

                const pubBatch = await databases.listDocuments(databaseId, publicationsCollectionId, queries);
                if (pubBatch.documents.length === 0) break;

                for (const pub of pubBatch.documents) {
                    if (contributorJsonReferencesSlug(pub.defaultContributors, targetSlug)) {
                        usedInPublications.push({ $id: pub.$id, name: pub.name });
                        if (usedInPublications.length >= MAX_REFERENCES_PER_SCAN) break pubLoop;
                    }
                }

                if (pubBatch.documents.length < CASCADE_BATCH_LIMIT) break;
                pubCursor = pubBatch.documents[pubBatch.documents.length - 1].$id;
            }

            // 6) Cikkek contributors scan — ugyanez slug JSON kulcs alapján.
            //    Articles jóval több lehet, mint pub — teljes scan + cap a
            //    memória- és response-time védelemre.
            const usedInArticles = [];
            let artCursor = null;
            artLoop:
            while (true) {
                const queries = [
                    sdk.Query.equal('editorialOfficeId', groupDoc.editorialOfficeId),
                    sdk.Query.select(['$id', 'name', 'contributors']),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ];
                if (artCursor) queries.push(sdk.Query.cursorAfter(artCursor));

                const artBatch = await databases.listDocuments(databaseId, articlesCollectionId, queries);
                if (artBatch.documents.length === 0) break;

                for (const art of artBatch.documents) {
                    if (contributorJsonReferencesSlug(art.contributors, targetSlug)) {
                        usedInArticles.push({ $id: art.$id, name: art.name });
                        if (usedInArticles.length >= MAX_REFERENCES_PER_SCAN) break artLoop;
                    }
                }

                if (artBatch.documents.length < CASCADE_BATCH_LIMIT) break;
                artCursor = artBatch.documents[artBatch.documents.length - 1].$id;
            }

            if (usedInWorkflows.length > 0 || usedInPublications.length > 0 || usedInArticles.length > 0) {
                return fail(res, 409, 'group_in_use', {
                    slug: targetSlug,
                    workflows: usedInWorkflows,
                    publications: usedInPublications,
                    articles: usedInArticles
                });
            }

            // 7) Kaszkád törlés — groupMemberships
            let deletedMemberships = 0;
            try {
                const cascadeResult = await deleteByQuery(
                    databases,
                    databaseId,
                    groupMembershipsCollectionId,
                    'groupId',
                    groupId
                );
                deletedMemberships = cascadeResult.deleted;
            } catch (err) {
                error(`[DeleteGroup] groupMemberships kaszkád hiba (group=${groupId}): ${err.message}`);
                return fail(res, 500, 'cascade_delete_failed');
            }

            // 8) Group törlés
            try {
                await databases.deleteDocument(databaseId, groupsCollectionId, groupId);
            } catch (err) {
                error(`[DeleteGroup] group delete hiba: ${err.message}`);
                return fail(res, 500, 'delete_failed');
            }

            // 9) Compensating sweep — add_group_member race védelem.
            //    Az add_group_member flow előbb megy végig a validáción (group
            //    létezik) majd később hozza létre a membership-et; a két hívás
            //    között a delete_group befejezheti a cascade-et. Ilyen orphan
            //    membership-et itt kitakarítjuk, mielőtt success-t adunk vissza.
            //    Nem blokkoló: ha a sweep elbukik, a csoport már törölve.
            let orphanCleaned = 0;
            try {
                const sweepResult = await deleteByQuery(
                    databases,
                    databaseId,
                    groupMembershipsCollectionId,
                    'groupId',
                    groupId
                );
                orphanCleaned = sweepResult.deleted;
                if (orphanCleaned > 0) {
                    log(`[DeleteGroup] Compensating sweep: ${orphanCleaned} orphan membership törölve race miatt (group=${groupId}).`);
                }
            } catch (err) {
                error(`[DeleteGroup] compensating sweep hiba (nem blokkoló, group=${groupId}): ${err.message}`);
            }

            log(`[DeleteGroup] User ${callerId} törölte "${groupDoc.name}" (${targetSlug}) csoportot (memberships=${deletedMemberships + orphanCleaned})`);

            return res.json({
                success: true,
                action: 'deleted',
                groupId,
                deletedMemberships: deletedMemberships + orphanCleaned
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'bootstrap_workflow_schema'
        // ════════════════════════════════════════════════════════
        //
        // Egyszeri, idempotens séma-bővítés a `workflows` collection-re. Fedi:
        // - #30 attribútumok: `visibility` enum, `createdBy` string
        // - #80 attribútumok: `description` string, `archivedAt` datetime
        // - #80 enum-bővítés: a meglévő `visibility` attribute `public` értékkel
        //   (updateEnumAttribute — ha a create 409-et ad, mert már létezik)
        // - #80 fulltext indexek: `name` + `description` (szabadszavas kereső)
        //
        // A user futtatja le (Appwrite Console → Function → Execute vagy curl)
        // deploy után. Az action idempotens: a már létező attributes / enum
        // values / indexek skip-elődnek, a response `created` / `updated` /
        // `skipped` listákkal jelzi a történteket.
        //
        // Auth: caller kell hogy legyen valamely szervezet `owner`-e — az
        // adminisztratív művelet jellege miatt admin role is szándékosan
        // kizárva.
        //
        // Megjegyzés: az attribútum-létrehozás **aszinkron** a szerveren
        // (processing → available átmenet néhány másodperc). Az indexeket a
        // CF megpróbálja létrehozni, de ha az attribute még nem available,
        // 400/409-re futva skip-eli. A user futtassa le újra 10s után, amíg
        // az `indexes_pending` lista kiürül.
        if (action === 'bootstrap_workflow_schema') {
            // 1. Caller legalább egy org owner-e
            const ownerships = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.equal('role', 'owner'),
                    sdk.Query.limit(1)
                ]
            );
            if (ownerships.documents.length === 0) {
                return fail(res, 403, 'insufficient_role', {
                    requiredRole: 'owner'
                });
            }

            const created = [];
            const updated = [];
            const skipped = [];
            const indexesPending = [];

            // 2. visibility enum attribútum.
            // Appwrite 1.9+: a `required=true` és `default` kombináció
            // hibát dob (`attribute_default_unsupported`). `required=false`
            // + default → új doc explicit vagy default értéket kap,
            // legacy row-ok null-ja a consumer fallback-en át `editorial_office`.
            // Ha már létezik (#30 deploy), updateEnumAttribute-tal bővítjük a
            // `public` értékkel (Feladat #80). Ha az Appwrite nem engedi
            // (pl. deprecated method), a user a Console-ban bővíti.
            try {
                await databases.createEnumAttribute(
                    databaseId,
                    workflowsCollectionId,
                    'visibility',
                    WORKFLOW_VISIBILITY_VALUES,
                    false,                         // required
                    WORKFLOW_VISIBILITY_DEFAULT,   // default
                    false                          // array
                );
                created.push('visibility');
            } catch (err) {
                if (err?.code === 409 || /already exists/i.test(err?.message || '')) {
                    // Már létezik — próbáljuk bővíteni a `public` értékkel (#80).
                    try {
                        await databases.updateEnumAttribute(
                            databaseId,
                            workflowsCollectionId,
                            'visibility',
                            WORKFLOW_VISIBILITY_VALUES,
                            false,
                            WORKFLOW_VISIBILITY_DEFAULT
                        );
                        updated.push('visibility(public added)');
                    } catch (updateErr) {
                        // Nem halálos: a user manuálisan bővítheti a Console-on.
                        const msg = updateErr?.message || String(updateErr);
                        log(`[BootstrapWorkflowSchema] visibility update nem ment: ${msg} — Console-ban bővítsd a 'public' értékkel.`);
                        skipped.push(`visibility (update_failed: ${msg})`);
                    }
                } else {
                    error(`[BootstrapWorkflowSchema] visibility létrehozás hiba: ${err.message}`);
                    return fail(res, 500, 'schema_visibility_failed', { error: err.message });
                }
            }

            // 3. createdBy string attribútum (user $id = 36 char)
            try {
                await databases.createStringAttribute(
                    databaseId,
                    workflowsCollectionId,
                    'createdBy',
                    36,                            // size
                    false,                         // required — legacy row-okon null
                    null,                          // default
                    false                          // array
                );
                created.push('createdBy');
            } catch (err) {
                if (err?.code === 409 || /already exists/i.test(err?.message || '')) {
                    skipped.push('createdBy');
                } else {
                    error(`[BootstrapWorkflowSchema] createdBy létrehozás hiba: ${err.message}`);
                    return fail(res, 500, 'schema_createdby_failed', { error: err.message });
                }
            }

            // 4. #80 — description string attribútum (szabadszavas keresőhöz
            // fulltext indexelt, max 500 char — egy-két mondatos workflow
            // leírás, hosszabb szöveg más mezőkbe).
            try {
                await databases.createStringAttribute(
                    databaseId,
                    workflowsCollectionId,
                    'description',
                    500,                           // size
                    false,                         // required
                    null,                          // default
                    false                          // array
                );
                created.push('description');
            } catch (err) {
                if (err?.code === 409 || /already exists/i.test(err?.message || '')) {
                    skipped.push('description');
                } else {
                    error(`[BootstrapWorkflowSchema] description létrehozás hiba: ${err.message}`);
                    return fail(res, 500, 'schema_description_failed', { error: err.message });
                }
            }

            // 5. #80 — archivedAt datetime attribútum (soft-delete marker).
            // Null → aktív workflow, nem-null → archivált (N napos türelmi
            // idő, lásd Feladatok.md #81 cron hard-delete).
            try {
                await databases.createDatetimeAttribute(
                    databaseId,
                    workflowsCollectionId,
                    'archivedAt',
                    false,                         // required
                    null,                          // default
                    false                          // array
                );
                created.push('archivedAt');
            } catch (err) {
                if (err?.code === 409 || /already exists/i.test(err?.message || '')) {
                    skipped.push('archivedAt');
                } else {
                    error(`[BootstrapWorkflowSchema] archivedAt létrehozás hiba: ${err.message}`);
                    return fail(res, 500, 'schema_archivedat_failed', { error: err.message });
                }
            }

            // 6. #80 — fulltext indexek a szabadszavas kereséshez (name +
            // description). Appwrite egyetlen fulltext indexben csak egy
            // attribute-ot támogat, ezért külön-külön. Ha az attribute még
            // nem `available` (aszinkron processing), az index létrehozás
            // 400-at/409-et ad — a user futtassa újra az action-t 10s múlva.
            const fulltextIndexes = [
                { key: 'name_fulltext', attr: 'name' },
                { key: 'description_fulltext', attr: 'description' }
            ];
            for (const { key, attr } of fulltextIndexes) {
                try {
                    await databases.createIndex(
                        databaseId,
                        workflowsCollectionId,
                        key,
                        'fulltext',
                        [attr]
                    );
                    created.push(`index:${key}`);
                } catch (err) {
                    const msg = err?.message || '';
                    if (err?.code === 409 || /already exists/i.test(msg)) {
                        skipped.push(`index:${key}`);
                    } else if (err?.code === 400 || /not available|processing|unknown attribute/i.test(msg)) {
                        // Attribute még nem elérhető — a user futtassa újra az action-t.
                        indexesPending.push(key);
                    } else {
                        error(`[BootstrapWorkflowSchema] index:${key} létrehozás hiba: ${err.message}`);
                        return fail(res, 500, 'schema_index_failed', { index: key, error: err.message });
                    }
                }
            }

            log(`[BootstrapWorkflowSchema] User ${callerId}: created=[${created.join(',')}] updated=[${updated.join(',')}] skipped=[${skipped.join(',')}] indexesPending=[${indexesPending.join(',')}]`);

            const note = indexesPending.length > 0
                ? `Az attribútumok feldolgozása ~5-10s. Futtasd újra az action-t amíg az indexesPending lista kiürül. A create_workflow hívás előtt várj, amíg a visibility + description + archivedAt available státuszú.`
                : 'Az attribútumok feldolgozása ~5-10s. Várj a create_workflow hívás előtt.';

            return res.json({
                success: true,
                created,
                updated,
                skipped,
                indexesPending,
                note
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'bootstrap_publication_schema'
        // ════════════════════════════════════════════════════════
        //
        // Idempotens schema-bővítés a `publications` collection-re:
        // `compiledWorkflowSnapshot` (string, nullable, ~1 MB). Aktiváláskor
        // a workflow `compiled` JSON pillanatképét tároljuk — onnantól a
        // publikáció élete a snapshot-on fut, a workflow későbbi módosításai
        // már nem érintik. Lásd _docs/Feladatok.md #36.
        //
        // Owner-only — a `bootstrap_workflow_schema` mintáját követi. Csak
        // org owner-ek hívhatják; a Dashboard-ról nem elérhető, manuálisan
        // kell triggerelni egyszer az env-ben (curl vagy Console).
        if (action === 'bootstrap_publication_schema') {
            // 1. Caller legalább egy org owner-e
            const ownerships = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.equal('role', 'owner'),
                    sdk.Query.limit(1)
                ]
            );
            if (ownerships.documents.length === 0) {
                return fail(res, 403, 'insufficient_role', {
                    requiredRole: 'owner'
                });
            }

            // 2. publicationsCollectionId env var kötelező
            if (!publicationsCollectionId) {
                return fail(res, 500, 'misconfigured', {
                    missing: ['PUBLICATIONS_COLLECTION_ID']
                });
            }

            const created = [];
            const skipped = [];

            // 3. compiledWorkflowSnapshot string attribútum.
            // Size: 1_000_000 char (~1 MB). A workflows.compiled jelenlegi mérete
            // ~12 KB (8 állapotos default workflow); a sapka bőven fedi a bővítést
            // (több állapot, részletesebb jogosultság-mátrix, capabilities).
            // Nullable — legacy (már aktivált, snapshot nélküli) publikációkon
            // null marad, a Plugin a workflowId cache-re fallback-el (Feladat #38).
            try {
                await databases.createStringAttribute(
                    databaseId,
                    publicationsCollectionId,
                    'compiledWorkflowSnapshot',
                    1000000,                       // size (~1 MB)
                    false,                         // required
                    null,                          // default
                    false                          // array
                );
                created.push('compiledWorkflowSnapshot');
            } catch (err) {
                if (err?.code === 409 || /already exists/i.test(err?.message || '')) {
                    skipped.push('compiledWorkflowSnapshot');
                } else {
                    error(`[BootstrapPublicationSchema] compiledWorkflowSnapshot létrehozás hiba: ${err.message}`);
                    return fail(res, 500, 'schema_snapshot_failed', { error: err.message });
                }
            }

            log(`[BootstrapPublicationSchema] User ${callerId}: created=[${created.join(',')}] skipped=[${skipped.join(',')}]`);

            return res.json({
                success: true,
                created,
                skipped,
                note: 'Az attribútum feldolgozása ~5-10s. Várj a publikáció aktiválás előtt.'
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'bootstrap_permission_sets_schema'
        // ════════════════════════════════════════════════════════
        //
        // A.1 (ADR 0008) — két új collection idempotens létrehozása a
        // jogosultság-csoport (permissionSet) réteghez. A `bootstrap_workflow_schema`
        // mintáját követi: owner-only, 409 → skip, `created`/`skipped`/`indexesPending`
        // listák a response-ban.
        //
        // Doc-szintű ACL (ADR 0003): collection perms üres + `documentSecurity: true`,
        // a read-jogot a doc-onkénti `team:office_${officeId}` adja. Deploy után a
        // Console-on ellenőrizendő, hogy a `rowSecurity` flag aktív (különben a
        // doc-ACL nem érvényesül).
        if (action === 'bootstrap_permission_sets_schema') {
            // 1. Caller legalább egy org owner-e
            const ownerships = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.equal('role', 'owner'),
                    sdk.Query.limit(1)
                ]
            );
            if (ownerships.documents.length === 0) {
                return fail(res, 403, 'insufficient_role', {
                    requiredRole: 'owner'
                });
            }

            // 2. Action-szintű env var guard (csak itt kötelező).
            const missingActionEnvVars = [];
            if (!permissionSetsCollectionId) {
                missingActionEnvVars.push('PERMISSION_SETS_COLLECTION_ID');
            }
            if (!groupPermissionSetsCollectionId) {
                missingActionEnvVars.push('GROUP_PERMISSION_SETS_COLLECTION_ID');
            }
            if (missingActionEnvVars.length > 0) {
                return fail(res, 500, 'misconfigured', {
                    missing: missingActionEnvVars
                });
            }

            const created = [];
            const skipped = [];
            const indexesPending = [];

            // ── Lokális helperek (csak ezen az action-en belül) ──────────
            // A 3 ismétlődő boilerplate egységesítése: collection-create,
            // attribute-create-loop, index-create-loop. Az `isAlreadyExists`
            // a 409 / "already exists" idempotens skip-feltételt fedi.
            const isAlreadyExists = (err) =>
                err?.code === 409 || /already exists/i.test(err?.message || '');

            const ensureCollection = async (colId, label) => {
                try {
                    await databases.createCollection(databaseId, colId, label, [], true, true);
                    created.push(`collection:${label}`);
                    return true;
                } catch (err) {
                    if (isAlreadyExists(err)) {
                        skipped.push(`collection:${label}`);
                        return true;
                    }
                    error(`[BootstrapPermissionSetsSchema] ${label} collection létrehozás hiba: ${err.message}`);
                    return fail(res, 500, 'schema_collection_failed', { collection: label, error: err.message });
                }
            };

            const ensureAttributes = async (colId, label, attrs) => {
                for (const attr of attrs) {
                    try {
                        if (attr.kind === 'datetime') {
                            await databases.createDatetimeAttribute(databaseId, colId, attr.name, attr.required, null, false);
                        } else {
                            await databases.createStringAttribute(databaseId, colId, attr.name, attr.size, attr.required, null, attr.array === true);
                        }
                        created.push(`${label}.${attr.name}`);
                    } catch (err) {
                        if (isAlreadyExists(err)) {
                            skipped.push(`${label}.${attr.name}`);
                        } else {
                            error(`[BootstrapPermissionSetsSchema] ${label}.${attr.name} attribútum hiba: ${err.message}`);
                            return fail(res, 500, 'schema_attribute_failed', { collection: label, attribute: attr.name, error: err.message });
                        }
                    }
                }
                return true;
            };

            const ensureIndexes = async (colId, label, indexes) => {
                for (const idx of indexes) {
                    try {
                        await databases.createIndex(databaseId, colId, idx.key, idx.type, idx.attrs);
                        created.push(`${label}.index:${idx.key}`);
                    } catch (err) {
                        const msg = err?.message || '';
                        if (isAlreadyExists(err)) {
                            skipped.push(`${label}.index:${idx.key}`);
                        } else if (err?.code === 400 && /not available|processing|unknown attribute/i.test(msg)) {
                            // Az aszinkron attribute-feldolgozás 400-at pending-re
                            // tesszük, egyéb 400 (érvénytelen index név, inkompatibilis
                            // attribute típus stb.) propagáljon — ne nyelje el a driftet.
                            indexesPending.push(`${label}.${idx.key}`);
                        } else {
                            error(`[BootstrapPermissionSetsSchema] ${label}.index:${idx.key} hiba: ${err.message}`);
                            return fail(res, 500, 'schema_index_failed', { collection: label, index: idx.key, error: err.message });
                        }
                    }
                }
                return true;
            };

            // ── permissionSets ──────────────────────────────────────────
            // A `permissions` egy string tömb — egy slug max 100 char
            // (`<resource>.<sub>.<action>` formátum bőven elfér). Az
            // `archivedAt` nullable (soft-delete marker).
            const permissionSetsAttrs = [
                { name: 'name',              kind: 'string',   size: 100,  required: true },
                { name: 'slug',              kind: 'string',   size: 100,  required: true },
                { name: 'description',       kind: 'string',   size: 500,  required: false },
                { name: 'permissions',       kind: 'string',   size: 100,  required: true,  array: true },
                { name: 'editorialOfficeId', kind: 'string',   size: 36,   required: true },
                { name: 'organizationId',    kind: 'string',   size: 36,   required: true },
                { name: 'archivedAt',        kind: 'datetime',             required: false },
                { name: 'createdByUserId',   kind: 'string',   size: 36,   required: false }
            ];
            // Az `office_slug_unique` egy office-on belül slug-ütközést
            // akadályoz; az `office_idx` / `org_idx` a Realtime + listing
            // query-khez kell.
            const permissionSetsIndexes = [
                { key: 'office_slug_unique', type: 'unique', attrs: ['editorialOfficeId', 'slug'] },
                { key: 'office_idx',         type: 'key',    attrs: ['editorialOfficeId'] },
                { key: 'org_idx',            type: 'key',    attrs: ['organizationId'] }
            ];

            const psCol = await ensureCollection(permissionSetsCollectionId, 'permissionSets');
            if (psCol !== true) return psCol;
            const psAttrs = await ensureAttributes(permissionSetsCollectionId, 'permissionSets', permissionSetsAttrs);
            if (psAttrs !== true) return psAttrs;
            const psIdx = await ensureIndexes(permissionSetsCollectionId, 'permissionSets', permissionSetsIndexes);
            if (psIdx !== true) return psIdx;

            // ── groupPermissionSets (m:n junction) ──────────────────────
            const groupPermissionSetsAttrs = [
                { name: 'groupId',           kind: 'string', size: 36, required: true },
                { name: 'permissionSetId',   kind: 'string', size: 36, required: true },
                { name: 'editorialOfficeId', kind: 'string', size: 36, required: true },
                { name: 'organizationId',    kind: 'string', size: 36, required: true }
            ];
            // A `group_set_unique` (groupId, permissionSetId) páronként egy
            // junction doc-ot enged — duplikátum-blokk. A többi index a
            // Realtime/lookup útvonalakhoz.
            const groupPermissionSetsIndexes = [
                { key: 'group_set_unique', type: 'unique', attrs: ['groupId', 'permissionSetId'] },
                { key: 'office_idx',       type: 'key',    attrs: ['editorialOfficeId'] },
                { key: 'group_idx',        type: 'key',    attrs: ['groupId'] },
                { key: 'set_idx',          type: 'key',    attrs: ['permissionSetId'] }
            ];

            const gpsCol = await ensureCollection(groupPermissionSetsCollectionId, 'groupPermissionSets');
            if (gpsCol !== true) return gpsCol;
            const gpsAttrs = await ensureAttributes(groupPermissionSetsCollectionId, 'groupPermissionSets', groupPermissionSetsAttrs);
            if (gpsAttrs !== true) return gpsAttrs;
            const gpsIdx = await ensureIndexes(groupPermissionSetsCollectionId, 'groupPermissionSets', groupPermissionSetsIndexes);
            if (gpsIdx !== true) return gpsIdx;

            log(`[BootstrapPermissionSetsSchema] User ${callerId}: created=[${created.join(',')}] skipped=[${skipped.join(',')}] indexesPending=[${indexesPending.join(',')}]`);

            const note = indexesPending.length > 0
                ? 'Az attribútumok feldolgozása ~5-10s. Futtasd újra az action-t amíg az indexesPending lista kiürül.'
                : 'A schema kész. A következő lépés (A.3.2): bootstrap_organization kibővítése default permission set-ek seedelésével.';

            return res.json({
                success: true,
                created,
                skipped,
                indexesPending,
                note
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'create_workflow'
        // ════════════════════════════════════════════════════════
        //
        // Új workflow létrehozása egy meglévő szerkesztőséghez. Owner/admin only.
        // A Dashboard Workflow Designer „+ Új workflow" gombja hívja.
        //
        // Opcionális `visibility` (default `editorial_office`): a listázási
        // láthatóság szabályozása. A `createdBy` automatikusan a callerId
        // (kliens NEM küldheti — biztonsági ok, a mező ownership-et reprezentál).
        if (action === 'create_workflow') {
            const { editorialOfficeId } = payload;
            const sanitizedName = sanitizeString(payload.name, NAME_MAX_LENGTH);

            // Visibility whitelist check — ha a kliens kap érvénytelen értéket,
            // fail-fast (ne tároljunk szemetet a DB-ben).
            const visibility = payload.visibility !== undefined
                ? payload.visibility
                : WORKFLOW_VISIBILITY_DEFAULT;
            if (!WORKFLOW_VISIBILITY_VALUES.includes(visibility)) {
                return fail(res, 400, 'invalid_visibility', {
                    allowed: WORKFLOW_VISIBILITY_VALUES
                });
            }

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
            // mert egy office-on belül több workflow is létezhet).
            // A `createWorkflowDoc` helper schema-safe fallback-et ad a rollout
            // ablakra (ha a `bootstrap_workflow_schema` még nem futott le).
            let newWorkflowDoc;
            try {
                newWorkflowDoc = await createWorkflowDoc(
                    databases,
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
                    },
                    visibility,
                    callerId,
                    buildWorkflowAclPerms(visibility, orgId, editorialOfficeId),
                    log
                );
            } catch (createErr) {
                error(`[CreateWorkflow] createDocument hiba: ${createErr.message}`);
                return fail(res, 500, 'create_failed');
            }

            log(`[CreateWorkflow] User ${callerId} új workflow-t hozott létre: id=${newWorkflowDoc.$id}, name="${sanitizedName}", office=${editorialOfficeId}, visibility=${visibility}`);

            return res.json({
                success: true,
                action: 'created',
                workflowId: newWorkflowDoc.$id,
                name: sanitizedName,
                visibility,
                createdBy: callerId
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

            // Rollback-stack (LIFO) — lásd bootstrap_organization komment.
            const rollbackSteps = [];
            const runRollback = async () => {
                for (let i = rollbackSteps.length - 1; i >= 0; i--) {
                    try { await rollbackSteps[i](); }
                    catch (e) { error(`[CreateOffice] rollback lépés hiba: ${e.message}`); }
                }
            };

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
                    rollbackSteps.push(() => databases.deleteDocument(databaseId, officesCollectionId, newOfficeId));
                    break;
                } catch (err) {
                    const isUnique = err?.type === 'document_already_exists' || /unique/i.test(err?.message || '');
                    if (isUnique && attempt < 2) continue;
                    error(`[CreateOffice] office create hiba (slug=${candidateSlug}, attempt=${attempt}): ${err.message}`);
                    if (isUnique) return fail(res, 409, 'office_slug_taken');
                    return fail(res, 500, 'office_create_failed');
                }
            }

            // 3.5. Office team — tenant ACL alapja, idempotens
            const officeTeamId = buildOfficeTeamId(newOfficeId);
            try {
                const result = await ensureTeam(teamsApi, officeTeamId, `Office: ${sanitizedName}`);
                if (result.created) {
                    rollbackSteps.push(() => teamsApi.delete(officeTeamId));
                }
            } catch (err) {
                error(`[CreateOffice] office team create hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'office_team_create_failed');
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
                rollbackSteps.push(() => databases.deleteDocument(databaseId, officeMembershipsCollectionId, newOfficeMembershipId));
            } catch (err) {
                error(`[CreateOffice] officeMembership create hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'office_membership_create_failed');
            }

            // 4.5. Caller az office team-be (admin role — cascade-re épít: a team
            //      törlése törli a memberships-et is, ezért nem kell explicit rollback step).
            try {
                await ensureTeamMembership(teamsApi, officeTeamId, callerId, ['admin']);
            } catch (err) {
                error(`[CreateOffice] office team membership hiba: ${err.message}`);
                await runRollback();
                return fail(res, 500, 'office_team_membership_create_failed');
            }

            // 5. 7 default group az új office-hoz — office ACL scope-pal.
            const createdGroupIds = [];
            rollbackSteps.push(async () => {
                for (const gId of createdGroupIds) {
                    try { await databases.deleteDocument(databaseId, groupsCollectionId, gId); }
                    catch (e) { error(`[CreateOffice] group rollback sikertelen (${gId}): ${e.message}`); }
                }
            });
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
                        },
                        buildOfficeAclPerms(newOfficeId)
                    );
                    createdGroupIds.push(groupDoc.$id);
                }
            } catch (err) {
                error(`[CreateOffice] groups create hiba (${createdGroupIds.length}/${DEFAULT_GROUPS.length} kész): ${err.message}`);
                await runRollback();
                return fail(res, 500, 'groups_create_failed');
            }

            // 6. groupMemberships — a caller tagja lesz mindegyiknek + office ACL.
            let callerUser;
            try {
                callerUser = await usersApi.get(callerId);
            } catch (e) {
                log(`[CreateOffice] Caller user lookup hiba (groupMemberships userName/userEmail): ${e.message}`);
                callerUser = { name: '', email: '' };
            }

            const createdGmIds = [];
            rollbackSteps.push(async () => {
                for (const gmId of createdGmIds) {
                    try { await databases.deleteDocument(databaseId, groupMembershipsCollectionId, gmId); }
                    catch (e) { error(`[CreateOffice] groupMembership rollback sikertelen (${gmId}): ${e.message}`); }
                }
            });
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
                        },
                        buildOfficeAclPerms(newOfficeId)
                    );
                    createdGmIds.push(gmDoc.$id);
                }
            } catch (err) {
                error(`[CreateOffice] groupMemberships create hiba (${createdGmIds.length}/${createdGroupIds.length} kész): ${err.message}`);
                await runRollback();
                return fail(res, 500, 'group_memberships_create_failed');
            }

            // 7. Opcionális workflow klón. Nem kritikus — ha elhasal, az office
            //    workflow nélkül marad (felhasználó később #30-ban rendelhet hozzá).
            let newWorkflowId = null;
            if (sourceWorkflowDoc) {
                try {
                    const workflowDoc = await createWorkflowDoc(
                        databases,
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
                        },
                        WORKFLOW_VISIBILITY_DEFAULT,
                        callerId,
                        buildWorkflowAclPerms(WORKFLOW_VISIBILITY_DEFAULT, organizationId, newOfficeId),
                        log
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

        // ════════════════════════════════════════════════════════
        // ACTION = 'update_workflow_metadata'
        // ════════════════════════════════════════════════════════
        //
        // Workflow metaadat frissítés (név + visibility) compiled JSON
        // érintés nélkül. A WorkflowTab dropdownjai és az inline rename
        // hívja. Külön action (nem az update_workflow bővítése), mert
        // nincs szükség verzió-bumpra / compiled newline-ra.
        //
        // Auth: org owner/admin (az update_workflow-val azonos gate).
        // Payload: { editorialOfficeId, workflowId, name?, visibility? }
        if (action === 'update_workflow_metadata') {
            const { editorialOfficeId, workflowId } = payload;
            const renameTo = payload.name !== undefined
                ? sanitizeString(payload.name, NAME_MAX_LENGTH)
                : null;
            const visibility = payload.visibility;
            // #80 description field — nullable textarea, `null` szándékos
            // törlés (trim → "" → null), `undefined` = no-op.
            const DESCRIPTION_MAX_LENGTH = 500;
            let descriptionUpdate = undefined;
            if (payload.description !== undefined) {
                if (payload.description === null) {
                    descriptionUpdate = null;
                } else if (typeof payload.description !== 'string') {
                    return fail(res, 400, 'invalid_description');
                } else {
                    const trimmed = payload.description.trim().slice(0, DESCRIPTION_MAX_LENGTH);
                    descriptionUpdate = trimmed.length === 0 ? null : trimmed;
                }
            }

            if (!editorialOfficeId || !workflowId) {
                return fail(res, 400, 'missing_fields', {
                    required: ['editorialOfficeId', 'workflowId']
                });
            }
            if (payload.name !== undefined && !renameTo) {
                return fail(res, 400, 'invalid_name');
            }
            if (visibility !== undefined && !WORKFLOW_VISIBILITY_VALUES.includes(visibility)) {
                return fail(res, 400, 'invalid_visibility', {
                    allowed: WORKFLOW_VISIBILITY_VALUES
                });
            }
            if (!renameTo && visibility === undefined && descriptionUpdate === undefined) {
                return fail(res, 400, 'nothing_to_update');
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

            // 3. Workflow doc betöltés + scope match
            let workflowDoc;
            try {
                workflowDoc = await databases.getDocument(
                    databaseId,
                    workflowsCollectionId,
                    workflowId
                );
            } catch (err) {
                return fail(res, 404, 'workflow_not_found');
            }
            if (workflowDoc.editorialOfficeId !== editorialOfficeId) {
                return fail(res, 403, 'scope_mismatch');
            }

            // 4. Rename unique check (csak ha változik)
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

            // 5. Update payload összeállítás (csak a változó mezők)
            const updateData = { updatedByUserId: callerId };
            if (renameTo && renameTo !== workflowDoc.name) {
                updateData.name = renameTo;
            }
            if (visibility !== undefined && visibility !== workflowDoc.visibility) {
                updateData.visibility = visibility;
            }
            if (descriptionUpdate !== undefined && descriptionUpdate !== (workflowDoc.description ?? null)) {
                updateData.description = descriptionUpdate;
            }

            // Ha minden mező no-op (rename to same / visibility to same /
            // description to same), success válasz (idempotens), nem kell
            // DB hit.
            if (Object.keys(updateData).length === 1) {
                return res.json({
                    success: true,
                    workflowId: workflowDoc.$id,
                    name: workflowDoc.name,
                    visibility: workflowDoc.visibility,
                    description: workflowDoc.description ?? null,
                    action: 'noop'
                });
            }

            // 5-pre. #81 — Visibility váltás kizárólag a tulajdonosnak
            // (`createdBy === callerId`). A rename/description továbbra is
            // org owner/admin joggal elvégezhető — a scope viszont üzleti
            // döntés, ami a workflow „gazdájának" a kompetenciája (a plan
            // szerint a későbbi részletes jogosultsági rendszer ezt finomítja).
            if (updateData.visibility && workflowDoc.createdBy !== callerId) {
                return fail(res, 403, 'not_workflow_owner', {
                    field: 'visibility',
                    yourRole: callerRole,
                    note: 'A scope (visibility) váltás csak a workflow tulajdonosának (createdBy) van engedélyezve.'
                });
            }

            // 5a. #80 — Visibility szűkítés warning scan (a #30 blocking
            // logika helyett). A user döntése alapján a szűkítés nem blokkol:
            // az aktív publikációk `compiledWorkflowSnapshot` alapján
            // tovább futnak, a korábbi másolatok megmaradnak, de az új scope
            // határain kívüli szerkesztőségek már nem indíthatnak új
            // publikációt ezzel a workflow-val. A CF figyelmezteti a klienst
            // a szűkülő scope-on kívüli publikációk listájával, a kliens
            // popup-ot mutat, majd `force: true` flag-gel újraküldi a hívást,
            // ha a user jóváhagyta.
            //
            // Szűkítés irány: public → {organization|editorial_office}, vagy
            // organization → editorial_office.
            if (
                updateData.visibility
                && updateData.visibility !== workflowDoc.visibility
                && !payload.force
            ) {
                const currentVisibility = workflowDoc.visibility;
                const newVisibility = updateData.visibility;
                const isShrinking =
                    (currentVisibility === 'public' && newVisibility !== 'public')
                    || (currentVisibility === 'organization' && newVisibility === 'editorial_office');

                if (isShrinking) {
                    if (!publicationsCollectionId) {
                        error('[UpdateWorkflowMetadata] PUBLICATIONS_COLLECTION_ID env var hiányzik');
                        return fail(res, 500, 'env_missing', {
                            required: 'PUBLICATIONS_COLLECTION_ID'
                        });
                    }

                    const orphanedPublications = [];
                    let shrinkageCursor = null;

                    shrinkageScanLoop:
                    while (true) {
                        const queries = [
                            sdk.Query.equal('workflowId', workflowId),
                            sdk.Query.select(['$id', 'name', 'editorialOfficeId', 'organizationId']),
                            sdk.Query.limit(CASCADE_BATCH_LIMIT)
                        ];
                        if (shrinkageCursor) queries.push(sdk.Query.cursorAfter(shrinkageCursor));

                        const batch = await databases.listDocuments(
                            databaseId,
                            publicationsCollectionId,
                            queries
                        );
                        if (batch.documents.length === 0) break;
                        for (const doc of batch.documents) {
                            const isInNewScope =
                                (newVisibility === 'public')
                                || (newVisibility === 'organization' && doc.organizationId === orgId)
                                || (newVisibility === 'editorial_office' && doc.editorialOfficeId === editorialOfficeId);
                            if (isInNewScope) continue;
                            orphanedPublications.push({
                                $id: doc.$id,
                                name: doc.name,
                                organizationId: doc.organizationId,
                                editorialOfficeId: doc.editorialOfficeId
                            });
                            if (orphanedPublications.length >= MAX_REFERENCES_PER_SCAN) {
                                break shrinkageScanLoop;
                            }
                        }
                        if (batch.documents.length < CASCADE_BATCH_LIMIT) break;
                        shrinkageCursor = batch.documents[batch.documents.length - 1].$id;
                    }

                    if (orphanedPublications.length > 0) {
                        return res.json({
                            success: false,
                            reason: 'visibility_shrinkage_warning',
                            from: currentVisibility,
                            to: newVisibility,
                            orphanedPublications,
                            count: orphanedPublications.length,
                            note: 'Az aktív publikációk a compiledWorkflowSnapshot alapján tovább futnak, és a korábbi másolatok is megmaradnak. A szűkített scope-on kívüli szerkesztőségek új publikációt már nem indíthatnak ezzel a workflow-val. Confirm-hoz küldd újra a hívást `force: true` flag-gel.'
                        });
                    }
                }
            }

            // 5b. #80 — ACL újraszámolás visibility-váltásnál. A
            // `buildWorkflowAclPerms` a scope alapján ad read-permission-t
            // (office/org team vagy users). Ha a visibility nem változik, a
            // perms paramétert nem adjuk át (Appwrite megőrzi a meglévőt).
            const updatePerms = updateData.visibility
                ? buildWorkflowAclPerms(updateData.visibility, orgId, editorialOfficeId)
                : undefined;

            await databases.updateDocument(
                databaseId,
                workflowsCollectionId,
                workflowDoc.$id,
                updateData,
                updatePerms
            );

            log(`[UpdateWorkflowMetadata] Workflow ${workflowDoc.$id}: ${Object.keys(updateData).filter(k => k !== 'updatedByUserId').join(',')} változott (by ${callerId})`);

            return res.json({
                success: true,
                workflowId: workflowDoc.$id,
                name: updateData.name || workflowDoc.name,
                visibility: updateData.visibility || workflowDoc.visibility,
                description: 'description' in updateData
                    ? updateData.description
                    : (workflowDoc.description ?? null)
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'archive_workflow'  (#81, 2026-04-20)
        // ════════════════════════════════════════════════════════
        //
        // Soft-delete: `archivedAt = now()` set. Az archivált workflow-t
        // a `WorkflowLibraryPanel` kiszűri a default listból (külön „Archív"
        // nézet jelenítheti meg a restore-hoz). A már aktivált publikációk
        // a `compiledWorkflowSnapshot`-ból futnak tovább (a doc read ACL-je
        // marad).
        //
        // 7 nap elteltével a scheduled `cleanup-archived-workflows` CF
        // hard-deletet hajt végre (blocking scan a hivatkozó publikációk
        // miatt — snapshot-tal védett aktív pub-ok NEM blokkolnak,
        // snapshot-nélküliek igen).
        //
        // Auth: `createdBy === callerId` (tulajdonos) VAGY org owner/admin
        // fallback (egy kilépett tag workflow-ját is lehessen takarítani).
        //
        // Payload: `{ editorialOfficeId, workflowId }`. Idempotens: már
        // archivált → `already_archived` success response.
        if (action === 'archive_workflow' || action === 'restore_workflow') {
            const { editorialOfficeId, workflowId } = payload;
            const isArchive = action === 'archive_workflow';

            if (!editorialOfficeId || !workflowId) {
                return fail(res, 400, 'missing_fields', {
                    required: ['editorialOfficeId', 'workflowId']
                });
            }

            // 1. Office lookup → organizationId
            let officeDoc;
            try {
                officeDoc = await databases.getDocument(
                    databaseId,
                    officesCollectionId,
                    editorialOfficeId
                );
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'office_not_found');
                error(`[ArchiveWorkflow] office lookup threw: ${err.message} (code=${err.code}, type=${err.type})`);
                return fail(res, 500, 'office_fetch_failed');
            }
            const orgId = officeDoc.organizationId;

            // 2. Caller org membership lookup (role meghatározáshoz)
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

            // 3. Workflow doc + scope match
            let workflowDoc;
            try {
                workflowDoc = await databases.getDocument(
                    databaseId,
                    workflowsCollectionId,
                    workflowId
                );
            } catch (err) {
                return fail(res, 404, 'workflow_not_found');
            }
            if (workflowDoc.editorialOfficeId !== editorialOfficeId) {
                return fail(res, 403, 'scope_mismatch');
            }

            // 4. Ownership guard: createdBy VAGY org owner/admin fallback.
            const isCreator = workflowDoc.createdBy === callerId;
            const isOrgAdmin = callerRole === 'owner' || callerRole === 'admin';
            if (!isCreator && !isOrgAdmin) {
                return fail(res, 403, 'not_workflow_owner', {
                    yourRole: callerRole,
                    note: 'Csak a workflow tulajdonosa (createdBy) vagy szervezeti admin/owner végezheti ezt a műveletet.'
                });
            }

            // 5. Idempotens státusz check
            const currentlyArchived = !!workflowDoc.archivedAt;
            if (isArchive && currentlyArchived) {
                return res.json({
                    success: true,
                    action: 'already_archived',
                    workflowId: workflowDoc.$id,
                    archivedAt: workflowDoc.archivedAt
                });
            }
            if (!isArchive && !currentlyArchived) {
                return res.json({
                    success: true,
                    action: 'already_active',
                    workflowId: workflowDoc.$id
                });
            }

            // 6. Update — archivedAt állítás (null-ra vagy now()-ra).
            const nowIso = new Date().toISOString();
            const updateData = {
                archivedAt: isArchive ? nowIso : null,
                updatedByUserId: callerId
            };

            try {
                await databases.updateDocument(
                    databaseId,
                    workflowsCollectionId,
                    workflowDoc.$id,
                    updateData
                );
            } catch (updateErr) {
                error(`[${isArchive ? 'ArchiveWorkflow' : 'RestoreWorkflow'}] updateDocument hiba (${workflowId}): ${updateErr.message}`);
                return fail(res, 500, isArchive ? 'archive_failed' : 'restore_failed');
            }

            log(`[${isArchive ? 'ArchiveWorkflow' : 'RestoreWorkflow'}] User ${callerId} ${isArchive ? 'archiválta' : 'visszaállította'} a workflow-t: id=${workflowId}, name="${workflowDoc.name}"`);

            return res.json({
                success: true,
                action: isArchive ? 'archived' : 'restored',
                workflowId: workflowDoc.$id,
                archivedAt: isArchive ? nowIso : null
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'delete_workflow'
        // ════════════════════════════════════════════════════════
        //
        // Workflow törlése. A WorkflowTab „Törlés" gombja hívja.
        //
        // Blocking check: nem törölhető, ha bármely publikáció (office-on
        // belül VAGY az org-on belül, ha visibility='organization') a
        // workflow-ra hivatkozik (`publications.workflowId`). Válasz:
        // `workflow_in_use` + érintett publikációk listája.
        //
        // Auth: org owner/admin. A `createdBy` alapú ownership NEM gate
        // MVP-ben (nincs private visibility).
        if (action === 'delete_workflow') {
            const { editorialOfficeId, workflowId } = payload;

            if (!editorialOfficeId || !workflowId) {
                return fail(res, 400, 'missing_fields', {
                    required: ['editorialOfficeId', 'workflowId']
                });
            }
            if (!publicationsCollectionId) {
                error('[DeleteWorkflow] PUBLICATIONS_COLLECTION_ID env var hiányzik');
                return fail(res, 500, 'env_missing', {
                    required: 'PUBLICATIONS_COLLECTION_ID'
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

            // 3. Workflow doc betöltés + scope match
            let workflowDoc;
            try {
                workflowDoc = await databases.getDocument(
                    databaseId,
                    workflowsCollectionId,
                    workflowId
                );
            } catch (err) {
                return fail(res, 404, 'workflow_not_found');
            }
            if (workflowDoc.editorialOfficeId !== editorialOfficeId) {
                return fail(res, 403, 'scope_mismatch');
            }

            // 4. Publikáció-hivatkozás scan. Organization-visibility esetén az
            // egész org publikációit nézzük (cross-office hivatkozás), különben
            // csak az office-t. Pagination + match-cap a MAX_REFERENCES_PER_SCAN-nel
            // (bounded payload + memória).
            const isOrgScope = workflowDoc.visibility === 'organization';
            const usedByPublications = [];
            let cursor = null;

            pubScanLoop:
            while (true) {
                const queries = [
                    sdk.Query.equal('workflowId', workflowId),
                    sdk.Query.select(['$id', 'name', 'editorialOfficeId']),
                    sdk.Query.limit(CASCADE_BATCH_LIMIT)
                ];
                if (isOrgScope) {
                    queries.push(sdk.Query.equal('organizationId', orgId));
                } else {
                    queries.push(sdk.Query.equal('editorialOfficeId', editorialOfficeId));
                }
                if (cursor) queries.push(sdk.Query.cursorAfter(cursor));

                const batch = await databases.listDocuments(
                    databaseId,
                    publicationsCollectionId,
                    queries
                );
                if (batch.documents.length === 0) break;
                for (const doc of batch.documents) {
                    usedByPublications.push({ $id: doc.$id, name: doc.name });
                    if (usedByPublications.length >= MAX_REFERENCES_PER_SCAN) {
                        break pubScanLoop;
                    }
                }
                if (batch.documents.length < CASCADE_BATCH_LIMIT) break;
                cursor = batch.documents[batch.documents.length - 1].$id;
            }

            if (usedByPublications.length > 0) {
                return fail(res, 400, 'workflow_in_use', {
                    usedByPublications,
                    count: usedByPublications.length
                });
            }

            // 5. Törlés (a Plugin DataContext Realtime handlere reagál a .delete
            // event-re, a `workflows[]`-ből eltávolítja).
            try {
                await databases.deleteDocument(
                    databaseId,
                    workflowsCollectionId,
                    workflowId
                );
            } catch (delErr) {
                error(`[DeleteWorkflow] deleteDocument hiba (${workflowId}): ${delErr.message}`);
                return fail(res, 500, 'delete_failed');
            }

            log(`[DeleteWorkflow] User ${callerId} törölte a workflow-t: id=${workflowId}, name="${workflowDoc.name}", office=${editorialOfficeId}`);

            return res.json({
                success: true,
                action: 'deleted',
                workflowId,
                name: workflowDoc.name
            });
        }

        // ════════════════════════════════════════════════════════
        // ACTION = 'duplicate_workflow'  (#81 cross-tenant, 2026-04-20)
        // ════════════════════════════════════════════════════════
        //
        // Cross-tenant workflow duplikálás. A forrás-workflow bárhol lehet
        // (saját office, saját org másik office-a, publikus). Ha a caller
        // olvashatja (visibility + membership alapján), duplikálhatja a
        // saját (target) office-ába.
        //
        // Szándékos szemantika (#81 plan): a duplikátum MINDIG
        // `visibility = editorial_office` scope-on indul, függetlenül a
        // forrás scope-jától. A tulajdonos (createdBy) a caller lesz;
        // a későbbi scope-tágítást az `update_workflow_metadata` végzi.
        //
        // Payload:
        //   - `editorialOfficeId` (kötelező) — **TARGET** office, ahová a
        //     másolat kerül (a caller aktív office-a).
        //   - `workflowId` (kötelező) — a forrás workflow `$id`-je
        //     (bárhonnan származhat, ha a caller olvashatja).
        //   - `name` (opcionális) — ha hiányzik, `${source.name} (másolat)`
        //     a default. Target office-on belül unique-re kell igazítani.
        //
        // Auth: caller target office-ának org owner/admin tagja (ugyanaz
        //       a guard, mint a `create_workflow`-nál). Read-access a
        //       forrásra: `public` mindenkinek, `organization` same-org,
        //       `editorial_office` same-office.
        if (action === 'duplicate_workflow') {
            const { editorialOfficeId, workflowId } = payload;
            const explicitName = payload.name !== undefined
                ? sanitizeString(payload.name, NAME_MAX_LENGTH)
                : null;

            if (!editorialOfficeId || !workflowId) {
                return fail(res, 400, 'missing_fields', {
                    required: ['editorialOfficeId', 'workflowId']
                });
            }
            if (payload.name !== undefined && !explicitName) {
                return fail(res, 400, 'invalid_name');
            }

            // 1. Target office lookup → target organizationId
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
            const targetOrgId = office.documents[0].organizationId;

            // 2. Target auth: caller target-org owner/admin (create_workflow-val
            // analóg). Ez védi a target office-ot: a cross-tenant duplikát
            // csak akkor kerülhet bele, ha a caller jogosult új workflow-t
            // létrehozni a target office-ban.
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', targetOrgId),
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

            // 3. Forrás workflow lookup (bárhol lehet)
            let sourceDoc;
            try {
                sourceDoc = await databases.getDocument(
                    databaseId,
                    workflowsCollectionId,
                    workflowId
                );
            } catch (err) {
                return fail(res, 404, 'workflow_not_found');
            }

            // Archivált forrás duplikálása blokkolva — ha szükséges, a user
            // először restore-olhatja (nincs semmi akadálya, csak explicit
            // lépés legyen).
            if (sourceDoc.archivedAt) {
                return fail(res, 400, 'source_archived', {
                    workflowId: sourceDoc.$id,
                    archivedAt: sourceDoc.archivedAt
                });
            }

            // 4. Read-access check a forrásra. A Team ACL a Realtime + kliens
            // olvasást szűri, de itt API key-jel olvasunk — a business-rule
            // check tehát expliciten itt zajlik.
            const sourceVisibility = WORKFLOW_VISIBILITY_VALUES.includes(sourceDoc.visibility)
                ? sourceDoc.visibility
                : WORKFLOW_VISIBILITY_DEFAULT;

            if (sourceVisibility === 'editorial_office') {
                // Csak a source office tagja olvashatja.
                const sourceOfficeMembership = await databases.listDocuments(
                    databaseId,
                    officeMembershipsCollectionId,
                    [
                        sdk.Query.equal('editorialOfficeId', sourceDoc.editorialOfficeId),
                        sdk.Query.equal('userId', callerId),
                        sdk.Query.limit(1)
                    ]
                );
                if (sourceOfficeMembership.documents.length === 0) {
                    return fail(res, 403, 'source_not_readable', {
                        visibility: sourceVisibility,
                        note: 'A forrás workflow editorial_office scope-ú, és a caller nem tagja a forrás-office-nak.'
                    });
                }
            } else if (sourceVisibility === 'organization') {
                // Az adott org bármely tagja olvashatja.
                const sourceOrgMembership = await databases.listDocuments(
                    databaseId,
                    membershipsCollectionId,
                    [
                        sdk.Query.equal('organizationId', sourceDoc.organizationId),
                        sdk.Query.equal('userId', callerId),
                        sdk.Query.limit(1)
                    ]
                );
                if (sourceOrgMembership.documents.length === 0) {
                    return fail(res, 403, 'source_not_readable', {
                        visibility: sourceVisibility,
                        note: 'A forrás workflow organization scope-ú, és a caller nem tagja a forrás-szervezetnek.'
                    });
                }
            }
            // `public` esetén minden authentikált user olvashatja → nincs check.

            // 5. Név meghatározás: explicit vagy `${forrás név} (másolat)`.
            //    Target office-on belül unique — ha ütközik, `(másolat 2)`,
            //    `(másolat 3)`, stb. (max 20 próbálkozás, fail-fast cap).
            const baseName = explicitName || `${sourceDoc.name} (másolat)`;
            let candidateName = baseName;
            let suffix = 2;
            const MAX_NAME_CANDIDATES = 20;
            while (suffix <= MAX_NAME_CANDIDATES + 1) {
                const clash = await databases.listDocuments(
                    databaseId,
                    workflowsCollectionId,
                    [
                        sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                        sdk.Query.equal('name', candidateName),
                        sdk.Query.limit(1)
                    ]
                );
                if (clash.documents.length === 0) break;
                if (explicitName) {
                    // Ha a user explicit nevet adott, ne próbáljunk suffix-et
                    // hozzáfűzni — érvényes üzenetet kapjon.
                    return fail(res, 400, 'name_taken', { name: candidateName });
                }
                candidateName = `${sourceDoc.name} (másolat ${suffix})`;
                suffix++;
            }
            if (suffix > MAX_NAME_CANDIDATES + 1) {
                return fail(res, 400, 'name_taken', {
                    name: baseName,
                    note: `Több mint ${MAX_NAME_CANDIDATES} hasonló nevű workflow van a target office-ban — adj meg explicit nevet.`
                });
            }

            // 6. Compiled klón — version reset (new doc, own version line)
            let compiledClone;
            try {
                const source = typeof sourceDoc.compiled === 'string'
                    ? JSON.parse(sourceDoc.compiled)
                    : sourceDoc.compiled;
                compiledClone = JSON.parse(JSON.stringify(source || {}));
                compiledClone.version = 1;
            } catch (parseErr) {
                error(`[DuplicateWorkflow] forrás compiled JSON parse hiba (${workflowId}): ${parseErr.message}`);
                return fail(res, 500, 'source_compiled_invalid');
            }

            // 7. Új visibility FORCED `editorial_office` — cross-tenant
            // megosztás alaphelyzet. A user a duplikátumot később átkapcsolhatja
            // organization/public scope-ra az `update_workflow_metadata`-val.
            const newVisibility = WORKFLOW_VISIBILITY_DEFAULT;

            // 8. Új doc — target office + target org scope-jával
            let newDoc;
            try {
                newDoc = await createWorkflowDoc(
                    databases,
                    databaseId,
                    workflowsCollectionId,
                    sdk.ID.unique(),
                    {
                        editorialOfficeId,
                        organizationId: targetOrgId,
                        name: candidateName,
                        version: 1,
                        compiled: JSON.stringify(compiledClone),
                        updatedByUserId: callerId
                    },
                    newVisibility,
                    callerId,
                    buildWorkflowAclPerms(newVisibility, targetOrgId, editorialOfficeId),
                    log
                );
            } catch (createErr) {
                error(`[DuplicateWorkflow] createDocument hiba: ${createErr.message}`);
                return fail(res, 500, 'duplicate_failed');
            }

            log(`[DuplicateWorkflow] User ${callerId} duplikált: forrás=${workflowId} (${sourceVisibility}) → új=${newDoc.$id}, name="${candidateName}", target-office=${editorialOfficeId}, visibility=${newVisibility}`);

            return res.json({
                success: true,
                action: 'duplicated',
                workflowId: newDoc.$id,
                sourceWorkflowId: workflowId,
                name: candidateName,
                visibility: newVisibility,
                createdBy: callerId,
                crossTenant: sourceDoc.editorialOfficeId !== editorialOfficeId
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
        // ACTION = 'update_editorial_office'
        // ════════════════════════════════════════════════════════════════
        //
        // Szerkesztőség átnevezése. A slug változatlan — a cikk / publikáció
        // rekordok nem hivatkoznak a slugra (csak az office $id-re), így a
        // megjelenítendő név szabadon cserélhető. Uniqueness: ugyanazon org-on
        // belül nem lehet két azonos `name`-ű office (case-insensitive check-et
        // kerülünk, hogy a case-distinct név még használható legyen — a UI-ban
        // a user látja, hogy pontosan milyen név ütközik).
        if (action === 'update_editorial_office') {
            const { editorialOfficeId, name } = payload;

            if (!editorialOfficeId || !name) {
                return fail(res, 400, 'missing_fields', {
                    required: ['editorialOfficeId', 'name']
                });
            }

            const sanitizedName = sanitizeString(name, NAME_MAX_LENGTH);
            if (!sanitizedName) {
                return fail(res, 400, 'invalid_name');
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
                error(`[UpdateOffice] getDocument hiba: ${fetchErr.message}`);
                return fail(res, 500, 'office_fetch_failed');
            }

            // 2) Caller jogosultság — org owner/admin
            const callerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', officeDoc.organizationId),
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

            // 3) Uniqueness check — ugyanazon org más office-a nem foglalhatja
            //    ugyanezt a nevet. A saját office self-match-et kizárjuk, hogy
            //    idempotens rename (változatlan név → 200 OK, noop) ne dobjon.
            if (sanitizedName !== officeDoc.name) {
                const conflictQuery = await databases.listDocuments(
                    databaseId,
                    officesCollectionId,
                    [
                        sdk.Query.equal('organizationId', officeDoc.organizationId),
                        sdk.Query.equal('name', sanitizedName),
                        sdk.Query.limit(1)
                    ]
                );
                const conflict = conflictQuery.documents.find(d => d.$id !== editorialOfficeId);
                if (conflict) {
                    return fail(res, 409, 'name_taken');
                }
            }

            // 4) Frissítés
            try {
                await databases.updateDocument(
                    databaseId,
                    officesCollectionId,
                    editorialOfficeId,
                    { name: sanitizedName }
                );
            } catch (updateErr) {
                error(`[UpdateOffice] updateDocument hiba: ${updateErr.message}`);
                return fail(res, 500, 'update_failed');
            }

            log(`[UpdateOffice] User ${callerId} átnevezte office ${editorialOfficeId} → "${sanitizedName}"`);

            return res.json({
                success: true,
                action: 'updated',
                editorialOfficeId,
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

            // 5) Office team cleanup — best-effort. Az office doc már törölve,
            //    a team törlés cascade-eli a memberships-et. Ha elbukik, a team
            //    árva (nem létező office-ra mutat) — nem blokkoljuk a usert.
            try {
                await deleteTeamIfExists(teamsApi, buildOfficeTeamId(editorialOfficeId));
            } catch (teamErr) {
                error(`[DeleteOffice] office team törlés best-effort hiba: ${teamErr.message}`);
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

                    // Office team cleanup — best-effort, lásd delete_editorial_office.
                    try {
                        await deleteTeamIfExists(teamsApi, buildOfficeTeamId(office.$id));
                    } catch (teamErr) {
                        error(`[DeleteOrg] office team törlés best-effort hiba (${office.$id}): ${teamErr.message}`);
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

            // 5b) Org team cleanup — best-effort. Az org doc már törölve, a team
            //     törlés cascade-eli az org memberships-et is.
            try {
                await deleteTeamIfExists(teamsApi, buildOrgTeamId(organizationId));
            } catch (teamErr) {
                error(`[DeleteOrg] org team törlés best-effort hiba: ${teamErr.message}`);
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

        // ════════════════════════════════════════════════════════════════
        // ACTION = 'backfill_tenant_acl'
        // ════════════════════════════════════════════════════════════════
        //
        // Egy konkrét szervezet + annak minden szerkesztőségének egyszeri
        // migrációja — létrehozza a hiányzó Appwrite Team-eket, szinkronizálja
        // a tagságot (`organizationMemberships` / `editorialOfficeMemberships`
        // alapján), és rewrite-olja a document-szintű ACL-t:
        //   - organizationInvites.read  = team:org_${orgId}
        //   - groups.read               = team:office_${officeId}
        //   - groupMemberships.read     = team:office_${officeId}
        //
        // Caller: KIZÁRÓLAG a payload-beli org `owner` role-lal rendelkező tagja.
        // Scoped action: csak a megadott `organizationId` + hozzá tartozó
        // office-ok kerülnek migrálásra — NINCS project-wide scan, mert az
        // lehetővé tenné, hogy A tenant owner-e mutassa B tenant ACL-jét.
        // Több org migrálásához többször kell hívni (egyszeri művelet).
        //
        // Idempotens: ugyanabban az env-ben többször futtatható, a team- és
        // membership-műveletek ugyanazt az eredményt adják (409 → skip),
        // az ACL rewrite pedig determinisztikus.
        //
        // Payload:
        //   - organizationId: string  (kötelező — target org)
        //   - dryRun: true            (opcionális — nem ír, csak számolja mi változna)
        //
        // Fail-open per-doc: egy-egy ACL rewrite vagy team member hiba
        // NEM szakítja meg a futást, a végeredményben `errors[]` kap egy
        // sort. Így egy félbeszakadt első futás után a következő futás a
        // maradékot is pótolja.
        if (action === 'backfill_tenant_acl') {
            const dryRun = payload.dryRun === true;
            const { organizationId: targetOrgId } = payload;

            if (!targetOrgId || typeof targetOrgId !== 'string') {
                return fail(res, 400, 'missing_fields', { required: ['organizationId'] });
            }

            // Caller jogosultság: target org `owner` role.
            const ownerMembership = await databases.listDocuments(
                databaseId,
                membershipsCollectionId,
                [
                    sdk.Query.equal('organizationId', targetOrgId),
                    sdk.Query.equal('userId', callerId),
                    sdk.Query.select(['role']),
                    sdk.Query.limit(1)
                ]
            );
            if (ownerMembership.documents.length === 0) {
                return fail(res, 403, 'not_a_member');
            }
            if (ownerMembership.documents[0].role !== 'owner') {
                return fail(res, 403, 'insufficient_role', {
                    yourRole: ownerMembership.documents[0].role,
                    required: 'owner'
                });
            }

            // Target org fetch — name kell a team labelnek + létezés check.
            let targetOrg;
            try {
                targetOrg = await databases.getDocument(
                    databaseId, organizationsCollectionId, targetOrgId
                );
            } catch (err) {
                if (err?.code === 404) return fail(res, 404, 'organization_not_found');
                error(`[Backfill] org fetch hiba: ${err.message}`);
                return fail(res, 500, 'organization_fetch_failed');
            }

            const stats = {
                dryRun,
                organizationId: targetOrgId,
                organizations: { scanned: 0, teamsCreated: 0, memberships: 0 },
                offices: { scanned: 0, teamsCreated: 0, memberships: 0 },
                acl: { invites: 0, groups: 0, groupMemberships: 0 },
                errors: []
            };

            const listAll = async (collectionId, queries = []) => {
                const out = [];
                let cursor = null;
                while (true) {
                    const q = [...queries, sdk.Query.limit(CASCADE_BATCH_LIMIT)];
                    if (cursor) q.push(sdk.Query.cursorAfter(cursor));
                    const batch = await databases.listDocuments(databaseId, collectionId, q);
                    out.push(...batch.documents);
                    if (batch.documents.length < CASCADE_BATCH_LIMIT) break;
                    cursor = batch.documents[batch.documents.length - 1].$id;
                }
                return out;
            };

            // ── 1) target organization: team + memberships + invites ACL
            //
            // Az org team HARD prerequisite az invite ACL rewrite-hoz.
            // Ha a team nem jön létre, a doksik `read(team:org_...)`-ra
            // kerülnének anélkül, hogy bárki tagja volna → minden user
            // elveszítené az invite láthatóságát, de a CF success-t adna.
            // Ezért: team create fail → abort az egész action 500-zal.
            {
                const org = targetOrg;
                stats.organizations.scanned++;
                const orgTeamId = buildOrgTeamId(org.$id);

                if (!dryRun) {
                    try {
                        const result = await ensureTeam(teamsApi, orgTeamId, `Org: ${org.name}`);
                        if (result.created) stats.organizations.teamsCreated++;
                    } catch (err) {
                        error(`[Backfill] org team create hard-fail (${org.$id}): ${err.message}`);
                        return fail(res, 500, 'org_team_create_failed', {
                            orgId: org.$id,
                            message: err.message,
                            hint: 'Org team create failure megakadályozta az ACL rewrite-ot az org invite-okra.'
                        });
                    }
                }

                let orgMembers;
                try {
                    orgMembers = await listAll(
                        membershipsCollectionId,
                        [sdk.Query.equal('organizationId', org.$id)]
                    );
                } catch (err) {
                    stats.errors.push({ kind: 'org_members_list', orgId: org.$id, message: err.message });
                    orgMembers = [];
                }

                for (const m of orgMembers) {
                    if (dryRun) { stats.organizations.memberships++; continue; }
                    try {
                        const result = await ensureTeamMembership(
                            teamsApi, orgTeamId, m.userId, [m.role || 'member']
                        );
                        if (result.added) {
                            stats.organizations.memberships++;
                        } else if (result.skipped === 'team_not_found') {
                            // A team-et épp most hoztuk létre — ha itt kap 404-et,
                            // a team időközben eltűnt (párhuzamos törlés?). Hard error.
                            stats.errors.push({
                                kind: 'org_membership', orgId: org.$id, userId: m.userId,
                                message: 'team_not_found after ensureTeam succeeded'
                            });
                        }
                    } catch (err) {
                        stats.errors.push({
                            kind: 'org_membership', orgId: org.$id, userId: m.userId, message: err.message
                        });
                    }
                }

                // Invites ACL rewrite — most már safe, a team biztosan létezik.
                let invites;
                try {
                    invites = await listAll(
                        invitesCollectionId,
                        [sdk.Query.equal('organizationId', org.$id)]
                    );
                } catch (err) {
                    stats.errors.push({ kind: 'invites_list', orgId: org.$id, message: err.message });
                    invites = [];
                }
                const orgPerms = buildOrgAclPerms(org.$id);
                for (const inv of invites) {
                    if (dryRun) { stats.acl.invites++; continue; }
                    try {
                        await databases.updateDocument(
                            databaseId, invitesCollectionId, inv.$id, {}, orgPerms
                        );
                        stats.acl.invites++;
                    } catch (err) {
                        stats.errors.push({
                            kind: 'invite_acl', inviteId: inv.$id, message: err.message
                        });
                    }
                }
            }

            // ── 2) target org editorialOffices: team + memberships + groups/groupMemberships ACL
            let offices;
            try {
                offices = await listAll(
                    officesCollectionId,
                    [sdk.Query.equal('organizationId', targetOrgId)]
                );
            } catch (err) {
                error(`[Backfill] offices list hiba: ${err.message}`);
                return fail(res, 500, 'scan_failed', { step: 'offices_list' });
            }
            for (const office of offices) {
                stats.offices.scanned++;
                const officeTeamId = buildOfficeTeamId(office.$id);

                if (!dryRun) {
                    try {
                        const result = await ensureTeam(teamsApi, officeTeamId, `Office: ${office.name}`);
                        if (result.created) stats.offices.teamsCreated++;
                    } catch (err) {
                        stats.errors.push({ kind: 'office_team', officeId: office.$id, message: err.message });
                        continue;
                    }
                }

                let officeMembers;
                try {
                    officeMembers = await listAll(
                        officeMembershipsCollectionId,
                        [sdk.Query.equal('editorialOfficeId', office.$id)]
                    );
                } catch (err) {
                    stats.errors.push({ kind: 'office_members_list', officeId: office.$id, message: err.message });
                    officeMembers = [];
                }

                for (const m of officeMembers) {
                    if (dryRun) { stats.offices.memberships++; continue; }
                    try {
                        const result = await ensureTeamMembership(
                            teamsApi, officeTeamId, m.userId, [m.role || 'member']
                        );
                        if (result.added) {
                            stats.offices.memberships++;
                        } else if (result.skipped === 'team_not_found') {
                            stats.errors.push({
                                kind: 'office_membership', officeId: office.$id, userId: m.userId,
                                message: 'team_not_found after ensureTeam succeeded'
                            });
                        }
                    } catch (err) {
                        stats.errors.push({
                            kind: 'office_membership', officeId: office.$id, userId: m.userId, message: err.message
                        });
                    }
                }

                const officePerms = buildOfficeAclPerms(office.$id);

                // Groups ACL rewrite
                let groups;
                try {
                    groups = await listAll(
                        groupsCollectionId,
                        [sdk.Query.equal('editorialOfficeId', office.$id)]
                    );
                } catch (err) {
                    stats.errors.push({ kind: 'groups_list', officeId: office.$id, message: err.message });
                    groups = [];
                }
                for (const g of groups) {
                    if (dryRun) { stats.acl.groups++; continue; }
                    try {
                        await databases.updateDocument(
                            databaseId, groupsCollectionId, g.$id, {}, officePerms
                        );
                        stats.acl.groups++;
                    } catch (err) {
                        stats.errors.push({
                            kind: 'group_acl', groupId: g.$id, message: err.message
                        });
                    }
                }

                // GroupMemberships ACL rewrite
                let groupMembers;
                try {
                    groupMembers = await listAll(
                        groupMembershipsCollectionId,
                        [sdk.Query.equal('editorialOfficeId', office.$id)]
                    );
                } catch (err) {
                    stats.errors.push({ kind: 'group_memberships_list', officeId: office.$id, message: err.message });
                    groupMembers = [];
                }
                for (const gm of groupMembers) {
                    if (dryRun) { stats.acl.groupMemberships++; continue; }
                    try {
                        await databases.updateDocument(
                            databaseId, groupMembershipsCollectionId, gm.$id, {}, officePerms
                        );
                        stats.acl.groupMemberships++;
                    } catch (err) {
                        stats.errors.push({
                            kind: 'group_membership_acl', gmId: gm.$id, message: err.message
                        });
                    }
                }
            }

            log(`[Backfill] User ${callerId} — org=${targetOrgId}, dryRun=${dryRun}, offices=${stats.offices.scanned}, errors=${stats.errors.length}`);

            return res.json({ success: true, action: 'backfilled', stats });
        }

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
