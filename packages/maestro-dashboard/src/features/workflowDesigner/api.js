/**
 * Maestro Dashboard — Workflow Designer API
 *
 * CF hívás a workflow mentéséhez.
 * Az invite-to-organization CF `update_workflow` action-ját hívja.
 */

import { Functions } from 'appwrite';
import { getClient } from '../../contexts/AuthContext.jsx';
import { FUNCTIONS } from '../../config.js';

/**
 * Workflow mentése a szerverre.
 *
 * @param {string} editorialOfficeId - Szerkesztőség ID
 * @param {Object} compiled - A graphToCompiled() kimenete
 * @param {Object} graph - A extractGraphData() kimenete (pozíciók + viewport)
 * @param {number} version - Aktuális helyi verzió (optimistic concurrency)
 * @returns {Promise<{ success: boolean, version: number }>}
 * @throws {Error} Ha a CF hívás sikertelen
 */
export async function saveWorkflow(editorialOfficeId, compiled, graph, version) {
    const client = getClient();
    const functions = new Functions(client);

    const execution = await functions.createExecution({
        functionId: FUNCTIONS.INVITE_TO_ORGANIZATION,
        body: JSON.stringify({
            action: 'update_workflow',
            editorialOfficeId,
            compiled,
            graph,
            version
        }),
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

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'version_conflict') {
            throw new Error('A workflow közben módosult. Töltsd újra az oldalt.');
        }
        if (reason === 'insufficient_role') {
            throw new Error('Nincs jogosultságod a workflow szerkesztéséhez.');
        }
        throw new Error(`Mentési hiba: ${reason}`);
    }

    return response;
}
