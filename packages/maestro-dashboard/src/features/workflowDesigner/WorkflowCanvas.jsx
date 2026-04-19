/**
 * Maestro Dashboard — WorkflowCanvas
 *
 * @xyflow/react wrapper a workflow vizuális szerkesztéséhez.
 * Custom node/edge típusokat regisztrál, MiniMap-et és Controls-t jelenít meg.
 */

import React, { useMemo } from 'react';
import {
    ReactFlow,
    MiniMap,
    Controls,
    Background,
    BackgroundVariant
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import StateNode from './nodes/StateNode.jsx';
import TransitionEdge from './edges/TransitionEdge.jsx';

/** Custom node típusok regisztrálása (stabil referencia) */
const nodeTypes = { stateNode: StateNode };

/** Custom edge típusok regisztrálása (stabil referencia) */
const edgeTypes = { transitionEdge: TransitionEdge };

/** Edge marker (nyílhegy) definíció */
const defaultEdgeOptions = {
    markerEnd: {
        type: 'arrowclosed',
        width: 16,
        height: 16,
        color: '#888'
    }
};

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
    // MiniMap szín a node szín alapján
    const miniMapNodeColor = useMemo(() => {
        return (node) => node.data?.color || '#888';
    }, []);

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
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#333" />
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
                    maskColor="rgba(0, 0, 0, 0.6)"
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
