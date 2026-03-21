/**
 * Maestro Dashboard — Szűrő sáv
 *
 * Státusz checkboxok, kimarad szűrő, csak saját cikkek.
 */

import React, { useMemo } from 'react';
import { WORKFLOW_CONFIG } from '../config.js';

export default function FilterBar({
    isOpen, statusFilter, showIgnored, showOnlyMine,
    onToggleStatus, onSetShowIgnored, onSetShowOnlyMine, onReset
}) {
    // Státuszok oszlopos sorrendben (felülről lefelé, 3 oszlopban)
    const orderedStates = useMemo(() => {
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
        return ordered;
    }, []);

    if (!isOpen) return null;

    return (
        <div className="filter-bar active">
            <div className="filter-status-grid">
                {orderedStates.map(([stateNum, config]) => (
                    <label key={stateNum} className="filter-checkbox">
                        <input
                            type="checkbox"
                            checked={statusFilter.has(Number(stateNum))}
                            onChange={() => onToggleStatus(Number(stateNum))}
                        />
                        <span className="status-dot" style={{ backgroundColor: config.color }} />
                        {config.label}
                    </label>
                ))}
            </div>
            <div className="filter-extra">
                <label className="filter-checkbox">
                    <input
                        type="checkbox"
                        checked={showIgnored}
                        onChange={e => onSetShowIgnored(e.target.checked)}
                    />
                    Kimarad
                </label>
                <label className="filter-checkbox">
                    <input
                        type="checkbox"
                        checked={showOnlyMine}
                        onChange={e => onSetShowOnlyMine(e.target.checked)}
                    />
                    Csak a saját cikkeim
                </label>
                <button className="filter-reset-btn" onClick={onReset}>
                    Visszaállítás
                </button>
            </div>
        </div>
    );
}
