/**
 * Maestro Shared — Közös konstansok
 *
 * Platform-független enumerációk, amiket mindkét projekt használ.
 */

/**
 * Zárolás típusok.
 * @enum {string}
 */
export const LOCK_TYPE = {
    USER: 'user',
    SYSTEM: 'system'
};

/**
 * Validáció típusok (felhasználói validációk severity szintjei).
 * A SUCCESS a Plugin-oldali `isResolved` megjelenítéshez használt — a DB-ben
 * nem fordul elő, de az UI state-kalkuláció ismeri.
 * @enum {string}
 */
export const VALIDATION_TYPES = {
    ERROR: 'error',
    WARNING: 'warning',
    INFO: 'info',
    SUCCESS: 'success'
};

/**
 * Jelölő (Marker) bitmaszkok.
 * A cikk megjelenítési állapotát jelölik (pl. kimarad a kiadványból).
 * @enum {number}
 */
export const MARKERS = {
    NONE: 0,
    IGNORE: 1
};

/**
 * Workflow láthatóság (#30, #80 bővítés: `public`).
 * - PUBLIC: az adott Appwrite instance minden authentikált user-e látja
 * - ORGANIZATION: az adott org bármely office-ának tagjai látják
 * - EDITORIAL_OFFICE: csak az adott office tagjai látják (default)
 *
 * @enum {string}
 */
export const WORKFLOW_VISIBILITY = {
    PUBLIC: 'public',
    ORGANIZATION: 'organization',
    EDITORIAL_OFFICE: 'editorial_office'
};

export const WORKFLOW_VISIBILITY_VALUES = [
    WORKFLOW_VISIBILITY.PUBLIC,
    WORKFLOW_VISIBILITY.ORGANIZATION,
    WORKFLOW_VISIBILITY.EDITORIAL_OFFICE
];

export const WORKFLOW_VISIBILITY_DEFAULT = WORKFLOW_VISIBILITY.EDITORIAL_OFFICE;

/**
 * A hatókörök szélessége (bővebb → szűkebb). A library panel
 * chip-sort + a scope-váltás warning/info döntéshez használjuk.
 */
export const WORKFLOW_VISIBILITY_RANK = {
    [WORKFLOW_VISIBILITY.PUBLIC]: 3,
    [WORKFLOW_VISIBILITY.ORGANIZATION]: 2,
    [WORKFLOW_VISIBILITY.EDITORIAL_OFFICE]: 1
};

/**
 * UI címkék a láthatósági chip-ekhez és toast üzenetekhez.
 * Magyar nyelvű, egy helyről — ne duplikáld komponensenként.
 */
export const WORKFLOW_VISIBILITY_LABELS = {
    [WORKFLOW_VISIBILITY.PUBLIC]: 'Publikus',
    [WORKFLOW_VISIBILITY.ORGANIZATION]: 'Szervezet',
    [WORKFLOW_VISIBILITY.EDITORIAL_OFFICE]: 'Szerkesztőség'
};

/**
 * Archivált workflow megőrzési idő napban. A `cleanup-archived-workflows`
 * cron CF ennyi napnál régebbi soft-delete-elt workflow-t hard-delete-el,
 * a dashboard UI ugyanezzel számolja ki a törlés várható dátumát
 * (`archivedAt + WORKFLOW_ARCHIVE_RETENTION_DAYS`).
 *
 * A CF CommonJS runtime miatt nem importálja ezt a fájlt — ugyanazt az
 * értéket hardkódolja a saját `DEFAULT_RETENTION_DAYS` konstansa. Ha ez
 * változik, a CF-et is frissíteni kell (deploy checklist).
 */
export const WORKFLOW_ARCHIVE_RETENTION_DAYS = 7;
