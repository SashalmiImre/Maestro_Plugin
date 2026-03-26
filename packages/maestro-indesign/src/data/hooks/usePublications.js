// React
import { useCallback } from "react";

// Contexts & Custom
import { useConnection } from "../../core/contexts/ConnectionContext.jsx";
import { useData } from "../../core/contexts/DataContext.jsx";
import { useToast } from "../../ui/common/Toast/ToastContext.jsx";

// Config & Constants
import { TOAST_TYPES } from "../../core/utils/constants.js";

// Utils
import { logError } from "../../core/utils/logger.js";
import { isNetworkError, isAuthError, getAPIErrorMessage } from "../../core/utils/errorUtils.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../core/config/maestroEvents.js";
import { toCanonicalPath } from "../../core/utils/pathUtils.js";

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
        createLayout: dataCreateLayout
    } = useData();
    const { showToast } = useToast();

    /**
     * Új kiadvány létrehozása
     *
     * @param {Object} folder - A kiválasztott mappa objektum (name, nativePath)
     */
    const createPublication = useCallback(async (folder) => {
        // Natív útvonal → kanonikus formátum (platform-független DB tároláshoz)
        const canonicalRoot = toCanonicalPath(folder.nativePath);

        // Duplikáció ellenőrzése kanonikus formátumban
        const isDuplicate = publications.some(publication => publication.rootPath === canonicalRoot);
        if (isDuplicate) {
            throw new Error("Ez a kiadvány már létezik!");
        }

        try {
            const pub = await dataCreatePublication({
                name: folder.name,
                rootPath: canonicalRoot
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
                showToast('A kiadvány létrehozása sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Kiadvány létrehozása'));
            }
            throw error;
        }
    }, [publications, dataCreatePublication, dataCreateLayout, setConnected, incrementAttempts, setOffline, showToast]);

    /**
     * Kiadvány törlése
     *
     * A kapcsolódó adatok (cikkek, határidők, layoutok, thumbnailek) takarítását
     * a szerver-oldali cascade-delete Cloud Function végzi automatikusan.
     *
     * @param {string} id - A törlendő kiadvány azonosítója
     */
    const deletePublication = useCallback(async (id) => {
        try {
            await dataDeletePublication(id);
            setConnected();
        } catch (error) {
            logError('[usePublications] Delete failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('A kiadvány törlése sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Kiadvány törlése'));
            }
            throw error;
        }
    }, [dataDeletePublication, setConnected, incrementAttempts, setOffline, showToast]);

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
                showToast('A kiadvány átnevezése sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Kiadvány átnevezése'));
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
            setConnected();
        } catch (error) {
            logError('[usePublications] Update failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('A kiadvány frissítése sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Kiadvány frissítése'));
            }
            throw error;
        }
    }, [dataUpdatePublication, setConnected, incrementAttempts, setOffline, showToast]);

    return {
        publications,
        loading: isLoading,
        createPublication,
        deletePublication,
        renamePublication,
        updatePublication
    };
};
