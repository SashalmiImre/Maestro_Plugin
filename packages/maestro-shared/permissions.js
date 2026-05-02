/**
 * Maestro Shared — Jogosultsági slug-konstansok és sync helperek (ADR 0008).
 *
 * Ez a modul a kanonikus slug-katalógus a 38 permission slug + 8 logikai
 * csoport + 3 default permission set számára. Mind a Plugin (UserContext),
 * mind a Dashboard (PermissionSetsTab + AuthContext), mind a CF guardok
 * ezt használják.
 *
 * **Scope szétválasztás (B.3 ADR 0008):**
 * - **5 org-scope slug** (`org.*`): csak `userHasOrgPermission()`-en át
 *   adhatók — `permissionSets.permissions[]`-be tilos beletenni.
 * - **33 office-scope slug** (minden, ami nem `org.*`): `permissionSets`-en
 *   keresztül adhatók egy `editorialOfficeId` scope-ban.
 *
 * **Drift-kockázat**: a CF (CommonJS) inline másolatot tart az async lookup
 * helpereken kívüli részekből (`packages/maestro-server/functions/
 * invite-to-organization/src/permissions.js`) — Phase 2 AST-equality CI
 * teszt vagy single-source bundle kötelező a hosszú távú konzisztenciához.
 * Részletek a [[Komponensek/PermissionTaxonomy]] vault-jegyzetben.
 *
 * Az async lookup helperek (`userHasPermission`, `userHasOrgPermission`,
 * `buildPermissionSnapshot`) NEM itt vannak — DB-hívást igényelnek, ezért
 * a server-only `permissions.js` (CF-belül) tartalmazza őket. A frontend
 * kliens-cache az `enrichUserWithPermissions()` (Plugin UserContext / Dashboard
 * AuthContext) `user.permissions: Set<string>` mezőjéből döntse el a guardot
 * — server-side a végső authority.
 */

// ── 1. Org-scope slug-ok (5 db) — csak organizationMemberships.role ─────────
//
// Ezek soha nem kerülhetnek `permissionSets.permissions[]`-be — a server-side
// `validatePermissionSetSlugs()` 400 `org_scope_slug_not_allowed` errorral
// utasítja vissza. A `userHasOrgPermission()` az `organizationMemberships.role`-ból
// dönt: owner kapja mind az 5-öt, admin a 3-at (kivéve `org.delete` /
// `org.rename`), member-nek nincs.

export const ORG_SCOPE_PERMISSION_SLUGS = Object.freeze([
    'org.rename',
    'org.delete',
    'org.member.invite',
    'org.member.remove',
    'org.member.role.change'
]);

export const ORG_SCOPE_PERMISSION_SLUG_SET = new Set(ORG_SCOPE_PERMISSION_SLUGS);

/**
 * Az `admin` org-role NEM kapja meg ezeket az org-scope slug-okat —
 * ezek kizárólag `owner` jogkör.
 */
export const ADMIN_EXCLUDED_ORG_SLUGS = new Set(['org.delete', 'org.rename']);

// ── 2. Office-scope slug-ok (33 db) ─────────────────────────────────────────
//
// Ezek `permissionSets`-en keresztül adhatók egy adott `editorialOfficeId`
// scope-ban. A `userHasPermission()` a következő láncot járja be:
//   1. `user.labels?.includes('admin')` → trivial true (Appwrite global admin)
//   2. `organizationMemberships.role === 'owner' | 'admin'` → mind a 33 slug
//   3. permission set lookup (`groupMemberships` × `groupPermissionSets`
//      × `permissionSets.permissions[]`) → user-scope Set
//
// A 8 logikai csoport (UI mátrix) a `PERMISSION_GROUPS` konstansból ered.

