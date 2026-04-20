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
import { getClient, useAuth } from '../../contexts/AuthContext.jsx';
import { subscribeRealtime, documentChannel } from '../../contexts/realtimeBus.js';
import { useData } from '../../contexts/DataContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useMediaQuery, BREAKPOINTS } from '../../hooks/useMediaQuery.js';
import { DATABASE_ID, COLLECTIONS } from '../../config.js';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import CreateWorkflowModal from '../../components/workflows/CreateWorkflowModal.jsx';
import { WORKFLOW_VISIBILITY_DEFAULT, WORKFLOW_VISIBILITY_LABELS } from '@shared/constants.js';
import { compiledToGraph, graphToCompiled, extractGraphData } from './compiler.js';
import { validateWorkflow } from './validator.js';
import { saveWorkflow, duplicateWorkflow } from './api.js';
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
    const { workflows: availableWorkflows, publications, getMemberName } = useData();
    const { user } = useAuth();
    const { activeEditorialOfficeId } = useScope();
    const { showToast } = useToast();
    const { openModal } = useModal();
    const confirm = useConfirm();
    // A xyflow canvas drag&drop-ja érintésen nem használható, + a properties
    // sidebar és a node palette szűk képernyőn nem férnek el egyszerre.
    // Mobilon csak tájékoztató képernyőt adunk.
    const isBelowWorkflowMin = useMediaQuery(BREAKPOINTS.tablet);

    // ── Workflow dokumentum ─────────────────────────────────────────────────
    const [workflowDocId, setWorkflowDocId] = useState(null);
    const [workflowName, setWorkflowName] = useState('');
    const [originalName, setOriginalName] = useState('');
    const [workflowDescription, setWorkflowDescription] = useState('');
    const [workflowVisibility, setWorkflowVisibility] = useState(WORKFLOW_VISIBILITY_DEFAULT);
    const [workflowOwnerOfficeId, setWorkflowOwnerOfficeId] = useState(null);
    const [workflowCreatedBy, setWorkflowCreatedBy] = useState(null);
    const [version, setVersion] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);

    // ── Read-only (#84) ──
    // A workflow MÁS szerkesztőséghez tartozik (foreign public/organization),
    // vagy a doc archivált. Megnyitható, de nem szerkeszthető — a "Duplikál
    // & szerkeszt" CTA a user saját scope-jába másolja.
    const isForeign = workflowOwnerOfficeId !== null && workflowOwnerOfficeId !== activeEditorialOfficeId;
    const isReadOnly = isForeign;
    const isDuplicating = useRef(false);

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
    // #73: oldalpanel collapse — localStorage-perzisztált, a designerbe visszatérve
    // megőrződik a felhasználó preferenciája (széles canvas vs. teljes panelek).
    const [isPaletteCollapsed, setIsPaletteCollapsed] = useState(() => {
        try { return localStorage.getItem('maestro.workflowDesigner.paletteCollapsed') === '1'; }
        catch { return false; }
    });
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
        try { return localStorage.getItem('maestro.workflowDesigner.sidebarCollapsed') === '1'; }
        catch { return false; }
    });
    const togglePaletteCollapsed = useCallback(() => {
        setIsPaletteCollapsed(prev => {
            const next = !prev;
            try { localStorage.setItem('maestro.workflowDesigner.paletteCollapsed', next ? '1' : '0'); } catch {}
            return next;
        });
    }, []);
    const toggleSidebarCollapsed = useCallback(() => {
        setIsSidebarCollapsed(prev => {
            const next = !prev;
            try { localStorage.setItem('maestro.workflowDesigner.sidebarCollapsed', next ? '1' : '0'); } catch {}
            return next;
        });
    }, []);

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

                // Archivált workflow → hard error (a könyvtárból vissza kell
                // állítani szerkesztés előtt).
                if (doc.archivedAt) {
                    setLoadError('Ez a workflow archivált. Előbb állítsd vissza az „Archivált" fülből.');
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
                setWorkflowDescription(doc.description || '');
                setWorkflowVisibility(doc.visibility || WORKFLOW_VISIBILITY_DEFAULT);
                setWorkflowOwnerOfficeId(doc.editorialOfficeId || null);
                setWorkflowCreatedBy(doc.createdBy || null);
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
        const channel = documentChannel(COLLECTIONS.WORKFLOWS, workflowDocId);

        const unsubscribe = subscribeRealtime([channel], (response) => {
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
        if (isReadOnly) {
            // Csak a „select" eseményeket engedjük át — így a user még mindig
            // ki tud választani egy node-ot a PropertiesSidebar megtekintéséhez,
            // de semmi mutáció nem megy át.
            const passthrough = changes.filter(c => c.type === 'select' || c.type === 'dimensions');
            if (passthrough.length > 0) onNodesChange(passthrough);
            return;
        }
        onNodesChange(changes);
        if (changes.some(c =>
            DIRTY_CHANGE_TYPES.has(c.type) ||
            (c.type === 'position' && c.dragging === false)
        )) {
            setIsGraphDirty(true);
        }
    }, [onNodesChange, isReadOnly]);

    const handleEdgesChange = useCallback((changes) => {
        if (isReadOnly) {
            const passthrough = changes.filter(c => c.type === 'select');
            if (passthrough.length > 0) onEdgesChange(passthrough);
            return;
        }
        onEdgesChange(changes);
        if (changes.some(c => DIRTY_CHANGE_TYPES.has(c.type))) {
            setIsGraphDirty(true);
        }
    }, [onEdgesChange, isReadOnly]);

    // ── Edge connection ─────────────────────────────────────────────────────

    const handleConnect = useCallback((connection) => {
        if (isReadOnly) return;
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
    }, [setEdges, isReadOnly]);

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

    // A canvason már használt színek (NodePalette next-color logikájához, #61)
    const usedNodeColors = useMemo(
        () => nodes.map(n => n.data?.color).filter(Boolean),
        [nodes]
    );

    // State slug → label térkép a TransitionPropertiesEditor „Útvonal" részéhez (#65)
    const stateLabels = useMemo(() => {
        const map = {};
        for (const n of nodes) {
            if (n?.id) map[n.id] = n.data?.label || n.id;
        }
        return map;
    }, [nodes]);

    const handleNodeDataChange = useCallback((newData) => {
        if (isReadOnly) return;
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
    }, [selectedNodeId, setNodes, isReadOnly]);

    const handleEdgeDataChange = useCallback((newData) => {
        if (isReadOnly) return;
        if (!selectedEdgeId) return;
        setEdges(prev => prev.map(e =>
            e.id === selectedEdgeId ? { ...e, data: newData } : e
        ));
        setIsGraphDirty(true);
    }, [selectedEdgeId, setEdges, isReadOnly]);

    const handleDeleteNode = useCallback(async () => {
        if (isReadOnly) return;
        if (!selectedNodeId) return;
        const node = nodes.find(n => n.id === selectedNodeId);
        const stateName = node?.data?.label || selectedNodeId;
        const ok = await confirm({
            title: 'Állapot törlése',
            message: `Biztosan törlöd a(z) „${stateName}" állapotot? Az állapothoz tartozó összes átmenet is törlődik. Ha egy aktív kiadványban van cikk ebben az állapotban, az aktiválás után a mentés hibát adhat — előbb vidd át a cikkeket egy másik állapotba.`,
            confirmLabel: 'Törlés',
            variant: 'danger'
        });
        if (!ok) return;
        setNodes(prev => prev.filter(n => n.id !== selectedNodeId));
        // Kapcsolódó edge-ek törlése
        setEdges(prev => prev.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId));
        setSelectedNodeId(null);
        setIsGraphDirty(true);
    }, [selectedNodeId, nodes, confirm, setNodes, setEdges, isReadOnly]);

    const handleDeleteEdge = useCallback(async () => {
        if (isReadOnly) return;
        if (!selectedEdgeId) return;
        const edge = edges.find(e => e.id === selectedEdgeId);
        const edgeLabel = edge?.data?.label || `${edge?.source} → ${edge?.target}`;
        const ok = await confirm({
            title: 'Átmenet törlése',
            message: `Biztosan törlöd a(z) „${edgeLabel}" átmenetet?`,
            confirmLabel: 'Törlés',
            variant: 'danger'
        });
        if (!ok) return;
        setEdges(prev => prev.filter(e => e.id !== selectedEdgeId));
        setSelectedEdgeId(null);
        setIsGraphDirty(true);
    }, [selectedEdgeId, edges, confirm, setEdges, isReadOnly]);

    const handleMetadataChange = useCallback((newMetadata) => {
        if (isReadOnly) return;
        setMetadata(newMetadata);
        setIsGraphDirty(true);
    }, [isReadOnly]);

    // ── DnD: új node létrehozás a palette-ból ────────────────────────────────

    const nodeIdCounter = useRef(0);

    const handleDragOver = useCallback((event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);

    const handleDrop = useCallback((event) => {
        event.preventDefault();
        if (isReadOnly) return;
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
    }, [setNodes, isReadOnly]);

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
        openModal(
            <CreateWorkflowModal editorialOfficeId={officeId} />,
            { title: 'Új workflow', size: 'sm' }
        );
    }, [openModal, officeId]);

    // ── Duplikál & szerkeszt (foreign workflow → user saját scope-ja) ──────

    const handleDuplicate = useCallback(async () => {
        if (isDuplicating.current) return;
        if (!activeEditorialOfficeId || !workflowDocId) return;
        isDuplicating.current = true;
        try {
            const result = await duplicateWorkflow(activeEditorialOfficeId, workflowDocId);
            showToast(`Workflow duplikálva: „${result.name}".`, 'success');
            navigate(`/admin/office/${activeEditorialOfficeId}/workflow/${result.workflowId}`);
        } catch (err) {
            showToast(err?.message || 'Nem sikerült a duplikálás.', 'error');
        } finally {
            isDuplicating.current = false;
        }
    }, [activeEditorialOfficeId, workflowDocId, navigate, showToast]);

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

    // Mobil/tablet: desktop-only felület → informatív képernyő.
    // Előre-visszatérő: a guard nem teljesíti a hook-szabályokat, ha a hookok
    // után van, ezért kizárólag a hookok lefutása után térünk vissza.
    if (isBelowWorkflowMin) {
        return (
            <div className="workflow-designer-page">
                <div className="workflow-designer-desktop-only">
                    <div className="workflow-designer-desktop-only__card">
                        <svg
                            width="48"
                            height="48"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                        >
                            <rect x="2" y="4" width="20" height="12" rx="2" />
                            <line x1="8" y1="20" x2="16" y2="20" />
                            <line x1="12" y1="16" x2="12" y2="20" />
                        </svg>
                        <h1 className="workflow-designer-desktop-only__title">
                            A Workflow tervező asztali nézetre van optimalizálva
                        </h1>
                        <p className="workflow-designer-desktop-only__desc">
                            A vizuális szerkesztő drag &amp; drop canvasa, a node-paletta és a
                            tulajdonság oldalsáv nem fér el kis képernyőn. Nyisd meg a
                            Dashboard-ot legalább 960 pixel széles eszközön (laptop vagy
                            asztali gép) a workflow szerkesztéséhez.
                        </p>
                        <Link to="/" className="workflow-designer-desktop-only__btn">
                            ← Vissza a kiadványokhoz
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

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
                        disabled={isReadOnly}
                        readOnly={isReadOnly}
                    />
                    {/* Dirty indikátor (#63): piros pötty a név mellett — VS Code tab minta.
                        A jobb oldali szöveg redundáns, eltávolítva — ezt a pötty viseli. */}
                    {isDirty && !isReadOnly && (
                        <span
                            className="workflow-designer-toolbar__dirty-dot"
                            role="status"
                            aria-label="Nem mentett változások"
                            title="Nem mentett változások"
                        />
                    )}
                    {/* Láthatóság chip — kontextualizálja a workflow scope-ját
                        a toolbar-on; a foreign esetben különösen hasznos. */}
                    <span
                        className={`workflow-designer-toolbar__scope-chip is-${workflowVisibility}`}
                        title={`Láthatóság: ${WORKFLOW_VISIBILITY_LABELS[workflowVisibility] || workflowVisibility}`}
                    >
                        {WORKFLOW_VISIBILITY_LABELS[workflowVisibility] || workflowVisibility}
                    </span>
                    {availableWorkflows && availableWorkflows.length > 1 && !isReadOnly && (
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
                    {/* #79: verzió chip — amíg nincs valódi verziózás (mindig v1
                        vagy a Realtime version increment-ek), a chip felesleges zaj.
                        Csak akkor mutatjuk, ha v2+ — egyébként optimistic
                        concurrency token-ként rejtve marad a state-ben. */}
                    {version > 1 && (
                        <span
                            className="workflow-designer-toolbar__version"
                            title="Optimistic concurrency token — minden mentés inkrementálja a szervezeti workflow-konfliktusok elkerülésére."
                        >
                            v{version}
                        </span>
                    )}
                </div>
                <div className="workflow-designer-toolbar__right">
                    {saveError && <span className="workflow-designer-toolbar__error">{saveError}</span>}
                    {isDirty && !saveError && !isReadOnly && <span className="workflow-designer-toolbar__dirty">Nem mentett változások</span>}
                    {isReadOnly ? (
                        <>
                            <span className="workflow-designer-toolbar__readonly-label" title="Ez a workflow másik szerkesztőséghez tartozik — duplikálással tudod szerkeszteni.">
                                Csak olvasható
                            </span>
                            <button
                                type="button"
                                className="workflow-designer-toolbar__save"
                                onClick={handleDuplicate}
                                title="Workflow duplikálása a saját szerkesztőséged alá"
                            >
                                Duplikál & szerkeszt
                            </button>
                        </>
                    ) : (
                        <>
                            {/* Workflow-szintű akció (új doc létrehozása) */}
                            <button
                                type="button"
                                className="workflow-designer-toolbar__btn-secondary"
                                onClick={handleOpenCreateDialog}
                                title="Új workflow létrehozása ebben a szerkesztőségben"
                            >
                                + Új workflow
                            </button>
                            {/* #78: separator — elválasztja az „új workflow" akciót
                                az adat IO csoporttól (Export/Import), így a user nem
                                kattint véletlenül destructive Import-ra. */}
                            <span className="workflow-designer-toolbar__separator" aria-hidden="true" />
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
                            {/* #78: separator — a primary akciót (Mentés) is elválasztjuk
                                az adat IO csoporttól, hogy vizuálisan kiemelkedjen. */}
                            <span className="workflow-designer-toolbar__separator" aria-hidden="true" />
                            <button
                                type="button"
                                className="workflow-designer-toolbar__save"
                                onClick={handleSave}
                                disabled={!isDirty || isSaving || !!remoteVersionWarning}
                            >
                                {isSaving ? 'Mentés...' : 'Mentés'}
                            </button>
                        </>
                    )}
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

            {isReadOnly && (
                <div className="workflow-designer-readonly-banner">
                    <div className="workflow-designer-readonly-banner__main">
                        <strong>Csak olvasható.</strong>{' '}
                        Ez a workflow másik szerkesztőséghez tartozik
                        {workflowCreatedBy && (
                            <> — létrehozta: <em>{getMemberName?.(workflowCreatedBy) || workflowCreatedBy}</em></>
                        )}
                        . A szerkesztéshez duplikáld a saját szerkesztőséged alá.
                        {workflowDescription && (
                            <div className="workflow-designer-readonly-banner__desc">{workflowDescription}</div>
                        )}
                    </div>
                    <button
                        type="button"
                        className="workflow-designer-readonly-banner__btn"
                        onClick={handleDuplicate}
                    >
                        Duplikál & szerkeszt
                    </button>
                </div>
            )}

            {/* Snapshot használat figyelmeztetés (#39, #76).
                #76: 3 mondatos magyarázat → 1 mondatos TL;DR + „Részletek"
                collapse — vizuálisan kevésbé domináns, de a kontextus
                egy kattintással elérhető. */}
            {snapshotUsageCount > 0 && (
                <div className="workflow-designer-snapshot-info">
                    <span className="workflow-designer-snapshot-info__tldr">
                        Ezt a workflow-t {snapshotUsageCount} aktív publikáció snapshot-olta — a mentett módosítások csak új aktiválásoknál érvényesülnek.
                    </span>
                    <details className="workflow-designer-snapshot-info__details">
                        <summary>Részletek</summary>
                        A meglévő aktivált publikációk a saját, rögzített
                        workflow-verziójukon futnak tovább; a Designer-ben
                        elvégzett módosítások csak újraaktiváláskor kerülnek be.
                        Ha az érintett publikációk azonnal a frissített workflow-t
                        kell hogy használják, deaktiváld őket a kiadvány
                        beállításokban, majd aktiváld újra.
                    </details>
                </div>
            )}

            {/* Fő tartalom: palette + canvas + sidebar */}
            <div className="workflow-designer-body">
                <NodePalette
                    usedColors={usedNodeColors}
                    isCollapsed={isPaletteCollapsed}
                    onToggleCollapsed={togglePaletteCollapsed}
                />
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
                    stateLabels={stateLabels}
                    isCollapsed={isSidebarCollapsed}
                    onToggleCollapsed={toggleSidebarCollapsed}
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
