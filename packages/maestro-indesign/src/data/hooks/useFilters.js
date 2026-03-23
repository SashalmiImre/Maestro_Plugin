/**
 * @file useFilters.js
 * @description Központi szűrő állapot hook.
 *
 * A korábban Publication.jsx-ben lévő per-publikációs szűrő állapotot emeli ki
 * közös hook-ba, hogy minden kiadványra egységesen alkalmazzuk a szűrőket.
 * Az állapotot localStorage-ban perzisztálja.
 */

// React
import { useState, useCallback } from "react";

// Konfiguráció & Konstansok
import { STORAGE_KEYS } from "../../core/utils/constants.js";
import { WORKFLOW_STATES } from "../../core/utils/workflow/workflowConstants.js";

// Utils
import { logError } from "../../core/utils/logger.js";

const allStatuses = Object.values(WORKFLOW_STATES);

/**
 * Központi szűrő állapot hook.
 *
 * @returns {Object} Szűrő állapot és kezelő függvények.
 */
export const useFilters = () => {
    const [filterOpen, setFilterOpen] = useState(false);

    const [statusFilters, setStatusFilters] = useState(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.FILTER_STATUS);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) return parsed;
            }
        } catch (error) {
            logError(`[useFilters] Error parsing statusFilters from localStorage (key: ${STORAGE_KEYS.FILTER_STATUS}):`, error);
        }
        return allStatuses;
    });

    const [showIgnored, setShowIgnored] = useState(
        () => localStorage.getItem(STORAGE_KEYS.FILTER_SHOW_IGNORED) !== 'false'
    );

    const [showOnlyMine, setShowOnlyMine] = useState(
        () => localStorage.getItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE) === 'true'
    );

    const [showPlaceholders, setShowPlaceholders] = useState(
        () => localStorage.getItem(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS) !== 'false'
    );

    const isFilterActive = statusFilters.length !== allStatuses.length || !showIgnored || showOnlyMine || !showPlaceholders;

    const toggleFilterOpen = useCallback(() => {
        setFilterOpen(prev => !prev);
    }, []);

    const handleStatusFiltersChange = useCallback((newFilters) => {
        setStatusFilters(newFilters);
        localStorage.setItem(STORAGE_KEYS.FILTER_STATUS, JSON.stringify(newFilters));
    }, []);

    const handleShowIgnoredChange = useCallback((value) => {
        setShowIgnored(value);
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_IGNORED, String(value));
    }, []);

    const handleShowOnlyMineChange = useCallback((value) => {
        setShowOnlyMine(value);
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE, String(value));
    }, []);

    const handleShowPlaceholdersChange = useCallback((value) => {
        setShowPlaceholders(value);
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS, String(value));
    }, []);

    const resetFilters = useCallback(() => {
        setStatusFilters(allStatuses);
        setShowIgnored(true);
        setShowOnlyMine(false);
        setShowPlaceholders(true);
        localStorage.removeItem(STORAGE_KEYS.FILTER_STATUS);
        localStorage.removeItem(STORAGE_KEYS.FILTER_SHOW_IGNORED);
        localStorage.removeItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE);
        localStorage.removeItem(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS);
    }, []);

    return {
        filterOpen,
        toggleFilterOpen,
        statusFilters,
        showIgnored,
        showOnlyMine,
        showPlaceholders,
        isFilterActive,
        handleStatusFiltersChange,
        handleShowIgnoredChange,
        handleShowOnlyMineChange,
        handleShowPlaceholdersChange,
        resetFilters
    };
};
