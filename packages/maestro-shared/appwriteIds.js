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
    USER_VALIDATIONS: 'userValidations',
    SYSTEM_VALIDATIONS: 'systemValidations',
    LAYOUTS: 'layouts',
    DEADLINES: 'deadlines',
    ORGANIZATIONS: 'organizations',
    ORGANIZATION_MEMBERSHIPS: 'organizationMemberships',
    EDITORIAL_OFFICES: 'editorialOffices',
    EDITORIAL_OFFICE_MEMBERSHIPS: 'editorialOfficeMemberships',
    ORGANIZATION_INVITES: 'organizationInvites',
    GROUPS: 'groups',
    GROUP_MEMBERSHIPS: 'groupMemberships',
    WORKFLOWS: 'workflows',
    // ADR 0008 / A.3 — Jogosultság-csoportok (permission sets)
    PERMISSION_SETS: 'permissionSets',
    GROUP_PERMISSION_SETS: 'groupPermissionSets',
    // ADR 0007 Phase 0 / B.1.1 — Workflow extensions (validator + command)
    WORKFLOW_EXTENSIONS: 'workflowExtensions'
};

/**
 * Storage bucket azonosítók.
 * @enum {string}
 */
export const BUCKETS = {
    THUMBNAILS: 'thumbnails'
};

/**
 * Cloud Function azonosítók.
 *
 * Egy helyen sorolva fel, hogy a hívó csomagok (plugin + dashboard) ne
 * hardkódolják a string literal-eket külön-külön. A `GET_TEAM_MEMBERS`
 * egyelőre Appwrite belső ID-t használ, az új CF-ek (B.5+) már a
 * `functionId` slug-gal hívhatóak (pl. `invite-to-organization`).
 * @enum {string}
 */
export const FUNCTIONS = {
    INVITE_TO_ORGANIZATION: 'invite-to-organization'
};
