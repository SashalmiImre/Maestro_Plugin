/**
 * @fileoverview set-publication-root-path Cloud Function kliens wrapper.
 *
 * A Plugin NEM ír közvetlenül a `publications` collection-be — a `users` role-nak
 * nincs Update joga a publikációkra. A rootPath first-set (null → kanonikus) az
 * egyetlen kivétel, ezt ez a CF szolgálja ki szerver API key-jel, a caller
 * jogosultságának (office admin VAGY org owner/admin) ellenőrzése után.
 *
 * A `updateArticleClient.js` mintáját követi — azonos hibakezelési protokoll,
 * hogy a UI egységes `PermissionDeniedError` / `cfReason` ágakon tudjon branch-elni.
 *
 * @module utils/updatePublicationClient
 */

import { functions, SET_PUBLICATION_ROOT_PATH_FUNCTION_ID } from "../config/appwriteConfig.js";
import { withTimeout } from "./promiseUtils.js";
import { PermissionDeniedError } from "./errorUtils.js";

const SET_ROOT_PATH_TIMEOUT_MS = 15000;

/**
 * Meghívja a `set-publication-root-path` CF-et és visszaadja a frissített publikációt.
 *
 * @param {string} publicationId - A publikáció `$id`-je.
 * @param {string} rootPath - Kanonikus rootPath (pl. `/ShareName/path`).
 * @returns {Promise<Object>} A szerver által visszaadott frissített dokumentum.
 * @throws {PermissionDeniedError} Ha a CF 403-as `permissionDenied` választ adott.
 * @throws {Error} Minden más hiba esetén (hálózat, 4xx/5xx, parse, `cfReason` mezővel).
 */
export async function callSetPublicationRootPathCF(publicationId, rootPath) {
    const execution = await withTimeout(
        functions.createExecution({
            functionId: SET_PUBLICATION_ROOT_PATH_FUNCTION_ID,
            body: JSON.stringify({ publicationId, rootPath }),
            async: false,
            method: 'POST',
            headers: { 'content-type': 'application/json' }
        }),
        SET_ROOT_PATH_TIMEOUT_MS,
        'set-publication-root-path'
    );

    let response;
    try {
        response = JSON.parse(execution.responseBody || '{}');
    } catch (e) {
        throw new Error('Érvénytelen válasz a set-publication-root-path CF-től.');
    }

    if (!response.success) {
        if (response.permissionDenied) {
            throw new PermissionDeniedError(response.reason, response.requiredGroups || []);
        }
        const err = new Error(response.reason || response.message || 'set-publication-root-path CF hiba');
        err.code = execution.responseStatusCode;
        err.cfReason = response.reason;
        throw err;
    }

    if (!response.document) {
        throw new Error('set-publication-root-path CF sikerjelzést adott dokumentum nélkül.');
    }

    return response.document;
}
