const sdk = require("node-appwrite");

/**
 * Appwrite Function: Article Update Guard
 *
 * Szerver-oldali validáció cikk frissítésekor.
 * Összevont ellenőrzés: workflow állapotátmenet + contributor mezők + office scope.
 *
 * Ellenőrzések:
 * 1. Állapot érvényessége (0-7 tartomány)
 * 2. Állapotátmenet érvényessége (previousState → state a VALID_TRANSITIONS alapján)
 * 3. Parent publication scope sync — a cikk editorialOfficeId/organizationId-ját
 *    a szülő publikáció scope mezőihez igazítja (Fázis 1 / B.8, scenario 1 védelem)
 * 4. Office scope (caller user tagja-e a cikk editorialOfficeId-jának) — Fázis 1 / B.8
 * 5. Jogosultság (a felhasználó csapattagsága/label-jei engedélyezik-e az átmenetet)
 * 6. Contributor mezők validitása (létező felhasználó, helyes csapat)
 *
 * A konstansokat a `config` collection `workflow_config` dokumentumából olvassa.
 * Ha a config nem elérhető, hardkódolt fallback értékeket használ (fail-closed).
 * A plugin felelős a config naprakészen tartásáért.
 *
 * Végtelen ciklus védelem: a korrekciós update `modifiedByClientId = 'server-guard'`
 * sentinel-t ír → a következő triggereléskor az early return elkapja.
 *
 * Trigger: databases.*.collections.articles.documents.*.update
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs (databases.*, users.*, teams.* jogosultságok)
 * - DATABASE_ID: Adatbázis azonosító
 * - ARTICLES_COLLECTION_ID: Cikkek gyűjtemény azonosító
 * - PUBLICATIONS_COLLECTION_ID: Kiadvány gyűjtemény (parent scope sync, B.8)
 * - CONFIG_COLLECTION_ID: Config gyűjtemény azonosító
 * - EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID: Szerkesztőség tagság gyűjtemény (B.8)
 */

const SERVER_GUARD_ID = 'server-guard';
const CONFIG_DOCUMENT_ID = 'workflow_config';

// Contributor mezők, amelyek user ID-t tartalmaznak
const CONTRIBUTOR_FIELDS = [
    'writerId', 'editorId', 'designerId',
    'imageEditorId', 'artDirectorId',
    'managingEditorId', 'proofwriterId'
];

// ─── Fallback konfiguráció ───────────────────────────────────────────────
// Ha a DB config nem elérhető, ezek az értékek biztosítják a validáció működését.
// Tartsd szinkronban: maestro-shared/workflowConfig.js + labelConfig.js
const FALLBACK_CONFIG = {
    statePermissions: {
        '0': ['designers', 'art_directors'],
        '1': ['art_directors'],
        '2': ['designers', 'art_directors'],
        '3': ['editors', 'managing_editors'],
        '4': ['proofwriters'],
        '5': ['editors', 'managing_editors'],
        '6': ['designers', 'art_directors']
    },
    validTransitions: {
        '0': [1], '1': [2, 0], '2': [3, 1], '3': [4, 0],
        '4': [5, 3], '5': [6, 1], '6': [7, 5], '7': []
    },
    teamArticleField: {
        'designers': 'designerId', 'art_directors': 'artDirectorId',
        'editors': 'editorId', 'managing_editors': 'managingEditorId',
        'proofwriters': 'proofwriterId', 'writers': 'writerId',
        'image_editors': 'imageEditorId'
    },
    capabilityLabels: {
        'canUseDesignerFeatures': ['designers'], 'canApproveDesigns': ['art_directors'],
        'canEditContent': ['editors'], 'canManageEditorial': ['managing_editors'],
        'canProofread': ['proofwriters'], 'canWriteArticles': ['writers'],
        'canEditImages': ['image_editors'], 'canUseEditorFeatures': ['editors']
    },
    validLabels: new Set([
        'canUseDesignerFeatures', 'canApproveDesigns', 'canEditContent',
        'canManageEditorial', 'canProofread', 'canWriteArticles',
        'canEditImages', 'canUseEditorFeatures', 'canAddArticlePlan'
    ]),
    validStates: new Set([0, 1, 2, 3, 4, 5, 6, 7])
};

