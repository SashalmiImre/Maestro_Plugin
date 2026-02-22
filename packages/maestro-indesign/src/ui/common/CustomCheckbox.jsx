import React, { useState } from 'react';
import "@spectrum-web-components/icons-workflow/icons/sp-icon-checkmark.js";

/**
 * Custom Checkbox component for Adobe UXP plugins.
 * 
 * @component
 * @description
 * THIS IS A CUSTOM IMPLEMENTATION REPLACING NATIVE <sp-checkbox>.
 * 
 * WHY THIS EXISTS:
 * Ideally, we should use the native `<sp-checkbox>` provided by the InDesign UXP engine.
 * However, our project uses `sp-table` from `@swc-uxp-wrappers/table`, which has an internal dependency
 * that registers a Web Component version of `sp-checkbox` globally. 
 * 
 * This registration overrides the native UXP widget, causing valid native attributes (like `checked` 
 * behavior or native styling) to break or display incorrectly (e.g., small unstyled box).
 * 
 * Since we cannot remove `sp-table` (it's essential for list views) and cannot isolate the dependencies,
 * we must use this custom visual implementation that:
 * 1. Mimics the official Spectrum design (colors, icons, hover states).
 * 2. Uses standard `div` elements, avoiding the `sp-checkbox` tag entirely to prevent conflicts.
 * 3. Provides reliable styling control (e.g., predictable sizing and alignment).
 * 
 * TODO: Check in future UXP/React-Wrapper versions if `sp-table` dependencies are decoupled 
 * or if the native widget conflict is resolved. If so, revert to `<sp-checkbox>`.
 * 
 * @param {Object} props
 * @param {boolean} props.checked - Whether the checkbox is checked.
 * @param {function} props.onChange - Handler called when toggled.
 * @param {React.ReactNode} props.children - Label content.
 * @param {string} [props.size="m"] - Size of the text (passed to sp-body).
 * @param {Object} [props.style] - Optional style overrides for the container.
 * @param {boolean} [props.disabled] - Whether the checkbox is disabled.
 */
export const CustomCheckbox = ({
    checked,
    onChange,
    children,
    size = "m",
    style = {},
    disabled = false
}) => {
    const [isHovered, setIsHovered] = useState(false);
    const [isFocused, setIsFocused] = useState(false);

    const handleClick = (e) => {
        if (disabled) return;
        if (onChange) onChange(e);
    };

    const fontSizeMap = {
        "s": "12px",
        "m": "14px",
        "l": "16px",
        "xl": "18px"
    };

    const labelSize = fontSizeMap[size] || size || "14px";

    return (
        <div
            role="checkbox"
            aria-checked={checked}
            aria-disabled={disabled}
            tabIndex={disabled ? -1 : 0}
            onClick={handleClick}
            onFocus={() => !disabled && setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onKeyDown={(e) => {
                if (disabled) return;
                if (e.key === ' ' || e.key === 'Enter') {
                    // Prevent default scrolling for Space
                    if (e.key === ' ') e.preventDefault();
                    handleClick(e);
                }
            }}
            onMouseEnter={() => !disabled && setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
                display: "flex",
                alignItems: "center",
                cursor: disabled ? "default" : "pointer",
                userSelect: "none",
                opacity: disabled ? 0.5 : 1,
                ...style
            }}
        >
            {/* Custom Checkbox Box */}
            <div style={{
                width: "14px",
                height: "14px",
                borderRadius: "2px",
                border: checked
                    ? "none"
                    : `2px solid ${isHovered && !disabled ? "var(--spectrum-global-color-gray-500)" : "var(--spectrum-alias-component-stroke-color-default, var(--spectrum-global-color-gray-400))"}`,
                backgroundColor: checked ? "var(--spectrum-alias-component-stroke-color-default, var(--spectrum-global-color-gray-600))" : "transparent",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginRight: "8px",
                flexShrink: 0,
                transition: "all 0.1s ease-in-out",
                outline: isFocused && !disabled ? "2px solid var(--spectrum-global-color-blue-400)" : "none",
                outlineOffset: "2px",

                position: "relative"
            }}>
                {checked && (
                    <sp-icon-checkmark
                        size="xs"
                        style={{
                            color: "var(--spectrum-alias-background-color-default, white)",
                            width: "10px",
                            height: "10px",
                            display: "block"
                        }}
                    ></sp-icon-checkmark>
                )}
            </div>
            <span style={{ fontSize: labelSize, color: "var(--system-spectrum-checkbox-control-color-default)" }}>{children}</span>
        </div>
    );
};
