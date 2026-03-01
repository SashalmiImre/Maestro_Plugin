/**
 * @fileoverview Workflow module barrel export.
 * @module utils/workflow
 */

export { WORKFLOW_STATES, MARKERS, TRANSITION_TYPES, WORKFLOW_CONFIG, STATE_PERMISSIONS, TEAM_ARTICLE_FIELD } from "./workflowConstants.js";
export { WorkflowEngine } from "./workflowEngine.js";
export { canUserMoveArticle, hasTransitionPermission } from "./workflowPermissions.js";
