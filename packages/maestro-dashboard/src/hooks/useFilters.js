/**
 * Maestro Dashboard — Szűrő hook
 *
 * Státusz, kimarad, saját cikkek szűrő — localStorage perzisztált.
 * A workflow-ból dinamikusan olvassa az állapotlistát.
 */

import { useState, useCallback, useMemo } from 'react';
import { MARKERS, STORAGE_KEYS } from '../config.js';
import { useData } from '../contexts/DataContext.jsx';
import { getAllStates } from '@shared/workflowRuntime.js';
import { isContributor } from '@shared/contributorHelpers.js';

// ─── localStorage segédfüggvények ───────────────────────────────────────────

function loadStatusFilter() {
    try {
        const stored = localStorage.getItem(STORAGE_KEYS.FILTER_STATUS);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                // Régi integer state ID-k érvénytelenek — eldobjuk a mentett szűrőt
                if (parsed.length > 0 && typeof parsed[0] !== 'string') {
                    localStorage.removeItem(STORAGE_KEYS.FILTER_STATUS);
                    return null;
                }
                return new Set(parsed);
            }
        }
    } catch { /* fallback */ }
    return null; // null jelzi, hogy nincs mentett filter → allStatuses lesz az alapértelmezett
}

function loadBoolean(key, defaultValue) {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultValue;
    return stored === 'true';
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useFilters() {
    const { workflow } = useData();
    const allStatuses = useMemo(() => new Set(getAllStates(workflow).map(s => s.id)), [workflow]);

    const [statusFilter, setStatusFilter] = useState(loadStatusFilter);
    const [showIgnored, setShowIgnored] = useState(() =>
        loadBoolean(STORAGE_KEYS.FILTER_SHOW_IGNORED, true)
    );
    const [showOnlyMine, setShowOnlyMine] = useState(() =>
        loadBoolean(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE, false)
    );
    const [showPlaceholders, setShowPlaceholders] = useState(() =>
        loadBoolean(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS, true)
    );

    // Effektív filter: ha nincs mentett, az összes állapot aktív
    const effectiveStatusFilter = statusFilter || allStatuses;

    const toggleStatus = useCallback((state) => {
        setStatusFilter(prev => {
            const base = prev || allStatuses;
            const next = new Set(base);
            if (next.has(state)) next.delete(state);
            else next.add(state);
            localStorage.setItem(STORAGE_KEYS.FILTER_STATUS, JSON.stringify([...next]));
            return next;
        });
    }, [allStatuses]);

    const setShowIgnoredPersist = useCallback((value) => {
        setShowIgnored(value);
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_IGNORED, String(value));
    }, []);

    const setShowOnlyMinePersist = useCallback((value) => {
        setShowOnlyMine(value);
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE, String(value));
    }, []);

    const setShowPlaceholdersPersist = useCallback((value) => {
        setShowPlaceholders(value);
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS, String(value));
    }, []);

    const resetFilters = useCallback(() => {
        setStatusFilter(null);
        setShowIgnored(true);
        setShowOnlyMine(false);
        setShowPlaceholders(true);
        localStorage.removeItem(STORAGE_KEYS.FILTER_STATUS);
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_IGNORED, 'true');
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE, 'false');
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS, 'true');
    }, []);

    const isFilterActive = useMemo(() => {
        if (effectiveStatusFilter.size !== allStatuses.size) return true;
        if (!showIgnored) return true;
        if (showOnlyMine) return true;
        if (!showPlaceholders) return true;
        return false;
    }, [effectiveStatusFilter, allStatuses, showIgnored, showOnlyMine, showPlaceholders]);

    /** Szűrés alkalmazása a cikkekre. */
    const applyFilters = useCallback((articles, user) => {
        return articles.filter(article => {
            // Státusz szűrő
            const state = article.state || "";
            if (!effectiveStatusFilter.has(state)) return false;

            // Kimarad szűrő
            const markers = typeof article.markers === 'number' ? article.markers : 0;
            const isIgnored = (markers & MARKERS.IGNORE) !== 0;
            if (!showIgnored && isIgnored) return false;

            // Csak saját cikkek
            if (showOnlyMine && user) {
                const slugs = user?.groupSlugs || [];
                if (!isContributor(article.contributors, user.$id, slugs)) return false;
            }

            return true;
        });
    }, [effectiveStatusFilter, showIgnored, showOnlyMine]);

    return {
        statusFilter: effectiveStatusFilter, showIgnored, showOnlyMine, showPlaceholders,
        toggleStatus, setShowIgnored: setShowIgnoredPersist,
        setShowOnlyMine: setShowOnlyMinePersist,
        setShowPlaceholders: setShowPlaceholdersPersist,
        resetFilters, isFilterActive, applyFilters
    };
}
