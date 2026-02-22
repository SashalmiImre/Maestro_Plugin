// React
import React, { useState, useEffect } from "react";

/**
 * CollapsibleSection Component
 * 
 * A reusable wrapper component that displays a collapsible section with:
 * - Optional divider line at the top
 * - Blue uppercase header with toggle controls
 * - Expandable/collapsible content
 * - Persistent collapse state via localStorage
 * 
 * @param {Object} props - Component props
 * @param {string} props.title - Section title (displayed in uppercase)
 * @param {boolean} [props.showDivider=true] - Whether to show the top divider line
 * @param {string} [props.storageKey] - LocalStorage key for persisting collapse state
 * @param {boolean} [props.defaultCollapsed=false] - Default collapsed state if not in storage
 * @param {React.ReactNode} props.children - Section content
 * @returns {JSX.Element} The CollapsibleSection component
 */
export const CollapsibleSection = ({
    title,
    showDivider = true,
    storageKey,
    defaultCollapsed = false,
    children
}) => {
    // Initialize collapsed state from localStorage or default
    const [isCollapsed, setIsCollapsed] = useState(() => {
        if (storageKey) {
            try {
                const saved = localStorage.getItem(storageKey);
                if (saved !== null) {
                    return saved === 'true';
                }
            } catch (e) {
                console.warn('[CollapsibleSection] Failed to read state from localStorage:', e);
            }
        }
        return defaultCollapsed;
    });

    // Persist collapse state to localStorage
    useEffect(() => {
        if (storageKey) {
            try {
                localStorage.setItem(storageKey, String(isCollapsed));
            } catch (e) {
                console.warn('[CollapsibleSection] Failed to save state to localStorage:', e);
            }
        }
    }, [isCollapsed, storageKey]);

    const toggleCollapse = () => {
        setIsCollapsed(prev => !prev);
    };

    return (
        <div style={{ flexShrink: 0 }}>
            {/* Divider line */}
            {showDivider && (
                <div style={{
                    borderTop: "0.5px solid var(--spectrum-alias-border-color-mid)",
                    marginTop: "32px"
                }} />
            )}

            {/* Header with toggle */}
            <div
                role="button"
                tabIndex={0}
                aria-expanded={!isCollapsed}
                onClick={toggleCollapse}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleCollapse();
                    }
                }}
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-start",
                    cursor: "pointer",
                    marginTop: showDivider ? "4px" : "0",
                    marginBottom: isCollapsed ? "0" : "12px",
                    userSelect: "none"
                }}
            >
                <div style={{ display: "flex", alignItems: "center", color: "var(--spectrum-global-color-blue-400)", marginRight: "8px" }}>
                    {isCollapsed ?
                        <sp-icon-chevron-right size="s" style={{ width: "14px", height: "14px", display: "inline-block" }}></sp-icon-chevron-right> :
                        <sp-icon-chevron-down size="s" style={{ width: "14px", height: "14px", display: "inline-block" }}></sp-icon-chevron-down>
                    }
                </div>
                <small style={{
                    color: "var(--spectrum-global-color-blue-400)",
                    fontWeight: "bold",
                    textTransform: "uppercase"
                }}>
                    {title}
                </small>
            </div>

            {/* Content - hidden when collapsed */}
            {!isCollapsed && (
                <div>
                    {children}
                </div>
            )}
        </div>
    );
};
