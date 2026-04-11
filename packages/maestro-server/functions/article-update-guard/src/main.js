const sdk = require("node-appwrite");

/**
 * Appwrite Function: Article Update Guard
 *
 * Szerver-oldali validáció cikk frissítésekor.
 * A workflow konfigurációt a `workflows` collection `compiled` JSON-jából olvassa.
 *
 * Ellenőrzések:
 * 1. Állapot érvényessége (a compiled.states-ben létezik-e)
 * 2. Állapotátmenet érvényessége (compiled.transitions alapján)
 * 3. Parent publication scope sync (Fázis 1 / B.8)
 * 4. Office scope (caller user tagja-e a cikk editorialOfficeId-jának)
 * 5. Jogosultság (a felhasználó csoporttagsága engedélyezi-e az átmenetet)
 * 6. Contributor mezők validitása
 *
 * Fail-closed: ha a workflow doc nem elérhető → state revert.
 *
 * Trigger: databases.*.collections.articles.documents.*.update
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - APPWRITE_API_KEY
 * - DATABASE_ID
 * - ARTICLES_COLLECTION_ID
 * - PUBLICATIONS_COLLECTION_ID
 * - WORKFLOWS_COLLECTION_ID
 * - EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID
 * - GROUPS_COLLECTION_ID
 * - GROUP_MEMBERSHIPS_COLLECTION_ID
 */

const SERVER_GUARD_ID = 'server-guard';

// ─── Workflow cache (process-szintű, 60s TTL, Map-alapú) ────────────────────
//
// Fázis 6: a workflow-t a publikáció `workflowId`-ja alapján töltjük be,
// fallback az office első workflow-jára ha null. A Map két kulcstípust kezel:
//   - `wf:${workflowId}`        — konkrét workflow ID
//   - `office:${officeId}`      — fallback az office első workflow-jára
//
// Soft FIFO eviction CACHE_MAX_ENTRIES felett; Appwrite function process-ek
// ephemeralisek, a memória-pressure alacsony, ezért LRU overkill lenne.

const workflowCache = new Map();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 32;

function cacheGet(key) {
    const entry = workflowCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) {
        workflowCache.delete(key);
        return null;
    }
    return entry.compiled;
}

function cacheSet(key, compiled) {
    if (workflowCache.size >= CACHE_MAX_ENTRIES) {
        // FIFO: Map insertion order garantált, a legrégebbi kerül ki
        const firstKey = workflowCache.keys().next().value;
        if (firstKey) workflowCache.delete(firstKey);
    }
    workflowCache.set(key, { compiled, fetchedAt: Date.now() });
}

/**
 * Betölti a compiled workflow JSON-t egy publikáció számára.
 *
 * Elsődleges (Fázis 7): `publication.workflowId` alapján a `workflows`
 * collection-ből, cross-tenant védelemmel (a workflow `editorialOfficeId`-jának
 * egyeznie kell a publikáció office-ával). Ha a workflowId explicit beállított,
 * de nem oldható fel (404, scope mismatch, egyéb hiba), a függvény `null`-t ad
 * vissza — a hívó ilyenkor fail-closed módon revert-el, soha nem esünk vissza
 * egy másik workflow-ra (cross-workflow leak védelem).
 *
 * Legacy fallback: kizárólag akkor, ha a `publication.workflowId` mező
 * explicit null/undefined (Fázis 7 előtti rekordok), akkor az office első
 * workflow-jára esünk vissza. Új publikációkat a Dashboard mindig `workflowId`-val
 * hoz létre, így ez az ág éles adatokon nem tüzel.
 *
 * @param {sdk.Databases} databases
 * @param {string} databaseId
 * @param {string} workflowsCollectionId
 * @param {{ editorialOfficeId?: string, workflowId?: string }} parentPublication
 * @param {Function} log
 * @returns {Promise<Object|null>}
 */
