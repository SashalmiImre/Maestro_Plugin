// 3-way workflow visibility scope match — Feladat #80 (ADR 0006).
// Single-source helper a publication-workflow párosítás scope-ellenőrzésére
// (`createPublicationWithWorkflow`, `assignWorkflowToPublication`,
// `activatePublication`). A `WORKFLOW_VISIBILITY_VALUES`-ban nem szereplő
// érték a `WORKFLOW_VISIBILITY_DEFAULT`-ra esik vissza (legacy null-fallback,
// a `actions/workflows.js` `deleteWorkflow` `public` fail-closed eltér: ott
// a delete-blocker célja minden hivatkozó pubot megtalálni).

const {
    WORKFLOW_VISIBILITY_VALUES,
    WORKFLOW_VISIBILITY_DEFAULT
} = require('./constants.js');

/**
 * @param {object} workflowDoc - `workflows` doc (`visibility`, `organizationId`, `editorialOfficeId`)
 * @param {{organizationId: string, editorialOfficeId: string}} target
 * @returns {{ ok: boolean, visibility: string }}
 */
function matchesWorkflowVisibility(workflowDoc, target) {
    const visibility = WORKFLOW_VISIBILITY_VALUES.includes(workflowDoc.visibility)
        ? workflowDoc.visibility
        : WORKFLOW_VISIBILITY_DEFAULT;
    if (visibility === 'public') return { ok: true, visibility };
    if (visibility === 'organization') {
        return { ok: workflowDoc.organizationId === target.organizationId, visibility };
    }
    if (visibility === 'editorial_office') {
        return { ok: workflowDoc.editorialOfficeId === target.editorialOfficeId, visibility };
    }
    return { ok: false, visibility };
}

module.exports = { matchesWorkflowVisibility };
