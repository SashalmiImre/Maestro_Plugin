/**
 * Maestro Dashboard — Data Context
 *
 * Központi adat állapot: kiadványok, cikkek, layoutok, határidők, validációk,
 * workflow-k (3-way visibility + derived compiled). Appwrite REST lekérés +
 * megosztott Realtime bus (`contexts/realtimeBus.js`) — minden fogyasztó
 * ezen keresztül iratkozik fel.
 *
 * A `$updatedAt` elavulás-védelem (`isStaleUpdate`) és a workflow Realtime
 * ág (`applyWorkflowEvent`) modul-scope helperekből dolgozik — a handler
 * branch-ek így 1:1-ben követik a többi ág (article/layout/deadline/validation)
 * struktúráját, és a 3-way visibility logikát a közös
 * `utils/workflowVisibility.js` helper szolgáltatja.
 *
 * A Provider-szintű `databases` / `storage` példányokat a context value
 * exportálja — a fogyasztók ezt vegyék át, NE képezzenek saját
 * `new Databases(getClient())` instance-t.
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { Databases, Storage, Query, ID } from 'appwrite';
import { getClient } from './AuthContext.jsx';
import { subscribeRealtime, collectionChannel } from './realtimeBus.js';
import { useScope } from './ScopeContext.jsx';
import {
    DATABASE_ID, COLLECTIONS,
    PAGE_SIZE, TEAM_CACHE_DURATION_MS
} from '../config.js';
import {
    buildWorkflowVisibilityQueries,
    isWorkflowInScope
} from '../utils/workflowVisibility.js';

const DataContext = createContext(null);

export function useData() {
    return useContext(DataContext);
}

export function DataProvider({ children }) {
    const { activeOrganizationId, activeEditorialOfficeId } = useScope();

    const [publications, setPublications] = useState([]);
    const [articles, setArticles] = useState([]);
    const [layouts, setLayouts] = useState([]);
    const [deadlines, setDeadlines] = useState([]);
    const [validations, setValidations] = useState([]);
    const [workflows, setWorkflows] = useState([]);
    // Archivált workflow-k külön lista — a WorkflowLibraryPanel „Archivált" fülének
    // forrása. Scope-váltáskor előre letöltjük, hogy a tab-címke `(N)` számláló
    // azonnal látsszon, ne csak tab-kattintáskor. Realtime karbantartott.
    const [archivedWorkflows, setArchivedWorkflows] = useState([]);
    const [archivedWorkflowsError, setArchivedWorkflowsError] = useState('');
    // Loading flag-ek mindkét workflow-listára (L-104): scope-váltáskor az eager
    // fetch ablaka alatt a WorkflowLibraryPanel a fetch-et jelzi az üres-állapot
    // helyett („Nincs workflow." flicker elkerülése). Initial `true`: mount-kor
    // még nem tudjuk, van-e scope — az első `useEffect` fetch vagy scope-null
    // guard állítja `false`-ra.
    const [workflowsLoading, setWorkflowsLoading] = useState(true);
    const [archivedWorkflowsLoading, setArchivedWorkflowsLoading] = useState(true);
    const [activePublicationId, setActivePublicationIdState] = useState(null);
    const [isLoading, setIsLoading] = useState(false);

    // Ref-ek a Realtime handler és a write-through metódusok számára (stabil referencia)
    const activePublicationIdRef = useRef(null);
    // Az aktuális kiadvány article $id-jainak Set-je — validáció Realtime szűréshez
    const articleIdsRef = useRef(new Set());
    // Workflow legutóbb látott $updatedAt-ja `id` szerint (union mindkét listából).
    // Out-of-order Realtime események esetén (pl. stale archive egy newer restore
    // UTÁN) védi a cross-list upsert-et: az `isStaleUpdate` önmagában csak a target
    // listában véd, de ha a newer verzió a MÁSIK listában ül, a target listbe
    // stale payload INSERT-je duplikátumot hozna létre. A globális ref alapján
    // eldobjuk a globálisan elavult eseményt még mielőtt listákat mozgatnánk.
    // Scope-váltáskor NEM ürítjük: a $updatedAt per-doc monoton, egy visszatérő
    // scope ugyanazt a baseline-t látja; a `fetchWorkflow` / `fetchArchivedWorkflows`
    // `seedWorkflowVersions` (>= semantika) az új scope doc-jaira felülírja a régit.
    // A `seedWorkflowVersions` `union` jellege miatt a két fetch race-mentesen
    // képzi a teljes baseline-t — egymás seedjét nem törlik.
    const workflowLatestUpdatedAtRef = useRef(new Map());
    // Archivált fetch generáció-számláló — A→B→A gyors váltásnál az első A-hívás
    // késlekedő válasza ne írja felül a második A-hívás eredményét. Minden call
    // bumpolja; closure-ben capture-öljük a saját gen-t, await után ha már nem
    // egyezik az aktuális gen-nel → eldobjuk a választ.
    const archivedFetchGenRef = useRef(0);
    // Aktív workflow fetch generáció-számláló — CSAK a `workflowsLoading` flag
    // A→B→A race védelmére (a régebbi fetch finally-je ne oltsa ki a frissebb
    // fetch loading-ját). A `setWorkflows` list-override maga NEM gen-védett:
    // az L-103 task (pre-existing race, kis valószínűségű) halasztva — ha egyszer
    // elővesszük, ugyanezt a gen-refet post-await ellenőrzéssel bővíteni kell.
    const fetchWorkflowGenRef = useRef(0);

    // Scope refek — a create metódusok olvassák, hogy callback closure-ök nélkül mindig
    // a legfrissebb aktív organization/office ID-ra injektáljanak scope mezőket.
    // useLayoutEffect: commit fázisban, még MIELŐTT a gyerek komponensek useEffect-jei
    // futnának. A DashboardLayout scope-effect-je ugyanis hamarabb fut a fa miatt
    // (child-first), és ref-ből olvassa a fetchPublications-t → ha useEffect-tel
    // szinkronizálnánk, stale office-szal fetchelne (A→B→A esetben A-n is üres lenne).
    const activeOrganizationIdRef = useRef(activeOrganizationId);
    const activeEditorialOfficeIdRef = useRef(activeEditorialOfficeId);
    useLayoutEffect(() => { activeOrganizationIdRef.current = activeOrganizationId; }, [activeOrganizationId]);
    useLayoutEffect(() => { activeEditorialOfficeIdRef.current = activeEditorialOfficeId; }, [activeEditorialOfficeId]);

    // Appwrite szolgáltatások
    const servicesRef = useRef(null);
    if (!servicesRef.current) {
        const client = getClient();
        servicesRef.current = {
            databases: new Databases(client),
            storage: new Storage(client)
        };
    }
    const { databases, storage } = servicesRef.current;

    // Csapattag cache — officeId-hez kötött, hogy scope váltáskor ne térítsen vissza
    // az előző szerkesztőség tagjaival (stale cross-office név).
    const memberCacheRef = useRef({ map: new Map(), officeId: null, time: 0 });

    // ─── Kiadványok lekérése ────────────────────────────────────────────────

    const fetchPublications = useCallback(async () => {
        const editorialOfficeId = activeEditorialOfficeIdRef.current;
        if (!editorialOfficeId) {
            setPublications([]);
            return [];
        }

        const allDocuments = [];
        let offset = 0;

        while (true) {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.PUBLICATIONS,
                queries: [
                    Query.equal('editorialOfficeId', editorialOfficeId),
                    Query.limit(PAGE_SIZE),
                    Query.offset(offset),
                    Query.orderAsc('name')
                ]
            });
            allDocuments.push(...result.documents);
            if (result.documents.length < PAGE_SIZE) break;
            offset += PAGE_SIZE;
        }

        setPublications(allDocuments);
        return allDocuments;
    }, [databases]);

    // ─── Kiadvány váltás ────────────────────────────────────────────────────

    const switchPublication = useCallback(async (publicationId) => {
        activePublicationIdRef.current = publicationId;
        setActivePublicationIdState(publicationId);

        // null = nincs aktív kiadvány (pl. üres scope) → derived state törlése
        if (!publicationId) {
            setArticles([]);
            setLayouts([]);
            setDeadlines([]);
            setValidations([]);
            articleIdsRef.current = new Set();
            setIsLoading(false);
            return;
        }

        setLayouts([]);
        setIsLoading(true);

        try {
            // 1. fázis: cikkek, layoutok, határidők párhuzamosan
            const [articlesResult, layoutsResult, deadlinesResult] = await Promise.all([
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.ARTICLES,
                    queries: [
                        Query.equal('publicationId', publicationId),
                        Query.limit(1000),
                        Query.orderAsc('startPage')
                    ]
                }).catch(() => ({ documents: [] })),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.LAYOUTS,
                    queries: [
                        Query.equal('publicationId', publicationId),
                        Query.limit(100),
                        Query.orderAsc('order')
                    ]
                }).catch(() => ({ documents: [] })),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.DEADLINES,
                    queries: [
                        Query.equal('publicationId', publicationId),
                        Query.limit(100)
                    ]
                }).catch(() => ({ documents: [] }))
            ]);

            setArticles(articlesResult.documents);
            setLayouts(layoutsResult.documents);
            setDeadlines(deadlinesResult.documents);

            // 2. fázis: validációk articleId alapján (plugin DataContext mintájára)
            const articleIds = articlesResult.documents.map(a => a.$id);
            // articleIdsRef szinkronizálása — Realtime szűréshez
            articleIdsRef.current = new Set(articleIds);
            let allValidations = [];

            try {
                if (articleIds.length > 0) {
                    const CHUNK_SIZE = 100;
                    const chunks = [];
                    for (let i = 0; i < articleIds.length; i += CHUNK_SIZE) {
                        chunks.push(articleIds.slice(i, i + CHUNK_SIZE));
                    }

                    // Mindkét validáció kollekció lekérése párhuzamosan, kötegelt articleId lekérdezéssel
                    const [userValResults, sysValResults] = await Promise.all([
                        Promise.all(chunks.map(ids =>
                            databases.listDocuments({
                                databaseId: DATABASE_ID,
                                collectionId: COLLECTIONS.USER_VALIDATIONS,
                                queries: [
                                    Query.equal('articleId', ids),
                                    Query.limit(Math.min(5000, ids.length * 10))
                                ]
                            }).catch(() => ({ documents: [] }))
                        )),
                        Promise.all(chunks.map(ids =>
                            databases.listDocuments({
                                databaseId: DATABASE_ID,
                                collectionId: COLLECTIONS.SYSTEM_VALIDATIONS,
                                queries: [
                                    Query.equal('articleId', ids),
                                    Query.limit(Math.min(5000, ids.length * 5))
                                ]
                            }).catch(() => ({ documents: [] }))
                        ))
                    ]);

                    const userValidationDocs = userValResults.flatMap(r => r.documents);
                    const sysValidationDocs = sysValResults.flatMap(r => r.documents);
                    const flatSysValidations = sysValidationDocs.flatMap(flattenSystemValidationRecord);
                    allValidations = [...flatSysValidations, ...userValidationDocs];
                }
            } catch {
                // Hálózati hiba esetén üres validáció-lista (stale adat elkerülése)
                allValidations = [];
            }

            setValidations(allValidations);
        } finally {
            setIsLoading(false);
        }
    }, [databases]);

    // ─── Csoporttag feloldás ────────────────────────────────────────────────

    const fetchAllGroupMembers = useCallback(async () => {
        const editorialOfficeId = activeEditorialOfficeIdRef.current;
        if (!editorialOfficeId) return new Map();

        const cache = memberCacheRef.current;
        const now = Date.now();
        if (cache.officeId === editorialOfficeId && cache.map.size > 0 && (now - cache.time) < TEAM_CACHE_DURATION_MS) {
            return cache.map;
        }

        try {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
                queries: [
                    Query.equal('editorialOfficeId', editorialOfficeId),
                    Query.limit(500)
                ]
            });

            const map = new Map();
            for (const m of result.documents) {
                if (!map.has(m.userId)) {
                    map.set(m.userId, m.userName || '');
                }
            }

            memberCacheRef.current = { map, officeId: editorialOfficeId, time: now };
            return map;
        } catch {
            return new Map();
        }
    }, [databases]);

    const getMemberName = useCallback((userId) => {
        // Office-váltás után a cache frissítéséig a régi office nevei stale-ek — officeId guard
        const cache = memberCacheRef.current;
        if (cache.officeId !== activeEditorialOfficeIdRef.current) return null;
        return cache.map.get(userId) || null;
    }, []);

    // ─── Workflow lekérés ────────────────────────────────────────────────────
    //
    // A `workflows[]` (plural) az összes workflow doc az aktív szerkesztőségben —
    // a publication CreateModal / SettingsModal workflow-dropdownja olvassa.
    // A `workflow` (singular) származtatott state: az aktív kiadvány `workflowId`-ja
    // szerint kiválasztott workflow compiled JSON-ja. Ha nincs aktív kiadvány vagy
    // nincs workflowId, az első (név szerint rendezett) workflow a fallback. Ezt a
    // filterek / jogosultsági hookok / Workflow Designer használják.

    // 3-way visibility fetch (#80): a közös `buildWorkflowVisibilityQueries`
    // helper építi a Query.or ágat — `WorkflowLibraryPanel.runArchivedQuery`
    // ugyanezt a helpert használja `archived: true`-val. Az `archivedAt IS NULL`
    // szűrés itt az aktív nézetet tartja — a soft-delete-ek a Library külön fülén.
    //
    // L-103 halasztva (2026-04-22): a `fetchArchivedWorkflows` kapott
    // `isScopeStale()` + `archivedFetchGenRef` race-védelmet a #98 harden során,
    // itt a `setWorkflows` list-override még „first-fetch wins" — A→B rapid
    // scope-váltásnál egy késlekedő A-response felülírhatja a B `workflows`
    // state-jét. Pre-existing alacsony kockázat, nincs user-riport. Ha egyszer
    // elővesszük: a lenti `fetchWorkflowGenRef`-et post-await ellenőrzéssel
    // bővíteni kell (`gen !== fetchWorkflowGenRef.current → return` a
    // `setWorkflows` ELŐTT), a #98 scope-key + gen-kombót NE másoljuk (redundáns).
    // A gen-ref a loading flag A→B→A race miatt MÁR bevezetett (L-104).
    const fetchWorkflow = useCallback(async () => {
        const gen = ++fetchWorkflowGenRef.current;
        const editorialOfficeId = activeEditorialOfficeIdRef.current;
        const organizationId = activeOrganizationIdRef.current;
        if (!editorialOfficeId || !organizationId) {
            setWorkflows([]);
            setWorkflowsLoading(false);
            return;
        }

        setWorkflowsLoading(true);
        try {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.WORKFLOWS,
                queries: [
                    ...buildWorkflowVisibilityQueries({ organizationId, editorialOfficeId }),
                    Query.orderAsc('name'),
                    Query.limit(100)
                ]
            });

            setWorkflows(result.documents);
            seedWorkflowVersions(workflowLatestUpdatedAtRef.current, result.documents);
        } catch (err) {
            console.error('[DataContext] Workflow fetch hiba:', err);
        } finally {
            // Stale-guard: A→B→A váltásnál egy régebbi fetch finally-je ne
            // oltsa ki a frissebb fetch által `true`-ra állított loading-ot.
            // A `setWorkflows` list-override MAGA nem gen-védett (L-103 halasztva).
            if (fetchWorkflowGenRef.current === gen) {
                setWorkflowsLoading(false);
            }
        }
    }, [databases]);

    // Workflow(k) betöltése induláskor, és scope-váltáskor újra (org + office).
    useEffect(() => {
        fetchWorkflow();
    }, [fetchWorkflow, activeEditorialOfficeId, activeOrganizationId]);

    // Archivált workflow-k eager fetch — scope-váltáskor előre letölti, hogy a
    // WorkflowLibraryPanel „Archivált (N)" fül címke azonnal látható legyen.
    // Schema-miss (legacy env, `archivedAt` attribútum hiányzik) nem triggerel
    // bootstrap-ot: a schema migráció admin művelet, amit a dashboard-navigáció
    // nem indíthat implicit módon (adversarial flag). A user-facing hibaüzenet
    // az Archivált fülön megjelenik — owner-ként manuálisan fut a CF action.
    const fetchArchivedWorkflows = useCallback(async () => {
        const gen = ++archivedFetchGenRef.current;
        const editorialOfficeId = activeEditorialOfficeIdRef.current;
        const organizationId = activeOrganizationIdRef.current;
        if (!editorialOfficeId || !organizationId) {
            setArchivedWorkflows([]);
            setArchivedWorkflowsError('');
            setArchivedWorkflowsLoading(false);
            return;
        }

        // Stale lista törlése scope-váltáskor — ha a fetch hibával zárul, ne
        // maradjon az előző scope archivált listája a UI-on. A loading flag
        // eközben elfedi a Panel-en az üres-állapotot, így nincs
        // `Nincs archivált workflow.` flicker.
        setArchivedWorkflows([]);
        setArchivedWorkflowsError('');
        setArchivedWorkflowsLoading(true);

        // Scope-race + generáció-védelem: A→B→A gyors scope-váltásnál (ugyanaz a
        // scope-key, de új fetch-generáció) a régebbi fetch eredménye ne írja
        // felül az újét. A generáció-check a ref-egyezést is redundánsan biztosítja.
        const isStale = () =>
            archivedFetchGenRef.current !== gen ||
            activeEditorialOfficeIdRef.current !== editorialOfficeId ||
            activeOrganizationIdRef.current !== organizationId;

        try {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.WORKFLOWS,
                queries: [
                    ...buildWorkflowVisibilityQueries({ organizationId, editorialOfficeId, archived: true }),
                    Query.orderDesc('archivedAt'),
                    Query.limit(100)
                ]
            });
            if (isStale()) return;
            // Fetch-vs-Realtime stale-védelem: ha mid-flight Realtime közben egy
            // archivált workflow-t restore-oltak (versionsMap[$id] = T_restore),
            // a REST snapshot régebbi $updatedAt-tal ne írja vissza az archivált
            // tabra. A REST-absence NEM dönthető el mid-flight addition-nek vs.
            // visibility-shrinkage-nek (trust-boundary) — ezért a REST snapshot
            // az authoritatív a scope-ra, mid-flight Realtime additions esetleg
            // elveszhetnek a következő eventig (alacsony valószínűségű UX cost,
            // cserébe nem leakelünk out-of-scope prev item-et).
            const versionsMap = workflowLatestUpdatedAtRef.current;
            setArchivedWorkflows(result.documents.filter(d => {
                const lastSeen = versionsMap.get(d.$id);
                return !lastSeen || !d.$updatedAt || d.$updatedAt >= lastSeen;
            }));
            seedWorkflowVersions(versionsMap, result.documents);
        } catch (err) {
            if (isStale()) return;
            const msg = err?.message || '';
            const isSchemaMiss = msg.includes('archivedAt') &&
                (msg.includes('not found in schema') || msg.includes('Attribute not found'));
            if (isSchemaMiss) {
                setArchivedWorkflowsError('Az archiválási funkció még nincs aktiválva ebben a környezetben. Kérd meg a szervezet owner-ét, hogy futtassa a workflow schema bootstrap-ot.');
            } else {
                console.error('[DataContext] Archivált workflow fetch hiba:', err);
                setArchivedWorkflowsError('Archivált workflow-k lekérése sikertelen.');
            }
        } finally {
            // Stale-guard: ha A→B→A közben egy frissebb fetch már `true`-ra
            // állította a loading-ot, a régebbi fetch finally-je ne oltsa ki.
            if (archivedFetchGenRef.current === gen) {
                setArchivedWorkflowsLoading(false);
            }
        }
    }, [databases]);

    useEffect(() => {
        fetchArchivedWorkflows();
    }, [fetchArchivedWorkflows, activeEditorialOfficeId, activeOrganizationId]);

    // Opt-in, nem cache-elt lekérdezés a szervezet workflow-jaira (minden office,
    // minden visibility, archivált is) — megkerüli a `workflows[]` scope-szűrést,
    // hogy multi-office admin cross-office `editorial_office` scope-okat is lásson
    // klón forrásként. Az Appwrite rowSecurity szűri az olvasási jogot. Archivált
    // szűrést a hívó kell alkalmazzon, ha relevánsak.
    const fetchAllOrgWorkflows = useCallback(async (orgId) => {
        const targetOrgId = orgId || activeOrganizationIdRef.current;
        if (!targetOrgId) return [];
        try {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.WORKFLOWS,
                queries: [
                    Query.equal('organizationId', targetOrgId),
                    Query.limit(100)
                ]
            });
            return [...result.documents].sort(
                (a, b) => (a.name || '').localeCompare(b.name || '', 'hu')
            );
        } catch (err) {
            console.warn('[DataContext] fetchAllOrgWorkflows hiba:', err);
            return [];
        }
    }, [databases]);

    // Származtatott workflow: az aktív kiadvány `workflowId`-ja szerint.
    // Ha a publikációnak van workflowId-ja, de a referencia stale (a workflow
    // már nem létezik a listában) → null (fail-closed, a szerver policy egyezik).
    // Ha nincs workflowId (legacy rekord vagy nincs aktív kiadvány) → az első
    // (név szerint rendezett) workflow a fallback.
    const workflow = useMemo(() => {
        if (workflows.length === 0) return null;

        const activePub = activePublicationId
            ? publications.find((p) => p.$id === activePublicationId)
            : null;
        const targetId = activePub?.workflowId;

        let targetDoc;
        if (targetId) {
            targetDoc = workflows.find((w) => w.$id === targetId) || null;
        } else {
            targetDoc = workflows[0];
        }

        if (!targetDoc) return null;

        try {
            return typeof targetDoc.compiled === 'string'
                ? JSON.parse(targetDoc.compiled)
                : targetDoc.compiled;
        } catch (err) {
            console.error('[DataContext] Workflow compiled parse hiba:', err);
            return null;
        }
    }, [workflows, publications, activePublicationId]);

    // ─── Write-through metódusok ────────────────────────────────────────────
    //
    // A Dashboard szerkesztőfelületek (CreatePublicationModal, PublicationSettingsModal)
    // ezeken keresztül írnak az Appwrite DB-be. A scope mezők (`organizationId`,
    // `editorialOfficeId`) automatikusan injektálódnak a `withScope()` helper-rel.
    // A Realtime $updatedAt guard az optimista update-et védi a régi payload ellen.

    const withScope = useCallback((data) => {
        const officeId = activeEditorialOfficeIdRef.current;
        const orgId = activeOrganizationIdRef.current;
        if (!officeId || !orgId) {
            throw new Error('Nincs aktív szerkesztőség — a művelet nem hajtható végre.');
        }
        return { ...data, organizationId: orgId, editorialOfficeId: officeId };
    }, []);

    // Publications

    const createPublication = useCallback(async (data) => {
        const doc = await databases.createDocument({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.PUBLICATIONS,
            documentId: ID.unique(),
            data: withScope(data)
        });
        setPublications((prev) => {
            if (prev.some((p) => p.$id === doc.$id)) return prev;
            return [...prev, doc].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        });
        // Frissen létrehozott kiadvány legyen az aktív — így a modal zárása
        // után azonnal a szerkesztő felületre kerül a user, és a modalból
        // utólag létrehozott default layout is az aktív pub-hoz kerül be.
        await switchPublication(doc.$id);
        return doc;
    }, [databases, withScope, switchPublication]);

    const updatePublication = useCallback(async (id, data) => {
        const doc = await databases.updateDocument({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.PUBLICATIONS,
            documentId: id,
            data
        });
        setPublications((prev) => prev.map((p) => (p.$id === id ? doc : p)));
        return doc;
    }, [databases]);

    const deletePublication = useCallback(async (id) => {
        await databases.deleteDocument({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.PUBLICATIONS,
            documentId: id
        });
        setPublications((prev) => prev.filter((p) => p.$id !== id));
        // Ha a törölt publikáció az aktív, a derived state-et és az aktív
        // ID-t is törölni kell — a Realtime handler ugyanezt végzi delete
        // event-re, de Realtime disconnect alatt nem érkezne meg az event,
        // így a UI árva doc-on ragadna. A direkt CRUD úton is szinkron
        // tisztázzuk ugyanazt a state-et.
        if (id === activePublicationIdRef.current) {
            activePublicationIdRef.current = null;
            setActivePublicationIdState(null);
            setArticles([]);
            setLayouts([]);
            setDeadlines([]);
            setValidations([]);
            articleIdsRef.current = new Set();
        }
    }, [databases]);

    // Layouts

    const createLayout = useCallback(async (data) => {
        const doc = await databases.createDocument({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.LAYOUTS,
            documentId: ID.unique(),
            data: withScope(data)
        });
        // Csak akkor rakjuk be a helyi state-be, ha az aktív kiadványhoz tartozik
        if (doc.publicationId === activePublicationIdRef.current) {
            setLayouts((prev) => {
                if (prev.some((l) => l.$id === doc.$id)) return prev;
                return [...prev, doc].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            });
        }
        return doc;
    }, [databases, withScope]);

    const updateLayout = useCallback(async (id, data) => {
        const doc = await databases.updateDocument({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.LAYOUTS,
            documentId: id,
            data
        });
        setLayouts((prev) => prev.map((l) => (l.$id === id ? doc : l)));
        return doc;
    }, [databases]);

    /**
     * Layout törlés cikk-áthelyezéssel.
     * @param {string} id - A törlendő layout $id-je.
     * @param {string|null} reassignToId - A cél layout $id-je, vagy null (layoutId mező
     *     nullázása az érintett cikkeken).
     */
    const deleteLayout = useCallback(async (id, reassignToId = null) => {
        // Érintett cikkek átrendelése
        const affectedArticles = articles.filter((a) => a.layoutId === id);
        if (affectedArticles.length > 0) {
            await Promise.all(
                affectedArticles.map((a) =>
                    databases.updateDocument({
                        databaseId: DATABASE_ID,
                        collectionId: COLLECTIONS.ARTICLES,
                        documentId: a.$id,
                        data: { layoutId: reassignToId }
                    })
                )
            );
            // Lokális article state frissítése a Realtime előtt (optimista)
            setArticles((prev) =>
                prev.map((a) => (a.layoutId === id ? { ...a, layoutId: reassignToId } : a))
            );
        }

        await databases.deleteDocument({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.LAYOUTS,
            documentId: id
        });
        setLayouts((prev) => prev.filter((l) => l.$id !== id));
    }, [databases, articles]);

    // Deadlines

    const createDeadline = useCallback(async (data) => {
        const doc = await databases.createDocument({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.DEADLINES,
            documentId: ID.unique(),
            data: withScope(data)
        });
        if (doc.publicationId === activePublicationIdRef.current) {
            setDeadlines((prev) => {
                if (prev.some((d) => d.$id === doc.$id)) return prev;
                return [...prev, doc];
            });
        }
        return doc;
    }, [databases, withScope]);

    const updateDeadline = useCallback(async (id, data) => {
        const doc = await databases.updateDocument({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.DEADLINES,
            documentId: id,
            data
        });
        setDeadlines((prev) => prev.map((d) => (d.$id === id ? doc : d)));
        return doc;
    }, [databases]);

    const deleteDeadline = useCallback(async (id) => {
        await databases.deleteDocument({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.DEADLINES,
            documentId: id
        });
        setDeadlines((prev) => prev.filter((d) => d.$id !== id));
    }, [databases]);

    // Articles (csak update — create és delete a plugin felelőssége)

    const updateArticle = useCallback(async (id, data) => {
        const doc = await databases.updateDocument({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.ARTICLES,
            documentId: id,
            data
        });
        setArticles((prev) => prev.map((a) => (a.$id === id ? doc : a)));
        return doc;
    }, [databases]);

    // ─── Realtime feliratkozás ──────────────────────────────────────────────

    useEffect(() => {
        const dataChannels = [
            collectionChannel(COLLECTIONS.ARTICLES),
            collectionChannel(COLLECTIONS.PUBLICATIONS),
            collectionChannel(COLLECTIONS.LAYOUTS),
            collectionChannel(COLLECTIONS.DEADLINES),
            collectionChannel(COLLECTIONS.USER_VALIDATIONS),
            collectionChannel(COLLECTIONS.SYSTEM_VALIDATIONS),
            collectionChannel(COLLECTIONS.WORKFLOWS)
        ];
        const unsubscribe = subscribeRealtime(dataChannels, (response) => {
            const eventType = getEventType(response.events);
            if (!eventType) return;

            const collection = getCollection(response.channels);
            if (!collection) return;

            const payload = response.payload;

            try {
                switch (collection) {
                    case 'articles':
                        applyArticleEvent(eventType, payload, activePublicationIdRef, setArticles);
                        break;
                    case 'publications':
                        applyPublicationEvent(
                            eventType,
                            payload,
                            activeEditorialOfficeIdRef.current,
                            setPublications
                        );
                        // Ha a törölt publikáció éppen az aktív, a derived
                        // state-et és az aktív ID-t is törölni kell, hogy a
                        // UI ne maradjon árva doc-on ragadva. A Plugin
                        // DataContext ugyanezt a mintát követi
                        // (maestro-indesign CLAUDE.md § DataContext).
                        if (eventType === 'delete' && payload.$id === activePublicationIdRef.current) {
                            activePublicationIdRef.current = null;
                            setActivePublicationIdState(null);
                            setArticles([]);
                            setLayouts([]);
                            setDeadlines([]);
                            setValidations([]);
                            articleIdsRef.current = new Set();
                        }
                        break;
                    case 'layouts':
                        applyLayoutEvent(eventType, payload, activePublicationIdRef, setLayouts);
                        break;
                    case 'deadlines':
                        applyDeadlineEvent(eventType, payload, activePublicationIdRef, setDeadlines);
                        break;
                    case 'validations':
                        applyValidationEvent(eventType, payload, articleIdsRef, setValidations);
                        break;
                    case 'system_validations':
                        applySystemValidationEvent(eventType, payload, articleIdsRef, setValidations);
                        break;
                    case 'workflows':
                        applyWorkflowEvent(eventType, payload, {
                            organizationId: activeOrganizationIdRef.current,
                            editorialOfficeId: activeEditorialOfficeIdRef.current
                        }, setWorkflows, setArchivedWorkflows, workflowLatestUpdatedAtRef.current);
                        break;
                }
            } catch (error) {
                console.error('Realtime event handler error', {
                    eventType, collection,
                    error: error?.message || error
                });
            }
        });

        return () => unsubscribe();
    }, []);

    // Minden mező memoizált — a state-ek / useCallback-ek maguk stabilak, itt
    // a külső consumer-ek miatt biztosítunk identitás-stabilitást: a Provider
    // re-renderénél ne kapjon minden context-fogyasztó új objektumot. A
    // deps-listában minden mező szerepel, amit a value objektum közvetlenül
    // átad (state + callback + stabil singleton).
    const value = useMemo(() => ({
        publications, articles, layouts, deadlines, validations,
        workflow, workflows, workflowsLoading,
        archivedWorkflows, archivedWorkflowsError, archivedWorkflowsLoading,
        activePublicationId, isLoading,
        // Appwrite szolgáltatások — a fogyasztók ezt vegyék át, ne képezzenek
        // saját `new Databases(getClient())` instance-t (singleton per Provider).
        databases, storage,
        fetchPublications, switchPublication, fetchWorkflow,
        fetchAllOrgWorkflows,
        fetchAllGroupMembers, getMemberName,
        // Write-through API
        createPublication, updatePublication, deletePublication,
        createLayout, updateLayout, deleteLayout,
        createDeadline, updateDeadline, deleteDeadline,
        updateArticle
    }), [
        publications, articles, layouts, deadlines, validations,
        workflow, workflows, workflowsLoading,
        archivedWorkflows, archivedWorkflowsError, archivedWorkflowsLoading,
        activePublicationId, isLoading,
        databases, storage,
        fetchPublications, switchPublication, fetchWorkflow,
        fetchAllOrgWorkflows,
        fetchAllGroupMembers, getMemberName,
        createPublication, updatePublication, deletePublication,
        createLayout, updateLayout, deleteLayout,
        createDeadline, updateDeadline, deleteDeadline,
        updateArticle
    ]);

    return (
        <DataContext.Provider value={value}>
            {children}
        </DataContext.Provider>
    );
}

