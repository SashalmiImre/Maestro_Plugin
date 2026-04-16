/**
 * Maestro Dashboard — BreadcrumbDropdown
 *
 * Újrafelhasználható dropdown a breadcrumb fejléchez. Click-re nyílik,
 * outside click-re zárul. Felül opcionális „Beállítások" menüpont + divider,
 * alatta ABC rendezett opciók.
 *
 * Használat:
 *   <BreadcrumbDropdown
 *     label="Szervezet"
 *     activeId={activeOrgId}
 *     items={[{ id: '1', name: 'Org A' }, ...]}
 *     onSelect={setActiveOrg}
 *     onSettings={() => openOrgSettings()}
 *   />
 */

import React, { useState, useRef, useMemo, useCallback } from 'react';
import usePopoverClose from '../hooks/usePopoverClose.js';

/**
 * @param {Object} props
 * @param {string} props.label — dropdown címke (ha nincs aktív elem)
 * @param {string} [props.activeId] — aktuálisan kiválasztott elem ID
 * @param {{ id: string, name: string }[]} props.items — kiválasztható elemek
 * @param {Function} props.onSelect — callback: (id) => void
 * @param {Function} [props.onSettings] — ha megadott, „Beállítások" menüpont jelenik meg
 * @param {string} [props.settingsLabel='Beállítások'] — beállítás menüpont szövege
 * @param {boolean} [props.disabled=false] — letiltva-e
 * @param {string} [props.className] — extra CSS osztály a trigger gombra
 */
export default function BreadcrumbDropdown({
    label,
    activeId,
    items,
    onSelect,
    onSettings,
    settingsLabel = 'Beállítások',
    disabled = false,
    className = ''
}) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef(null);

    const close = useCallback(() => setIsOpen(false), []);
    usePopoverClose(containerRef, isOpen, close);

    const activeName = useMemo(
        () => items.find(i => i.id === activeId)?.name,
        [items, activeId]
    );

    const sortedItems = useMemo(
        () => items
            .filter(item => item.id !== activeId)
            .sort((a, b) => a.name.localeCompare(b.name, 'hu')),
        [items, activeId]
    );

    // Csak 1 elem + nincs settings → nem kell dropdown, statikus címke
    const isStatic = items.length <= 1 && !onSettings;

    function handleToggle() {
        if (!disabled && !isStatic) setIsOpen(prev => !prev);
    }

    function handleSelect(id) {
        setIsOpen(false);
        onSelect(id);
    }

    function handleSettings() {
        setIsOpen(false);
        onSettings();
    }

    return (
        <div className="bc-dropdown" ref={containerRef}>
            <button
                type="button"
                className={`bc-dropdown-trigger ${isOpen ? 'open' : ''} ${isStatic ? 'static' : ''} ${className}`}
                onClick={handleToggle}
                disabled={disabled}
                aria-haspopup={!isStatic ? 'listbox' : undefined}
                aria-expanded={isOpen}
            >
                <span className="bc-dropdown-label">
                    {activeName || label}
                </span>
                {!isStatic && (
                    <span className="bc-dropdown-chevron" aria-hidden="true">
                        {isOpen ? '▴' : '▾'}
                    </span>
                )}
            </button>

            {isOpen && (
                <div className="bc-dropdown-menu" role="listbox">
                    {onSettings && (
                        <>
                            <button
                                type="button"
                                className="bc-dropdown-item"
                                onClick={handleSettings}
                            >
                                {settingsLabel}
                            </button>
                            {sortedItems.length > 0 && <div className="bc-dropdown-divider" />}
                        </>
                    )}
                    {sortedItems.map(item => (
                        <button
                            key={item.id}
                            type="button"
                            className="bc-dropdown-item"
                            role="option"
                            onClick={() => handleSelect(item.id)}
                        >
                            {item.name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
