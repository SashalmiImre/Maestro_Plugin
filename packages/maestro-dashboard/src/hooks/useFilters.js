/**
 * Maestro Dashboard — Szűrő hook
 *
 * Státusz, kimarad, saját cikkek szűrő — localStorage perzisztált.
 */

import { useState, useCallback, useMemo } from 'react';
import { WORKFLOW_CONFIG, MARKERS, TEAM_ARTICLE_FIELD, STORAGE_KEYS, resolveGrantedTeams } from '../config.js';

// ─── localStorage segédfüggvények ───────────────────────────────────────────

function loadStatusFilter() {
    try {
        const stored = localStorage.getItem(STORAGE_KEYS.FILTER_STATUS);
        if (stored) return new Set(JSON.parse(stored));
    } catch { /* fallback */ }
    return new Set(Object.keys(WORKFLOW_CONFIG).map(Number));
}

function loadBoolean(key, defaultValue) {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultValue;
    return stored === 'true';
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useFilters() {
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

    const toggleStatus = useCallback((state) => {
        setStatusFilter(prev => {
            const next = new Set(prev);
            if (next.has(state)) next.delete(state);
            else next.add(state);
            localStorage.setItem(STORAGE_KEYS.FILTER_STATUS, JSON.stringify([...next]));
            return next;
        });
    }, []);

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
        const allStates = new Set(Object.keys(WORKFLOW_CONFIG).map(Number));
        setStatusFilter(allStates);
        setShowIgnored(true);
        setShowOnlyMine(false);
        setShowPlaceholders(true);
        localStorage.setItem(STORAGE_KEYS.FILTER_STATUS, JSON.stringify([...allStates]));
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_IGNORED, 'true');
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE, 'false');
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS, 'true');
    }, []);

    const isFilterActive = useMemo(() => {
        if (statusFilter.size !== Object.keys(WORKFLOW_CONFIG).length) return true;
        if (!showIgnored) return true;
        if (showOnlyMine) return true;
        if (!showPlaceholders) return true;
        return false;
    }, [statusFilter, showIgnored, showOnlyMine, showPlaceholders]);

    /** Szűrés alkalmazása a cikkekre. */
    const applyFilters = useCallback((articles, user) => {
        return articles.filter(article => {
            // Státusz szűrő
            const state = article.state ?? 0;
            if (!statusFilter.has(state)) return false;

            // Kimarad szűrő
            const markers = typeof article.markers === 'number' ? article.markers : 0;
            const isIgnored = (markers & MARKERS.IGNORE) !== 0;
            if (!showIgnored && isIgnored) return false;

            // Csak saját cikkek
            if (showOnlyMine && user) {
                const userFields = getUserContributorFields(user);
                const isOwner = userFields.some(field => article[field] === user.$id);
                if (!isOwner) return false;
            }

            return true;
        });
    }, [statusFilter, showIgnored, showOnlyMine]);

    return {
        statusFilter, showIgnored, showOnlyMine, showPlaceholders,
        toggleStatus, setShowIgnored: setShowIgnoredPersist,
        setShowOnlyMine: setShowOnlyMinePersist,
        setShowPlaceholders: setShowPlaceholdersPersist,
        resetFilters, isFilterActive, applyFilters
    };
}

// ─── Segédfüggvény ──────────────────────────────────────────────────────────

function getUserContributorFields(user) {
    if (!user?.groupSlugs) return [];
    const fields = [];
    for (const slug of user.groupSlugs) {
        const field = TEAM_ARTICLE_FIELD[slug];
        if (field) fields.push(field);
    }
    // Capability label-ek feloldása csapat slug-okra
    if (user.labels) {
        const grantedTeams = resolveGrantedTeams(user.labels);
        for (const [slug, field] of Object.entries(TEAM_ARTICLE_FIELD)) {
            if (grantedTeams.has(slug) && !fields.includes(field)) {
                fields.push(field);
            }
        }
    }
    return fields;
}