// ─── Realtime segédfüggvények ──────────────────────────────────────────────

/**
 * Elavulás-védelem a Realtime payload-ra: csak SZIGORÚAN régebbi timestamp-et
 * dobunk el, hogy gyors egymás utáni (ms-on belüli) írások esetén ne nyeljük
 * el a második eltérő payload-ot. Appwrite `$updatedAt` ms-pontos — a doc-szintű
 * serializálás nem garantálja, hogy két érvényes, különböző payload sose kapja
 * ugyanazt a timestamp-et (pl. DeadlinesTab blur burst).
 */
function isStaleUpdate(local, payload) {
    if (!local?.$updatedAt || !payload?.$updatedAt) return false;
    return new Date(local.$updatedAt) > new Date(payload.$updatedAt);
}

function getEventType(events) {
    for (const e of events) {
        if (e.includes('.create')) return 'create';
        if (e.includes('.update')) return 'update';
        if (e.includes('.delete')) return 'delete';
    }
    return null;
}

function getCollection(channels) {
    for (const ch of channels) {
        if (ch.includes(COLLECTIONS.ARTICLES)) return 'articles';
        if (ch.includes(COLLECTIONS.PUBLICATIONS)) return 'publications';
        if (ch.includes(COLLECTIONS.LAYOUTS)) return 'layouts';
        if (ch.includes(COLLECTIONS.DEADLINES)) return 'deadlines';
        if (ch.includes(COLLECTIONS.USER_VALIDATIONS)) return 'validations';
        if (ch.includes(COLLECTIONS.SYSTEM_VALIDATIONS)) return 'system_validations';
        if (ch.includes(COLLECTIONS.WORKFLOWS)) return 'workflows';
    }
    return null;
}

