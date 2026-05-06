/**
 * Maestro Dashboard — TransitionEdge
 *
 * Custom xyflow edge típus a workflow átmenetek megjelenítéséhez.
 * Irány szerinti szín + label megjelenítés.
 */

import React, { memo, useMemo } from 'react';
import {
    BaseEdge,
    EdgeLabelRenderer,
    getBezierPath
} from '@xyflow/react';

import { useCssTokens } from '../../../hooks/useCssToken.js';

/** C.2.7.b: a direction → szín és selected-stroke prop-okat tokenekből olvassuk
 *  (Codex C.0.2 finding), hogy light témán automatikusan átálljanak. */
const EDGE_TOKEN_NAMES = ['--edge-forward', '--edge-backward', '--edge-reset', '--edge-selected'];

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

    const [forwardColor, backwardColor, resetColor, selectedColor] = useCssTokens(EDGE_TOKEN_NAMES);

    // Iránytól függő edge-szín (token-ből, light/dark theme-aware). A `||` az
    // első render token-cache miss-re fallback-el (még nem hidratált értékre).
    // 50+ edge esetén useMemo elkerüli a render-enkénti obj-allocációt.
    const colorByDirection = useMemo(() => ({
        forward:  forwardColor,
        backward: backwardColor,
        reset:    resetColor,
    }), [forwardColor, backwardColor, resetColor]);
    const directionColor = colorByDirection[data?.direction] || '#888';

    return (
        <>
            <BaseEdge
                id={id}
                path={edgePath}
                markerEnd={markerEnd}
                style={{
                    stroke: selected ? (selectedColor || '#3b82f6') : directionColor,
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
