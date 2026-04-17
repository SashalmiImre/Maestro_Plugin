/**
 * Maestro Dashboard — Workflow Designer oldal
 *
 * A vizuális workflow szerkesztő gyökér komponense.
 * Route: /admin/office/:officeId/workflow/:workflowId
 *
 * Betölti a teljes workflow dokumentumot (compiled + graph),
 * konvertálja xyflow állapotra, és rendereli a canvast.
 *
 * Egy szerkesztőség több workflow-t is tarthat (Fázis 7). A toolbar
 * selector dropdown-ja engedi a váltást, a „+ Új workflow" gomb új
 * workflow-t hoz létre (CF `create_workflow` action).
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, Link, useBlocker, useNavigate } from 'react-router-dom';
import { useNodesState, useEdgesState } from '@xyflow/react';
import { Databases, Query } from 'appwrite';
import { getClient } from '../../contexts/AuthContext.jsx';
import { DATABASE_ID, COLLECTIONS } from '../../config.js';
import { useData } from '../../contexts/DataContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { compiledToGraph, graphToCompiled, extractGraphData } from './compiler.js';
import { validateWorkflow } from './validator.js';
import { saveWorkflow, createWorkflow } from './api.js';
import { exportWorkflow } from './exportImport.js';

import NodePalette from './NodePalette.jsx';
import ImportDialog from './ImportDialog.jsx';
import WorkflowCanvas from './WorkflowCanvas.jsx';
import PropertiesSidebar from './PropertiesSidebar.jsx';
import './workflowDesigner.css';

/** Graph-mutáló change típusok, amelyeknél dirty-t kell állítani */
const DIRTY_CHANGE_TYPES = new Set(['remove', 'add', 'replace']);

