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
import { tables, ID, DATABASE_ID, PUBLICATIONS_COLLECTION_ID, ARTICLES_COLLECTION_ID, USER_VALIDATIONS_COLLECTION_ID, LAYOUTS_COLLECTION_ID, DEADLINES_COLLECTION_ID, Query } from "../config/appwriteConfig.js";
import { realtime } from "../config/realtimeClient.js";
import { useConnection } from "./ConnectionContext.jsx";
import { useToast } from "../../ui/common/Toast/ToastContext.jsx";
import { log, logError } from "../utils/logger.js";
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

    const activePublicationIdRef = useRef(activePublicationId);
    useEffect(() => {
        activePublicationIdRef.current = activePublicationId;
    }, [activePublicationId]);

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

        if (!isBackground) setIsLoading(true);

        // UI Feedback delay (csak ha nem background)
        const connectingDelayTimerId = !isBackground ? setTimeout(() => {
            startConnecting("Adatok betöltése...");
        }, 200) : null;

        try {
            log('[DataContext] Adatok lekérése...', { activePublicationId: currentPubId, generation });
            const cacheBustId = `cache-bust-${Date.now()}`;

            // 1. Publikációk lekérése (Mindig) — kritikus
            const publicationsPromise = withRetry(
                () => withTimeout(
                    tables.listRows({
                        databaseId: DATABASE_ID,
                        tableId: PUBLICATIONS_COLLECTION_ID,
                        queries: [
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
                articlesPromise = withRetry(
                    () => withTimeout(
                        tables.listRows({
                            databaseId: DATABASE_ID,
                            tableId: ARTICLES_COLLECTION_ID,
                            queries: [
                                Query.equal("publicationId", currentPubId),
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

    // Initial fetch — egyszer fut, amikor a komponens mountol
    useEffect(() => {
        fetchData();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Trigger fetch on publication change — a fetchData ref-ből olvassa a pubId-t.
    // Az isInitialized is kell a deps-ben, mert:
    //   1. PublicationList hamarabb állítja be az activePublicationId-t (localStorage restore),
    //      mint ahogy az initial fetch befejeződne (isInitialized = false → skip).
    //   2. Amikor az initial fetch kész és isInitialized = true, az activePublicationId
    //      már nem változik → az effect nem futna újra nélküle.
    useEffect(() => {
        if (isInitialized && activePublicationId !== null) {
            fetchData(false);
        }
    }, [activePublicationId, isInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

    // ═══════════════════════════════════════════════════════════════════════════
    // Write-Through API — Publikációk
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Új kiadvány létrehozása az adatbázisban.
     * A szerver válaszával azonnal frissíti a helyi state-et.
     *
     * @param {Object} data - A kiadvány adatai (name, rootPath, stb.)
     * @returns {Promise<Object>} A létrehozott dokumentum.
     */
    const createPublication = useCallback(async (data) => {
        const result = await withTimeout(
            tables.createRow({
                databaseId: DATABASE_ID,
                tableId: PUBLICATIONS_COLLECTION_ID,
                rowId: ID.unique(),
                data
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: createPublication"
        );
        setPublications(prev => {
            if (prev.some(pub => pub.$id === result.$id)) return prev;
            return [...prev, result].sort(compareByName);
        });
        return result;
    }, []);

    /**
     * Kiadvány frissítése az adatbázisban.
     *
     * @param {string} publicationId - A frissítendő kiadvány azonosítója.
     * @param {Object} data - A frissítendő mezők.
     * @returns {Promise<Object>} A frissített dokumentum.
     */
    const updatePublication = useCallback(async (publicationId, data) => {
        const result = await withTimeout(
            tables.updateRow({
                databaseId: DATABASE_ID,
                tableId: PUBLICATIONS_COLLECTION_ID,
                rowId: publicationId,
                data
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: updatePublication"
        );
        setPublications(prev => prev.map(publication => publication.$id === publicationId ? result : publication).sort(compareByName));
        return result;
    }, []);

    /**
     * Kiadvány törlése az adatbázisból.
     *
     * @param {string} publicationId - A törlendő kiadvány azonosítója.
     */
    const deletePublication = useCallback(async (publicationId) => {
        await withTimeout(
            tables.deleteRow({
                databaseId: DATABASE_ID,
                tableId: PUBLICATIONS_COLLECTION_ID,
                rowId: publicationId
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: deletePublication"
        );
        setPublications(prev => prev.filter(publication => publication.$id !== publicationId));
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
                data
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: createArticle"
        );
        setArticles(prev => {
            if (prev.some(article => article.$id === result.$id)) return prev;
            return [...prev, result].sort(compareByName);
        });
        return result;
    }, []);

    /**
     * Cikk frissítése az adatbázisban.
     *
     * @param {string} articleId - A frissítendő cikk azonosítója.
     * @param {Object} data - A frissítendő mezők.
     * @returns {Promise<Object>} A frissített dokumentum.
     */
    const updateArticle = useCallback(async (articleId, data) => {
        const result = await withTimeout(
            tables.updateRow({
                databaseId: DATABASE_ID,
                tableId: ARTICLES_COLLECTION_ID,
                rowId: articleId,
                data
            }),
            20000,
            "DataContext: updateArticle"
        );
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
        setArticles(prev => prev.map(article => article.$id === serverDocument.$id ? serverDocument : article).sort(compareByName));
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
                data
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
    }, []);

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
    // Write-Through API — Layoutok
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Új layout létrehozása az adatbázisban.
     *
     * @param {Object} data - A layout adatai (publicationId, name, order)
     * @returns {Promise<Object>} A létrehozott dokumentum.
     */
    const createLayout = useCallback(async (data) => {
        const result = await withTimeout(
            tables.createRow({
                databaseId: DATABASE_ID,
                tableId: LAYOUTS_COLLECTION_ID,
                rowId: ID.unique(),
                data
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: createLayout"
        );
        setLayouts(prev => {
            if (prev.some(l => l.$id === result.$id)) return prev;
            return [...prev, result].sort(compareByOrder);
        });
        return result;
    }, []);

    /**
     * Layout frissítése az adatbázisban.
     *
     * @param {string} layoutId - A frissítendő layout azonosítója.
     * @param {Object} data - A frissítendő mezők.
     * @returns {Promise<Object>} A frissített dokumentum.
     */
    const updateLayout = useCallback(async (layoutId, data) => {
        const result = await withTimeout(
            tables.updateRow({
                databaseId: DATABASE_ID,
                tableId: LAYOUTS_COLLECTION_ID,
                rowId: layoutId,
                data
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: updateLayout"
        );
        setLayouts(prev => prev.map(layout => layout.$id === layoutId ? result : layout).sort(compareByOrder));
        return result;
    }, []);

    /**
     * Layout törlése az adatbázisból.
     *
     * @param {string} layoutId - A törlendő layout azonosítója.
     */
    const deleteLayout = useCallback(async (layoutId) => {
        await withTimeout(
            tables.deleteRow({
                databaseId: DATABASE_ID,
                tableId: LAYOUTS_COLLECTION_ID,
                rowId: layoutId
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: deleteLayout"
        );
        setLayouts(prev => prev.filter(layout => layout.$id !== layoutId));
    }, []);

    // ═══════════════════════════════════════════════════════════════════════════
    // Write-Through API — Határidők (Deadlines)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Új határidő létrehozása az adatbázisban.
     *
     * @param {Object} data - A határidő adatai (publicationId, startPage, endPage, datetime)
     * @returns {Promise<Object>} A létrehozott dokumentum.
     */
    const createDeadline = useCallback(async (data) => {
        const result = await withTimeout(
            tables.createRow({
                databaseId: DATABASE_ID,
                tableId: DEADLINES_COLLECTION_ID,
                rowId: ID.unique(),
                data
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: createDeadline"
        );
        setDeadlines(prev => {
            if (prev.some(d => d.$id === result.$id)) return prev;
            return [...prev, result].sort(compareByStartPage);
        });
        return result;
    }, []);

    /**
     * Határidő frissítése az adatbázisban.
     *
     * @param {string} deadlineId - A frissítendő határidő azonosítója.
     * @param {Object} data - A frissítendő mezők.
     * @returns {Promise<Object>} A frissített dokumentum.
     */
    const updateDeadline = useCallback(async (deadlineId, data) => {
        const result = await withTimeout(
            tables.updateRow({
                databaseId: DATABASE_ID,
                tableId: DEADLINES_COLLECTION_ID,
                rowId: deadlineId,
                data
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: updateDeadline"
        );
        setDeadlines(prev => prev.map(deadline => deadline.$id === deadlineId ? result : deadline).sort(compareByStartPage));
        return result;
    }, []);

    /**
     * Határidő törlése az adatbázisból.
     *
     * @param {string} deadlineId - A törlendő határidő azonosítója.
     */
    const deleteDeadline = useCallback(async (deadlineId) => {
        await withTimeout(
            tables.deleteRow({
                databaseId: DATABASE_ID,
                tableId: DEADLINES_COLLECTION_ID,
                rowId: deadlineId
            }),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            "DataContext: deleteDeadline"
        );
        setDeadlines(prev => prev.filter(deadline => deadline.$id !== deadlineId));
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
            'teams'
        ];

        const unsubscribe = realtime.subscribe(channels, (response) => {
            const { events, payload } = response;
            const event = events[0];

            // --- Publikációk ---
            if (event.includes(PUBLICATIONS_COLLECTION_ID)) {
                setPublications(prev => {
                    if (event.includes(".update")) {
                        return prev.map(publication => {
                            if (publication.$id !== payload.$id) return publication;
                            // $updatedAt staleness guard
                            if (publication.$updatedAt && payload.$updatedAt && publication.$updatedAt > payload.$updatedAt) {
                                return publication;
                            }
                            return payload;
                        }).sort(compareByName);
                    } else if (event.includes(".create")) {
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
                }
            }

            // --- Határidők ---
            else if (event.includes(DEADLINES_COLLECTION_ID)) {
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

            // --- Csapattagság ---
            // A `teams` csatornáról jövő membership események (pl. teams.designers.memberships.*.create)
            else if (event.includes('teams.') && event.includes('.memberships.')) {
                const teamId = payload.teamId;
                log(`[DataContext] Csapattagság változás (Realtime): team=${teamId}`);
                dispatchMaestroEvent(MaestroEvent.teamMembershipChanged, { teamId });
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
        isLoading,
        isSwitchingPublication,
        activePublicationId,
        setActivePublicationId: updateActivePublicationId,
        fetchData,

        // Write-Through API — Publikációk
        createPublication,
        updatePublication,
        deletePublication,

        // Write-Through API — Cikkek
        createArticle,
        updateArticle,
        deleteArticle,
        applyArticleUpdate,

        // Write-Through API — Validációk
        createValidation,
        updateValidation,
        deleteValidation,

        // Write-Through API — Layoutok
        createLayout,
        updateLayout,
        deleteLayout,

        // Write-Through API — Határidők
        createDeadline,
        updateDeadline,
        deleteDeadline
    }), [
        publications, articles, validations, layouts, deadlines,
        isLoading, isSwitchingPublication, activePublicationId,
        updateActivePublicationId, fetchData,
        createPublication, updatePublication, deletePublication,
        createArticle, updateArticle, deleteArticle, applyArticleUpdate,
        createValidation, updateValidation, deleteValidation,
        createLayout, updateLayout, deleteLayout,
        createDeadline, updateDeadline, deleteDeadline
    ]);

    return (
        <DataContext.Provider value={value}>
            {children}
        </DataContext.Provider>
    );
};
