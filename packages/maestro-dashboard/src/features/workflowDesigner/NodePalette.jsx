/**
 * Maestro Dashboard — NodePalette
 *
 * Bal oldali panel — drag source új állapot node-ok létrehozásához.
 * HTML5 DnD: a felhasználó húzza a palette elemét a canvas-ra,
 * az onDrop handler a WorkflowDesignerPage-ben kezeli.
 *
 * #61 redesign (2026-04-19): a korábbi 6 azonos „Új állapot" item helyett
 * egyetlen gomb — a következő szín automatikusan a `WORKFLOW_STATE_COLORS`
 * paletta első, még nem használt értékéből származik (ld. `nextAvailableColor`).
 * Így a user nem találgat: minden új állapot eleve új színt kap.
 */

import React, { useCallback, useMemo } from 'react';
import { WORKFLOW_STATE_COLORS, nextAvailableColor } from '@shared/workflowStateColors.js';

/**
 * @param {Object} props
 * @param {string[]} props.usedColors - A canvason már használt szín hex-ek (a palette ezekből választ)
 */
export default function NodePalette({ usedColors }) {
    const nextColor = useMemo(() => nextAvailableColor(usedColors), [usedColors]);

    // Hány paletta-szín van még szabadon — felhasználói visszajelzés a hint-ben
    const remainingColors = useMemo(() => {
        const used = new Set(
            (usedColors || [])
                .filter(c => typeof c === 'string')
                .map(c => c.toUpperCase())
        );
        return WORKFLOW_STATE_COLORS.filter(c => !used.has(c.toUpperCase())).length;
    }, [usedColors]);

    const handleDragStart = useCallback((event) => {
        event.dataTransfer.setData('application/maestro-node-type', 'stateNode');
        event.dataTransfer.setData('application/maestro-node-color', nextColor);
        event.dataTransfer.effectAllowed = 'move';
    }, [nextColor]);

    return (
        <div className="node-palette">
            <div className="node-palette__header">Elemek</div>
            <div className="node-palette__items">
                <div
                    className="node-palette__item"
                    draggable
                    onDragStart={handleDragStart}
                    title="Húzd a vászonra új állapot létrehozásához"
                    aria-label="Új állapot hozzáadása húzással"
                >
                    <div
                        className="node-palette__item-accent"
                        style={{ background: nextColor }}
                        aria-hidden="true"
                    />
                    <span className="node-palette__item-label">+ Új állapot</span>
                </div>
            </div>
            <div className="node-palette__hint">
                Húzd a vászonra
                {remainingColors === 0 && (
                    <>
                        <br />
                        <span style={{ opacity: 0.7 }}>
                            (paletta újrahasznosítva)
                        </span>
                    </>
                )}
            </div>
        </div>
    );
}
