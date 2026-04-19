/**
 * Maestro Dashboard — ValidationListField
 *
 * Validátor multi-select chip lista (onEntry, requiredToEnter, requiredToExit).
 * A VALIDATOR_REGISTRY-ből listázza az elérhető validátorokat.
 */

import React, { useCallback } from 'react';
import { VALIDATOR_REGISTRY } from '@shared/validatorRegistry.js';

const VALIDATOR_IDS = Object.keys(VALIDATOR_REGISTRY);

/**
 * Validátor ID kinyerése (string vagy { validator, options } objektum).
 */
function getValidatorId(v) {
    return typeof v === 'string' ? v : v?.validator;
}

/**
 * @param {Object} props
 * @param {string} props.label - Mező címke
 * @param {string} [props.helpText] - Magyarázó szöveg a label alatt (#66)
 * @param {Array} props.value - Kiválasztott validátorok (string[] vagy object[])
 * @param {Function} props.onChange - (Array) => void
 */
export default function ValidationListField({ label, helpText, value = [], onChange }) {
    const selectedIds = new Set(value.map(getValidatorId));

    const handleToggle = useCallback((validatorId) => {
        if (selectedIds.has(validatorId)) {
            // Eltávolítás — megtartjuk az eredeti objektumot a többi elemben
            onChange(value.filter(v => getValidatorId(v) !== validatorId));
        } else {
            // Hozzáadás — string formában (options nélkül)
            // Ha a felhasználó korábban options-szel rendelkező validátort
            // kapcsol vissza, az options elvész (ez elfogadható, mert
            // az options szerkesztése még nincs implementálva a UI-ban)
            onChange([...value, validatorId]);
        }
    }, [value, selectedIds, onChange]);

    return (
        <div className="designer-field">
            {label && <label className="designer-field__label">{label}</label>}
            {helpText && <p className="designer-field__help">{helpText}</p>}
            <div className="designer-field__chips">
                {VALIDATOR_IDS.map(id => (
                    <button
                        key={id}
                        type="button"
                        className={`designer-chip ${selectedIds.has(id) ? 'designer-chip--active' : ''}`}
                        onClick={() => handleToggle(id)}
                        title={VALIDATOR_REGISTRY[id].description}
                    >
                        {VALIDATOR_REGISTRY[id].label}
                    </button>
                ))}
            </div>
        </div>
    );
}
