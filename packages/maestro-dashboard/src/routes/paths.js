/**
 * Maestro Dashboard — Route path builderek
 *
 * Egy helyen tart minden alkalmazás URL-t. Ha egy route átnevezésre kerül
 * (ld. #83: /admin/office/:officeId/workflow/:id → /workflows/:id), csak
 * itt kell módosítani, a navigate()/Link to= hívók automatikusan követik.
 */

/** Workflow Designer — konkrét workflow szerkesztő oldal. */
export function workflowPath(workflowId) {
    return `/workflows/${workflowId}`;
}

/** Workflow Designer — új workflow belépési pont (CreateWorkflowModal). */
export const WORKFLOW_NEW_PATH = '/workflows/new';
