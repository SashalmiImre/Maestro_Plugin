/**
 * @fileoverview Workflow Engine a cikkek állapotátmeneteinek és jelölőinek (markers) kezelésére.
 * Kezeli a validációt, az állapotváltásokat és a jelölők kapcsolását a Maestro pluginban.
 *
 * A workflow konfiguráció a DataContext `workflow` state-jéből (compiled JSON) érkezik.
 * Minden állapot- és átmenet-művelet a `workflowRuntime` helpereket használja.
 *
 * @module utils/workflowEngine
 */

import { callUpdateArticleCF } from "../updateArticleClient.js";
import { PermissionDeniedError } from "../errorUtils.js";
import { getAvailableTransitions as rtGetAvailableTransitions } from "maestro-shared/workflowRuntime.js";
import { canUserMoveArticle } from "./workflowPermissions.js";
import { LOCK_TYPE } from "../constants.js";
import { validate } from "../validationRunner.js";
import { VALIDATOR_TYPES } from "../validationConstants.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../config/maestroEvents.js";

import { log, logError } from "../logger.js";

/** Közös hibakezelés a CF-hívó metódusokhoz. */
function _handleCFError(error, context) {
    if (error instanceof PermissionDeniedError) {
        return { success: false, error: error.message, permissionDenied: true };
    }
    logError(context, error);
    return { success: false, error: error.message };
}

/**
 * WorkflowEngine osztály a cikkek munkafolyamat-állapotainak és átmeneteinek kezelésére.
 *
 * Ez a statikus osztály metódusokat biztosít a következőkhöz:
 * - Elérhető állapotátmenetek lekérdezése
 * - Átmenetek validálása végrehajtás előtt
 * - Állapotátmenetek végrehajtása adatbázis frissítéssel
 * - Jelölők (flag-ek) kapcsolása a cikkeken
 *
 * @class
 */
export class WorkflowEngine {
    /**
     * Visszaadja a cikk számára elérhető következő állapotátmeneteket a jelenlegi állapot alapján.
     *
     * @param {Object} workflow - A compiled workflow JSON (DataContext.workflow).
     * @param {string} currentState - A cikk jelenlegi munkafolyamat állapota (string ID).
     * @returns {Array<Object>} Érvényes átmenetek tömbje (from, to, label, direction, allowedGroups).
     */
    static getAvailableTransitions(workflow, currentState) {
        return rtGetAvailableTransitions(workflow, currentState);
    }

    /**
     * Validálja, hogy a cikk áttérhet-e a célállapotba.
     * Lefuttatja az alapvető fájlvalidációt és a célállapothoz definiált specifikus ellenőrzéseket.
     *
     * @param {Object} workflow - A compiled workflow JSON.
     * @param {Object} article - A validálandó cikk objektum.
     * @param {string} targetState - A célállapot string ID-ja.
     * @param {string} publicationRootPath - A kiadvány gyökér útvonala.
     * @returns {Promise<Object>} Validációs eredmény: { isValid, errors[], warnings[] }.
     */
    static async validateTransition(workflow, article, targetState, publicationRootPath) {
        return validate(article, VALIDATOR_TYPES.STATE_COMPLIANCE, { workflow, targetState, publicationRootPath });
    }

