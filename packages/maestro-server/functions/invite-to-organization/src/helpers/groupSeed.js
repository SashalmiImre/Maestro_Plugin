/**
 * Maestro Server — Csoport és permission set autoseed helperek
 * (Fázis 1 helper-extract, 2026-05-02).
 *
 * - `seedGroupsFromWorkflow` (A.2.2 / A.2.3) — workflow `requiredGroupSlugs[]`
 *   alapján üres `groups` doc-ok létrehozása az office-ban (idempotens,
 *   first-write wins).
 * - `findEmptyRequiredGroupSlugs` (A.2.2) — aktiváló-flow min. 1 tag check.
 * - `seedDefaultPermissionSets` (A.3.2) — 3 default permission set seed új
 *   org / új office létrehozásakor.
 */

const sdk = require('node-appwrite');
const permissions = require('../permissions.js');

/**
 * A.2.2 / A.2.3 — `requiredGroupSlugs[]` autoseed helper.
 *
 * A workflow `compiled.requiredGroupSlugs[]` halmazából minden olyan slugra,
 * amely még nem létezik az adott szerkesztőség `groups` collection-jében,
 * létrehoz egy üres (tag nélküli) `groups` doc-ot — `slug`, `name` (= label),
 * `description`, `color`, `isContributorGroup`, `isLeaderGroup` mezőkkel.
 *
 * Idempotens: a meglévő slug-okat NEM írja felül (first-write wins, ADR 0008
 * "slug-collision policy"). Ha a flag-ek eltérnek a meglévő doc-on és a
 * workflow-ban, a függvény `warnings[]`-ban jelzi, de nem dob hibát.
 *
 * Schema-safe fallback: ha a `bootstrap_groups_schema` még nem futott le, a
 * `description`/`color`/`isContributorGroup`/`isLeaderGroup` mezők hiányában
 * a create payload retry-olódik csak `slug` + `name`-mel (legacy struktúra).
 *
 * @param {sdk.Databases} databases
 * @param {Object} env — { databaseId, groupsCollectionId }
 * @param {Object} compiled — workflow compiled JSON
 * @param {string} editorialOfficeId
 * @param {string} organizationId
 * @param {string} callerId
 * @param {Function} log
 * @param {Function} buildAcl — ACL builder (`buildOfficeAclPerms`)
 * @returns {Promise<{ created: string[], existed: string[], warnings: Array }>}
 */
