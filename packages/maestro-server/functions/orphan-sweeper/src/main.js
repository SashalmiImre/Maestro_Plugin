const sdk = require("node-appwrite");

// S.13.2+S.13.3 Phase 2.2 — PII-redaction log wrap + response info-disclosure védelem.
const { wrapLogger } = require('./_generated_piiRedaction.js');
const { fail } = require('./_generated_responseHelpers.js');

/**
 * Appwrite Function: Orphan Sweeper (D.4, 2026-05-09)
 *
 * Backstop cron a `user-cascade-delete` event-driven CF mellett. A CF nem
 * védett a race ellen:
 *   - User-delete + concurrent acceptInvite → membership létrejön a user-doc
 *     törlésével párhuzamosan, a CF event utáni cleanup nem találja
 *   - Web-platform race: a Appwrite `users.delete` event sometimes előbb fut,
 *     mint az utolsó in-flight membership-create
 *
 * Logika:
 *   1. Iteráljon a 3 membership collection-ön (org/office/group)
 *   2. Minden rekord `userId`-jét nézze meg `usersApi.get(id)` → 404 = orphan
 *      → delete (csak akkor, ha a membership doc legalább `GRACE_WINDOW_MS`
 *        régi, hogy ne harcoljon a user-cascade-delete in-flight cleanup-jával)
 *   3. Statisztika log + ha >50 orphan, e-mail az adminnak (Resend, opcionális)
 *
 * Trigger: Schedule (`0 3 * * *` — naponta 3:00 UTC)
 * Runtime: Node.js 18.0+
 *
 * Env vars (kötelezők):
 *   - APPWRITE_API_KEY: API kulcs (databases.*, users.read jogosultságok)
 *   - APPWRITE_ENDPOINT (lásd CFTemplate)
 *   - DATABASE_ID
 *   - ORGANIZATION_MEMBERSHIPS_COLLECTION_ID
 *   - EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID
 *   - GROUP_MEMBERSHIPS_COLLECTION_ID
 *
 * Env vars (opcionálisak):
 *   - RESEND_API_KEY + ADMIN_NOTIFICATION_EMAIL: ha be van állítva és >50
 *     orphan, e-mail riport megy az adminnak
 *   - GRACE_WINDOW_MS: alapértelmezett 1 óra (3600000) — Codex tervi review
 *     (2026-05-09) szerint legalább 1 óra grace, hogy ne harcoljon a
 *     user-cascade-delete event-driven CF in-flight cleanup-jával
 *
 * Throttling: Codex Q4 review szerint max 100 user-check / minute (Appwrite
 * API rate limit). Ha sok orphan van, csak a legrégebbi 500-at takarítja egy
 * futás — a következő scheduled futás folytatja.
 *
 * Cache (Codex review 2026-05-09 MAJOR-2 dokumentáció): a `userExistsCache`
 * Map szándékosan **per-futás** — egy 24h cron-cycle-ben max
 * `MAX_USER_CHECKS_PER_RUN=500` `usersApi.get` hívás megy ki a forgalom-cap
 * miatt, így a perzisztált cache (új collection) overengineering lenne. Egy
 * tartós orphan helyzet (memberships maradnak, mert nincs ki törölje) napi
 * 500 ismétlődő `usersApi.get`-et fogyaszt, ami a 100/min Appwrite rate
 * limit alatt marad (5 perc CF runtime). Phase 2 felmerülhet, ha az orphan-
 * szám tartósan >500.
 */

const BATCH_LIMIT = 100;
const MAX_USER_CHECKS_PER_RUN = 500; // ~5 perc 100/min throttle-lal; 5min CF timeout-on belül
// Codex harden adversarial fix (2026-05-09): per-collection user-check budget.
// Korábban egy busy `organizationMemberships` head megette mind az 500-at, és
// a 2 másik collection (office/group) sosem került sweepelésre. Most minden
// collection saját 1/3 budget-et kap; ha bármelyik nem használja el, a
// reziduum a többinek nem cumulál (egyszerűbb a tisztán izolált budget).
const COLLECTION_CHECK_BUDGET = Math.floor(MAX_USER_CHECKS_PER_RUN / 3);
const ADMIN_ALERT_THRESHOLD = 50;
const DEFAULT_GRACE_WINDOW_MS = 60 * 60 * 1000; // 1 óra

