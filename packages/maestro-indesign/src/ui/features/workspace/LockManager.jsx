// React
import React, { useEffect, useRef } from "react";

// Contextusok és Egyedi Hook-ok
import { useUser } from "../../../core/contexts/UserContext.jsx";
import { useToast } from "../../common/Toast/ToastContext.jsx";
import { tables, Query, DATABASE_ID, ARTICLES_COLLECTION_ID } from "../../../core/config/appwriteConfig.js";

// Segédfüggvények
import { resolvePlatformPath, getCrossPlatformPaths } from "../../../core/utils/pathUtils.js";
import { SCRIPT_LANGUAGE_JAVASCRIPT, LOCK_TYPE } from "../../../core/utils/constants.js";
import { withTimeout } from "../../../core/utils/promiseUtils.js";
import { isIndexNotFoundError } from "../../../core/utils/errorUtils.js";
import { getOpenDocumentPaths, getIndesignApp, generateGetActiveDocumentPathScript } from "../../../core/utils/indesign/index.js";
import { WorkflowEngine } from "../../../core/utils/workflow/workflowEngine.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../../core/config/maestroEvents.js";

// InDesign Application objektum importálása (Lustán töltve)
// const app = require("indesign").app; <-- Törölve, helyette getIndesignApp() a komponensen belül

/**
 * LockManager Komponens
 * 
 * Ez a komponens felelős az InDesign fájlok zárolásának (lock) és feloldásának (unlock)
 * automatikus kezeléséért a Maestro rendszerben.
 * 
 * Működése:
 * 1. Figyeli az InDesign eseményeket (megnyitás, bezárás, mentés másként).
 * 2. Amikor egy fájl megnyílik, megpróbálja "zárolni" az adatbázisban a jelenlegi felhasználó számára.
 * 3. Amikor egy fájl bezáródik, "feloldja" a zárolást.
 * 4. Szinkronizálja a helyi állapotot az adatbázissal (pl. indításkor vagy hiba után).
 * 
 * @returns {null} Ez egy logikai komponens, vizuálisan nem renderel semmit (null).
 */
