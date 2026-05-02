/**
 * Maestro Server — Permission helper modul (ADR 0008 / A.3.5 + A.3.7).
 *
 * **Server-only** verzió: a CommonJS Cloud Function a `packages/maestro-shared/
 * permissions.js` ESM modulját nem tudja közvetlenül importálni (drift-rizikó:
 * a slug-konstansok inline duplikálva vannak — Phase 2 single-source bundle
 * build-step refactor, ld. A.7.1). Az async lookup helperek (`buildPermissionSnapshot`,
 * `userHasPermission`, `userHasOrgPermission`) viszont kizárólag itt vannak,
 * mert DB-hívást igényelnek.
 *
 * **Per-request memoizáció (A.3.7)**: a CF entry-pointja két `Map`-et hoz létre
 * és minden helper-hívásnak átadja:
 *   - `snapshotsByOffice: Map<cacheKey, PermissionSnapshot>` — office-scope
 *     snapshot, egy `userId+officeId` párra egyszer számol DB lookupot.
 *   - `orgRoleByOrg: Map<cacheKey, 'owner'|'admin'|'member'|null>` — org-role,
 *     `userId+organizationId` párra cache-elve.
 *
 * **Cache-kulcs userId-vel** (Codex baseline review Critical): a kulcs
 * `${userId}::${scopeId}` formátumú, hogy multi-user CF flow-k (jövőbeli
 * target-user validáció) ne tudjanak más user snapshot-ját örökölni.
 *
 * Cross-request állapot **nincs**, a Map-ek a CF function-call lokálisak —
 * Appwrite container-pooling miatt theoretikusan túlélnék, de a hívó CF entry-point
 * az elején inicializálja, ezért minden bejövő request friss.
 *
 * @typedef {Object} PermissionSnapshot
 * @property {string} userId
 * @property {string} editorialOfficeId
 * @property {string|null} organizationId
 * @property {'owner'|'admin'|'member'|null} orgRole
 * @property {Set<string>} permissionSlugs - permission set lookup-ból összerakott office-scope Set
 * @property {boolean} hasGlobalAdminLabel - `user.labels?.includes('admin')` shortcut
 */

const sdk = require('node-appwrite');

// ── Slug-konstansok inline másolat (a shared ESM modulból) ──────────────────
//
// Drift kockázat: ha a `packages/maestro-shared/permissions.js` változik, ezt
// a két konstanst is frissíteni kell. Phase 2 (A.7.1 mintája): single-source
// bundle vagy AST-equality CI test.

const ORG_SCOPE_PERMISSION_SLUG_SET = new Set([
    'org.rename',
    'org.delete',
    'org.member.invite',
    'org.member.remove',
    'org.member.role.change'
]);

const ADMIN_EXCLUDED_ORG_SLUGS = new Set(['org.delete', 'org.rename']);

// `OFFICE_SCOPE_PERMISSION_SLUGS` (array) a default permission set-ek
// `permissions[]` mezőjéhez kell — a Set lookup-hoz és a sorrendhez egyaránt
// szükséges, ezért a kanonikus tömbből építjük a Set-et.
const OFFICE_SCOPE_PERMISSION_SLUGS = [
    // Szerkesztőség
    'office.create', 'office.rename', 'office.delete', 'office.settings.edit',
    // Felhasználó-csoportok
    'group.create', 'group.rename', 'group.delete', 'group.member.add', 'group.member.remove',
    // Jogosultság-csoportok
    'permissionSet.create', 'permissionSet.edit', 'permissionSet.archive', 'permissionSet.assign',
    // Bővítmények
    'extension.create', 'extension.edit', 'extension.archive',
    // Kiadvány
    'publication.create', 'publication.edit', 'publication.archive',
    'publication.activate', 'publication.workflow.assign', 'publication.settings.edit',
    // Workflow CRUD
    'workflow.create', 'workflow.edit', 'workflow.archive', 'workflow.duplicate', 'workflow.share',
    // Workflow-tartalom
    'workflow.state.edit', 'workflow.transition.edit', 'workflow.permission.edit',
    'workflow.requiredGroups.edit', 'workflow.validation.edit', 'workflow.command.edit'
];

const OFFICE_SCOPE_PERMISSION_SLUG_SET = new Set(OFFICE_SCOPE_PERMISSION_SLUGS);

