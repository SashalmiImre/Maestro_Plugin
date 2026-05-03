/**
 * Maestro Dashboard — StatePropertiesEditor
 *
 * Kiválasztott state node tulajdonságainak szerkesztője.
 * Mezők: label, id, color, duration, isInitial, isTerminal,
 * validations, commands, statePermissions.
 */

import React, { useCallback, useState, useMemo } from 'react';
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
 * @param {boolean} [props.isReadOnly] - Olvasásra korlátozott mód — letiltja az interaktív vezérlőket
 */
export default function StatePropertiesEditor({ node, onDataChange, availableGroups, onDelete, isReadOnly = false }) {
    const { data } = node;
    // #64: minden szekció ZÁRVA alapból — szimmetria + a Mozgatási jogosultság
    // (kritikus policy) sem ragad „rejtett"-ben az aszimmetrikus default miatt.
    const [validationsOpen, setValidationsOpen] = useState(false);
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

    // #64: szekció trigger label-ek itemszám badge-dzsel — a user a panel megnyitása
    // nélkül lássa, hány elem van bent (alvó policy észrevétlenül nem maradhat).
    const validationsCount = useMemo(() => {
        const v = data.validations || {};
        return (v.onEntry?.length || 0)
            + (v.requiredToEnter?.length || 0)
            + (v.requiredToExit?.length || 0);
    }, [data.validations]);
    const commandsCount = (data.commands || []).length;
    const permissionsCount = (data.statePermissions || []).length;

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
                    disabled={isReadOnly}
                />
            </div>

            {/* Szín */}
            <ColorPickerField
                label="Szín"
                value={data.color}
                onChange={c => update('color', c)}
                disabled={isReadOnly}
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
                        disabled={isReadOnly}
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
                        disabled={isReadOnly}
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
                        disabled={isReadOnly}
                    />
                    Kezdőállapot
                </label>
                <label className="designer-field__checkbox-label">
                    <input
                        type="checkbox"
                        checked={data.isTerminal || false}
                        onChange={e => update('isTerminal', e.target.checked)}
                        disabled={isReadOnly}
                    />
                    Végállapot
                </label>
            </div>

            {/* ── Validációk (collapsible) ──────────────────────────────────── */}
            {/* #66: az „onEntry" akció (futtatás), a „requiredToEnter/Exit" kapu (ellenőrzés).
                A label prefix + tooltip a két szemantikát egyértelműsíti.
                #69: aria-expanded + aria-controls a screen reader-eknek. */}
            <div className="designer-collapsible">
                <button
                    type="button"
                    className="designer-collapsible__header"
                    onClick={() => setValidationsOpen(v => !v)}
                    aria-expanded={validationsOpen}
                    aria-controls={`state-validations-${node.id}`}
                >
                    <span>Validációk{validationsCount > 0 ? ` (${validationsCount})` : ''}</span>
                    <span className="designer-collapsible__chevron" aria-hidden="true">{validationsOpen ? '▾' : '▸'}</span>
                </button>
                {validationsOpen && (
                    <div className="designer-collapsible__body" id={`state-validations-${node.id}`}>
                        <ValidationListField
                            label="Akció: belépéskor futtatódik"
                            helpText="Az állapotba lépés pillanatában lefutó művelet (pl. preflight). Nem blokkolja a belépést."
                            value={data.validations?.onEntry || []}
                            onChange={v => updateValidation('onEntry', v)}
                            disabled={isReadOnly}
                        />
                        <ValidationListField
                            label="Ellenőrzés: belépés feltétele"
                            helpText="Az állapotba lépés ELŐTT futó kapu — ha bukik, az átmenet blokkolva."
                            value={data.validations?.requiredToEnter || []}
                            onChange={v => updateValidation('requiredToEnter', v)}
                            disabled={isReadOnly}
                        />
                        <ValidationListField
                            label="Ellenőrzés: kilépés feltétele"
                            helpText="Az állapotból kilépés ELŐTT futó kapu — ha bukik, az átmenet blokkolva."
                            value={data.validations?.requiredToExit || []}
                            onChange={v => updateValidation('requiredToExit', v)}
                            disabled={isReadOnly}
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
                    aria-expanded={commandsOpen}
                    aria-controls={`state-commands-${node.id}`}
                >
                    <span>Parancsok{commandsCount > 0 ? ` (${commandsCount})` : ''}</span>
                    <span className="designer-collapsible__chevron" aria-hidden="true">{commandsOpen ? '▾' : '▸'}</span>
                </button>
                {commandsOpen && (
                    <div className="designer-collapsible__body" id={`state-commands-${node.id}`}>
                        <CommandListField
                            value={data.commands || []}
                            availableGroups={availableGroups}
                            onChange={v => update('commands', v)}
                            disabled={isReadOnly}
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
                    aria-expanded={permissionsOpen}
                    aria-controls={`state-permissions-${node.id}`}
                >
                    <span>
                        Mozgatási jogosultság
                        {permissionsCount > 0 ? ` (${permissionsCount} csoport)` : ''}
                    </span>
                    <span className="designer-collapsible__chevron" aria-hidden="true">{permissionsOpen ? '▾' : '▸'}</span>
                </button>
                {permissionsOpen && (
                    <div className="designer-collapsible__body" id={`state-permissions-${node.id}`}>
                        <GroupMultiSelectField
                            label="Ki mozgathatja ki a cikket ebből az állapotból?"
                            value={data.statePermissions || []}
                            availableGroups={availableGroups}
                            onChange={v => update('statePermissions', v)}
                            disabled={isReadOnly}
                        />
                    </div>
                )}
            </div>

            {/* Törlés gomb — read-only módban letiltva (#A.4.6 follow-up). */}
            <div className="properties-editor__footer">
                <button
                    type="button"
                    className="danger-action danger-action--block"
                    onClick={onDelete}
                    disabled={isReadOnly}
                >
                    Állapot törlése
                </button>
            </div>
        </div>
    );
}
