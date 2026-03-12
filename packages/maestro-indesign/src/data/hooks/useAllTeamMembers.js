// React
import { useState, useEffect, useCallback, useRef } from "react";

// Config
import { TEAMS } from "../../core/config/appwriteConfig.js";
import { MaestroEvent } from "../../core/config/maestroEvents.js";

// Utils
import { getTeamMembers, invalidateTeamMembersCache, invalidateTeamMembersCacheForTeam } from "./useTeamMembers.js";

const ALL_TEAM_IDS = Object.values(TEAMS);

/**
 * Az összes csapat tagjait lekérő hook.
 * Dinamikusan iterál a TEAMS konfig összes értékén — új csapat hozzáadásakor
 * automatikusan bekerül a lekérdezésbe.
 * Deduplikál userId alapján (egy személy több csapatban is lehet).
 *
 * @returns {{ members: Array<{userId: string, userName: string, userEmail: string}>, loading: boolean }}
 */
export const useAllTeamMembers = () => {
    const [members, setMembers] = useState([]);
    const [loading, setLoading] = useState(true);
    const mountedRef = useRef(true);

    const fetchAll = useCallback(async () => {
        setLoading(true);

        const settled = await Promise.allSettled(
            ALL_TEAM_IDS.map(teamId => getTeamMembers(teamId))
        );

        if (!mountedRef.current) return;

        // Deduplikálás userId alapján
        const seen = new Set();
        const deduplicated = [];
        for (const result of settled) {
            if (result.status !== 'fulfilled') continue;
            for (const member of result.value) {
                if (!seen.has(member.userId)) {
                    seen.add(member.userId);
                    deduplicated.push(member);
                }
            }
        }

        setMembers(deduplicated);
        setLoading(false);
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        fetchAll();
        return () => { mountedRef.current = false; };
    }, [fetchAll]);

    // Realtime: csapattagság változás → érintett csapat cache invalidálás + újralekérés
    useEffect(() => {
        const handleMembershipChanged = (event) => {
            const changedTeamId = event.detail?.teamId;
            if (changedTeamId) {
                invalidateTeamMembersCacheForTeam(changedTeamId);
            }
            fetchAll();
        };

        // Recovery: teljes cache invalidálás + újralekérés
        const handleRecovery = () => {
            invalidateTeamMembersCache();
            fetchAll();
        };

        window.addEventListener(MaestroEvent.teamMembershipChanged, handleMembershipChanged);
        window.addEventListener(MaestroEvent.dataRefreshRequested, handleRecovery);

        return () => {
            window.removeEventListener(MaestroEvent.teamMembershipChanged, handleMembershipChanged);
            window.removeEventListener(MaestroEvent.dataRefreshRequested, handleRecovery);
        };
    }, [fetchAll]);

    return { members, loading };
};
