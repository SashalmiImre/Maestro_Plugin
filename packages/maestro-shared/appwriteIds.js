/**
 * Maestro Shared — Appwrite azonosítók
 *
 * Projekt, adatbázis, gyűjtemény, funkció és csapat ID-k.
 * Egyetlen igazságforrás, amit mind a plugin, mind a dashboard használ.
 */

export const APPWRITE_PROJECT_ID = '68808427001c20418996';
export const DATABASE_ID = '6880850e000da87a3d55';

/**
 * Gyűjtemény azonosítók.
 * @enum {string}
 */
export const COLLECTIONS = {
    PUBLICATIONS: 'publications',
    ARTICLES: 'articles',
    USER_VALIDATIONS: 'uservalidations',
    SYSTEM_VALIDATIONS: 'validations',
    LAYOUTS: 'layouts',
    DEADLINES: 'deadlines',
    CONFIG: 'config',
    ORGANIZATIONS: 'organizations',
    ORGANIZATION_MEMBERSHIPS: 'organizationMemberships',
    EDITORIAL_OFFICES: 'editorialOffices',
    EDITORIAL_OFFICE_MEMBERSHIPS: 'editorialOfficeMemberships',
    ORGANIZATION_INVITES: 'organizationInvites'
};

/**
 * Csapat slug-ok.
 * @enum {string}
 * @deprecated Fázis 4 végén törlendő — a dinamikus `groups` collection váltja.
 */
export const TEAMS = {
    EDITORS: 'editors',
    DESIGNERS: 'designers',
    WRITERS: 'writers',
    IMAGE_EDITORS: 'image_editors',
    ART_DIRECTORS: 'art_directors',
    MANAGING_EDITORS: 'managing_editors',
    PROOFWRITERS: 'proofwriters'
};

/**
 * Storage bucket azonosítók.
 * @enum {string}
 */
export const BUCKETS = {
    THUMBNAILS: 'thumbnails'
};

/** Cloud Function ID — csapattagok lekérése. */
export const GET_TEAM_MEMBERS_FUNCTION_ID = '69599cf9000a865db98a';
