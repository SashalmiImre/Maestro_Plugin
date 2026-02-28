/**
 * @fileoverview Workflow Engine a cikkek állapotátmeneteinek és jelölőinek (markers) kezelésére.
 * Kezeli a validációt, az állapotváltásokat és a jelölők kapcsolását a Maestro pluginban.
 * 
 * @module utils/workflowEngine
 */

import { tables, DATABASE_ID, ARTICLES_COLLECTION_ID } from "../../config/appwriteConfig.js";
import { withTimeout } from "../promiseUtils.js";
import { WORKFLOW_CONFIG, MARKERS } from "./workflowConstants.js";
import { canUserMoveArticle } from "./workflowPermissions.js";
import { LOCK_TYPE } from "../constants.js";
import { validate } from "../validationRunner.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../config/maestroEvents.js";

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
     * Visszaadja a cikk számára elérhető következő állapotokat a jelenlegi állapot alapján.
     * 
     * @param {string|number} currentState - A cikk jelenlegi munkafolyamat állapota.
     *                                       A WORKFLOW_STATES konstans egyik értéke kell legyen.
     * @returns {Array<Object>} Érvényes célállapotok tömbje, ahová a cikk áttérhet.
     *                          Üres tömböt ad vissza, ha nincs elérhető átmenet.
     */
    static getAvailableTransitions(currentState) {
        return WORKFLOW_CONFIG[currentState]?.transitions || [];
    }

    /**
     * Validálja, hogy a cikk áttérhet-e a célállapotba.
     * Lefuttatja az alapvető fájlvalidációt és a célállapothoz definiált specifikus ellenőrzéseket.
     * 
     * @param {Object} article - A validálandó cikk objektum.
     * @param {string} article.$id - A cikk egyedi azonosítója.
     * @param {string} article.Name - A cikk neve.
     * @param {number} article.state - Jelenlegi munkafolyamat állapot.
     * @param {string} [article.FilePath] - A fájl útvonala.
     * @param {number} [article.startPage] - Kezdő oldalszám.
     * @param {number} [article.endPage] - Utolsó oldalszám.
     * @param {number} targetState - A célállapot, amire a váltást validálni kell.
     * 
     * @returns {Promise<Object>} Validációs eredmény objektum.
     * @returns {boolean} return.isValid - Igaz, ha az átmenet érvényes.
     * @returns {string[]} return.errors - Hibaüzenetek tömbje (megakadályozza az átmenetet).
     * @returns {string[]} return.warnings - Figyelmeztetések tömbje (nem blokkol).
     */
    static async validateTransition(article, targetState) {
        // Állapot-specifikus ellenőrzések (fájl létezés, oldalszám, fájlnév, preflight)
        // delegálva a StateComplianceValidator-nak
        return validate(article, 'state_compliance', { targetState });
    }

    /**
     * Végrehajt egy állapotátmenetet a cikken.
     * Frissíti a cikk állapotát az adatbázisban és naplózza az eseményt.
     * 
     * @param {Object} article - A cikk objektum.
     * @param {string} article.$id - A cikk egyedi azonosítója.
     * @param {number} targetState - A célállapot (WORKFLOW_STATES egyik értéke).
     * @param {Object} user - A felhasználó, aki végrehajtja a váltást.
     * @param {string} user.$id - Felhasználó ID-ja.
     * @param {string} [user.name] - Felhasználó neve.
     * 
     * @returns {Promise<Object>} Eredmény objektum, ami jelzi a sikert vagy hibát.
     * @returns {boolean} return.success - Sikeres volt-e a váltás.
     * @returns {Object} [return.document] - A frissített dokumentum az Appwrite-ból (siker esetén).
     * @returns {string} [return.error] - Hibaüzenet (kudarc esetén).
     */
    static async executeTransition(article, targetState, user) {
        try {
            // 0. Jogosultsági ellenőrzés (a validáció ELŐTT — a drága preflight ne fusson feleslegesen)
            const permission = canUserMoveArticle(article, article.state, user);
            if (!permission.allowed) {
                return { success: false, error: permission.reason, permissionDenied: true };
            }

            // 1. Átmenet validálása
            const validation = await WorkflowEngine.validateTransition(article, targetState);
            if (!validation.isValid) {
                return { success: false, error: validation.errors.join(", ") };
            }

            console.log(`[WorkflowEngine] Cikk (${article.$id}) állapotváltása erre: ${targetState}, felhasználó: ${user?.name || user?.$id || 'ismeretlen'}`);

            // 1. Cikk frissítése az adatbázisban
            const result = await withTimeout(
                tables.updateRow({
                    databaseId: DATABASE_ID,
                    tableId: ARTICLES_COLLECTION_ID,
                    rowId: article.$id,
                    data: {
                        state: targetState
                    }
                }),
                20000,
                "WorkflowEngine: executeTransition"
            );

            // Állapotváltás jelzése az event rendszeren keresztül
            try {
                dispatchMaestroEvent(MaestroEvent.stateChanged, {
                    article: result,
                    previousState: Number(article.state),
                    newState: targetState
                });
            } catch (listenerError) {
                console.error("[WorkflowEngine] state-changed esemény listener hiba:", listenerError);
            }

            return { success: true, document: result };
        } catch (error) {
            console.error("Állapotváltás sikertelen:", error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Jelölő (marker) kapcsolása a cikken bitműveletek használatával.
     * A jelölők bitmaszkként vannak tárolva a cikk `markers` mezőjében.
     * 
     * @param {Object} article - A módosítandó cikk objektum.
     * @param {string} article.$id - A cikk egyedi azonosítója.
     * @param {number} [article.markers=0] - Jelenlegi marker bitmaszk.
     * @param {number} markerType - A kapcsolni kívánt marker bit (MARKERS konstansok egyike).
     *                              Például: MARKERS.URGENT, MARKERS.REVIEWED, stb.
     * @param {Object} user - A felhasználó, aki a módosítást végzi.
     * 
     * @returns {Promise<Object>} Eredmény objektum.
     * @returns {boolean} return.success - Sikeres volt-e a módosítás.
     * @returns {Object} [return.document] - A frissített dokumentum (siker esetén).
     * @returns {string} [return.error] - Hibaüzenet (kudarc esetén).
     */
    static async toggleMarker(article, markerType, user) {
        try {
            // Alapértelmezés 0-ra, ha null/undefined
            const currentMarkersMask = typeof article.markers === 'number' ? article.markers : 0;
            
            // Bit átbillentése XOR művelettel
            const newMarkersMask = currentMarkersMask ^ markerType;

            const result = await withTimeout(
                tables.updateRow({
                    databaseId: DATABASE_ID,
                    tableId: ARTICLES_COLLECTION_ID,
                    rowId: article.$id,
                    data: {
                        markers: newMarkersMask
                    }
                }),
                20000,
                "WorkflowEngine: toggleMarker"
            );
            return { success: true, document: result };
        } catch (error) {
            console.error("Marker kapcsolása sikertelen:", error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Dokumentum zárolása az adatbázisban.
     *
     * A valódi fájlszintű zárolást az InDesign .idlk mechanizmusa végzi —
     * ez a DB lock informatív jellegű (a UI-ban mutatja, ki szerkeszti éppen).
     * Sima updateRow hívás, ami megbízhatóan triggerel Appwrite realtime eventeket.
     *
     * @param {Object} article - A zárolandó cikk.
     * @param {string} lockType - A zárolás típusa (LOCK_TYPE.USER vagy LOCK_TYPE.SYSTEM).
     * @param {Object} user - A műveletet végző felhasználó.
     * @returns {Promise<Object>} { success: boolean, document?: Object, error?: string }
     */
    static async lockDocument(article, lockType, user) {
        // Validate lockType
        if (!Object.values(LOCK_TYPE).includes(lockType)) {
            return {
                success: false,
                error: `Invalid lockType: ${lockType}. Must be one of: ${Object.values(LOCK_TYPE).join(", ")}`
            };
        }

        // Ownership check (a hívó friss adatot ad — LockManager mindig DB-ből lekérdez előtte)
        if (article.lockOwnerId && article.lockOwnerId !== user.$id) {
            return { success: false, error: "A dokumentumot már zárolta más felhasználó" };
        }

        try {
            const result = await withTimeout(
                tables.updateRow({
                    databaseId: DATABASE_ID,
                    tableId: ARTICLES_COLLECTION_ID,
                    rowId: article.$id,
                    data: {
                        lockType: lockType,
                        lockOwnerId: user.$id
                    }
                }),
                20000,
                "WorkflowEngine: lockDocument"
            );

            return { success: true, document: result };

        } catch (error) {
            console.error("Dokumentum zárolása sikertelen:", error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Dokumentum zárolásának feloldása.
     *
     * Sima updateRow hívás, ami megbízhatóan triggerel Appwrite realtime eventeket.
     * Idempotens: ha nincs zárolva, sikeresnek tekinti.
     *
     * @param {Object} article - A feloldandó cikk.
     * @param {Object} user - A műveletet végző felhasználó.
     * @returns {Promise<Object>} { success: boolean, document?: Object, error?: string }
     */
    static async unlockDocument(article, user) {
        try {
            // Ha nincs zárolva, már rendben vagyunk (idempotens)
            if (!article.lockOwnerId) {
                return { success: true };
            }

            // Authorization check — csak a tulajdonos oldhatja fel
            if (article.lockOwnerId !== user.$id) {
                return { success: false, error: "not authorized" };
            }

            const result = await withTimeout(
                tables.updateRow({
                    databaseId: DATABASE_ID,
                    tableId: ARTICLES_COLLECTION_ID,
                    rowId: article.$id,
                    data: {
                        lockType: null,
                        lockOwnerId: null
                    }
                }),
                20000,
                "WorkflowEngine: unlockDocument"
            );

            return { success: true, document: result };

        } catch (error) {
            console.error("Dokumentum feloldása sikertelen:", error);
            return { success: false, error: error.message };
        }
    }
}
