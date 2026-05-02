/**
 * Maestro Server — Workflow doc létrehozás (Fázis 1 helper-extract, 2026-05-02).
 *
 * `createWorkflowDoc` schema-safe fallback-kel hozza létre a workflow dokumentumot
 * a #30-as `visibility` + `createdBy` mezőkkel és #80 doc-szintű ACL-lel. Ha a
 * `bootstrap_workflow_schema` még nem futott le egy upgrade alatt álló
 * env-ben, az új attribútumok hiánya esetén legacy retry-ot ad — kizárólag
 * a default `editorial_office` scope-ra (különben az eredeti hiba propagálódik).
 */

const { WORKFLOW_VISIBILITY_DEFAULT } = require('./constants.js');

/**
 * Workflow doc létrehozás a #30-as mezőkkel (`visibility`, `createdBy`) és
 * #80 doc-szintű ACL-lel, schema-safe fallback-kel. Ha a
 * `bootstrap_workflow_schema` még nem futott le egy upgrade alatt álló
 * env-ben, az Appwrite `document_invalid_structure` (400) hibát dob az új
 * attribútumokra — ezen az ágon legacy retry fut nélküle.
 *
 * @param {sdk.Databases} databases
 * @param {string} databaseId
 * @param {string} workflowsCollectionId
 * @param {string} docId — ID.unique() vagy explicit
 * @param {Object} baseFields — workflow alap-mezők (editorialOfficeId, organizationId, name, version, compiled, updatedByUserId stb.)
 * @param {string} visibility — 'editorial_office' | 'organization' | 'public'
 * @param {string} callerId — `createdBy` mezőt erre állítja
 * @param {string[]} permissions — Appwrite doc-szintű perms (`buildWorkflowAclPerms` outputja)
 * @param {Function} log
 * @returns {Promise<Object>} a létrejött workflow doc
 */
async function createWorkflowDoc(
    databases, databaseId, workflowsCollectionId, docId, baseFields, visibility, callerId, permissions, log
) {
    try {
        return await databases.createDocument(
            databaseId,
            workflowsCollectionId,
            docId,
            {
                ...baseFields,
                visibility,
                createdBy: callerId
            },
            permissions
        );
    } catch (err) {
        const msg = err?.message || '';
        const isSchemaMissing =
            (err?.type === 'document_invalid_structure' || err?.code === 400)
            && /visibility|createdBy|unknown attribute/i.test(msg);
        if (!isSchemaMissing) {
            throw err;
        }
        if (visibility !== WORKFLOW_VISIBILITY_DEFAULT) {
            // Nem tudjuk biztonságosan elmenteni a nem-default visibility-t —
            // az eredeti hiba terjedjen a hívóra (az `bootstrap_workflow_schema`
            // futtatása után retry-olható).
            throw err;
        }
        log(`[WorkflowDoc] Schema hiányos (visibility/createdBy) — legacy retry without #30 fields. docId=${docId}`);
        return databases.createDocument(
            databaseId,
            workflowsCollectionId,
            docId,
            baseFields,
            permissions
        );
    }
}

module.exports = {
    createWorkflowDoc
};
