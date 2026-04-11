/**
 * Maestro Dashboard — Workflow Designer API
 *
 * CF hívások a workflow-k kezeléséhez (create + update/rename).
 * Az invite-to-organization CF action-öket hívja.
 */

import { Functions } from 'appwrite';
import { getClient } from '../../contexts/AuthContext.jsx';
import { FUNCTIONS } from '../../config.js';

/**
 * CF execution wrapper — parse + hibaüzenet.
 *
 * @param {Object} body - A CF hívás body-ja (action + payload)
 * @returns {Promise<Object>} A CF parsolt response-ja
 * @throws {Error} Ha a CF hívás sikertelen
 */
async function callCF(body) {
    const client = getClient();
    const functions = new Functions(client);

    const execution = await functions.createExecution({
        functionId: FUNCTIONS.INVITE_TO_ORGANIZATION,
        body: JSON.stringify(body),
        async: false,
        method: 'POST',
        headers: { 'content-type': 'application/json' }
    });

    let response;
    try {
        response = JSON.parse(execution.responseBody || '{}');
    } catch {
        throw new Error('Érvénytelen szerver válasz.');
    }
    return response;
}

/**
 * Workflow mentése a szerverre (compiled + graph + opcionális rename).
 *
 * @param {string} editorialOfficeId - Szerkesztőség ID
 * @param {string} workflowId - A mentendő workflow doc ID-ja (multi-workflow targeting)
 * @param {Object} compiled - A graphToCompiled() kimenete
 * @param {Object} graph - A extractGraphData() kimenete (pozíciók + viewport)
 * @param {number} version - Aktuális helyi verzió (optimistic concurrency)
 * @param {string} [name] - Új név, ha rename történt (opcionális)
 * @returns {Promise<{ success: boolean, version: number, workflowId: string, name: string }>}
 * @throws {Error} Ha a CF hívás sikertelen
 */
export async function saveWorkflow(editorialOfficeId, workflowId, compiled, graph, version, name) {
    const body = {
        action: 'update_workflow',
        editorialOfficeId,
        workflowId,
        compiled,
        graph,
        version
    };
    if (name !== undefined) body.name = name;

    const response = await callCF(body);

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'version_conflict') {
            throw new Error('A workflow közben módosult. Töltsd újra az oldalt.');
        }
        if (reason === 'insufficient_role') {
            throw new Error('Nincs jogosultságod a workflow szerkesztéséhez.');
        }
        if (reason === 'name_taken') {
            throw new Error(`Már létezik workflow ezzel a névvel: „${response.name || name}".`);
        }
        if (reason === 'invalid_name') {
            throw new Error('Érvénytelen név.');
        }
        if (reason === 'workflow_not_found') {
            throw new Error('A workflow nem található. Lehet, hogy közben törölve lett.');
        }
        if (reason === 'scope_mismatch') {
            throw new Error('A workflow nem az adott szerkesztőséghez tartozik.');
        }
        throw new Error(`Mentési hiba: ${reason}`);
    }

    return response;
}

/**
 * Új workflow létrehozása egy meglévő szerkesztőséghez.
 *
 * A default workflow compiled JSON-t klónozza a CF (version=1), a hívónak
 * csak a nevet kell megadnia. Owner/admin only.
 *
 * @param {string} editorialOfficeId - Szerkesztőség ID
 * @param {string} name - Az új workflow neve (unique az office-on belül)
 * @returns {Promise<{ workflowId: string, name: string }>}
 * @throws {Error} Ha a CF hívás sikertelen
 */
export async function createWorkflow(editorialOfficeId, name) {
    const response = await callCF({
        action: 'create_workflow',
        editorialOfficeId,
        name
    });

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'insufficient_role') {
            throw new Error('Nincs jogosultságod új workflow létrehozásához.');
        }
        if (reason === 'name_taken') {
            throw new Error(`Már létezik workflow ezzel a névvel: „${response.name || name}".`);
        }
        if (reason === 'missing_fields') {
            throw new Error('A név megadása kötelező.');
        }
        if (reason === 'office_not_found') {
            throw new Error('A szerkesztőség nem található.');
        }
        throw new Error(`Workflow létrehozási hiba: ${reason}`);
    }

    return {
        workflowId: response.workflowId,
        name: response.name
    };
}
