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
 * @param {Object<string,string>} [props.stateLabels] - State slug → human label map (#65)
 * @param {boolean} [props.isReadOnly] - Olvasásra korlátozott mód — letiltja az interaktív vezérlőket
 */
export default function TransitionPropertiesEditor({ edge, onDataChange, availableGroups, onDelete, stateLabels, isReadOnly = false }) {
    const { data } = edge;

    const update = useCallback((key, value) => {
        onDataChange({ ...data, [key]: value });
    }, [data, onDataChange]);

    // #65: az „Útvonal" elsősorban a human label-t mutassa, slug másodlagos.
    // Ha a label === slug (új state, vagy nincs még átnevezve), csak a slug-ot
    // mutatjuk — duplikáció elkerülésére.
    const sourceLabel = stateLabels?.[edge.source] || edge.source;
    const targetLabel = stateLabels?.[edge.target] || edge.target;
    const showSourceSlug = sourceLabel !== edge.source;
    const showTargetSlug = targetLabel !== edge.target;

    return (
        <div className="properties-editor">
            <h3 className="properties-editor__title">Átmenet tulajdonságok</h3>

            {/* Irány (from → to) kijelzés — human label + slug másodlagos (#65) */}
            <div className="designer-field">
                <label className="designer-field__label">Útvonal</label>
                <div className="designer-field__route designer-field__route--stacked">
                    <div className="designer-field__route-cell">
                        <div className="designer-field__route-label">{sourceLabel}</div>
                        {showSourceSlug && (
                            <div className="designer-field__route-slug">{edge.source}</div>
                        )}
                    </div>
                    <span className="designer-field__route-arrow" aria-hidden="true">→</span>
                    <div className="designer-field__route-cell">
                        <div className="designer-field__route-label">{targetLabel}</div>
                        {showTargetSlug && (
                            <div className="designer-field__route-slug">{edge.target}</div>
                        )}
                    </div>
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
                    disabled={isReadOnly}
                />
            </div>

            {/* Direction — #72: natív <select> helyett chip-csoport (single-select),
                hogy a designer többi mezőjének chip-stílusához illeszkedjen
                (rendszerfüggő select widget eltérő platformokon zavaró). */}
            <div className="designer-field">
                <label className="designer-field__label" id={`transition-direction-${edge.id}`}>Irány</label>
                <div
                    className="designer-field__chips"
                    role="radiogroup"
                    aria-labelledby={`transition-direction-${edge.id}`}
                >
                    {DIRECTIONS.map(d => {
                        const isActive = (data.direction || 'forward') === d.value;
                        return (
                            <button
                                key={d.value}
                                type="button"
                                role="radio"
                                aria-checked={isActive}
                                className={`designer-chip ${isActive ? 'designer-chip--active' : ''}`}
                                onClick={() => update('direction', d.value)}
                                disabled={isReadOnly}
                            >
                                {d.label}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Allowed Groups */}
            <GroupMultiSelectField
                label="Engedélyezett csoportok"
                value={data.allowedGroups || []}
                availableGroups={availableGroups}
                onChange={v => update('allowedGroups', v)}
                disabled={isReadOnly}
            />

            {/* Törlés gomb — read-only módban letiltva (#A.4.6 follow-up). */}
            <div className="properties-editor__footer">
                <button
                    type="button"
                    className="danger-action danger-action--block"
                    onClick={onDelete}
                    disabled={isReadOnly}
                >
                    Átmenet törlése
                </button>
            </div>
        </div>
    );
}
