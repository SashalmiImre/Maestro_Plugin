/**
 * @fileoverview Munkafolyamat jogosultsági ellenőrzés.
 * Meghatározza, hogy egy adott felhasználó mozgathatja-e a cikket
 * a jelenlegi állapotából.
 *
 * A tényleges logika a `workflowRuntime.js` helperekben van —
 * ez a fájl plugin-szintű proxy, ami a compiled workflow-t
 * és a userGroupSlugs-t fogadja.
 *
 * @module utils/workflow/workflowPermissions
 */

import {
    canUserMoveArticle as rtCanUserMoveArticle
} from "maestro-shared/workflowRuntime.js";

/**
 * Ellenőrzi, hogy a felhasználó mozgathatja-e a cikket az aktuális állapotából.
 *
 * @param {Object} workflow - A compiled workflow JSON (DataContext.workflow).
 * @param {string} currentState - A cikk jelenlegi állapota (string ID).
 * @param {string[]} userGroupSlugs - A felhasználó csoporttagságai.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canUserMoveArticle(workflow, currentState, userGroupSlugs) {
    return rtCanUserMoveArticle(workflow, currentState, userGroupSlugs);
}

/**
 * Kényelmi függvény: ellenőrzi a jogosultságot és visszaadja a boolean eredményt.
 *
 * @param {Object} workflow - A compiled workflow JSON.
 * @param {string} currentState - A cikk jelenlegi állapota.
 * @param {string[]} userGroupSlugs - A felhasználó csoporttagságai.
 * @returns {boolean}
 */
export function hasTransitionPermission(workflow, currentState, userGroupSlugs) {
    return canUserMoveArticle(workflow, currentState, userGroupSlugs).allowed;
}

