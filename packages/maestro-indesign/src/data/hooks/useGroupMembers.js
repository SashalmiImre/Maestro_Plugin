/**
 * @file useGroupMembers.js
 * @description Csoporttagok lekérése a groupMemberships collection-ből.
 *
 * A korábbi useTeamMembers-t váltja ki: Cloud Function hívás helyett közvetlen
 * Appwrite DB query a groupMemberships + groups collection-ökön.
 * A userName/userEmail denormalizálva van a groupMemberships dokumentumokon.
 *
 * Fázis 2 / B.7
 */

// React
import { useState, useEffect, useCallback, useRef } from "react";

// Context & Hooks
import { useScope } from "../../core/contexts/ScopeContext.jsx";

// Config
import { tables, DATABASE_ID, GROUPS_COLLECTION_ID, GROUP_MEMBERSHIPS_COLLECTION_ID, Query } from "../../core/config/appwriteConfig.js";
import { MaestroEvent } from "../../core/config/maestroEvents.js";

// Utils
import { withRetry } from "../../core/utils/promiseUtils.js";
import { logWarn, logError } from "../../core/utils/logger.js";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE = {};
const CACHE_DURATION = 5 * 60 * 1000; // 5 perc

/**
 * A csoporttag-cache teljes invalidálása.
 */
export function invalidateGroupMembersCache() {
    Object.keys(CACHE).forEach(key => delete CACHE[key]);
}

/**
 * Egyetlen csoport cache-ének invalidálása.
 * @param {string} groupSlug - A csoport slug-ja
 */
export function invalidateGroupMembersCacheForSlug(groupSlug) {
    // A cache kulcs `${slug}::${officeId}` formátumú — az összes matchelőt töröljük
    for (const key of Object.keys(CACHE)) {
        if (key.startsWith(`${groupSlug}::`)) delete CACHE[key];
    }
}

// ---------------------------------------------------------------------------
// Lekérdező függvény
// ---------------------------------------------------------------------------

/**
 * Egy csoport tagjainak lekérése slug és editorialOfficeId alapján.
 *
 * @param {string} groupSlug - A csoport slug-ja (pl. 'editors')
 * @param {string} editorialOfficeId - Az aktív szerkesztőség ID-ja
 * @returns {Promise<Array<{userId: string, userName: string, userEmail: string}>>}
 */
