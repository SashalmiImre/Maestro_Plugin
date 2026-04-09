const sdk = require("node-appwrite");

/**
 * Appwrite Function: Validate Publication Update
 *
 * Szerver-oldali validáció kiadvány létrehozásakor és módosításakor.
 *
 * Ellenőrzések:
 * 1. Scope mezők (organizationId + editorialOfficeId) jelen vannak-e — create only (B.8)
 * 2. Caller membership — a user tagja-e a kiadvány editorialOfficeId-jának (B.8)
 * 3. Default contributor ID-k — létező felhasználókra mutatnak-e
 * 4. rootPath formátum — kanonikus-e (nem /Volumes-szal kezdődik, nincs drive letter)
 *
 * Érvénytelen contributor → nullázás.
 * rootPath probléma → csak logolás (nem javítjuk, lehet migráció folyamatban).
 * Scope hiány create esetén → törlés.
 * Cross-tenant caller: create → törlés, update → csak logolás (B.8 korlát, Fázis 6
 * fedi a teljes update field-level védelmét).
 *
 * Trigger: databases.*.collections.publications.documents.*.create
 *          databases.*.collections.publications.documents.*.update
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs (databases.*, users.* jogosultságok)
 * - DATABASE_ID
 * - PUBLICATIONS_COLLECTION_ID
 * - EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID (B.8)
 */

const SERVER_GUARD_ID = 'server-guard';


// Legacy útvonal felismerés
const MOUNT_PREFIXES = ['/Volumes', 'C:/Volumes'];

/**
 * Lekéri a felhasználó membership rekordját az adott szerkesztőségben.
 * Fázis 1 / B.8 — cross-tenant leakage elleni védelem.
 *
 * Lásd article-update-guard/src/main.js-ben a részletes leírást.
 * **Hibakezelés**: a lookup hibák felfelé dobódnak; a caller dönti el,
 * hogyan reagál (create pathon 500-ast adunk vissza, hogy ne töröljük
 * a frissen létrehozott publikációt átmeneti DB hiba miatt).
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

/**
 * Ellenőrzi, hogy a rootPath régi (legacy) formátumú-e.
 * @param {string} rootPath
 * @returns {boolean}
 */
