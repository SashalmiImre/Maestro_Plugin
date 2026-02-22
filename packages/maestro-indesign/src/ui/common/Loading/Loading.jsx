import React from "react";

export const Loading = ({ message = "Betöltés...", details = null, showSpinner = true, icon = null }) => {
    return (
        <div style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            height: "100%",
            width: "100%",
            flexDirection: "column",
            padding: "24px"
        }}>
            {icon && (
                <div style={{
                    marginBottom: showSpinner ? "8px" : "0",
                    color: "var(--spectrum-global-color-gray-700)"
                }}>
                    {React.isValidElement(icon) ? (
                        icon
                    ) : (typeof icon === 'function' ? (
                        React.createElement(icon, { size: "xl", style: { width: "64px", height: "64px" } })
                    ) : null)}
                </div>
            )}

            {showSpinner && (
                <div style={{ marginBottom: "16px" }}>
                    <sp-progress-circle
                        indeterminate
                        size={icon ? "m" : "l"}
                    />
                </div>
            )}

            <sp-heading level="3" style={{
                textAlign: "center",
                marginBottom: details ? "8px" : "0"
            }}>
                {message}
            </sp-heading>
            {details && (
                <sp-detail style={{
                    textAlign: "center",
                    maxWidth: "300px"
                }}>
                    {details}
                </sp-detail>
            )}
        </div>
    );
};
