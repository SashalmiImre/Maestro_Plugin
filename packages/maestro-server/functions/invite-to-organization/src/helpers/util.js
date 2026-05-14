// B.0.3.0 (2026-05-03) — Központi util-ok kiszervezése a `main.js`-ből.
// A B.0.3 inkrementális action-bontás előfeltétele (Codex flag): az új
// `actions/*.js` modulok ezeket a helpereket innen require-olják, NEM a
// `main.js`-ből. Ezzel elkerüljük a CommonJS ciklikus require-t (fél-
// inicializált export). A `main.js` változatlanul require-olja vissza
// őket — az API kompatibilis.
//
// Tilos import-irány: `actions/*` → `helpers/*` → `permissions.js` /
// `teamHelpers.js`. Visszafelé NEM (CommonJS ciklikus require csendben
// fél-inicializált exports-ot ad).
//
// A komment-anyag és a logika 1:1-ben átkerült a `main.js`-ből, csak a
// helyét cseréltük. Tartalmi változtatás NINCS — mechanikus refactor.

const crypto = require('crypto');

/**
 * Alapértelmezett workflow compiled JSON — új office bootstrap-nél seed-elődik.
 * Inline másolat a maestro-shared/defaultWorkflow.json-ből.
 */
const DEFAULT_WORKFLOW = require('../defaultWorkflow.json');

// ADR 0010 W2 — meghívó lejárat választható (1 / 3 / 7 nap, default 7).
// A `INVITE_VALIDITY_DAYS` backward-compat re-export az alapértelmezett értékre,
// hogy a meglévő hivatkozások (pl. createInvite default) ne törjenek.
const INVITE_VALIDITY_DAYS_OPTIONS = [1, 3, 7];
const INVITE_VALIDITY_DAYS_DEFAULT = 7;
const INVITE_VALIDITY_DAYS = INVITE_VALIDITY_DAYS_DEFAULT;
const TOKEN_BYTES = 32;

// Egyszerű e-mail formátum-ellenőrzés (a részletes validáció B.10-ben kézzel)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Érvényes action-ök halmaza
const VALID_ACTIONS = new Set([
    'bootstrap_organization', 'create_organization', 'create', 'accept',
    'list_my_invites', 'decline_invite', 'leave_organization',
    'add_group_member', 'remove_group_member',
    // A.2.6 — `rename_group` aliasa az új `update_group_metadata` action-nek
    // (slug immutable, label/description/color/isContributor/isLeader szerk.).
    'create_group', 'rename_group', 'update_group_metadata',
    'archive_group', 'restore_group', 'delete_group',
    'bootstrap_workflow_schema',
    'bootstrap_publication_schema',
    'bootstrap_permission_sets_schema',
    'bootstrap_groups_schema',
    // B.1.1 (ADR 0007 Phase 0) — workflowExtensions collection schema-create.
    'bootstrap_workflow_extension_schema',
    'create_workflow', 'update_workflow',
    'update_workflow_metadata',
    'delete_workflow', 'duplicate_workflow',
    'archive_workflow', 'restore_workflow',
    // A.2.2/A.2.3 — workflow-driven autoseed + aktiválás
    'activate_publication', 'assign_workflow_to_publication',
    'create_publication_with_workflow',
    'update_organization',
    // 2026-05-07: org-tag role változtatása (owner → admin → member). Az
    // `org.member.role.change` org-scope slug + extra owner-touch guard.
    'change_organization_member_role',
    // 2026-05-10 ([[Döntések/0012-org-member-removal-cascade]]) — admin-kick.
    // `org.member.remove` org-scope slug, owner-touch + last-owner guarddal.
    'remove_organization_member',
    // 2026-05-10 ([[Döntések/0013-self-service-account-management]]) — self-service
    // fiók-törlés. Cross-org sequential cleanup + users.delete (Codex B1+B2 fix).
    'delete_my_account',
    'create_editorial_office', 'update_editorial_office',
    'delete_organization', 'delete_editorial_office',
    'backfill_tenant_acl',
    // 2026-05-07 — `userName`/`userEmail` denormalizációs backfill az
    // `organizationMemberships` + `editorialOfficeMemberships`-en. Owner-anywhere.
    'backfill_membership_user_names',
    // A.3.3 — permission set CRUD (ADR 0008)
    'create_permission_set', 'update_permission_set',
    'archive_permission_set', 'restore_permission_set',
    // A.3.4 — m:n junction CRUD
    'assign_permission_set_to_group', 'unassign_permission_set_from_group',
    // B.3.1 (ADR 0007 Phase 0) — workflow extension CRUD.
    // `restore_workflow_extension` SZÁNDÉKOSAN nincs (Codex tervi review
    // 2026-05-04 nyíltan rögzít: a Feladatok.md / ADR 0007 csak az archive-ot
    // említi; a Phase 1+ fogja eldönteni, hogy szükséges-e külön restore
    // action vagy az `update_workflow_extension` `archivedAt: null`-lal
    // implicit visszaállít).
    'create_workflow_extension', 'update_workflow_extension',
    'archive_workflow_extension',
    // ADR 0010 W2/W3 — meghívási flow redesign
    'create_batch_invites',           // multi-invite (max 20)
    'send_invite_email',              // egyetlen invite e-mail újraküldés (admin gomb)
    'bootstrap_invites_schema_v2',    // 4 új mező (lastDeliveryStatus, ...)
    'bootstrap_rate_limit_schema',    // 2 új collection (counters + blocks)
    // D blokk (2026-05-09) — meghívási flow stabilizálás follow-up
    'bootstrap_organization_status_schema',     // D.2.1 — organizations.status enum
    'backfill_organization_status',             // D.2.5 — legacy orgok status='active'
    'transfer_orphaned_org_ownership',          // D.2.5b — recovery action (global admin)
    'bootstrap_organization_invite_history_schema', // D.3.1 — audit-trail collection schema
    // E (2026-05-09 follow-up) — Q1 ACL refactor: admin-team scoped backfill.
    // (Korábbi drift-fix 2026-05-10: a router-ben már szerepelt, a VALID_ACTIONS-ból hiányzott.)
    'backfill_admin_team_acl',
    // S.7.2 (2026-05-12) — R.S.7.2 close: legacy üres-permission doc backfill
    // a S.7.1 fix-csomag 5 collection-én (organizations, organizationMemberships,
    // editorialOffices, editorialOfficeMemberships, publications). Scope-paraméteres,
    // user-read preserve, target-org-owner auth. Codex pre-review fix-ekkel.
    'backfill_acl_phase2'
]);

