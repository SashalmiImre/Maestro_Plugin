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
 * - $updatedAt staleness guard: a Realtime handler ÉS az írási útvonalak (update*)
 *   kihagyják az elavult eseményeket / válaszokat, hogy egy párhuzamos írás a
 *   saját CF válaszunkkal ne íródjon felül.
 * - applyArticleUpdate / applyValidationUpdate: belső helperek (cikk / validáció)
 *   a szerver válasz staleness-guarddal védett alkalmazására. Az applyArticleUpdate
 *   exportált is — külső írók (pl. WorkflowEngine, LockManager, DocumentMonitor)
 *   DB hívás nélkül frissíthetik vele a helyi state-et.
 */

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from "react";
import { tables, ID, DATABASE_ID, COLLECTIONS, Query } from "../config/appwriteConfig.js";
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

// Elavult fetch eredmény — a catch csendben eldobja (nincs toast, nincs offline overlay).
class StaleFetchError extends Error {
    constructor(generation, current) {
        super(`Stale fetch eredmény (gen ${generation}, aktuális: ${current})`);
        this.name = 'StaleFetchError';
    }
}

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
    const { startConnecting, setOffline, setConnectionStatus, incrementAttempts } = useConnection();
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
    const workflowFetchedForScopeRef = useRef(null);

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

        const throwIfStale = () => {
            if (generation !== fetchGenerationRef.current) {
                throw new StaleFetchError(generation, fetchGenerationRef.current);
            }
        };

        // Háttér (recovery utáni) fetch-nél elnyomjuk a nem-kritikus toast-okat —
        // a user már dolgozik, ne zavarjuk átmeneti hibákkal; a hiba logban marad.
        const warnUser = (title, type, details) => {
            if (!isBackground) showToast(title, type, details);
        };

        // Ref-ből olvassuk — így a fetchData nem függ az activePublicationId-tól,
        // és nem generálódik újra pub-váltáskor (elkerüli a dupla fetch-et).
        const currentPubId = activePublicationIdRef.current;
        const currentOfficeId = activeEditorialOfficeIdRef.current;
        const currentOrgId = activeOrganizationIdRef.current;

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
            // Overlay tisztítás: ha korábbi fetch/recovery már kapcsolódó állapotba
            // állította a UI-t, a no-office ág megkerülné a finally cleanup-ot.
            setConnectionStatus(prev => {
                if (prev.isOffline || !prev.isConnecting) return prev;
                return { ...prev, isConnecting: false, message: null, details: null };
            });
            return;
        }

        if (!isBackground) setIsLoading(true);

        // UI Feedback delay (csak ha nem background)
        const connectingDelayTimerId = !isBackground ? setTimeout(() => {
            startConnecting("Adatok betöltése...");
        }, 200) : null;

        // Auth hibát külön jelezzük a finally-nek — auth hiba esetén NEM inicializálunk
        // (nincs értelme Realtime feliratkozásnak session nélkül; a user vissza fog kerülni Login-ra).
        let didAuthError = false;
        // Sikerült-e elérni a szervert? Ha igen, egy korábbi setOffline overlay
        // feloldható — a REST recovery bizonyítja, hogy a hálózat él.
        let didFetchSucceed = false;

        try {
            log('[DataContext] Adatok lekérése...', { activePublicationId: currentPubId, generation });

            // 1. Publikációk lekérése (Mindig) — kritikus
            // isActivated szűrés: a plugin csak aktivált kiadványokat lát
            const publicationsPromise = withRetry(
                () => withTimeout(
                    tables.listRows({
                        databaseId: DATABASE_ID,
                        tableId: COLLECTIONS.PUBLICATIONS,
                        queries: [
                            Query.equal("editorialOfficeId", currentOfficeId),
                            Query.equal("isActivated", true),
                            Query.limit(100)
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
                            tableId: COLLECTIONS.ARTICLES,
                            queries: [
                                Query.equal("publicationId", currentPubId),
                                Query.equal("editorialOfficeId", currentOfficeId),
                                Query.limit(1000)
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
                            tableId: COLLECTIONS.LAYOUTS,
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
                            tableId: COLLECTIONS.DEADLINES,
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

            // 2d. Workflow-k lekérése (nem-kritikus) — csak ha scope változott vagy
            // még nincs meg. Része a kritikus Promise.all-nak, hogy a
            // `isInitialized=true` csak betöltött workflow után billenjen — különben
            // a Realtime handler átmenetileg `workflow=null`-t látna.
            //
            // 2-way visibility (#30):
            //   - `editorial_office`: csak az aktív office workflow-i
            //   - `organization`: az aktív org bármely office-ának workflow-i
            // A scope fetch cache kulcsa `${orgId}|${officeId}` — org-váltás is invalidál.
            const workflowScopeKey = `${currentOrgId}|${currentOfficeId}`;
            const needsWorkflowFetch = workflowFetchedForScopeRef.current !== workflowScopeKey;
            const workflowsPromise = needsWorkflowFetch
                ? withRetry(
                    () => withTimeout(
                        tables.listRows({
                            databaseId: DATABASE_ID,
                            tableId: COLLECTIONS.WORKFLOWS,
                            queries: [
                                Query.or([
                                    Query.and([
                                        Query.equal("visibility", "organization"),
                                        Query.equal("organizationId", currentOrgId)
                                    ]),
                                    Query.and([
                                        Query.equal("visibility", "editorial_office"),
                                        Query.equal("editorialOfficeId", currentOfficeId)
                                    ]),
                                    // Legacy null → editorial_office fallback (illeszkedik a
                                    // Realtime handler `payload.visibility || 'editorial_office'`
                                    // szemantikájához). Rollout-ablak: schema bootstrap előtt
                                    // létezett sorokat is láthatóvá teszi.
                                    Query.and([
                                        Query.isNull("visibility"),
                                        Query.equal("editorialOfficeId", currentOfficeId)
                                    ])
                                ]),
                                Query.orderAsc("name"),
                                Query.limit(100)
                            ]
                        }),
                        FETCH_TIMEOUT_CONFIG.NON_CRITICAL_DATA_MS, "fetchWorkflows"
                    ),
                    { operationName: "fetchWorkflows" }
                )
                : Promise.resolve(null); // Skip — már betöltve, Realtime frissít

            // Kritikus adatok (publications, articles) — ha elbuknak, a catch kezeli
            // Nem-kritikus adatok (layouts, deadlines, workflows) — allSettled: ha elbuknak,
            // toast figyelmeztetés, a UI működik tovább üres listával / read-only módban
            const [
                publicationsResponse,
                articlesResponse,
                ...settledResults
            ] = await Promise.all([
                publicationsPromise,
                articlesPromise,
                Promise.allSettled([layoutsPromise, deadlinesPromise, workflowsPromise])
            ]).then(([pubs, arts, settled]) => [pubs, arts, ...settled]);

            const [layoutsResult, deadlinesResult, workflowsResult] = settledResults;

            // Elavult generáció: a catch blokk StaleFetchError-ként némán eldobja.
            throwIfStale();

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

            if (layoutsResult.status === 'fulfilled') {
                const layoutList = layoutsResult.value.documents || layoutsResult.value.rows || [];
                setLayouts(layoutList.sort(compareByOrder));
            } else {
                logError('[DataContext] Layoutok lekérése sikertelen:', layoutsResult.reason);
                warnUser('Layoutok betöltése sikertelen', TOAST_TYPES.ERROR, 'A layoutok nem töltődtek be. Próbáld újra később.');
            }

            if (deadlinesResult.status === 'fulfilled') {
                const deadlineList = deadlinesResult.value.documents || deadlinesResult.value.rows || [];
                setDeadlines(deadlineList.sort(compareByStartPage));
            } else {
                logError('[DataContext] Határidők lekérése sikertelen:', deadlinesResult.reason);
                warnUser('Határidők betöltése sikertelen', TOAST_TYPES.ERROR, 'A határidők nem töltődtek be. Próbáld újra később.');
            }

            // Workflows: ha skip-elve volt (már betöltve, value=null), nem érintjük.
            if (needsWorkflowFetch) {
                if (workflowsResult.status === 'fulfilled' && workflowsResult.value) {
                    const rows = workflowsResult.value.documents || workflowsResult.value.rows || [];
                    setWorkflows(rows);
                    workflowFetchedForScopeRef.current = workflowScopeKey;
                    if (rows.length === 0) {
                        logWarn('[DataContext] Nincs látható workflow doc ebben a scope-ban:', workflowScopeKey);
                    } else {
                        log(`[DataContext] Workflow-k betöltve (${rows.length} doc, scope=${workflowScopeKey})`);
                    }
                } else {
                    logError('[DataContext] Workflow lekérése sikertelen:', workflowsResult.reason);
                    warnUser('Workflow betöltése sikertelen', TOAST_TYPES.WARNING, 'A munkafolyamat nem töltődött be — a cikk-szerkesztés átmenetileg korlátozott.');
                }
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
                                tableId: COLLECTIONS.USER_VALIDATIONS,
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
                // Korai stale-check a normalizáció előtt, hogy ne végezzünk
                // felesleges munkát, ha közben pub-switch/recovery új fetch-et indított.
                throwIfStale();
                loadedValidations = chunkResults.flatMap(response => response.documents || response.rows || []);
                log(`[DataContext] ${loadedValidations.length} validáció betöltve.`);
            }

            const normalizedValidations = loadedValidations.map(validation => ({
                ...validation,
                id: validation.$id,
                $id: validation.$id
            }));

            throwIfStale();

            setValidations(normalizedValidations);

            didFetchSucceed = true;

        } catch (error) {
            // Elavult generáció: csendben eldobjuk — nincs user-látható mellékhatás.
            if (error instanceof StaleFetchError) {
                log(`[DataContext] ${error.message}`);
                return;
            }

            logError('[DataContext] Hiba:', error);
            if (isAuthError(error)) {
                didAuthError = true;
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                // Timeout ≠ offline: a szerver elérhető lehet, csak a lekérés lassú.
                // Háttérben (recovery után) ne zajongjunk toast-tal — a user már
                // dolgozik; a recovery lánc maga rendezi a következő trigger-nél.
                const isTimeout = error.message?.includes('időtúllépés');
                if (isTimeout) {
                    if (!isBackground) {
                        showToast('Lassú kapcsolat', TOAST_TYPES.WARNING, 'Az adatlekérés időtúllépés miatt megszakadt.');
                    }
                } else {
                    // Valódi hálózati hiba — offline overlay (háttérben is, mert a
                    // kapcsolat tényleges megszakadása mindig látható state).
                    const attempts = incrementAttempts();
                    setOffline(error, attempts);
                }
            } else if (!isBackground) {
                showToast('Adatok betöltése sikertelen', TOAST_TYPES.ERROR, error.message);
            }
            // Háttér (recovery utáni) fetch ismeretlen hibájánál a fentebbi logError elég —
            // a user-t nem zavarjuk, a következő recovery trigger majd rendezi.
        } finally {
            if (connectingDelayTimerId) clearTimeout(connectingDelayTimerId);

            // Csak a legfrissebb generáció állítja a loading state-et,
            // különben egy elavult fetch törölhetné az újabb loading jelzését
            if (generation === fetchGenerationRef.current) {
                if (!isBackground) {
                    setIsLoading(false);
                    setIsSwitchingPublication(false);
                }

                // Initialized flag: auth hibán kívül MINDEN terminal ágon true-ra
                // billen, hogy a Realtime feliratkozás elinduljon — hálózati hiba
                // után is (különben csak a RecoveryManager `dataRefreshRequested`
                // eseményére tudna indulni). Auth hibánál viszont értelmetlen a
                // feliratkozás (nincs session → a user Login-ra kerül).
                if (!didAuthError) {
                    setIsInitialized(true);
                }

                // Overlay tisztítás:
                // - Siker: ha korábban offline-ba mentünk (más útvonalon, pl. előző
                //   fetch), a sikeres REST bizonyítja, hogy a hálózat él → clear.
                // - Egyéb: a startConnecting által felhúzott isConnecting törlése.
                setConnectionStatus(prev => {
                    if (didFetchSucceed && prev.isOffline) {
                        return { ...prev, isOffline: false, isConnecting: false, message: null, details: null };
                    }
                    if (prev.isOffline) return prev; // Valódi hálózati hiba — offline marad
                    if (!prev.isConnecting) return prev; // Nincs mit tisztítani
                    return { ...prev, isConnecting: false, message: null, details: null };
                });
            }
        }
    }, [startConnecting, setOffline, setConnectionStatus, incrementAttempts, showToast]);

    // ═══════════════════════════════════════════════════════════════════════════
    // Inicializálás és Active Publication Váltás
    // ═══════════════════════════════════════════════════════════════════════════

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
                tableId: COLLECTIONS.ARTICLES,
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

    /**
     * Cikk frissítése az adatbázisban az `update-article` Cloud Function-ön keresztül.
     *
     * A Plugin NEM ír közvetlenül az `articles` collection-be — minden írás
     * ezen a CF-en fut át, amely szerver-oldalon validál és jogosultságot
     * ellenőriz (Fázis 9 follow-up). Fail-closed: ha a CF `permissionDenied`-et
     * jelez, a hívó `PermissionDeniedError`-t kap, és a hívó oldal kezeli
     * (toast + optimista UI revert).
     *
     * A helyi állapot frissítése az `applyArticleUpdate`-en keresztül történik,
     * amely `$updatedAt` staleness guardot alkalmaz — így egy párhuzamos másik
     * user CF írása (magasabb `$updatedAt`-tel, Realtime-on már érkezett) nem
     * íródik felül a saját, régebbi CF válaszunkkal.
     *
     * @param {string} articleId - A frissítendő cikk azonosítója.
     * @param {Object} data - A frissítendő mezők (csak engedett whitelist).
     * @returns {Promise<Object>} A szerver által visszaadott frissített dokumentum.
     * @throws {PermissionDeniedError} Ha a szerver 403-mal utasítja el a kérést.
     */
    const updateArticle = useCallback(async (articleId, data) => {
        const result = await callUpdateArticleCF(articleId, data, "DataContext: updateArticle");
        applyArticleUpdate(result);
        return result;
    }, [applyArticleUpdate]);

    /**
     * Cikk törlése az adatbázisból.
     *
     * @param {string} articleId - A törlendő cikk azonosítója.
     */
    const deleteArticle = useCallback(async (articleId) => {
        await withTimeout(
            tables.deleteRow({
                databaseId: DATABASE_ID,
                tableId: COLLECTIONS.ARTICLES,
                rowId: articleId
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: deleteArticle"
        );
        setArticles(prev => prev.filter(article => article.$id !== articleId));
    }, []);

    // ═══════════════════════════════════════════════════════════════════════════
    // Write-Through API — Felhasználói Validációk (User Validations)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Helyi validation-state frissítése egy szerver-válasz dokumentummal, DB hívás nélkül.
     * Az `applyArticleUpdate`-hez analóg minta: `$updatedAt` staleness guardot alkalmaz,
     * és normalizálja az `id`+`$id` duplát (a UI a duál mezőt használja).
     *
     * @param {Object} serverDocument - A szerver által visszaadott frissített validáció.
     */
    const applyValidationUpdate = useCallback((serverDocument) => {
        if (!serverDocument?.$id) return;
        const normalized = { ...serverDocument, id: serverDocument.$id, $id: serverDocument.$id };
        setValidations(prev => prev.map(validation => {
            if (validation.$id !== normalized.$id) return validation;
            // $updatedAt elavulás-védelem: ne írjunk felül frissebb adatot régebbivel
            if (validation.$updatedAt && normalized.$updatedAt && validation.$updatedAt > normalized.$updatedAt) {
                logWarn(`[DataContext] applyValidationUpdate elavult dokumentum kihagyva (${validation.$id})`);
                return validation;
            }
            return normalized;
        }));
    }, []);

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
                tableId: COLLECTIONS.USER_VALIDATIONS,
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
     * A helyi állapotot az `applyValidationUpdate`-en keresztül frissíti —
     * `$updatedAt` staleness guarddal, hogy egy párhuzamos írás (Realtime-on
     * már érkezett, magasabb `$updatedAt`-tel) ne íródjon felül a saját,
     * régebbi szerver válaszunkkal.
     *
     * @param {string} validationId - A frissítendő validáció azonosítója.
     * @param {Object} data - A frissítendő mezők.
     * @returns {Promise<Object>} A frissített dokumentum.
     */
    const updateValidation = useCallback(async (validationId, data) => {
        const result = await withTimeout(
            tables.updateRow({
                databaseId: DATABASE_ID,
                tableId: COLLECTIONS.USER_VALIDATIONS,
                rowId: validationId,
                data
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: updateValidation"
        );
        applyValidationUpdate(result);
        return result;
    }, [applyValidationUpdate]);

    /**
     * Validációs bejegyzés törlése.
     *
     * @param {string} validationId - A törlendő validáció azonosítója.
     */
    const deleteValidation = useCallback(async (validationId) => {
        await withTimeout(
            tables.deleteRow({
                databaseId: DATABASE_ID,
                tableId: COLLECTIONS.USER_VALIDATIONS,
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
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.PUBLICATIONS}.documents`,
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.ARTICLES}.documents`,
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.USER_VALIDATIONS}.documents`,
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.LAYOUTS}.documents`,
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.DEADLINES}.documents`,
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.GROUP_MEMBERSHIPS}.documents`,
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.WORKFLOWS}.documents`
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
            // Realtime eseményen. Normál Appwrite kézbesítési sorrend mellett a
            // $updatedAt staleness guard biztosítja, hogy a revert felülírja a
            // kezdeti aktivációt (a revert $updatedAt-ja frissebb). Halott
            // socket / reconnect / failover alatt viszont egy elveszett revert
            // esemény átmenetileg stale aktivált állapotot hagyhat — ez csak a
            // következő Realtime update vagy fetch konvergálás után oldódik.
            // A cikkek szerkesztése addig is blokkolva van, mert a scope query-k
            // (workflow, validations) nem találnak semmit a még nem létező DB állapothoz.
            if (event.includes(COLLECTIONS.PUBLICATIONS)) {
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
            else if (event.includes(COLLECTIONS.ARTICLES)) {
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
            else if (event.includes(COLLECTIONS.USER_VALIDATIONS)) {
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
            else if (event.includes(COLLECTIONS.LAYOUTS)) {
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
            else if (event.includes(COLLECTIONS.DEADLINES)) {
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
            else if (event.includes(COLLECTIONS.GROUP_MEMBERSHIPS)) {
                if (payload.editorialOfficeId && payload.editorialOfficeId !== activeEditorialOfficeIdRef.current) {
                    return; // Más szerkesztőség eseménye — ignoráljuk
                }
                const groupId = payload.groupId;
                log(`[DataContext] Csoporttagság változás (Realtime): groupId=${groupId}`);
                dispatchMaestroEvent(MaestroEvent.groupMembershipChanged, { groupId });
            }

            // --- Workflow ---
            // 2-way visibility (#30) alapján szűrünk: a payload látható, ha
            //  - visibility='editorial_office' ÉS editorialOfficeId === aktív office, VAGY
            //  - visibility='organization' ÉS organizationId === aktív org.
            // Legacy payload visibility=null → 'editorial_office' default.
            // A derived `workflow` memo automatikusan újraszámolódik a publikáció
            // workflowId-ja alapján, a workflowChanged event dispatch külön useEffect-ben.
            else if (event.includes(COLLECTIONS.WORKFLOWS)) {
                const payloadVisibility = payload.visibility || 'editorial_office';
                const currentOfficeId = activeEditorialOfficeIdRef.current;
                const currentOrgId = activeOrganizationIdRef.current;
                const isVisible = (
                    (payloadVisibility === 'editorial_office' && payload.editorialOfficeId === currentOfficeId)
                    || (payloadVisibility === 'organization' && payload.organizationId === currentOrgId)
                );
                if (!isVisible) {
                    // Visible → invisible átmenetkor a sort kivesszük a state-ből
                    // (pl. másik office `organization` → `editorial_office` átminősítés),
                    // különben ragadna. A `.delete` alul amúgy is $id alapján szűr.
                    if (event.includes(".update")) {
                        setWorkflows(prev => prev.filter(w => w.$id !== payload.$id));
                    }
                    if (!event.includes(".delete")) {
                        return;
                    }
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
