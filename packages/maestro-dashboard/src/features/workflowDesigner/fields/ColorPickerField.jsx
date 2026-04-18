/**
 * Maestro Dashboard — ColorPickerField
 *
 * Szín swatch + natív color picker + hex input.
 */

import React, { useCallback } from 'react';

export default function ColorPickerField({ label, value, onChange }) {
    const handleColorInput = useCallback((e) => {
        onChange(e.target.value);
    }, [onChange]);

    const handleHexInput = useCallback((e) => {
        const hex = e.target.value;
        // Elfogadjuk, ha érvényes hex szín
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
            onChange(hex);
        }
    }, [onChange]);

    return (
        <div className="designer-field">
            {label && <label className="designer-field__label">{label}</label>}
            <div className="designer-field__color-row">
                <input
                    type="color"
                    value={value || '#888888'}
                    onChange={handleColorInput}
                    className="designer-field__color-swatch"
                />
                <input
                    type="text"
                    value={value || ''}
                    onChange={handleHexInput}
                    placeholder="#FFFFFF"
                    maxLength={7}
                    className="designer-field__input designer-field__input--mono"
                />
            </div>
        </div>
    );
}
