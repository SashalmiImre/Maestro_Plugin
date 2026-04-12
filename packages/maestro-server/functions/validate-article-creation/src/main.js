const sdk = require("node-appwrite");

/**
 * Appwrite Function: Validate Article Creation
 *
 * Szerver-oldali validáció új cikk létrehozásakor.
 *
 * Ellenőrzések:
 * 1. publicationId — létezik-e a Publications gyűjteményben
 * 2. Scope mezők — organizationId + editorialOfficeId jelen van-e (B.8)
 * 3. Parent scope consistency — a cikk officeId-je megegyezik-e a publication-éval (B.8)
 * 4. Caller membership — a user tagja-e a cikk editorialOfficeId-jának (B.8)
 * 5. state — érvényes workflow állapot-e (0-7)
 * 6. Contributor mezők — létező felhasználókra mutatnak-e
 * 7. filePath — nem üres, nem tartalmaz tiltott karaktereket
 *
 * Érvénytelen publicationId / scope mismatch / hiányzó scope / cross-tenant
 * caller → a cikk törlődik (nincs legitim szülő vagy jogosultság).
 * Egyéb hibák → mező nullázás / alapértékre állítás.
 *
 * Trigger: databases.*.collections.articles.documents.*.create
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs (databases.*, users.* jogosultságok)
 * - DATABASE_ID
 * - ARTICLES_COLLECTION_ID
 * - PUBLICATIONS_COLLECTION_ID
 * - WORKFLOWS_COLLECTION_ID
 * - EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID (B.8)
 */

const SERVER_GUARD_ID = 'server-guard';

