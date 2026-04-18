/**
 * @file useFilters.js
 * @description Központi szűrő állapot hook.
 *
 * A korábban Publication.jsx-ben lévő per-publikációs szűrő állapotot emeli ki
 * közös hook-ba, hogy minden kiadványra egységesen alkalmazzuk a szűrőket.
 * Az állapotot localStorage-ban perzisztálja.
 */

// React
import { useState, useCallback, useMemo } from "react";

// Konfiguráció & Konstansok
import { STORAGE_KEYS } from "../../core/utils/constants.js";

// Utils
import { logError } from "../../core/utils/logger.js";
import { useData } from "../../core/contexts/DataContext.jsx";
import { getAllStates } from "maestro-shared/workflowRuntime.js";

/**
 * localStorage-ból olvassa a mentett status filter-t.
 * Régi integer ID-k esetén eldobja a mentett értéket.
 * @returns {string[]|null} Mentett szűrők vagy null ha nincs/érvénytelen.
 */
function loadStatusFilter() {
    try {
        const saved = localStorage.getItem(STORAGE_KEYS.FILTER_STATUS);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                if (parsed.length > 0 && typeof parsed[0] !== 'string') {
                    localStorage.removeItem(STORAGE_KEYS.FILTER_STATUS);
                    return null;
                }
                return parsed;
            }
        }
    } catch (error) {
        logError(`[useFilters] Error parsing statusFilters from localStorage (key: ${STORAGE_KEYS.FILTER_STATUS}):`, error);
    }
    return null;
}

/**
 * Központi szűrő állapot hook.
 * Az állapotszűrők string ID-kat tartalmaznak.
 * Ha nincs localStorage-ban mentett érték, az összes állapot aktív (allStatuses).
 *
 * @returns {Object} Szűrő állapot és kezelő függvények.
 */
export const useFilters = () => {
    const { workflow } = useData();
    const allStatuses = useMemo(() => getAllStates(workflow).map(s => s.id), [workflow]);
    const [filterOpen, setFilterOpen] = useState(false);

    // null = nincs mentett szűrő → allStatuses lesz az effektív
    const [statusFilters, setStatusFilters] = useState(loadStatusFilter);

    // Effektív szűrő: ha nincs mentett, az összes állapot aktív
    const effectiveStatusFilters = statusFilters ?? allStatuses;

    const [showIgnored, setShowIgnored] = useState(
        () => localStorage.getItem(STORAGE_KEYS.FILTER_SHOW_IGNORED) !== 'false'
    );

    const [showOnlyMine, setShowOnlyMine] = useState(
        () => localStorage.getItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE) === 'true'
    );

    const [showPlaceholders, setShowPlaceholders] = useState(
        () => localStorage.getItem(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS) !== 'false'
    );

    const isFilterActive = effectiveStatusFilters.length !== allStatuses.length || !showIgnored || showOnlyMine || !showPlaceholders;

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
        setStatusFilters(null);
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
        statusFilters: effectiveStatusFilters,
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
