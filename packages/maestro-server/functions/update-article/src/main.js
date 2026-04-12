const sdk = require("node-appwrite");

/**
 * Appwrite Function: Update Article
 *
 * Pre-event szinkron endpoint cikk-update műveletekhez. A plugin a
 * `functions.createExecution()` hívásán keresztül küldi ide a változtatást;
 * a CF validál, jogosultságot ellenőriz, majd szerver API key-jel ír a DB-be.
 * Az `articles` collection `users` role-ja NEM rendelkezik direkt Update
 * joggal — ez a CF az egyetlen írási útvonal a Plugin felől.
 *
 * Ellenőrzések (sorrendben, fail-closed):
 *  1. Payload parse + alap validáció
 *  2. Auth (x-appwrite-user-id header)
 *  3. SDK init + env var validáció
 *  4. Fresh doc fetch
 *  5. Parent publication scope sync (drift → soft-fix)
 *  6. lockType enum validáció (USER / SYSTEM / null)
 *  7. Lock-only fast-path detektálás (skip: workflow + csoport check)
 *  8. Workflow betöltés (publication.workflowId alapján, fail-closed)
 *  9. Allowed state / átmenet validáció
 * 10. Office membership check — MINDIG fut (lock fast-path is)
 * 11. Jogosultsági check (állapotváltáskor és per-mező, statePermissions alapján)
 * 12. previousState karbantartás + sentinel
 * 13. DB write
 *
 * Speciális kivétel: ha a payload KIZÁRÓLAG `lockType`/`lockOwnerId` mezőket
 * tartalmaz, és a user a saját lock-ját veszi/adja vissza (a cikk nincs más
 * által zárolva), a workflow + csoport jogosultsági check-et skippeljük —
 * így az orphaned lock cleanup működik akkor is, ha a user közben elvesztette
 * a csoporttagságát. Az office membership check MINDIG fut.
 *
 * Trigger: HTTP endpoint, `execute: ["users"]`
 * Runtime: Node.js 18.0+
 *
 * Szükséges környezeti változók:
 * - DATABASE_ID
 * - ARTICLES_COLLECTION_ID
 * - PUBLICATIONS_COLLECTION_ID
 * - WORKFLOWS_COLLECTION_ID
 * - EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID
 * - GROUPS_COLLECTION_ID
 * - GROUP_MEMBERSHIPS_COLLECTION_ID
 * - APPWRITE_API_KEY (fallback, ha az x-appwrite-key header hiányzik)
 */

const SERVER_GUARD_ID = 'server-guard';

// Engedélyezett cikk-mezők. Minden más mezőt a CF elutasít — az immutable
// scope mezők (organizationId, editorialOfficeId, publicationId, stb.) nem
// írhatók ezen az útvonalon.
const ALLOWED_FIELDS = new Set([
    'state',
    'previousState',
    'name',
    'filePath',
    'startPage',
    'endPage',
    'pageRanges',
    'contributors',
    'markers',
    'lockType',
    'lockOwnerId',
    'thumbnails'
]);

// Lock-only kivételhez használt mező halmaz.
const LOCK_FIELDS = new Set(['lockType', 'lockOwnerId']);

// Érvényes lockType értékek. Bármi más → 400.
const VALID_LOCK_TYPES = new Set(['USER', 'SYSTEM', null]);

// ─── Workflow cache (process-szintű, 60s TTL, Map-alapú) ────────────────────
// Azonos minta, mint a `article-update-guard` CF-ben: egy ephemerális process
// 60 másodpercig memoizálja a compiled workflow-t, hogy a gyakori
// cikk-update burst-ök ne terheljék feleslegesen a DB-t.

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
        const firstKey = workflowCache.keys().next().value;
        if (firstKey) workflowCache.delete(firstKey);
    }
    workflowCache.set(key, { compiled, fetchedAt: Date.now() });
}

/**
 * Betölti a compiled workflow JSON-t egy publikáció számára.
 * Primary: publication.workflowId (cross-tenant védelem). Legacy fallback:
 * office első workflow-ja — csak ha a publication.workflowId explicit null.
 */