export default function WorkflowDesignerPage() {
    const { officeId, workflowId } = useParams();
    const navigate = useNavigate();
    const { workflows: availableWorkflows, publications } = useData();
    const { showToast } = useToast();

    // ── Workflow dokumentum ─────────────────────────────────────────────────
    const [workflowDocId, setWorkflowDocId] = useState(null);
    const [workflowName, setWorkflowName] = useState('');
    const [originalName, setOriginalName] = useState('');
    const [version, setVersion] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);

    // ── Új workflow dialog állapot ──────────────────────────────────────────
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [createName, setCreateName] = useState('');
    const [createError, setCreateError] = useState(null);
    const [isCreating, setIsCreating] = useState(false);

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
    // Dirty split: a graph mutációi külön állapotban (isGraphDirty) maradnak,
    // a név-változás pedig az originálissal való direkt összehasonlításból
    // származik (isNameDirty). Így ha a felhasználó vissza-gépeli az eredeti
    // nevet, a dirty jelzés automatikusan eltűnik — nem ragad be.
    const [isGraphDirty, setIsGraphDirty] = useState(false);
    const isNameDirty = workflowName.trim() !== originalName;
    const isDirty = isGraphDirty || isNameDirty;
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [isImportOpen, setIsImportOpen] = useState(false);
    const [remoteVersionWarning, setRemoteVersionWarning] = useState(null);

    const reactFlowRef = useRef(null);
    const defaultViewportRef = useRef(null);
    const versionRef = useRef(0);
    const originalStateIdsRef = useRef(new Set());

    // ── Snapshot usage count (#39) ──────────────────────────────────────────
    // Azok az aktivált publikációk, amelyek ezt a workflow-t már snapshot-olták
    // (a saját `compiledWorkflowSnapshot` mezőjükben egy pillanatképet őriznek).
    // A workflow módosításai ezekre a publikációkra NEM érvényesülnek — a
    // designer banner figyelmezteti a szerkesztőt erről a szándékos viselkedésről.
    const snapshotUsageCount = useMemo(() => {
        if (!workflowDocId || !Array.isArray(publications)) return 0;
        return publications.filter(p =>
            p.isActivated === true
            && p.workflowId === workflowDocId
            && typeof p.compiledWorkflowSnapshot === 'string'
            && p.compiledWorkflowSnapshot.length > 0
        ).length;
    }, [publications, workflowDocId]);

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
    // A workflowId route param szerint töltjük be a konkrét workflow doc-ot.
    // Scope check: a doc editorialOfficeId-ja egyezzen a route officeId-vel.

    useEffect(() => {
        if (!officeId || !workflowId) return;
        let cancelled = false;

        (async () => {
            setIsLoading(true);
            setLoadError(null);
            // Dirty és remote-version warning resetelése új workflow-ra
            // váltáskor — nem hurcoljuk tovább a régi állapotot.
            setIsGraphDirty(false);
            setSaveError(null);
            setRemoteVersionWarning(null);
            try {
                const client = getClient();
                const databases = new Databases(client);
                const doc = await databases.getDocument(
                    DATABASE_ID,
                    COLLECTIONS.WORKFLOWS,
                    workflowId
                );

                if (cancelled) return;

                if (doc.editorialOfficeId !== officeId) {
                    setLoadError('Ez a workflow nem az adott szerkesztőséghez tartozik.');
                    return;
                }

                const compiled = typeof doc.compiled === 'string'
                    ? JSON.parse(doc.compiled) : doc.compiled;
                const savedGraph = doc.graph
                    ? (typeof doc.graph === 'string' ? JSON.parse(doc.graph) : doc.graph)
                    : null;

                setWorkflowDocId(doc.$id);
                setWorkflowName(doc.name || '');
                setOriginalName(doc.name || '');
                setVersion(compiled?.version ?? doc.version ?? 1);

                const { nodes: n, edges: e, metadata: m, viewport } = compiledToGraph(compiled, savedGraph);
                setNodes(n);
                setEdges(e);
                setMetadata(m);
                defaultViewportRef.current = viewport;
                originalStateIdsRef.current = new Set(n.map(node => node.id));
            } catch (err) {
                if (!cancelled) {
                    const code = err?.code || err?.response?.code;
                    if (code === 404) {
                        setLoadError('Nem található a workflow. Lehet, hogy időközben törölve lett.');
                    } else {
                        setLoadError('Workflow betöltési hiba: ' + (err?.message || 'Ismeretlen hiba'));
                    }
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [officeId, workflowId]); // eslint-disable-line react-hooks/exhaustive-deps

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
            setIsGraphDirty(true);
        }
    }, [onNodesChange]);

    const handleEdgesChange = useCallback((changes) => {
        onEdgesChange(changes);
        if (changes.some(c => DIRTY_CHANGE_TYPES.has(c.type))) {
            setIsGraphDirty(true);
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
        setIsGraphDirty(true);
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
        setIsGraphDirty(true);
    }, [selectedNodeId, setNodes]);

    const handleEdgeDataChange = useCallback((newData) => {
        if (!selectedEdgeId) return;
        setEdges(prev => prev.map(e =>
            e.id === selectedEdgeId ? { ...e, data: newData } : e
        ));
        setIsGraphDirty(true);
    }, [selectedEdgeId, setEdges]);

    const handleDeleteNode = useCallback(() => {
        if (!selectedNodeId) return;
        setNodes(prev => prev.filter(n => n.id !== selectedNodeId));
        // Kapcsolódó edge-ek törlése
        setEdges(prev => prev.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId));
        setSelectedNodeId(null);
        setIsGraphDirty(true);
    }, [selectedNodeId, setNodes, setEdges]);

    const handleDeleteEdge = useCallback(() => {
        if (!selectedEdgeId) return;
        setEdges(prev => prev.filter(e => e.id !== selectedEdgeId));
        setSelectedEdgeId(null);
        setIsGraphDirty(true);
    }, [selectedEdgeId, setEdges]);

    const handleMetadataChange = useCallback((newMetadata) => {
        setMetadata(newMetadata);
        setIsGraphDirty(true);
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
        setIsGraphDirty(true);
    }, [setNodes]);

    // ── Mentés ──────────────────────────────────────────────────────────────

    const handleSave = useCallback(async () => {
        if (isSaving) return;
        setSaveError(null);

        // Név validáció — rename esetén
        const trimmedName = workflowName.trim();
        if (!trimmedName) {
            setSaveError('A workflow neve nem lehet üres.');
            return;
        }

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

        // 5. Mentés a szerverre — opcionális rename-mel
        setIsSaving(true);
        try {
            const nameToSend = trimmedName !== originalName ? trimmedName : undefined;
            const result = await saveWorkflow(officeId, workflowDocId, compiled, graph, version, nameToSend);
            setVersion(result.version);
            setIsGraphDirty(false);
            setSaveError(null);
            originalStateIdsRef.current = currentStateIds;
            if (nameToSend !== undefined) {
                setOriginalName(trimmedName);
            }
        } catch (err) {
            setSaveError(err.message || 'Mentési hiba.');
        } finally {
            setIsSaving(false);
        }
    }, [isSaving, nodes, edges, metadata, officeId, workflowDocId, version, workflowName, originalName]);

    // ── Workflow switch (selector dropdown) ────────────────────────────────

    const handleSwitchWorkflow = useCallback((newWorkflowId) => {
        if (!newWorkflowId || newWorkflowId === workflowDocId) return;
        // A useBlocker elkapja a dirty állapotot, a felhasználó maradhat
        // vagy elhagyhatja az oldalt — mindkét útvonalat a standard blocker kezeli.
        navigate(`/admin/office/${officeId}/workflow/${newWorkflowId}`);
    }, [workflowDocId, officeId, navigate]);

    // ── Új workflow létrehozás ─────────────────────────────────────────────

    const handleOpenCreateDialog = useCallback(() => {
        setCreateName('');
        setCreateError(null);
        setIsCreateOpen(true);
    }, []);

    const handleConfirmCreate = useCallback(async () => {
        const trimmed = createName.trim();
        if (!trimmed) {
            setCreateError('A név megadása kötelező.');
            return;
        }
        setIsCreating(true);
        setCreateError(null);
        try {
            const result = await createWorkflow(officeId, trimmed);
            showToast(`Workflow létrehozva: „${result.name}".`, 'success');
            setIsCreateOpen(false);
            // Navigáció az új workflow szerkesztőjére — a useBlocker
            // elkapja, ha dirty, és rákérdez.
            navigate(`/admin/office/${officeId}/workflow/${result.workflowId}`);
        } catch (err) {
            setCreateError(err.message || 'Létrehozási hiba.');
        } finally {
            setIsCreating(false);
        }
    }, [createName, officeId, navigate, showToast]);

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
        setIsGraphDirty(true);
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
                    <Link
                        to="/"
                        className="workflow-designer-toolbar__back"
                        title="Vissza a kiadványokhoz"
                        aria-label="Vissza a kiadványokhoz"
                    >
                        <span aria-hidden="true">←</span>
                    </Link>
                    <input
                        type="text"
                        className="workflow-designer-toolbar__name"
                        value={workflowName}
                        onChange={(e) => setWorkflowName(e.target.value)}
                        placeholder="Workflow neve"
                        maxLength={128}
                        aria-label="Workflow neve"
                    />
                    {availableWorkflows && availableWorkflows.length > 1 && (
                        <select
                            className="workflow-designer-toolbar__selector"
                            value={workflowDocId || ''}
                            onChange={(e) => handleSwitchWorkflow(e.target.value)}
                            aria-label="Workflow váltás"
                        >
                            {availableWorkflows.map((wf) => (
                                <option key={wf.$id} value={wf.$id}>{wf.name}</option>
                            ))}
                        </select>
                    )}
                    <span className="workflow-designer-toolbar__version">v{version}</span>
                </div>
                <div className="workflow-designer-toolbar__right">
                    {saveError && <span className="workflow-designer-toolbar__error">{saveError}</span>}
                    {isDirty && !saveError && <span className="workflow-designer-toolbar__dirty">Nem mentett változások</span>}
                    <button
                        type="button"
                        className="workflow-designer-toolbar__btn-secondary"
                        onClick={handleOpenCreateDialog}
                        title="Új workflow létrehozása ebben a szerkesztőségben"
                    >
                        + Új workflow
                    </button>
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

            {/* Snapshot használat figyelmeztetés (#39) */}
            {snapshotUsageCount > 0 && (
                <div className="workflow-designer-snapshot-info">
                    <span>
                        Ezt a workflow-t már {snapshotUsageCount} aktív publikáció használja
                        snapshot-ként — a mentett módosítások csak új aktiválásoknál érvényesülnek.
                        A meglévő publikációk a saját, rögzített verziójukon futnak tovább.
                    </span>
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

            {/* Új workflow dialógus */}
            {isCreateOpen && (
                <div className="import-dialog__overlay" onClick={() => !isCreating && setIsCreateOpen(false)}>
                    <div className="import-dialog" onClick={e => e.stopPropagation()}>
                        <h3 className="import-dialog__title">Új workflow létrehozása</h3>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary, #999)', margin: '0 0 12px' }}>
                            Add meg az új workflow nevét. A default állapotgépből indul.
                        </p>
                        <input
                            type="text"
                            className="workflow-designer-toolbar__name"
                            style={{ width: '100%', marginBottom: 12 }}
                            value={createName}
                            onChange={(e) => setCreateName(e.target.value)}
                            placeholder="Workflow neve"
                            maxLength={128}
                            autoFocus
                            disabled={isCreating}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !isCreating) handleConfirmCreate();
                            }}
                        />
                        {createError && (
                            <p className="import-dialog__error" style={{ marginBottom: 12 }}>{createError}</p>
                        )}
                        <div className="import-dialog__actions">
                            <button
                                type="button"
                                className="import-dialog__btn import-dialog__btn--cancel"
                                onClick={() => setIsCreateOpen(false)}
                                disabled={isCreating}
                            >
                                Mégse
                            </button>
                            <button
                                type="button"
                                className="import-dialog__btn import-dialog__btn--confirm"
                                onClick={handleConfirmCreate}
                                disabled={isCreating || !createName.trim()}
                            >
                                {isCreating ? 'Létrehozás...' : 'Létrehozás'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

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