// ── Default permission set-ek (A.3.2 seed) ──────────────────────────────────
//
// Inline duplikáció a `packages/maestro-shared/permissions.js`-ből — a CF
// CommonJS, az ESM-shared modult nem tudja importálni (drift hint, A.7.1
// Phase 2: AST-equality CI test vagy single-source bundle).

const DEFAULT_PERMISSION_SETS = [
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
];

// ── Sync scope-checkek ──────────────────────────────────────────────────────

function isOrgScopeSlug(slug) {
    return ORG_SCOPE_PERMISSION_SLUG_SET.has(slug);
}

function isOfficeScopeSlug(slug) {
    return OFFICE_SCOPE_PERMISSION_SLUG_SET.has(slug);
}

function assertOfficeScope(slug) {
    if (!isOfficeScopeSlug(slug)) {
        if (isOrgScopeSlug(slug)) {
            throw new Error(
                `userHasPermission() office-scope only — got "${slug}". Use userHasOrgPermission() for org.* slugs.`
            );
        }
        throw new Error(`userHasPermission(): unknown permission slug "${slug}".`);
    }
}

function assertOrgScope(slug) {
    if (!isOrgScopeSlug(slug)) {
        throw new Error(
            `userHasOrgPermission() org-scope only — got "${slug}". Use userHasPermission() for office-scope slugs.`
        );
    }
}

/**
 * `permissionSets.permissions[]` validáció a `create_permission_set` /
 * `update_permission_set` action save-flow-jához. Inline duplikáció a
 * `packages/maestro-shared/permissions.js`-ből.
 *
 * Két szabály:
 *  1. Minden slug az `OFFICE_SCOPE_PERMISSION_SLUG_SET`-ben legyen.
 *  2. `org.*`-prefixű slug-ok explicit elutasítva
 *     (`org_scope_slug_not_allowed`).
 *
 * @param {string[]} slugs
 * @returns {{ valid: boolean, errors: Array<{ code: string, slug: string, message: string }> }}
 */
function validatePermissionSetSlugs(slugs) {
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
                message: `Ismeretlen permission slug: ${slug}.`
            });
        }
    }

    // Duplikátum-check
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

// ── Lookup-ok (cache-elt, per-request) ──────────────────────────────────────

/**
 * Office → organizationId lookup. Per-request cache nincs ide szervezve
 * (a hívó snapshot szintjén cache-eljük az `organizationId`-t).
 */
async function lookupOrgIdFromOffice(databases, env, editorialOfficeId) {
    const { databaseId, officesCollectionId } = env;
    if (!editorialOfficeId) return null;
    try {
        const office = await databases.getDocument(databaseId, officesCollectionId, editorialOfficeId);
        return office.organizationId || null;
    } catch (err) {
        if (err?.code === 404) return null;
        throw err;
    }
}

/**
 * Office-tagság ellenőrzés egy adott `(userId, editorialOfficeId)` párra.
 *
 * Single-source-of-truth a defense-in-depth office-membership lookup-okhoz —
 * 3 hívási hely között megosztott:
 *   1. `buildPermissionSnapshot` member-path eleje (rogue `groupMembership`
 *      privilege-eszkalációs felület lezárása).
 *   2. `archive_workflow`/`restore_workflow` ownership-fallback (kilépett
 *      creator a workflow-jára nem maradhat jogosult).
 *   3. `update_workflow_metadata` visibility-ág ownership-fallback (ugyanaz).
 *
 * **Fail-closed**: env-hiány vagy DB-hiba esetén `false`, hogy az ownership-
 * jog csendben ne adódjon meg. Az SDK runtime log-olja a HTTP exception-t —
 * a hívóhelyek további logging-ja redundáns, és a Codex adversarial review
 * (2026-05-02) szerint a fail-closed defense-in-depth **szándékosan** néma.
 *
 * @param {sdk.Databases} databases
 * @param {Object} env - { databaseId, officeMembershipsCollectionId }
 * @param {string} userId
 * @param {string} editorialOfficeId
 * @returns {Promise<boolean>}
 */