export const LockManager = () => {
    // 1. Felhasználói környezet
    const { user } = useUser();
    const { showToast } = useToast();

    // 2. Ref-ek a komponens élettartamának követésére
    // Segít elkerülni a memóriaszivárgást aszinkron műveleteknél, ha a komponens már nincs felcsatolva.
    const isMountedRef = useRef(true);
    const timeoutsRef = useRef([]);
    const syncLocksTimeoutRef = useRef(null);
    const isVerifyingRef = useRef(false);

    /**
     * Cikk keresése útvonal alapján a lekérdezés eredményében.
     * Kereszt-platformos egyezést is vizsgál (Mac/Win útvonalak).
     *
     * @param {Array} rows - Az adatbázisból lekérdezett cikkek.
     * @param {string} path - A keresett fájl natív útvonala.
     * @returns {Object|undefined} A megtalált cikk, vagy undefined.
     */
    const findArticleByPath = (rows, path) => {
        const mappedPath = resolvePlatformPath(path);
        const searchPaths = getCrossPlatformPaths(path) || [];
        return rows?.find(article => {
            const dbPaths = getCrossPlatformPaths(article.filePath) || [];
            return dbPaths.some(dbPath => dbPath.toLowerCase() === mappedPath.toLowerCase())
                || searchPaths.some(searchPath => searchPath.toLowerCase() === article.filePath.toLowerCase());
        });
    };

    /**
     * Biztonságos setTimeout wrapper.
     * Csak akkor futtatja le a callback-et, ha a komponens még létezik (mounted).
     * 
     * @param {Function} callback - A késleltetve futtatandó függvény.
     * @param {number} delay - Késleltetés milliszekundumban.
     * @returns {number} A timeout azonosítója.
     */
    const safeSetTimeout = (callback, delay) => {
        const timeoutId = setTimeout(() => {
            if (isMountedRef.current) {
                Promise.resolve(callback()).catch(error =>
                    console.error('[LockManager] safeSetTimeout error:', error)
                );
            }
            // Törlés a listából futás után
            timeoutsRef.current = timeoutsRef.current.filter(id => id !== timeoutId);
        }, delay);
        timeoutsRef.current.push(timeoutId);
        return timeoutId;
    };

    /**
     * Orphaned lockok takarítása induláskor.
     * Törli azokat a lockokat, ahol lockOwnerId === user.$id
     * Ez kezeli azt az esetet, amikor az InDesign lefagyott és a lockok bent maradtak.
     */
    const cleanupOrphanedLocks = async () => {
        if (!user || !isMountedRef.current) return;

        try {
            console.log('[LockManager] Orphaned lockok takarítása induláskor...');

            // Egyszerű query: minden lock ahol én vagyok az owner
            const orphanedQueries = [
                Query.equal("lockOwnerId", user.$id)
            ];

            const response = await withTimeout(
                tables.listRows({
                    databaseId: DATABASE_ID,
                    tableId: ARTICLES_COLLECTION_ID,
                    queries: orphanedQueries,
                    limit: 100
                }),
                30000,
                "LockManager: cleanupOrphanedLocks"
            );

            if (!isMountedRef.current) return;

            // Minden talált lockot törlünk
            for (const article of response.rows) {
                if (!isMountedRef.current) break;
                try {
                    await tables.updateRow({
                        databaseId: DATABASE_ID,
                        tableId: ARTICLES_COLLECTION_ID,
                        rowId: article.$id,
                        data: {
                            lockType: null,
                            lockOwnerId: null
                        }
                    });
                    console.log(`[LockManager] Orphaned lock törölve: ${article.name}`);
                } catch (error) {
                    console.error(`[LockManager] Orphaned lock törlése sikertelen (${article.name}):`, error);
                }
            }

            if (response.rows.length > 0) {
                console.log(`[LockManager] ${response.rows.length} orphaned lock törölve.`);
            }
        } catch (error) {
            console.error('[LockManager] Orphaned lock cleanup hiba:', error);
            if (isIndexNotFoundError(error)) {
                showToast('Adatbázis konfigurációs hiba', 'error', 'Hiányzó index (lockOwnerId). Kérjük, értesítsd a rendszergazdát.');
            }
        }
    };

    /**
     * Releváns cikkek lekérdezése az adatbázisból.
     * Kétféle cikket keres:
     * 1. Ami a jelenlegi felhasználó által van zárolva (takarításhoz).
     * 2. Ami jelenleg meg van nyitva az InDesign-ban (zároláshoz).
     * 
     * @param {string[]} openPaths - A jelenleg megnyitott InDesign fájlok útvonalai.
     * @returns {Promise<{rows: Array}>} A releváns cikkek egyesített listája.
     */
    const fetchRelevantArticles = async (openPaths = []) => {
        // Query 1: Amit ÉN zároltam (hogy feloldhassam, ha már nincs nyitva)
        const cleanupQuery = [Query.equal("lockOwnerId", user.$id)];

        // Útvonal variációk generálása (Mac/Win validációhoz)
        let pathVariants = [];
        if (openPaths.length > 0) {
            openPaths.forEach(openPath => {
                const paths = getCrossPlatformPaths(openPath);
                if (paths && Array.isArray(paths)) {
                    pathVariants.push(...paths);
                }
            });
        }

        // Query 2: Ami most nyitva van (hogy zárolhassam, ha még nincs)
        const openFilesQuery = pathVariants.length > 0 ? [Query.equal("filePath", pathVariants)] : null;

        // Párhuzamos lekérdezések futtatása timeout-tal
        const promises = [
            withTimeout(
                tables.listRows({
                    databaseId: DATABASE_ID,
                    tableId: ARTICLES_COLLECTION_ID,
                    queries: cleanupQuery,
                    limit: 100
                }),
                30000, "LockManager: listRows (cleanup)"
            )
        ];

        if (openFilesQuery) {
            promises.push(
                withTimeout(
                    tables.listRows({
                        databaseId: DATABASE_ID,
                        tableId: ARTICLES_COLLECTION_ID,
                        queries: openFilesQuery,
                        limit: 100
                    }),
                    30000, "LockManager: listRows (open files)"
                )
            );
        }

        const results = await Promise.all(promises);

        // Eredmények összefésülése (duplikátumok szűrése ID alapján)
        const combined = new Map();
        results.forEach(result => {
            if (result && result.rows && Array.isArray(result.rows)) {
                result.rows.forEach(row => combined.set(row.$id, row));
            }
        });

        return { rows: Array.from(combined.values()) };
    };

    /**
     * Egy konkrét fájl zárolása az adatbázisban a jelenlegi felhasználó nevére.
     * 
     * @param {string} path - A zárolandó dokumentum natív fájlútvonala.
     */
    const lockFile = async (path) => {
        if (!user || !isMountedRef.current) return;
        try {
            const searchPaths = getCrossPlatformPaths(path) || [];

            // 1. Megkeressük a cikket az útvonal alapján
            const response = await withTimeout(
                tables.listRows({
                    databaseId: DATABASE_ID,
                    tableId: ARTICLES_COLLECTION_ID,
                    queries: [Query.equal("filePath", searchPaths)],
                    limit: 10
                }),
                30000,
                "LockManager: listRows"
            );

            const article = findArticleByPath(response?.rows, path);

            if (article && isMountedRef.current) {
                // Ha MÁS valaki már zárolta, nem vesszük el tőle!
                if (article.lockOwnerId && article.lockOwnerId !== user.$id) {
                    console.warn('[LockManager] A fájlt már zárolta más felhasználó. Zárolás sikertelen.');
                    return;
                }

                // Ha nincs zárolva, vagy mi zároltuk (megerősítés), akkor írjuk be
                const lockResult = await WorkflowEngine.lockDocument(article, LOCK_TYPE.USER, user);
                if (lockResult.success) {
                    console.log('[LockManager] Fájl zárolva:', article.name, '-', user.name);
                    // Kényszerített frissítés a UI szinkronizálásához
                    dispatchMaestroEvent(MaestroEvent.dataRefreshRequested);
                } else {
                    console.warn('[LockManager] Zárolás sikertelen:', lockResult.error);
                    showToast('A dokumentum zárolása sikertelen', 'error', lockResult.error || 'Nem sikerült zárolni a fájlt. Próbáld meg újra.');
                }
            }
        } catch (error) {
            if (isMountedRef.current) {
                console.error("Hiba a fájl zárolásakor:", error);
            }
        }
    };

    /**
     * Egy konkrét fájl feloldása (unlock) az adatbázisban.
     * Csak akkor oldja fel, ha a jelenlegi felhasználó tartja a zárolást.
     * 
     * @param {string} path - A feloldandó dokumentum natív fájlútvonala.
     */
    const unlockFile = async (path) => {
        if (!user || !isMountedRef.current) return;
        try {
            const searchPaths = getCrossPlatformPaths(path) || [];

            const response = await withTimeout(
                tables.listRows({
                    databaseId: DATABASE_ID,
                    tableId: ARTICLES_COLLECTION_ID,
                    queries: [Query.equal("filePath", searchPaths)],
                    limit: 10
                }),
                30000,
                "LockManager: listRows (unlock)"
            );

            const article = findArticleByPath(response?.rows, path);

            if (article && article.lockOwnerId === user.$id && isMountedRef.current) {
                const unlockResult = await WorkflowEngine.unlockDocument(article, user);
                if (unlockResult.success) {
                    console.log('[LockManager] Fájl feloldva:', article.name);
                    // Kényszerített frissítés a UI szinkronizálásához
                    dispatchMaestroEvent(MaestroEvent.dataRefreshRequested);
                }
            }
        } catch (error) {
            if (isMountedRef.current) {
                console.error("Hiba a fájl feloldásakor:", error);
            }
        }
    };

    /**
     * Teljes szinkronizáció (Sync Locks).
     * 
     * Ez a függvény a rendszer "lelke". Összehasonlítja a valóságot (InDesign nyitott fájlok)
     * az adatbázis állapotával, és korrigálja az eltéréseket.
     * 
     * Logika:
     * 1. Lekéri az összes nyitott InDesign dokumentum útvonalát (ExtendScript segítségével).
     * 2. Lekéri az adatbázisból a releváns cikkeket.
     * 3. Minden cikkre:
     *    - Ha NYITVA van a gépen ÉS (nincs zárolva VAGY én zároltam) -> ZÁROLÁS (Lock).
     *    - Ha NINCS nyitva a gépen DE én zároltam -> FELOLDÁS (Unlock).
     */
    const syncLocks = async () => {
        const app = getIndesignApp();
        if (!user || !isMountedRef.current || !app) return;

        try {
            // ExtendScript: Nyitott dokumentumok listázása a segédfüggvény használatával
            const rawOpenDocPaths = await getOpenDocumentPaths(app);
            if (!rawOpenDocPaths || !Array.isArray(rawOpenDocPaths)) {
                console.warn('[LockManager] Nincs érvényes dokumentum lista');
                return;
            }
            const openDocPaths = rawOpenDocPaths.map(rawPath => resolvePlatformPath(rawPath));

            // Releváns cikkek lekérése
            const response = await fetchRelevantArticles(rawOpenDocPaths);
            if (!isMountedRef.current) return;

            const articles = response?.rows || [];

            // Iterálás és állapotjavítás
            for (const article of articles) {
                if (!isMountedRef.current) break;

                try {
                    if (!article.filePath) continue;

                    const mappedPath = resolvePlatformPath(article.filePath);
                    // Ellenőrizzük, hogy a DB-beli cikk nyitva van-e a helyi gépen
                    const isLocallyOpen = openDocPaths.some(openPath => openPath.toLowerCase() === mappedPath.toLowerCase());

                    // Ha a Maestro rendszer zárolta (validálás folyamatban), ne nyúljunk hozzá!
                    if (article.lockType === LOCK_TYPE.SYSTEM) {
                        console.log(`[LockManager] Kihagyva: ${article.name} (Maestro validál)`);
                        continue;
                    }

                    if (isLocallyOpen && (!article.lockOwnerId || article.lockOwnerId === user.$id)) {
                        // NYITVA van + Nincs Lock (vagy saját) => LOCKOLÁS
                        const result = await WorkflowEngine.lockDocument(article, LOCK_TYPE.USER, user);
                        if (result.success) {
                            console.log('[LockManager] Fájl zárolva:', article.name, '-', user.name);
                        } else {
                            console.warn(`[LockManager] Zárolás sikertelen (${article.name}, ${article.$id}):`, result.error);
                        }
                    } else if (!isLocallyOpen && article.lockOwnerId === user.$id) {
                        // NINCS nyitva + Saját Lock => UNLOCKOLÁS (Takarítás)
                        const result = await WorkflowEngine.unlockDocument(article, user);
                        if (result.success) {
                            console.log('[LockManager] Fájl feloldva:', article.name);
                        } else {
                            console.warn(`[LockManager] Feloldás sikertelen (${article.name}, ${article.$id}):`, result.error);
                        }
                    }
                } catch (innerError) {
                    console.error(`Hiba a szinkronizációnál (${article.name}):`, innerError);
                }
            }
        } catch (error) {
            if (isMountedRef.current) {
                console.error("Startup lock sync failed:", error);
                if (isIndexNotFoundError(error)) {
                    showToast('Adatbázis konfigurációs hiba', 'error', 'Hiányzó index (lockOwnerId). Kérjük, értesítsd a rendszergazdát.');
                } else {
                    // showToast("Szinkronizációs hiba: " + error.message, "warning"); // Opcionális, ne legyen zavaró
                }
            }
        }
    };

    /**
     * Debounce-olt syncLocks hívás.
     * Ha rövid időn belül többször is meghívják (pl. több fájl gyors nyitása/zárása),
     * csak az utolsó hívás fut le ténylegesen.
     *
     * @param {number} [delay=300] - Késleltetés milliszekundumban.
     */
    const debouncedSyncLocks = (delay = 300) => {
        if (syncLocksTimeoutRef.current) {
            clearTimeout(syncLocksTimeoutRef.current);
        }
        syncLocksTimeoutRef.current = safeSetTimeout(() => {
            syncLocksTimeoutRef.current = null;
            syncLocks().catch(error => {
                if (isMountedRef.current) {
                    console.error("[LockManager] Debounced sync failed:", error);
                }
            });
        }, delay);
    };

    // Eseményfigyelők beállítása (Effect)
    useEffect(() => {
        if (!user) return;

        const app = getIndesignApp();
        if (!app) {
            console.warn("[LockManager] InDesign app object not available.");
            return;
        }

        isMountedRef.current = true;

        // Orphaned lockok takarítása, majd szinkronizáció
        // Sorrend fontos: először töröljük a régi lockokat, aztán újra lockoljuk a nyitott fájlokat
        cleanupOrphanedLocks().then(() => {
            if (isMountedRef.current) {
                syncLocks();
            }
        });

        /**
         * Eseménykezelő: Fájl megnyitása után (afterOpen)
         * Késleltetéssel fut (200ms), hogy az InDesign biztosan betöltse a dokumentumot.
         */
        const handleAfterOpen = (event) => {
            try {
                // HA a DocumentMonitor épp validál (háttérben nyitotta meg), akkor NE zároljuk!
                if (isVerifyingRef.current) {
                    console.log("[LockManager] handleAfterOpen kihagyása (Validáció folyamatban)");
                    return;
                }

                if (!isMountedRef.current) return;
                safeSetTimeout(async () => {
                    try {
                        if (!isMountedRef.current) return;

                        let target = event.target;

                        if (target && target.constructor.name === "LayoutWindow") {
                            target = target.parent;
                        }

                        if (!target || target.isValid === false) {
                            syncLocks();
                            return;
                        }

                        const isDocument = target.constructor &&
                            (target.constructor.name === "Document" || target.toString().includes("Document"));

                        if (!isDocument || !target.saved) return;

                        const filePath = await app.doScript(generateGetActiveDocumentPathScript(), SCRIPT_LANGUAGE_JAVASCRIPT, []);

                        if (filePath) {
                            lockFile(filePath).catch(error => console.error("Lock error:", error));
                        }
                    } catch (error) {
                        syncLocks();
                    }
                }, 200);
            } catch (error) {
                console.error("Error in afterOpen listener:", error);
            }
        };

        /**
         * Eseménykezelő: Fájl bezárása után (afterClose)
         * Figyeli, ha a felhasználó bezár egy ablakot.
         */
        const handleAfterClose = (event) => {
            try {
                if (!isMountedRef.current) return;
                // Kicsit hosszabb késleltetés (500ms), hogy az ablak biztosan eltűnjön a listából
                debouncedSyncLocks(500);
            } catch (error) {
                if (isMountedRef.current) {
                    console.error("Error in afterClose listener:", error);
                }
            }
        };

        /**
         * Eseménykezelő: Mentés másként (afterSaveAs)
         * Ha átneveznek egy fájlt, a régit fel kell oldani (ha bezáródott), az újat zárolni.
         * A syncLocks() ezt automatikusan kezeli.
         */
        const handleAfterSaveAs = (event) => {
            try {
                if (!isMountedRef.current) return;
                debouncedSyncLocks(200);
            } catch (error) {
                if (isMountedRef.current) {
                    console.error("Error in afterSaveAs listener:", error);
                }
            }
        };

        /**
         * Manuális ellenőrzés (maestro:lock-check-requested)
         * Ezt az eseményt a rendszer más részei (pl. useArticles) váltják ki,
         * ha programozottan nyitnak meg fájlt, kikerülve a GUI eseményeket.
         */
        const handleManualCheck = () => {
            if (isMountedRef.current) {
                console.log('[LockManager] Manuális ellenőrzés kényszerítve');
                syncLocks().catch(error => console.error("Manual sync failed:", error));
            }
        };

        // Verification event handlerek (DocumentMonitor jelzi, ha validálás indul/végződik)
        const handleVerificationStart = () => { isVerifyingRef.current = true; };
        const handleVerificationEnd = () => { isVerifyingRef.current = false; };

        // Feliratkozás az InDesign és DOM eseményekre
        const afterOpenListener = app.addEventListener("afterOpen", handleAfterOpen);
        const afterCloseListener = app.addEventListener("afterClose", handleAfterClose);
        const afterSaveAsListener = app.addEventListener("afterSaveAs", handleAfterSaveAs);
        window.addEventListener(MaestroEvent.lockCheckRequested, handleManualCheck);
        window.addEventListener(MaestroEvent.verificationStarted, handleVerificationStart);
        window.addEventListener(MaestroEvent.verificationEnded, handleVerificationEnd);

        // Takarítás (Cleanup) a komponens megszűnésekor
        return () => {
            isMountedRef.current = false;
            // Timeoutok törlése
            timeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
            timeoutsRef.current = [];
            if (syncLocksTimeoutRef.current) {
                clearTimeout(syncLocksTimeoutRef.current);
                syncLocksTimeoutRef.current = null;
            }

            // Eseményfigyelők eltávolítása
            window.removeEventListener(MaestroEvent.lockCheckRequested, handleManualCheck);
            window.removeEventListener(MaestroEvent.verificationStarted, handleVerificationStart);
            window.removeEventListener(MaestroEvent.verificationEnded, handleVerificationEnd);
            // InDesign leiratkozások (try-catch, mert kilépéskor hibát dobhatnak)
            try { afterOpenListener.remove(); } catch (_) { /* InDesign kilépéskor hibát dobhat */ }
            try { afterCloseListener.remove(); } catch (_) { /* InDesign kilépéskor hibát dobhat */ }
            try { afterSaveAsListener.remove(); } catch (_) { /* InDesign kilépéskor hibát dobhat */ }
        };
    }, [user]);

    return null;
};