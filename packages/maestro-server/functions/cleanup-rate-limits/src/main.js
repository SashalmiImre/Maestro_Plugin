const sdk = require("node-appwrite");

/**
 * Appwrite Function: Cleanup Rate Limits (S.2.5, 2026-05-11)
 *
 * S.2 audit-blokk záró-CF. Lejárt rate-limit doc-ok periodikus törlése a
 * két collection-ből:
 *   - ipRateLimitCounters: `$updatedAt < now - COUNTER_CUTOFF_HOURS` (default 48h)
 *     → biztosan lejárt window (leghosszabb runtime-window 24h + 24h grace)
 *   - ipRateLimitBlocks:   `$updatedAt < now - BLOCK_CUTOFF_HOURS` (default 6h)
 *     → biztosan lejárt blokk (max blockMs jelenleg 1h × 6 grace)
 *
 * Index-stratégia (Codex pre-review Opció Y + stop-time BLOCKER fix):
 * a counter+block collection `[ip, endpoint, ...]` composite indexei NEM
 * hatékonyak `lessThan(time, ...)` lookupra `ip`/`endpoint` prefix nélkül
 * (leftmost-prefix szabály). Ezért a `$updatedAt` system-mező system-indexén
 * szűrünk. A `$updatedAt`-választás indoka collection-enként eltér:
 *   - counter: `appendCounter` minden hit-en ÚJ doc-ot ír `sdk.ID.unique()`-vel
 *     (append-only model, a `readCounter` lapozottan SUM-olja a window-on
 *     belüli doc-ok `count`-ját). Így `$createdAt ≈ $updatedAt` per-doc,
 *     bármelyik szűrés ekvivalens. A `$updatedAt` választása jövőbiztos —
 *     ha valaha update-elnénk a model-t (counter-coalescing), a cleanup
 *     továbbra is helyes marad.
 *   - block: `setBlock` `document_already_exists` ágon `updateDocument`-tel
 *     HOSSZABBÍTJA a meglévő determinisztikus-ID block-ot
 *     (`{ blockedAt, blockedUntil }` újraírás). Egy 1 perce hosszabbított
 *     aktív block `$createdAt`-je akár hetes lehet, de `$updatedAt`-je
 *     friss → **kötelezően** `$updatedAt`-en kell szűrni, NEM `$createdAt`-en.
 *
 * Race-condition: a 48h grace > leghosszabb runtime-window 24h → kizárva.
 * A 6h grace > max blockMs 1h → kizárva. Phase 2-ben, ha runtime window-ok
 * vagy blockMs-ek növekednének, a két cutoff env var-ral hangolható.
 *
 * Trigger: Schedule (`0 2 * * *` — napi 2:00 UTC, a többi cleanup CF előtt)
 * Runtime: Node.js 18.0+
 * Timeout: 300s (5 perc). Worst-case: 2 × 2_000 × ~30ms = 120s = 2 perc.
 * Specification: s-0.5vcpu-512mb
 *
 * Env vars (kötelezők):
 *   - APPWRITE_API_KEY: `databases.*` jogosultság
 *   - APPWRITE_ENDPOINT (lásd [[Komponensek/CFTemplate]])
 *   - DATABASE_ID
 *   - IP_RATE_LIMIT_COUNTERS_COLLECTION_ID
 *   - IP_RATE_LIMIT_BLOCKS_COLLECTION_ID
 *
 * Env vars (opcionálisak):
 *   - COUNTER_CUTOFF_HOURS: default 48
 *   - BLOCK_CUTOFF_HOURS:   default 6
 *   - CLEANUP_DRY_RUN: '1' → csak loggol, NEM töröl. Első batch után kilép
 *     (listDocuments mindig ugyanazt adná dryRun-on → infinite-loop guard).
 *   - RESEND_API_KEY + ADMIN_NOTIFICATION_EMAIL: ha be van állítva és a futás
 *     bármelyik trigger-feltételt teljesíti, riport megy:
 *       - `failedAny` (per-doc delete-hiba — permission-misconfig / SDK error)
 *       - `cappedAtAny` (cap-elérte, következő futás folytatja)
 *       - `totalDeleted >= 1_000` (anomáliás volumen)
 *
 * Hibakezelés (orphan-sweeper-minta):
 *   - listDocuments fail → `success: false` 500 + `stats.collectionScanFailed`
 *   - per-doc deleteDocument 404 → idempotens (NEM hiba), continue
 *   - per-doc deleteDocument egyéb hiba → `stats.failed++` + log + continue
 *   - "no-progress" guard: ha egy iter 0 successful delete-tel zárul, break
 *     (infinite-loop védelem permission-failed / 404-loop ellen)
 */