async function isStillOfficeMember(databases, env, userId, editorialOfficeId) {
    if (!userId || !editorialOfficeId) return false;
    const { databaseId, officeMembershipsCollectionId } = env;
    if (!officeMembershipsCollectionId) return false;
    try {
        const list = await databases.listDocuments(
            databaseId,
            officeMembershipsCollectionId,
            [
                sdk.Query.equal('userId', userId),
                sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                sdk.Query.select(['$id']),
                sdk.Query.limit(1)
            ]
        );
        return list.documents.length > 0;
    } catch {
        return false;
    }
}

/**
 * User org-role lookup egy adott szervezetre. Per-request `orgRoleByOrg`
 * Map-pel cache-elt (a hívó adja át).
 *
 * **Cache-kulcs**: `${userId}::${organizationId}` (Codex baseline review
 * Critical: csak `organizationId` kulcs multi-user flow-ban auth leak-et
 * okozhatna).
 *
 * **Hibás lookup NEM kerül cache-be** (Codex baseline review P2): egy
 * átmeneti DB hiba ne okozzon determinisztikus 403-at a teljes requesten —
 * a következő hívás újraprobálkozik.
 *
 * @returns {'owner'|'admin'|'member'|null}
 */
async function getOrgRole(databases, env, userId, organizationId, orgRoleByOrg) {
    if (!userId || !organizationId) return null;

    const cacheKey = `${userId}::${organizationId}`;
    if (orgRoleByOrg && orgRoleByOrg.has(cacheKey)) {
        return orgRoleByOrg.get(cacheKey);
    }

    const { databaseId, membershipsCollectionId } = env;
    try {
        const list = await databases.listDocuments(databaseId, membershipsCollectionId, [
            sdk.Query.equal('organizationId', organizationId),
            sdk.Query.equal('userId', userId),
            sdk.Query.select(['$id', 'role']),
            sdk.Query.limit(1)
        ]);
        const role = list.documents.length > 0 ? (list.documents[0].role || null) : null;
        // Sikeres lookup: cache-eljük (akár null role is — pl. user nem tagja).
        if (orgRoleByOrg) orgRoleByOrg.set(cacheKey, role);
        return role;
    } catch (err) {
        // Fail-closed a hívóra (null), de NEM cache-elünk hibát — a következő
        // hívás újrapróbálkozhat. Egy átmeneti DB hiba ne fagyassza le a
        // teljes request engedélyezését.
        return null;
    }
}

// ── Snapshot építés (office-scope) ──────────────────────────────────────────

/**
 * Office-scope `permissionSnapshot` build. Egy hívás (egy office, egy user)
 * 4 DB lookupot jár be:
 *   1. office → organizationId (ha még nem ismert)
 *   2. user org-role (`organizationMemberships`)
 *   3. user `groupMemberships` az adott office-ban
 *   4. ha vannak group-ok → `groupPermissionSets` JOIN + `permissionSets` lookup
 *      (csak `archivedAt === null`, a soft-delete-elt set-ek figyelmen kívül)
 *
 * Owner/admin shortcut: a 33 office-scope slug egyaránt true, ezért a 3-4.
 * lookup kihagyható (a `permissionSlugs` Set teli OFFICE_SCOPE_PERMISSION_SLUG_SET-vel).
 *
 * Member-pathon (3-4. lookup) a 4. csak akkor fut, ha a 3. talált legalább 1
 * `groupMembership`-et — kék-kődanél a query elhagyható.
 *
 * @param {Object} databases - sdk.Databases
 * @param {Object} env - { databaseId, officesCollectionId, membershipsCollectionId,
 *                         officeMembershipsCollectionId,
 *                         groupMembershipsCollectionId, groupPermissionSetsCollectionId,
 *                         permissionSetsCollectionId }
 *   Az `officeMembershipsCollectionId` opcionális, de erősen ajánlott —
 *   defense-in-depth a member-path `groupMemberships` rogue write-tal szemben
 *   (lásd a 4-es lépésben).
 * @param {Object} user - { id, labels?: string[] }
 * @param {string} editorialOfficeId
 * @param {Map<string, string|'owner'|'admin'|'member'|null>} [orgRoleByOrg]
 * @returns {Promise<PermissionSnapshot>}
 */
