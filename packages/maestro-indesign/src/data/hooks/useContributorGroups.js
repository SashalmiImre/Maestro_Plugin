/**
 * @file useContributorGroups.js
 * @description Az aktív szerkesztőség összes csoportját és csoporttagjait lekéri.
 *
 * Két Appwrite query:
 * 1. groups (editorialOfficeId) → [{$id, slug, name}]
 * 2. groupMemberships (editorialOfficeId) → [{groupId, userId, userName, userEmail}]
 *
 * Visszaadja:
 * - groups: [{slug, name}] — a DEFAULT_GROUPS sorrend szerint rendezve,
 *   ismeretlen csoportok a végére kerülnek
 * - membersBySlug: {slug: [{userId, userName, userEmail}]}
 * - loading: boolean
 *
 * Kiváltja a 7× useGroupMembers(slug) hívást a ContributorsSection komponensekben.
 * Fázis 4-ben a groups forrása átállhat compiled.contributorGroups-ra.
 *
 * Fázis 3
 */

// React
import { useState, useEffect, useCallback, useRef } from "react";

// Context
import { useScope } from "../../core/contexts/ScopeContext.jsx";

// Config
import { tables, DATABASE_ID, GROUPS_COLLECTION_ID, GROUP_MEMBERSHIPS_COLLECTION_ID, Query } from "../../core/config/appwriteConfig.js";
import { MaestroEvent } from "../../core/config/maestroEvents.js";

// Utils
import { withRetry } from "../../core/utils/promiseUtils.js";
import { logError } from "../../core/utils/logger.js";

// Shared
import { DEFAULT_GROUPS } from "maestro-shared/groups.js";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let CACHE = null;
let CACHE_OFFICE_ID = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 perc
let CACHE_TIMESTAMP = 0;

function invalidateCache() {
    CACHE = null;
    CACHE_OFFICE_ID = null;
    CACHE_TIMESTAMP = 0;
}

// ---------------------------------------------------------------------------
// Sorrend helper
// ---------------------------------------------------------------------------

/** A DEFAULT_GROUPS slug sorrendje — ismeretlen csoportok a végére kerülnek. */
const DEFAULT_ORDER = new Map(DEFAULT_GROUPS.map((g, i) => [g.slug, i]));

function sortGroups(groups) {
    return [...groups].sort((a, b) => {
        const ia = DEFAULT_ORDER.has(a.slug) ? DEFAULT_ORDER.get(a.slug) : 1000;
        const ib = DEFAULT_ORDER.has(b.slug) ? DEFAULT_ORDER.get(b.slug) : 1000;
        if (ia !== ib) return ia - ib;
        return a.slug.localeCompare(b.slug);
    });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Az aktív szerkesztőség összes csoportját és csoporttagjait lekérő hook.
 *
 * @returns {{
 *   groups: Array<{slug: string, name: string}>,
 *   membersBySlug: Object.<string, Array<{userId: string, userName: string, userEmail: string}>>,
 *   loading: boolean
 * }}
 */
export function useContributorGroups() {
    const { activeEditorialOfficeId } = useScope();
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
            // Párhuzamos lekérdezés: groups + groupMemberships
            const [groupsResult, membershipsResult] = await Promise.all([
                withRetry(
                    () => tables.listRows({
                        databaseId: DATABASE_ID,
                        tableId: GROUPS_COLLECTION_ID,
                        queries: [
                            Query.equal('editorialOfficeId', activeEditorialOfficeId),
                            Query.limit(50)
                        ]
                    }),
                    { operationName: 'fetchContributorGroups' }
                ),
                withRetry(
                    () => tables.listRows({
                        databaseId: DATABASE_ID,
                        tableId: GROUP_MEMBERSHIPS_COLLECTION_ID,
                        queries: [
                            Query.equal('editorialOfficeId', activeEditorialOfficeId),
                            Query.limit(500)
                        ]
                    }),
                    { operationName: 'fetchContributorGroupMembers' }
                )
            ]);

            // Stale response / unmount védelem
            if (!mountedRef.current || generation !== generationRef.current) return;

            const groupDocs = groupsResult.rows || groupsResult.documents || [];
            const membershipDocs = membershipsResult.rows || membershipsResult.documents || [];

            // groupId → slug leképezés
            const groupIdToSlug = new Map();
            const sortedGroups = sortGroups(
                groupDocs.map(g => {
                    groupIdToSlug.set(g.$id, g.slug);
                    return { slug: g.slug, name: g.name };
                })
            );

            // Tagok slug szerint csoportosítva
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
            logError('[useContributorGroups] Hiba a csoportok/tagok lekérésekor:', err);
            if (!mountedRef.current || generation !== generationRef.current) return;
            setGroups([]);
            setMembersBySlug({});
        }

        if (mountedRef.current) setLoading(false);
    }, [activeEditorialOfficeId]);

    // Mount + officeId változás
    useEffect(() => {
        mountedRef.current = true;
        fetchData();
        return () => { mountedRef.current = false; };
    }, [fetchData]);

    // Realtime: csoporttagság változás → cache invalidálás + újralekérés
    useEffect(() => {
        const handleChange = () => {
            invalidateCache();
            fetchData();
        };

        window.addEventListener(MaestroEvent.groupMembershipChanged, handleChange);
        window.addEventListener(MaestroEvent.dataRefreshRequested, handleChange);

        return () => {
            window.removeEventListener(MaestroEvent.groupMembershipChanged, handleChange);
            window.removeEventListener(MaestroEvent.dataRefreshRequested, handleChange);
        };
    }, [fetchData]);

    return { groups, membersBySlug, loading };
}
