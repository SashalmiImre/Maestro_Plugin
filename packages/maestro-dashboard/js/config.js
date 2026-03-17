/**
 * Maestro Dashboard — Konfiguráció
 *
 * A közös konstansok a maestro-shared csomagból jönnek.
 * Itt csak a dashboard-specifikus értékek és a kompatibilitási
 * re-exportok vannak.
 */

// ─── Shared importok (re-export, hogy a fogyasztók ne változzanak) ───────────

export {
    APPWRITE_PROJECT_ID,
    DATABASE_ID,
    COLLECTIONS,
    TEAMS,
    GET_TEAM_MEMBERS_FUNCTION_ID
} from '../shared/appwriteIds.js';

export {
    WORKFLOW_STATES,
    MARKERS,
    STATE_DURATIONS,
    TEAM_ARTICLE_FIELD,
    STATUS_LABELS,
    STATUS_COLORS
} from '../shared/workflowConfig.js';

export {
    LOCK_TYPE,
    VALIDATION_TYPES
} from '../shared/constants.js';

// ─── Dashboard-specifikus ───────────────────────────────────────────────────

/** Közvetlen Appwrite endpoint (nem proxy-n keresztül). */
export const APPWRITE_ENDPOINT = 'https://cloud.appwrite.io/v1';

/**
 * Workflow konfiguráció — label és szín állapotonként.
 * A fogyasztók WORKFLOW_CONFIG[state].label / .color-t használják.
 */
import { STATUS_LABELS, STATUS_COLORS } from '../shared/workflowConfig.js';

export const WORKFLOW_CONFIG = {};
for (const [state, label] of Object.entries(STATUS_LABELS)) {
    WORKFLOW_CONFIG[state] = { label, color: STATUS_COLORS[state] || '#999' };
}

/** Dashboard localStorage kulcsok. */
export const STORAGE_KEYS = {
    SELECTED_PUBLICATION: 'maestro.dashboard.selectedPublication',
    FILTER_STATUS: 'maestro.dashboard.filterStatus',
    FILTER_SHOW_IGNORED: 'maestro.dashboard.filterShowIgnored',
    FILTER_SHOW_ONLY_MINE: 'maestro.dashboard.filterShowOnlyMine'
};

/** Sürgősség újraszámítás gyakorisága (5 perc). */
export const URGENCY_REFRESH_INTERVAL_MS = 300_000;

/** Csapattag cache élettartama (5 perc). */
export const TEAM_CACHE_DURATION_MS = 300_000;