// Tiltott karakterek a fájlnévben (Windows + InDesign kompatibilitás)
const FORBIDDEN_CHARS = /[\\/:*?"<>|]/;

/**
 * Betölti a compiled workflow-ból az érvényes állapot ID-kat.
 */
async function loadValidStates(databases, databaseId, workflowsCollectionId, editorialOfficeId, log) {
    if (!editorialOfficeId) return null;
    try {
        const result = await databases.listDocuments(databaseId, workflowsCollectionId, [
            sdk.Query.equal('editorialOfficeId', editorialOfficeId),
            sdk.Query.limit(1)
        ]);
        if (result.documents.length === 0) return null;
        const doc = result.documents[0];
        const compiled = typeof doc.compiled === 'string' ? JSON.parse(doc.compiled) : doc.compiled;
        const states = Array.isArray(compiled.states) ? compiled.states : [];
        return new Set(states.map(s => s.id));
    } catch (e) {
        log(`[Workflow] Workflow betöltés hiba: ${e.message}`);
        return null;
    }
}

/**
 * Lekéri a felhasználó membership rekordját az adott szerkesztőségben.
 * Fázis 1 / B.8 — cross-tenant leakage elleni védelem.
 *
 * Lásd article-update-guard/src/main.js-ben a részletes leírást.
 * **Hibakezelés**: a lookup hibák felfelé dobódnak; a caller dönti el,
 * hogyan reagál (ez a CF fail-fast 500-zal, hogy ne töröljön frissen
 * létrehozott cikket átmeneti DB hiba miatt).
 *
 * @param {sdk.Databases} databases
 * @param {string} databaseId
 * @param {string} collectionId
 * @param {string} userId
 * @param {string} officeId
 * @returns {Promise<Object|null>} membership doc vagy null
 * @throws a listDocuments() bármely hibája
 */
async function findOfficeMembership(databases, databaseId, collectionId, userId, officeId) {
    const result = await databases.listDocuments(databaseId, collectionId, [
        sdk.Query.equal('userId', userId),
        sdk.Query.equal('editorialOfficeId', officeId),
        sdk.Query.limit(1)
    ]);
    if ((result.total || 0) === 0) return null;
    return result.documents[0] || null;
}

module.exports = async function ({ req, res, log, error }) {
    try {
        // Event payload feldolgozása
        let payload = {};
        if (req.body) {
            try {
                payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            } catch (e) {
                error(`Payload parse hiba: ${e.message}`);
                return res.json({ success: false, reason: 'Invalid payload' });
            }
        }

        if (!payload.$id) {
            return res.json({ success: true, action: 'skipped', reason: 'No document ID' });
        }

        // ── SDK inicializálás ──
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const databases = new sdk.Databases(client);
        const usersApi = new sdk.Users(client);

        const databaseId = process.env.DATABASE_ID;
        const articlesCollectionId = process.env.ARTICLES_COLLECTION_ID;
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;
        const workflowsCollectionId = process.env.WORKFLOWS_COLLECTION_ID;
        const officeMembershipsCollectionId = process.env.EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID;

        // ── Fail-fast env var guard (B.8) ──
        if (!officeMembershipsCollectionId) {
            error('[Config] Hiányzó környezeti változó: EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID');
            return res.json({ success: false, reason: 'misconfigured', missing: ['EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID'] }, 500);
        }

        // ── 1. publicationId validáció ──
        if (!payload.publicationId) {
            log(`Cikk publicationId nélkül: ${payload.$id} → törlés`);
            await databases.deleteDocument(databaseId, articlesCollectionId, payload.$id);
            return res.json({ success: true, action: 'deleted', reason: 'Missing publicationId' });
        }

        // A parent publication-t elmentjük változóba, hogy a scope consistency
        // check ne igényeljen újabb getDocument hívást.
        let parentPublication;
        try {
            parentPublication = await databases.getDocument(databaseId, publicationsCollectionId, payload.publicationId);
        } catch (e) {
            if (e.code === 404) {
                log(`Érvénytelen publicationId: ${payload.publicationId} → cikk törlése (${payload.$id})`);
                await databases.deleteDocument(databaseId, articlesCollectionId, payload.$id);
                return res.json({ success: true, action: 'deleted', reason: 'Invalid publicationId' });
            }
            throw e;
        }

        // ── 2. Scope mezők jelenlét (B.8) ──
        if (!payload.organizationId || !payload.editorialOfficeId) {
            log(`[Scope] Hiányzó scope mezők a cikken ${payload.$id} → törlés`);
            await databases.deleteDocument(databaseId, articlesCollectionId, payload.$id);
            return res.json({ success: true, action: 'deleted', reason: 'Missing scope fields' });
        }

        // ── 3. Parent publication scope consistency (B.8) ──
        // Legacy publication (null editorialOfficeId) esetén skip warning-gal —
        // a B.9 wipe után ez nem fut.
        // Az `organizationId` és `editorialOfficeId` egymástól függetlenül is
        // ellenőrizve, hogy a denormalizált scope pár invariáns ne sérüljön
        // akkor sem, ha a támadó csak az egyik mezőt próbálja elcsúsztatni.
        if (parentPublication.editorialOfficeId) {
            if (parentPublication.editorialOfficeId !== payload.editorialOfficeId) {
                log(`[Scope] Cikk editorialOfficeId (${payload.editorialOfficeId}) ≠ publication editorialOfficeId (${parentPublication.editorialOfficeId}) → törlés`);
                await databases.deleteDocument(databaseId, articlesCollectionId, payload.$id);
                return res.json({ success: true, action: 'deleted', reason: 'Parent office mismatch' });
            }
            if (parentPublication.organizationId
                && parentPublication.organizationId !== payload.organizationId) {
                log(`[Scope] Cikk organizationId (${payload.organizationId}) ≠ publication organizationId (${parentPublication.organizationId}) → törlés`);
                await databases.deleteDocument(databaseId, articlesCollectionId, payload.$id);
                return res.json({ success: true, action: 'deleted', reason: 'Parent organization mismatch' });
            }
        } else {
            log(`[Scope] Legacy publication ${parentPublication.$id} — nincs editorialOfficeId, parent check kihagyva`);
        }

        // ── 4. Caller office membership check (B.8) ──
        // A cikk létrehozója csak akkor írhat az office-ba, ha tagja annak.
        //
        // Missing `x-appwrite-user-id` header: szerver-oldali írás (API kulcs,
        // CF-by-CF call) nem hordoz user kontextust. Jelenleg egyetlen trusted
        // CF sem hoz létre cikket (a Plugin a kizárólagos create útvonal), így
        // ez az ág a gyakorlatban nem fut. Ha később trusted CF is ír ide,
        // ennek elfogadhatóságát újra kell értékelni (fail-closed vs trusted
        // service principal allowlist).
        //
        // **Lookup hiba kezelése**: átmeneti DB hiba (timeout, missing index,
        // Appwrite outage) esetén 500-as hibával visszatérünk, NEM töröljük
        // a cikket. Ha return false-ot adnánk a fenti try/catch mintából,
        // egy transient issue destruktív módon kitörölné a frissen létrehozott
        // legitim cikket. A 500 miatt a trigger retry-olja a CF-et, és
        // amikor a DB visszajön, a check végre tud futni.
        const callerId = req.headers['x-appwrite-user-id'];
        if (callerId) {
            let membership;
            try {
                membership = await findOfficeMembership(
                    databases,
                    databaseId,
                    officeMembershipsCollectionId,
                    callerId,
                    payload.editorialOfficeId
                );
            } catch (e) {
                error(`[Scope] Membership lookup hiba (${callerId}, ${payload.editorialOfficeId}): ${e.message} — fail-fast 500, cikk NEM törölhető`);
                return res.json({ success: false, reason: 'membership_lookup_failed', error: e.message }, 500);
            }
            if (!membership) {
                log(`[Scope] User ${callerId} nem tagja az office-nak ${payload.editorialOfficeId} → cikk törlése (${payload.$id})`);
                await databases.deleteDocument(databaseId, articlesCollectionId, payload.$id);
                return res.json({ success: true, action: 'deleted', reason: 'Caller not member of target office' });
            }
        }

        const corrections = {};

        // ── 5. Állapot validáció ──
        const validStates = await loadValidStates(databases, databaseId, workflowsCollectionId, payload.editorialOfficeId, log);
        if (validStates && payload.state && !validStates.has(payload.state)) {
            // Érvénytelen állapot → első állapot
            const initialState = validStates.values().next().value || "designing";
            corrections.state = initialState;
            log(`Érvénytelen állapot (${payload.state}) → ${initialState}`);
        }

        // ── 6. Contributors JSON validáció ──
        if (payload.contributors) {
            try {
                const parsed = JSON.parse(payload.contributors);
                let corrected = false;
                for (const [slug, userId] of Object.entries(parsed)) {
                    if (!userId) continue;
                    try {
                        await usersApi.get(userId);
                    } catch (e) {
                        if (e.code === 404) {
                            parsed[slug] = null;
                            corrected = true;
                            log(`[Contributor] contributors.${slug}=${userId} — nem létező felhasználó → nullázva`);
                        }
                    }
                }
                if (corrected) {
                    corrections.contributors = JSON.stringify(parsed);
                }
            } catch (e) {
                corrections.contributors = '{}';
                log(`[Contributor] contributors parse hiba: ${e.message} → üres objektum`);
            }
        }

        // ── 7. filePath formátum validáció ──
        if (payload.filePath) {
            // A fájlnév részét ellenőrizzük (az utolsó path szegmens)
            const fileName = payload.filePath.split('/').pop();
            if (fileName && FORBIDDEN_CHARS.test(fileName)) {
                log(`[filePath] Tiltott karakter a fájlnévben: "${fileName}"`);
                // Nem javítjuk, mert a fájlrendszeren már létezhet — csak logoljuk
            }
        }

        // ── 8. Korrekciók alkalmazása ──
        if (Object.keys(corrections).length > 0) {
            corrections.modifiedByClientId = SERVER_GUARD_ID;

            await databases.updateDocument(
                databaseId,
                articlesCollectionId,
                payload.$id,
                corrections
            );

            log(`Korrekciók alkalmazva: ${JSON.stringify(corrections)}`);

            return res.json({
                success: true,
                action: 'corrected',
                corrections
            });
        }

        return res.json({ success: true, action: 'validated' });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