async function getWorkflowForPublication(databases, databaseId, workflowsCollectionId, parentPublication, log) {
    if (!parentPublication) return null;
    const officeId = parentPublication.editorialOfficeId;
    const workflowId = parentPublication.workflowId;

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

/**
 * Lekéri a felhasználó csoporttagságait egy adott szerkesztőségben.
 * @returns {Promise<string[]|null>} slug lista, vagy null hiba esetén
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
 * JSON válasz hibakóddal — egyszerű wrapper a `res.json` köré.
 */
function fail(res, statusCode, reason, extra = {}) {
    return res.json({ success: false, reason, ...extra }, statusCode);
}

/**
 * Jogosultság-megtagadás válasz (403) strukturált payloaddal, amit a kliens
 * `PermissionDeniedError`-ba tud mappelni.
 */
function permissionDenied(res, reason, requiredGroups = []) {
    return res.json({
        success: false,
        permissionDenied: true,
        reason,
        requiredGroups
    }, 403);
}

module.exports = async function ({ req, res, log, error }) {
    try {
        // ── 1. Payload parse + alap validáció ──
        let payload = {};
        if (req.body) {
            try {
                payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            } catch (e) {
                error(`Payload parse hiba: ${e.message}`);
                return fail(res, 400, 'invalid_payload');
            }
        }

        const articleId = payload.articleId;
        const data = payload.data;

        if (!articleId || typeof articleId !== 'string') {
            return fail(res, 400, 'missing_article_id');
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return fail(res, 400, 'missing_data');
        }

        // Whitelist: ismeretlen mezők → 400.
        const dataKeys = Object.keys(data);
        if (dataKeys.length === 0) {
            return fail(res, 400, 'empty_data');
        }
        const disallowed = dataKeys.filter(k => !ALLOWED_FIELDS.has(k));
        if (disallowed.length > 0) {
            return fail(res, 400, 'disallowed_fields', { fields: disallowed });
        }

        // ── 2. Auth ──
        const userId = req.headers['x-appwrite-user-id'];
        if (!userId) {
            return fail(res, 401, 'unauthenticated');
        }

        // ── 3. SDK init ──
        const apiKey = req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY || '';
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(apiKey);

        const databases = new sdk.Databases(client);

        const databaseId = process.env.DATABASE_ID;
        const articlesCollectionId = process.env.ARTICLES_COLLECTION_ID;
        const publicationsCollectionId = process.env.PUBLICATIONS_COLLECTION_ID;
        const workflowsCollectionId = process.env.WORKFLOWS_COLLECTION_ID;
        const officeMembershipsCollectionId = process.env.EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID;
        const groupsCollectionId = process.env.GROUPS_COLLECTION_ID;
        const groupMembershipsCollectionId = process.env.GROUP_MEMBERSHIPS_COLLECTION_ID;

        const missingEnvVars = [];
        if (!databaseId) missingEnvVars.push('DATABASE_ID');
        if (!articlesCollectionId) missingEnvVars.push('ARTICLES_COLLECTION_ID');
        if (!publicationsCollectionId) missingEnvVars.push('PUBLICATIONS_COLLECTION_ID');
        if (!workflowsCollectionId) missingEnvVars.push('WORKFLOWS_COLLECTION_ID');
        if (!officeMembershipsCollectionId) missingEnvVars.push('EDITORIAL_OFFICE_MEMBERSHIPS_COLLECTION_ID');
        if (!groupsCollectionId) missingEnvVars.push('GROUPS_COLLECTION_ID');
        if (!groupMembershipsCollectionId) missingEnvVars.push('GROUP_MEMBERSHIPS_COLLECTION_ID');
        if (!apiKey) missingEnvVars.push('APPWRITE_API_KEY (vagy x-appwrite-key header)');
        if (missingEnvVars.length > 0) {
            error(`[Config] Hiányzó környezeti változók: ${missingEnvVars.join(', ')}`);
            return fail(res, 500, 'misconfigured', { missing: missingEnvVars });
        }

        // ── 4. Fresh doc fetch ──
        let freshDoc;
        try {
            freshDoc = await databases.getDocument(databaseId, articlesCollectionId, articleId);
        } catch (e) {
            if (e.code === 404) {
                return fail(res, 404, 'article_not_found');
            }
            throw e;
        }

        // ── 5. Parent publication scope check + soft-fix ──
        let parentPublication = null;
        if (freshDoc.publicationId) {
            try {
                parentPublication = await databases.getDocument(
                    databaseId, publicationsCollectionId, freshDoc.publicationId
                );
            } catch (e) {
                if (e.code !== 404) throw e;
                log(`[Scope] Parent publication ${freshDoc.publicationId} nem található (${freshDoc.$id})`);
            }
        }

        const scopeFix = {};
        if (parentPublication && parentPublication.editorialOfficeId) {
            if (parentPublication.editorialOfficeId !== freshDoc.editorialOfficeId) {
                scopeFix.editorialOfficeId = parentPublication.editorialOfficeId;
                log(`[Scope] Cikk editorialOfficeId drift → sync a parent-hez`);
                freshDoc.editorialOfficeId = parentPublication.editorialOfficeId;
            }
            if (parentPublication.organizationId
                && parentPublication.organizationId !== freshDoc.organizationId) {
                scopeFix.organizationId = parentPublication.organizationId;
                log(`[Scope] Cikk organizationId drift → sync a parent-hez`);
                freshDoc.organizationId = parentPublication.organizationId;
            }
        }

        // ── 6. lockType enum validáció ──
        if (data.lockType !== undefined && !VALID_LOCK_TYPES.has(data.lockType)) {
            return fail(res, 400, 'invalid_lock_type', { lockType: data.lockType });
        }

        // ── 7. Lock-only fast-path detektálás ──
        // A workflow/csoport jogosultsági check-et skippeljük, DE az office
        // membership check-et megtartjuk (ld. 10. lépés) — így cross-office
        // lock-lopás nem lehetséges.
        const isLockOnlyPayload = dataKeys.every(k => LOCK_FIELDS.has(k));
        let skipPermissionCheck = false;
        if (isLockOnlyPayload) {
            // Saját lock felvétele: a cikk jelenleg NINCS zárolva (vagy már a
            // mi lockunk), és a kért lockOwnerId a mi userId-nk.
            const settingOwnLock = data.lockOwnerId === userId
                && (freshDoc.lockOwnerId === null || freshDoc.lockOwnerId === userId);
            // Saját lock elengedése: a cikk jelenleg a mi lockunk.
            const releasingOwnLock =
                (data.lockType === null || data.lockOwnerId === null)
                && freshDoc.lockOwnerId === userId;
            if (settingOwnLock || releasingOwnLock) {
                skipPermissionCheck = true;
                log(`[Lock] Lock-only kivétel: user ${userId} a saját lock-ját módosítja`);
            }
        }

        // ── 8. Workflow betöltés (fail-closed) ──
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

        if (!compiled && !skipPermissionCheck) {
            return permissionDenied(res, 'A kiadványhoz nem tartozik elérhető workflow.');
        }

        // ── 9. State érvényesség + átmenet validáció ──
        const currentState = freshDoc.state || '';
        const requestedState = data.state;
        const stateChanged = requestedState !== undefined && requestedState !== currentState;

        if (stateChanged && compiled) {
            const states = Array.isArray(compiled.states) ? compiled.states : [];
            const validStateIds = states.map(s => s.id);
            if (!validStateIds.includes(requestedState)) {
                return fail(res, 400, 'invalid_state', { state: requestedState });
            }
            const transitions = compiled.transitions || [];
            const transitionExists = transitions.some(
                t => t.from === currentState && t.to === requestedState
            );
            if (!transitionExists) {
                return fail(res, 400, 'invalid_transition', {
                    from: currentState,
                    to: requestedState
                });
            }
        }

        // ── 10. Office membership check ──
        // MINDIG fut — a lock fast-path is igényli, hogy a user a cikk
        // szerkesztőségének tagja legyen (cross-office lock-lopás megelőzése).
        if (freshDoc.editorialOfficeId) {
            let membership;
            try {
                membership = await findOfficeMembership(
                    databases, databaseId, officeMembershipsCollectionId,
                    userId, freshDoc.editorialOfficeId
                );
            } catch (e) {
                error(`[Scope] Membership lookup hiba: ${e.message} — fail-closed`);
                return permissionDenied(res, 'Szerkesztőség-tagság ellenőrzése sikertelen.');
            }
            if (!membership) {
                log(`[Scope] User ${userId} nem tagja az office-nak ${freshDoc.editorialOfficeId}`);
                return permissionDenied(res, 'Nem vagy tagja a cikk szerkesztőségének.');
            }
        }

        // ── 11. Jogosultsági check (csoporttagság + statePermissions) ──
        if (!skipPermissionCheck && compiled) {
            const statePermissions = compiled.statePermissions || {};
            const leaderGroups = compiled.leaderGroups || [];

            const userGroupSlugs = freshDoc.editorialOfficeId
                ? await getUserGroupSlugs(
                    databases, databaseId, groupsCollectionId, groupMembershipsCollectionId,
                    userId, freshDoc.editorialOfficeId
                )
                : [];

            if (userGroupSlugs === null) {
                error(`Jogosultság check: getUserGroupSlugs hiba — fail-closed, userId=${userId}`);
                return permissionDenied(res, 'Csoporttagság ellenőrzése sikertelen.');
            }

            const isLeader = leaderGroups.some(g => userGroupSlugs.includes(g));

            if (!isLeader) {
                // A jelenlegi állapot szerkesztési jogosultsága — ki érhet a cikkhez
                // ebben az állapotban egyáltalán.
                const currentStateAllowed = statePermissions[currentState] || [];
                const hasCurrentAccess = currentStateAllowed.some(slug => userGroupSlugs.includes(slug));
                if (!hasCurrentAccess) {
                    log(`Jogosultsági hiba: user ${userId} nem szerkesztheti a cikket állapotban "${currentState}" (szükséges: [${currentStateAllowed.join(', ')}])`);
                    return permissionDenied(
                        res,
                        'Nincs jogosultságod a cikk módosításához az aktuális állapotban.',
                        currentStateAllowed
                    );
                }

                // Ha az állapot változik, a CÉL-állapot (destination) mozgatási
                // jogosultságát is ellenőrizzük — a korábbi guard ugyanezt
                // a `from` állapot alapján dönti el, de a plugin kliense
                // (`canUserMoveArticle`) is így működik: ki nyithatja meg
                // a célállapotot.
                if (stateChanged) {
                    const destStateAllowed = statePermissions[requestedState] || [];
                    if (destStateAllowed.length > 0) {
                        const hasDestAccess = destStateAllowed.some(slug => userGroupSlugs.includes(slug));
                        if (!hasDestAccess) {
                            log(`Jogosultsági hiba: user ${userId} nem mozgathatja a cikket állapotba "${requestedState}"`);
                            return permissionDenied(
                                res,
                                'Nincs jogosultságod a cikket ebbe az állapotba mozgatni.',
                                destStateAllowed
                            );
                        }
                    }
                }
            }
        }

        // ── 12. previousState karbantartás ──
        // Ha az állapot változik és a hívó nem küldte explicit módon a
        // previousState mezőt, automatikusan a jelenlegi állapotot rögzítjük.
        const writePayload = { ...data, ...scopeFix };
        if (stateChanged && writePayload.previousState === undefined) {
            writePayload.previousState = currentState;
        }

        // Sentinel — a legacy `article-update-guard` CF ezen a mezőn alapján
        // szűri a saját, már validált írásait.
        writePayload.modifiedByClientId = SERVER_GUARD_ID;

        // ── 13. DB write ──
        let updated;
        try {
            updated = await databases.updateDocument(
                databaseId, articlesCollectionId, articleId, writePayload
            );
        } catch (e) {
            error(`[DB] updateDocument hiba: ${e.message}`);
            if (e.code === 404) {
                return fail(res, 404, 'article_not_found');
            }
            return fail(res, 500, 'db_write_failed', { message: e.message });
        }

        return res.json({
            success: true,
            action: 'applied',
            document: updated
        });

    } catch (err) {
        error(`Function hiba: ${err.message}`);
        error(`Stack: ${err.stack}`);
        return res.json({ success: false, reason: 'internal_error', message: err.message }, 500);
    }
};
