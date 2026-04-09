/**
 * Maestro Dashboard — Workflow Designer oldal
 *
 * A vizuális workflow szerkesztő gyökér komponense.
 * Route: /admin/office/:officeId/workflow
 *
 * Betölti a teljes workflow dokumentumot (compiled + graph),
 * konvertálja xyflow állapotra, és rendereli a canvast.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, Link, useBlocker } from 'react-router-dom';
import { useNodesState, useEdgesState } from '@xyflow/react';
import { Databases, Query } from 'appwrite';
import { getClient } from '../../contexts/AuthContext.jsx';
import { DATABASE_ID, COLLECTIONS } from '../../config.js';
import { compiledToGraph, graphToCompiled, extractGraphData } from './compiler.js';
import { validateWorkflow } from './validator.js';
import { saveWorkflow } from './api.js';
import { exportWorkflow } from './exportImport.js';

import NodePalette from './NodePalette.jsx';
import ImportDialog from './ImportDialog.jsx';
import WorkflowCanvas from './WorkflowCanvas.jsx';
import PropertiesSidebar from './PropertiesSidebar.jsx';
import './workflowDesigner.css';

/** Graph-mutáló change típusok, amelyeknél dirty-t kell állítani */
const DIRTY_CHANGE_TYPES = new Set(['remove', 'add', 'replace']);