function applyArticleEvent(eventType, payload, pubIdRef, setArticles) {
    if (payload.publicationId !== pubIdRef.current) return;

    if (eventType === 'delete') {
        setArticles(prev => prev.filter(a => a.$id !== payload.$id));
    } else {
        setArticles(prev => {
            const idx = prev.findIndex(a => a.$id === payload.$id);
            if (idx >= 0) {
                if (isStaleUpdate(prev[idx], payload)) return prev;
                const next = [...prev];
                next[idx] = payload;
                return next;
            }
            return [...prev, payload];
        });
    }
}

function applyPublicationEvent(eventType, payload, activeOfficeId, setPublications) {
    if (eventType === 'delete') {
        setPublications(prev => prev.filter(p => p.$id !== payload.$id));
        return;
    }

    // Scope-szűrés: idegen office payload-ját nem vesszük fel, és ha egy
    // már listázott rekord scope-ja idegenre változott, eltávolítjuk.
    const inScope = payload.editorialOfficeId === activeOfficeId;

    setPublications(prev => {
        const idx = prev.findIndex(p => p.$id === payload.$id);
        if (!inScope) {
            return idx >= 0 ? prev.filter(p => p.$id !== payload.$id) : prev;
        }
        if (idx >= 0) {
            if (isStaleUpdate(prev[idx], payload)) return prev;
            const next = [...prev];
            next[idx] = payload;
            return next;
        }
        return [...prev, payload];
    });
}

