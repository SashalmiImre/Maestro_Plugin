/**
 * @file WorkspaceHeader.jsx
 * @description Fejléc sáv: felhasználó név + szűrők gomb + dashboard link.
 */

import React from "react";

/** Fejléc monospace betűstílus (dashboard page-range stílushoz igazítva). */
const HEADER_FONT_STYLE = {
    fontFamily: "Consolas, 'Andale Mono', 'Lucida Console', 'Courier New', monospace",
    fontSize: '11px'
};

/**
 * Workspace fejléc komponens.
 *
 * @param {Object} props
 * @param {Object} props.user - Aktuális felhasználó objektum
 * @param {boolean} props.isFilterActive - Van-e aktív szűrő
 * @param {Function} props.onToggleFilter - Szűrők megjelenítése/elrejtése
 * @param {Function} props.onOpenDashboard - Dashboard megnyitása böngészőben
 */
const WorkspaceHeader = React.memo(({ user, isFilterActive, onToggleFilter, onOpenDashboard }) => (
    <sp-body style={{
        flexShrink: 0,
        borderBottom: '1px solid var(--spectrum-global-color-gray-300)'
    }}>
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
        }}>
            <span style={{
                ...HEADER_FONT_STYLE,
                fontWeight: 'bold',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            }}>
                {user?.name || user?.email || ''}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                <span
                    onClick={onToggleFilter}
                    title="Szűrők megjelenítése/elrejtése"
                    style={{
                        ...HEADER_FONT_STYLE,
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        opacity: isFilterActive ? 1 : 0.7,
                        color: isFilterActive ? 'var(--spectrum-global-color-static-blue-600)' : 'inherit'
                    }}
                >
                    SZŰRŐK
                </span>
                <div style={{
                    margin: '0 8px',
                    width: '1px',
                    height: '12px',
                    backgroundColor: 'var(--spectrum-global-color-gray-300)'
                }} />
                <span
                    onClick={onOpenDashboard}
                    title="Dashboard megnyitása böngészőben"
                    style={{
                        ...HEADER_FONT_STYLE,
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        opacity: 0.7
                    }}
                >
                    DASHBOARD
                </span>
            </div>
        </div>
    </sp-body>
));
WorkspaceHeader.displayName = "WorkspaceHeader";

export { WorkspaceHeader };
