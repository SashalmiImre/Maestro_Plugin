/**
 * Maestro Dashboard — UserAvatar
 *
 * Kör alakú 2 betűs monogram a felhasználó nevéből. Kattintásra
 * dropdown menü jelenik meg (Beállítások, Kijelentkezés).
 */

import React, { useState, useRef, useCallback } from 'react';
import usePopoverClose from '../hooks/usePopoverClose.js';

/**
 * Monogram generálás: vezetéknév + keresztnév kezdőbetűi,
 * vagy az első 2 betű ha nincs szóköz (pl. email).
 */
function getInitials(name) {
    if (!name) return '??';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
}

/**
 * @param {Object} props
 * @param {string} props.name — felhasználó neve (vagy email)
 * @param {{ label: string, onClick: Function, danger?: boolean }[]} props.menuItems — menü elemek
 */
export default function UserAvatar({ name, menuItems }) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef(null);

    const initials = getInitials(name);

    const close = useCallback(() => setIsOpen(false), []);
    usePopoverClose(containerRef, isOpen, close);

    function handleItemClick(item) {
        setIsOpen(false);
        item.onClick();
    }

    return (
        <div className="user-avatar-container" ref={containerRef}>
            <button
                type="button"
                className={`user-avatar ${isOpen ? 'open' : ''}`}
                onClick={() => setIsOpen(prev => !prev)}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                title={name}
            >
                {initials}
            </button>

            {isOpen && (
                <div className="user-avatar-menu" role="menu">
                    <div className="user-avatar-name">{name}</div>
                    <div className="popup-divider" />
                    {menuItems.map((item) => (
                        <button
                            key={item.label}
                            type="button"
                            className={`popup-item ${item.danger ? 'danger' : ''}`}
                            role="menuitem"
                            onClick={() => handleItemClick(item)}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