async function seedGroupsFromWorkflow(databases, env, compiled, editorialOfficeId, organizationId, callerId, log, buildAcl) {
    const { databaseId, groupsCollectionId } = env;
    const result = { created: [], existed: [], warnings: [] };

    const required = Array.isArray(compiled?.requiredGroupSlugs)
        ? compiled.requiredGroupSlugs
        : [];
    if (required.length === 0) return result;

    // 1) Meglévő slug-ok lekérése az office-ban — aktív és archivált
    //    külön Map-be, hogy az archivált doc ne legyen "csendben létező"
    //    (harden Codex MUST FIX): archivált slug → autoseed warning, mert
    //    az archivált doc UI-ból nem látható, runtime-ot eltöri.
    const existingByName = new Map();
    const archivedByName = new Map();
    let cursor = null;
    while (true) {
        const queries = [
            sdk.Query.equal('editorialOfficeId', editorialOfficeId),
            sdk.Query.select(['$id', 'slug', 'name', 'description', 'color', 'isContributorGroup', 'isLeaderGroup', 'archivedAt']),
            sdk.Query.limit(100)
        ];
        if (cursor) queries.push(sdk.Query.cursorAfter(cursor));
        let batch;
        try {
            batch = await databases.listDocuments(databaseId, groupsCollectionId, queries);
        } catch (err) {
            // Schema-fallback: ha a select() ismeretlen mezőre fut, retry
            // szelektáló nélkül (legacy schema, csak slug+name elérhető).
            if (err?.code === 400 && /unknown attribute/i.test(err?.message || '')) {
                const fallbackQueries = [
                    sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                    sdk.Query.limit(100)
                ];
                if (cursor) fallbackQueries.push(sdk.Query.cursorAfter(cursor));
                batch = await databases.listDocuments(databaseId, groupsCollectionId, fallbackQueries);
            } else {
                throw err;
            }
        }
        if (batch.documents.length === 0) break;
        for (const doc of batch.documents) {
            if (!doc.slug) continue;
            if (doc.archivedAt) {
                archivedByName.set(doc.slug, doc);
            } else {
                existingByName.set(doc.slug, doc);
            }
        }
        if (batch.documents.length < 100) break;
        cursor = batch.documents[batch.documents.length - 1].$id;
    }

    // 2) Hiányzó slug-okra create. A `document_already_exists` (race közben
    //    egy másik request hozta létre) → skip + existed listára.
    for (const entry of required) {
        if (!entry || typeof entry.slug !== 'string') continue;
        // Archivált slug-collision: a doc létezik a sémában, de UI-ból
        // eltűnt — az autoseed nem írja felül (first-write wins), de
        // warninggal jelezzük, hogy a user vagy `restore_group`-pal
        // visszaállítja, vagy `delete_group`-pal véglegesen kitakarítja.
        const archived = archivedByName.get(entry.slug);
        if (archived) {
            result.warnings.push({
                code: 'group_archived_blocking_autoseed',
                slug: entry.slug,
                groupId: archived.$id,
                note: 'A slug archivált csoporthoz tartozik — az autoseed nem írja felül. Restore_group vagy delete_group szükséges.'
            });
            continue;
        }
        const existing = existingByName.get(entry.slug);
        if (existing) {
            result.existed.push(entry.slug);
            // Slug-collision warning: ha a workflow flag-jei eltérnek a
            // meglévő doc-tól. A "first-write wins" politika nem írja felül,
            // de a hívó a response-ban látja a konfliktusos slug-okat.
            const collidingFields = [];
            if (entry.isContributorGroup !== undefined
                && existing.isContributorGroup !== undefined
                && entry.isContributorGroup !== existing.isContributorGroup) {
                collidingFields.push('isContributorGroup');
            }
            if (entry.isLeaderGroup !== undefined
                && existing.isLeaderGroup !== undefined
                && entry.isLeaderGroup !== existing.isLeaderGroup) {
                collidingFields.push('isLeaderGroup');
            }
            if (collidingFields.length > 0) {
                result.warnings.push({
                    code: 'group_slug_collision',
                    slug: entry.slug,
                    fields: collidingFields,
                    note: 'A meglévő groups doc kanonikus marad (first-write wins). Explicit update_group_metadata szükséges a workflow-igazításhoz.'
                });
            }
            continue;
        }

        const fullPayload = {
            slug: entry.slug,
            name: entry.label || entry.slug,
            editorialOfficeId,
            organizationId,
            createdByUserId: callerId
        };
        if (entry.description !== undefined) fullPayload.description = entry.description ?? null;
        if (entry.color !== undefined) fullPayload.color = entry.color ?? null;
        if (entry.isContributorGroup !== undefined) fullPayload.isContributorGroup = !!entry.isContributorGroup;
        if (entry.isLeaderGroup !== undefined) fullPayload.isLeaderGroup = !!entry.isLeaderGroup;

        try {
            await databases.createDocument(
                databaseId,
                groupsCollectionId,
                sdk.ID.unique(),
                fullPayload,
                buildAcl(editorialOfficeId)
            );
            result.created.push(entry.slug);
        } catch (err) {
            if (err?.type === 'document_already_exists' || /unique/i.test(err?.message || '')) {
                // Race: másik request közben létrehozta — idempotens skip.
                result.existed.push(entry.slug);
                continue;
            }
            // Schema-safe fallback: az új mezők nem léteznek (`bootstrap_groups_schema`
            // nem futott). Retry minimal payload-dal — `slug` + `name` + scope.
            const isSchemaMissing =
                (err?.type === 'document_invalid_structure' || err?.code === 400)
                && /unknown attribute|description|color|isContributorGroup|isLeaderGroup/i.test(err?.message || '');
            if (isSchemaMissing) {
                try {
                    await databases.createDocument(
                        databaseId,
                        groupsCollectionId,
                        sdk.ID.unique(),
                        {
                            slug: entry.slug,
                            name: entry.label || entry.slug,
                            editorialOfficeId,
                            organizationId,
                            createdByUserId: callerId
                        },
                        buildAcl(editorialOfficeId)
                    );
                    result.created.push(entry.slug);
                    result.warnings.push({
                        code: 'group_metadata_schema_missing',
                        slug: entry.slug,
                        note: 'description/color/isContributorGroup/isLeaderGroup mezők nem elérhetők (futtasd: bootstrap_groups_schema). Csoport name-mel létrehozva.'
                    });
                    continue;
                } catch (fallbackErr) {
                    log(`[SeedGroups] fallback create hiba (slug=${entry.slug}): ${fallbackErr.message}`);
                    throw fallbackErr;
                }
            }
            throw err;
        }
    }

    return result;
}