const BATCH_LIMIT = 100;
// Codex pre-review BLOCKER fix: a 10_000/coll × 30ms = 5 perc szekvenciálisan
// NEM fér 5 perc CF timeout-ba. 2_000/coll × 30ms = 60s/coll → 120s a 2 coll-ra.
const MAX_DELETES_PER_COLLECTION = 2_000;
const DEFAULT_COUNTER_CUTOFF_HOURS = 48;
const DEFAULT_BLOCK_CUTOFF_HOURS = 6;
const ADMIN_ALERT_TOTAL_THRESHOLD = 1_000; // totalDeleted küszöb az admin email-re
const SAFETY_ITER_CAP = 50; // 50 × BATCH_LIMIT=100 = 5_000 max scan (> MAX_DELETES_PER_COLLECTION)

module.exports = async function ({ req, res, log, error }) {
    const startedAt = Date.now();
    try {
        const databaseId = process.env.DATABASE_ID;
        const countersCol = process.env.IP_RATE_LIMIT_COUNTERS_COLLECTION_ID;
        const blocksCol = process.env.IP_RATE_LIMIT_BLOCKS_COLLECTION_ID;
        const apiKey = req.headers?.['x-appwrite-key'] || process.env.APPWRITE_API_KEY;

        const missing = [];
        if (!databaseId) missing.push('DATABASE_ID');
        if (!countersCol) missing.push('IP_RATE_LIMIT_COUNTERS_COLLECTION_ID');
        if (!blocksCol) missing.push('IP_RATE_LIMIT_BLOCKS_COLLECTION_ID');
        if (!apiKey) missing.push('APPWRITE_API_KEY');
        if (missing.length > 0) {
            error(`[CleanupRateLimits] Missing env vars: ${missing.join(', ')}`);
            return res.json({ success: false, reason: 'misconfigured', missing }, 500);
        }

        // Codex stop-time NIT fix: explicit pozitív szám validáció.
        // `parseInt('0')` → 0, `parseInt('-5')` → -5 mindkettő félreviheti a cutoff-ot
        // jelen vagy jövőbeli timestamp-re. Csak `> 0` érték kerülhet a cutoff-ba.
        const counterCutoffHours = positiveIntEnv(process.env.COUNTER_CUTOFF_HOURS, DEFAULT_COUNTER_CUTOFF_HOURS);
        const blockCutoffHours = positiveIntEnv(process.env.BLOCK_CUTOFF_HOURS, DEFAULT_BLOCK_CUTOFF_HOURS);
        const dryRun = process.env.CLEANUP_DRY_RUN === '1';

        const now = Date.now();
        const counterCutoffIso = new Date(now - counterCutoffHours * 60 * 60 * 1000).toISOString();
        const blockCutoffIso = new Date(now - blockCutoffHours * 60 * 60 * 1000).toISOString();

        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || req.headers?.['x-appwrite-project'])
            .setKey(apiKey);
        const databases = new sdk.Databases(client);

        log(`[CleanupRateLimits] Start (dryRun=${dryRun}, counterCutoff=${counterCutoffIso} [-${counterCutoffHours}h], blockCutoff=${blockCutoffIso} [-${blockCutoffHours}h], cap=${MAX_DELETES_PER_COLLECTION}/coll)`);

        const stats = {
            counters: { scanned: 0, deleted: 0, failed: 0, cappedAtBudget: false },
            blocks: { scanned: 0, deleted: 0, failed: 0, cappedAtBudget: false },
            collectionScanFailed: []
        };

        await sweepCollection({
            databases, databaseId, collectionId: countersCol,
            cutoffIso: counterCutoffIso, dryRun, stat: stats.counters,
            collectionScanFailed: stats.collectionScanFailed,
            log, error, label: 'counters'
        });
        await sweepCollection({
            databases, databaseId, collectionId: blocksCol,
            cutoffIso: blockCutoffIso, dryRun, stat: stats.blocks,
            collectionScanFailed: stats.collectionScanFailed,
            log, error, label: 'blocks'
        });

        const totalDeleted = stats.counters.deleted + stats.blocks.deleted;
        const totalScanned = stats.counters.scanned + stats.blocks.scanned;
        const elapsedMs = Date.now() - startedAt;

        log(`[CleanupRateLimits] Done in ${elapsedMs}ms — stats=${JSON.stringify(stats)} totalScanned=${totalScanned} totalDeleted=${totalDeleted}`);

        // Codex stop-time MAJOR fix: failed > 0 esetén is admin alert (ne csak
        // cap-trigger vagy volumen-trigger). Permission-misconfig korai detect.
        const cappedAtAny = stats.counters.cappedAtBudget || stats.blocks.cappedAtBudget;
        const failedAny = stats.counters.failed > 0 || stats.blocks.failed > 0;
        const shouldAlert = cappedAtAny || failedAny || totalDeleted >= ADMIN_ALERT_TOTAL_THRESHOLD;
        if (shouldAlert && process.env.RESEND_API_KEY && process.env.ADMIN_NOTIFICATION_EMAIL) {
            try {
                await sendAdminAlert({ stats, totalDeleted, totalScanned, elapsedMs, cappedAtAny, failedAny, dryRun });
                log(`[CleanupRateLimits] Admin alert e-mail elküldve (${process.env.ADMIN_NOTIFICATION_EMAIL})`);
            } catch (mailErr) {
                error(`[CleanupRateLimits] Admin alert e-mail hiba: ${mailErr.message}`);
            }
        }

        // Codex stop-time MAJOR fix: per-doc delete failure (permission-misconfig,
        // SDK error) NEM mehet csendben `success: true`-val. Ha bármi failed > 0,
        // a CF 500-ot ad — egységes ops-policy a többi cron-CF-fel (orphan-sweeper).
        const hasFailure =
            stats.collectionScanFailed.length > 0 ||
            stats.counters.failed > 0 ||
            stats.blocks.failed > 0;
        const responsePayload = {
            success: !hasFailure,
            elapsedMs,
            dryRun,
            stats,
            totalScanned,
            totalDeleted
        };
        if (hasFailure) {
            responsePayload.reason = 'partial_failure';
            return res.json(responsePayload, 500);
        }
        return res.json(responsePayload);
    } catch (err) {
        error(`[CleanupRateLimits] uncaught: ${err.message}\n${err.stack}`);
        return res.json({ success: false, reason: 'internal_error', message: err.message }, 500);
    }
};

