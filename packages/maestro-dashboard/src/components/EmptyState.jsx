/**
 * Maestro Dashboard — EmptyState
 *
 * Landing / üres lista helyén megjelenő hero komponens.
 * Cím, leírás, opcionális primary + secondary akció.
 */

import React from 'react';

/**
 * @param {Object} props
 * @param {string} props.title — Fő címsor
 * @param {string} [props.description] — Másodlagos szöveg
 * @param {{ label: string, onClick: Function }} [props.primaryAction]
 * @param {{ label: string, onClick: Function }} [props.secondaryAction]
 */
export default function EmptyState({ title, description, primaryAction, secondaryAction }) {
    return (
        <div className="empty-state empty-state--hero">
            <div className="empty-state__content">
                <h2 className="empty-state__title">{title}</h2>
                {description && (
                    <p className="empty-state__description">{description}</p>
                )}
                {(primaryAction || secondaryAction) && (
                    <div className="empty-state__actions">
                        {primaryAction && (
                            <button
                                type="button"
                                className="btn-primary"
                                onClick={primaryAction.onClick}
                            >
                                {primaryAction.label}
                            </button>
                        )}
                        {secondaryAction && (
                            <button
                                type="button"
                                className="btn-secondary"
                                onClick={secondaryAction.onClick}
                            >
                                {secondaryAction.label}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