export default function WorkflowDesignerPage() {
    const { officeId } = useParams();

    // ── Workflow dokumentum ─────────────────────────────────────────────────
    const [workflowDocId, setWorkflowDocId] = useState(null);
    const [version, setVersion] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);

    // ── Xyflow állapot ──────────────────────────────────────────────────────
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const [metadata, setMetadata] = useState({
        contributorGroups: [],
        leaderGroups: [],
        elementPermissions: {},
        capabilities: {}
    });

    // ── UI állapot ──────────────────────────────────────────────────────────
    const [selectedNodeId, setSelectedNodeId] = useState(null);
    const [selectedEdgeId, setSelectedEdgeId] = useState(null);
    const [isDirty, setIsDirty] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [isImportOpen, setIsImportOpen] = useState(false);
    const [remoteVersionWarning, setRemoteVersionWarning] = useState(null);

    const reactFlowRef = useRef(null);
    const defaultViewportRef = useRef(null);
    const versionRef = useRef(0);
    const originalStateIdsRef = useRef(new Set());

    // Version ref szinkronban tartása (Realtime handler-nek)
    useEffect(() => { versionRef.current = version; }, [version]);

    // ── Unsaved changes guard ──────────────────────────────────────────────
    // beforeunload: böngésző bezárás / újratöltés
    useEffect(() => {
        if (!isDirty) return;
        const handler = (e) => { e.preventDefault(); };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [isDirty]);

    // react-router navigáció blokkolás
    const blocker = useBlocker(({ currentLocation, nextLocation }) =>
        isDirty && currentLocation.pathname !== nextLocation.pathname
    );

    // ── Workflow betöltés ────────────────────────────────────────────────────

    useEffect(() => {
        if (!officeId) return;
        let cancelled = false;

        (async () => {
            setIsLoading(true);
            setLoadError(null);
            try {
                const client = getClient();
                const databases = new Databases(client);
                const result = await databases.listDocuments(
                    DATABASE_ID,
                    COLLECTIONS.WORKFLOWS,
                    [
                        Query.equal('editorialOfficeId', officeId),
                        Query.limit(1)
                    ]
                );

                if (cancelled) return;

                if (result.documents.length === 0) {
                    setLoadError('Nem található workflow ehhez a szerkesztőséghez.');
                    return;
                }

                const doc = result.documents[0];
                const compiled = typeof doc.compiled === 'string'
                    ? JSON.parse(doc.compiled) : doc.compiled;
                const savedGraph = doc.graph
                    ? (typeof doc.graph === 'string' ? JSON.parse(doc.graph) : doc.graph)
                    : null;

                setWorkflowDocId(doc.$id);
                setVersion(compiled?.version ?? doc.version ?? 1);

                const { nodes: n, edges: e, metadata: m, viewport } = compiledToGraph(compiled, savedGraph);
                setNodes(n);
                setEdges(e);
                setMetadata(m);
                defaultViewportRef.current = viewport;
                originalStateIdsRef.current = new Set(n.map(node => node.id));
            } catch (err) {
                if (!cancelled) {
                    setLoadError('Workflow betöltési hiba: ' + (err?.message || 'Ismeretlen hiba'));
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [officeId]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Realtime awareness: más felhasználó mentett ────────────────────────

    useEffect(() => {
        if (!workflowDocId) return;
        const client = getClient();
        const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.WORKFLOWS}.documents.${workflowDocId}`;

        const unsubscribe = client.subscribe(channel, (response) => {
            if (response.events?.some(e => e.includes('.update'))) {
                const payload = response.payload;
                const remoteCompiled = typeof payload.compiled === 'string'
                    ? JSON.parse(payload.compiled) : payload.compiled;
                const remoteVersion = remoteCompiled?.version ?? 0;

                if (remoteVersion > versionRef.current) {
                    setRemoteVersionWarning(
                        `A workflow-t más felhasználó frissítette (v${remoteVersion}). Töltsd újra az oldalt.`
                    );
                }
            }
        });

        return () => { unsubscribe(); };
    }, [workflowDocId]);

    // ── Kijelölés kezelés ────────────────────────────────────────────────────

    const handleNodeClick = useCallback((_event, node) => {
        setSelectedNodeId(node.id);
        setSelectedEdgeId(null);
    }, []);

    const handleEdgeClick = useCallback((_event, edge) => {
        setSelectedEdgeId(edge.id);
        setSelectedNodeId(null);
    }, []);

    const handlePaneClick = useCallback(() => {
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
    }, []);

    // ── Dirty tracking: node/edge változások ────────────────────────────────

    const handleNodesChange = useCallback((changes) => {
        onNodesChange(changes);
        if (changes.some(c =>
            DIRTY_CHANGE_TYPES.has(c.type) ||
            (c.type === 'position' && c.dragging === false)
        )) {
            setIsDirty(true);
        }
    }, [onNodesChange]);

    const handleEdgesChange = useCallback((changes) => {
        onEdgesChange(changes);
        if (changes.some(c => DIRTY_CHANGE_TYPES.has(c.type))) {
            setIsDirty(true);
        }
    }, [onEdgesChange]);

    // ── Edge connection ─────────────────────────────────────────────────────

    const handleConnect = useCallback((connection) => {
        const edgeId = `${connection.source}__${connection.target}`;
        setEdges(prev => {
            // Duplikátum ellenőrzés
            if (prev.some(e => e.source === connection.source && e.target === connection.target)) {
                return prev;
            }
            return [...prev, {
                id: edgeId,
                source: connection.source,
                target: connection.target,
                type: 'transitionEdge',
                data: {
                    label: 'Új átmenet',
                    direction: 'forward',
                    allowedGroups: []
                }
            }];
        });
        setSelectedEdgeId(edgeId);
        setSelectedNodeId(null);
        setIsDirty(true);
    }, [setEdges]);

    // ── Sidebar: node/edge adat módosítás ──────────────────────────────────

    const selectedNode = useMemo(
        () => selectedNodeId ? nodes.find(n => n.id === selectedNodeId) : null,
        [nodes, selectedNodeId]
    );

    const selectedEdge = useMemo(
        () => selectedEdgeId ? edges.find(e => e.id === selectedEdgeId) : null,
        [edges, selectedEdgeId]
    );

    // Elérhető csoportok: a metadata.contributorGroups slug-jaiból
    const availableGroups = useMemo(
        () => (metadata.contributorGroups || []).map(cg => cg.slug),
        [metadata.contributorGroups]
    );

    const handleNodeDataChange = useCallback((newData) => {
        if (!selectedNodeId) return;

        // Ha isInitial bekapcsolva, minden más node-nál kikapcsoljuk
        if (newData.isInitial) {
            setNodes(prev => prev.map(n => ({
                ...n,
                data: n.id === selectedNodeId
                    ? newData
                    : { ...n.data, isInitial: false }
            })));
        } else {
            setNodes(prev => prev.map(n =>
                n.id === selectedNodeId ? { ...n, data: newData } : n
            ));
        }
        setIsDirty(true);
    }, [selectedNodeId, setNodes]);

    const handleEdgeDataChange = useCallback((newData) => {
        if (!selectedEdgeId) return;
        setEdges(prev => prev.map(e =>
            e.id === selectedEdgeId ? { ...e, data: newData } : e
        ));
        setIsDirty(true);
    }, [selectedEdgeId, setEdges]);

    const handleDeleteNode = useCallback(() => {
        if (!selectedNodeId) return;
        setNodes(prev => prev.filter(n => n.id !== selectedNodeId));
        // Kapcsolódó edge-ek törlése
        setEdges(prev => prev.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId));
        setSelectedNodeId(null);
        setIsDirty(true);
    }, [selectedNodeId, setNodes, setEdges]);

    const handleDeleteEdge = useCallback(() => {
        if (!selectedEdgeId) return;
        setEdges(prev => prev.filter(e => e.id !== selectedEdgeId));
        setSelectedEdgeId(null);
        setIsDirty(true);
    }, [selectedEdgeId, setEdges]);

    const handleMetadataChange = useCallback((newMetadata) => {
        setMetadata(newMetadata);
        setIsDirty(true);
    }, []);

    // ── DnD: új node létrehozás a palette-ból ────────────────────────────────

    const nodeIdCounter = useRef(0);

    const handleDragOver = useCallback((event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);

    const handleDrop = useCallback((event) => {
        event.preventDefault();
        const type = event.dataTransfer.getData('application/maestro-node-type');
        if (type !== 'stateNode') return;

        const color = event.dataTransfer.getData('application/maestro-node-color') || '#888';
        const rfInstance = reactFlowRef.current;
        if (!rfInstance) return;

        const position = rfInstance.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY
        });

        nodeIdCounter.current += 1;
        const newId = `state_${Date.now()}_${nodeIdCounter.current}`;

        const newNode = {
            id: newId,
            type: 'stateNode',
            position,
            data: {
                id: newId,
                label: 'Új állapot',
                color,
                duration: { perPage: 0, fixed: 0 },
                isInitial: false,
                isTerminal: false,
                validations: { onEntry: [], requiredToEnter: [], requiredToExit: [] },
                commands: [],
                statePermissions: []
            }
        };

        setNodes(prev => [...prev, newNode]);
        setSelectedNodeId(newId);
        setSelectedEdgeId(null);
        setIsDirty(true);
    }, [setNodes]);

    // ── Mentés ──────────────────────────────────────────────────────────────

    const handleSave = useCallback(async () => {
        if (isSaving) return;
        setSaveError(null);

        // 1. Compiled JSON generálás
        const compiled = graphToCompiled(nodes, edges, metadata);

        // 2. Validáció
        const { valid, errors } = validateWorkflow(compiled);
        if (!valid) {
            setSaveError(errors[0]);
            return;
        }

        // 3. Törölt state ID ellenőrzés — van-e cikk az eltávolított állapotokban?
        const currentStateIds = new Set(compiled.states.map(s => s.id));
        const removedIds = [...originalStateIdsRef.current].filter(id => !currentStateIds.has(id));

        if (removedIds.length > 0) {
            try {
                const client = getClient();
                const databases = new Databases(client);
                const articlesInRemoved = await databases.listDocuments(
                    DATABASE_ID,
                    COLLECTIONS.ARTICLES,
                    [
                        Query.equal('state', removedIds),
                        Query.equal('editorialOfficeId', officeId),
                        Query.limit(1)
                    ]
                );
                if (articlesInRemoved.documents.length > 0) {
                    const affectedState = articlesInRemoved.documents[0].state;
                    setSaveError(`Nem törölhető a(z) "${affectedState}" állapot — vannak benne cikkek.`);
                    return;
                }
            } catch {
                setSaveError('Nem sikerült ellenőrizni, hogy vannak-e cikkek a törölt állapotokban. Próbáld újra.');
                return;
            }
        }

        // 4. Graph pozíciók
        const viewport = reactFlowRef.current?.getViewport() || null;
        const graph = extractGraphData(nodes, viewport);

        // 5. Mentés a szerverre
        setIsSaving(true);
        try {
            const result = await saveWorkflow(officeId, compiled, graph, version);
            setVersion(result.version);
            setIsDirty(false);
            setSaveError(null);
            originalStateIdsRef.current = currentStateIds;
        } catch (err) {
            setSaveError(err.message || 'Mentési hiba.');
        } finally {
            setIsSaving(false);
        }
    }, [isSaving, nodes, edges, metadata, officeId, version]);

    // ── Export / Import ───────────────────────────────────────────────────

    const handleExport = useCallback(() => {
        const viewport = reactFlowRef.current?.getViewport() || null;
        exportWorkflow(nodes, edges, metadata, viewport);
    }, [nodes, edges, metadata]);

    const handleImport = useCallback((importedNodes, importedEdges, importedMetadata, importedViewport) => {
        setNodes(importedNodes);
        setEdges(importedEdges);
        setMetadata(importedMetadata);
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        setIsDirty(true);
        if (importedViewport && reactFlowRef.current) {
            reactFlowRef.current.setViewport(importedViewport);
        }
    }, [setNodes, setEdges]);

    // ── ReactFlow init ──────────────────────────────────────────────────────

    const handleInit = useCallback((instance) => {
        reactFlowRef.current = instance;
    }, []);

    // ── Renderelés ──────────────────────────────────────────────────────────

    if (isLoading) {
        return (
            <div className="workflow-designer-page">
                <div className="loading-overlay">
                    <div className="spinner" />
                    <span>Workflow betöltése...</span>
                </div>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="workflow-designer-page">
                <div className="workflow-designer-scaffold">
                    <Link to="/" className="auth-link" style={{ marginBottom: 16, display: 'inline-block' }}>
                        ← Vissza a kiadványokhoz
                    </Link>
                    <p style={{ color: 'var(--c-error, #f87171)' }}>{loadError}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="workflow-designer-page">
            {/* Toolbar */}
            <div className="workflow-designer-toolbar">
                <div className="workflow-designer-toolbar__left">
                    <Link to="/" className="workflow-designer-toolbar__back" title="Vissza a kiadványokhoz">
                        ←
                    </Link>
                    <h2 className="workflow-designer-toolbar__title">Workflow Tervező</h2>
                    <span className="workflow-designer-toolbar__version">v{version}</span>
                </div>
                <div className="workflow-designer-toolbar__right">
                    {saveError && <span className="workflow-designer-toolbar__error">{saveError}</span>}
                    {isDirty && !saveError && <span className="workflow-designer-toolbar__dirty">Nem mentett változások</span>}
                    <button
                        type="button"
                        className="workflow-designer-toolbar__btn-secondary"
                        onClick={handleExport}
                        title="Workflow exportálása JSON-be"
                    >
                        Export
                    </button>
                    <button
                        type="button"
                        className="workflow-designer-toolbar__btn-secondary"
                        onClick={() => setIsImportOpen(true)}
                        title="Workflow importálása JSON-ből"
                    >
                        Import
                    </button>
                    <button
                        type="button"
                        className="workflow-designer-toolbar__save"
                        onClick={handleSave}
                        disabled={!isDirty || isSaving || !!remoteVersionWarning}
                    >
                        {isSaving ? 'Mentés...' : 'Mentés'}
                    </button>
                </div>
            </div>

            {/* Realtime figyelmeztetés */}
            {remoteVersionWarning && (
                <div className="workflow-designer-remote-warning">
                    <span>{remoteVersionWarning}</span>
                    <button
                        type="button"
                        className="workflow-designer-remote-warning__btn"
                        onClick={() => window.location.reload()}
                    >
                        Újratöltés
                    </button>
                </div>
            )}

            {/* Fő tartalom: palette + canvas + sidebar */}
            <div className="workflow-designer-body">
                <NodePalette nodeCount={nodes.length} />
                <WorkflowCanvas
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={handleEdgesChange}
                    onNodeClick={handleNodeClick}
                    onEdgeClick={handleEdgeClick}
                    onPaneClick={handlePaneClick}
                    onConnect={handleConnect}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onInit={handleInit}
                    defaultViewport={defaultViewportRef.current}
                />
                <PropertiesSidebar
                    selectedNode={selectedNode}
                    selectedEdge={selectedEdge}
                    onNodeDataChange={handleNodeDataChange}
                    onEdgeDataChange={handleEdgeDataChange}
                    onDeleteNode={handleDeleteNode}
                    onDeleteEdge={handleDeleteEdge}
                    availableGroups={availableGroups}
                    version={version}
                    metadata={metadata}
                    onMetadataChange={handleMetadataChange}
                />
            </div>

            {/* Import dialógus */}
            <ImportDialog
                isOpen={isImportOpen}
                onClose={() => setIsImportOpen(false)}
                currentNodes={nodes}
                currentEdges={edges}
                currentMetadata={metadata}
                onImport={handleImport}
            />

            {/* Navigáció blokkoló dialógus */}
            {blocker.state === 'blocked' && (
                <div className="import-dialog__overlay" onClick={() => blocker.reset()}>
                    <div className="import-dialog" onClick={e => e.stopPropagation()}>
                        <h3 className="import-dialog__title">Nem mentett változások</h3>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary, #999)', margin: '0 0 16px' }}>
                            A workflow nem mentett változásokat tartalmaz. Biztosan elhagyod az oldalt?
                        </p>
                        <div className="import-dialog__actions">
                            <button
                                type="button"
                                className="import-dialog__btn import-dialog__btn--cancel"
                                onClick={() => blocker.reset()}
                            >
                                Maradok
                            </button>
                            <button
                                type="button"
                                className="import-dialog__btn import-dialog__btn--confirm"
                                onClick={() => blocker.proceed()}
                            >
                                Elhagyom
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