function applyLayoutEvent(eventType, payload, pubIdRef, setLayouts) {
    if (payload.publicationId !== pubIdRef.current) return;

    if (eventType === 'delete') {
        setLayouts(prev => prev.filter(l => l.$id !== payload.$id));
    } else {
        setLayouts(prev => {
            const idx = prev.findIndex(l => l.$id === payload.$id);
            if (idx >= 0) {
                if (isStaleUpdate(prev[idx], payload)) return prev;
                const next = [...prev];
                next[idx] = payload;
                // Az `order` mező változhatott — re-sort, különben rossz sorrendben jelenik meg
                return next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            }
            return [...prev, payload].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        });
    }
}

function applyDeadlineEvent(eventType, payload, pubIdRef, setDeadlines) {
    if (payload.publicationId !== pubIdRef.current) return;

    if (eventType === 'delete') {
        setDeadlines(prev => prev.filter(d => d.$id !== payload.$id));
    } else {
        setDeadlines(prev => {
            const idx = prev.findIndex(d => d.$id === payload.$id);
            if (idx >= 0) {
                // A DeadlinesTab blur-onként külön hívja az updateDeadline-t →
                // könnyen érkezik out-of-order régebbi payload, amit az isStaleUpdate elnyel.
                if (isStaleUpdate(prev[idx], payload)) return prev;
                const next = [...prev];
                next[idx] = payload;
                return next;
            }
            return [...prev, payload];
        });
    }
}