function isLegacyRootPath(rootPath) {
    if (!rootPath) return false;
    const normalized = rootPath.replace(/\\/g, '/');
    for (const pfx of MOUNT_PREFIXES) {
        if (normalized.startsWith(pfx + '/') || normalized === pfx) return true;
    }
    return /^[a-zA-Z]:\//.test(normalized);
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

        // Sentinel guard — saját korrekciós update kihagyása
        if (payload.modifiedByClientId === SERVER_GUARD_ID) {
            return res.json({ success: true, action: 'skipped', reason: 'Server guard update' });
        }

        // ── SDK inicializálás ──
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const databases = new sdk.Databases(client);
        const usersApi = new sdk.Users(client);

        const databaseId = process.env.DATABASE_ID;
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;
        const officeMembershipsCollectionId = process.env.EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID;

        // ── Fail-fast env var guard (B.8) ──
        if (!officeMembershipsCollectionId) {
            error('[Config] Hiányzó környezeti változó: EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID');
            return res.json({ success: false, reason: 'misconfigured', missing: ['EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID'] }, 500);
        }

        // Event típus detektálás — create vagy update?
        // A header-ből olvassuk, mert a payload maga nem tartalmazza az event típust.
        const eventHeader = req.headers['x-appwrite-event'] || '';
        const isCreate = eventHeader.includes('.create');

        // Friss dokumentum lekérése
        let freshDoc;
        try {
            freshDoc = await databases.getDocument(databaseId, publicationsCollectionId, payload.$id);
        } catch (e) {
            if (e.code === 404) {
                return res.json({ success: true, action: 'skipped', reason: 'Document deleted' });
            }
            throw e;
        }

        if (freshDoc.modifiedByClientId === SERVER_GUARD_ID) {
            return res.json({ success: true, action: 'skipped', reason: 'Server guard update (fresh)' });
        }

        // ── 1. Scope mezők jelenlét — csak CREATE eventnél (B.8) ──
        // Update-nél a legacy null scope skip-pel mehet tovább, a B.9 wipe után
        // ez már nem fut. Create-nél szigorúbb: hiányzó scope → törlés.
        if (isCreate && (!freshDoc.organizationId || !freshDoc.editorialOfficeId)) {
            log(`[Scope] Hiányzó scope mezők publikáción ${freshDoc.$id} → törlés`);
            await databases.deleteDocument(databaseId, publicationsCollectionId, payload.$id);
            return res.json({ success: true, action: 'deleted', reason: 'Missing scope fields' });
        }

        // ── 2. Caller office membership check (B.8) ──
        //
        // Missing `x-appwrite-user-id` header: szerver-oldali írás (API kulcs,
        // vagy cron CF mint `migrate-legacy-paths`) nem hordoz user kontextust.
        // Trusted-nek tekintjük (shared `MaestroFunctionsKey`), ezért a scope
        // check kihagyódik. Ha új, nem-trusted belépési pont érkezik, ez
        // fail-closed irányba vizsgálandó.
        //
        // ⚠ Update path ismert hézag (Fázis 6/7 hatáskör):
        // Ez a check a POST-update `freshDoc.editorialOfficeId` alapján dolgozik.
        // Ha egy multi-office user (tagja A-nak ÉS B-nek) átírja egy A-beli
        // publikáció `editorialOfficeId`-ját B-re, a `findOfficeMembership(userId, B)`
        // sikerrel fog visszatérni, és a guard nem detektál violation-t — a
        // publikáció cross-tenant átkerült. A cikkek guard-ja ezt parent sync-kel
        // elkerüli (a szülő publikáció scope-ját használja referenciaként), de a
        // publikációnak nincs szülője, így itt pre-update snapshot vagy ACL-alapú
        // immutabilitás kellene a scope mezőkre. Ezt Fázis 6/7 hozza be (Appwrite
        // document-level permission → az `editorialOfficeId` + `organizationId`
        // mezők read-only-vá válnak a kliens API-n keresztül, csak trusted CF
        // írhatja őket, pl. publikáció létrehozáskor).
        //
        // Hasonló korlát: egy tag-user, aki a saját office-ából akar más rontást
        // okozni (rootPath legacy formátum, törölt contributor stb.), a
        // contributor + rootPath validáció továbbfut, és a javítható problémák
        // javulnak — de a non-scope mezők (name, issueDate, stb.) revertelése
        // szintén Fázis 6/7 scope.
        const callerId = req.headers['x-appwrite-user-id'];
        if (callerId && freshDoc.editorialOfficeId) {
            // **Lookup hiba kezelése**: create pathon fail-fast 500-ast adunk
            // vissza (a frissen létrehozott publikációt NEM töröljük átmeneti
            // DB hiba miatt — a trigger retry-olja). Update pathon a scope
            // check kihagyódik (log), a contributor + rootPath validáció
            // továbbfut.
            let membership = null;
            let lookupFailed = false;
            try {
                membership = await findOfficeMembership(
                    databases,
                    databaseId,
                    officeMembershipsCollectionId,
                    callerId,
                    freshDoc.editorialOfficeId
                );
            } catch (e) {
                if (isCreate) {
                    error(`[Scope] Membership lookup hiba (${callerId}, ${freshDoc.editorialOfficeId}): ${e.message} — fail-fast 500, publikáció NEM törölhető`);
                    return res.json({ success: false, reason: 'membership_lookup_failed', error: e.message }, 500);
                }
                error(`[Scope] Membership lookup hiba (${callerId}, ${freshDoc.editorialOfficeId}): ${e.message} — update path, scope check kihagyva`);
                lookupFailed = true;
            }
            if (!lookupFailed && !membership) {
                if (isCreate) {
                    log(`[Scope] Create by non-member ${callerId} → publikáció törlése (${freshDoc.$id})`);
                    await databases.deleteDocument(databaseId, publicationsCollectionId, payload.$id);
                    return res.json({ success: true, action: 'deleted', reason: 'Caller not member of target office' });
                }
                // Update path: a mostani CF nem revertel főbb mezőket (rootPath,
                // default contributors). Csak logoljuk — a teljes field-level
                // revert Fázis 6 hatáskör. A contributor + rootPath validáció
                // továbbfut: ha nem-tag user rossz adatokat írt, azok javíthatók.
                log(`[Scope] Update by non-member ${callerId} (${freshDoc.$id}) — csak logolva, Fázis 6 fedi`);
            } else if (membership && isCreate) {
                // Denormalizált scope invariáns: a publikáció `organizationId`
                // mezőjének meg kell egyeznie a membership `organizationId`-jával
                // (ami az office → org kapcsolat egyedüli trusted forrása).
                // Enélkül a caller A-ban tag lenne, de átírhatná az org-ot X-re,
                // ami dangling cross-org rekordot hoz létre.
                if (membership.organizationId
                    && freshDoc.organizationId !== membership.organizationId) {
                    log(`[Scope] Create: publikáció organizationId (${freshDoc.organizationId}) ≠ membership organizationId (${membership.organizationId}) → törlés`);
                    await databases.deleteDocument(databaseId, publicationsCollectionId, payload.$id);
                    return res.json({ success: true, action: 'deleted', reason: 'Organization mismatch with office membership' });
                }
            }
        } else if (callerId && !freshDoc.editorialOfficeId) {
            log(`[Scope] Legacy publikáció ${freshDoc.$id} — nincs editorialOfficeId, office check kihagyva`);
        }

        const corrections = {};

        // ── 3. Default contributors JSON validáció ──
        if (freshDoc.defaultContributors) {
            try {
                const parsed = JSON.parse(freshDoc.defaultContributors);
                let corrected = false;
                for (const [slug, userId] of Object.entries(parsed)) {
                    if (!userId) continue;
                    try {
                        await usersApi.get(userId);
                    } catch (e) {
                        if (e.code === 404) {
                            parsed[slug] = null;
                            corrected = true;
                            log(`[Contributor] defaultContributors.${slug}=${userId} — nem létező felhasználó → nullázva`);
                        }
                    }
                }
                if (corrected) {
                    corrections.defaultContributors = JSON.stringify(parsed);
                }
            } catch (e) {
                corrections.defaultContributors = '{}';
                log(`[Contributor] defaultContributors parse hiba: ${e.message} → üres objektum`);
            }
        }

        // ── 4. rootPath formátum ellenőrzés ──
        if (freshDoc.rootPath && isLegacyRootPath(freshDoc.rootPath)) {
            log(`[rootPath] Legacy formátum észlelve: "${freshDoc.rootPath}" — migráció szükséges`);
            // Nem javítjuk automatikusan — a kliens lazy migrációja vagy a
            // migrate-legacy-paths function kezeli
        }

        // ── 5. Korrekciók alkalmazása ──
        if (Object.keys(corrections).length > 0) {
            corrections.modifiedByClientId = SERVER_GUARD_ID;

            await databases.updateDocument(
                databaseId,
                publicationsCollectionId,
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