export const OFFICE_SCOPE_PERMISSION_SLUGS = Object.freeze([
    // 2. Szerkesztőség (4)
    'office.create',
    'office.rename',
    'office.delete',
    'office.settings.edit',

    // 3. Felhasználó-csoportok (5)
    'group.create',
    'group.rename',
    'group.delete',
    'group.member.add',
    'group.member.remove',

    // 4. Jogosultság-csoportok (4)
    'permissionSet.create',
    'permissionSet.edit',
    'permissionSet.archive',
    'permissionSet.assign',

    // 5. Bővítmények (3) — ADR 0007 Phase 0
    'extension.create',
    'extension.edit',
    'extension.archive',

    // 6. Kiadvány (6)
    'publication.create',
    'publication.edit',
    'publication.archive',
    'publication.activate',
    'publication.workflow.assign',
    'publication.settings.edit',

    // 7. Workflow CRUD (5)
    'workflow.create',
    'workflow.edit',
    'workflow.archive',
    'workflow.duplicate',
    'workflow.share',

    // 8. Workflow-tartalom (6) — designer-en belül
    'workflow.state.edit',
    'workflow.transition.edit',
    'workflow.permission.edit',
    'workflow.requiredGroups.edit',
    'workflow.validation.edit',
    'workflow.command.edit'
]);

export const OFFICE_SCOPE_PERMISSION_SLUG_SET = new Set(OFFICE_SCOPE_PERMISSION_SLUGS);

// ── 3. Teljes katalógus (38) ────────────────────────────────────────────────

export const ALL_PERMISSION_SLUGS = Object.freeze([
    ...ORG_SCOPE_PERMISSION_SLUGS,
    ...OFFICE_SCOPE_PERMISSION_SLUGS
]);

export const ALL_PERMISSION_SLUG_SET = new Set(ALL_PERMISSION_SLUGS);

// ── 4. Logikai csoportok (UI mátrix renderhez) ──────────────────────────────
//
// A 8 csoport magyar UI-label-lel + slug-lista. A Dashboard
// `PermissionSetEditor` ezt rendereli mátrix-ban, a CF csak validációhoz
// használja (a slug elem-e az `ALL_PERMISSION_SLUG_SET`-nek).

export const PERMISSION_GROUPS = Object.freeze([
    {
        id: 'organization',
        label: 'Szervezet',
        scope: 'org',
        description: 'Org-szintű műveletek — kizárólag az organizationMemberships.role-on át.',
        slugs: ['org.rename', 'org.delete', 'org.member.invite', 'org.member.remove', 'org.member.role.change']
    },
    {
        id: 'office',
        label: 'Szerkesztőség',
        scope: 'office',
        description: 'Szerkesztőség-szintű CRUD műveletek.',
        slugs: ['office.create', 'office.rename', 'office.delete', 'office.settings.edit']
    },
    {
        id: 'group',
        label: 'Felhasználó-csoportok',
        scope: 'office',
        description: 'Manuális csoport-CRUD és tagság-műveletek.',
        slugs: ['group.create', 'group.rename', 'group.delete', 'group.member.add', 'group.member.remove']
    },
    {
        id: 'permissionSet',
        label: 'Jogosultság-csoportok',
        scope: 'office',
        description: 'Permission set CRUD és csoport-hozzárendelés.',
        slugs: ['permissionSet.create', 'permissionSet.edit', 'permissionSet.archive', 'permissionSet.assign']
    },
    {
        id: 'extension',
        label: 'Bővítmények',
        scope: 'office',
        description: 'Workflow extension CRUD (ADR 0007 Phase 0).',
        slugs: ['extension.create', 'extension.edit', 'extension.archive']
    },
    {
        id: 'publication',
        label: 'Kiadvány',
        scope: 'office',
        description: 'Publikáció CRUD és aktiválás.',
        slugs: [
            'publication.create',
            'publication.edit',
            'publication.archive',
            'publication.activate',
            'publication.workflow.assign',
            'publication.settings.edit'
        ]
    },
    {
        id: 'workflowCrud',
        label: 'Workflow CRUD',
        scope: 'office',
        description: 'Workflow létrehozás, archiválás, duplikálás, megosztás.',
        slugs: ['workflow.create', 'workflow.edit', 'workflow.archive', 'workflow.duplicate', 'workflow.share']
    },
    {
        id: 'workflowContent',
        label: 'Workflow-tartalom',
        scope: 'office',
        description: 'Designer-en belüli tartalom-szerkesztő finom-jogok (a workflow.edit master-jog mellett értelmesek).',
        slugs: [
            'workflow.state.edit',
            'workflow.transition.edit',
            'workflow.permission.edit',
            'workflow.requiredGroups.edit',
            'workflow.validation.edit',
            'workflow.command.edit'
        ]
    }
]);

