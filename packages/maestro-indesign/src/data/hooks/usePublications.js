// React
import { useCallback } from "react";

// Contexts & Custom
import { useConnection } from "../../core/contexts/ConnectionContext.jsx";
import { useData } from "../../core/contexts/DataContext.jsx";
import { useToast } from "../../ui/common/Toast/ToastContext.jsx";

// Appwrite
import { tables, DATABASE_ID, ARTICLES_COLLECTION_ID, Query } from "../../core/config/appwriteConfig.js";

// Utils
import { withTimeout } from "../../core/utils/promiseUtils.js";
import { logError } from "../../core/utils/logger.js";
import { isNetworkError, isAuthError, getAPIErrorMessage } from "../../core/utils/errorUtils.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../core/config/maestroEvents.js";

/**
 * React Hook a kiadványok kezelésére
 *
 * Ez a hook felelős a kiadványok létrehozásáért,
 * törléséért és módosításáért. Az írási műveletek a DataContext
 * write-through API-ján keresztül történnek.
 *
 * @returns {Object} A kiadványok listája, a betöltési állapot és a kezelő függvények
 */
export const usePublications = () => {
    const { setOffline, setConnected, incrementAttempts } = useConnection();
    const {
        publications,
        isLoading,
        createPublication: dataCreatePublication,
        updatePublication: dataUpdatePublication,
        deletePublication: dataDeletePublication,
        deleteArticle: dataDeleteArticle,
        createLayout: dataCreateLayout
    } = useData();
    const { showToast } = useToast();

    /**
     * Új kiadvány létrehozása
     *
     * @param {Object} folder - A kiválasztott mappa objektum (name, nativePath)
     */
    const createPublication = useCallback(async (folder) => {
        // Duplikáció ellenőrzése
        const isDuplicate = publications.some(publication => publication.rootPath === folder.nativePath);
        if (isDuplicate) {
            throw new Error("Ez a kiadvány már létezik!");
        }

        try {
            const pub = await dataCreatePublication({
                name: folder.name,
                rootPath: folder.nativePath
            });

            // Automatikus "A" layout létrehozása az új kiadványhoz
            await dataCreateLayout({
                publicationId: pub.$id,
                name: "A",
                order: 0
            });

            setConnected();
        } catch (error) {
            logError('[usePublications] Create failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('A kiadvány létrehozása sikertelen', 'warning', getAPIErrorMessage(error, 'Kiadvány létrehozása'));
            }
            throw error;
        }
    }, [publications, dataCreatePublication, dataCreateLayout, setConnected, incrementAttempts, setOffline, showToast]);

    /**
     * Kiadvány és összes hozzá tartozó cikk törlése
     *
     * Sorrend: kiadvány törlése ELŐSZÖR, majd cikkek takarítása.
     * Ha a kiadvány törlése sikertelen → semmi nem változott (konzisztens állapot).
     * Ha a cikk-takarítás részben sikertelen → árva cikkek láthatatlanok a UI-ban
     * (a publicationId-jük már nem létezik), és nem blokkolják a felhasználót.
     *
     * @param {string} id - A törlendő kiadvány azonosítója
     */
    const deletePublication = useCallback(async (id) => {
        try {
            // 1. Kapcsolódó cikkek lekérése a szerverről
            // Nem a helyi state-ből szűrünk, mert a törlendő pub nem feltétlenül az aktív.
            const articlesResponse = await withTimeout(
                tables.listRows({
                    databaseId: DATABASE_ID,
                    tableId: ARTICLES_COLLECTION_ID,
                    queries: [Query.equal("publicationId", id)]
                }),
                10000,
                "usePublications: deletePublication (fetch articles)"
            );

            // 2. Kiadvány törlése ELŐSZÖR — ha ez sikertelen, semmi nem változott
            await dataDeletePublication(id);

            // 3. Kapcsolódó cikkek takarítása (best-effort)
            // A kiadvány már törölve van, ezek az árva cikkek láthatatlanok a UI-ban.
            if (articlesResponse.rows.length > 0) {
                const deleteResults = await Promise.allSettled(
                    articlesResponse.rows.map(article => dataDeleteArticle(article.$id))
                );

                const failedDeletes = deleteResults.filter(result => result.status === 'rejected');
                if (failedDeletes.length > 0) {
                    failedDeletes.forEach(result => { logError('[usePublications] Article cleanup failed:', result.reason); });
                }
            }

            setConnected();

        } catch (error) {
            logError('[usePublications] Delete failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('A kiadvány törlése sikertelen', 'warning', getAPIErrorMessage(error, 'Kiadvány törlése'));
            }
            throw error;
        }
    }, [dataDeleteArticle, dataDeletePublication, setConnected, incrementAttempts, setOffline, showToast]);

    /**
     * Kiadvány nevének módosítása
     *
     * @param {string} id - A módosítandó kiadvány azonosítója
     * @param {string} newName - Az új név
     */
    const renamePublication = useCallback(async (id, newName) => {
        try {
            await dataUpdatePublication(id, { name: newName });
            setConnected();
        } catch (error) {
            logError('[usePublications] Rename failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('A kiadvány átnevezése sikertelen', 'warning', getAPIErrorMessage(error, 'Kiadvány átnevezése'));
            }
            throw error;
        }
    }, [dataUpdatePublication, setConnected, incrementAttempts, setOffline, showToast]);

    /**
     * Kiadvány adatainak frissítése
     *
     * @param {string} id - A frissítendő kiadvány azonosítója
     * @param {Object} data - A frissítendő adatok
     */
    const updatePublication = useCallback(async (id, data) => {
        try {
            await dataUpdatePublication(id, data);
        } catch (error) {
            logError('[usePublications] Update failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('A kiadvány frissítése sikertelen', 'warning', getAPIErrorMessage(error, 'Kiadvány frissítése'));
            }
            throw error;
        }
    }, [dataUpdatePublication, incrementAttempts, setOffline, showToast]);

    return {
        publications,
        loading: isLoading,
        createPublication,
        deletePublication,
        renamePublication,
        updatePublication
    };
};
