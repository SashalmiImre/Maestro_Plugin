/**
 * @file useContributorGroups.js
 * @description Az aktív szerkesztőség összes csoportját és csoporttagjait lekéri.
 *
 * Két Appwrite query:
 *   1. `groups` (editorialOfficeId) → [{slug, name, description, color, isContributorGroup, isLeaderGroup, archivedAt}]
 *   2. `groupMemberships` (editorialOfficeId) → [{groupId, userId, userName, userEmail}]
 *
 * Visszaadja:
 *   - `groups: [{slug, name, description, color, isContributorGroup, isLeaderGroup, archivedAt}]`
 *     — `orderingSlugs` paraméter alapján rendezve, fallback `$createdAt` ascending
 *   - `membersBySlug: {slug: [{userId, userName, userEmail}]}`
 *   - `loading: boolean`
 *
 * **A.5.4 változások (Dashboard A.4.9 mintára, ADR 0008)**:
 *   - `DEFAULT_GROUPS` import eltávolítva — a workflow-driven autoseed után a
 *     7 hardcoded csoport feltevése már nem érvényes.
 *   - **Sorrend**: opcionális `orderingSlugs` paraméter (a publikáció
 *     `compiledWorkflowSnapshot.requiredGroupSlugs[].slug` listája) szerint;
 *     fallback `groups.$createdAt` ascending — kanonikus first-write-wins.
 *   - **Cache invalidáció**: Realtime listener a `groups` és `groupMemberships`
 *     collection-en — más tabban / másik user által történő változás
 *     azonnal tükröződik. 5-perces TTL eltűnt.
 *   - **Metadata**: a `name` mellé `description`, `color`, `isContributorGroup`,
 *     `isLeaderGroup`, `archivedAt` is letöltődik (a hívó ezeket szűrésre /
 *     színezésre / "archivált" jelzésre használhatja).
 *   - **Archived groups megmaradnak** a return-ben — a hívó UI dönti el, hogy
 *     mutatja-e (pl. egy meglévő `defaultContributors[archivedSlug]`
 *     hozzárendelés "archivált" badge-dzsel kell látsszon, hogy a felhasználó
 *     el tudja távolítani).
 *
 * Reconnect-time resync (Plugin oldali sajátosság): a Plugin dual-proxy
 * recovery rétege a `dataRefreshRequested` MaestroEvent-en keresztül indítja
 * az újratöltést. A hook erre is feliratkozik, így a megszakadás-újraépítés
 * ablakában érkezett group-mutációkat is lefedi.
 */

// React
import { useState, useEffect, useCallback, useRef } from "react";

// Context
import { useScope } from "../../core/contexts/ScopeContext.jsx";

// Config
import { tables, DATABASE_ID, COLLECTIONS, Query } from "../../core/config/appwriteConfig.js";
import { realtime } from "../../core/config/realtimeClient.js";
import { MaestroEvent } from "../../core/config/maestroEvents.js";

// Utils
import { withRetry, paginateAll } from "../../core/utils/promiseUtils.js";
import { logError } from "../../core/utils/logger.js";

// ---------------------------------------------------------------------------
// Cache (in-memory, scope + ordering kulcsra)
// ---------------------------------------------------------------------------
//
// A cache scope-onként (`activeEditorialOfficeId`) ÉS `orderingKey`-enként
// él. Realtime listener invalidálja, amint az adatforrás változik — így
// a cache mindig friss, de a re-render ablakon belül stabil.

let CACHE = null;
let CACHE_OFFICE_ID = null;
let CACHE_ORDERING_KEY = '';

export function invalidateContributorGroupsCache() {
    CACHE = null;
    CACHE_OFFICE_ID = null;
    CACHE_ORDERING_KEY = '';
}

// ---------------------------------------------------------------------------
// Sorrend helper
// ---------------------------------------------------------------------------

/**
 * Rendezés:
 *   1. ha van `orderingSlugs` (a publikáció / workflow `requiredGroupSlugs[]`-ből),
 *      az index-rendezést alkalmazzuk — a slug-ok ott következnek, ahol a
 *      workflow definiálta őket, az ismeretlen slug-ok a végére kerülnek.
 *   2. fallback: `groups.$createdAt` ascending (kanonikus first-write-wins,
 *      ADR 0008 A.3 slug-collision policy). Tie-break a slug-on a
 *      determinizmusért.
 */
// ---------------------------------------------------------------------------
// Cursor-pagination — withRetry + paginateAll összekötése a tables.listRows API-ra
// ---------------------------------------------------------------------------

const fetchAllPaginated = (tableId, baseQueries, operationName) => paginateAll(
    (queries) => withRetry(
        () => tables.listRows({ databaseId: DATABASE_ID, tableId, queries }),
        { operationName }
    ),
    {
        baseQueries,
        cursorAfterFn: Query.cursorAfter,
        limitFn: Query.limit,
        operationName
    }
);