module.exports = async function ({ req, res, log: rawLog, error: rawError }) {
    const { log, error } = wrapLogger(rawLog, rawError);
    const startedAt = Date.now();
    try {
        const databaseId = process.env.DATABASE_ID;
        const orgMemsCol = process.env.ORGANIZATION_MEMBERSHIPS_COLLECTION_ID;
        const officeMemsCol = process.env.EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID;
        const groupMemsCol = process.env.GROUP_MEMBERSHIPS_COLLECTION_ID;
        // Codex adversarial review (2026-05-09 BLOCKER fix): a sweeper az
        // `user-cascade-delete` Phase 1.5 invariánsát is fenntartja — ha
        // törli egy org utolsó owner membership-jét, ráírja a
        // `organizations.status='orphaned'` markert is. OPCIONÁLIS env var
        // (ha hiányzik, csak loggol mint a v4 user-cascade-delete-ben).
        const orgsCol = process.env.ORGANIZATIONS_COLLECTION_ID;
        const apiKey = req.headers?.['x-appwrite-key'] || process.env.APPWRITE_API_KEY;

        const missing = [];
        if (!databaseId) missing.push('DATABASE_ID');
        if (!orgMemsCol) missing.push('ORGANIZATION_MEMBERSHIPS_COLLECTION_ID');
        if (!officeMemsCol) missing.push('EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID');
        if (!groupMemsCol) missing.push('GROUP_MEMBERSHIPS_COLLECTION_ID');
        if (!apiKey) missing.push('APPWRITE_API_KEY');
        if (missing.length > 0) {
            error(`[OrphanSweeper] Missing env vars: ${missing.join(', ')}`);
            return res.json({ success: false, reason: 'misconfigured', missing }, 500);
        }

        const graceWindowMs = parseInt(process.env.GRACE_WINDOW_MS || '', 10) || DEFAULT_GRACE_WINDOW_MS;
        const cutoffIso = new Date(Date.now() - graceWindowMs).toISOString();

        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || req.headers?.['x-appwrite-project'])
            .setKey(apiKey);
        const databases = new sdk.Databases(client);
        const usersApi = new sdk.Users(client);

        log(`[OrphanSweeper] Start (graceWindow=${graceWindowMs}ms, cutoff=${cutoffIso})`);

        const userExistsCache = new Map(); // userId → boolean
        // Codex adversarial review fix: az org-szintű last-owner detect-hez
        // gyűjtjük azokat az `organizationId`-ket, ahol owner-membership
        // törlődött (a `sweepCollection` callback push-olja). A 3 sweep
        // után egy post-process loop minden ilyen org-ra owner recount-ot
        // futtat + status writeback-et.
        const ownerDeletedOrgIds = new Set();
        const stats = {
            organizationMemberships: { scanned: 0, orphaned: 0, deleted: 0, failed: 0, cappedAtBudget: false },
            editorialOfficeMemberships: { scanned: 0, orphaned: 0, deleted: 0, failed: 0, cappedAtBudget: false },
            groupMemberships: { scanned: 0, orphaned: 0, deleted: 0, failed: 0, cappedAtBudget: false },
            userChecks: 0,
            cappedAtMaxChecks: false,
            // Codex adversarial review fix (BLOCKER): a sweeper által törölt
            // owner-rekordok után az érintett org-ok status-watch-a.
            orphanedOrgsMarked: 0,
            orphanMarkerSkipped: 0,
            orphanMarkerFailed: 0,
            // Codex harden adversarial fix (2026-05-09): a sweep-collection
            // listDocuments hibák korábban silent-fail-eltek (return; +
            // success:true a CF végen). Most a stats track-eli az érintett
            // collection-eket, és a CF végén `success: false`-t ad vissza,
            // ha bármi failed.
            collectionScanFailed: []
        };

        async function isUserOrphan(userId) {
            if (userExistsCache.has(userId)) return !userExistsCache.get(userId);
            if (stats.userChecks >= MAX_USER_CHECKS_PER_RUN) {
                stats.cappedAtMaxChecks = true;
                return false; // ne dönts orphan-t a cap után, várj a következő futásra
            }
            stats.userChecks++;
            try {
                await usersApi.get(userId);
                userExistsCache.set(userId, true);
                return false;
            } catch (err) {
                if (err?.code === 404 || /not.?found/i.test(err?.message || '')) {
                    userExistsCache.set(userId, false);
                    return true;
                }
                // Egyéb hiba (network, rate-limit) → konzervatív: NE dönts orphan-t.
                error(`[OrphanSweeper] users.get(${userId}) hiba (skip): ${err.message}`);
                return false;
            }
        }

        async function sweepCollection(collectionId, statKey) {
            // Codex harden adversarial fix (2026-05-09): per-collection user-
            // check budget — a busy head ne starve-olja a kisebb collection-öket.
            const startChecks = stats.userChecks;
            let cursorAfter = null;
            let safety = 0;
            while (safety++ < 1000) {
                if (stats.cappedAtMaxChecks) break;
                if ((stats.userChecks - startChecks) >= COLLECTION_CHECK_BUDGET) {
                    stats[statKey].cappedAtBudget = true;
                    break;
                }

                const queries = [
                    sdk.Query.lessThan('$createdAt', cutoffIso), // grace window
                    sdk.Query.limit(BATCH_LIMIT)
                ];
                if (cursorAfter) queries.push(sdk.Query.cursorAfter(cursorAfter));

                let page;
                try {
                    page = await databases.listDocuments(databaseId, collectionId, queries);
                } catch (err) {
                    // Codex harden adversarial fix (2026-05-09): NEM silent
                    // return — track-eljük a collection scan failure-t és a
                    // CF végén `success: false`-t adunk vissza.
                    error(`[OrphanSweeper] listDocuments(${collectionId}) hiba: ${err.message}`);
                    stats.collectionScanFailed.push({ collection: collectionId });
                    return;
                }

                if (!page.documents || page.documents.length === 0) break;
                stats[statKey].scanned += page.documents.length;

                for (const doc of page.documents) {
                    if (stats.cappedAtMaxChecks) break;
                    if ((stats.userChecks - startChecks) >= COLLECTION_CHECK_BUDGET) {
                        stats[statKey].cappedAtBudget = true;
                        break;
                    }
                    if (!doc.userId) continue;
                    const orphan = await isUserOrphan(doc.userId);
                    if (!orphan) continue;
                    stats[statKey].orphaned++;
                    try {
                        await databases.deleteDocument(databaseId, collectionId, doc.$id);
                        stats[statKey].deleted++;
                        // Codex adversarial review fix (BLOCKER): az
                        // `organizationMemberships` collection owner törlése
                        // potenciálisan utolsó owner-t érint — a 3 sweep
                        // után post-process loop ellenőrzi az érintett
                        // org-ok ténylegesen owner-tlensé válását.
                        if (collectionId === orgMemsCol && doc.role === 'owner' && doc.organizationId) {
                            ownerDeletedOrgIds.add(doc.organizationId);
                        }
                    } catch (delErr) {
                        stats[statKey].failed++;
                        error(`[OrphanSweeper] delete ${collectionId}/${doc.$id} hiba: ${delErr.message}`);
                    }
                }

                if (page.documents.length < BATCH_LIMIT) break;
                cursorAfter = page.documents[page.documents.length - 1].$id;
            }
        }

        await sweepCollection(orgMemsCol, 'organizationMemberships');
        await sweepCollection(officeMemsCol, 'editorialOfficeMemberships');
        await sweepCollection(groupMemsCol, 'groupMemberships');

        // Codex adversarial review fix (BLOCKER): a sweeper után az érintett
        // org-okra `last-owner` recount + `organizations.status='orphaned'`
        // marker write. A `user-cascade-delete` Phase 1.5 invariánsát
        // tartja: NE keletkezzen `active` org owner nélkül a sweeper által.
        // Best-effort — ha az `ORGANIZATIONS_COLLECTION_ID` env nincs
        // beállítva, csak loggol (mint a user-cascade-delete v4-en).
        for (const orgId of ownerDeletedOrgIds) {
            try {
                const remainingOwners = await databases.listDocuments(databaseId, orgMemsCol, [
                    sdk.Query.equal('organizationId', orgId),
                    sdk.Query.equal('role', 'owner'),
                    sdk.Query.limit(1)
                ]);
                if (remainingOwners.total !== 0) continue; // van owner, OK
                if (!orgsCol) {
                    error(`[OrphanSweeper] orphan marker SKIP (org=${orgId}) — ORGANIZATIONS_COLLECTION_ID env var nincs beállítva`);
                    stats.orphanMarkerSkipped++;
                    continue;
                }
                try {
                    await databases.updateDocument(databaseId, orgsCol, orgId, { status: 'orphaned' });
                    stats.orphanedOrgsMarked++;
                    log(`[OrphanSweeper] org=${orgId} status='orphaned' (last-owner enforcement, sweeper backstop)`);
                } catch (markErr) {
                    stats.orphanMarkerFailed++;
                    error(`[OrphanSweeper] orphan marker write hiba (org=${orgId}): ${markErr.message}`);
                }
            } catch (countErr) {
                error(`[OrphanSweeper] owner-count lookup hiba (org=${orgId}): ${countErr.message}`);
                stats.orphanMarkerFailed++;
            }
        }

        const totalDeleted =
            stats.organizationMemberships.deleted +
            stats.editorialOfficeMemberships.deleted +
            stats.groupMemberships.deleted;

        const totalOrphaned =
            stats.organizationMemberships.orphaned +
            stats.editorialOfficeMemberships.orphaned +
            stats.groupMemberships.orphaned;

        const elapsedMs = Date.now() - startedAt;
        log(`[OrphanSweeper] Done in ${elapsedMs}ms — stats=${JSON.stringify(stats)} totalOrphaned=${totalOrphaned} totalDeleted=${totalDeleted}`);

        // Admin notification (D.4.3 — opcionális, csak ha sok orphan van)
        if (totalOrphaned >= ADMIN_ALERT_THRESHOLD && process.env.RESEND_API_KEY && process.env.ADMIN_NOTIFICATION_EMAIL) {
            try {
                await sendAdminAlert(stats, totalOrphaned, totalDeleted, elapsedMs);
                log(`[OrphanSweeper] Admin alert e-mail elküldve (${process.env.ADMIN_NOTIFICATION_EMAIL})`);
            } catch (mailErr) {
                error(`[OrphanSweeper] Admin alert e-mail hiba: ${mailErr.message}`);
            }
        }

        // Codex harden adversarial fix (2026-05-09): success:false ha bármi
        // collection-scan failed VAGY orphan-marker skipped (misconfig).
        // Ezzel az ops-policy egységes a `user-cascade-delete`-tel
        // (verificationFailures.push + 5xx admin-attention-mintát követve).
        const hasFailure = stats.collectionScanFailed.length > 0
            || stats.orphanMarkerSkipped > 0
            || stats.orphanMarkerFailed > 0;
        const responsePayload = {
            success: !hasFailure,
            elapsedMs,
            stats,
            totalOrphaned,
            totalDeleted
        };
        if (hasFailure) {
            responsePayload.reason = 'partial_failure';
            return res.json(responsePayload, 500);
        }
        return res.json(responsePayload);
    } catch (err) {
        error(`[OrphanSweeper] uncaught: ${err.message}\n${err.stack}`);
        return fail(res, 500, 'internal_error', {
            executionId: req?.headers?.['x-appwrite-execution-id']
        });
    }
};

