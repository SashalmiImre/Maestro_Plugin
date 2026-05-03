/**
 * Maestro Dashboard — useContributorGroups hook (A.4.9 / ADR 0008)
 *
 * Az aktív szerkesztőség összes csoportját és csoporttagjait lekéri.
 * A `ContributorsTab` (Publication Settings → Közreműködők) használja
 * a `defaultContributors` dropdown-ok építéséhez.
 *
 * **A.4.9 változások (Codex roast)**:
 *   - `DEFAULT_GROUPS` import megszűnt — a workflow-driven autoseed után a
 *     7 hardcoded csoport feltevése már nem érvényes.
 *   - **Sorrend**: opcionális `orderingSlugs` paraméter (a publikáció
 *     `compiledWorkflowSnapshot.requiredGroupSlugs[].slug` listája) szerint;
 *     fallback `groups.$createdAt` ascending — kanonikus first-write-wins.
 *   - **Cache invalidáció**: Realtime listener a `groups` és `groupMemberships`
 *     collection-en — más tabban / másik user által történő változás
 *     azonnal tükröződik. Stale 5-perces cache eltűnt.
 *   - **Metadata**: a `name` mellé `description`, `color`, `isContributorGroup`,
 *     `isLeaderGroup`, `archivedAt` is letöltődik (a hívó ezeket szűrésre /
 *     színezésre / "archivált" jelzésre használhatja).
 *   - **Archived groups megmaradnak** a return-ben — a hívó UI dönti el, hogy
 *     mutatja-e (pl. egy meglévő `defaultContributors[archivedSlug]`
 *     hozzárendelés "archivált" badge-dzsel kell látsszon, hogy a felhasználó
 *     el tudja távolítani).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Query } from 'appwrite';
import { useData } from '../contexts/DataContext.jsx';
import { useScope } from '../contexts/ScopeContext.jsx';
import { subscribeRealtime, collectionChannel } from '../contexts/realtimeBus.js';
import { DATABASE_ID, COLLECTIONS } from '../config.js';

// ─── Cache ──────────────────────────────────────────────────────────────────
//
// Memória-cache az ismételt modal-nyitásokra (modal close → re-open ne hozzon
// újabb DB roundtrip-et). Realtime listener invalidálja, amint az adatforrás
// változik — így a cache mindig friss, de a re-render ablakon belül stabil.
//
// A cache scope-onként él (`activeEditorialOfficeId` az index). Scope-váltáskor
// automatikusan érvénytelenné válik (másik office-id → cache miss).

let CACHE = null;
let CACHE_OFFICE_ID = null;

export function invalidateContributorGroupsCache() {
    CACHE = null;
    CACHE_OFFICE_ID = null;
}

// ─── Sorrend helper ─────────────────────────────────────────────────────────

/**
 * Rendezés:
 *   1. ha van `orderingSlugs` (a publikáció / workflow `requiredGroupSlugs[]`-ből),
 *      az index-rendezést alkalmazzuk — a slug-ok ott következnek, ahol a
 *      workflow definiálta őket, az ismeretlen slug-ok a végére kerülnek.
 *   2. fallback: `groups.$createdAt` ascending (kanonikus first-write-wins,
 *      ADR 0008 A.3 slug-collision policy). Tie-break a slug-on a
 *      determinizmusért.
 */
