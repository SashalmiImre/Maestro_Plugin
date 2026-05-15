const sdk = require("node-appwrite");

// S.13.2+S.13.3 Phase 2.2 — PII-redaction log wrap + response info-disclosure védelem.
const { wrapLogger } = require('./_generated_piiRedaction.js');
const { fail } = require('./_generated_responseHelpers.js');

/**
 * Appwrite Function: Migrate Legacy Paths
 *
 * Egyszeri batch migráció: régi formátumú útvonalak konvertálása kanonikus/relatív formátumra.
 *
 * A kliens-oldali `migratePathsIfNeeded()` (DataContext.jsx) lazy módon fut —
 * ha egy felhasználó soha nem nyitja meg a plugint, az ő kiadványainak útvonalai
 * soha nem migrálódnak. Ez a function batch-ben dolgozza fel az összes rekordot.
 *
 * Műveletek:
 * 1. Publications: abszolút rootPath → kanonikus (/ShareName/relative/path)
 * 2. Articles: abszolút filePath → relatív (pub rootPath-hoz képest)
 *
 * Biztonság: DRY_RUN=true (alapértelmezett) — csak logol, nem módosít.
 *
 * Trigger: Manuális (HTTP endpoint)
 * Runtime: Node.js 18.0+
 * Timeout: 120s
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY: API kulcs (databases.read, databases.write)
 * - DATABASE_ID
 * - ARTICLES_COLLECTION_ID
 * - PUBLICATIONS_COLLECTION_ID
 * - DRY_RUN: "true" (alapértelmezett) vagy "false"
 */

const BATCH_LIMIT = 100;
const MOUNT_PREFIXES = ['/Volumes', 'C:/Volumes'];

// ─── Path konverziós segédfüggvények (portolva pathUtils.js-ből) ──────────

/**
 * Ellenőrzi, hogy a rootPath legacy (abszolút natív) formátumú-e.
 */
function isLegacyRootPath(rootPath) {
    if (!rootPath) return false;
    const normalized = rootPath.replace(/\\/g, '/');
    for (const pfx of MOUNT_PREFIXES) {
        if (normalized.startsWith(pfx + '/') || normalized === pfx) return true;
    }
    return /^[a-zA-Z]:\//.test(normalized);
}

/**
 * Natív útvonal → kanonikus formátum (levágja a MOUNT_PREFIX-et).
 * Pl.: /Volumes/Story/2026/March → /Story/2026/March
 */
function toCanonicalPath(nativePath) {
    const processed = nativePath.replace(/\\/g, '/');
    for (const pfx of MOUNT_PREFIXES) {
        if (processed.startsWith(pfx + '/') || processed === pfx) {
            return processed.substring(pfx.length) || '/';
        }
    }
    return processed;
}

/**
 * Ellenőrzi, hogy a filePath abszolút (natív) formátumú-e.
 */
function isAbsoluteFilePath(filePath) {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
}

/**
 * Abszolút filePath → relatív (pub rootPath-hoz képest).
 * Pl.: /Volumes/Story/2026/March/.maestro/cikk.indd + /Story/2026/March → .maestro/cikk.indd
 */
function toRelativeArticlePath(absolutePath, canonicalRootPath) {
    if (!absolutePath || !canonicalRootPath) return absolutePath;

    const normalizedPath = absolutePath.replace(/\\/g, '/');
    const normalizedRoot = canonicalRootPath.replace(/\\/g, '/');

    // Próbáljuk a mount prefix-es verziókat
    for (const pfx of MOUNT_PREFIXES) {
        const fullRoot = pfx + normalizedRoot;
        if (normalizedPath.startsWith(fullRoot + '/')) {
            return normalizedPath.substring(fullRoot.length + 1);
        }
        if (normalizedPath.startsWith(fullRoot)) {
            return normalizedPath.substring(fullRoot.length);
        }
    }

    // Ha a kanonikus root közvetlenül egyezik
    if (normalizedPath.startsWith(normalizedRoot + '/')) {
        return normalizedPath.substring(normalizedRoot.length + 1);
    }

    return absolutePath;
}