/**
 * D.4.3 — Resend e-mail riport admin-nak, ha egy futás >50 orphan-t talál.
 * Best-effort, nem blokkol. NEM a `actions/sendEmail.js`-t hívja, mert ez
 * önálló CF — saját fetch-pattern.
 */
async function sendAdminAlert(stats, totalOrphaned, totalDeleted, elapsedMs) {
    const apiKey = process.env.RESEND_API_KEY;
    const toEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@maestro.emago.hu';

    const html = `
        <h2>Maestro orphan-sweeper riport</h2>
        <p>A napi <code>orphan-sweeper</code> futás <strong>${totalOrphaned}</strong> árva membership-rekordot talált.</p>
        <ul>
            <li>organizationMemberships: scanned=${stats.organizationMemberships.scanned}, orphaned=${stats.organizationMemberships.orphaned}, deleted=${stats.organizationMemberships.deleted}, failed=${stats.organizationMemberships.failed}</li>
            <li>editorialOfficeMemberships: scanned=${stats.editorialOfficeMemberships.scanned}, orphaned=${stats.editorialOfficeMemberships.orphaned}, deleted=${stats.editorialOfficeMemberships.deleted}, failed=${stats.editorialOfficeMemberships.failed}</li>
            <li>groupMemberships: scanned=${stats.groupMemberships.scanned}, orphaned=${stats.groupMemberships.orphaned}, deleted=${stats.groupMemberships.deleted}, failed=${stats.groupMemberships.failed}</li>
            <li>userChecks: ${stats.userChecks}${stats.cappedAtMaxChecks ? ' (cap reached, többi a következő futásra marad)' : ''}</li>
            <li>elapsedMs: ${elapsedMs}</li>
            <li>totalDeleted: ${totalDeleted}</li>
        </ul>
        <p>Ha ez váratlan szám, ellenőrizd: <code>user-cascade-delete</code> CF execution log + <code>users</code> collection változások az utolsó 24h-ban.</p>
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
            subject: `[Maestro] orphan-sweeper riport — ${totalOrphaned} árva rekord`,
            html
        })
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Resend API ${response.status}: ${body}`);
    }
}
