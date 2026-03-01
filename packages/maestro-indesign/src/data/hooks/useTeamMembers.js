// Appwrite
import { functions, GET_TEAM_MEMBERS_FUNCTION_ID } from "../../core/config/appwriteConfig.js";

// React
import { useState, useEffect, useCallback } from "react";

// Config
import { MaestroEvent } from "../../core/config/maestroEvents.js";

// Utils
import { withRetry } from "../../core/utils/promiseUtils.js";
import { logWarn, logError } from "../../core/utils/logger.js";

export const getTeamMembers = async (teamId) => {
    if (!teamId) return [];

    try {
        // Use withRetry to handle transient network errors (502, 503, etc.)
        const execution = await withRetry(async () => {
            return await functions.createExecution({
                functionId: GET_TEAM_MEMBERS_FUNCTION_ID,
                body: JSON.stringify({ teamId: teamId })
            });
        }, { operationName: `Fetch members for team ${teamId}` });

        if (execution.status === "completed") {
            if (!execution.responseBody) {
                logWarn(`[useTeamMembers] Empty response body for team ${teamId}`);
                return [];
            }

            let response;
            try {
                response = JSON.parse(execution.responseBody);
            } catch (e) {
                logError(`[useTeamMembers] JSON parse error for team ${teamId}:`, e);
                logError(`[useTeamMembers] Response length: ${execution.responseBody.length}`);
                return [];
            }

            if (response.success && response.members) {
                // Normalize data to standard format for UI
                return response.members.map(m => ({
                    userId: m.userId,
                    userName: m.name, // The function returns 'name'
                    userEmail: m.email
                }));
            } else {
                logWarn(`Cloud Function error for ${teamId}:`, response.message);
                // Don't throw for logic errors, just return empty to avoid UI crash loop
                return [];
            }
        } else {
            logError(`Execution failed for ${teamId}: status=${execution.status}`);
            // Log but return empty list to prevent crash loop
            return [];
        }
    } catch (err) {
        // Suppress specific Appwrite cloud function timeout errors
        const msg = err.message || "";
        if (msg.includes("Synchronous function execution timed out")) {
             logWarn(`[useTeamMembers] Function execution warning for ${teamId}: Server timed out. Returning empty list.`);
             return [];
        }

        logError(`Failed to fetch members for team ${teamId}:`, err);
        // If the function doesn't exist yet (404), warn gracefully
        if (err.code === 404) {
             logWarn(`Function '${GET_TEAM_MEMBERS_FUNCTION_ID}' not found or execution failed. Check Appwrite config.`);
        }

        // Return empty array instead of throwing to prevent UI loops
        return [];
    }
};

const CACHE = {};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * A csapattag-cache invalidálása.
 * A következő useTeamMembers hívás friss adatot kér a szervertől.
 */
export function invalidateTeamMembersCache() {
    Object.keys(CACHE).forEach(key => delete CACHE[key]);
}

/**
 * Egyetlen csapat cache-ének invalidálása.
 * @param {string} teamId - A csapat azonosítója
 */
export function invalidateTeamMembersCacheForTeam(teamId) {
    if (CACHE[teamId]) delete CACHE[teamId];
}

export const useTeamMembers = (teamId) => {
    const [members, setMembers] = useState([]);
    const [loading, setLoading] = useState(true);

    const fetchMembers = useCallback(async () => {
        if (!teamId) return;

        // Cache ellenőrzés
        const cached = CACHE[teamId];
        const now = Date.now();
        if (cached && (now - cached.timestamp < CACHE_DURATION)) {
             setMembers(cached.data);
             setLoading(false);
             return;
        }

        setLoading(true);

        // A getTeamMembers soha nem dob kivételt — hibák esetén üres tömböt ad vissza.
        const data = await getTeamMembers(teamId);

        // Cache frissítés
        CACHE[teamId] = {
            data: data,
            timestamp: Date.now()
        };

        setMembers(data);
        setLoading(false);
    }, [teamId]);

    useEffect(() => {
        fetchMembers();
    }, [fetchMembers]);

    // Realtime: csapattagság változás → cache invalidálás + újralekérés
    useEffect(() => {
        if (!teamId) return;

        const handleMembershipChanged = (event) => {
            const changedTeamId = event.detail?.teamId;
            if (changedTeamId === teamId) {
                invalidateTeamMembersCacheForTeam(teamId);
                fetchMembers();
            }
        };

        // Recovery: cache invalidálás + újralekérés
        const handleRecovery = () => {
            invalidateTeamMembersCacheForTeam(teamId);
            fetchMembers();
        };

        window.addEventListener(MaestroEvent.teamMembershipChanged, handleMembershipChanged);
        window.addEventListener(MaestroEvent.dataRefreshRequested, handleRecovery);

        return () => {
            window.removeEventListener(MaestroEvent.teamMembershipChanged, handleMembershipChanged);
            window.removeEventListener(MaestroEvent.dataRefreshRequested, handleRecovery);
        };
    }, [teamId, fetchMembers]);

    return { members, loading, refetch: fetchMembers };
};