// ─── Belépési pont ────────────────────────────────────────────────────────

module.exports = async function ({ req, res, log: rawLog, error: rawError }) {
    const { log, error } = wrapLogger(rawLog, rawError);
    const isDryRun = (process.env.DRY_RUN || 'true').toLowerCase() !== 'false';

    try {
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        const databases = new sdk.Databases(client);

        const databaseId = process.env.DATABASE_ID;
        const articlesCollectionId = process.env.ARTICLES_COLLECTION_ID;
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;

        log(`=== Útvonal migráció indítása (DRY_RUN=${isDryRun}) ===`);

        // ── 1. Publications rootPath migráció ──
        let pubsMigrated = 0;
        let cursor = undefined;
        const pubRootPaths = new Map(); // pubId → canonical rootPath

        while (true) {
            const queries = [sdk.Query.limit(BATCH_LIMIT)];
            if (cursor) queries.push(sdk.Query.cursorAfter(cursor));

            const pubs = await databases.listDocuments(databaseId, publicationsCollectionId, queries);

            for (const pub of pubs.documents) {
                // Aktuális rootPath mentése a cikkek migrációjához
                let canonicalRoot = pub.rootPath;

                if (pub.rootPath && isLegacyRootPath(pub.rootPath)) {
                    canonicalRoot = toCanonicalPath(pub.rootPath);
                    log(`[Pub] ${pub.name}: "${pub.rootPath}" → "${canonicalRoot}"`);

                    if (!isDryRun) {
                        await databases.updateDocument(databaseId, publicationsCollectionId, pub.$id, {
                            rootPath: canonicalRoot
                        });
                    }
                    pubsMigrated++;
                }

                pubRootPaths.set(pub.$id, canonicalRoot);
            }

            if (pubs.documents.length < BATCH_LIMIT) break;
            cursor = pubs.documents[pubs.documents.length - 1].$id;
        }

        // ── 2. Articles filePath migráció ──
        let artsMigrated = 0;
        cursor = undefined;

        while (true) {
            const queries = [sdk.Query.limit(BATCH_LIMIT)];
            if (cursor) queries.push(sdk.Query.cursorAfter(cursor));

            const articles = await databases.listDocuments(databaseId, articlesCollectionId, queries);

            for (const article of articles.documents) {
                if (!article.filePath) continue;

                const normalized = article.filePath.replace(/\\/g, '/');
                let newPath = null;

                if (isAbsoluteFilePath(normalized)) {
                    // Abszolút → relatív konverzió
                    const pubRoot = pubRootPaths.get(article.publicationId);
                    if (pubRoot) {
                        const relative = toRelativeArticlePath(normalized, pubRoot);
                        if (relative !== normalized) {
                            newPath = relative;
                        }
                    }
                } else if (normalized !== article.filePath) {
                    // Backslash normalizáció (Windows → kanonikus)
                    newPath = normalized;
                }

                if (newPath) {
                    log(`[Art] ${article.name || article.$id}: "${article.filePath}" → "${newPath}"`);

                    if (!isDryRun) {
                        await databases.updateDocument(databaseId, articlesCollectionId, article.$id, {
                            filePath: newPath
                        });
                    }
                    artsMigrated++;
                }
            }

            if (articles.documents.length < BATCH_LIMIT) break;
            cursor = articles.documents[articles.documents.length - 1].$id;
        }

        log(`=== Migráció kész: ${pubsMigrated} pub + ${artsMigrated} article ${isDryRun ? '(DRY RUN)' : '(ALKALMAZVA)'} ===`);

        return res.json({
            success: true,
            dryRun: isDryRun,
            publicationsMigrated: pubsMigrated,
            articlesMigrated: artsMigrated
        });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return fail(res, 500, 'internal_error', {
            executionId: req?.headers?.['x-appwrite-execution-id']
        });
    }
};