// ─── Config betöltés ──────────────────────────────────────────────────────

/**
 * Betölti a workflow konfigurációt a DB config collection-ből.
 * Ha nem elérhető, a FALLBACK_CONFIG-ot adja vissza (fail-closed).
 *
 * @param {sdk.Databases} databases
 * @param {string} databaseId
 * @param {string} configCollectionId
 * @param {Function} log
 * @returns {Object|null} A parsed config objektum vagy null
 */
async function loadWorkflowConfig(databases, databaseId, configCollectionId, log) {
    try {
        const doc = await databases.getDocument(databaseId, configCollectionId, CONFIG_DOCUMENT_ID);

        return {
            statePermissions: JSON.parse(doc.statePermissions || '{}'),
            validTransitions: JSON.parse(doc.validTransitions || '{}'),
            teamArticleField: JSON.parse(doc.teamArticleField || '{}'),
            capabilityLabels: JSON.parse(doc.capabilityLabels || '{}'),
            validLabels: new Set(JSON.parse(doc.validLabels || '[]')),
            validStates: new Set(JSON.parse(doc.validStates || '[]'))
        };
    } catch (e) {
        log(`[Config] DB config nem elérhető, fallback használata: ${e.message}`);
        return FALLBACK_CONFIG;
    }
}

// ─── Label → csapat feloldás ──────────────────────────────────────────────

/**
 * A felhasználó label-jei alapján feloldja a virtuális csapat slug-okat.
 * (Szerver-oldali portja a maestro-shared/labelConfig.js resolveGrantedTeams-nek.)
 *
 * @param {string[]} userLabels - A felhasználó label-jei
 * @param {Object} capabilityLabels - A config-ból olvasott label→teams mapping
 * @returns {Set<string>}
 */
function resolveGrantedTeams(userLabels, capabilityLabels) {
    const granted = new Set();
    for (const label of userLabels) {
        const teams = capabilityLabels[label];
        if (Array.isArray(teams)) {
            for (const team of teams) {
                granted.add(team);
            }
        }
    }
    return granted;
}

/**
 * Lekéri a felhasználó tényleges csapat slug-jait (membership alapján).
 *
 * @param {sdk.Users} users
 * @param {string} userId
 * @returns {Promise<string[]>} A csapat ID-k tömbje
 */
async function getUserTeamIds(users, userId) {
    try {
        const memberships = await users.listMemberships(userId);
        return (memberships.memberships || []).map(m => m.teamId);
    } catch (e) {
        return [];
    }
}