async function sweepCollection({ databases, databaseId, collectionId, cutoffIso, dryRun, stat, collectionScanFailed, log, error, label }) {
    let safety = 0;
    while (safety++ < SAFETY_ITER_CAP) {
        if (stat.deleted >= MAX_DELETES_PER_COLLECTION) {
            stat.cappedAtBudget = true;
            break;
        }

        // Codex stop-time BLOCKER fix: `$updatedAt`-en szűrünk, NEM `$createdAt`.
        // A runtime `incrementCounter` (counter) és `setBlock` `document_already_exists`
        // ág (block) `updateDocument`-tel hosszabbítja a doc-ot — a `$createdAt`
        // stale, az `$updatedAt` az autoritatív "utolsó érintés".
        const queries = [
            sdk.Query.lessThan('$updatedAt', cutoffIso),
            sdk.Query.orderAsc('$updatedAt'),
            sdk.Query.limit(BATCH_LIMIT)
        ];

        let page;
        try {
            page = await databases.listDocuments(databaseId, collectionId, queries);
        } catch (err) {
            error(`[CleanupRateLimits] listDocuments(${collectionId}, label=${label}) hiba: ${err.message}`);
            collectionScanFailed.push({ collection: collectionId, label, error: err.message });
            return;
        }

        if (!page.documents || page.documents.length === 0) break;
        stat.scanned += page.documents.length;

        if (dryRun) {
            // Csak az első batch-et loggoljuk, NEM iterálunk tovább —
            // listDocuments ugyanazt adná infinite-loop nélkül.
            log(`[CleanupRateLimits] DRY RUN ${label}: ${page.documents.length} doc lenne törölve (cutoff=${cutoffIso}). NEM iterál tovább.`);
            break;
        }

        const deletedAtStart = stat.deleted;
        for (const doc of page.documents) {
            if (stat.deleted >= MAX_DELETES_PER_COLLECTION) {
                stat.cappedAtBudget = true;
                break;
            }
            try {
                await databases.deleteDocument(databaseId, collectionId, doc.$id);
                stat.deleted++;
            } catch (delErr) {
                // 404 → idempotens (másik futás vagy konkurens cleanup törölte), NEM hiba.
                if (delErr?.code === 404 || /not.?found/i.test(delErr?.message || '')) continue;
                stat.failed++;
                error(`[CleanupRateLimits] delete ${collectionId}/${doc.$id} (label=${label}) hiba: ${delErr.message}`);
            }
        }

        // No-progress guard: ha 0 successful delete (mind 404 vagy permission-failed),
        // break — különben infinite loop, mert a következő listDocuments ugyanezt adja.
        if (stat.deleted === deletedAtStart) {
            log(`[CleanupRateLimits] sweep break ${label}: 0 successful delete in iter ${safety} (scanned=${page.documents.length}, failed=${stat.failed})`);
            break;
        }
    }
}

