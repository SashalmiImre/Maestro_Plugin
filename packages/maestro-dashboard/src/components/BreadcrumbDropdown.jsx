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

import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import usePopoverClose from '../hooks/usePopoverClose.js';

/**
 * @param {Object} props
 * @param {string} props.label — dropdown címke (ha nincs aktív elem)
 * @param {string} [props.activeId] — aktuálisan kiválasztott elem ID
 * @param {{ id: string, name: string }[]} props.items — kiválasztható elemek
 * @param {Function} props.onSelect — callback: (id) => void
 * @param {Function} [props.onSettings] — ha megadott, „Beállítások" menüpont jelenik meg
 * @param {string} [props.settingsLabel='Beállítások'] — beállítás menüpont szövege
 * @param {string} [props.moreItemsLabel] — kis-kapitális szekciófejléc a divider alatt
 *                                          (pl. „További szervezetek"). Csak ha van
 *                                          onSettings ÉS van legalább egy további elem.
 * @param {boolean} [props.disabled=false] — letiltva-e
 * @param {string} [props.disabledTitle] — tooltip, ha disabled (pl. üres scope magyarázata)
 * @param {string} [props.className] — extra CSS osztály a trigger gombra
 * @param {React.ReactNode} [props.labelSuffix] — opcionális kiegészítő a trigger
 *        címke mellett (pl. halvány „alapértelmezett"). Csak a triggerben
 *        látszik, a menü-listában NEM jelenik meg.
 */
export default function BreadcrumbDropdown({
    label,
    activeId,
    items,
    onSelect,
    onSettings,
    settingsLabel = 'Beállítások',
    moreItemsLabel,
    disabled = false,
    disabledTitle,
    className = '',
    labelSuffix
}) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef(null);

    const close = useCallback(() => setIsOpen(false), []);
    usePopoverClose(containerRef, isOpen, close);

    // Ha `disabled` menet közben billen true-ra (pl. scope-váltás közben a menü
    // nyitva van), a menüt explicit zárjuk — különben a `disabled` vissza-flip-jén
    // a menü stale-open állapotban újra megjelenne user-akció nélkül.
    useEffect(() => {
        if (disabled) setIsOpen(false);
    }, [disabled]);

    // Disabled csak az interakciókat blokkolja (handleToggle korai visszatérés,
    // menü nem renderelődik) — a vizuális állapot (aktív név, suffix) megmarad,
    // hogy a user tudja melyik scope-on van. A `disabledTitle` tooltip magyarázza a blokkolás okát.
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
    // Csak 1 elem + van settings → dropdown helyett közvetlen settings modal
    const isDirectSettings = items.length <= 1 && !!onSettings;

    function handleToggle() {
        if (disabled || isStatic) return;
        if (isDirectSettings) {
            onSettings();
            return;
        }
        setIsOpen(prev => !prev);
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
                className={`bc-dropdown-trigger ${isOpen ? 'open' : ''} ${isStatic || isDirectSettings ? 'static' : ''} ${disabled ? 'disabled' : ''} ${className}`}
                onClick={handleToggle}
                aria-disabled={disabled || undefined}
                tabIndex={disabled ? -1 : undefined}
                title={disabled ? disabledTitle : (isDirectSettings ? settingsLabel : undefined)}
                aria-haspopup={isDirectSettings ? 'dialog' : (!isStatic ? 'listbox' : undefined)}
                aria-expanded={isOpen || undefined}
                aria-label={
                    isDirectSettings
                        ? `${activeName || label} — ${settingsLabel}`
                        : (activeName ? `${label}: ${activeName}` : `${label} választó`)
                }
            >
                <span className="bc-dropdown-label">
                    {activeName || label}
                </span>
                {labelSuffix && (
                    <span className="bc-dropdown-label-suffix" aria-hidden="true">
                        {labelSuffix}
                    </span>
                )}
                {!isStatic && !isDirectSettings && !disabled && (
                    <span className="bc-dropdown-chevron" aria-hidden="true">
                        {isOpen ? '▴' : '▾'}
                    </span>
                )}
            </button>

            {isOpen && !disabled && (
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
                            {sortedItems.length > 0 && moreItemsLabel && (
                                <div className="bc-dropdown-section-label">
                                    {moreItemsLabel}
                                </div>
                            )}
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
