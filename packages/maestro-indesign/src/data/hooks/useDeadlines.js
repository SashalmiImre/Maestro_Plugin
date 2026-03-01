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
 * React Hook a határidők (deadlines) kezelésére.
 *
 * Egy kiadványhoz tartozó nyomdai határidők CRUD műveleteit biztosítja.
 * Az írási műveletek a DataContext write-through API-ján keresztül történnek.
 *
 * @returns {Object} A határidők listája és a kezelő függvények
 */
export const useDeadlines = () => {
    const { setConnected, setOffline, incrementAttempts } = useConnection();
    const {
        deadlines,
        createDeadline: dataCreateDeadline,
        updateDeadline: dataUpdateDeadline,
        deleteDeadline: dataDeleteDeadline
    } = useData();
    const { showToast } = useToast();

    /**
     * Új határidő létrehozása a kiadványhoz.
     *
     * @param {string} publicationId - A kiadvány azonosítója
     * @param {Object} data - A határidő adatai
     * @param {number} data.startPage - Tartomány kezdő oldala
     * @param {number} data.endPage - Tartomány utolsó oldala
     * @param {string} [data.datetime] - ISO 8601 datetime string
     * @returns {Promise<Object>} A létrehozott határidő dokumentum
     */
    const createDeadline = useCallback(async (publicationId, data) => {
        try {
            const result = await dataCreateDeadline({
                publicationId,
                ...data
            });
            setConnected();
            return result;
        } catch (error) {
            logError('[useDeadlines] Create failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('A határidő létrehozása sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Határidő létrehozása'));
            }
            throw error;
        }
    }, [dataCreateDeadline, setConnected, incrementAttempts, setOffline, showToast]);

    /**
     * Határidő frissítése.
     *
     * @param {string} deadlineId - A módosítandó határidő azonosítója
     * @param {Object} data - A frissítendő mezők
     * @returns {Promise<Object>} A frissített határidő dokumentum
     */
    const updateDeadline = useCallback(async (deadlineId, data) => {
        try {
            const result = await dataUpdateDeadline(deadlineId, data);
            setConnected();
            return result;
        } catch (error) {
            logError('[useDeadlines] Update failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('A határidő frissítése sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Határidő frissítése'));
            }
            throw error;
        }
    }, [dataUpdateDeadline, setConnected, incrementAttempts, setOffline, showToast]);

    /**
     * Határidő törlése.
     *
     * @param {string} deadlineId - A törlendő határidő azonosítója
     * @returns {Promise<void>}
     */
    const deleteDeadline = useCallback(async (deadlineId) => {
        try {
            await dataDeleteDeadline(deadlineId);
            setConnected();
        } catch (error) {
            logError('[useDeadlines] Delete failed:', error);

            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('A határidő törlése sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Határidő törlése'));
            }
            throw error;
        }
    }, [dataDeleteDeadline, setConnected, incrementAttempts, setOffline, showToast]);

    return {
        deadlines,
        createDeadline,
        updateDeadline,
        deleteDeadline
    };
};