function positiveIntEnv(value, fallback) {
    const parsed = parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function sendAdminAlert({ stats, totalDeleted, totalScanned, elapsedMs, cappedAtAny, failedAny, dryRun }) {
    const apiKey = process.env.RESEND_API_KEY;
    const toEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@maestro.emago.hu';
    const triggerReason = failedAny
        ? 'failed > 0 (permission-misconfig vagy SDK error gyanú)'
        : cappedAtAny
            ? 'cappedAtBudget'
            : `totalDeleted >= ${ADMIN_ALERT_TOTAL_THRESHOLD}`;

    const html = `
        <h2>Maestro cleanup-rate-limits riport</h2>
        <p>Trigger: <strong>${triggerReason}</strong>${dryRun ? ' <em>(DRY RUN)</em>' : ''}</p>
        <ul>
            <li>counters: scanned=${stats.counters.scanned}, deleted=${stats.counters.deleted}, failed=${stats.counters.failed}, cappedAtBudget=${stats.counters.cappedAtBudget}</li>
            <li>blocks: scanned=${stats.blocks.scanned}, deleted=${stats.blocks.deleted}, failed=${stats.blocks.failed}, cappedAtBudget=${stats.blocks.cappedAtBudget}</li>
            <li>totalScanned: ${totalScanned}, totalDeleted: ${totalDeleted}</li>
            <li>elapsedMs: ${elapsedMs}</li>
        </ul>
        <p>${failedAny
            ? 'Per-doc delete-hibák — ellenőrizd a CF execution log-ot (permission-scope, schema-drift, SDK error).'
            : cappedAtAny
                ? `Egy vagy több collection elérte a MAX_DELETES_PER_COLLECTION=${MAX_DELETES_PER_COLLECTION} capet — a következő futás folytatja.`
                : 'Magas törlési volumen — ellenőrizd, hogy a rate-limit-konfig nem túl szigorú vagy van-e bot-spam-incident.'}</p>
    `;

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: fromEmail,
            to: toEmail,
            subject: `[Maestro] cleanup-rate-limits — ${triggerReason}, totalDeleted=${totalDeleted}`,
            html
        })
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Resend API ${response.status}: ${body}`);
    }
}