/**
 * Workflow Realtime handler (#80 — 3-way visibility + archivedAt szűrés).
 * A `workflow` useMemo (a származtatott compiled) automatikusan recompute-ol
 * az aktív publikáció `workflowId`-ja alapján, amint a `setWorkflows` frissít.
 *
 * #98: archive/restore átmenet a `workflows` ↔ `archivedWorkflows` listák között
 * mozgat — a listákat mindkét irányban karbantartja, hogy a WorkflowLibraryPanel
 * Aktív/Archivált számláló azonnal tükrözze a változást.
 */
function removeById(setter, id) {
    setter(prev => {
        const idx = prev.findIndex(w => w.$id === id);
        return idx >= 0 ? prev.filter(w => w.$id !== id) : prev;
    });
}

// Kezdeti fetch eredményével feltöltjük a verzió-ref-et — induló stale események
// elvetéséhez szükséges baseline (máskülönben egy older event upsert-elne first ciklusban).
// Csak `$updatedAt` truthy-ra settelünk: ha valamiért hiányozna a doc-on (nem várt),
// egy későbbi stale-check `undefined < string` összehasonlítása nem védene.
function seedWorkflowVersions(versionsMap, docs) {
    for (const d of docs) {
        if (!d.$updatedAt) continue;
        const cur = versionsMap.get(d.$id);
        if (!cur || d.$updatedAt >= cur) {
            versionsMap.set(d.$id, d.$updatedAt);
        }
    }
}

