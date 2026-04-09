/**
 * Maestro Shared — Dinamikus csoportok
 *
 * Alapértelmezett csoport-definíciók és helper függvények a `groups` +
 * `groupMemberships` collection-ök feletti műveletekhez.
 *
 * Fázis 2 / B.2 — A 7 fix Appwrite Team helyett dinamikus, szerkesztőség-
 * szintű csoportok.
 */

/**
 * Alapértelmezett csoportok — bootstrap_organization hozza létre mindegyiket
 * az új szerkesztőséghez. A slug-ok megegyeznek a régi Appwrite Team slug-okkal,
 * így a permission config-ok (STATE_PERMISSIONS, TEAM_ARTICLE_FIELD) változatlanul
 * működnek.
 */
export const DEFAULT_GROUPS = [
    { slug: 'editors',          name: 'Szerkesztők' },
    { slug: 'designers',        name: 'Tervezők' },
    { slug: 'writers',          name: 'Szerzők' },
    { slug: 'image_editors',    name: 'Képszerkesztők' },
    { slug: 'art_directors',    name: 'Művészeti vezetők' },
    { slug: 'managing_editors', name: 'Vezetőszerkesztők' },
    { slug: 'proofwriters',     name: 'Korrektorok' }
];

/**
 * GroupMembership dokumentumokból és Group dokumentumokból feloldja a felhasználó
 * csoportjainak slug-jait.
 *
 * @param {Array<{groupId: string}>} groupMembershipDocs - A user groupMemberships rekordjai
 * @param {Array<{$id: string, slug: string}>} groupDocs - Az érintett group dokumentumok
 * @returns {string[]} Deduplikált slug tömb (pl. ['designers', 'art_directors'])
 */
export function resolveGroupSlugs(groupMembershipDocs, groupDocs) {
    const groupIdToSlug = new Map(groupDocs.map(g => [g.$id, g.slug]));
    const slugs = new Set();
    for (const m of groupMembershipDocs) {
        const slug = groupIdToSlug.get(m.groupId);
        if (slug) slugs.add(slug);
    }
    return [...slugs];
}