/**
 * A.2.2 — Empty `requiredGroupSlugs` ellenőrzés. Az autoseed után minden
 * slug-hoz legalább 1 `groupMembership` léte kötelező az aktiváláshoz.
 *
 * @param {sdk.Databases} databases
 * @param {Object} env — { databaseId, groupsCollectionId, groupMembershipsCollectionId }
 * @param {string[]} slugs — a `requiredGroupSlugs[].slug` halmaz
 * @param {string} editorialOfficeId
 * @returns {Promise<string[]>} — üres slug-ok listája
 */
async function findEmptyRequiredGroupSlugs(databases, env, slugs, editorialOfficeId) {
    const { databaseId, groupsCollectionId, groupMembershipsCollectionId } = env;
    if (!Array.isArray(slugs) || slugs.length === 0) return [];

    // Slug-onként független lookup (archivált-szűrt group + membership count).
    // Paralel `Promise.all` — N slug × 2 await szekvenciálisan kb. 2N RTT,
    // párhuzamosan ~2 RTT (user-facing latency az aktiváló-flow-nál).
    const checks = await Promise.all(slugs.map(async (slug) => {
        let groupId = null;
        try {
            const groupResult = await databases.listDocuments(
                databaseId,
                groupsCollectionId,
                [
                    sdk.Query.equal('editorialOfficeId', editorialOfficeId),
                    sdk.Query.equal('slug', slug),
                    sdk.Query.select(['$id', 'archivedAt']),
                    sdk.Query.limit(1)
                ]
            );
            const doc = groupResult.documents[0];
            if (doc && !doc.archivedAt) groupId = doc.$id;
        } catch {
            // Lookup hiba esetén üresnek tekintjük (fail-closed).
            return slug;
        }
        if (!groupId) return slug;

        try {
            const memResult = await databases.listDocuments(
                databaseId,
                groupMembershipsCollectionId,
                [
                    sdk.Query.equal('groupId', groupId),
                    sdk.Query.select(['$id']),
                    sdk.Query.limit(1)
                ]
            );
            return memResult.documents.length === 0 ? slug : null;
        } catch {
            return slug;
        }
    }));
    return checks.filter(s => s !== null);
}

