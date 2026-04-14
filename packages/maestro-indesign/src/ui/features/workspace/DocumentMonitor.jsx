// React
import React, { useEffect, useRef, useState } from "react";

// Contextusok & Egyedi Hook-ok
import { useUser } from "../../../core/contexts/UserContext.jsx";
import { useToast } from "../../common/Toast/ToastContext.jsx";
import { useData } from "../../../core/contexts/DataContext.jsx";

// Segédprogramok (Utils)
import { toCanonicalPath, getArticleCanonicalPath, toAbsoluteArticlePath } from "../../../core/utils/pathUtils.js";
import {
    findActiveDocument,
    getDocPath,
    resolveTargetToDoc,
    getFileTimestamp,
    getOpenDocumentPaths,
    getIndesignApp
} from "../../../core/utils/indesign/indesignUtils.js";
import { WorkflowEngine } from "../../../core/utils/workflow/workflowEngine.js";
import { LOCK_TYPE, LOCK_WAIT_CONFIG, TOAST_TYPES } from "../../../core/utils/constants.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../../core/config/maestroEvents.js";
import { log, logWarn, logError } from "../../../core/utils/logger.js";



/**
 * DocumentMonitor Komponens
 *
 * Ez a komponens felelős az InDesign dokumentum életciklus-események (mentés, bezárás)
 * jelzéséért az event rendszeren keresztül. A validátorok önállóan feliratkoznak
 * a számukra releváns eseményekre.
 *
 * Fő triggerek:
 * 1. afterSave esemény → dispatol `MaestroEvent.documentSaved`
 * 2. Realtime Unlock Detektálás → dispatol `MaestroEvent.documentClosed` (registerTask mintával)
 *
 * Infrastrukturális feladatok:
 * - System lock kezelés (bezáráskor)
 * - Fájl-hozzáférés várakozás (polling)
 * - Timestamp optimalizáció (változatlan fájl kihagyása)
 * - `MaestroEvent.verificationStarted/Ended` jelzés a LockManager felé
 */