function applyWorkflowEvent(eventType, payload, scope, setWorkflows, setArchivedWorkflows, versionsMap) {
    if (eventType === 'delete') {
        // 7-napos purge vagy manuális törlés — mindkét listából szűrünk (idempotens).
        // versionsMap entry törlése: a doc többé nem él, a baseline-t nem tartjuk.
        versionsMap.delete(payload.$id);
        removeById(setWorkflows, payload.$id);
        removeById(setArchivedWorkflows, payload.$id);
        return;
    }

    // Globális stale-védelem: out-of-order Realtime kézbesítés esetén (stale archive
    // event a newer restore UTÁN, vagy fordítva) a per-lista `isStaleUpdate` csak a
    // target listát védi; ha a newer verzió a másik listában ül, az upsert duplikátumot
    // hozna létre. Ezért a ref a legutóbbi látott $updatedAt-ot tartja union-szinten,
    // és globálisan elavult eseményt elvetjük, mielőtt bármit is mozgatnánk.
    const lastSeen = versionsMap.get(payload.$id);
    if (lastSeen && payload.$updatedAt && payload.$updatedAt < lastSeen) return;
    if (payload.$updatedAt) versionsMap.set(payload.$id, payload.$updatedAt);

    if (!isWorkflowInScope(payload, scope)) {
        // Scope-on kívülre csúszott (pl. visibility shrinkage más officere).
        removeById(setWorkflows, payload.$id);
        removeById(setArchivedWorkflows, payload.$id);
        return;
    }

    const isArchived = typeof payload.archivedAt === 'string' && payload.archivedAt.length > 0;

    if (isArchived) {
        // Archivált → aktív-listából törlés + upsert az archiváltba (archivedAt DESC).
        removeById(setWorkflows, payload.$id);
        setArchivedWorkflows(prev => {
            const idx = prev.findIndex(w => w.$id === payload.$id);
            if (idx >= 0) {
                if (isStaleUpdate(prev[idx], payload)) return prev;
                const next = [...prev];
                next[idx] = payload;
                return next.sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));
            }
            return [...prev, payload].sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));
        });
        return;
    }

    // Aktív → archivált-listából törlés (restore) + upsert az aktívba (name ASC).
    removeById(setArchivedWorkflows, payload.$id);
    setWorkflows(prev => {
        const idx = prev.findIndex(w => w.$id === payload.$id);
        if (idx >= 0) {
            if (isStaleUpdate(prev[idx], payload)) return prev;
            const next = [...prev];
            next[idx] = payload;
            return next.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }
        return [...prev, payload].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    });
}

