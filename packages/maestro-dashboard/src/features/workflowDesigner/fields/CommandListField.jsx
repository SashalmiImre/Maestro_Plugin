/**
 * Maestro Dashboard — CommandListField
 *
 * Parancs lista szerkesztő: hozzáadás dropdown + allowedGroups per parancs.
 * A COMMAND_REGISTRY-ből listázza az elérhető parancsokat.
 */

import React, { useCallback, useState } from 'react';
import { COMMAND_REGISTRY } from '@shared/commandRegistry.js';

const COMMAND_IDS = Object.keys(COMMAND_REGISTRY);

/**
 * @param {Object} props
 * @param {string} props.label - Mező címke
 * @param {Object[]} props.value - [{ id, allowedGroups }]
 * @param {string[]} props.availableGroups - Elérhető csoport slug-ok
 * @param {Function} props.onChange - (Object[]) => void
 */
export default function CommandListField({ label, value = [], availableGroups = [], onChange }) {
    const [addingId, setAddingId] = useState('');
    const usedIds = new Set(value.map(c => c.id));

    const handleAdd = useCallback(() => {
        if (!addingId || usedIds.has(addingId)) return;
        onChange([...value, { id: addingId, allowedGroups: [] }]);
        setAddingId('');
    }, [addingId, usedIds, value, onChange]);

    const handleRemove = useCallback((commandId) => {
        onChange(value.filter(c => c.id !== commandId));
    }, [value, onChange]);

    const handleGroupsChange = useCallback((commandId, groups) => {
        onChange(value.map(c => c.id === commandId ? { ...c, allowedGroups: groups } : c));
    }, [value, onChange]);

    // Elérhető parancsok az „Új parancs" dropdown-hoz (ami még nincs hozzáadva)
    const availableCommands = COMMAND_IDS.filter(id => !usedIds.has(id));

    const isEmpty = value.length === 0;

    return (
        <div className="designer-field">
            {label && <label className="designer-field__label">{label}</label>}

            {/* #71: empty state hint — egyértelműsíti, hogy lent a dropdown-ban
                lehet parancsot hozzáadni (ha nincs hozzáadott parancs még). */}
            {isEmpty && availableCommands.length > 0 && (
                <p className="designer-field__empty-hint">
                    Még nincs parancs hozzáadva. Válassz egyet lentről a hozzáadáshoz.
                </p>
            )}

            {/* Meglévő parancsok */}
            {value.map(cmd => (
                <div key={cmd.id} className="designer-field__command-item">
                    <div className="designer-field__command-header">
                        <span className="designer-field__command-name">
                            {COMMAND_REGISTRY[cmd.id]?.label || cmd.id}
                        </span>
                        <button
                            type="button"
                            className="designer-field__remove-btn"
                            onClick={() => handleRemove(cmd.id)}
                            title="Parancs eltávolítása"
                            aria-label={`${COMMAND_REGISTRY[cmd.id]?.label || cmd.id} parancs eltávolítása`}
                        >
                            <span aria-hidden="true">✕</span>
                        </button>
                    </div>
                    <div className="designer-field__chips">
                        {availableGroups.map(slug => (
                            <button
                                key={slug}
                                type="button"
                                className={`designer-chip designer-chip--small ${
                                    cmd.allowedGroups.includes(slug) ? 'designer-chip--active' : ''
                                }`}
                                onClick={() => {
                                    const next = cmd.allowedGroups.includes(slug)
                                        ? cmd.allowedGroups.filter(g => g !== slug)
                                        : [...cmd.allowedGroups, slug];
                                    handleGroupsChange(cmd.id, next);
                                }}
                            >
                                {slug}
                            </button>
                        ))}
                    </div>
                </div>
            ))}

            {/* Új parancs hozzáadás */}
            {availableCommands.length > 0 && (
                <div className="designer-field__add-row">
                    <select
                        value={addingId}
                        onChange={e => setAddingId(e.target.value)}
                        className="designer-field__select"
                    >
                        <option value="">Parancs kiválasztása...</option>
                        {availableCommands.map(id => (
                            <option key={id} value={id}>{COMMAND_REGISTRY[id].label}</option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="designer-field__add-btn"
                        onClick={handleAdd}
                        disabled={!addingId}
                        aria-label="Kiválasztott parancs hozzáadása"
                    >
                        <span aria-hidden="true">+</span>
                    </button>
                </div>
            )}
        </div>
    );
}
