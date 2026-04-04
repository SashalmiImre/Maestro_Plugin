const sdk = require("node-appwrite");

/**
 * Appwrite Function: Validate Labels
 *
 * Felhasználó frissítésekor ellenőrzi a label-eket a VALID_LABELS halmaz alapján.
 * Érvénytelen label-eket automatikusan eltávolítja és logolja.
 *
 * Végtelen ciklus védelem: a korrekciós updateLabels() újra triggereli ezt a függvényt,
 * de a második futáskor minden label már érvényes → early return.
 *
 * Stale snapshot védelem: az event payload-ban észlelt érvénytelen label esetén
 * a függvény friss users.get() hívással olvassa az aktuális állapotot, mielőtt ír.
 * Így a közben történt párhuzamos label-módosítások nem vesznek el.
 *
 * Trigger: users.*.update
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs 'users.read' és 'users.write' jogosultsággal.
 */

// ─── Érvényes capability label-ek ─────────────────────────────────────────
// A config collection `workflow_config` dokumentumából olvassuk.
// Fallback: hardcoded lista, ha a config nem elérhető.
const CONFIG_DOCUMENT_ID = 'workflow_config';

const FALLBACK_VALID_LABELS = new Set([
    'canUseDesignerFeatures',
    'canApproveDesigns',
    'canEditContent',
    'canManageEditorial',
    'canProofread',
    'canWriteArticles',
    'canEditImages',
    'canUseEditorFeatures',
    'canAddArticlePlan',
]);

/**
 * Betölti az érvényes label-ek listáját a config collection-ből.
 * Ha nem elérhető, a hardcoded fallback listát adja vissza.
 */
async function loadValidLabels(databases, databaseId, configCollectionId, log) {
    if (!configCollectionId) return FALLBACK_VALID_LABELS;
    try {
        const doc = await databases.getDocument(databaseId, configCollectionId, CONFIG_DOCUMENT_ID);
        const labels = JSON.parse(doc.validLabels || '[]');
        if (labels.length > 0) return new Set(labels);
    } catch (e) {
        log(`[Config] Fallback valid labels használata: ${e.message}`);
    }
    return FALLBACK_VALID_LABELS;
}

module.exports = async function ({ req, res, log, error }) {
    try {
        // Event payload feldolgozása
        let eventUser = {};
        if (req.body) {
            try {
                eventUser = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            } catch (e) {
                error(`Payload parse hiba: ${e.message}`);
                return res.json({ success: false, reason: 'Invalid payload' });
            }
        }

        // Ha nincs user ID vagy labels tömb, kihagyjuk (pl. session/prefs frissítés)
        if (!eventUser.$id || !Array.isArray(eventUser.labels)) {
            return res.json({ success: true, action: 'skipped', reason: 'No labels in payload' });
        }

        // ── SDK inicializálás ──
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const users = new sdk.Users(client);
        const databases = new sdk.Databases(client);

        // Érvényes label-ek betöltése a config collection-ből (fallback: hardcoded lista)
        const VALID_LABELS = await loadValidLabels(
            databases,
            process.env.DATABASE_ID,
            process.env.CONFIG_COLLECTION_ID,
            log
        );

        // Gyors ellenőrzés az event payload alapján — ha minden érvényes, nincs teendő
        const quickCheck = eventUser.labels.some(l => !VALID_LABELS.has(l));
        if (!quickCheck) {
            return res.json({ success: true, action: 'none' });
        }

        // ── Érvénytelen label észlelve → friss állapot lekérése (stale snapshot védelem) ──
        const freshUser = await users.get(eventUser.$id);

        const validLabels = freshUser.labels.filter(l => VALID_LABELS.has(l));
        const invalidLabels = freshUser.labels.filter(l => !VALID_LABELS.has(l));

        // Ha a friss állapotban már minden rendben (közben javították), kész
        if (invalidLabels.length === 0) {
            log(`User ${freshUser.$id} (${freshUser.name}): event payload-ban volt érvénytelen label, de a friss állapot már rendben`);
            return res.json({ success: true, action: 'none', note: 'Already corrected in fresh state' });
        }

        // Érvénytelen label-ek eltávolítása friss adatból
        log(`User ${freshUser.$id} (${freshUser.name}): érvénytelen label-ek: [${invalidLabels.join(', ')}] → eltávolítás`);

        await users.updateLabels(freshUser.$id, validLabels);

        log(`Korrigálva: megtartva [${validLabels.join(', ')}], törölve [${invalidLabels.join(', ')}]`);

        return res.json({
            success: true,
            action: 'corrected',
            kept: validLabels,
            removed: invalidLabels
        });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, error: err.message }, 500);
    }
};