async function getWorkflowForPublication(databases, databaseId, workflowsCollectionId, parentPublication, log) {
    if (!parentPublication) return null;
    const officeId = parentPublication.editorialOfficeId;
    const workflowId = parentPublication.workflowId;

    // 1. Primary: publication.workflowId — fail-closed, nincs cross-workflow fallback
    if (workflowId) {
        const cacheKey = `wf:${workflowId}`;
        const cached = cacheGet(cacheKey);
        if (cached) return cached;
        try {
            const doc = await databases.getDocument(databaseId, workflowsCollectionId, workflowId);
            if (officeId && doc.editorialOfficeId !== officeId) {
                log(`[Workflow] Cross-tenant leak blokkolva: wf ${workflowId} office=${doc.editorialOfficeId} ≠ pub office=${officeId} — fail-closed`);
                return null;
            }
            const compiled = typeof doc.compiled === 'string' ? JSON.parse(doc.compiled) : doc.compiled;
            cacheSet(cacheKey, compiled);
            return compiled;
        } catch (e) {
            if (e.code === 404) {
                log(`[Workflow] publication.workflowId=${workflowId} not found — fail-closed`);
            } else {
                log(`[Workflow] workflow lookup hiba (${workflowId}): ${e.message} — fail-closed`);
            }
            return null;
        }
    }

    // 2. Legacy fallback: csak akkor, ha a publication.workflowId explicit null
    if (!officeId) return null;
    const fallbackKey = `office:${officeId}`;
    const cached = cacheGet(fallbackKey);
    if (cached) return cached;
    try {
        const result = await databases.listDocuments(databaseId, workflowsCollectionId, [
            sdk.Query.equal('editorialOfficeId', officeId),
            sdk.Query.limit(1)
        ]);
        if (result.documents.length === 0) {
            log(`[Workflow] Nincs workflow az office-hoz: ${officeId}`);
            return null;
        }
        const doc = result.documents[0];
        const compiled = typeof doc.compiled === 'string' ? JSON.parse(doc.compiled) : doc.compiled;
        cacheSet(fallbackKey, compiled);
        return compiled;
    } catch (e) {
        log(`[Workflow] Office fallback hiba: ${e.message}`);
        return null;
    }
}

// ─── Segédfüggvények ─────────────────────────────────────────────────────

/**
 * Lekéri a felhasználó csoporttagságait.
 */
async function getUserGroupSlugs(databases, databaseId, groupsCollectionId, groupMembershipsCollectionId, userId, editorialOfficeId) {
    try {
        const membershipsResult = await databases.listDocuments(databaseId, groupMembershipsCollectionId, [
            sdk.Query.equal('userId', userId),
            sdk.Query.equal('editorialOfficeId', editorialOfficeId),
            sdk.Query.limit(100)
        ]);
        if (membershipsResult.documents.length === 0) return [];

        const groupIds = [...new Set(membershipsResult.documents.map(m => m.groupId))];
        const groupsResult = await databases.listDocuments(databaseId, groupsCollectionId, [
            sdk.Query.equal('$id', groupIds),
            sdk.Query.limit(100)
        ]);

        const groupIdToSlug = new Map(groupsResult.documents.map(g => [g.$id, g.slug]));
        const slugs = new Set();
        for (const m of membershipsResult.documents) {
            const slug = groupIdToSlug.get(m.groupId);
            if (slug) slugs.add(slug);
        }
        return [...slugs];
    } catch (e) {
        return null;
    }
}

