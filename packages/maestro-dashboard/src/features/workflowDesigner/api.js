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
 * @param {string} [visibility] - Láthatóság (`organization` / `editorial_office`)
 * @returns {Promise<{ workflowId: string, name: string, visibility: string }>}
 * @throws {Error} Ha a CF hívás sikertelen
 */
export async function createWorkflow(editorialOfficeId, name, visibility) {
    const body = {
        action: 'create_workflow',
        editorialOfficeId,
        name
    };
    if (visibility !== undefined) body.visibility = visibility;

    const response = await callCF(body);

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
        if (reason === 'invalid_visibility') {
            throw new Error('Érvénytelen láthatóság érték.');
        }
        throw new Error(`Workflow létrehozási hiba: ${reason}`);
    }

    return {
        workflowId: response.workflowId,
        name: response.name,
        visibility: response.visibility
    };
}

/**
 * Workflow metaadat módosítása (név és/vagy láthatóság).
 *
 * Nem módosítja a compiled JSON-t — erre a `saveWorkflow` szolgál. Owner/admin only.
 *
 * @param {string} editorialOfficeId - Szerkesztőség ID
 * @param {string} workflowId - Módosítandó workflow doc ID
 * @param {Object} changes
 * @param {string} [changes.name] - Új név (opcionális)
 * @param {string} [changes.visibility] - Új láthatóság (opcionális)
 * @returns {Promise<{ workflowId: string, name: string, visibility: string }>}
 * @throws {Error} Ha a CF hívás sikertelen
 */
export async function updateWorkflowMetadata(editorialOfficeId, workflowId, { name, visibility } = {}) {
    const body = {
        action: 'update_workflow_metadata',
        editorialOfficeId,
        workflowId
    };
    if (name !== undefined) body.name = name;
    if (visibility !== undefined) body.visibility = visibility;

    const response = await callCF(body);

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'insufficient_role') {
            throw new Error('Nincs jogosultságod a workflow módosításához.');
        }
        if (reason === 'name_taken') {
            throw new Error(`Már létezik workflow ezzel a névvel: „${response.name || name}".`);
        }
        if (reason === 'invalid_name') {
            throw new Error('Érvénytelen név.');
        }
        if (reason === 'invalid_visibility') {
            throw new Error('Érvénytelen láthatóság érték.');
        }
        if (reason === 'workflow_not_found') {
            throw new Error('A workflow nem található.');
        }
        if (reason === 'scope_mismatch') {
            throw new Error('A workflow nem az adott szerkesztőséghez tartozik.');
        }
        if (reason === 'visibility_downgrade_blocked') {
            const count = Array.isArray(response.orphanedPublications)
                ? response.orphanedPublications.length
                : 0;
            const suffix = count > 0 ? ` (${count} másik szerkesztőségbeli kiadvány hivatkozik rá)` : '';
            const err = new Error(`A láthatóság nem szűkíthető le „Szerkesztőség" szintre${suffix}, amíg más szerkesztőségek publikációi hivatkoznak a workflow-ra.`);
            err.code = 'visibility_downgrade_blocked';
            err.orphanedPublications = response.orphanedPublications || [];
            throw err;
        }
        throw new Error(`Módosítási hiba: ${reason}`);
    }

    return {
        workflowId: response.workflowId,
        name: response.name,
        visibility: response.visibility
    };
}

/**
 * Workflow duplikálás — a forrás compiled JSON klónozása új doc-ba.
 *
 * A duplikátum örökli a forrás `visibility` értékét; a `createdBy` a caller.
 *
 * @param {string} editorialOfficeId - Szerkesztőség ID
 * @param {string} workflowId - Forrás workflow doc ID
 * @param {string} name - Új név (unique az office-on belül)
 * @returns {Promise<{ workflowId: string, name: string, visibility: string }>}
 * @throws {Error} Ha a CF hívás sikertelen
 */
export async function duplicateWorkflow(editorialOfficeId, workflowId, name) {
    const response = await callCF({
        action: 'duplicate_workflow',
        editorialOfficeId,
        workflowId,
        name
    });

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'insufficient_role') {
            throw new Error('Nincs jogosultságod workflow duplikálásához.');
        }
        if (reason === 'name_taken') {
            throw new Error(`Már létezik workflow ezzel a névvel: „${response.name || name}".`);
        }
        if (reason === 'missing_fields' || reason === 'invalid_name') {
            throw new Error('Érvénytelen név.');
        }
        if (reason === 'source_not_found' || reason === 'workflow_not_found') {
            // A CF `workflow_not_found`-ot ad vissza; a `source_not_found` legacy alias.
            throw new Error('A forrás workflow nem található.');
        }
        if (reason === 'scope_mismatch') {
            throw new Error('A workflow nem az adott szerkesztőséghez tartozik.');
        }
        throw new Error(`Duplikálási hiba: ${reason}`);
    }

    return {
        workflowId: response.workflowId,
        name: response.name,
        visibility: response.visibility
    };
}

/**
 * Workflow törlése — csak akkor sikeres, ha egyetlen publikáció sem hivatkozik rá.
 *
 * A CF blokkolja a törlést, ha a workflow használatban van (`workflow_in_use` reason
 * + `usedByPublications` listával). Owner/admin only.
 *
 * @param {string} editorialOfficeId - Szerkesztőség ID
 * @param {string} workflowId - Törlendő workflow doc ID
 * @returns {Promise<{ success: boolean, workflowId: string }>}
 * @throws {Error} Ha a workflow használatban van vagy a CF hívás sikertelen
 */
export async function deleteWorkflow(editorialOfficeId, workflowId) {
    const response = await callCF({
        action: 'delete_workflow',
        editorialOfficeId,
        workflowId
    });

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'insufficient_role') {
            throw new Error('Nincs jogosultságod workflow törléséhez.');
        }
        if (reason === 'workflow_not_found') {
            throw new Error('A workflow nem található.');
        }
        if (reason === 'scope_mismatch') {
            throw new Error('A workflow nem az adott szerkesztőséghez tartozik.');
        }
        if (reason === 'workflow_in_use') {
            const count = Array.isArray(response.usedByPublications)
                ? response.usedByPublications.length
                : 0;
            const suffix = count > 0 ? ` (${count} kiadvány hivatkozik rá)` : '';
            const err = new Error(`A workflow használatban van${suffix}, ezért nem törölhető.`);
            err.code = 'workflow_in_use';
            err.usedByPublications = response.usedByPublications || [];
            throw err;
        }
        throw new Error(`Törlési hiba: ${reason}`);
    }

    return response;
}

/**
 * Schema bootstrap — idempotens `visibility` + `createdBy` attribútum létrehozás
 * a `workflows` collection-ön. Owner only. Egyszeri adminisztratív művelet.
 *
 * @returns {Promise<{ success: boolean, created: string[], skipped: string[], note?: string }>}
 * @throws {Error} Ha a CF hívás sikertelen
 */
export async function bootstrapWorkflowSchema() {
    const response = await callCF({ action: 'bootstrap_workflow_schema' });

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'insufficient_role') {
            throw new Error('Csak owner jogosultságú felhasználó futtathatja.');
        }
        throw new Error(`Schema bootstrap hiba: ${reason}`);
    }

    return response;
}
