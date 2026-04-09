/**
 * Maestro Dashboard — NodePalette
 *
 * Bal oldali panel — drag source új állapot node-ok létrehozásához.
 * HTML5 DnD: a felhasználó húzza a palette elemét a canvas-ra,
 * az onDrop handler a WorkflowDesignerPage-ben kezeli.
 */

import React, { useCallback } from 'react';

/** Palette elem alapértelmezett színek */
const PALETTE_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#06b6d4'];

/**
 * Egyetlen palette elem (draggable).
 * A drag data: 'application/maestro-node-type' = 'stateNode'
 */
function PaletteItem({ color, index }) {
    const handleDragStart = useCallback((event) => {
        event.dataTransfer.setData('application/maestro-node-type', 'stateNode');
        event.dataTransfer.setData('application/maestro-node-color', color);
        event.dataTransfer.effectAllowed = 'move';
    }, [color]);

    return (
        <div
            className="node-palette__item"
            draggable
            onDragStart={handleDragStart}
            title="Húzd a vászonra új állapot létrehozásához"
        >
            <div className="node-palette__item-accent" style={{ background: color }} />
            <span className="node-palette__item-label">Új állapot</span>
        </div>
    );
}

/**
 * @param {Object} props
 * @param {number} props.nodeCount - Jelenlegi node-ok száma (egyedi ID generáláshoz)
 */
export default function NodePalette({ nodeCount }) {
    return (
        <div className="node-palette">
            <div className="node-palette__header">Elemek</div>
            <div className="node-palette__items">
                {PALETTE_COLORS.map((color, i) => (
                    <PaletteItem key={color} color={color} index={i} />
                ))}
            </div>
            <div className="node-palette__hint">
                Húzd az elemet a vászonra
            </div>
        </div>
    );
}
