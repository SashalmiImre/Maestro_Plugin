/**
 * Maestro Dashboard — StatePropertiesEditor
 *
 * Kiválasztott state node tulajdonságainak szerkesztője.
 * Mezők: label, id, color, duration, isInitial, isTerminal,
 * validations, commands, statePermissions.
 */

import React, { useCallback, useState } from 'react';
import ColorPickerField from '../fields/ColorPickerField.jsx';
import GroupMultiSelectField from '../fields/GroupMultiSelectField.jsx';
import ValidationListField from '../fields/ValidationListField.jsx';
import CommandListField from '../fields/CommandListField.jsx';

/**
 * @param {Object} props
 * @param {Object} props.node - Az xyflow node
 * @param {Function} props.onDataChange - (newData) => void
 * @param {string[]} props.availableGroups - Elérhető csoport slug-ok
 * @param {Function} props.onDelete - Node törlés callback
 */
export default function StatePropertiesEditor({ node, onDataChange, availableGroups, onDelete }) {
    const { data } = node;
    const [validationsOpen, setValidationsOpen] = useState(true);
    const [commandsOpen, setCommandsOpen] = useState(false);
    const [permissionsOpen, setPermissionsOpen] = useState(false);

    const update = useCallback((key, value) => {
        onDataChange({ ...data, [key]: value });
    }, [data, onDataChange]);

    const updateValidation = useCallback((listKey, value) => {
        onDataChange({
            ...data,
            validations: { ...data.validations, [listKey]: value }
        });
    }, [data, onDataChange]);

    return (
        <div className="properties-editor">
            <h3 className="properties-editor__title">Állapot tulajdonságok</h3>

            {/* Azonosító (slug) */}
            <div className="designer-field">
                <label className="designer-field__label">Azonosító (slug)</label>
                <input
                    type="text"
                    className="designer-field__input designer-field__input--mono"
                    value={node.id}
                    readOnly
                    title="Az állapot ID nem módosítható, ha már van rá hivatkozó cikk"
                />
            </div>

            {/* Címke */}
            <div className="designer-field">
                <label className="designer-field__label">Címke</label>
                <input
                    type="text"
                    className="designer-field__input"
                    value={data.label || ''}
                    onChange={e => update('label', e.target.value)}
                    placeholder="Állapot neve"
                />
            </div>

            {/* Szín */}
            <ColorPickerField
                label="Szín"
                value={data.color}
                onChange={c => update('color', c)}
            />

            {/* Duration */}
            <div className="designer-field__row">
                <div className="designer-field">
                    <label className="designer-field__label">Perc/oldal</label>
                    <input
                        type="number"
                        className="designer-field__input"
                        value={data.duration?.perPage ?? 0}
                        min={0}
                        onChange={e => update('duration', {
                            ...data.duration,
                            perPage: parseInt(e.target.value) || 0
                        })}
                    />
                </div>
                <div className="designer-field">
                    <label className="designer-field__label">Fix perc</label>
                    <input
                        type="number"
                        className="designer-field__input"
                        value={data.duration?.fixed ?? 0}
                        min={0}
                        onChange={e => update('duration', {
                            ...data.duration,
                            fixed: parseInt(e.target.value) || 0
                        })}
                    />
                </div>
            </div>

            {/* Típus jelölők */}
            <div className="designer-field__row">
                <label className="designer-field__checkbox-label">
                    <input
                        type="checkbox"
                        checked={data.isInitial || false}
                        onChange={e => update('isInitial', e.target.checked)}
                    />
                    Kezdőállapot
                </label>
                <label className="designer-field__checkbox-label">
                    <input
                        type="checkbox"
                        checked={data.isTerminal || false}
                        onChange={e => update('isTerminal', e.target.checked)}
                    />
                    Végállapot
                </label>
            </div>

            {/* ── Validációk (collapsible) ──────────────────────────────────── */}
            <div className="designer-collapsible">
                <button
                    type="button"
                    className="designer-collapsible__header"
                    onClick={() => setValidationsOpen(v => !v)}
                >
                    <span>Validációk</span>
                    <span className="designer-collapsible__chevron">{validationsOpen ? '▾' : '▸'}</span>
                </button>
                {validationsOpen && (
                    <div className="designer-collapsible__body">
                        <ValidationListField
                            label="Belépéskor futtatandó"
                            value={data.validations?.onEntry || []}
                            onChange={v => updateValidation('onEntry', v)}
                        />
                        <ValidationListField
                            label="Belépés feltétele"
                            value={data.validations?.requiredToEnter || []}
                            onChange={v => updateValidation('requiredToEnter', v)}
                        />
                        <ValidationListField
                            label="Kilépés feltétele"
                            value={data.validations?.requiredToExit || []}
                            onChange={v => updateValidation('requiredToExit', v)}
                        />
                    </div>
                )}
            </div>

            {/* ── Parancsok (collapsible) ───────────────────────────────────── */}
            <div className="designer-collapsible">
                <button
                    type="button"
                    className="designer-collapsible__header"
                    onClick={() => setCommandsOpen(v => !v)}
                >
                    <span>Parancsok</span>
                    <span className="designer-collapsible__chevron">{commandsOpen ? '▾' : '▸'}</span>
                </button>
                {commandsOpen && (
                    <div className="designer-collapsible__body">
                        <CommandListField
                            value={data.commands || []}
                            availableGroups={availableGroups}
                            onChange={v => update('commands', v)}
                        />
                    </div>
                )}
            </div>

            {/* ── State permissions (collapsible) ──────────────────────────── */}
            <div className="designer-collapsible">
                <button
                    type="button"
                    className="designer-collapsible__header"
                    onClick={() => setPermissionsOpen(v => !v)}
                >
                    <span>Mozgatási jogosultság</span>
                    <span className="designer-collapsible__chevron">{permissionsOpen ? '▾' : '▸'}</span>
                </button>
                {permissionsOpen && (
                    <div className="designer-collapsible__body">
                        <GroupMultiSelectField
                            label="Ki mozgathatja ki a cikket ebből az állapotból?"
                            value={data.statePermissions || []}
                            availableGroups={availableGroups}
                            onChange={v => update('statePermissions', v)}
                        />
                    </div>
                )}
            </div>

            {/* Törlés gomb */}
            <div className="properties-editor__footer">
                <button
                    type="button"
                    className="designer-field__delete-btn"
                    onClick={onDelete}
                >
                    Állapot törlése
                </button>
            </div>
        </div>
    );
}