// Slug formátum: kisbetű, szám, kötőjel. A frontend is ugyanezt alkalmazza.
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 128;

/**
 * JSON válasz hibakóddal — egyszerű wrapper a `res.json` köré.
 */
function fail(res, statusCode, reason, extra = {}) {
    return res.json({ success: false, reason, ...extra }, statusCode);
}

/**
 * Hungarian ékezetes karakterek ASCII-ra fordítása a slug-képzéshez.
 */
const HUN_ACCENT_MAP = {
    'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ö': 'o', 'ő': 'o',
    'ú': 'u', 'ü': 'u', 'ű': 'u'
};

/**
 * Egyszerű slugify: kisbetű, magyar transliteráció, nem-alfanumerikus → '-',
 * több kötőjel egyesítve, végek levágva, SLUG_MAX_LENGTH-ra vágva.
 * Ha a kimenet üres vagy nem felel meg SLUG_REGEX-nek, random fallback-et ad.
 */
function slugifyName(name) {
    const lower = String(name).toLowerCase();
    const trans = lower.replace(/[áéíóöőúüű]/g, ch => HUN_ACCENT_MAP[ch] || ch);
    const base = trans.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const truncated = base.slice(0, SLUG_MAX_LENGTH);
    if (!truncated || !SLUG_REGEX.test(truncated)) {
        return `office-${crypto.randomBytes(3).toString('hex')}`;
    }
    return truncated;
}

/**
 * Trimelt, hosszra szűrt string vagy null, ha üres.
 */
function sanitizeString(value, maxLength) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > maxLength) return null;
    return trimmed;
}

/**
 * Idempotens "already exists" hibafelismerés Appwrite SDK call-okhoz.
 * 409 status code VAGY a hibaüzenet `already exists` szöveget tartalmaz.
 *
 * Korábban 5 schema-bootstrap action duplikálta inline lambdaként —
 * single-source extract a B.1 simplify pass-ben (2026-05-04).
 */
function isAlreadyExists(err) {
    return err?.code === 409 || /already exists/i.test(err?.message || '');
}