function sortGroups(groups, orderingSlugs) {
    if (Array.isArray(orderingSlugs) && orderingSlugs.length > 0) {
        const orderIdx = new Map(orderingSlugs.map((s, i) => [s, i]));
        return [...groups].sort((a, b) => {
            const ia = orderIdx.has(a.slug) ? orderIdx.get(a.slug) : Number.MAX_SAFE_INTEGER;
            const ib = orderIdx.has(b.slug) ? orderIdx.get(b.slug) : Number.MAX_SAFE_INTEGER;
            if (ia !== ib) return ia - ib;
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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Az aktív szerkesztőség összes csoportját és csoporttagjait lekérő hook.
 *
 * @param {Object} [options]
 * @param {string[]} [options.orderingSlugs] - Opcionális slug-array a publikáció
 *   `compiledWorkflowSnapshot.requiredGroupSlugs[].slug` listájából. Ha jelen
 *   van, a hook a slug-ok eredeti workflow-sorrendjét tükrözi. Egyébként
 *   `$createdAt` ascending fallback.
 * @returns {{
 *   groups: Array<{slug: string, name: string, description: string, color: string, isContributorGroup: boolean, isLeaderGroup: boolean, archivedAt: string|null}>,
 *   membersBySlug: Object.<string, Array<{userId: string, userName: string, userEmail: string}>>,
 *   loading: boolean
 * }}
 */
export function useContributorGroups(options = {}) {
    const { orderingSlugs } = options;
    const { activeEditorialOfficeId } = useScope();
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

        // Cache hit (scope + orderingKey egyezés)
        if (CACHE && CACHE_OFFICE_ID === activeEditorialOfficeId && CACHE_ORDERING_KEY === orderingKey) {
            setGroups(CACHE.groups);
            setMembersBySlug(CACHE.membersBySlug);
            setLoading(false);
            return;
        }

        setLoading(true);

        try {
            // Párhuzamos lekérdezés cursor-pagination-nel — egy nagyobb
            // szerkesztőség (>100 csoport vagy >500 tag) különben silent-en
            // levágta volna a végét és lyukas dropdown-okat adott (Codex
            // baseline review P2 + adversarial review #5).
            const [groupDocs, membershipDocs] = await Promise.all([
                fetchAllPaginated(
                    COLLECTIONS.GROUPS,
                    [Query.equal('editorialOfficeId', activeEditorialOfficeId)],
                    'fetchContributorGroups'
                ),
                fetchAllPaginated(
                    COLLECTIONS.GROUP_MEMBERSHIPS,
                    [Query.equal('editorialOfficeId', activeEditorialOfficeId)],
                    'fetchContributorGroupMembers'
                )
            ]);

            // Stale response / unmount védelem
            if (!mountedRef.current || generation !== generationRef.current) return;

            // groupId → slug leképezés (sort UTÁN, hogy a doc-ok eredeti $createdAt
            // sorrendje is megmaradjon a `sortGroups` fallback-jéhez).
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
            CACHE_ORDERING_KEY = orderingKey;

            setGroups(sortedGroups);
            setMembersBySlug(bySlug);
        } catch (err) {
            logError('[useContributorGroups] Hiba a csoportok/tagok lekérésekor:', err);
            if (!mountedRef.current || generation !== generationRef.current) return;
            setGroups([]);
            setMembersBySlug({});
        }

        if (mountedRef.current) setLoading(false);
        // `orderingSlugs` direkt deps-ként benne van a `orderingKey` mellett —
        // azon az ágon, ahol a hívó stabilizálja, csak a key változik (no-op
        // re-fetch). Az `eslint-disable` szükségtelen: `orderingKey` képviseli.
    }, [activeEditorialOfficeId, orderingKey, orderingSlugs]);

    useEffect(() => {
        mountedRef.current = true;
        fetchData();
        return () => { mountedRef.current = false; };
    }, [fetchData]);

    // Realtime: groups + groupMemberships változás → cache invalidálás + reload.
    // Scope-szűrés a payload `editorialOfficeId`-jén; .delete eseményeknél
    // (ahol a payload csak `$id`) skip-elés helyett közvetlen reload — a fetch
    // úgyis konvergálja a state-et.
    useEffect(() => {
        if (!activeEditorialOfficeId) return undefined;

        const channels = [
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.GROUPS}.documents`,
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.GROUP_MEMBERSHIPS}.documents`
        ];

        let debounceId = null;
        const DEBOUNCE_MS = 100;

        const unsubscribe = realtime.subscribe(channels, (response) => {
            const { events, payload } = response;
            const isDelete = events?.some(e => e.includes('.delete'));
            if (!isDelete) {
                if (!payload || payload.editorialOfficeId !== activeEditorialOfficeId) return;
            }
            if (debounceId) clearTimeout(debounceId);
            debounceId = setTimeout(() => {
                debounceId = null;
                invalidateContributorGroupsCache();
                fetchData();
            }, DEBOUNCE_MS);
        });

        return () => {
            if (debounceId) clearTimeout(debounceId);
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, [activeEditorialOfficeId, fetchData]);

    // MaestroEvent: groupMembershipChanged / dataRefreshRequested (recovery).
    // A `dataRefreshRequested` lefedi a dual-proxy reconnect ablakában történt
    // változásokat — a Plugin oldali analógja a Dashboard `onReconnect`
    // callback-jének (a `realtime.subscribe` callback nem kap push-t a
    // megszakadás alatt érkezett event-ekről).
    //
    // `authStateChanged` (cross-user leakage védelem, simplify finding):
    // a modul-szintű CACHE túléli az auth-boundary-t — másik user belépése
    // után az első render egy stale tabba addigi office adatait láthatja
    // a fetch befejezéséig. Az event minden login és logout átmenetnél
    // tüzel, így a cache invalidálódik a user-csere pillanatában.
    useEffect(() => {
        const handleChange = () => {
            invalidateContributorGroupsCache();
            fetchData();
        };
        const handleAuthChange = () => {
            invalidateContributorGroupsCache();
        };

        window.addEventListener(MaestroEvent.groupMembershipChanged, handleChange);
        window.addEventListener(MaestroEvent.dataRefreshRequested, handleChange);
        window.addEventListener(MaestroEvent.authStateChanged, handleAuthChange);

        return () => {
            window.removeEventListener(MaestroEvent.groupMembershipChanged, handleChange);
            window.removeEventListener(MaestroEvent.dataRefreshRequested, handleChange);
            window.removeEventListener(MaestroEvent.authStateChanged, handleAuthChange);
        };
    }, [fetchData]);

    return { groups, membersBySlug, loading };
}
