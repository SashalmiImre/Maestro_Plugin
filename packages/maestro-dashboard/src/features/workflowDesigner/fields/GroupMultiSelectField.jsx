/**
 * Maestro Dashboard — GroupMultiSelectField
 *
 * Csoport slug multi-select chip komponens.
 * Használja: statePermissions, allowedGroups, leaderGroups szerkesztése.
 */

import React, { useCallback } from 'react';

/**
 * @param {Object} props
 * @param {string} props.label - Mező címke
 * @param {string[]} props.value - Kiválasztott slug-ok
 * @param {string[]} props.availableGroups - Elérhető csoport slug-ok
 * @param {Function} props.onChange - (string[]) => void
 */
export default function GroupMultiSelectField({ label, value = [], availableGroups = [], onChange }) {
    const selected = new Set(value);

    const handleToggle = useCallback((slug) => {
        const next = new Set(value);
        if (next.has(slug)) next.delete(slug);
        else next.add(slug);
        onChange([...next]);
    }, [value, onChange]);

    const isEmpty = value.length === 0;

    return (
        <div className="designer-field">
            {label && <label className="designer-field__label">{label}</label>}
            {/* #71: empty state hint — a chip-grid kontextust ad, a hint
                explicit használati útmutató („kattints a hozzáadáshoz"). */}
            {isEmpty && availableGroups.length > 0 && (
                <p className="designer-field__empty-hint">
                    Kattints egy csoportra a hozzáadáshoz.
                </p>
            )}
            <div className="designer-field__chips">
                {availableGroups.map(slug => (
                    <button
                        key={slug}
                        type="button"
                        className={`designer-chip ${selected.has(slug) ? 'designer-chip--active' : ''}`}
                        onClick={() => handleToggle(slug)}
                    >
                        {slug}
                    </button>
                ))}
                {availableGroups.length === 0 && (
                    <span className="designer-field__empty">Nincsenek elérhető csoportok</span>
                )}
            </div>
        </div>
    );
}
