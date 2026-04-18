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
    BUCKETS,
    FUNCTIONS
} from '@shared/appwriteIds.js';

export {
    LOCK_TYPE,
    VALIDATION_TYPES,
    MARKERS
} from '@shared/constants.js';

// ─── Dashboard-specifikus ───────────────────────────────────────────────────

/**
 * Közvetlen Appwrite endpoint (nem proxy-n keresztül).
 * Production-ban érdemes saját custom domain-t használni (pl. `api.maestro.emago.hu`),
 * hogy a böngésző első-feles cookie-ként kezelje a session-t — különben Safari ITP
 * (és hamarosan Chrome) blokkolja a WebSocket upgrade-nél küldött session cookie-t,
 * és a Realtime nem kap push-t.
 */
export const APPWRITE_ENDPOINT = import.meta.env.VITE_APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1';

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

/** Csoporttag cache élettartama (5 perc). */
export const TEAM_CACHE_DURATION_MS = 300_000;

/** Lapozás méret az Appwrite lekérdezésekhez. */
export const PAGE_SIZE = 100;