function sortGroups(groups, orderingSlugs) {
    if (Array.isArray(orderingSlugs) && orderingSlugs.length > 0) {
        const orderIdx = new Map(orderingSlugs.map((s, i) => [s, i]));
        return [...groups].sort((a, b) => {
            const ia = orderIdx.has(a.slug) ? orderIdx.get(a.slug) : Number.MAX_SAFE_INTEGER;
            const ib = orderIdx.has(b.slug) ? orderIdx.get(b.slug) : Number.MAX_SAFE_INTEGER;
            if (ia !== ib) return ia - ib;
            // ismeretlen slug-ok közt: createdAt asc fallback
            const ta = a.$createdAt || '';
            const tb = b.$createdAt || '';
            if (ta !== tb) return ta < tb ? -1 : 1;
            return (a.slug || '').localeCompare(b.slug || '');
        });
    }
    return [...groups].sort((a, b) => {
        const ta = a.$createdAt || '';
        const tb = b.$createdAt || '';
        if (ta !== tb) return ta < tb ? -1 : 1;
        return (a.slug || '').localeCompare(b.slug || '');
    });
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * @param {Object} [options]
 * @param {string[]} [options.orderingSlugs] - Opcionális slug-array a publikáció
 *   `compiledWorkflowSnapshot.requiredGroupSlugs[].slug` listájából. Ha jelen
 *   van, a hook a slug-ok eredeti workflow-sorrendjét tükrözi. Egyébként
 *   `$createdAt` ascending fallback.
 * @returns {{
 *   groups: Array<{slug: string, name: string, description?: string, color?: string, isContributorGroup?: boolean, isLeaderGroup?: boolean, archivedAt?: string|null}>,
 *   membersBySlug: Object.<string, Array<{userId: string, userName: string, userEmail: string}>>,
 *   loading: boolean
 * }}
 */
export function useContributorGroups(options = {}) {
    const { orderingSlugs } = options;
    const { activeEditorialOfficeId } = useScope();
    const { databases } = useData();
    const [groups, setGroups] = useState([]);
    const [membersBySlug, setMembersBySlug] = useState({});
    const [loading, setLoading] = useState(true);
    const mountedRef = useRef(true);
    const generationRef = useRef(0);

    // Az `orderingSlugs` array referenciaként változhat re-render-enként.
    // Stabilizálás: a join-jét string kulcsként használjuk a memo-ban.
    const orderingKey = Array.isArray(orderingSlugs) ? orderingSlugs.join('|') : '';

    const fetchData = useCallback(async () => {
        const generation = ++generationRef.current;

        if (!activeEditorialOfficeId) {
            setGroups([]);
            setMembersBySlug({});
            setLoading(false);
            return;
        }

        // Cache hit (csak ha még az aktív office-ra szól ÉS ugyanaz az ordering)
        if (CACHE && CACHE_OFFICE_ID === activeEditorialOfficeId && CACHE.orderingKey === orderingKey) {
            setGroups(CACHE.groups);
            setMembersBySlug(CACHE.membersBySlug);
            setLoading(false);
            return;
        }

        setLoading(true);

        try {
            const [groupsResult, membershipsResult] = await Promise.all([
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUPS,
                    queries: [
                        Query.equal('editorialOfficeId', activeEditorialOfficeId),
                        Query.limit(100)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
                    queries: [
                        Query.equal('editorialOfficeId', activeEditorialOfficeId),
                        Query.limit(500)
                    ]
                })
            ]);

            // Stale response / unmount védelem
            if (!mountedRef.current || generation !== generationRef.current) return;

            const groupDocs = groupsResult.documents || [];
            const membershipDocs = membershipsResult.documents || [];

            // A.4.9 — Az archivált csoportokat is visszaadjuk (a hívó UI dönt).
            // Ha egy meglévő `defaultContributors[archivedSlug]` hozzárendelést
            // szűrnénk a hookból, a UI nem mutatná a régi hozzárendelést és
            // a felhasználó nem tudná eltávolítani — Codex review.
            const groupIdToSlug = new Map();
            const sortedGroups = sortGroups(groupDocs, orderingSlugs).map((g) => {
                groupIdToSlug.set(g.$id, g.slug);
                return {
                    slug: g.slug,
                    name: g.name,
                    description: g.description || '',
                    color: g.color || '',
                    isContributorGroup: g.isContributorGroup === true,
                    isLeaderGroup: g.isLeaderGroup === true,
                    archivedAt: g.archivedAt || null
                };
            });

            const bySlug = {};
            for (const g of sortedGroups) {
                bySlug[g.slug] = [];
            }
            for (const m of membershipDocs) {
                const slug = groupIdToSlug.get(m.groupId);
                if (slug && bySlug[slug]) {
                    bySlug[slug].push({
                        userId: m.userId,
                        userName: m.userName || '',
                        userEmail: m.userEmail || ''
                    });
                }
            }

            // Cache frissítés (orderingKey-vel együtt — ha a hívó más
            // workflow snapshot-tal kéri, cache miss).
            CACHE = { groups: sortedGroups, membersBySlug: bySlug, orderingKey };
            CACHE_OFFICE_ID = activeEditorialOfficeId;

            setGroups(sortedGroups);
            setMembersBySlug(bySlug);
        } catch (err) {
            console.error('[useContributorGroups] Hiba a csoportok/tagok lekérésekor:', err);
            if (!mountedRef.current || generation !== generationRef.current) return;
            setGroups([]);
            setMembersBySlug({});
        }

        if (mountedRef.current) setLoading(false);
    }, [activeEditorialOfficeId, databases, orderingSlugs, orderingKey]);

    useEffect(() => {
        mountedRef.current = true;
        fetchData();
        return () => { mountedRef.current = false; };
    }, [fetchData]);

    // A.4.9 — Realtime cache invalidáció. A `groups` és `groupMemberships`
    // collection scope-on belüli változására kiürítjük a cache-t és reload-ot
    // futtatunk. A `realtimeBus` 50ms debounce-ot ad ingyenesen, így a burst-ök
    // (autoseed több slug egyszerre) egyetlen reload-ban összefutnak.
    useEffect(() => {
        if (!activeEditorialOfficeId) return undefined;
        const handler = (response) => {
            const payload = response?.payload;
            // Scope-szűrés a payload-on: más office event-jét ignoráljuk.
            if (!payload || payload.editorialOfficeId !== activeEditorialOfficeId) return;
            invalidateContributorGroupsCache();
            fetchData();
        };
        const unsubscribe = subscribeRealtime([
            collectionChannel(COLLECTIONS.GROUPS),
            collectionChannel(COLLECTIONS.GROUP_MEMBERSHIPS)
        ], handler);
        return unsubscribe;
    }, [activeEditorialOfficeId, fetchData]);

    return { groups, membersBySlug, loading };
}
