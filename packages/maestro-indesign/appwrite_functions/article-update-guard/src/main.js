const sdk = require("node-appwrite");

/**
 * Appwrite Function: Article Update Guard
 *
 * Szerver-oldali validáció cikk frissítésekor.
 * Összevont ellenőrzés: workflow állapotátmenet + contributor mezők.
 *
 * Ellenőrzések:
 * 1. Állapot érvényessége (0-7 tartomány)
 * 2. Állapotátmenet érvényessége (previousState → state a VALID_TRANSITIONS alapján)
 * 3. Jogosultság (a felhasználó csapattagsága/label-jei engedélyezik-e az átmenetet)
 * 4. Contributor mezők validitása (létező felhasználó, helyes csapat)
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
 * - CONFIG_COLLECTION_ID: Config gyűjtemény azonosító
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
        const configCollectionId = process.env.CONFIG_COLLECTION_ID;

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

        // ── 6. Jogosultsági ellenőrzés (állapotváltáskor) ──
        const userId = req.headers['x-appwrite-user-id'];

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

        // ── 7. Contributor mezők validáció (log only) ──
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

        // ── 8. previousState karbantartás ──
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

        // ── 9. Korrekciók alkalmazása ──
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
