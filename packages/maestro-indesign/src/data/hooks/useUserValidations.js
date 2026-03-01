/**
 * @file useUserValidations.js
 * @description Egyedi React Hook cikkekhez tartozó felhasználói validációk (hibák, feladatok) kezelésére.
 *
 * Ez a hook biztosítja a validációs bejegyzések lekérését, küldését, módosítását (pl. megoldva jelölés)
 * és törlését. Az írási műveletek a DataContext write-through API-ján keresztül történnek,
 * ami biztosítja az azonnali helyi frissítést és a szerver szinkronizációt.
 */

// React
import { useMemo, useCallback } from "react";
import { useData } from "../../core/contexts/DataContext.jsx";

// Utils
import { log, logError } from "../../core/utils/logger.js";
// Konstansok
import { VALIDATION_SOURCES } from "../../core/utils/validationConstants.js";
import { VALIDATION_TYPES } from "../../core/utils/messageConstants.js";
import { isAuthError } from "../../core/utils/errorUtils.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../core/config/maestroEvents.js";

/**
 * Hook az cikk felhasználói validációinak kezelésére.
 *
 * @param {string} articleId - A cikk egyedi azonosítója ($id).
 * @returns {object} A hook visszatérési értékei:
 *  - validations: A validációs bejegyzések listája (tömb).
 *  - loading: Betöltés állapota (boolean).
 *  - addValidation: Függvény új bejegyzés létrehozásához.
 *  - resolveValidation: Függvény bejegyzés megoldottnak jelöléséhez.
 *  - deleteValidation: Függvény bejegyzés törléséhez.
 *  - downgradeSystemError: Függvény rendszerhiba visszaminősítéséhez.
 */
export const useUserValidations = (articleId) => {
    // DataContext: adatok és write-through API
    const {
        validations: allValidations,
        isLoading,
        createValidation: dataCreateValidation,
        updateValidation: dataUpdateValidation,
        deleteValidation: dataDeleteValidation
    } = useData();

    // Szűrt validációk az adott cikkhez (memoizált)
    const validations = useMemo(() => {
        if (!articleId) return [];
        return allValidations.filter(validation => validation.articleId === articleId).sort((a, b) => {
             // Rendezés létrehozás dátuma szerint (legújabb elöl)
             return new Date(b.$createdAt || b.createdAt) - new Date(a.$createdAt || a.createdAt);
        });
    }, [allValidations, articleId]);

    /**
     * Új validációs bejegyzés létrehozása.
     */
    const addValidation = useCallback(async (data) => {
        if (!articleId) {
            return { success: false, error: 'Hiányzó cikk azonosító (articleId)' };
        }

        try {
            log('[useUserValidations] Bejegyzés létrehozása...', data);

            const document = await dataCreateValidation({
                articleId,
                type: data.type || 'info',
                source: data.source || 'user',
                description: data.description || '',
                recipientType: data.recipientType || null,
                recipientUserId: data.recipientUserId || null,
                createdBy: data.createdBy,
                contextId: data.contextId || null,
                originalType: data.originalType || null,
                isResolved: false,
                resolvedBy: null,
                resolvedAt: null
            });

            return { success: true, document };
        } catch (err) {
            logError('[useUserValidations] Hiba a létrehozáskor:', err);
            if (isAuthError(err)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            }
            return { success: false, error: err };
        }
    }, [articleId, dataCreateValidation]);

    /**
     * Bejegyzés megoldottnak jelölése.
     */
    const resolveValidation = useCallback(async (validationId, userId) => {
        try {
            log(`[useUserValidations] Megoldás: ${validationId}`);

            const document = await dataUpdateValidation(validationId, {
                isResolved: true,
                resolvedBy: userId,
                resolvedAt: new Date().toISOString()
            });

            return { success: true, document };
        } catch (err) {
            logError('[useUserValidations] Hiba a megoldás jelzésekor:', err);
            if (isAuthError(err)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            }
            return { success: false, error: err };
        }
    }, [dataUpdateValidation]);

    /**
     * Bejegyzés törlése.
     */
    const deleteValidation = useCallback(async (validationId) => {
        try {
            log(`[useUserValidations] Törlés: ${validationId}`);

            await dataDeleteValidation(validationId);

            return { success: true };
        } catch (err) {
            logError('[useUserValidations] Hiba a törléskor:', err);
            if (isAuthError(err)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            }
            return { success: false, error: err };
        }
    }, [dataDeleteValidation]);

    /**
     * Rendszerhiba visszaminősítése (Error -> Warning).
     */
    const downgradeSystemError = useCallback(async (errorItem, userId) => {
        if (!errorItem.contextId) return { success: false, error: 'Hiányzó contextId' };

        return addValidation({
            recipientType: null,
            recipientUserId: null,
            createdBy: userId,
            description: `Hibajelzés visszaminősítve: ${errorItem.message}`,
            type: VALIDATION_TYPES.WARNING,
            source: VALIDATION_SOURCES.SYSTEM_OVERRIDE,
            contextId: errorItem.contextId,
            originalType: 'error'
        });
    }, [addValidation]);

    return {
        validations,
        loading: isLoading,
        addValidation,
        resolveValidation,
        deleteValidation,
        downgradeSystemError
    };
};
