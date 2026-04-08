/**
 * Maestro Dashboard — Konfiguráció
 *
 * A közös konstansok a maestro-shared csomagból jönnek.
 * Itt csak a dashboard-specifikus értékek és a re-exportok vannak.
 */

// ─── Shared importok ────────────────────────────────────────────────────────

export {
    APPWRITE_PROJECT_ID,
    DATABASE_ID,
    COLLECTIONS,
    TEAMS,
    BUCKETS,
    FUNCTIONS,
    GET_TEAM_MEMBERS_FUNCTION_ID
} from '@shared/appwriteIds.js';

export {
    WORKFLOW_STATES,
    MARKERS,
    STATE_DURATIONS,
    TEAM_ARTICLE_FIELD,
    STATUS_LABELS,
    STATUS_COLORS
} from '@shared/workflowConfig.js';

export {
    LOCK_TYPE,
    VALIDATION_TYPES
} from '@shared/constants.js';

export {
    resolveGrantedTeams,
    hasCapability,
    CAPABILITY_LABELS,
    VALID_LABELS
} from '@shared/labelConfig.js';

// ─── Dashboard-specifikus ───────────────────────────────────────────────────

/** Közvetlen Appwrite endpoint (nem proxy-n keresztül). */
export const APPWRITE_ENDPOINT = 'https://cloud.appwrite.io/v1';

/**
 * Workflow konfiguráció — label és szín állapotonként.
 * A komponensek WORKFLOW_CONFIG[state].label / .color-t használják.
 */
import { STATUS_LABELS as _SL, STATUS_COLORS as _SC } from '@shared/workflowConfig.js';

export const WORKFLOW_CONFIG = Object.fromEntries(
    Object.entries(_SL).map(([state, label]) => [
        state, { label, color: _SC[state] || '#999' }
    ])
);

/**
 * A Dashboard saját origin URL-je az Appwrite verifikációs/recovery callback-ekhez.
 * Az `account.createVerification()` és `account.createRecovery()` ezt használja
 * abszolút URL-ként. Production-ban env var (`VITE_DASHBOARD_URL`) felülírhatja.
 */
export const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL || window.location.origin;

/** Dashboard localStorage kulcsok. */
export const STORAGE_KEYS = {
    SELECTED_PUBLICATION: 'maestro.dashboard.selectedPublication',
    FILTER_STATUS: 'maestro.dashboard.filterStatus',
    FILTER_SHOW_IGNORED: 'maestro.dashboard.filterShowIgnored',
    FILTER_SHOW_ONLY_MINE: 'maestro.dashboard.filterShowOnlyMine',
    FILTER_SHOW_PLACEHOLDERS: 'maestro.dashboard.filterShowPlaceholders',
    LAYOUT_COLUMNS: 'maestro.dashboard.layoutColumns',
    LAYOUT_SELECTED: 'maestro.dashboard.layoutSelected'
};

/** Sürgősség újraszámítás gyakorisága (5 perc). */
export const URGENCY_REFRESH_INTERVAL_MS = 300_000;

/** Csapattag cache élettartama (5 perc). */
export const TEAM_CACHE_DURATION_MS = 300_000;

/** Lapozás méret az Appwrite lekérdezésekhez. */
export const PAGE_SIZE = 100;
