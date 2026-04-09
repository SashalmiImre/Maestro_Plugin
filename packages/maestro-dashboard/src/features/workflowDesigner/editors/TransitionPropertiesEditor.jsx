/**
 * Maestro Dashboard — TransitionPropertiesEditor
 *
 * Kiválasztott transition edge tulajdonságainak szerkesztője.
 * Mezők: label, direction, allowedGroups.
 */

import React, { useCallback } from 'react';
import GroupMultiSelectField from '../fields/GroupMultiSelectField.jsx';

const DIRECTIONS = [
    { value: 'forward',  label: 'Előre (→)' },
    { value: 'backward', label: 'Vissza (←)' },
    { value: 'reset',    label: 'Reset (↩)' }
];

/**
 * @param {Object} props
 * @param {Object} props.edge - Az xyflow edge
 * @param {Function} props.onDataChange - (newData) => void
 * @param {string[]} props.availableGroups - Elérhető csoport slug-ok
 * @param {Function} props.onDelete - Edge törlés callback
 */
export default function TransitionPropertiesEditor({ edge, onDataChange, availableGroups, onDelete }) {
    const { data } = edge;

    const update = useCallback((key, value) => {
        onDataChange({ ...data, [key]: value });
    }, [data, onDataChange]);

    return (
        <div className="properties-editor">
            <h3 className="properties-editor__title">Átmenet tulajdonságok</h3>

            {/* Irány (from → to) kijelzés */}
            <div className="designer-field">
                <label className="designer-field__label">Útvonal</label>
                <div className="designer-field__route">
                    <span className="designer-field__route-state">{edge.source}</span>
                    <span className="designer-field__route-arrow">→</span>
                    <span className="designer-field__route-state">{edge.target}</span>
                </div>
            </div>

            {/* Label */}
            <div className="designer-field">
                <label className="designer-field__label">Gomb felirat</label>
                <input
                    type="text"
                    className="designer-field__input"
                    value={data.label || ''}
                    onChange={e => update('label', e.target.value)}
                    placeholder="Átmenet neve (gomb felirat)"
                />
            </div>

            {/* Direction */}
            <div className="designer-field">
                <label className="designer-field__label">Irány</label>
                <select
                    className="designer-field__select"
                    value={data.direction || 'forward'}
                    onChange={e => update('direction', e.target.value)}
                >
                    {DIRECTIONS.map(d => (
                        <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                </select>
            </div>

            {/* Allowed Groups */}
            <GroupMultiSelectField
                label="Engedélyezett csoportok"
                value={data.allowedGroups || []}
                availableGroups={availableGroups}
                onChange={v => update('allowedGroups', v)}
            />

            {/* Törlés gomb */}
            <div className="properties-editor__footer">
                <button
                    type="button"
                    className="designer-field__delete-btn"
                    onClick={onDelete}
                >
                    Átmenet törlése
                </button>
            </div>
        </div>
    );
}
