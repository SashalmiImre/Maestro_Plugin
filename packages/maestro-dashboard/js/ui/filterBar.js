/**
 * Maestro Dashboard — Szűrő sáv
 *
 * Státusz checkboxok, kimarad szűrő, csak saját cikkek.
 */

import { getArticles } from '../data.js';
import { getCurrentUser } from '../auth.js';
import { WORKFLOW_STATES, WORKFLOW_CONFIG, MARKERS, TEAM_ARTICLE_FIELD, STORAGE_KEYS } from '../config.js';
import { escapeHtml } from './components.js';

// ─── Szűrő állapot ─────────────────────────────────────────────────────────

/** Bekapcsolt állapotok (alapértelmezetten mind) */
let statusFilter = loadStatusFilter();
let showIgnored = loadBoolean(STORAGE_KEYS.FILTER_SHOW_IGNORED, true);
let showOnlyMine = loadBoolean(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE, false);

let onFilterChangeCallback = null;

// ─── Inicializálás ──────────────────────────────────────────────────────────

/**
 * Inicializálja a szűrő sávot.
 * @param {Function} onFilterChange — Callback szűrő változáskor.
 */
export function initFilterBar(onFilterChange) {
    onFilterChangeCallback = onFilterChange;
    renderFilterBar();

    // Toggle gomb
    const toggleBtn = document.getElementById('filter-toggle-btn');
    const filterBar = document.getElementById('filter-bar');
    if (toggleBtn && filterBar) {
        toggleBtn.addEventListener('click', () => {
            const isActive = filterBar.classList.toggle('active');
            toggleBtn.classList.toggle('active', isActive);
        });
    }
}

// ─── Renderelés ─────────────────────────────────────────────────────────────

function renderFilterBar() {
    const container = document.getElementById('filter-bar');
    if (!container) return;

    // Státuszok oszlopos sorrendben (felülről lefelé, 3 oszlopban)
    const states = Object.entries(WORKFLOW_CONFIG);
    const colCount = 3;
    const perCol = Math.ceil(states.length / colCount);
    const ordered = [];
    for (let col = 0; col < colCount; col++) {
        for (let row = 0; row < perCol; row++) {
            const idx = col * perCol + row;
            if (idx < states.length) ordered.push(states[idx]);
        }
    }

    container.innerHTML = `
        <div class="filter-status-grid">
            ${ordered.map(([stateNum, config]) => {
                const checked = statusFilter.has(Number(stateNum)) ? 'checked' : '';
                return `<label class="filter-checkbox">
                    <input type="checkbox" data-state="${stateNum}" ${checked}>
                    <span class="status-dot" style="background-color: ${config.color}"></span>
                    ${escapeHtml(config.label)}
                </label>`;
            }).join('')}
        </div>
        <div class="filter-extra">
            <label class="filter-checkbox">
                <input type="checkbox" id="filter-ignored" ${showIgnored ? 'checked' : ''}>
                Kimarad
            </label>
            <label class="filter-checkbox">
                <input type="checkbox" id="filter-only-mine" ${showOnlyMine ? 'checked' : ''}>
                Csak a saját cikkeim
            </label>
            <button class="filter-reset-btn" id="filter-reset-btn">Visszaállítás</button>
        </div>
    `;

    // Eseménykezelők
    container.querySelectorAll('input[data-state]').forEach(input => {
        input.addEventListener('change', () => {
            const state = Number(input.dataset.state);
            if (input.checked) statusFilter.add(state);
            else statusFilter.delete(state);
            saveStatusFilter();
            notifyChange();
        });
    });

    const ignoredCheckbox = document.getElementById('filter-ignored');
    if (ignoredCheckbox) {
        ignoredCheckbox.addEventListener('change', () => {
            showIgnored = ignoredCheckbox.checked;
            localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_IGNORED, String(showIgnored));
            notifyChange();
        });
    }

    const onlyMineCheckbox = document.getElementById('filter-only-mine');
    if (onlyMineCheckbox) {
        onlyMineCheckbox.addEventListener('change', () => {
            showOnlyMine = onlyMineCheckbox.checked;
            localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE, String(showOnlyMine));
            notifyChange();
        });
    }

    const resetBtn = document.getElementById('filter-reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', resetFilters);
    }
}

// ─── Szűrés alkalmazása ─────────────────────────────────────────────────────

/**
 * Alkalmazza a szűrőket a cikkekre.
 * @returns {Array} Szűrt cikk tömb.
 */
export function applyFilters() {
    const articles = getArticles();
    const user = getCurrentUser();

    return articles.filter(article => {
        // Státusz szűrő
        const state = article.state ?? 0;
        if (!statusFilter.has(state)) return false;

        // Kimarad szűrő
        const isIgnored = (article.markers & MARKERS.IGNORE) !== 0;
        if (!showIgnored && isIgnored) return false;

        // Csak saját cikkek
        if (showOnlyMine && user) {
            const userFields = getUserContributorFields(user);
            const isOwner = userFields.some(field => article[field] === user.$id);
            if (!isOwner) return false;
        }

        return true;
    });
}

/**
 * Visszaadja, hogy a szűrők aktívak-e (nem alapértelmezett állapot).
 */
export function isFilterActive() {
    if (statusFilter.size !== Object.keys(WORKFLOW_CONFIG).length) return true;
    if (!showIgnored) return true;
    if (showOnlyMine) return true;
    return false;
}

// ─── Szűrő visszaállítás ───────────────────────────────────────────────────

function resetFilters() {
    statusFilter = new Set(Object.keys(WORKFLOW_CONFIG).map(Number));
    showIgnored = true;
    showOnlyMine = false;
    saveStatusFilter();
    localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_IGNORED, 'true');
    localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE, 'false');
    renderFilterBar();
    notifyChange();
}

// ─── Segédfüggvények ────────────────────────────────────────────────────────

function getUserContributorFields(user) {
    if (!user?.teamIds) return [];
    const fields = [];
    for (const teamId of user.teamIds) {
        const field = TEAM_ARTICLE_FIELD[teamId];
        if (field) fields.push(field);
    }
    // Label override: label-ből is leképezzük
    if (user.labels) {
        for (const [slug, field] of Object.entries(TEAM_ARTICLE_FIELD)) {
            const normalizedSlug = slug.replace(/_/g, '').toLowerCase();
            if (user.labels.some(l => l.replace(/_/g, '').toLowerCase() === normalizedSlug)) {
                if (!fields.includes(field)) fields.push(field);
            }
        }
    }
    return fields;
}

function notifyChange() {
    if (onFilterChangeCallback) onFilterChangeCallback();

    // Szűrő gomb vizuális jelzés
    const toggleBtn = document.getElementById('filter-toggle-btn');
    if (toggleBtn) {
        toggleBtn.style.color = isFilterActive() ? '#3b82f6' : '';
        toggleBtn.style.borderColor = isFilterActive() ? '#3b82f6' : '';
    }
}

// ─── localStorage ───────────────────────────────────────────────────────────

function loadStatusFilter() {
    try {
        const stored = localStorage.getItem(STORAGE_KEYS.FILTER_STATUS);
        if (stored) return new Set(JSON.parse(stored));
    } catch { /* fallback */ }
    return new Set(Object.keys(WORKFLOW_CONFIG).map(Number));
}

function saveStatusFilter() {
    localStorage.setItem(STORAGE_KEYS.FILTER_STATUS, JSON.stringify([...statusFilter]));
}

function loadBoolean(key, defaultValue) {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultValue;
    return stored === 'true';
}
