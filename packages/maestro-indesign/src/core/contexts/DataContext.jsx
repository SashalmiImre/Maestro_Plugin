/**
 * @file DataContext.jsx
 * @description Központi adatmenedzser a Maestro Pluginhoz.
 *
 * Ez a komponens felelős az adatok központi kezeléséért: lekérés, írás (write-through),
 * és valós idejű (Realtime) szinkronizáció.
 *
 * Központi elvek:
 * - "Active Publication" alapú adatkezelés: mindig lekéri az összes kiadványt,
 *   de csak az AKTÍV kiadványhoz tartozó cikkeket és validációkat tölti be.
 * - Write-through minta: a komponensek ide írnak vissza, a DataContext szinkronizálja az adatbázissal,
 *   majd optimistikusan frissíti a helyi state-et a szerver válaszával.
 * - $updatedAt staleness guard: a Realtime handler kihagyja az elavult eseményeket.
 * - applyArticleUpdate: külső írók (pl. WorkflowEngine hívók) a szerver válaszával
 *   közvetlenül frissíthetik a helyi state-et DB hívás nélkül.
 */

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from "react";
import { tables, ID, DATABASE_ID, PUBLICATIONS_COLLECTION_ID, ARTICLES_COLLECTION_ID, USER_VALIDATIONS_COLLECTION_ID, LAYOUTS_COLLECTION_ID, DEADLINES_COLLECTION_ID, GROUP_MEMBERSHIPS_COLLECTION_ID, WORKFLOWS_COLLECTION_ID, Query } from "../config/appwriteConfig.js";
import { callUpdateArticleCF } from "../utils/updateArticleClient.js";
import { realtime } from "../config/realtimeClient.js";
import { useConnection } from "./ConnectionContext.jsx";
import { useScope } from "./ScopeContext.jsx";
import { useToast } from "../../ui/common/Toast/ToastContext.jsx";
import { log, logWarn, logError } from "../utils/logger.js";
import { withTimeout, withRetry } from "../utils/promiseUtils.js";
import { isNetworkError, isAuthError } from "../utils/errorUtils.js";
import { MaestroEvent, dispatchMaestroEvent } from "../config/maestroEvents.js";
import { FETCH_TIMEOUT_CONFIG, TOAST_TYPES } from "../utils/constants.js";

/** Név szerinti komparátor rendezéshez. */
const compareByName = (a, b) => (a?.name ?? '').localeCompare(b?.name ?? '');

/** Sorrend szerinti komparátor rendezéshez. */
const compareByOrder = (a, b) => (a?.order ?? 0) - (b?.order ?? 0);

/** Kezdőoldal szerinti komparátor rendezéshez. */
const compareByStartPage = (a, b) => (a?.startPage ?? 0) - (b?.startPage ?? 0);

// Létrehozzuk a Context-et (alapértelmezésben null)
const DataContext = createContext(null);

/**
 * Hook az adatok eléréséhez bármely komponensből.
 */
export const useData = () => {
    const context = useContext(DataContext);
    if (!context) throw new Error("useData must be used within a DataProvider");
    return context;
};

/**
 * A fő szolgáltató komponens (Provider).
 */