function applyValidationEvent(eventType, payload, articleIdsRef, setValidations) {
    // userValidations: csak az aktív kiadvány cikkeihez tartozó eseményeket kezeljük.
    // Delete esetén $id alapján szűrünk (a cikk már törölve lehet az articleIdsRef-ből).
    if (eventType === 'delete') {
        setValidations(prev => prev.filter(v => v.$id !== payload.$id));
        return;
    }
    if (!articleIdsRef.current.has(payload.articleId)) return;
    setValidations(prev => {
        const idx = prev.findIndex(v => v.$id === payload.$id);
        if (idx >= 0) {
            const next = [...prev];
            next[idx] = payload;
            return next;
        }
        return [...prev, payload];
    });
}

/**
 * Egy `validations` (rendszer) rekordból lapos validáció-itemeket generál,
 * amelyek kompatibilisek az ArticleTable validationIndex formátumával.
 *
 * @param {Object} record - Appwrite validations rekord (errors[], warnings[], articleId, source)
 * @returns {Array} Lapos validáció-itemek tömbje
 */
function flattenSystemValidationRecord(record) {
    const errors = (record.errors || []).map((msg, i) => ({
        $id: `${record.$id}-e-${i}`,
        articleId: record.articleId,
        type: 'error',
        description: msg,
        source: record.source,
        isResolved: false
    }));
    const warnings = (record.warnings || []).map((msg, i) => ({
        $id: `${record.$id}-w-${i}`,
        articleId: record.articleId,
        type: 'warning',
        description: msg,
        source: record.source,
        isResolved: false
    }));
    return [...errors, ...warnings];
}

/**
 * Realtime handler a `validations` (rendszer) kollekció eseményeire.
 * Egy rekord create/update esetén az adott articleId + source kombinációhoz tartozó
 * összes lapos itemet lecseréli az újra lapított eredménnyel.
 */
function applySystemValidationEvent(eventType, payload, articleIdsRef, setValidations) {
    // system validations: csak az aktív kiadvány cikkeihez tartozó eseményeket kezeljük.
    // Delete esetén articleId + source alapján törlünk, ha még szerepel a state-ben.
    const { articleId, source } = payload;

    if (eventType !== 'delete' && !articleIdsRef.current.has(articleId)) return;

    setValidations(prev => {
        // Régi lapos itemek eltávolítása erre az articleId + source párra
        const filtered = prev.filter(v => !(v.articleId === articleId && v.source === source));
        if (eventType === 'delete') return filtered;
        // Új lapos itemek hozzáadása
        return [...filtered, ...flattenSystemValidationRecord(payload)];
    });
}
