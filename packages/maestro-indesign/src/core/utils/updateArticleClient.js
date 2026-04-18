/**
 * @fileoverview update-article Cloud Function kliens wrapper.
 *
 * Szűk, egyrétegű helper a `functions.createExecution()` hívás fölé, amit mind
 * a `DataContext.updateArticle()` (React state sync + optimista frissítés),
 * mind a `WorkflowEngine` statikus metódusai (csak a frissített doc-ot kérik
 * vissza, a state-et a hívó `applyArticleUpdate`-tel merge-öli) használnak.
 *
 * Fázis 9 follow-up: a plugin NEM ír közvetlenül az `articles` collection-be,
 * az `users` role-nak nincs Update joga. Minden cikk-update ezen a CF-en
 * keresztül fut.
 *
 * @module utils/updateArticleClient
 */

import { functions, UPDATE_ARTICLE_FUNCTION_ID } from "../config/appwriteConfig.js";
import { withTimeout } from "./promiseUtils.js";
import { PermissionDeniedError } from "./errorUtils.js";

const UPDATE_ARTICLE_TIMEOUT_MS = 20000;

/**
 * Meghívja az `update-article` CF-et és visszaadja a frissített dokumentumot.
 *
 * @param {string} articleId - A frissítendő cikk `$id`-je.
 * @param {Object} data - Engedett cikk-mezők (state, name, startPage, stb.).
 * @param {string} [label='update-article'] - withTimeout debug címke.
 * @returns {Promise<Object>} A szerver által visszaadott frissített dokumentum.
 * @throws {PermissionDeniedError} Ha a CF 403-as `permissionDenied` választ adott.
 * @throws {Error} Bármely más hiba esetén (hálózat, 4xx/5xx, parse).
 */
export async function callUpdateArticleCF(articleId, data, label = 'update-article') {
    const execution = await withTimeout(
        functions.createExecution({
            functionId: UPDATE_ARTICLE_FUNCTION_ID,
            body: JSON.stringify({ articleId, data }),
            async: false,
            method: 'POST',
            headers: { 'content-type': 'application/json' }
        }),
        UPDATE_ARTICLE_TIMEOUT_MS,
        label
    );

    let response;
    try {
        response = JSON.parse(execution.responseBody || '{}');
    } catch (e) {
        throw new Error('Érvénytelen válasz az update-article CF-től.');
    }

    if (!response.success) {
        if (response.permissionDenied) {
            throw new PermissionDeniedError(response.reason, response.requiredGroups || []);
        }
        const err = new Error(response.reason || response.message || 'update-article CF hiba');
        err.code = execution.responseStatusCode;
        err.cfReason = response.reason;
        throw err;
    }

    // success:true, de document hiányzik → protokollsértés, dobunk, ne hagyjunk üres optimista state-et.
    if (!response.document) {
        throw new Error('update-article CF sikerjelzést adott dokumentum nélkül.');
    }

    return response.document;
}