/**
 * A.3.2 — A 3 default permission set (`owner_base`, `admin_base`, `member_base`)
 * seedelése egy új office-ba. A `bootstrap_organization` és
 * `create_editorial_office` action egyaránt meghívja a workflow seed ELŐTT.
 *
 * **Best-effort, idempotens** (Codex stop-time review):
 * - 409 / `document_already_exists` → skip. Az idempotencia a
 *   `office_slug_unique` indexen alapul (a `bootstrap_permission_sets_schema`
 *   hozza létre). **Index hiányában nincs slug-listing fallback** — a deploy
 *   sorrend szerint a schema bootstrap-nek MEG KELL történnie a default
 *   permission set seed előtt. Ha a fail-closed sorrend megsérül (tenant
 *   schema-bump nélkül indul), a `schema-missing` ágon megáll a seed (lentebb).
 * - schema-hiány (a `bootstrap_permission_sets_schema` még nem futott) →
 *   csendes skip (`errors[]`-be kerül `schema_missing` üzenettel). A bootstrap
 *   később a schema deploy után újra futtatható, vagy a user a Dashboard
 *   PermissionSetsTab-on manuálisan létrehozhatja.
 * - egyéb hiba → log + skip. NEM rollback-eli az org-bootstrapot — az
 *   org owner role-override miatt a 33 office-scope slug bejön a
 *   `userHasPermission()` 2. lépésében, így a permission set hiánya csak a
 *   member-szintű csoport-jogokat érinti (és azokat manuálisan pótolható).
 *
 * **Nincs csoport-mapping** (A.3.2): a permission set-ek létrejönnek, de
 * `groupPermissionSets` doc-ok NEM. A workflow-driven autoseed csak slug-szintű
 * csoport-créatiót tesz; a permission set hozzárendelés a Dashboard
 * `PermissionSetsTab` (A.4) és `EditorialOfficeGroupsTab` (A.4.5) hatáskör.
 *
 * @param {sdk.Databases} databases
 * @param {Object} env — { databaseId, permissionSetsCollectionId }
 * @param {string} organizationId
 * @param {string} editorialOfficeId
 * @param {string} callerId
 * @param {Function} buildAcl — `buildOfficeAclPerms` (`teamHelpers.js`-ből)
 * @param {Function} log
 * @param {Function} error
 * @returns {Promise<{ created: string[], skipped: string[], errors: Array<{slug: string, message: string}> }>}
 */
async function seedDefaultPermissionSets(
    databases, env, organizationId, editorialOfficeId, callerId, buildAcl, log, error
) {
    const { databaseId, permissionSetsCollectionId } = env;
    const result = { created: [], skipped: [], errors: [] };

    if (!permissionSetsCollectionId) {
        // env hiánya — a `PERMISSION_SETS_COLLECTION_ID` opcionális minden non-A.3
        // action-hez. Ezen az ágon a CF a permission set seed-et kihagyja.
        log(`[SeedPermSets] PERMISSION_SETS_COLLECTION_ID hiányzik, seed kihagyva`);
        result.errors.push({ slug: '*', message: 'env_missing:PERMISSION_SETS_COLLECTION_ID' });
        return result;
    }

    for (const def of permissions.DEFAULT_PERMISSION_SETS) {
        try {
            await databases.createDocument(
                databaseId,
                permissionSetsCollectionId,
                sdk.ID.unique(),
                {
                    name: def.name,
                    slug: def.slug,
                    description: def.description,
                    permissions: def.permissions,
                    editorialOfficeId,
                    organizationId,
                    createdByUserId: callerId
                    // archivedAt explicit null → nincs default-szöveg, az
                    // attribute schema-ja `required: false` engedélyezi.
                },
                buildAcl(editorialOfficeId)
            );
            result.created.push(def.slug);
        } catch (err) {
            const msg = err?.message || '';
            const isAlreadyExists = err?.code === 409
                || err?.type === 'document_already_exists'
                || /unique|already exists/i.test(msg);
            if (isAlreadyExists) {
                result.skipped.push(def.slug);
                continue;
            }
            const isSchemaMissing = (err?.type === 'document_invalid_structure' || err?.code === 400)
                && /unknown attribute|invalid structure|collection.*not found/i.test(msg);
            if (isSchemaMissing) {
                log(`[SeedPermSets] schema_missing — bootstrap_permission_sets_schema not yet run. office=${editorialOfficeId}, slug=${def.slug}`);
                result.errors.push({ slug: def.slug, message: 'schema_missing' });
                // Az első ilyen hibánál megállunk — a többi slug is ugyanazt
                // kapná, és a felhasználó számára egy hibaüzenet elég.
                break;
            }
            error(`[SeedPermSets] ${def.slug} create hiba: ${err.message}`);
            result.errors.push({ slug: def.slug, message: err.message });
        }
    }

    return result;
}

module.exports = {
    seedGroupsFromWorkflow,
    findEmptyRequiredGroupSlugs,
    seedDefaultPermissionSets
};
