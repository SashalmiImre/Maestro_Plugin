// Appwrite
import { functions, GET_TEAM_MEMBERS_FUNCTION_ID } from "../../core/config/appwriteConfig.js";

// React
import { useState, useEffect, useCallback } from "react";

// Utils
import { withRetry } from "../../core/utils/promiseUtils.js";

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
                console.warn(`[useTeamMembers] Empty response body for team ${teamId}`);
                return [];
            }

            let response;
            try {
                response = JSON.parse(execution.responseBody);
            } catch (e) {
                console.error(`[useTeamMembers] JSON parse error for team ${teamId}:`, e);
                console.error(`[useTeamMembers] Response length: ${execution.responseBody.length}`);
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
                console.warn(`Cloud Function error for ${teamId}:`, response.message);
                // Don't throw for logic errors, just return empty to avoid UI crash loop
                return [];
            }
        } else {
            console.error(`Execution failed for ${teamId}: status=${execution.status}`);
            // Log but return empty list to prevent crash loop
            return [];
        }
    } catch (err) {
        // Suppress specific Appwrite cloud function timeout errors
        const msg = err.message || "";
        if (msg.includes("Synchronous function execution timed out")) {
             console.warn(`[useTeamMembers] Function execution warning for ${teamId}: Server timed out. Returning empty list.`);
             return [];
        }

        console.error(`Failed to fetch members for team ${teamId}:`, err);
        // If the function doesn't exist yet (404), warn gracefully
        if (err.code === 404) {
             console.warn(`Function '${GET_TEAM_MEMBERS_FUNCTION_ID}' not found or execution failed. Check Appwrite config.`);
        }
        
        // Return empty array instead of throwing to prevent UI loops
        return [];
    }
};

const CACHE = {};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

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

    return { members, loading, refetch: fetchMembers };
};