/**
 * Globális owner-only auth check a `bootstrap_*_schema` és más privileged
 * site-szintű action-ökhöz: a caller LEGALÁBB EGY orgban owner kell legyen
 * (nem scope-szűkített orgId-re — ezért "anywhere"). Ha nem: 403
 * `insufficient_role` response.
 *
 * Korábban 5 schema-bootstrap action duplikálta inline-ban (12 soros block) —
 * single-source extract a B.1 simplify pass-ben (2026-05-04).
 *
 * @param {Object} ctx - a CF entry-point által épített handler-context.
 * @returns {Promise<Object|null>} `null` ha a caller jogosult; egyébként a
 *   `fail(res, 403, ...)` által visszaadott response objektumot, amit a hívónak
 *   `return`-elnie kell. Idiomatikus hívás:
 *
 *     const denied = await requireOwnerAnywhere(ctx);
 *     if (denied) return denied;
 */
async function requireOwnerAnywhere(ctx) {
    const { databases, env, callerId, sdk, res, fail: failFn } = ctx;
    const ownerships = await databases.listDocuments(
        env.databaseId,
        env.membershipsCollectionId,
        [
            sdk.Query.equal('userId', callerId),
            sdk.Query.equal('role', 'owner'),
            sdk.Query.limit(1)
        ]
    );
    if (ownerships.documents.length === 0) {
        return failFn(res, 403, 'insufficient_role', { requiredRole: 'owner' });
    }
    return null;
}

/**
 * Org-scope-szűkített owner-only auth check a 3 backfill action-höz
 * (`backfill_tenant_acl`, `backfill_admin_team_acl`, `backfill_acl_phase2`) és
 * minden jövőbeli target-org-scope-os action-höz. Az "owner-anywhere"-rel
 * szemben itt a `(organizationId, userId)` páros membership-jét nézzük, és
 * elvárjuk, hogy `role === 'owner'`.
 *
 * **Indok**: a target-org-owner-szűkítés tisztább per-org-backfill action-ön —
 * az owner csak a saját org-jain végezhet ACL-rewrite-ot, NEM más org-okon
 * (a `requireOwnerAnywhere` minta a globális schema-bootstrap action-öknek
 * megfelelő).
 *
 * **Hibakezelés** (3 ág):
 *  - 5xx `membership_lookup_failed` — lookup-bukás (network/SDK error)
 *  - 403 `not_a_member` — nincs membership a target orgban
 *  - 403 `insufficient_role` — van membership, de `role !== 'owner'`
 *
 * **Visszatérés** (idiomatikus minta a `requireOwnerAnywhere` mintáján):
 *  - `null` — caller jogosult, folytasd
 *  - `failFn(res, ...)` response — adj `return denied;`-vel vissza
 *
 * @param {Object} ctx — handler-context (`databases`, `env`, `callerId`, `sdk`,
 *   `res`, `fail`, `error`).
 * @param {string} organizationId — target org $id
 * @returns {Promise<Object|null>}
 */
async function requireOrgOwner(ctx, organizationId) {
    const { databases, env, callerId, sdk, res, fail: failFn, error } = ctx;
    let membership;
    try {
        membership = await databases.listDocuments(
            env.databaseId, env.membershipsCollectionId,
            [
                sdk.Query.equal('organizationId', organizationId),
                sdk.Query.equal('userId', callerId),
                sdk.Query.select(['role']),
                sdk.Query.limit(1)
            ]
        );
    } catch (err) {
        if (typeof error === 'function') {
            error(`[requireOrgOwner] membership lookup hiba (org=${organizationId}): ${err.message}`);
        }
        return failFn(res, 500, 'membership_lookup_failed');
    }
    if (membership.documents.length === 0) {
        return failFn(res, 403, 'not_a_member');
    }
    if (membership.documents[0].role !== 'owner') {
        return failFn(res, 403, 'insufficient_role', {
            yourRole: membership.documents[0].role,
            required: 'owner'
        });
    }
    return null;
}

