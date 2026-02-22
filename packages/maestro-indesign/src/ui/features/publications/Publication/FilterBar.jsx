import React, { useCallback, useMemo } from "react";

import { CustomCheckbox } from "../../../common/CustomCheckbox.jsx";
import { WORKFLOW_STATES, WORKFLOW_CONFIG } from "../../../../core/utils/workflow/workflowConstants.js";

/** Státusz opciók (egyszer számítva, nem renderenként) */
const statusOptions = Object.values(WORKFLOW_STATES).map(state => {
    const config = WORKFLOW_CONFIG[state]?.config;
    return {
        value: state,
        label: config?.label || `Állapot ${state}`,
        color: config?.color || "var(--spectrum-global-color-gray-500)"
    };
});

/**
 * Inline szűrősáv a publikáció neve alatt.
 * Státusz checkbox-ok 3 oszlopban + Kimarad checkbox + szűrők törlése.
 *
 * @param {Object} props
 * @param {number[]} props.statusFilters - Kiválasztott workflow állapotok tömbje
 * @param {Function} props.onStatusFiltersChange - (newFilters: number[]) => void
 * @param {boolean} props.showIgnored - Kimaradó cikkek mutatása
 * @param {Function} props.onShowIgnoredChange - (show: boolean) => void
 * @param {boolean} props.isFilterActive - Van-e aktív (nem alapértelmezett) szűrő
 * @param {Function} props.onReset - Szűrők alaphelyzetbe állítása
 */
const FilterBar = React.memo(({
    statusFilters,
    onStatusFiltersChange,
    showIgnored,
    onShowIgnoredChange,
    isFilterActive,
    onReset
}) => {
    const toggleStatus = useCallback((value) => {
        const next = statusFilters.includes(value)
            ? statusFilters.filter(v => v !== value)
            : [...statusFilters, value];
        onStatusFiltersChange(next);
    }, [statusFilters, onStatusFiltersChange]);

    /** Összes szűrő opció: státuszok + Kimarad */
    const allItems = useMemo(() => [
        ...statusOptions.map(opt => ({
            key: `status-${opt.value}`,
            label: opt.label,
            color: opt.color,
            checked: statusFilters.includes(opt.value),
            onChange: () => toggleStatus(opt.value)
        })),
        {
            key: "ignored",
            label: "Kimarad",
            color: "var(--spectrum-global-color-gray-500)",
            checked: showIgnored,
            onChange: () => onShowIgnoredChange(!showIgnored)
        }
    ], [statusFilters, toggleStatus, showIgnored, onShowIgnoredChange]);

    return (
        <div style={{
            padding: "6px 0px 6px 0px",
            flexShrink: 0,
            borderBottom: "1px solid var(--spectrum-global-color-gray-300)"
        }}>
            {/* Fejléc: cím + törlés gomb */}
            {isFilterActive && (
                <div style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    marginBottom: "4px"
                }}>
                    <button
                        type="button"
                        onClick={onReset}
                        title="Szűrők törlése"
                        style={{
                            display: "flex",
                            alignItems: "center",
                            cursor: "pointer",
                            fontSize: "12px",
                            color: "var(--spectrum-global-color-gray-600)",
                            background: "none",
                            border: "none",
                            padding: 0,
                            margin: 0
                        }}
                    >
                        <sp-icon-close size="s" style={{
                            width: "10px",
                            height: "10px",
                            display: "inline-block",
                            marginRight: "4px"
                        }}></sp-icon-close>
                        <span>Törlés</span>
                    </button>
                </div>
            )}

            {/* Checkbox rács — 3 oszlop */}
            <div style={{
                display: "flex",
                flexWrap: "wrap"
            }}>
                {allItems.map(item => (
                    <div
                        key={item.key}
                        style={{
                            width: "33.33%",
                            padding: "2px 0",
                            boxSizing: "border-box"
                        }}
                    >
                        <CustomCheckbox
                            checked={item.checked}
                            onChange={item.onChange}
                            size="s"
                        >
                            <span style={{
                                display: "inline-block",
                                width: "8px",
                                height: "8px",
                                borderRadius: "50%",
                                backgroundColor: item.color,
                                marginRight: "6px",
                                verticalAlign: "middle"
                            }}></span>
                            <span style={{ verticalAlign: "middle" }}>{item.label}</span>
                        </CustomCheckbox>
                    </div>
                ))}
            </div>
        </div>
    );
});
FilterBar.displayName = "FilterBar";

export { FilterBar };
