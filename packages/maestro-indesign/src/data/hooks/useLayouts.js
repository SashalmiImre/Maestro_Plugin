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

/**
 * React Hook az elrendezések (layoutok) kezelésére.
 *
 * Egy kiadványhoz tartozó layoutok CRUD műveleteit biztosítja.
 * Az írási műveletek a DataContext write-through API-ján keresztül történnek.
 *
 * @returns {Object} A layoutok listája és a kezelő függvények
 */
export const useLayouts = () => {
    const { setConnected, setOffline, incrementAttempts } = useConnection();
    const {
        layouts,
        articles,
        createLayout: dataCreateLayout,
        updateLayout: dataUpdateLayout,
        deleteLayout: dataDeleteLayout,
        updateArticle: dataUpdateArticle
    } = useData();
    const { showToast } = useToast();

    /**
     * Új layout létrehozása a kiadványhoz.
     * Automatikusan kiszámolja a következő `order` értéket.
     *
     * @param {string} publicationId - A kiadvány azonosítója
     * @param {string} name - A layout neve
     * @returns {Promise<Object>} A létrehozott layout dokumentum
     */
    const createLayout = useCallback(async (publicationId, name) => {
        try {
            const maxOrder = layouts.reduce((max, layout) => Math.max(max, layout.order ?? 0), -1);
            const result = await dataCreateLayout({
                publicationId,
                name,
                order: maxOrder + 1
            });
            setConnected();
            return result;
        } catch (error) {
            logError('[useLayouts] Create failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('Az elrendezés létrehozása sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Elrendezés létrehozása'));
            }
            throw error;
        }
    }, [layouts, dataCreateLayout, setConnected, incrementAttempts, setOffline, showToast]);

    /**
     * Layout átnevezése.
     *
     * @param {string} layoutId - A módosítandó layout azonosítója
     * @param {string} newName - Az új név
     * @returns {Promise<Object>} A frissített layout dokumentum
     */
    const renameLayout = useCallback(async (layoutId, newName) => {
        try {
            const result = await dataUpdateLayout(layoutId, { name: newName });
            setConnected();
            return result;
        } catch (error) {
            logError('[useLayouts] Rename failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('Az elrendezés átnevezése sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Elrendezés átnevezése'));
            }
            throw error;
        }
    }, [dataUpdateLayout, setConnected, incrementAttempts, setOffline, showToast]);

    /**
     * Layout törlése.
     * Ha vannak cikkek az adott layouton, azokat az első elérhető layoutra rendeli át.
     *
     * @param {string} layoutId - A törlendő layout azonosítója
     * @returns {Promise<void>}
     */
    const deleteLayout = useCallback(async (layoutId) => {
        // Utolsó layout nem törölhető
        if (layouts.length <= 1) {
            showToast('Törlés nem lehetséges', TOAST_TYPES.WARNING, 'Legalább egy elrendezésnek lennie kell.');
            return;
        }

        try {
            // Első elérhető layout megkeresése (nem a törlendő)
            const fallbackLayout = layouts.find(layout => layout.$id !== layoutId);

            // Érintett cikkek átrendelése
            const affectedArticles = articles.filter(article => article.layout === layoutId);
            let updatedArticles = [];
            if (affectedArticles.length > 0 && fallbackLayout) {
                updatedArticles = await Promise.all(
                    affectedArticles.map(article =>
                        dataUpdateArticle(article.$id, { layout: fallbackLayout.$id })
                    )
                );
            }

            await dataDeleteLayout(layoutId);
            setConnected();

            // Átfedés-validáció kiváltása — egyetlen event az összes érintett cikkel.
            // Az updatedArticles-t közvetlenül adjuk át, mert a React ref-ek
            // (articlesRef az useOverlapValidation-ben) még nem frissültek.
            if (updatedArticles.length > 0) {
                dispatchMaestroEvent(MaestroEvent.layoutChanged, {
                    articles: updatedArticles,
                    publicationId: updatedArticles[0].publicationId
                });
            }
        } catch (error) {
            logError('[useLayouts] Delete failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('Az elrendezés törlése sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Elrendezés törlése'));
            }
            throw error;
        }
    }, [layouts, articles, dataDeleteLayout, dataUpdateArticle, setConnected, incrementAttempts, setOffline, showToast]);

    return {
        layouts,
        createLayout,
        renameLayout,
        deleteLayout
    };
};
