/**
 * Maestro Dashboard — Szűrő sáv
 *
 * Státusz checkboxok + Kimarad (3 oszlopban, fentről lefelé),
 * alatta: Csak a saját cikkeim + Helykitöltők mutatása.
 * Az InDesign plugin FilterBar struktúráját követi.
 */

import React, { useMemo } from 'react';
import { WORKFLOW_CONFIG } from '../config.js';

/** Státusz opciók (egyszer számítva) */
const statusOptions = Object.entries(WORKFLOW_CONFIG).map(([stateNum, config]) => ({
    key: `status-${stateNum}`,
    value: Number(stateNum),
    label: config.label,
    color: config.color || '#999'
}));

export default function FilterBar({
    isOpen, statusFilter, showIgnored, showOnlyMine, showPlaceholders,
    onToggleStatus, onSetShowIgnored, onSetShowOnlyMine, onSetShowPlaceholders,
    isFilterActive, onReset
}) {
    /** Összes szűrő opció: státuszok + Kimarad */
    const allItems = useMemo(() => {
        const items = [
            ...statusOptions.map(opt => ({
                key: opt.key,
                label: opt.label,
                color: opt.color,
                checked: statusFilter.has(opt.value),
                onChange: () => onToggleStatus(opt.value)
            })),
            {
                key: 'ignored',
                label: 'Kimarad',
                color: '#9E9E9E',
                checked: showIgnored,
                onChange: () => onSetShowIgnored(!showIgnored)
            }
        ];

        /** Oszlop-alapú sorrend: fentről lefelé, balról jobbra (3 oszlop) */
        const cols = 3;
        const rows = Math.ceil(items.length / cols);
        const reordered = [];
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const idx = col * rows + row;
                if (idx < items.length) reordered.push(items[idx]);
            }
        }
        return reordered;
    }, [statusFilter, showIgnored, onSetShowIgnored, onToggleStatus]);

    if (!isOpen) return null;

    return (
        <div className="filter-bar active">
            {/* Fejléc: törlés gomb (csak ha aktív szűrő van) */}
            {isFilterActive && (
                <div className="filter-header">
                    <button
                        type="button"
                        className="filter-reset-btn"
                        onClick={onReset}
                        title="Szűrők törlése"
                    >
                        <span className="filter-reset-icon">✕</span>
                        <span>Törlés</span>
                    </button>
                </div>
            )}

            {/* Checkbox rács — 3 oszlop, fentről lefelé */}
            <div className="filter-status-grid">
                {allItems.map(item => (
                    <label key={item.key} className="filter-checkbox">
                        <input
                            type="checkbox"
                            checked={item.checked}
                            onChange={item.onChange}
                        />
                        <span className="status-dot" style={{ backgroundColor: item.color }} />
                        {item.label}
                    </label>
                ))}
            </div>

            {/* Extra szűrők: Csak a saját cikkeim + Helykitöltők mutatása */}
            <div className="filter-extra">
                <label className="filter-checkbox">
                    <input
                        type="checkbox"
                        checked={showOnlyMine}
                        onChange={e => onSetShowOnlyMine(e.target.checked)}
                    />
                    Csak a saját cikkeim
                </label>
                <label className="filter-checkbox">
                    <input
                        type="checkbox"
                        checked={showPlaceholders}
                        onChange={e => onSetShowPlaceholders(e.target.checked)}
                    />
                    Helykitöltők mutatása
                </label>
            </div>
        </div>
    );
}