async function buildPermissionSnapshot(databases, env, user, editorialOfficeId, orgRoleByOrg) {
    const userId = user?.id || user?.$id;
    const hasGlobalAdminLabel = Array.isArray(user?.labels) && user.labels.includes('admin');

    // 1) office → orgId
    const organizationId = await lookupOrgIdFromOffice(databases, env, editorialOfficeId);

    // 2) user org-role (cache-elt)
    const orgRole = userId && organizationId
        ? await getOrgRole(databases, env, userId, organizationId, orgRoleByOrg)
        : null;

    // 3) Owner/admin shortcut → mind a 33 office-scope slug
    if (hasGlobalAdminLabel || orgRole === 'owner' || orgRole === 'admin') {
        return {
            userId,
            editorialOfficeId,
            organizationId,
            orgRole,
            permissionSlugs: new Set(OFFICE_SCOPE_PERMISSION_SLUG_SET),
            hasGlobalAdminLabel
        };
    }

    // 4) Member-path: groupMemberships lookup az office-ban
    const slugs = new Set();
    if (!userId) {
        return {
            userId: null,
            editorialOfficeId,
            organizationId,
            orgRole,
            permissionSlugs: slugs,
            hasGlobalAdminLabel: false
        };
    }

    const { databaseId, groupMembershipsCollectionId, groupPermissionSetsCollectionId, permissionSetsCollectionId, officeMembershipsCollectionId } = env;
    if (!groupMembershipsCollectionId || !groupPermissionSetsCollectionId || !permissionSetsCollectionId) {
        // env hiánya → fail-closed üres set (member-pathon nincs jog)
        return { userId, editorialOfficeId, organizationId, orgRole, permissionSlugs: slugs, hasGlobalAdminLabel: false };
    }

    // **A.3.6 hardening (Codex adversarial review 2026-05-02 Critical fix)**:
    //   Defense-in-depth `editorialOfficeMemberships` cross-check a
    //   `isStillOfficeMember` shared helperrel. A `userHasPermission()`
    //   member-path-on a `groupMemberships` collection-en alapul, és a
    //   collection-ACL védi az integritást rendes körülmények között —
    //   DE: egy out-of-band DB-write (Appwrite Console / direkt API key
    //   script / kompromittált backup-restore) létrehozhat rogue
    //   `groupMembership` rekordot anélkül, hogy a user `editorialOfficeMemberships`
    //   tag lenne. Itt ezt explicit megakadályozzuk: ha a user nem tagja
    //   az office-nak, member-path üres set (privilege-eszkalációs felület
    //   lezárása). Az `officeMembershipsCollectionId` env-hiánya esetén az
    //   `isStillOfficeMember` `false`-t ad — ami **fail-closed** member-pathon.
    //   A `main.js` deploy-ban globálisan kötelezőként kezeli, így normál
    //   esetben a guard érvényesül.
    if (officeMembershipsCollectionId) {
        const stillMember = await isStillOfficeMember(databases, env, userId, editorialOfficeId);
        if (!stillMember) {
            return { userId, editorialOfficeId, organizationId, orgRole, permissionSlugs: slugs, hasGlobalAdminLabel: false };
        }
    }

    // groupMemberships lapozás (Codex review P1: 100+ csoport esetén csonkulás).
    // Cursor-based pagination, max 10 lap (1000 csoport / user — pathologikus
    // küszöb felett amúgy is rendszer-szintű probléma a workflow-driven
    // group autoseed mellett). 100 csoport / user reálisan extrém eset.
    //
    // **`$id` explicit a select-ben** (Codex baseline review P1): a cursorAfter
    // az utolsó doc `$id`-jét várja; szelektív `select()` defense-in-depth-tel
    // kerüljön be a kulcsmező.
    const groupIds = new Set();
    try {
        let cursor = null;
        for (let page = 0; page < 10; page++) {
            const queries = [
                sdk.Query.equal('userId', userId),
                sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                sdk.Query.select(['$id', 'groupId']),
                sdk.Query.limit(100)
            ];
            if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
            const list = await databases.listDocuments(databaseId, groupMembershipsCollectionId, queries);
            for (const doc of list.documents) {
                if (doc.groupId) groupIds.add(doc.groupId);
            }
            if (list.documents.length < 100) break;
            cursor = list.documents[list.documents.length - 1].$id;
        }
    } catch (err) {
        return { userId, editorialOfficeId, organizationId, orgRole, permissionSlugs: slugs, hasGlobalAdminLabel: false };
    }

    if (groupIds.size === 0) {
        return { userId, editorialOfficeId, organizationId, orgRole, permissionSlugs: slugs, hasGlobalAdminLabel: false };
    }

    // 5) groupPermissionSets — chunkolva 100-as blokkokra (Codex review P1:
    //    Appwrite Query.equal-array hard limit 100 érték).
    const permissionSetIds = new Set();
    const groupIdsArr = [...groupIds];
    const APPWRITE_QUERY_EQUAL_LIMIT = 100;
    try {
        for (let chunkStart = 0; chunkStart < groupIdsArr.length; chunkStart += APPWRITE_QUERY_EQUAL_LIMIT) {
            const chunk = groupIdsArr.slice(chunkStart, chunkStart + APPWRITE_QUERY_EQUAL_LIMIT);
            let cursor = null;
            for (let page = 0; page < 10; page++) {
                const queries = [
                    sdk.Query.equal('groupId', chunk),
                    sdk.Query.select(['$id', 'permissionSetId']),
                    sdk.Query.limit(100)
                ];
                if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
                const list = await databases.listDocuments(databaseId, groupPermissionSetsCollectionId, queries);
                for (const doc of list.documents) {
                    if (doc.permissionSetId) permissionSetIds.add(doc.permissionSetId);
                }
                if (list.documents.length < 100) break;
                cursor = list.documents[list.documents.length - 1].$id;
            }
        }
    } catch (err) {
        return { userId, editorialOfficeId, organizationId, orgRole, permissionSlugs: slugs, hasGlobalAdminLabel: false };
    }

    if (permissionSetIds.size === 0) {
        return { userId, editorialOfficeId, organizationId, orgRole, permissionSlugs: slugs, hasGlobalAdminLabel: false };
    }

    // 6) permissionSets lookup — chunked + lapozott (Codex review P1).
    //    Az `archivedAt === null` szűrést explicit beletesszük (Codex (b) opció):
    //    az archivált set továbbra is hivatkozható a `groupPermissionSets`-ből
    //    (junction docok intaktak), de jogokat NEM ad — restore esetén
    //    automatikusan újra él.
    try {
        const ids = [...permissionSetIds];
        for (let chunkStart = 0; chunkStart < ids.length; chunkStart += APPWRITE_QUERY_EQUAL_LIMIT) {
            const chunk = ids.slice(chunkStart, chunkStart + APPWRITE_QUERY_EQUAL_LIMIT);
            let cursor = null;
            for (let page = 0; page < 10; page++) {
                const queries = [
                    sdk.Query.equal('$id', chunk),
                    sdk.Query.isNull('archivedAt'),
                    sdk.Query.select(['$id', 'permissions']),
                    sdk.Query.limit(100)
                ];
                if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
                const list = await databases.listDocuments(databaseId, permissionSetsCollectionId, queries);
                for (const set of list.documents) {
                    const arr = Array.isArray(set.permissions) ? set.permissions : [];
                    for (const slug of arr) {
                        // Defense-in-depth: csak office-scope slugot fogadunk el
                        // (org.*-ot a CF write-path eleve elutasítja, de DevTools
                        // / direct DB write ellen ez véd).
                        if (OFFICE_SCOPE_PERMISSION_SLUG_SET.has(slug)) {
                            slugs.add(slug);
                        }
                    }
                }
                if (list.documents.length < 100) break;
                cursor = list.documents[list.documents.length - 1].$id;
            }
        }
    } catch (err) {
        return { userId, editorialOfficeId, organizationId, orgRole, permissionSlugs: slugs, hasGlobalAdminLabel: false };
    }

    return {
        userId,
        editorialOfficeId,
        organizationId,
        orgRole,
        permissionSlugs: slugs,
        hasGlobalAdminLabel: false
    };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Office-scope permission ellenőrzés. **Throw-ol** ha `slug` nem
 * office-scope (org-scope vagy ismeretlen) — a hívó kódban a slug
 * literál, ezért a fail-fast helyes.
 *
 * @param {Object} databases - sdk.Databases
 * @param {Object} env - környezeti collection ID-k
 * @param {Object} user - { id, labels? }
 * @param {string} permissionSlug - 33 office-scope slug egyike
 * @param {string} editorialOfficeId
 * @param {Map} [snapshotsByOffice] - per-request cache
 * @param {Map} [orgRoleByOrg] - per-request cache
 * @returns {Promise<boolean>}
 */
async function userHasPermission(databases, env, user, permissionSlug, editorialOfficeId, snapshotsByOffice, orgRoleByOrg) {
    assertOfficeScope(permissionSlug);

    if (!editorialOfficeId) return false;

    // Global admin label shortcut — a snapshot build is ezt csinálja, de
    // ha nincs cache, gyorsabb előbb itt eldönteni.
    if (Array.isArray(user?.labels) && user.labels.includes('admin')) return true;

    // Cache-kulcs userId-t is tartalmaz (Codex baseline review Critical):
    // multi-user CF flow-ban más user snapshot-jának öröklése auth leak-et
    // okozna. A `userId` hiányában (anonim) a kulcs kezdője "anon::".
    const userId = user?.id || user?.$id || 'anon';
    const cacheKey = `${userId}::${editorialOfficeId}`;

    let snapshot = snapshotsByOffice ? snapshotsByOffice.get(cacheKey) : null;
    if (!snapshot) {
        snapshot = await buildPermissionSnapshot(databases, env, user, editorialOfficeId, orgRoleByOrg);
        if (snapshotsByOffice) snapshotsByOffice.set(cacheKey, snapshot);
    }

    return snapshot.permissionSlugs.has(permissionSlug);
}

/**
 * Org-scope permission ellenőrzés. **Throw-ol** ha `slug` nem org-scope.
 * Csak `organizationMemberships.role`-t használ — permission set lookup
 * NEM fut (a `permissionSets.permissions[]` org.* slug-ot nem tárolhat).
 *
 * @param {Object} databases - sdk.Databases
 * @param {Object} env - { databaseId, membershipsCollectionId }
 * @param {Object} user - { id, labels? }
 * @param {string} orgPermissionSlug - 5 org-scope slug egyike
 * @param {string} organizationId
 * @param {Map} [orgRoleByOrg]
 * @returns {Promise<boolean>}
 */
async function userHasOrgPermission(databases, env, user, orgPermissionSlug, organizationId, orgRoleByOrg) {
    assertOrgScope(orgPermissionSlug);

    if (!organizationId) return false;
    if (Array.isArray(user?.labels) && user.labels.includes('admin')) return true;

    const userId = user?.id || user?.$id;
    if (!userId) return false;

    const role = await getOrgRole(databases, env, userId, organizationId, orgRoleByOrg);
    if (role === 'owner') return true; // mind az 5 slug
    if (role === 'admin' && !ADMIN_EXCLUDED_ORG_SLUGS.has(orgPermissionSlug)) return true; // 3 slug
    return false;
}

// ── Per-request scaffolder helper ───────────────────────────────────────────

/**
 * A CF entry-pointja az elején hívja, hogy egy konzisztens cache-szettel
 * dolgozzon a teljes request lifecycle-jén át. A visszaadott objektum
 * kompatibilis a `userHasPermission` / `userHasOrgPermission` paraméteres
 * meghívásával — egyszerűen átadjuk a függvényeknek.
 *
 * @returns {{ snapshotsByOffice: Map, orgRoleByOrg: Map }}
 */
function createPermissionContext() {
    return {
        snapshotsByOffice: new Map(),
        orgRoleByOrg: new Map()
    };
}

module.exports = {
    // Sync helpers + konstansok
    ORG_SCOPE_PERMISSION_SLUG_SET,
    OFFICE_SCOPE_PERMISSION_SLUG_SET,
    OFFICE_SCOPE_PERMISSION_SLUGS,
    ADMIN_EXCLUDED_ORG_SLUGS,
    DEFAULT_PERMISSION_SETS,
    isOrgScopeSlug,
    isOfficeScopeSlug,
    assertOfficeScope,
    assertOrgScope,
    validatePermissionSetSlugs,

    // Async helpers
    lookupOrgIdFromOffice,
    isStillOfficeMember,
    getOrgRole,
    buildPermissionSnapshot,
    userHasPermission,
    userHasOrgPermission,
    createPermissionContext
};
