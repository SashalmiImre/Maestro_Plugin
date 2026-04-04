/**
 * Maestro Dashboard — Validációs ikonok
 *
 * Közös komponens a validációs hiba/figyelmeztetés ikonok megjelenítéséhez.
 * Használja: ArticleRow (táblázat), PageSlot (layout nézet).
 */

import React from 'react';
import { VALIDATION_TYPES } from '../config.js';

/**
 * Validáció tooltip szöveg generálása.
 * @param {Array} items - Validációs elemek ({type, message, source})
 * @returns {string} Tooltip szöveg
 */
export function buildValidationTooltip(items) {
    return items.map(i => {
        const prefix = i.type === VALIDATION_TYPES.ERROR
            ? (i.source === 'user' ? '[Gond]' : '[Hiba]')
            : (i.source === 'user' ? '[Infó]' : '[Figy.]');
        return `${prefix} ${i.message}`;
    }).join('\n');
}

/**
 * Validációs ikonok (hiba: piros X kör, figyelmeztetés: narancssárga háromszög).
 * @param {Object} props
 * @param {Array} props.items - Validációs elemek ({type, message, source})
 * @param {string} [props.className] - Wrapper CSS osztály (alapértelmezett: 'validation-icons')
 * @param {number} [props.size] - SVG méret pixelben (alapértelmezett: 14)
 */
export default function ValidationIcons({ items, className = 'validation-icons', size = 14 }) {
    if (!items || items.length === 0) return null;

    const hasErrors = items.some(i => i.type === VALIDATION_TYPES.ERROR);
    const hasWarnings = items.some(i => i.type === VALIDATION_TYPES.WARNING);

    return (
        <div className={className} title={buildValidationTooltip(items)}>
            {hasErrors && (
                <svg width={size} height={size} viewBox="0 0 14 14">
                    <circle cx="7" cy="7" r="6" fill="#dc2626"/>
                    <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
            )}
            {hasWarnings && (
                <svg width={size} height={size} viewBox="0 0 14 14">
                    <path d="M7 1L13 13H1L7 1Z" fill="#ea950c"/>
                    <path d="M7 5.5v3" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                    <circle cx="7" cy="10.5" r="0.8" fill="white"/>
                </svg>
            )}
        </div>
    );
}
