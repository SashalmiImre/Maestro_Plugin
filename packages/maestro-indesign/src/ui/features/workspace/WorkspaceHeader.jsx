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

/** Függőleges elválasztó a fejléc linkek között. */
const DIVIDER_STYLE = {
    margin: '0 8px',
    width: '1px',
    height: '12px',
    backgroundColor: 'var(--spectrum-global-color-gray-300)'
};

/**
 * Workspace fejléc komponens.
 *
 * @param {Object} props
 * @param {Object} props.user - Aktuális felhasználó objektum
 * @param {boolean} props.isFilterActive - Van-e aktív szűrő
 * @param {Function} props.onToggleFilter - Szűrők megjelenítése/elrejtése
 * @param {Function} props.onOpenDashboard - Dashboard megnyitása böngészőben
 * @param {boolean} props.isPropertiesView - Properties panel aktív-e (ilyenkor a szűrők gomb elrejtése)
 * @param {boolean} props.canArchivePublication - Megjelenik-e az archiválás gomb
 * @param {boolean} props.isArchiving - Archiválás folyamatban van-e
 * @param {Object|null} props.archiveProgress - Archiválási progress: { current, total, currentArticleName }
 * @param {Function} props.onArchivePublication - Archiválás indítása
 */
const WorkspaceHeader = React.memo(({ user, isFilterActive, onToggleFilter, onOpenDashboard, isPropertiesView, canArchivePublication, isArchiving, archiveProgress, onArchivePublication }) => (
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
                {!isPropertiesView && (
                    <>
                        {canArchivePublication && (
                            <>
                                <span
                                    onClick={!isArchiving ? onArchivePublication : undefined}
                                    title={isArchiving
                                        ? `Archiválás: ${archiveProgress?.currentArticleName} (${archiveProgress?.current}/${archiveProgress?.total})`
                                        : "Teljes kiadvány archiválása (archív + PDF)"
                                    }
                                    style={{
                                        ...HEADER_FONT_STYLE,
                                        cursor: isArchiving ? 'wait' : 'pointer',
                                        textDecoration: 'underline',
                                        opacity: isArchiving ? 0.5 : 1,
                                        color: '#B366FF'
                                    }}
                                >
                                    {isArchiving
                                        ? `ARCHIVÁLÁS (${archiveProgress?.current}/${archiveProgress?.total})…`
                                        : 'ARCHIVÁLÁS'
                                    }
                                </span>
                                <div style={DIVIDER_STYLE} />
                            </>
                        )}
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
                        <div style={DIVIDER_STYLE} />
                    </>
                )}
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
