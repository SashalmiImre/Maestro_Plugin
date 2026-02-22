import React from "react";
import { WORKFLOW_STATES, WORKFLOW_CONFIG, MARKERS } from "../../../../core/utils/workflow/workflowConstants.js";

export const WorkflowStatus = ({ article }) => {
    if (!article) return null;

    // State is now an integer in DB
    // Handle both lowercase 'state' (new) and PascalCase 'State' (legacy/imported)
    let rawState = article.state;
    if (rawState === undefined) rawState = article.State;

    const currentState = typeof rawState === 'number' ? rawState : WORKFLOW_STATES.DESIGNING;
    const currentConfig = WORKFLOW_CONFIG[currentState]?.config || WORKFLOW_CONFIG[WORKFLOW_STATES.DESIGNING]?.config;

    // Markers are stored as a Bitmask Integer
    const markersMask = typeof article.markers === 'number' ? article.markers : 0;
    const isIgnored = (markersMask & MARKERS.IGNORE) !== 0;

    // Ha "Kimarad" aktív, szürke pöttyöt mutatunk az eredeti státusz szín helyett
    const dotColor = isIgnored
        ? "var(--spectrum-global-color-gray-500)"
        : currentConfig.color;
    const dotTitle = isIgnored
        ? `${currentConfig.label} (Kimarad)`
        : currentConfig.label;

    return (
        <div style={{ display: "flex", flexGrow: 0, alignItems: "center" }}>
            {/* Status Dot — szürke ha kimarad */}
            <div
                title={dotTitle}
                style={{
                    width: "12px",
                    height: "12px",
                    borderRadius: "50%",
                    backgroundColor: dotColor
                }}
            />
        </div>
    );
};