/**
 * Lekéri a felhasználó office membership rekordját.
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

        // ── 1. Sentinel guard ──
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
        const workflowsCollectionId = process.env.WORKFLOWS_COLLECTION_ID;
        const officeMembershipsCollectionId = process.env.EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID;
        const groupsCollectionId = process.env.GROUPS_COLLECTION_ID;
        const groupMembershipsCollectionId = process.env.GROUP_MEMBERSHIPS_COLLECTION_ID;

        // ── Fail-fast env var guard ──
        const missingEnvVars = [];
        if (!officeMembershipsCollectionId) missingEnvVars.push('EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID');
        if (!publicationsCollectionId) missingEnvVars.push('PUBLICATIONS_COLLECTION_ID');
        if (!workflowsCollectionId) missingEnvVars.push('WORKFLOWS_COLLECTION_ID');
        if (!groupsCollectionId) missingEnvVars.push('GROUPS_COLLECTION_ID');
        if (!groupMembershipsCollectionId) missingEnvVars.push('GROUP_MEMBERSHIPS_COLLECTION_ID');
        if (missingEnvVars.length > 0) {
            error(`[Config] Hiányzó környezeti változó(k): ${missingEnvVars.join(', ')}`);
            return res.json({ success: false, reason: 'misconfigured', missing: missingEnvVars }, 500);
        }

        // ── 2. Friss dokumentum lekérése ──
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

        if (freshDoc.modifiedByClientId === SERVER_GUARD_ID) {
            return res.json({ success: true, action: 'skipped', reason: 'Server guard update (fresh)' });
        }

        const corrections = {};

        // ── 3. Parent publication scope sync (Fázis 1 / B.8) ──
        let parentPublication = null;
        if (freshDoc.publicationId) {
            try {
                parentPublication = await databases.getDocument(
                    databaseId, publicationsCollectionId, freshDoc.publicationId
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
            if (parentPublication.editorialOfficeId !== freshDoc.editorialOfficeId) {
                corrections.editorialOfficeId = parentPublication.editorialOfficeId;
                log(`[Scope] Cikk editorialOfficeId drift → sync a parent-hez`);
                freshDoc.editorialOfficeId = parentPublication.editorialOfficeId;
            }
            if (parentPublication.organizationId
                && parentPublication.organizationId !== freshDoc.organizationId) {
                corrections.organizationId = parentPublication.organizationId;
                log(`[Scope] Cikk organizationId drift → sync a parent-hez`);
                freshDoc.organizationId = parentPublication.organizationId;
            }
        }

        // ── 4. Workflow betöltés (fail-closed) ──
        // Fázis 6: a workflow a publication.workflowId alapján töltődik be
        // (fallback: office első workflow-ja). Ha a parent publication törölt
        // vagy nem elérhető, a freshDoc.editorialOfficeId-val megyünk tovább.
        let compiled = null;
        if (parentPublication) {
            compiled = await getWorkflowForPublication(
                databases, databaseId, workflowsCollectionId, parentPublication, log
            );
        } else if (freshDoc.editorialOfficeId) {
            compiled = await getWorkflowForPublication(
                databases, databaseId, workflowsCollectionId,
                { editorialOfficeId: freshDoc.editorialOfficeId, workflowId: null },
                log
            );
        }

        const currentState = freshDoc.state || "";
        const previousState = freshDoc.previousState;
        const stateChanged = previousState !== null && previousState !== undefined
            && previousState !== currentState;

        // ── 5. Állapot érvényesség ──
        if (compiled) {
            const states = Array.isArray(compiled.states) ? compiled.states : [];
            const validStateIds = states.map(s => s.id);
            if (currentState && !validStateIds.includes(currentState)) {
                // Érvénytelen állapot → első állapot (order szerinti)
                const sorted = [...states].sort((a, b) => (a.order || 0) - (b.order || 0));
                const initialState = sorted.length > 0 ? sorted[0].id : "";
                corrections.state = initialState;
                log(`Érvénytelen állapot (${currentState}) → visszaállítás: ${initialState}`);
            }
        } else if (stateChanged) {
            // Nincs workflow → fail-closed: state revert
            corrections.state = previousState;
            log(`[Workflow] Nincs elérhető workflow — state revert: ${currentState} → ${previousState}`);
        }

        // ── 6. Állapotátmenet validáció ──
        if (stateChanged && !corrections.state && compiled) {
            const transitions = compiled.transitions || [];
            const isValid = transitions.some(t => t.from === previousState && t.to === currentState);

            if (!isValid) {
                corrections.state = previousState;
                log(`Érvénytelen átmenet: ${previousState} → ${currentState} → visszaállítás`);
            }
        }

        // ── 7. Office scope ellenőrzés (Fázis 1 / B.8) ──
        const userId = req.headers['x-appwrite-user-id'];

        if (userId && freshDoc.editorialOfficeId) {
            try {
                const membership = await findOfficeMembership(
                    databases, databaseId, officeMembershipsCollectionId,
                    userId, freshDoc.editorialOfficeId
                );
                if (!membership) {
                    if (stateChanged && !corrections.state) {
                        corrections.state = previousState;
                        log(`[Scope] User ${userId} nem tagja az office-nak ${freshDoc.editorialOfficeId} → state revert`);
                    } else {
                        log(`[Scope] User ${userId} nem tagja az office-nak ${freshDoc.editorialOfficeId} — non-state cross-tenant update detektálva`);
                    }
                }
            } catch (e) {
                error(`[Scope] Membership lookup hiba: ${e.message} — fail-closed, state revert`);
                if (stateChanged && !corrections.state) {
                    corrections.state = previousState;
                }
            }
        } else if (userId && !freshDoc.editorialOfficeId) {
            log(`[Scope] Legacy cikk ${freshDoc.$id} — nincs editorialOfficeId, office check kihagyva`);
        }

        // ── 8. Jogosultsági ellenőrzés (állapotváltáskor) ──
        if (stateChanged && !corrections.state && userId && compiled) {
            const statePermissions = compiled.statePermissions || {};
            const leaderGroups = compiled.leaderGroups || [];
            const requiredGroups = statePermissions[previousState] || [];

            if (requiredGroups.length > 0) {
                const userGroupSlugs = freshDoc.editorialOfficeId
                    ? await getUserGroupSlugs(databases, databaseId, groupsCollectionId, groupMembershipsCollectionId, userId, freshDoc.editorialOfficeId)
                    : [];

                if (userGroupSlugs === null) {
                    error(`Jogosultság check: getUserGroupSlugs hiba — fail-closed, state revert: userId=${userId}`);
                    corrections.state = previousState;
                } else {
                    // Vezetők mindig átléphetnek
                    const isLeader = leaderGroups.some(g => userGroupSlugs.includes(g));
                    const hasPermission = isLeader || requiredGroups.some(slug => userGroupSlugs.includes(slug));

                    if (!hasPermission) {
                        corrections.state = previousState;
                        log(`Jogosultsági hiba: felhasználó ${userId} nem mozgathatja a cikket állapotból ${previousState} (szükséges: [${requiredGroups.join(', ')}])`);
                    }
                }
            }
        }

        // ── 9. Contributors JSON validáció (log only) ──
        if (freshDoc.contributors) {
            try {
                const parsed = JSON.parse(freshDoc.contributors);
                for (const [slug, contribUserId] of Object.entries(parsed)) {
                    if (!contribUserId) continue;
                    try {
                        await usersApi.get(contribUserId);
                    } catch (e) {
                        if (e.code === 404) {
                            log(`[Contributor] contributors.${slug}=${contribUserId} — felhasználó nem létezik`);
                        }
                    }
                }
            } catch (e) {
                log(`[Contributor] contributors parse hiba: ${e.message}`);
            }
        }

        // ── 10. previousState karbantartás ──
        if (freshDoc.previousState === null || freshDoc.previousState === undefined) {
            const effectiveState = corrections.state !== undefined ? corrections.state : currentState;
            corrections.previousState = effectiveState;
            log(`previousState inicializálva: ${effectiveState}`);
        } else if (corrections.state !== undefined) {
            corrections.previousState = corrections.state;
        }

        // ── 11. Korrekciók alkalmazása ──
        if (Object.keys(corrections).length > 0) {
            corrections.modifiedByClientId = SERVER_GUARD_ID;

            await databases.updateDocument(
                databaseId, articlesCollectionId, payload.$id, corrections
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
