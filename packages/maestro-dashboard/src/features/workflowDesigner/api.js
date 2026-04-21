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
 * @param {Object} [options]
 * @param {string} [options.visibility] - Láthatóság (`public` / `organization` / `editorial_office`)
 * @param {string} [options.description] - Rövid leírás (max 500 karakter)
 * @returns {Promise<{ workflowId: string, name: string, visibility: string, description: string|null }>}
 * @throws {Error} Ha a CF hívás sikertelen
 */
export async function createWorkflow(editorialOfficeId, name, options = {}) {
    // Backward-compat: ha a 3. paraméter string, akkor visibility-ként értelmezzük.
    const opts = typeof options === 'string' ? { visibility: options } : (options || {});
    const body = {
        action: 'create_workflow',
        editorialOfficeId,
        name
    };
    if (opts.visibility !== undefined) body.visibility = opts.visibility;
    if (opts.description !== undefined) body.description = opts.description;

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
        if (reason === 'invalid_description') {
            throw new Error('Érvénytelen leírás (maximum 500 karakter).');
        }
        throw new Error(`Workflow létrehozási hiba: ${reason}`);
    }

    return {
        workflowId: response.workflowId,
        name: response.name,
        visibility: response.visibility,
        description: response.description ?? null
    };
}

/**
 * Workflow metaadat módosítása (név / láthatóság / leírás).
 *
 * Nem módosítja a compiled JSON-t — erre a `saveWorkflow` szolgál. Owner/admin
 * a rename + description mezőkre, a visibility módosítás viszont `createdBy === caller`
 * tulajdonoshoz kötött (#81).
 *
 * Scope szűkítésnél (pl. `public → organization`) a CF a `visibility_shrinkage_warning`
 * reason-nel tér vissza — a hívónak popup-ban meg kell erősíttetnie a usert,
 * és `force: true` flag-gel újraküldenie.
 *
 * @param {string} editorialOfficeId - Szerkesztőség ID
 * @param {string} workflowId - Módosítandó workflow doc ID
 * @param {Object} changes
 * @param {string} [changes.name] - Új név (opcionális)
 * @param {string} [changes.visibility] - Új láthatóság (opcionális)
 * @param {string|null} [changes.description] - Új leírás (null / üres = törlés, undefined = no-op)
 * @param {boolean} [changes.force] - Szűkítési warning override
 * @returns {Promise<{ workflowId: string, name: string, visibility: string, description: string|null }>}
 * @throws {Error} Ha a CF hívás sikertelen. Scope shrinkage esetén `err.code === 'visibility_shrinkage_warning'`.
 */
export async function updateWorkflowMetadata(
    editorialOfficeId,
    workflowId,
    { name, visibility, description, force } = {}
) {
    const body = {
        action: 'update_workflow_metadata',
        editorialOfficeId,
        workflowId
    };
    if (name !== undefined) body.name = name;
    if (visibility !== undefined) body.visibility = visibility;
    if (description !== undefined) body.description = description;
    if (force === true) body.force = true;

    const response = await callCF(body);

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'visibility_shrinkage_warning') {
            // Soft warning — a hívónak popup-ban meg kell erősíttetnie,
            // majd `{ ..., force: true }` flag-gel újra kell hívnia.
            const count = Array.isArray(response.orphanedPublications)
                ? response.orphanedPublications.length
                : (response.count || 0);
            const err = new Error(
                `A szűkítés után ${count} kiadvány nem érné el a workflow-t. Megerősítés szükséges.`
            );
            err.code = 'visibility_shrinkage_warning';
            err.from = response.from;
            err.to = response.to;
            err.orphanedPublications = response.orphanedPublications || [];
            err.count = count;
            err.note = response.note || null;
            throw err;
        }
        if (reason === 'not_workflow_owner') {
            const err = new Error(
                'A láthatóság (scope) módosítását csak a workflow tulajdonosa végezheti el.'
            );
            err.code = 'not_workflow_owner';
            err.field = response.field;
            throw err;
        }
        if (reason === 'insufficient_role') {
            throw new Error('Nincs jogosultságod a workflow módosításához.');
        }
        if (reason === 'name_taken') {
            throw new Error(`Már létezik workflow ezzel a névvel: „${response.name || name}".`);
        }
        if (reason === 'invalid_name') {
            throw new Error('Érvénytelen név.');
        }
        if (reason === 'invalid_description') {
            throw new Error('Érvénytelen leírás (maximum 500 karakter).');
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
            // Legacy alias (#30 előtt). Maradjon itt a backward-compat miatt.
            const count = Array.isArray(response.orphanedPublications)
                ? response.orphanedPublications.length
                : 0;
            const suffix = count > 0 ? ` (${count} másik szerkesztőségbeli kiadvány hivatkozik rá)` : '';
            const err = new Error(`A láthatóság nem szűkíthető le „Szerkesztőség" szintre${suffix}.`);
            err.code = 'visibility_downgrade_blocked';
            err.orphanedPublications = response.orphanedPublications || [];
            throw err;
        }
        throw new Error(`Módosítási hiba: ${reason}`);
    }

    return {
        workflowId: response.workflowId,
        name: response.name,
        visibility: response.visibility,
        description: response.description ?? null
    };
}