export const DataProvider = ({ children }) => {
    // Kapcsolat kezelése (ConnectionContext)
    const { startConnecting, setConnected, setOffline, setConnectionStatus, incrementAttempts } = useConnection();
    // Értesítések (ToastContext)
    const { showToast } = useToast();
    // Aktív scope (ScopeContext) — Fázis 1 / B.7
    const { activeOrganizationId, activeEditorialOfficeId, isScopeValidated } = useScope();

    // --- State (Állapot) ---
    // 1. Globális adatok
    const [publications, setPublications] = useState([]);

    // 2. Aktív kontextus
    const [activePublicationId, setActivePublicationId] = useState(null);

    // 3. Aktív kiadványhoz tartozó adatok
    const [articles, setArticles] = useState([]);
    const [validations, setValidations] = useState([]); // User Validations
    const [layouts, setLayouts] = useState([]);
    const [deadlines, setDeadlines] = useState([]);

    // Az office-hoz tartozó összes workflow doc (nyers, NEM parse-olt compiled).
    // A derived `workflow` memo a publication.workflowId alapján oldja fel,
    // a parse a memo-ban történik — így a Realtime handler olcsó.
    const [workflows, setWorkflows] = useState([]);
    const workflowFetchedForOfficeRef = useRef(null);

    // 4. Loading indikátorok
    const [isLoading, setIsLoading] = useState(true); // Globális loading (initial)
    const [isSwitchingPublication, setIsSwitchingPublication] = useState(false); // Publikáció váltáskor

    // 5. Inicializálás jelző
    const [isInitialized, setIsInitialized] = useState(false);

    // 6. Fetch generáció-számláló (dupla fetch elkerülésére)
    const fetchGenerationRef = useRef(0);

    // 7. Ref-ek a stale closure elkerülésére a Realtime handlerben
    const latestArticlesRef = useRef(articles);
    useEffect(() => {
        latestArticlesRef.current = articles;
    }, [articles]);

    const latestPublicationsRef = useRef(publications);
    useEffect(() => {
        latestPublicationsRef.current = publications;
    }, [publications]);

    const activePublicationIdRef = useRef(activePublicationId);
    useEffect(() => {
        activePublicationIdRef.current = activePublicationId;
    }, [activePublicationId]);

    // Scope ref-ek: stabil closure-t adnak a fetchData, Realtime handler és
    // write-through createX metódusoknak (elkerüli a deps-sprawlt).
    const activeOrganizationIdRef = useRef(activeOrganizationId);
    useEffect(() => {
        activeOrganizationIdRef.current = activeOrganizationId;
    }, [activeOrganizationId]);

    const activeEditorialOfficeIdRef = useRef(activeEditorialOfficeId);
    useEffect(() => {
        activeEditorialOfficeIdRef.current = activeEditorialOfficeId;
    }, [activeEditorialOfficeId]);

    // ═══════════════════════════════════════════════════════════════════════════
    // Adatlekérés (Fetch)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Adatok lekérése.
     * Két fázis:
     * 1. Mindig: Publikációk listája
     * 2. Ha van activePublicationId: Cikkek és Validációk
     *
     * @param {boolean} isBackground - Ha igaz, nem állítja át a isLoading state-et.
     */
    const fetchData = useCallback(async (isBackground = false) => {
        // Generáció-számláló: ha közben újabb fetchData indul, az elavult eredményt eldobjuk.
        // Ez megakadályozza, hogy a recovery + publication switch dupla fetch-je
        // egymás eredményeit felülírja.
        const generation = ++fetchGenerationRef.current;

        // Ref-ből olvassuk — így a fetchData nem függ az activePublicationId-tól,
        // és nem generálódik újra pub-váltáskor (elkerüli a dupla fetch-et).
        const currentPubId = activePublicationIdRef.current;
        const currentOfficeId = activeEditorialOfficeIdRef.current;

        // Scope-guard: ha még nincs aktív szerkesztőség, üres state + initialized,
        // hogy a Realtime feliratkozás indulhasson. A scope megjelenésekor az
        // office effect újra meghívja ezt a függvényt.
        if (!currentOfficeId) {
            log('[DataContext] Nincs aktív editorialOfficeId — üres state + initialized');
            setPublications([]);
            setArticles([]);
            setLayouts([]);
            setDeadlines([]);
            setValidations([]);
            setWorkflows([]);
            setIsInitialized(true);
            if (!isBackground) {
                setIsLoading(false);
                setIsSwitchingPublication(false);
            }
            setConnected();
            return;
        }

        if (!isBackground) setIsLoading(true);

        // UI Feedback delay (csak ha nem background)
        const connectingDelayTimerId = !isBackground ? setTimeout(() => {
            startConnecting("Adatok betöltése...");
        }, 200) : null;

        try {
            log('[DataContext] Adatok lekérése...', { activePublicationId: currentPubId, generation });
            const cacheBustId = `cache-bust-${Date.now()}`;

            // Workflow fetch — csak ha office változott vagy még nem töltöttük be
            // (Realtime hot-reload frissíti, ha közben módosul)
            if (workflowFetchedForOfficeRef.current !== currentOfficeId) {
                fetchWorkflow(currentOfficeId).then(success => {
                    if (success) workflowFetchedForOfficeRef.current = currentOfficeId;
                });
            }

            // 1. Publikációk lekérése (Mindig) — kritikus
            // isActivated szűrés: a plugin csak aktivált kiadványokat lát
            const publicationsPromise = withRetry(
                () => withTimeout(
                    tables.listRows({
                        databaseId: DATABASE_ID,
                        tableId: PUBLICATIONS_COLLECTION_ID,
                        queries: [
                            Query.equal("editorialOfficeId", currentOfficeId),
                            Query.equal("isActivated", true),
                            Query.limit(100),
                            Query.notEqual("$id", cacheBustId)
                        ]
                    }),
                    FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS, "fetchPublications"
                ),
                { operationName: "fetchPublications" }
            );

            // 2. Cikkek lekérése (Csak ha van aktív publikáció) — kritikus
            let articlesPromise = Promise.resolve({ documents: [] });
            // Nem-kritikus adatok (layoutok, határidők) — Promise.allSettled-del kezeljük
            let layoutsPromise = Promise.resolve({ documents: [] });
            let deadlinesPromise = Promise.resolve({ documents: [] });

            if (currentPubId) {
                // editorialOfficeId szűrés a publicationId mellé: a pub transzitíven
                // scope-ol, de a kétszeres szűrés explicit enforcement (match a CF guard logikával).
                articlesPromise = withRetry(
                    () => withTimeout(
                        tables.listRows({
                            databaseId: DATABASE_ID,
                            tableId: ARTICLES_COLLECTION_ID,
                            queries: [
                                Query.equal("publicationId", currentPubId),
                                Query.equal("editorialOfficeId", currentOfficeId),
                                Query.limit(1000),
                                Query.notEqual("$id", cacheBustId)
                            ]
                        }),
                        FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS, "fetchArticles"
                    ),
                    { operationName: "fetchArticles" }
                );

                // 2b. Layoutok lekérése (nem-kritikus)
                layoutsPromise = withRetry(
                    () => withTimeout(
                        tables.listRows({
                            databaseId: DATABASE_ID,
                            tableId: LAYOUTS_COLLECTION_ID,
                            queries: [
                                Query.equal("publicationId", currentPubId),
                                Query.equal("editorialOfficeId", currentOfficeId),
                                Query.limit(100)
                            ]
                        }),
                        FETCH_TIMEOUT_CONFIG.NON_CRITICAL_DATA_MS, "fetchLayouts"
                    ),
                    { operationName: "fetchLayouts" }
                );

                // 2c. Határidők lekérése (nem-kritikus)
                deadlinesPromise = withRetry(
                    () => withTimeout(
                        tables.listRows({
                            databaseId: DATABASE_ID,
                            tableId: DEADLINES_COLLECTION_ID,
                            queries: [
                                Query.equal("publicationId", currentPubId),
                                Query.equal("editorialOfficeId", currentOfficeId),
                                Query.limit(100)
                            ]
                        }),
                        FETCH_TIMEOUT_CONFIG.NON_CRITICAL_DATA_MS, "fetchDeadlines"
                    ),
                    { operationName: "fetchDeadlines" }
                );
            }

            // Kritikus adatok (publications, articles) — ha elbuknak, a catch kezeli
            // Nem-kritikus adatok (layouts, deadlines) — Promise.allSettled: ha elbuknak,
            // toast figyelmeztetés, a UI működik tovább üres listával
            const [
                publicationsResponse,
                articlesResponse,
                ...settledResults
            ] = await Promise.all([
                publicationsPromise,
                articlesPromise,
                Promise.allSettled([layoutsPromise, deadlinesPromise])
            ]).then(([pubs, arts, settled]) => [pubs, arts, ...settled]);

            const [layoutsResult, deadlinesResult] = settledResults;

            // Elavult generáció ellenőrzése: ha közben újabb fetchData indult,
            // az eredményt eldobjuk, mert a frissebb hívás fogja a state-et beállítani.
            if (generation !== fetchGenerationRef.current) {
                log(`[DataContext] Elavult fetch eredmény eldobva (gen ${generation}, aktuális: ${fetchGenerationRef.current})`);
                return;
            }

            // Feldolgozás
            const publicationList = publicationsResponse.documents || publicationsResponse.rows || [];
            const sortedPublications = publicationList.sort(compareByName);
            setPublications(sortedPublications);

            // Stale activePublicationId védelem: ha a scope-szűrt lista nem
            // tartalmazza (pl. másik office-é volt), nullázzuk.
            if (currentPubId && !sortedPublications.some(publication => publication.$id === currentPubId)) {
                log(`[DataContext] Aktív kiadvány már nem elérhető az aktuális scope-ban (${currentPubId}), nullázás`);
                setActivePublicationId(null);
            }

            const articleList = articlesResponse.documents || articlesResponse.rows || [];
            const sortedArticles = articleList.sort(compareByName);
            setArticles(sortedArticles);

            // Layoutok feldolgozása (nem-kritikus — allSettled)
            if (layoutsResult.status === 'fulfilled') {
                const layoutList = layoutsResult.value.documents || layoutsResult.value.rows || [];
                setLayouts(layoutList.sort(compareByOrder));
            } else {
                logError('[DataContext] Layoutok lekérése sikertelen:', layoutsResult.reason);
                showToast('Layoutok betöltése sikertelen', TOAST_TYPES.ERROR, 'A layoutok nem töltődtek be. Próbáld újra később.');
            }

            // Határidők feldolgozása (nem-kritikus — allSettled)
            if (deadlinesResult.status === 'fulfilled') {
                const deadlineList = deadlinesResult.value.documents || deadlinesResult.value.rows || [];
                setDeadlines(deadlineList.sort(compareByStartPage));
            } else {
                logError('[DataContext] Határidők lekérése sikertelen:', deadlinesResult.reason);
                showToast('Határidők betöltése sikertelen', TOAST_TYPES.ERROR, 'A határidők nem töltődtek be. Próbáld újra később.');
            }

            // 3. Validációk lekérése (Ha vannak cikkek)
            let loadedValidations = [];
            if (currentPubId && sortedArticles.length > 0) {
                const articleIds = sortedArticles.map(article => article.$id);
                const CHUNK_SIZE = 50;
                const chunks = [];
                for (let i = 0; i < articleIds.length; i += CHUNK_SIZE) {
                    chunks.push(articleIds.slice(i, i + CHUNK_SIZE));
                }

                log(`[DataContext] Validációk lekérése ${articleIds.length} cikkhez...`);

                const chunkPromises = chunks.map(chunkIds =>
                    withRetry(
                        () => withTimeout(
                            tables.listRows({
                                databaseId: DATABASE_ID,
                                tableId: USER_VALIDATIONS_COLLECTION_ID,
                                queries: [
                                    Query.equal('articleId', chunkIds),
                                    Query.equal("editorialOfficeId", currentOfficeId),
                                    Query.limit(chunkIds.length * 5)
                                ]
                            }),
                            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS, "fetchValidationChunk"
                        ),
                        { operationName: "fetchValidationChunk" }
                    )
                );

                const chunkResults = await Promise.all(chunkPromises);
                loadedValidations = chunkResults.flatMap(response => response.documents || response.rows || []);
                log(`[DataContext] ${loadedValidations.length} validáció betöltve.`);
            }

            // Validációk ID normalizálás
            const normalizedValidations = loadedValidations.map(validation => ({
                ...validation,
                id: validation.$id,
                $id: validation.$id
            }));

            // Végső elavulás-ellenőrzés a validációk után (a validáció lekérés is időt vehet igénybe)
            if (generation !== fetchGenerationRef.current) {
                log(`[DataContext] Elavult fetch eredmény eldobva validációk után (gen ${generation}, aktuális: ${fetchGenerationRef.current})`);
                return;
            }

            setValidations(normalizedValidations);

            setConnected();
            setIsInitialized(true);

        } catch (error) {
            // Elavult generáció: a hiba is elavult, nem kell kezelni
            if (generation !== fetchGenerationRef.current) {
                log(`[DataContext] Elavult fetch hiba figyelmen kívül hagyva (gen ${generation})`);
                return;
            }

            logError('[DataContext] Hiba:', error);
            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                // Timeout ≠ offline: a szerver elérhető lehet, csak a lekérés lassú
                const isTimeout = error.message?.includes('időtúllépés');
                if (isTimeout) {
                    showToast('Lassú kapcsolat', TOAST_TYPES.WARNING, 'Az adatlekérés időtúllépés miatt megszakadt.');
                } else {
                    // Valódi hálózati hiba — offline overlay
                    const attempts = incrementAttempts();
                    setOffline(error, attempts);
                }
            } else {
                showToast('Adatok betöltése sikertelen', TOAST_TYPES.ERROR, error.message);
            }
        } finally {
            if (connectingDelayTimerId) clearTimeout(connectingDelayTimerId);

            // Csak a legfrissebb generáció állítja a loading state-et,
            // különben egy elavult fetch törölhetné az újabb loading jelzését
            if (generation === fetchGenerationRef.current) {
                if (!isBackground) {
                    setIsLoading(false);
                    setIsSwitchingPublication(false);
                }

                // Overlay tisztítás: ha a startConnecting tüzelt (200ms eltelt) de
                // nem mentünk offline-ba, töröljük az isConnecting-et, hogy az overlay
                // ne ragadjon be (timeout, auth hiba, egyéb hiba esetén).
                setConnectionStatus(prev => {
                    if (prev.isOffline) return prev; // Offline overlay marad (valódi hálózati hiba)
                    if (!prev.isConnecting) return prev; // Nincs mit tisztítani
                    return { ...prev, isConnecting: false, message: null, details: null };
                });
            }
        }
    }, [startConnecting, setConnected, setOffline, incrementAttempts, showToast]);

    // ═══════════════════════════════════════════════════════════════════════════
    // Inicializálás és Active Publication Váltás
    // ═══════════════════════════════════════════════════════════════════════════

    // Workflow fetch — office-szintű, a fetchData-ban (és recovery-nél) fut.
    // Fázis 7: egy office-ban több workflow is lehet, ezért az összeset behúzzuk
    // név szerint rendezve. A derived `workflow` memo a publication.workflowId
    // alapján oldja fel, a compiled JSON parse-olás is ott történik.
    const fetchWorkflow = useCallback(async (officeId) => {
        if (!officeId) {
            setWorkflows([]);
            return true;
        }
        try {
            const response = await withRetry(
                () => withTimeout(
                    tables.listRows({
                        databaseId: DATABASE_ID,
                        tableId: WORKFLOWS_COLLECTION_ID,
                        queries: [
                            Query.equal("editorialOfficeId", officeId),
                            Query.orderAsc("name"),
                            Query.limit(100)
                        ]
                    }),
                    FETCH_TIMEOUT_CONFIG.NON_CRITICAL_DATA_MS, "fetchWorkflow"
                ),
                { operationName: "fetchWorkflow" }
            );
            const rows = response.documents || response.rows || [];
            if (rows.length > 0) {
                setWorkflows(rows);
                log(`[DataContext] Workflow-k betöltve (${rows.length} doc, office=${officeId})`);
            } else {
                logWarn('[DataContext] Nincs workflow doc ehhez az office-hoz:', officeId);
                setWorkflows([]);
            }
            return true;
        } catch (err) {
            logError('[DataContext] Workflow fetch hiba:', err);
            return false;
        }
    }, []);

    // Parse cache docId szerint — stabil compiled referencia, ha két publikáció
    // ugyanarra a workflow doc-ra mutat (publikáció-váltáskor nincs fals
    // workflowChanged event).
    const workflowCache = useMemo(() => {
        const cache = new Map();
        for (const doc of workflows) {
            try {
                const compiled = typeof doc.compiled === 'string'
                    ? JSON.parse(doc.compiled)
                    : doc.compiled;
                cache.set(doc.$id, compiled);
            } catch (err) {
                logError(`[DataContext] Workflow compiled parse hiba (${doc.$id}):`, err);
            }
        }
        return cache;
    }, [workflows]);

    // Az aktív publikáció workflowId-ja — külön memo, hogy a workflow memo
    // ne invalidálódjon minden publikáció-mutációnál (lock flip, rename stb.).
    const activeWorkflowId = useMemo(() => {
        if (!activePublicationId) return null;
        const activePub = publications.find(p => p.$id === activePublicationId);
        return activePub?.workflowId || null;
    }, [publications, activePublicationId]);

    // Derived workflow — fail-closed: ha a workflowId érvénytelen vagy nincs,
    // null. A plugin `!workflow` ágakra megy (cikk blokkolás). Egyezik a CF
    // `article-update-guard` `getWorkflowForPublication()` viselkedésével.
    const workflow = useMemo(() => {
        if (!activeWorkflowId) return null;
        return workflowCache.get(activeWorkflowId) || null;
    }, [activeWorkflowId, workflowCache]);

    // workflowChanged dispatch a derived workflow identitás változására —
    // lefedi a Realtime eseményeket ÉS a publikáció-váltást is.
    const prevWorkflowRef = useRef(null);
    useEffect(() => {
        if (prevWorkflowRef.current === workflow) return;
        prevWorkflowRef.current = workflow;
        dispatchMaestroEvent(MaestroEvent.workflowChanged);
    }, [workflow]);

    // Active Publication váltás kezelése
    const updateActivePublicationId = useCallback((id) => {
        if (id === activePublicationId) return;

        log(`[DataContext] Aktív kiadvány váltása: ${activePublicationId} -> ${id}`);
        setActivePublicationId(id);

        // UI azonnali ürítése, hogy ne látszódjanak a régi adatok
        setArticles([]);
        setValidations([]);
        setLayouts([]);
        setDeadlines([]);
        setIsSwitchingPublication(true);
    }, [activePublicationId]);

    // Egyesített fetch trigger: initial fetch a scope validáció után, office
    // váltás detektálás (nullázza a régi pubId-t) és pub váltás fetch egy
    // effectben. Külön effectekkel a pubId nullázás + re-trigger dupla fetch-et
    // indított el office váltáskor.
    const hasInitializedRef = useRef(false);
    const prevOfficeIdRef = useRef(activeEditorialOfficeId);
    useEffect(() => {
        if (!isScopeValidated) return;

        if (!hasInitializedRef.current) {
            hasInitializedRef.current = true;
            prevOfficeIdRef.current = activeEditorialOfficeId;
            fetchData();
            return;
        }

        if (prevOfficeIdRef.current !== activeEditorialOfficeId) {
            log(`[DataContext] Office váltás (${prevOfficeIdRef.current} → ${activeEditorialOfficeId})`);
            prevOfficeIdRef.current = activeEditorialOfficeId;
            if (activePublicationId !== null) {
                // A setter re-triggereli ezt az effectet pubId=null-lal,
                // ahol aztán a fetch tiszta állapotból indul.
                setActivePublicationId(null);
                setArticles([]);
                setLayouts([]);
                setDeadlines([]);
                setValidations([]);
                return;
            }
        }

        fetchData(false);
    }, [isScopeValidated, activePublicationId, activeEditorialOfficeId]); // eslint-disable-line react-hooks/exhaustive-deps

    // ═══════════════════════════════════════════════════════════════════════════
    // Write-Through API — közös scope injection helper
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Hozzáfűzi a `createX` payloadhoz a scope mezőket (organizationId +
     * editorialOfficeId), és dob, ha hiányzik. A happy path-ban nem tüzelhet
     * (a UI a ScopeMissingPlaceholder mögött zárolva), de védi a recovery alatti
     * race-t és a CF guard előtti köztes időszakot.
     */
    const withScope = useCallback((data) => {
        const orgId = activeOrganizationIdRef.current;
        const officeId = activeEditorialOfficeIdRef.current;
        if (!orgId || !officeId) {
            throw new Error('Nincs aktív szerkesztőség — a művelet nem hajtható végre.');
        }
        return {
            ...data,
            organizationId: orgId,
            editorialOfficeId: officeId
        };
    }, []);

    // ═══════════════════════════════════════════════════════════════════════════
    // Write-Through API — Cikkek (Articles)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Új cikk létrehozása az adatbázisban.
     *
     * @param {Object} data - A cikk adatai (name, filePath, publicationId, state, stb.)
     * @returns {Promise<Object>} A létrehozott dokumentum.
     */
    const createArticle = useCallback(async (data) => {
        const result = await withTimeout(
            tables.createRow({
                databaseId: DATABASE_ID,
                tableId: ARTICLES_COLLECTION_ID,
                rowId: ID.unique(),
                data: withScope(data)
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: createArticle"
        );
        setArticles(prev => {
            if (prev.some(article => article.$id === result.$id)) return prev;
            return [...prev, result].sort(compareByName);
        });
        return result;
    }, [withScope]);

    /**
     * Cikk frissítése az adatbázisban az `update-article` Cloud Function-ön keresztül.
     *
     * A Plugin NEM ír közvetlenül az `articles` collection-be — minden írás
     * ezen a CF-en fut át, amely szerver-oldalon validál és jogosultságot
     * ellenőriz (Fázis 9 follow-up). Fail-closed: ha a CF `permissionDenied`-et
     * jelez, a hívó `PermissionDeniedError`-t kap, és a hívó oldal kezeli
     * (toast + optimista UI revert).
     *
     * @param {string} articleId - A frissítendő cikk azonosítója.
     * @param {Object} data - A frissítendő mezők (csak engedett whitelist).
     * @returns {Promise<Object>} A szerver által visszaadott frissített dokumentum.
     * @throws {PermissionDeniedError} Ha a szerver 403-mal utasítja el a kérést.
     */
    const updateArticle = useCallback(async (articleId, data) => {
        const result = await callUpdateArticleCF(articleId, data, "DataContext: updateArticle");
        setArticles(prev => prev.map(article => article.$id === articleId ? result : article).sort(compareByName));
        return result;
    }, []);

    /**
     * Cikk törlése az adatbázisból.
     *
     * @param {string} articleId - A törlendő cikk azonosítója.
     */
    const deleteArticle = useCallback(async (articleId) => {
        await withTimeout(
            tables.deleteRow({
                databaseId: DATABASE_ID,
                tableId: ARTICLES_COLLECTION_ID,
                rowId: articleId
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: deleteArticle"
        );
        setArticles(prev => prev.filter(article => article.$id !== articleId));
    }, []);

    /**
     * Helyi cikk-state frissítése egy szerver-válasz dokumentummal, DB hívás nélkül.
     * Külső írók számára (pl. WorkflowEngine.executeTransition, lockDocument, unlockDocument),
     * akik már végrehajtották a DB írást és a szerver válaszával szeretnék frissíteni a helyi adatot.
     *
     * @param {Object} serverDocument - A szerver által visszaadott frissített dokumentum.
     */
    const applyArticleUpdate = useCallback((serverDocument) => {
        if (!serverDocument?.$id) return;
        setArticles(prev => prev.map(article => {
            if (article.$id !== serverDocument.$id) return article;
            // $updatedAt elavulás-védelem: ne írjunk felül frissebb adatot régebbivel
            if (article.$updatedAt && serverDocument.$updatedAt && article.$updatedAt > serverDocument.$updatedAt) {
                logWarn(`[DataContext] applyArticleUpdate elavult dokumentum kihagyva (${article.$id})`);
                return article;
            }
            return serverDocument;
        }).sort(compareByName));
    }, []);

    // ═══════════════════════════════════════════════════════════════════════════
    // Write-Through API — Felhasználói Validációk (User Validations)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Új validációs bejegyzés létrehozása.
     *
     * @param {Object} data - A validáció adatai (articleId, type, description, stb.)
     * @returns {Promise<Object>} A létrehozott dokumentum.
     */
    const createValidation = useCallback(async (data) => {
        const result = await withTimeout(
            tables.createRow({
                databaseId: DATABASE_ID,
                tableId: USER_VALIDATIONS_COLLECTION_ID,
                rowId: ID.unique(),
                data: withScope(data)
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: createValidation"
        );
        const normalized = { ...result, id: result.$id, $id: result.$id };
        setValidations(prev => {
            if (prev.some(v => v.$id === normalized.$id)) return prev;
            return [normalized, ...prev];
        });
        return result;
    }, [withScope]);

    /**
     * Validációs bejegyzés frissítése.
     *
     * @param {string} validationId - A frissítendő validáció azonosítója.
     * @param {Object} data - A frissítendő mezők.
     * @returns {Promise<Object>} A frissített dokumentum.
     */
    const updateValidation = useCallback(async (validationId, data) => {
        const result = await withTimeout(
            tables.updateRow({
                databaseId: DATABASE_ID,
                tableId: USER_VALIDATIONS_COLLECTION_ID,
                rowId: validationId,
                data
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: updateValidation"
        );
        const normalized = { ...result, id: result.$id, $id: result.$id };
        setValidations(prev => prev.map(validation => validation.$id === validationId ? normalized : validation));
        return result;
    }, []);

    /**
     * Validációs bejegyzés törlése.
     *
     * @param {string} validationId - A törlendő validáció azonosítója.
     */
    const deleteValidation = useCallback(async (validationId) => {
        await withTimeout(
            tables.deleteRow({
                databaseId: DATABASE_ID,
                tableId: USER_VALIDATIONS_COLLECTION_ID,
                rowId: validationId
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: deleteValidation"
        );
        setValidations(prev => prev.filter(validation => validation.$id !== validationId));
    }, []);

    // ═══════════════════════════════════════════════════════════════════════════
    // Realtime Szinkronizáció
    // ═══════════════════════════════════════════════════════════════════════════

    useEffect(() => {
        if (!isInitialized) return;

        log('[DataContext] Realtime feliratkozás...');

        const channels = [
            `databases.${DATABASE_ID}.collections.${PUBLICATIONS_COLLECTION_ID}.documents`,
            `databases.${DATABASE_ID}.collections.${ARTICLES_COLLECTION_ID}.documents`,
            `databases.${DATABASE_ID}.collections.${USER_VALIDATIONS_COLLECTION_ID}.documents`,
            `databases.${DATABASE_ID}.collections.${LAYOUTS_COLLECTION_ID}.documents`,
            `databases.${DATABASE_ID}.collections.${DEADLINES_COLLECTION_ID}.documents`,
            `databases.${DATABASE_ID}.collections.${GROUP_MEMBERSHIPS_COLLECTION_ID}.documents`,
            `databases.${DATABASE_ID}.collections.${WORKFLOWS_COLLECTION_ID}.documents`
        ];

        const unsubscribe = realtime.subscribe(channels, (response) => {
            const { events, payload } = response;
            const event = events[0];

            // Scope out-of-scope check. Delete eseményeknél NEM szűrünk — a
            // payload jellemzően nincs scope mezővel, és a downstream filter()
            // amúgy is csak a scope-on belüli prev listán dolgozik (idegen
            // office delete-je no-op).
            const isOutOfScope = (evt, pl) => {
                if (evt.includes(".delete")) return false;
                const currentOfficeId = activeEditorialOfficeIdRef.current;
                return !currentOfficeId || pl.editorialOfficeId !== currentOfficeId;
            };

            // --- Publikációk ---
            // A plugin kizárólag aktivált kiadványokat lát. Nem aktivált create-et
            // figyelmen kívül hagyunk; update esetén, ha a payload nem aktivált,
            // eltávolítjuk (deaktiválás vagy még nem aktivált szerkesztés kezelése).
            //
            // Post-write CF korlát: a validate-publication-update CF az írás UTÁN
            // fut, ezért egy érvénytelen aktiválás rövid ideig (~1-2s) látszhat
            // a pluginban, mielőtt a server-side revert megérkezik egy második
            // Realtime eseményen. A $updatedAt staleness guard és a Realtime
            // sorrend garantálja, hogy a revert felülírja a kezdeti aktivációt
            // (a revert $updatedAt-ja mindig frissebb). A cikkek szerkesztése
            // addig is blokkolva van, mert a scope query-k (workflow, validations)
            // nem találnak semmit a még nem létező DB állapothoz.
            if (event.includes(PUBLICATIONS_COLLECTION_ID)) {
                if (isOutOfScope(event, payload)) return;

                // Ha a deaktivált (vagy törölt) publikáció éppen az aktív,
                // töröljük az aktív állapotot is — különben stale cikkek /
                // határidők / layoutok maradnának a UI-ban. Ez szimmetrikus
                // a .delete és az office-váltás kezelésével.
                const deactivation = event.includes(".update") && !payload.isActivated;
                const deletion = event.includes(".delete");
                if ((deactivation || deletion) && activePublicationIdRef.current === payload.$id) {
                    setActivePublicationId(null);
                    setArticles([]);
                    setLayouts([]);
                    setDeadlines([]);
                    setValidations([]);
                }

                // A coverage-változás detektálása a setPublications ELŐTT, a prev state-ből,
                // hogy Strict Mode-ban is idempotens legyen (a setter callback kétszer fut).
                // Csak akkor érdekes az overlap validációnak, ha az érintett publikáció
                // éppen az aktív (azaz cikkei betöltve vannak).
                const shouldCheckCoverage = event.includes(".update")
                    && payload.isActivated
                    && payload.$id === activePublicationIdRef.current;
                if (shouldCheckCoverage) {
                    const existing = latestPublicationsRef.current.find(pub => pub.$id === payload.$id);
                    const isStale = existing?.$updatedAt && payload.$updatedAt && existing.$updatedAt > payload.$updatedAt;
                    if (existing && !isStale) {
                        const coverageDidChange = existing.coverageStart !== payload.coverageStart
                            || existing.coverageEnd !== payload.coverageEnd;
                        if (coverageDidChange) {
                            dispatchMaestroEvent(MaestroEvent.publicationCoverageChanged, { publication: payload });
                        }
                    }
                }

                setPublications(prev => {
                    if (event.includes(".update")) {
                        const existing = prev.find(pub => pub.$id === payload.$id);
                        if (!payload.isActivated) {
                            // Nem aktivált: eltávolítjuk (ha eddig ott volt)
                            return existing ? prev.filter(pub => pub.$id !== payload.$id) : prev;
                        }
                        if (!existing) {
                            // Új aktivált publikáció (pl. first-time activation): hozzáadás
                            return [...prev, payload].sort(compareByName);
                        }
                        // $updatedAt staleness guard — ha a helyi adat frissebb, skip
                        const isStale = existing.$updatedAt && payload.$updatedAt && existing.$updatedAt > payload.$updatedAt;
                        return prev.map(publication => {
                            if (publication.$id !== payload.$id) return publication;
                            if (isStale) return publication;
                            return payload;
                        }).sort(compareByName);
                    } else if (event.includes(".create")) {
                        if (!payload.isActivated) return prev;
                        if (prev.some(publication => publication.$id === payload.$id)) return prev;
                        return [...prev, payload].sort(compareByName);
                    } else if (event.includes(".delete")) {
                        return prev.filter(publication => publication.$id !== payload.$id);
                    }
                    return prev;
                });
            }

            // --- Cikkek ---
            else if (event.includes(ARTICLES_COLLECTION_ID)) {
                if (isOutOfScope(event, payload)) return;
                const currentActivePublicationId = activePublicationIdRef.current;

                if (currentActivePublicationId) {
                    const currentArticles = latestArticlesRef.current;

                    if (payload.publicationId === currentActivePublicationId || currentArticles.some(article => article.$id === payload.$id)) {
                        setArticles(prev => {
                            if (event.includes(".update")) {
                                return prev.map(article => {
                                    if (article.$id !== payload.$id) return article;
                                    // $updatedAt staleness guard
                                    if (article.$updatedAt && payload.$updatedAt && article.$updatedAt > payload.$updatedAt) {
                                        return article;
                                    }
                                    return payload;
                                }).sort(compareByName);
                            } else if (event.includes(".create")) {
                                if (payload.publicationId !== currentActivePublicationId) return prev;
                                if (prev.some(article => article.$id === payload.$id)) return prev;
                                return [...prev, payload].sort(compareByName);
                            } else if (event.includes(".delete")) {
                                return prev.filter(article => article.$id !== payload.$id);
                            }
                            return prev;
                        });
                    }
                }
            }

            // --- Validációk ---
            else if (event.includes(USER_VALIDATIONS_COLLECTION_ID)) {
                if (isOutOfScope(event, payload)) return;
                const currentArticles = latestArticlesRef.current;
                const isRelevant = currentArticles.some(article => article.$id === payload.articleId);

                if (isRelevant) {
                    setValidations(prev => {
                        const normalizedDocument = { ...payload, id: payload.$id, $id: payload.$id };

                        if (event.includes(".create")) {
                            if (prev.some(validation => validation.$id === payload.$id)) return prev;
                            return [normalizedDocument, ...prev];
                        } else if (event.includes(".update")) {
                            return prev.map(validation => {
                                if (validation.$id !== payload.$id) return validation;
                                // $updatedAt staleness guard
                                if (validation.$updatedAt && payload.$updatedAt && validation.$updatedAt > payload.$updatedAt) {
                                    return validation;
                                }
                                return normalizedDocument;
                            });
                        } else if (event.includes(".delete")) {
                            return prev.filter(validation => validation.$id !== payload.$id);
                        }
                        return prev;
                    });
                }
            }

            // --- Layoutok ---
            else if (event.includes(LAYOUTS_COLLECTION_ID)) {
                if (isOutOfScope(event, payload)) return;
                const currentActivePublicationId = activePublicationIdRef.current;

                if (payload.publicationId === currentActivePublicationId) {
                    setLayouts(prev => {
                        if (event.includes(".update")) {
                            return prev.map(layout => {
                                if (layout.$id !== payload.$id) return layout;
                                if (layout.$updatedAt && payload.$updatedAt && layout.$updatedAt > payload.$updatedAt) {
                                    return layout;
                                }
                                return payload;
                            }).sort(compareByOrder);
                        } else if (event.includes(".create")) {
                            if (prev.some(layout => layout.$id === payload.$id)) return prev;
                            return [...prev, payload].sort(compareByOrder);
                        } else if (event.includes(".delete")) {
                            return prev.filter(layout => layout.$id !== payload.$id);
                        }
                        return prev;
                    });

                    // Az useOverlapValidation hook a layoutChanged eseményre hallgat —
                    // a Dashboard-oldali layout CRUD így triggereli az overlap újraszámítást.
                    dispatchMaestroEvent(MaestroEvent.layoutChanged, { publicationId: payload.publicationId });
                }
            }

            // --- Határidők ---
            else if (event.includes(DEADLINES_COLLECTION_ID)) {
                if (isOutOfScope(event, payload)) return;
                const currentActivePublicationId = activePublicationIdRef.current;

                if (payload.publicationId === currentActivePublicationId) {
                    setDeadlines(prev => {
                        if (event.includes(".update")) {
                            return prev.map(deadline => {
                                if (deadline.$id !== payload.$id) return deadline;
                                if (deadline.$updatedAt && payload.$updatedAt && deadline.$updatedAt > payload.$updatedAt) {
                                    return deadline;
                                }
                                return payload;
                            }).sort(compareByStartPage);
                        } else if (event.includes(".create")) {
                            if (prev.some(deadline => deadline.$id === payload.$id)) return prev;
                            return [...prev, payload].sort(compareByStartPage);
                        } else if (event.includes(".delete")) {
                            return prev.filter(deadline => deadline.$id !== payload.$id);
                        }
                        return prev;
                    });
                }
            }

            // --- Csoporttagság ---
            // A groupMemberships collection-ről jövő események — csak az aktív szerkesztőség
            else if (event.includes(GROUP_MEMBERSHIPS_COLLECTION_ID)) {
                if (payload.editorialOfficeId && payload.editorialOfficeId !== activeEditorialOfficeIdRef.current) {
                    return; // Más szerkesztőség eseménye — ignoráljuk
                }
                const groupId = payload.groupId;
                log(`[DataContext] Csoporttagság változás (Realtime): groupId=${groupId}`);
                dispatchMaestroEvent(MaestroEvent.groupMembershipChanged, { groupId });
            }

            // --- Workflow ---
            // Office-szintű workflow doc változás → a workflows[] array-t frissítjük.
            // A derived `workflow` memo automatikusan újraszámolódik a publikáció
            // workflowId-ja alapján, a workflowChanged event dispatch külön useEffect-ben.
            else if (event.includes(WORKFLOWS_COLLECTION_ID)) {
                if (payload.editorialOfficeId && payload.editorialOfficeId !== activeEditorialOfficeIdRef.current) {
                    return; // Más szerkesztőség workflow-ja — ignoráljuk
                }
                if (event.includes(".create")) {
                    log(`[DataContext] Workflow doc létrehozva (Realtime): ${payload.$id}`);
                    setWorkflows(prev => {
                        if (prev.some(w => w.$id === payload.$id)) return prev;
                        return [...prev, payload].sort(compareByName);
                    });
                } else if (event.includes(".update")) {
                    log(`[DataContext] Workflow doc frissítve (Realtime): ${payload.$id}`);
                    setWorkflows(prev => {
                        const idx = prev.findIndex(w => w.$id === payload.$id);
                        if (idx === -1) return [...prev, payload].sort(compareByName);
                        const next = [...prev];
                        next[idx] = payload;
                        return next.sort(compareByName);
                    });
                } else if (event.includes(".delete")) {
                    logWarn(`[DataContext] Workflow doc törölve (Realtime): ${payload.$id}`);
                    setWorkflows(prev => prev.filter(w => w.$id !== payload.$id));
                }
            }
        });

        return () => {
            if (typeof unsubscribe === 'function') unsubscribe();
        };

    }, [isInitialized]); // Stabil: ref-eket használ, nem closure-öket

    // Ref a stabil event handler-hez (a fetchData változásakor ne kelljen újra feliratkozni)
    const fetchDataRef = useRef(fetchData);
    useEffect(() => {
        fetchDataRef.current = fetchData;
    }, [fetchData]);

    // --- Forced Refresh Event ---
    useEffect(() => {
        const handleRefresh = () => {
            log('[DataContext] Forced Refresh Requested');
            fetchDataRef.current(true);
        };
        window.addEventListener(MaestroEvent.dataRefreshRequested, handleRefresh);
        return () => window.removeEventListener(MaestroEvent.dataRefreshRequested, handleRefresh);
    }, []);

    // ═══════════════════════════════════════════════════════════════════════════
    // Provider Value
    // ═══════════════════════════════════════════════════════════════════════════

    const value = useMemo(() => ({
        // Adatok (read)
        publications,
        articles,
        validations,
        layouts,
        deadlines,
        workflow,
        workflows,
        isLoading,
        isSwitchingPublication,
        activePublicationId,
        setActivePublicationId: updateActivePublicationId,
        fetchData,

        // Write-Through API — Cikkek
        createArticle,
        updateArticle,
        deleteArticle,
        applyArticleUpdate,

        // Write-Through API — Validációk
        createValidation,
        updateValidation,
        deleteValidation
    }), [
        publications, articles, validations, layouts, deadlines, workflow, workflows,
        isLoading, isSwitchingPublication, activePublicationId,
        updateActivePublicationId, fetchData,
        createArticle, updateArticle, deleteArticle, applyArticleUpdate,
        createValidation, updateValidation, deleteValidation
    ]);

    return (
        <DataContext.Provider value={value}>
            {children}
        </DataContext.Provider>
    );
};