/**
 * Lekéri a felhasználó membership rekordját az adott szerkesztőségben.
 * Fázis 1 / B.8 — cross-tenant leakage elleni védelem.
 *
 * A `editorialOfficeMemberships` collectionből olvas, amelyet kizárólag az
 * `invite-to-organization` CF ír (ACL-alapú lockdown). Egy sikeres lookup
 * bizonyíték arra, hogy a user legitim módon jutott hozzá az office-hoz.
 * A visszaadott doc `organizationId` mezőjét a caller használhatja a
 * denormalizált scope invariáns (`organizationId + editorialOfficeId` egy
 * konzisztens pár) ellenőrzésére.
 *
 * **Hibakezelés**: a helper kizárólag a membership doc-ot vagy `null`-t
 * ad vissza. Bármilyen DB lookup hiba (timeout, missing index, Appwrite
 * outage) felfelé dobódik — a caller dönti el, hogy fail-open (skip check)
 * vagy fail-closed (500 error) viselkedést választ. Ez azért kritikus,
 * mert a korábbi "catch → return false" pattern átmeneti DB hibáknál
 * destruktív delete-et váltott ki (create CF-ekben) vagy legitim state
 * change-et revertelt (update guard).
 *
 * @param {sdk.Databases} databases
 * @param {string} databaseId
 * @param {string} collectionId - editorialOfficeMemberships collection ID
 * @param {string} userId
 * @param {string} officeId
 * @returns {Promise<Object|null>} membership doc vagy null (ha nincs)
 * @throws a listDocuments() bármely hibája (caller kezeli)
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

// ─── Belépési pont ────────────────────────────────────────────────────────

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

        // ── 1. Sentinel guard — saját korrekciós update kihagyása ──
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
        const articlesCollectionId = process.env.ARTICLES_COLLECTION_ID;
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;
        const configCollectionId = process.env.CONFIG_COLLECTION_ID;
        const officeMembershipsCollectionId = process.env.EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID;

        // ── Fail-fast env var guard (B.8) ──
        // A scope check az `editorialOfficeMemberships` collection ID-jától függ,
        // a parent publication sync pedig a `publications` collection ID-jától.
        // Hiányzó env var esetén cryptic „Missing required parameter" jönne a
        // listDocuments / getDocument hívásokból — inkább itt korán 500-zal
        // elbuktatunk és explicit hibaüzenetet adunk vissza.
        const missingEnvVars = [];
        if (!officeMembershipsCollectionId) missingEnvVars.push('EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID');
        if (!publicationsCollectionId) missingEnvVars.push('PUBLICATIONS_COLLECTION_ID');
        if (missingEnvVars.length > 0) {
            error(`[Config] Hiányzó környezeti változó(k): ${missingEnvVars.join(', ')}`);
            return res.json({ success: false, reason: 'misconfigured', missing: missingEnvVars }, 500);
        }

        // ── 2. Config betöltés (fail-closed: DB → fallback → mindig validál) ──
        const config = await loadWorkflowConfig(databases, databaseId, configCollectionId, log);

        // ── 3. Friss dokumentum lekérése (stale snapshot védelem) ──
        let freshDoc;
        try {
            freshDoc = await databases.getDocument(databaseId, articlesCollectionId, payload.$id);
        } catch (e) {
            if (e.code === 404) {
                log(`Cikk már nem létezik: ${payload.$id}`);
                return res.json({ success: true, action: 'skipped', reason: 'Document deleted' });
            }
            throw e;
        }

        // Ismételt sentinel check a friss dokumentumon
        if (freshDoc.modifiedByClientId === SERVER_GUARD_ID) {
            return res.json({ success: true, action: 'skipped', reason: 'Server guard update (fresh)' });
        }

        const corrections = {};

        // ── 4. Állapot érvényesség ──
        const currentState = Number(freshDoc.state);
        if (!config.validStates.has(currentState)) {
            corrections.state = 0; // DESIGNING — biztonságos alapállapot
            log(`Érvénytelen állapot (${freshDoc.state}) → visszaállítás 0-ra`);
        }

        // ── 5. Állapotátmenet validáció ──
        const previousState = freshDoc.previousState;
        const stateChanged = previousState !== null && previousState !== undefined
            && Number(previousState) !== currentState;

        if (stateChanged && !corrections.state) {
            const prevStateNum = Number(previousState);
            const validTargets = config.validTransitions[String(prevStateNum)] || [];

            if (!validTargets.includes(currentState)) {
                corrections.state = prevStateNum;
                log(`Érvénytelen átmenet: ${prevStateNum} → ${currentState} (nem engedélyezett) → visszaállítás`);
            }
        }

        // ── 6. Parent publication scope sync (Fázis 1 / B.8) ──
        // Támadási forgatókönyv: egy user, aki csak A office-ban tag, frissíti
        // a cikket `editorialOfficeId = B`-re, de a `publicationId` változatlan
        // marad (pub-A, ami A office-hoz tartozik). A downstream office check
        // önmagában nem fogná el ezt, mert a `findOfficeMembership(userId, B)`
        // (amit a user megadott) → false → csak state revert, viszont a cikk
        // egy B office-beli rekordként marad a DB-ben. A parent sync ezt zárja
        // le: a cikk `editorialOfficeId` + `organizationId` mezőit mindig a
        // szülő publikáció scope mezőihez igazítjuk. Ha a user nem is volt
        // office B-ben, a sync után a scope ismét A, és a későbbi checkek
        // konzisztens állapoton futnak.
        //
        // Korlát: ha a támadó mindkét mezőt (editorialOfficeId + publicationId)
        // egyszerre átírja, és B-ben is tagja, a parent sync nem fogja el
        // (scenario 3). Ennek lezárása Appwrite ACL-alapú immutabilitást
        // igényel (Fázis 6/7 hatáskör).
        //
        // Legacy cikkek / hiányzó parent: skip warning log-gal.
        let parentPublication = null;
        if (freshDoc.publicationId) {
            try {
                parentPublication = await databases.getDocument(
                    databaseId,
                    publicationsCollectionId,
                    freshDoc.publicationId
                );
            } catch (e) {
                if (e.code === 404) {
                    log(`[Scope] Parent publication ${freshDoc.publicationId} nem található — sync kihagyva (${freshDoc.$id})`);
                } else {
                    throw e;
                }
            }
        }

        if (parentPublication && parentPublication.editorialOfficeId) {
            // Az officeId és az organizationId mezőket egymástól függetlenül
            // ellenőrizzük: bármelyik drift-je (akár önmagában is) a parent
            // scope-hoz igazítást vonja maga után. A két mező denormalizált
            // párt alkot, ezért bármelyik önálló elcsúszása invariáns sérelem.
            if (parentPublication.editorialOfficeId !== freshDoc.editorialOfficeId) {
                corrections.editorialOfficeId = parentPublication.editorialOfficeId;
                log(`[Scope] Cikk editorialOfficeId drift (article=${freshDoc.editorialOfficeId}, pub=${parentPublication.editorialOfficeId}) → sync a parent-hez`);
                // A freshDoc-ot is frissítjük, hogy a downstream office check
                // a helyreállított (parent-szinkronizált) értéken fusson.
                freshDoc.editorialOfficeId = parentPublication.editorialOfficeId;
            }
            if (parentPublication.organizationId
                && parentPublication.organizationId !== freshDoc.organizationId) {
                corrections.organizationId = parentPublication.organizationId;
                log(`[Scope] Cikk organizationId drift (article=${freshDoc.organizationId}, pub=${parentPublication.organizationId}) → sync a parent-hez`);
                freshDoc.organizationId = parentPublication.organizationId;
            }
        }

        // ── 7. Office scope ellenőrzés (Fázis 1 / B.8) ──
        // A caller user kizárólag akkor módosíthat egy cikket, ha tagja annak
        // az editorialOffice-nak, amelybe a cikk tartozik. Cross-tenant update
        // esetén a state-et visszaállítjuk az előző értékre (ha volt state change).
        //
        // B.8 scope korlát: ez a guard CSAK a `state` mezőt revertelja. Egyéb
        // mezők (filePath, name, contributors, publicationId, stb.) cross-tenant
        // átírása detektálásra kerül (log), de a régi érték nem állítódik vissza
        // pre-update snapshot hiányában. A teljes field-level revert Fázis 6/7
        // hatáskör — akkor ACL-alapú védelem vagy pre-update snapshot alapján
        // fog működni. A jelenlegi állapot szándékos, a B.8 csak scope-awareness
        // baseline-t vezet be.
        //
        // Missing `x-appwrite-user-id` header: szerver-oldali írás (API kulcs
        // használat, cron CF mint `cleanup-orphaned-locks` vagy `migrate-
        // legacy-paths`) nem hordoz user kontextust. Ezeket megbízhatónak
        // tekintjük (shared `MaestroFunctionsKey`), ezért a scope check
        // kihagyódik. Ha új, nem-trusted belépési pont érkezik, ez az ág
        // fail-closed irányba vizsgálandó.
        //
        // Legacy cikkek (null editorialOfficeId) skippelődnek warning log-gal —
        // a B.9 wipe után ez az ág soha nem fut.
        const userId = req.headers['x-appwrite-user-id'];

        if (userId && freshDoc.editorialOfficeId) {
            // Fail-open scope check: átmeneti membership lookup hiba esetén
            // a scope check kihagyódik (log + skip), de a state + permission
            // validáció továbbfut. Ez megakadályozza, hogy egy Appwrite
            // outage legitim workflow átmeneteket blokkoljon.
            try {
                const membership = await findOfficeMembership(
                    databases,
                    databaseId,
                    officeMembershipsCollectionId,
                    userId,
                    freshDoc.editorialOfficeId
                );
                if (!membership) {
                    if (stateChanged && !corrections.state) {
                        corrections.state = Number(previousState);
                        log(`[Scope] User ${userId} nem tagja az office-nak ${freshDoc.editorialOfficeId} → state revert`);
                    } else {
                        log(`[Scope] User ${userId} nem tagja az office-nak ${freshDoc.editorialOfficeId} — non-state cross-tenant update detektálva (nem revertelhető, Fázis 6/7)`);
                    }
                }
            } catch (e) {
                error(`[Scope] Membership lookup hiba (${userId}, ${freshDoc.editorialOfficeId}): ${e.message} — scope check kihagyva, state/permission validáció továbbfut`);
            }
        } else if (userId && !freshDoc.editorialOfficeId) {
            log(`[Scope] Legacy cikk ${freshDoc.$id} — nincs editorialOfficeId, office check kihagyva`);
        }

        // ── 8. Jogosultsági ellenőrzés (állapotváltáskor) ──

        if (stateChanged && !corrections.state && userId) {
            const prevStateNum = Number(previousState);
            const requiredTeams = config.statePermissions[String(prevStateNum)];

            if (requiredTeams && requiredTeams.length > 0) {
                // Felhasználó csapattagságai
                const userTeamIds = await getUserTeamIds(usersApi, userId);

                // Felhasználó label-jei → virtuális csapatok
                let grantedTeams = new Set();
                try {
                    const userDoc = await usersApi.get(userId);
                    grantedTeams = resolveGrantedTeams(userDoc.labels || [], config.capabilityLabels);
                } catch (e) {
                    log(`Felhasználó lekérése sikertelen (${userId}): ${e.message}`);
                }

                // Ellenőrzés: a felhasználó benne van-e valamelyik szükséges csapatban
                const hasPermission = requiredTeams.some(slug =>
                    userTeamIds.includes(slug) || grantedTeams.has(slug)
                );

                if (!hasPermission) {
                    corrections.state = prevStateNum;
                    log(`Jogosultsági hiba: felhasználó ${userId} nem mozgathatja a cikket állapotból ${prevStateNum} (szükséges: [${requiredTeams.join(', ')}])`);
                }
            }
        }

        // ── 9. Contributor mezők validáció (log only) ──
        for (const field of CONTRIBUTOR_FIELDS) {
            const value = freshDoc[field];
            if (!value) continue;

            try {
                await usersApi.get(value);
            } catch (e) {
                if (e.code === 404) {
                    log(`[Contributor] ${field}=${value} — felhasználó nem létezik (nem javítva, csak logolva)`);
                }
            }
        }

        // ── 10. previousState karbantartás ──
        // A szerver mindig naprakészen tartja a previousState-et, így a közvetlen
        // API hívások (previousState nélkül) a következő módosításkor elkaphatók.
        if (freshDoc.previousState === null || freshDoc.previousState === undefined) {
            const effectiveState = corrections.state !== undefined ? corrections.state : currentState;
            corrections.previousState = effectiveState;
            log(`previousState inicializálva: ${effectiveState} (korábban nem volt beállítva)`);
        } else if (corrections.state !== undefined) {
            // State korrekció (revert) → previousState is frissül
            corrections.previousState = corrections.state;
        }

        // ── 11. Korrekciók alkalmazása ──
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

        return res.json({ success: true, action: 'none' });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