// ── 5. Default permission set-ek (A.3.2 seed) ──────────────────────────────
//
// A `bootstrap_organization` és `create_editorial_office` minden új office-ra
// seedeli ezt a 3 default permission set-et. Csoporthoz nincsenek
// hozzárendelve — az org owner / admin manuálisan rendel hozzá vagy
// testreszab.
//
// Az `owner_base` és `admin_base` tartalom-azonos: mind a 33 office-scope
// slug. A különbség kizárólag az `organizationMemberships.role`-ban van
// (owner kap 5 org-scope slug-ot, admin 3-at) — ezt a `userHasOrgPermission()`
// dönti el, NEM ez a permission set. Az `admin_base` set létezésének értelme:
// ha egy felhasználó NEM org-admin (csak member), de office-szinten admin-jellegű
// jogokat kell kapjon, ez a set a csoportjához rendelhető.

export const DEFAULT_PERMISSION_SETS = Object.freeze([
    {
        slug: 'owner_base',
        name: 'Tulajdonos alap',
        description: 'A 33 office-scope slug teljes halmaza. Az org-szintű 5 org.* slug az organizationMemberships.role === \'owner\'-ből jön — nem ebből a set-ből.',
        permissions: [...OFFICE_SCOPE_PERMISSION_SLUGS]
    },
    {
        slug: 'admin_base',
        name: 'Adminisztrátor alap',
        description: 'Tartalom-azonos owner_base-szel (33 office-scope slug). A különbség csak az org.*-okon van: az admin role kapja az org.member.*-ot, de NEM kapja az org.delete/org.rename-et — ez kizárólag a role-on át.',
        permissions: [...OFFICE_SCOPE_PERMISSION_SLUGS]
    },
    {
        slug: 'member_base',
        name: 'Tag alap',
        description: 'Saját kezdeményezésű alap-műveletek: publikáció létrehozás + aktiválás + workflow forkolás. A tényleges cikk-szintű munka-jog a workflow-runtime-ból ered (canUserMoveArticle), nem ebből a set-ből.',
        permissions: ['publication.create', 'publication.activate', 'workflow.duplicate']
    }
]);

// ── 6. Sync helperek (kliens + szerver egyaránt) ────────────────────────────

/**
 * @param {string} slug - permission slug
 * @returns {boolean} true ha office-scope (33 slug egyike)
 */
export function isOfficeScopeSlug(slug) {
    return OFFICE_SCOPE_PERMISSION_SLUG_SET.has(slug);
}

/**
 * @param {string} slug - permission slug
 * @returns {boolean} true ha org-scope (5 slug egyike, `org.*` prefix)
 */
export function isOrgScopeSlug(slug) {
    return ORG_SCOPE_PERMISSION_SLUG_SET.has(slug);
}

/**
 * @param {string} slug - permission slug
 * @returns {boolean} true ha a 38 ismert slug egyike
 */
export function isKnownPermissionSlug(slug) {
    return ALL_PERMISSION_SLUG_SET.has(slug);
}

/**
 * `permissionSets.permissions[]` validálása. A `create_permission_set` és
 * `update_permission_set` CF action ezt használja a save előtt.
 *
 * **Két szabály:**
 * 1. Minden slug az `OFFICE_SCOPE_PERMISSION_SLUG_SET`-ben legyen.
 * 2. Az `org.*`-prefixű slug-ok explicit elutasítva (`org_scope_slug_not_allowed`)
 *    — különben az org-szintű jogokat permission set-en át lehetne kiosztani,
 *    ami sérti az ADR 0008 B.3 pontját.
 *
 * Ismeretlen (nem `org.*`, de NEM is office-scope) slug-ok az `unknown_slug`
 * errort kapják.
 *
 * @param {string[]} slugs - validálandó slug lista
 * @returns {{ valid: boolean, errors: Array<{ code: string, slug: string, message: string }> }}
 */