/**
 * 2026-05-07 — User identity denormalizáció helper.
 *
 * Visszaad egy `{ userName, userEmail }` objektumot az Appwrite Account
 * lookup-jából, amit a `organizationMemberships` és `editorialOfficeMemberships`
 * collection-ök denormalizált mezőibe írhatunk a create-flow-knál. Ezzel a UI
 * (Dashboard `userIdentity.js` + `EditorialOfficeGroupsTab` / `OrganizationSettingsModal`
 * / `UsersTab`) a tag nevét akkor is meg tudja jeleníteni, ha az adott felhasználó
 * még egyetlen `groupMemberships` rekorddal sem rendelkezik.
 *
 * **Drift-stratégia**: snapshot-at-join (a `groupMemberships`-éhez igazodva).
 * A user későbbi név/email változása a meglévő membership rekordon NEM jelenik meg
 * automatikusan; a `backfill_membership_user_names` action manuálisan szinkronba
 * hoz mindent. Ez egyszerűbb, mint event-handler-szinkron, és a `groupMemberships`
 * collection mintáját követi.
 *
 * **Failure mode**: ha a `usersApi.get(userId)` bukik (hálózati / törölt user / 404),
 * `{ userName: null, userEmail: null }`-t ad vissza — NEM dob errort. A hívó
 * flow nem buknia szabad egy denormalizált mezőhiány miatt, mert az csak UI-cache.
 *
 * **Per-request cache**: ha a `cache` Map megadva, idempotens (egy request egy
 * userId-re egyszer kérdezi az Appwrite-ot). A bootstrapnál a self-membership
 * + office-membership ugyanazt a callerId-t hívja kétszer — cache nélkül 2 lookup,
 * cache-szel 1.
 *
 * @param {Object} usersApi - `sdk.Users(client)` példány
 * @param {string} userId - target user $id
 * @param {Map<string, {userName: string|null, userEmail: string|null}>} [cache]
 * @param {Function} [log] - optional log callback (fail-csendes)
 * @returns {Promise<{userName: string|null, userEmail: string|null}>}
 */
async function fetchUserIdentity(usersApi, userId, cache, log) {
    if (!userId) return { userName: null, userEmail: null };
    if (cache && cache.has(userId)) return cache.get(userId);

    let identity = { userName: null, userEmail: null };
    try {
        const userDoc = await usersApi.get(userId);
        identity = {
            userName: userDoc?.name || null,
            userEmail: userDoc?.email || null
        };
    } catch (err) {
        // 404 / hálózati hiba / törölt user → null marad. NEM propagáljuk:
        // a denormalizált mező hiánya nem buktathatja a tényleges flow-t.
        if (typeof log === 'function') {
            log(`[fetchUserIdentity] user=${userId} lookup hiba (null marad): ${err?.message || err}`);
        }
    }

    if (cache) cache.set(userId, identity);
    return identity;
}

/**
 * Org-on belüli office ID-k paginált lekérdezése team-cleanup workflow-khoz.
 * A `leaveOrganization`, `removeOrganizationMember` és `deleteMyAccount` mind
 * ugyanezt a select(['$id']) cursor-paginált scan-t használja az org alá tartozó
 * office team ID-k összegyűjtéséhez. Single-source helper.
 *
 * @param {Object} databases — Appwrite Databases SDK instance
 * @param {Object} env — env objektum `databaseId`, `officesCollectionId` mezőkkel
 * @param {Object} sdk — node-appwrite SDK module (Query-konstruktorok miatt)
 * @param {string} organizationId
 * @param {number} [batchLimit=100] — `helpers/constants.CASCADE_BATCH_LIMIT` default
 * @returns {Promise<string[]>} — office $id-k tömbje
 */
async function listOfficeIdsForOrg(databases, env, sdk, organizationId, batchLimit = 100) {
    const officeIds = [];
    let cursor;
    while (true) {
        const queries = [
            sdk.Query.equal('organizationId', organizationId),
            sdk.Query.select(['$id']),
            sdk.Query.limit(batchLimit)
        ];
        if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
        const resp = await databases.listDocuments(env.databaseId, env.officesCollectionId, queries);
        if (resp.documents.length === 0) break;
        for (const o of resp.documents) officeIds.push(o.$id);
        if (resp.documents.length < batchLimit) break;
        cursor = resp.documents[resp.documents.length - 1].$id;
    }
    return officeIds;
}

module.exports = {
    DEFAULT_WORKFLOW,
    INVITE_VALIDITY_DAYS,
    INVITE_VALIDITY_DAYS_OPTIONS,
    INVITE_VALIDITY_DAYS_DEFAULT,
    TOKEN_BYTES,
    EMAIL_REGEX,
    VALID_ACTIONS,
    requireOrgOwner,
    SLUG_REGEX,
    SLUG_MAX_LENGTH,
    NAME_MAX_LENGTH,
    fetchUserIdentity,
    HUN_ACCENT_MAP,
    fail,
    slugifyName,
    sanitizeString,
    isAlreadyExists,
    requireOwnerAnywhere,
    listOfficeIdsForOrg
};
