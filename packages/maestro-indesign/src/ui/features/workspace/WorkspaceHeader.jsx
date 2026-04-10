/**
 * @file WorkspaceHeader.jsx
 * @description Fejléc sáv: felhasználó név + scope dropdown-ok (org/office) + szűrők gomb + dashboard link.
 */

import React from "react";
import { CustomDropdown } from "../../common/CustomDropdown.jsx";

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
 * @param {Array} [props.organizations] - Elérhető szervezetek listája
 * @param {string} [props.activeOrganizationId] - Aktív szervezet ID
 * @param {Function} [props.onOrganizationChange] - Szervezet váltás callback
 * @param {Array} [props.scopedOffices] - Az aktív orghoz tartozó szerkesztőségek
 * @param {string} [props.activeEditorialOfficeId] - Aktív szerkesztőség ID
 * @param {Function} [props.onOfficeChange] - Szerkesztőség váltás callback
 */
const WorkspaceHeader = React.memo(({
    user, isFilterActive, onToggleFilter, onOpenDashboard, isPropertiesView,
    canArchivePublication, isArchiving, archiveProgress, onArchivePublication,
    organizations, activeOrganizationId, onOrganizationChange,
    scopedOffices, activeEditorialOfficeId, onOfficeChange
}) => {
    const hasMultipleOrgs = Array.isArray(organizations) && organizations.length > 1;
    const hasMultipleOffices = Array.isArray(scopedOffices) && scopedOffices.length > 1;
    const showDropdowns = hasMultipleOrgs || hasMultipleOffices;

    return (
        <sp-body style={{
            flexShrink: 0,
            borderBottom: '1px solid var(--spectrum-global-color-gray-300)'
        }}>
            <div style={{
                display: 'flex',
                alignItems: showDropdowns ? 'flex-start' : 'center',
                justifyContent: 'space-between'
            }}>
                {/* Bal oldal: felhasználó név + scope dropdown-ok */}
                <div style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden' }}>
                    <span style={{
                        ...HEADER_FONT_STYLE,
                        fontWeight: 'bold',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        display: 'block'
                    }}>
                        {user?.name || user?.email || ''}
                    </span>

                    {hasMultipleOrgs && (
                        <CustomDropdown
                            value={activeOrganizationId}
                            onChange={onOrganizationChange}
                            placeholder="Szervezet"
                            style={{ width: '100%', marginTop: '4px' }}
                            disabled={isPropertiesView}
                        >
                            <sp-menu slot="options">
                                {organizations.map(org => (
                                    <sp-menu-item key={org.$id} value={org.$id}>{org.name}</sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    )}

                    {hasMultipleOffices && (
                        <CustomDropdown
                            value={activeEditorialOfficeId}
                            onChange={onOfficeChange}
                            placeholder="Szerkesztőség"
                            style={{ width: '100%', marginTop: '4px' }}
                            disabled={isPropertiesView}
                        >
                            <sp-menu slot="options">
                                {scopedOffices.map(office => (
                                    <sp-menu-item key={office.$id} value={office.$id}>{office.name}</sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    )}
                </div>

                {/* Jobb oldal: akciógombok */}
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
    );
});
WorkspaceHeader.displayName = "WorkspaceHeader";

export { WorkspaceHeader };
