/**
 * Maestro Dashboard — User identity name-resolver helper.
 *
 * 2026-05-07: A `organizationMemberships` és `editorialOfficeMemberships`
 * collection-ök mostantól denormalizálják a `userName` és `userEmail` mezőket
 * (snapshot-at-join), ahogy a `groupMemberships` is teszi. A frontend a primary
 * forrásként ezeket használja — ha egy adott rekordon mégis hiányoznak (pl.
 * legacy doc, amire a `backfill_membership_user_names` még nem futott), a
 * `useAuth().user` self-fallback átveszi a saját bejelentkezett user-t.
 *
 * **Source priority** (a hívó adja át a sources-listáját):
 *   1. első nem-null `userName`/`userEmail` egy adott `userId`-ra a sources között
 *   2. self-fallback a `useAuth().user`-ből, ha a saját userId nincs cache-ben
 *
 * Példa használat:
 * ```js
 * const userNameMap = useMemo(
 *     () => buildUserIdentityMap([members, officeMembers, groupMemberships], user),
 *     [members, officeMembers, groupMemberships,
 *      user?.$id, user?.name, user?.email]
 * );
 * ```
 *
 * @typedef {Object} UserIdentity
 * @property {string|null} name
 * @property {string|null} email
 *
 * @param {Array<Array<Object>>|Array<Object>} sources - egy vagy több
 *   membership-doc tömb (pl. `[members, officeMembers, groupMemberships]`).
 *   Backward-kompat: egyetlen tömb (`groupMemberships`) is elfogadott.
 *   Mindegyik elem egy doc, amin van `userId` + opcionálisan `userName`/`userEmail`.
 * @param {Object|null} [currentUser] - `useAuth().user` (Appwrite Account doc).
 * @returns {Map<string, UserIdentity>}
 */
export function buildUserIdentityMap(sources, currentUser) {
    const map = new Map();

    // Backward-kompat: ha egyetlen tömböt kapunk, csomagoljuk be.
    const sourceList = Array.isArray(sources) && sources.length > 0 && Array.isArray(sources[0])
        ? sources
        : [Array.isArray(sources) ? sources : []];

    for (const source of sourceList) {
        if (!Array.isArray(source)) continue;
        for (const doc of source) {
            if (!doc?.userId) continue;
            const existing = map.get(doc.userId);
            const docName = doc.userName || null;
            const docEmail = doc.userEmail || null;
            // Idempotens merge: csak akkor írunk át egy mezőt, ha a meglévő null
            // és az új nem. Ezzel az első nem-null forrás "nyer" — gyakorlatilag
            // a hívó által átadott listában lévő sorrend prioritást ad.
            if (!existing) {
                if (docName || docEmail) {
                    map.set(doc.userId, { name: docName, email: docEmail });
                }
                continue;
            }
            const merged = {
                name: existing.name || docName,
                email: existing.email || docEmail
            };
            if (merged.name !== existing.name || merged.email !== existing.email) {
                map.set(doc.userId, merged);
            }
        }
    }

    // Self-fallback: ha a saját user-ünk nincs még a cache-ben (pl. egy backfill
    // előtti legacy rekord még csak `userId`-vel), pótoljuk a `useAuth().user`-ből.
    if (currentUser?.$id && !map.has(currentUser.$id)) {
        map.set(currentUser.$id, {
            name: currentUser.name || null,
            email: currentUser.email || null
        });
    }

    return map;
}