/**
 * Workflow archiválása (soft-delete) — `archivedAt = now()`.
 *
 * Auth: a `createdBy === caller` tulajdonos VAGY org owner/admin.
 * Idempotens: már archivált → `{ action: 'already_archived' }`.
 *
 * @param {string} editorialOfficeId
 * @param {string} workflowId
 * @returns {Promise<{ success: boolean, workflowId: string, action: string, archivedAt: string|null }>}
 */
export async function archiveWorkflow(editorialOfficeId, workflowId) {
    const response = await callCF({
        action: 'archive_workflow',
        editorialOfficeId,
        workflowId
    });

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'insufficient_role') {
            throw new Error('Nincs jogosultságod a workflow archiválásához.');
        }
        if (reason === 'workflow_not_found') {
            throw new Error('A workflow nem található.');
        }
        if (reason === 'scope_mismatch') {
            throw new Error('A workflow nem az adott szerkesztőséghez tartozik.');
        }
        throw new Error(`Archiválási hiba: ${reason}`);
    }

    return response;
}

/**
 * Workflow visszaállítása archiválásból — `archivedAt = null`.
 *
 * Auth azonos az archive action-nel. Idempotens: már aktív → `{ action: 'already_active' }`.
 *
 * @param {string} editorialOfficeId
 * @param {string} workflowId
 * @returns {Promise<{ success: boolean, workflowId: string, action: string }>}
 */
export async function restoreWorkflow(editorialOfficeId, workflowId) {
    const response = await callCF({
        action: 'restore_workflow',
        editorialOfficeId,
        workflowId
    });

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'insufficient_role') {
            throw new Error('Nincs jogosultságod a workflow visszaállításához.');
        }
        if (reason === 'workflow_not_found') {
            throw new Error('A workflow nem található.');
        }
        if (reason === 'scope_mismatch') {
            throw new Error('A workflow nem az adott szerkesztőséghez tartozik.');
        }
        throw new Error(`Visszaállítási hiba: ${reason}`);
    }

    return response;
}

/**
 * Workflow duplikálás — a forrás compiled JSON klónozása új doc-ba.
 *
 * #81 óta cross-tenant: az `editorialOfficeId` a TARGET office (a caller
 * aktív szerkesztősége), a forrás bármilyen scope-ban lehet, amelyhez a
 * callernek olvasási joga van. A duplikátum MINDIG `editorial_office`
 * scope-on indul, `createdBy = caller`. Ha a név nincs megadva, a CF
 * automatikus `(másolat)` / `(másolat 2)` suffix-szel névütközés-mentes
 * nevet képez.
 *
 * @param {string} editorialOfficeId - Cél szerkesztőség ID (target)
 * @param {string} workflowId - Forrás workflow doc ID
 * @param {string} [name] - Új név (opcionális; ha hiányzik, auto-suffix)
 * @returns {Promise<{ workflowId: string, name: string, visibility: string, crossTenant?: boolean }>}
 * @throws {Error} Ha a CF hívás sikertelen
 */
export async function duplicateWorkflow(editorialOfficeId, workflowId, name) {
    const body = {
        action: 'duplicate_workflow',
        editorialOfficeId,
        workflowId
    };
    if (name !== undefined && name !== null) body.name = name;

    const response = await callCF(body);

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        if (reason === 'insufficient_role') {
            throw new Error('Nincs jogosultságod workflow duplikálásához.');
        }
        if (reason === 'source_archived') {
            throw new Error('A forrás workflow archivált, előbb állítsd vissza.');
        }
        if (reason === 'source_read_denied') {
            throw new Error('Nem fér hozzá ehhez a workflow-hoz.');
        }
        if (reason === 'name_taken') {
            throw new Error(`Már létezik workflow ezzel a névvel: „${response.name || name}".`);
        }
        if (reason === 'missing_fields' || reason === 'invalid_name') {
            throw new Error('Érvénytelen név.');
        }
        if (reason === 'source_not_found' || reason === 'workflow_not_found') {
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
        visibility: response.visibility,
        crossTenant: !!response.crossTenant
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
 * @throws {Error} Ha a CF hívás sikertelen. A dobott `err.code` a CF `reason`-jét
 *   tükrözi — `'insufficient_role'` non-owner esetén, egyéb CF reason egyébként.
 *   A hívók a `err.code`-ra branch-elhetnek a lokalizált üzenet-parszolás helyett.
 */
export async function bootstrapWorkflowSchema() {
    const response = await callCF({ action: 'bootstrap_workflow_schema' });

    if (!response.success) {
        const reason = response.reason || 'unknown_error';
        // Strukturált error code — a hívó lokalizált üzenet helyett `err.code`-ra branch-elhet.
        if (reason === 'insufficient_role') {
            const err = new Error('Csak owner jogosultságú felhasználó futtathatja.');
            err.code = 'insufficient_role';
            throw err;
        }
        const err = new Error(`Schema bootstrap hiba: ${reason}`);
        err.code = reason;
        throw err;
    }

    return response;
}
