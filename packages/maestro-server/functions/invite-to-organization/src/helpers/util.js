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

const INVITE_VALIDITY_DAYS = 7;
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
    'create_workflow', 'update_workflow',
    'update_workflow_metadata',
    'delete_workflow', 'duplicate_workflow',
    'archive_workflow', 'restore_workflow',
    // A.2.2/A.2.3 — workflow-driven autoseed + aktiválás
    'activate_publication', 'assign_workflow_to_publication',
    'create_publication_with_workflow',
    'update_organization',
    'create_editorial_office', 'update_editorial_office',
    'delete_organization', 'delete_editorial_office',
    'backfill_tenant_acl',
    // A.3.3 — permission set CRUD (ADR 0008)
    'create_permission_set', 'update_permission_set',
    'archive_permission_set', 'restore_permission_set',
    // A.3.4 — m:n junction CRUD
    'assign_permission_set_to_group', 'unassign_permission_set_from_group'
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

module.exports = {
    DEFAULT_WORKFLOW,
    INVITE_VALIDITY_DAYS,
    TOKEN_BYTES,
    EMAIL_REGEX,
    VALID_ACTIONS,
    SLUG_REGEX,
    SLUG_MAX_LENGTH,
    NAME_MAX_LENGTH,
    HUN_ACCENT_MAP,
    fail,
    slugifyName,
    sanitizeString
};
