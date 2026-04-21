/**
 * Maestro Dashboard — useContributorGroups hook
 *
 * Az aktív szerkesztőség összes csoportját és csoporttagjait lekéri.
 * A PublicationSettingsModal ContributorsTab komponense használja a
 * `defaultContributors` dropdown-ok építéséhez.
 *
 * Két Appwrite query:
 *   1. groups (editorialOfficeId) → [{$id, slug, name}]
 *   2. groupMemberships (editorialOfficeId) → [{groupId, userId, userName, userEmail}]
 *
 * 5 perces memória-cache az ismételt modal-nyitásokra. A cache az aktív
 * office-hoz kötődik, scope-váltáskor automatikusan érvénytelenné válik.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Query } from 'appwrite';
import { useData } from '../contexts/DataContext.jsx';
import { useScope } from '../contexts/ScopeContext.jsx';
import { DATABASE_ID, COLLECTIONS } from '../config.js';
import { DEFAULT_GROUPS } from '@shared/groups.js';

// ─── Cache ──────────────────────────────────────────────────────────────────

let CACHE = null;
let CACHE_OFFICE_ID = null;
let CACHE_TIMESTAMP = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 perc

export function invalidateContributorGroupsCache() {
    CACHE = null;
    CACHE_OFFICE_ID = null;
    CACHE_TIMESTAMP = 0;
}

// ─── Sorrend helper ─────────────────────────────────────────────────────────

const DEFAULT_ORDER = new Map(DEFAULT_GROUPS.map((g, i) => [g.slug, i]));

function sortGroups(groups) {
    return [...groups].sort((a, b) => {
        const ia = DEFAULT_ORDER.has(a.slug) ? DEFAULT_ORDER.get(a.slug) : 1000;
        const ib = DEFAULT_ORDER.has(b.slug) ? DEFAULT_ORDER.get(b.slug) : 1000;
        if (ia !== ib) return ia - ib;
        return a.slug.localeCompare(b.slug);
    });
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * @returns {{
 *   groups: Array<{slug: string, name: string}>,
 *   membersBySlug: Object.<string, Array<{userId: string, userName: string, userEmail: string}>>,
 *   loading: boolean
 * }}
 */
export function useContributorGroups() {
    const { activeEditorialOfficeId } = useScope();
    const { databases } = useData();
    const [groups, setGroups] = useState([]);
    const [membersBySlug, setMembersBySlug] = useState({});
    const [loading, setLoading] = useState(true);
    const mountedRef = useRef(true);
    const generationRef = useRef(0);

    const fetchData = useCallback(async () => {
        const generation = ++generationRef.current;

        if (!activeEditorialOfficeId) {
            setGroups([]);
            setMembersBySlug({});
            setLoading(false);
            return;
        }

        // Cache ellenőrzés
        const now = Date.now();
        if (CACHE && CACHE_OFFICE_ID === activeEditorialOfficeId && (now - CACHE_TIMESTAMP < CACHE_DURATION)) {
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
                        Query.limit(50)
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

            const groupIdToSlug = new Map();
            const sortedGroups = sortGroups(
                groupDocs.map((g) => {
                    groupIdToSlug.set(g.$id, g.slug);
                    return { slug: g.slug, name: g.name };
                })
            );

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

            // Cache frissítés
            CACHE = { groups: sortedGroups, membersBySlug: bySlug };
            CACHE_OFFICE_ID = activeEditorialOfficeId;
            CACHE_TIMESTAMP = Date.now();

            setGroups(sortedGroups);
            setMembersBySlug(bySlug);
        } catch (err) {
            console.error('[useContributorGroups] Hiba a csoportok/tagok lekérésekor:', err);
            if (!mountedRef.current || generation !== generationRef.current) return;
            setGroups([]);
            setMembersBySlug({});
        }

        if (mountedRef.current) setLoading(false);
    }, [activeEditorialOfficeId, databases]);

    useEffect(() => {
        mountedRef.current = true;
        fetchData();
        return () => { mountedRef.current = false; };
    }, [fetchData]);

    return { groups, membersBySlug, loading };
}