export async function getGroupMembers(groupSlug, editorialOfficeId) {
    if (!groupSlug || !editorialOfficeId) return [];

    try {
        // 1. Csoport keresése slug + officeId alapján
        const groupsResult = await withRetry(
            () => tables.listRows({
                databaseId: DATABASE_ID,
                tableId: GROUPS_COLLECTION_ID,
                queries: [
                    Query.equal('slug', groupSlug),
                    Query.equal('editorialOfficeId', editorialOfficeId),
                    Query.limit(1)
                ]
            }),
            { operationName: `fetchGroup(${groupSlug})` }
        );

        const groupRows = groupsResult.rows || groupsResult.documents || [];
        if (groupRows.length === 0) {
            logWarn(`[useGroupMembers] Csoport nem található: slug=${groupSlug}, officeId=${editorialOfficeId}`);
            return [];
        }

        const groupId = groupRows[0].$id;

        // 2. Tagok lekérése groupId alapján
        const membershipsResult = await withRetry(
            () => tables.listRows({
                databaseId: DATABASE_ID,
                tableId: GROUP_MEMBERSHIPS_COLLECTION_ID,
                queries: [
                    Query.equal('groupId', groupId),
                    Query.limit(100)
                ]
            }),
            { operationName: `fetchGroupMembers(${groupSlug})` }
        );

        return (membershipsResult.rows || membershipsResult.documents || []).map(m => ({
            userId: m.userId,
            userName: m.userName || '',
            userEmail: m.userEmail || ''
        }));
    } catch (err) {
        logError(`[useGroupMembers] Hiba a ${groupSlug} csoport tagjainak lekérésekor:`, err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Hook: useGroupMembers
// ---------------------------------------------------------------------------

/**
 * Egyetlen csoport tagjait lekérő hook.
 *
 * @param {string} groupSlug - A csoport slug-ja (pl. 'editors')
 * @returns {{ members: Array<{userId: string, userName: string, userEmail: string}>, loading: boolean, refetch: Function }}
 */
export const useGroupMembers = (groupSlug) => {
    const { activeEditorialOfficeId } = useScope();
    const [members, setMembers] = useState([]);
    const [loading, setLoading] = useState(true);
    const mountedRef = useRef(true);
    const generationRef = useRef(0);

    const fetchMembers = useCallback(async () => {
        // Generáció inkrementálás a legelején — bármely korábbi in-flight response
        // invalidálódik, még akkor is, ha az aktuális hívás cache-ből teljesül.
        const generation = ++generationRef.current;

        if (!groupSlug || !activeEditorialOfficeId) {
            setMembers([]);
            setLoading(false);
            return;
        }

        const cacheKey = `${groupSlug}::${activeEditorialOfficeId}`;

        // Cache ellenőrzés
        const cached = CACHE[cacheKey];
        const now = Date.now();
        if (cached && (now - cached.timestamp < CACHE_DURATION)) {
            setMembers(cached.data);
            setLoading(false);
            return;
        }

        setLoading(true);

        const data = await getGroupMembers(groupSlug, activeEditorialOfficeId);

        // Stale response / unmount védelem
        if (!mountedRef.current || generation !== generationRef.current) return;

        // Cache frissítés
        CACHE[cacheKey] = {
            data,
            timestamp: Date.now()
        };

        setMembers(data);
        setLoading(false);
    }, [groupSlug, activeEditorialOfficeId]);

    useEffect(() => {
        mountedRef.current = true;
        fetchMembers();
        return () => { mountedRef.current = false; };
    }, [fetchMembers]);

    // Realtime: csoporttagság változás → cache invalidálás + újralekérés
    useEffect(() => {
        if (!groupSlug) return;

        const handleMembershipChanged = () => {
            // Bármely csoporttagság változásnál invalidáljuk — a groupId-t nem
            // tudjuk slug-ból feloldani event handlerben, ezért konzervatív megoldás
            invalidateGroupMembersCacheForSlug(groupSlug);
            fetchMembers();
        };

        // Recovery: cache invalidálás + újralekérés
        const handleRecovery = () => {
            invalidateGroupMembersCacheForSlug(groupSlug);
            fetchMembers();
        };

        window.addEventListener(MaestroEvent.groupMembershipChanged, handleMembershipChanged);
        window.addEventListener(MaestroEvent.dataRefreshRequested, handleRecovery);

        return () => {
            window.removeEventListener(MaestroEvent.groupMembershipChanged, handleMembershipChanged);
            window.removeEventListener(MaestroEvent.dataRefreshRequested, handleRecovery);
        };
    }, [groupSlug, fetchMembers]);

    return { members, loading, refetch: fetchMembers };
};

// ---------------------------------------------------------------------------
// Hook: useAllGroupMembers
// ---------------------------------------------------------------------------

/** Cache az összes tag lekéréshez (officeId → data). */
const ALL_CACHE = {};

/**
 * Az aktív szerkesztőség összes csoporttagjának lekérése (deduplikálva).
 *
 * Egyetlen groupMemberships query az editorialOfficeId-re — nem kell
 * csoportonként külön lekérdezni, a denormalizált userName/userEmail közvetlenül
 * elérhető a dokumentumokon.
 *
 * @returns {{ members: Array<{userId: string, userName: string, userEmail: string}>, loading: boolean }}
 */
export const useAllGroupMembers = () => {
    const { activeEditorialOfficeId } = useScope();
    const [members, setMembers] = useState([]);
    const [loading, setLoading] = useState(true);
    const mountedRef = useRef(true);

    const fetchAll = useCallback(async () => {
        if (!activeEditorialOfficeId) {
            setMembers([]);
            setLoading(false);
            return;
        }

        const cacheKey = activeEditorialOfficeId;
        const cached = ALL_CACHE[cacheKey];
        const now = Date.now();
        if (cached && (now - cached.timestamp < CACHE_DURATION)) {
            setMembers(cached.data);
            setLoading(false);
            return;
        }

        setLoading(true);

        try {
            const result = await withRetry(
                () => tables.listRows({
                    databaseId: DATABASE_ID,
                    tableId: GROUP_MEMBERSHIPS_COLLECTION_ID,
                    queries: [
                        Query.equal('editorialOfficeId', activeEditorialOfficeId),
                        Query.limit(500)
                    ]
                }),
                { operationName: 'fetchAllGroupMembers' }
            );

            if (!mountedRef.current) return;

            // Deduplikálás userId alapján
            const seen = new Set();
            const deduplicated = [];
            for (const m of (result.rows || result.documents || [])) {
                if (!seen.has(m.userId)) {
                    seen.add(m.userId);
                    deduplicated.push({
                        userId: m.userId,
                        userName: m.userName || '',
                        userEmail: m.userEmail || ''
                    });
                }
            }

            ALL_CACHE[cacheKey] = { data: deduplicated, timestamp: Date.now() };
            setMembers(deduplicated);
        } catch (err) {
            logError('[useAllGroupMembers] Hiba az összes csoporttag lekérésekor:', err);
            if (!mountedRef.current) return;
            setMembers([]);
        }

        setLoading(false);
    }, [activeEditorialOfficeId]);

    useEffect(() => {
        mountedRef.current = true;
        fetchAll();
        return () => { mountedRef.current = false; };
    }, [fetchAll]);

    // Realtime: csoporttagság változás → cache invalidálás + újralekérés
    useEffect(() => {
        const handleMembershipChanged = () => {
            if (activeEditorialOfficeId) {
                delete ALL_CACHE[activeEditorialOfficeId];
            }
            fetchAll();
        };

        const handleRecovery = () => {
            invalidateGroupMembersCache();
            Object.keys(ALL_CACHE).forEach(key => delete ALL_CACHE[key]);
            fetchAll();
        };

        window.addEventListener(MaestroEvent.groupMembershipChanged, handleMembershipChanged);
        window.addEventListener(MaestroEvent.dataRefreshRequested, handleRecovery);

        return () => {
            window.removeEventListener(MaestroEvent.groupMembershipChanged, handleMembershipChanged);
            window.removeEventListener(MaestroEvent.dataRefreshRequested, handleRecovery);
        };
    }, [fetchAll, activeEditorialOfficeId]);

    return { members, loading };
};