export function validatePermissionSetSlugs(slugs) {
    const errors = [];

    if (!Array.isArray(slugs)) {
        errors.push({
            code: 'invalid_field_type',
            slug: '',
            message: 'A permissions mezőnek tömbnek kell lennie.'
        });
        return { valid: false, errors };
    }

    for (const slug of slugs) {
        if (typeof slug !== 'string' || !slug) {
            errors.push({
                code: 'invalid_slug',
                slug: String(slug),
                message: `Érvénytelen slug típus / üres slug: ${JSON.stringify(slug)}.`
            });
            continue;
        }

        if (ORG_SCOPE_PERMISSION_SLUG_SET.has(slug)) {
            errors.push({
                code: 'org_scope_slug_not_allowed',
                slug,
                message: `Az ${slug} org-scope slug — soha nem tárolható permission set-ben. Az org.* jogok kizárólag az organizationMemberships.role-ból származnak.`
            });
            continue;
        }

        if (!OFFICE_SCOPE_PERMISSION_SLUG_SET.has(slug)) {
            errors.push({
                code: 'unknown_slug',
                slug,
                message: `Ismeretlen permission slug: ${slug}. Az érvényes office-scope slug-ok listáját ld. OFFICE_SCOPE_PERMISSION_SLUGS-ben (38 slug, 8 csoport — PermissionTaxonomy.md).`
            });
        }
    }

    // Duplikátum-check (engedmény-logikájú: a kettős seed nem hibás, de
    // jelezzük a kliensnek a normalizációhoz)
    const seen = new Set();
    const duplicates = new Set();
    for (const slug of slugs) {
        if (typeof slug !== 'string') continue;
        if (seen.has(slug)) duplicates.add(slug);
        seen.add(slug);
    }
    for (const slug of duplicates) {
        errors.push({
            code: 'duplicate_slug',
            slug,
            message: `Duplikált slug a permissions tömbben: ${slug}.`
        });
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Egyetlen permission slug ellenőrzése — a CF `userHasPermission()` /
 * `userHasOrgPermission()` belépési pontján használt minimális validáció.
 * Throw-ol ha a slug nem ismert vagy rossz scope-ú.
 *
 * @param {string} slug
 * @param {'office'|'org'} expectedScope
 * @throws {Error} ha a slug ismeretlen vagy rossz scope-ú
 */
export function assertSlugScope(slug, expectedScope) {
    if (typeof slug !== 'string' || !slug) {
        throw new Error(`assertSlugScope: invalid slug "${slug}"`);
    }
    if (expectedScope === 'org') {
        if (!ORG_SCOPE_PERMISSION_SLUG_SET.has(slug)) {
            throw new Error(
                `userHasOrgPermission() org-scope only — got "${slug}". Use userHasPermission() for office-scope slugs.`
            );
        }
    } else if (expectedScope === 'office') {
        if (!OFFICE_SCOPE_PERMISSION_SLUG_SET.has(slug)) {
            throw new Error(
                `userHasPermission() office-scope only — got "${slug}". Use userHasOrgPermission() for org-scope slugs (org.*).`
            );
        }
    } else {
        throw new Error(`assertSlugScope: unknown expectedScope "${expectedScope}" (must be 'office' or 'org').`);
    }
}

/**
 * Egy `user.permissions` Set + egy slug alapján dönt, hogy a kliens megkapta-e
 * a jogot. **Csak office-scope slug-okra használható** — org-scope slug-okra
 * `assertSlugScope('org')` exception-t dob.
 *
 * **NEM helyettesíti a server-side guardot** — a `user.permissions` egy
 * cache-elt snapshot, ami stale lehet (Realtime push előtt). A CF
 * `userHasPermission()`-je a végső authority.
 *
 * @param {Set<string>|string[]|null|undefined} userPermissions
 * @param {string} slug
 * @returns {boolean}
 */
export function clientHasPermission(userPermissions, slug) {
    assertSlugScope(slug, 'office');
    if (!userPermissions) return false;
    if (userPermissions instanceof Set) return userPermissions.has(slug);
    if (Array.isArray(userPermissions)) return userPermissions.includes(slug);
    return false;
}
