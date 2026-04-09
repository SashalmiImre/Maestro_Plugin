/**
 * Maestro Dashboard — TransitionEdge
 *
 * Custom xyflow edge típus a workflow átmenetek megjelenítéséhez.
 * Irány szerinti szín + label megjelenítés.
 */

import React, { memo } from 'react';
import {
    BaseEdge,
    EdgeLabelRenderer,
    getBezierPath
} from '@xyflow/react';

/** Irány → szín leképezés */
const DIRECTION_COLORS = {
    forward:  '#4ade80',  // zöld
    backward: '#fb923c',  // narancs
    reset:    '#f87171'   // piros
};

function TransitionEdge({
    id,
    sourceX, sourceY,
    targetX, targetY,
    sourcePosition, targetPosition,
    data,
    selected,
    markerEnd
}) {
    const [edgePath, labelX, labelY] = getBezierPath({
        sourceX, sourceY,
        targetX, targetY,
        sourcePosition, targetPosition
    });

    const color = DIRECTION_COLORS[data?.direction] || '#888';

    return (
        <>
            <BaseEdge
                id={id}
                path={edgePath}
                markerEnd={markerEnd}
                style={{
                    stroke: selected ? '#3b82f6' : color,
                    strokeWidth: selected ? 2.5 : 1.5,
                    opacity: selected ? 1 : 0.7
                }}
            />
            {data?.label && (
                <EdgeLabelRenderer>
                    <div
                        className={`transition-edge__label ${selected ? 'transition-edge__label--selected' : ''}`}
                        style={{
                            position: 'absolute',
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                            pointerEvents: 'all',
                            '--edge-color': color
                        }}
                    >
                        {data.label}
                    </div>
                </EdgeLabelRenderer>
            )}
        </>
    );
}

export default memo(TransitionEdge);
