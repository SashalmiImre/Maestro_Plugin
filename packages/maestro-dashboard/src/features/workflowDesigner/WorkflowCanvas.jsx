/**
 * Maestro Dashboard — WorkflowCanvas
 *
 * @xyflow/react wrapper a workflow vizuális szerkesztéséhez.
 * Custom node/edge típusokat regisztrál, MiniMap-et és Controls-t jelenít meg.
 */

import React, { useCallback, useMemo } from 'react';
import {
    ReactFlow,
    MiniMap,
    Controls,
    Background,
    BackgroundVariant
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useCssTokens } from '../../hooks/useCssToken.js';
import StateNode from './nodes/StateNode.jsx';
import TransitionEdge from './edges/TransitionEdge.jsx';

/** Stabil token-lista referencia — a useCssTokens dep-je `.join(',')` ugyanaz marad. */
const CANVAS_TOKEN_NAMES = ['--canvas-dot-color', '--canvas-mask-color', '--edge-marker'];

/** Custom node típusok regisztrálása (stabil referencia) */
const nodeTypes = { stateNode: StateNode };

/** Custom edge típusok regisztrálása (stabil referencia) */
const edgeTypes = { transitionEdge: TransitionEdge };

/** Stabil prop-érték — nem újraépítve render-enként. A nyílhegy színét
 *  runtime-ban injektáljuk a `defaultEdgeOptions` memo-ban (lentebb), hogy
 *  light témán is helyes színt adjon. C.2.7.b spontán finding (Codex). */
const DEFAULT_EDGE_MARKER_DIMENSIONS = { type: 'arrowclosed', width: 16, height: 16 };

/**
 * @param {Object} props
 * @param {Object[]} props.nodes - xyflow node-ok
 * @param {Object[]} props.edges - xyflow edge-ek
 * @param {Function} props.onNodesChange - Node változás handler
 * @param {Function} props.onEdgesChange - Edge változás handler
 * @param {Function} props.onNodeClick - Node kattintás
 * @param {Function} props.onEdgeClick - Edge kattintás
 * @param {Function} props.onPaneClick - Háttér kattintás (kijelölés törlés)
 * @param {Function} props.onConnect - Új edge létrehozás
 * @param {Function} props.onDrop - DnD drop handler
 * @param {Function} props.onDragOver - DnD drag-over handler
 * @param {Function} props.onInit - ReactFlow instance callback
 * @param {Object|null} props.defaultViewport - Alapértelmezett viewport
 */
export default function WorkflowCanvas({
    nodes, edges,
    onNodesChange, onEdgesChange,
    onNodeClick, onEdgeClick, onPaneClick,
    onConnect,
    onDrop, onDragOver,
    onInit,
    defaultViewport
}) {
    // MiniMap szín a node szín alapján — useCallback, hogy a függvény-referencia
    // stabil maradjon (a MiniMap a prop-azonosság alapján dönt re-renderről).
    const miniMapNodeColor = useCallback((node) => node.data?.color || '#888', []);

    // C.2.7.a + 7b spontán: a Background `color`, MiniMap `maskColor` és edge
    // marker color prop-okat tokenekből olvassuk, hogy light témán automatikusan
    // átálljanak (Codex C.0.2 finding + spontán 2026-05-06 finding).
    const [canvasDotColor, canvasMaskColor, edgeMarkerColor] = useCssTokens(CANVAS_TOKEN_NAMES);

    const defaultEdgeOptions = useMemo(() => ({
        markerEnd: {
            ...DEFAULT_EDGE_MARKER_DIMENSIONS,
            color: edgeMarkerColor || '#888',
        },
    }), [edgeMarkerColor]);

    const isEmpty = nodes.length === 0;

    return (
        <div className="workflow-canvas">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                onEdgeClick={onEdgeClick}
                onPaneClick={onPaneClick}
                onConnect={onConnect}
                onDrop={onDrop}
                onDragOver={onDragOver}
                onInit={onInit}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                defaultEdgeOptions={defaultEdgeOptions}
                defaultViewport={defaultViewport || { x: 0, y: 0, zoom: 1 }}
                fitView={!defaultViewport}
                proOptions={{ hideAttribution: true }}
                deleteKeyCode={['Backspace', 'Delete']}
                selectNodesOnDrag={false}
            >
                <Background
                    variant={BackgroundVariant.Dots}
                    gap={20}
                    size={1}
                    color={canvasDotColor || '#333'}
                />
                <Controls
                    showInteractive={false}
                    position="bottom-left"
                    className="workflow-canvas__controls"
                />
                <MiniMap
                    nodeColor={miniMapNodeColor}
                    nodeStrokeWidth={1}
                    position="bottom-right"
                    className="workflow-canvas__minimap"
                    maskColor={canvasMaskColor || 'rgba(0, 0, 0, 0.6)'}
                />
            </ReactFlow>

            {/* #70: üres canvas onboarding hint — eltűnik az első node lehelyezésekor.
                pointer-events: none, hogy ne blokkolja a drop event-et a canvason. */}
            {isEmpty && (
                <div className="workflow-canvas__empty-hint" aria-hidden="true">
                    <div className="workflow-canvas__empty-hint-arrow">←</div>
                    <div className="workflow-canvas__empty-hint-text">
                        Húzz ide egy <strong>+ Új állapot</strong> elemet a bal oldali palettáról
                    </div>
                </div>
            )}
        </div>
    );
}