    /**
     * Végrehajt egy állapotátmenetet a cikken.
     * Frissíti a cikk állapotát az adatbázisban és naplózza az eseményt.
     *
     * @param {Object} workflow - A compiled workflow JSON (snapshot — a hívó a belépéskor rögzíti).
     * @param {Object} article - A cikk objektum.
     * @param {string} targetState - A célállapot string ID-ja.
     * @param {Object} user - A felhasználó, aki végrehajtja a váltást.
     * @param {string[]} userGroupSlugs - A felhasználó csoporttagságai.
     * @param {string} publicationRootPath - A kiadvány gyökér útvonala.
     * @returns {Promise<Object>} { success, document?, error?, permissionDenied? }
     */
    static async executeTransition(workflow, article, targetState, user, userGroupSlugs, publicationRootPath) {
        try {
            // 0. Jogosultsági ellenőrzés (a validáció ELŐTT — a drága preflight ne fusson feleslegesen)
            const permission = canUserMoveArticle(workflow, article.state, userGroupSlugs);
            if (!permission.allowed) {
                return { success: false, error: permission.reason, permissionDenied: true };
            }

            // 1. Átmenet validálása
            const validation = await WorkflowEngine.validateTransition(workflow, article, targetState, publicationRootPath);
            if (!validation.isValid) {
                return { success: false, error: validation.errors.join(", ") };
            }

            log(`[WorkflowEngine] Cikk (${article.$id}) állapotváltása: ${article.state} → ${targetState}, felhasználó: ${user?.name || user?.$id || 'ismeretlen'}`);

            // 2. Cikk frissítése az update-article CF-en keresztül
            const result = await callUpdateArticleCF(article.$id, {
                state: targetState,
                previousState: article.state
            }, "WorkflowEngine: executeTransition");

            // Állapotváltás jelzése az event rendszeren keresztül
            try {
                dispatchMaestroEvent(MaestroEvent.stateChanged, {
                    article: result,
                    previousState: article.state,
                    newState: targetState
                });
            } catch (listenerError) {
                logError("[WorkflowEngine] state-changed esemény listener hiba:", listenerError);
            }

            return { success: true, document: result };
        } catch (error) {
            return _handleCFError(error, "Állapotváltás sikertelen:");
        }
    }

    /**
     * Jelölő (marker) kapcsolása a cikken bitműveletek használatával.
     * A jelölők bitmaszkként vannak tárolva a cikk `markers` mezőjében.
     *
     * @param {Object} article - A módosítandó cikk objektum.
     * @param {number} markerType - A kapcsolni kívánt marker bit (pl. 1 = IGNORE).
     * @param {Object} user - A felhasználó, aki a módosítást végzi.
     * @returns {Promise<Object>} { success, document?, error? }
     */
    static async toggleMarker(article, markerType, user) {
        try {
            const currentMarkersMask = typeof article.markers === 'number' ? article.markers : 0;
            const newMarkersMask = currentMarkersMask ^ markerType;

            const result = await callUpdateArticleCF(article.$id, {
                markers: newMarkersMask
            }, "WorkflowEngine: toggleMarker");
            return { success: true, document: result };
        } catch (error) {
            return _handleCFError(error, "Marker kapcsolása sikertelen:");
        }
    }

    /**
     * Dokumentum zárolása az adatbázisban.
     *
     * A valódi fájlszintű zárolást az InDesign .idlk mechanizmusa végzi —
     * ez a DB lock informatív jellegű (a UI-ban mutatja, ki szerkeszti éppen).
     *
     * @param {Object} article - A zárolandó cikk.
     * @param {string} lockType - A zárolás típusa (LOCK_TYPE.USER vagy LOCK_TYPE.SYSTEM).
     * @param {Object} user - A műveletet végző felhasználó.
     * @returns {Promise<Object>} { success, document?, error? }
     */
    static async lockDocument(article, lockType, user) {
        if (!Object.values(LOCK_TYPE).includes(lockType)) {
            return {
                success: false,
                error: `Invalid lockType: ${lockType}. Must be one of: ${Object.values(LOCK_TYPE).join(", ")}`
            };
        }

        if (article.lockOwnerId && article.lockOwnerId !== user.$id) {
            return { success: false, error: "A dokumentumot már zárolta más felhasználó" };
        }

        try {
            const result = await callUpdateArticleCF(article.$id, {
                lockType: lockType,
                lockOwnerId: user.$id
            }, "WorkflowEngine: lockDocument");

            return { success: true, document: result };

        } catch (error) {
            return _handleCFError(error, "Dokumentum zárolása sikertelen:");
        }
    }

    /**
     * Dokumentum zárolásának feloldása.
     *
     * @param {Object} article - A feloldandó cikk.
     * @param {Object} user - A műveletet végző felhasználó.
     * @returns {Promise<Object>} { success, document?, error? }
     */
    static async unlockDocument(article, user) {
        try {
            if (!article.lockOwnerId) {
                return { success: true };
            }

            if (article.lockOwnerId !== user.$id) {
                return { success: false, error: "not authorized" };
            }

            const result = await callUpdateArticleCF(article.$id, {
                lockType: null,
                lockOwnerId: null
            }, "WorkflowEngine: unlockDocument");

            return { success: true, document: result };

        } catch (error) {
            return _handleCFError(error, "Dokumentum feloldása sikertelen:");
        }
    }
}