export const DocumentMonitor = () => {
    const { user } = useUser();
    const { showToast, removeToast } = useToast();
    const { articles, publications, applyArticleUpdate } = useData();

    // Referenciák
    const isDocumentMonitorMountedRef = useRef(true);
    const isVerifyingRef = useRef(false);
    const latestArticlesRef = useRef(articles);
    const publicationsRef = useRef(publications);
    const previousLocksRef = useRef({});
    const pendingUnlockRef = useRef(new Set());

    // Verifikáció végét jelző számláló — a pending unlock-ok feldolgozásának triggerelésére.
    // Ha verifikáció befejezésekor vannak még várakozó unlock-ok, a számláló növelése
    // kikényszeríti a useEffect újrafutását (mivel a dependency listában szerepel).
    const [verificationEndTick, setVerificationEndTick] = useState(0);

    /**
     * Timestamp cache a változatlan fájlok kihagyásához.
     * Session-szintű optimalizáció: plugin újratöltéskor törlődik.
     */
    const lastValidatedTimestampsRef = useRef({});

    // Mindig frissítjük a ref-eket, ha változik a context adat
    useEffect(() => { latestArticlesRef.current = articles; }, [articles]);
    useEffect(() => { publicationsRef.current = publications; }, [publications]);

    /**
     * Megkeres egy cikket a globális Context-ben a fájl útvonala alapján.
     * Kanonikus útvonal-összehasonlítást használ (platform-független).
     */
    const fetchArticle = (nativePath) => {
        try {
            if (!latestArticlesRef.current?.length) return null;
            const searchCanonical = toCanonicalPath(nativePath).toLowerCase();
            const pubs = publicationsRef.current;
            return latestArticlesRef.current.find(a => {
                return getArticleCanonicalPath(a, pubs).toLowerCase() === searchCanonical;
            }) || null;
        } catch (error) {
            logError("[DocumentMonitor] fetchArticle hiba:", error);
            return null;
        }
    };

    /**
     * Háttérbeli ellenőrzés "Maestro" rendszer zárolással.
     *
     * Infrastruktúrát kezel (system lock, file wait), majd dispatolja a
     * `MaestroEvent.documentClosed` eventet a registerTask mintával.
     * A validátorok a saját hookjaikban feliratkoznak és regisztrálják a feladataikat.
     */
    const verifyDocumentInBackground = async (filePath, article) => {
        // MEGJEGYZÉS: isVerifyingRef-et a hívó kezeli a versenyhelyzet elkerülése érdekében
        if (!article?.$id) {
            logWarn("[DocumentMonitor] verifyDocumentInBackground: Nincs article!");
            return;
        }

        // OPTIMALIZÁCIÓ: Timestamp ellenőrzés (változatlan fájl kihagyása)
        try {
            const currentTimestamp = await getFileTimestamp(filePath);
            const lastTimestamp = lastValidatedTimestampsRef.current[article.$id];

            if (currentTimestamp && lastTimestamp && currentTimestamp === lastTimestamp) {
                log(`[DocumentMonitor] Kihagyva (változatlan): ${article.name}`);
                return; // Fájl nem változott, nincs validálás
            }
            // NE mentsük el itt a timestampot - csak sikeres validálás után!
        } catch (e) {
            // Ha nem sikerül timestampot olvasni, folytatjuk a validálást
        }

        let toastId = null;
        let lockedArticle = null;
        try {
            // Optimistic update — azonnal megjelenítjük a MAESTRO feliratot az ArticleTable-ben,
            // nem várjuk meg a DB zárolás hálózati késleltetését.
            applyArticleUpdate({
                ...article,
                lockType: LOCK_TYPE.SYSTEM,
                lockOwnerId: user.$id
            });

            // isVerifyingRef.current már a hívó által true-ra van állítva
            dispatchMaestroEvent(MaestroEvent.verificationStarted);
            toastId = showToast("Lezárt dokumentum ellenőrzése...", TOAST_TYPES.INFO);

            // Maestro zárolás
            const lockResult = await WorkflowEngine.lockDocument(article, LOCK_TYPE.SYSTEM, user);
            if (!lockResult.success) {
                logWarn("[DocumentMonitor] Nem sikerült zárolni a dokumentumot:", lockResult.error);
                if (toastId) removeToast(toastId);
                return; // finally block küldi a verificationEnded-et
            }
            // Fontos: A returned document-ben már benne van a lock infó!
            lockedArticle = lockResult.document;
            applyArticleUpdate(lockedArticle);

            // Várakozás, amíg az InDesign fájl zárolása feloldódik (polling loop)
            const lockWaitStart = Date.now();
            let fileLockReleased = false;

            while (Date.now() - lockWaitStart < LOCK_WAIT_CONFIG.TIMEOUT_MS) {
                try {
                    // Ha sikerül olvasni a fájl timestampját, a zárolás feloldódott
                    const ts = await getFileTimestamp(filePath);
                    if (ts) {
                        fileLockReleased = true;
                        break;
                    }
                } catch (e) {
                    // Fájl még zárolva van, folytatjuk a pollingot
                }
                await new Promise(resolve => setTimeout(resolve, LOCK_WAIT_CONFIG.POLL_INTERVAL_MS));
            }

            if (!fileLockReleased) {
                logWarn(`[DocumentMonitor] Lock wait timeout (${LOCK_WAIT_CONFIG.TIMEOUT_MS}ms) for: ${article.name}`);
                // Folytatjuk a validálást timeout esetén is, hátha sikerül
            }

            // Friss article adat a latestArticlesRef-ből, hogy a validátorok a legfrissebb
            // állapottal dolgozzanak (pl. state, pageRanges, amelyek a system lock alatt változhattak).
            const freshArticle = latestArticlesRef.current.find(a => a.$id === article.$id) || article;

            // Event dispatch a registerTask mintával
            // A DOM events szinkronok: minden handler lefut mielőtt dispatchEvent visszatér.
            // A handlerek registerTask-kal regisztrálják a Promise-aikat.
            const tasks = [];
            dispatchMaestroEvent(MaestroEvent.documentClosed, {
                article: freshArticle,
                filePath,
                registerTask: (promise) => tasks.push(promise)
            });

            // Megvárjuk az összes regisztrált feladatot
            if (tasks.length > 0) {
                log(`[DocumentMonitor] ${tasks.length} validációs feladat fut: ${article.name}`);
                await Promise.all(tasks);
            }

            // Sikeres validálás után friss timestamp mentése
            try {
                const freshTimestamp = await getFileTimestamp(filePath);
                if (freshTimestamp) {
                    lastValidatedTimestampsRef.current[article.$id] = freshTimestamp;
                }
            } catch (e) {
                // Timestamp mentés sikertelen
            }

        } catch (err) {
            logError("[DocumentMonitor] Háttér ellenőrzés hiba:", err);
        } finally {
            // Maestro zárolás feloldása / optimistic update visszavonása
            try {
                if (lockedArticle) {
                    // Normál útvonal: DB-ben megerősített lock feloldása
                    const unlockResult = await WorkflowEngine.unlockDocument(lockedArticle, user);
                    if (unlockResult?.success && unlockResult.document) {
                        applyArticleUpdate(unlockResult.document);
                    }
                } else {
                    // DB lock nem sikerült — optimistic update visszavonása
                    applyArticleUpdate({
                        ...article,
                        lockType: null,
                        lockOwnerId: null
                    });
                }
            } catch (unlockErr) {
                logError("[DocumentMonitor] Maestro unlock hiba:", unlockErr);
            }

            if (toastId) removeToast(toastId);
            // isVerifyingRef.current-et a hívó állítja false-ra
            dispatchMaestroEvent(MaestroEvent.verificationEnded);
        }
    };

    /**
     * Realtime Unlock Detektálás (kétfázisú)
     *
     * 1. FÁZIS — Lock tracking: MINDIG frissíti a previousLocksRef-et és a pending queue-t,
     *    verifikáció alatt is. Így a lock állapot soha nem csúszik el.
     *
     * 2. FÁZIS — Unlock feldolgozás: Csak ha NEM fut verifikáció. A pending queue-ból
     *    kiveszi az első elemet és elindítja a háttér validálást.
     *
     * A verificationEndTick dependency biztosítja, hogy verifikáció végén,
     * ha vannak még pending unlock-ok, a useEffect újrafusson.
     */
    useEffect(() => {
        if (!user || !articles?.length) return;

        // ── 1. FÁZIS: Lock tracking (MINDIG lefut) ──
        for (const article of articles) {
            const prev = previousLocksRef.current[article.$id];
            const currentLock = article.lockOwnerId;

            if (prev?.lockOwnerId === user.$id && prev?.lockType !== LOCK_TYPE.SYSTEM && currentLock === null) {
                // USER unlock detektálva → pending queue-ba
                // System lock feloldásokat kihagyjuk: azokat a DocumentMonitor saját maga végzi,
                // és nem szabad újra-triggerelni a verifikációt.
                pendingUnlockRef.current.add(article.$id);
            } else if (currentLock !== null) {
                // Újrazárolva → eltávolítjuk a pending queue-ból (már nem releváns)
                pendingUnlockRef.current.delete(article.$id);
            }

            previousLocksRef.current[article.$id] = {
                lockOwnerId: currentLock,
                lockType: article.lockType
            };
        }

        // ── 2. FÁZIS: Pending unlock feldolgozás (csak ha NEM fut verifikáció) ──
        if (isVerifyingRef.current || pendingUnlockRef.current.size === 0) return;

        const firstId = pendingUnlockRef.current.values().next().value;
        pendingUnlockRef.current.delete(firstId);

        const unlockTarget = articles.find(a => a.$id === firstId);
        // Ha menet közben újrazárolták, kihagyjuk
        if (!unlockTarget || unlockTarget.lockOwnerId !== null) return;

        // Atomikus foglalás SZINKRON részben a versenyhelyzet elkerülésére
        isVerifyingRef.current = true;

        // IIFE az aszinkron InDesign-ellenőrzéshez
        (async () => {
            try {
                // Nyitott fájl ellenőrzés — ha még nyitva van, a LockManager újrazárolja
                const appInstance = getIndesignApp();

                if (appInstance) {
                    const openPaths = await getOpenDocumentPaths(appInstance);
                    if (openPaths) {
                        const articleCanonical = getArticleCanonicalPath(unlockTarget, publicationsRef.current).toLowerCase();
                        const isOpen = openPaths.some(p => {
                            return toCanonicalPath(p).toLowerCase() === articleCanonical;
                        });

                        if (isOpen) {
                            log(`[DocumentMonitor] Unlock detektálva, de a fájl NYITVA van (LockManager újrazárolja): ${unlockTarget.name}`);
                            return; // SKIP VERIFICATION
                        }
                    }
                }

                // Friss article a latestArticlesRef-ből (a verifikáció a legfrissebb adattal induljon)
                const freshArticle = latestArticlesRef.current.find(a => a.$id === unlockTarget.$id) || unlockTarget;
                log(`[DocumentMonitor] Realtime unlock: ${freshArticle.name}`);

                // Relatív filePath → abszolút natív útvonal (ExtendScript File() nem tud relatívat feloldani)
                const pub = publicationsRef.current?.find(p => p.$id === freshArticle.publicationId);
                let absolutePath;
                if (pub?.rootPath) {
                    absolutePath = toAbsoluteArticlePath(freshArticle.filePath, pub.rootPath);
                } else {
                    logWarn(
                        `[DocumentMonitor] Publication rootPath missing for verification: publicationId=${freshArticle.publicationId}, relativeFilePath=${freshArticle.filePath}. Falling back to filePath directly, but ExtendScript File() may fail to resolve it.`
                    );
                    absolutePath = freshArticle.filePath;
                }
                await verifyDocumentInBackground(absolutePath, freshArticle);
            } catch (e) {
                logError("[DocumentMonitor] Unlock check hiba:", e);
            } finally {
                isVerifyingRef.current = false;

                // Ha van még pending unlock, triggereljük a useEffect újrafutását
                if (pendingUnlockRef.current.size > 0) {
                    setVerificationEndTick(t => t + 1);
                }
            }
        })();
    }, [articles, user, verificationEndTick]); // eslint-disable-line react-hooks/exhaustive-deps

    /**
     * InDesign Event Listener: afterSave
     *
     * Mentéskor dispatolja a `MaestroEvent.documentSaved` eventet.
     * A validátorok a saját hookjaikban feliratkoznak és reagálnak.
     */
    useEffect(() => {
        isDocumentMonitorMountedRef.current = true;
        log("[DocumentMonitor] Indítás (v8 - Event-driven)");

        const app = getIndesignApp();

        const handleSave = async (event) => {
            // Programozott mentés kihagyása — számláló-alapú (több party egyidejűleg is jelezhet)
            if (typeof window !== 'undefined' && window.maestroSkipCount > 0) {
                window.maestroSkipCount--;
                return;
            }

            let docPath = null;
            try {
                let target = null;
                try { target = resolveTargetToDoc(event.target); } catch (e) { /* Ignore */ }
                const doc = target || findActiveDocument(app);
                if (doc) docPath = await getDocPath(doc);
            } catch (err) {
                return; // Csendes hiba - realtime trigger kezeli
            }

            if (!docPath) return;

            const article = fetchArticle(docPath);
            if (!article) return;

            // Event dispatch — a feliratkozott validátorok reagálnak
            dispatchMaestroEvent(MaestroEvent.documentSaved, { article, filePath: docPath });
        };

        // Csak afterSave-re iratkozunk fel, ha van app
        let afterSaveListener = null;
        if (app) {
            afterSaveListener = app.addEventListener("afterSave", handleSave);
        } else {
            logWarn("[DocumentMonitor] InDesign app not available, monitoring disabled.");
        }

        return () => {
            isDocumentMonitorMountedRef.current = false;

            // afterSave listener eltávolítása megfelelő hibakezeléssel
            if (afterSaveListener && typeof afterSaveListener.remove === 'function') {
                try {
                    afterSaveListener.remove();
                } catch (e) {
                    logError(
                        "[DocumentMonitor] afterSaveListener.remove() failed during cleanup " +
                        "(handleSave listener, isDocumentMonitorMountedRef.current = false):",
                        e
                    );
                }
            }

            // Verification end jelzése unmount esetén, csak ha éppen fut
            if (isVerifyingRef.current) {
                dispatchMaestroEvent(MaestroEvent.verificationEnded);
            }
        };
    }, [user]);

    return null;
};
