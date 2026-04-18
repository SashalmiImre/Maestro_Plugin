import React from "react";
import { useData } from "../../../../core/contexts/DataContext.jsx";
import { getStateConfig } from "maestro-shared/workflowRuntime.js";
import { MARKERS } from "maestro-shared/constants.js";

export const WorkflowStatus = ({ article }) => {
    const { workflow } = useData();

    if (!article) return null;

    const stateId = article.state || "designing";
    const config = getStateConfig(workflow, stateId);
    const label = config?.label || stateId;
    const color = config?.color || "#999999";

    // Markers are stored as a Bitmask Integer
    const markersMask = typeof article.markers === 'number' ? article.markers : 0;
    const isIgnored = (markersMask & MARKERS.IGNORE) !== 0;

    // Ha "Kimarad" aktív, szürke pöttyöt mutatunk az eredeti státusz szín helyett
    const dotColor = isIgnored
        ? "var(--spectrum-global-color-gray-500)"
        : color;
    const dotTitle = isIgnored
        ? `${label} (Kimarad)`
        : label;

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
