/**
 * Maestro Dashboard — Workflow Compiler
 *
 * Konverziós logika a compiled JSON és az xyflow graph állapot között.
 * - compiledToGraph: DB-ből olvasott compiled → xyflow nodes/edges (betöltéskor)
 * - graphToCompiled: xyflow nodes/edges → compiled JSON (mentéskor)
 */

// ── Auto-layout konstansok ──────────────────────────────────────────────────

const NODE_HORIZONTAL_GAP = 260;
const NODE_VERTICAL_GAP = 160;
const NODES_PER_ROW = 4;
const START_X = 50;
const START_Y = 80;

/**
 * Topológiai sorrend számítás a transitions alapján.
 * Az initial state mindig az első. BFS-t használ.
 *
 * @param {Object[]} states
 * @param {Object[]} transitions
 * @returns {string[]} Rendezett state ID-k
 */
function topologicalOrder(states, transitions) {
    const stateIds = states.map(s => s.id);
    const initialId = states.find(s => s.isInitial)?.id;
    if (!initialId) return stateIds;

    const adj = new Map();
    for (const id of stateIds) adj.set(id, []);
    for (const t of transitions) {
        if (t.direction === 'forward' && adj.has(t.from)) {
            adj.get(t.from).push(t.to);
        }
    }

    const visited = new Set();
    const order = [];
    const queue = [initialId];
    visited.add(initialId);

    while (queue.length > 0) {
        const current = queue.shift();
        order.push(current);
        for (const next of (adj.get(current) || [])) {
            if (!visited.has(next)) {
                visited.add(next);
                queue.push(next);
            }
        }
    }

    // Bármely elérhetetlen state a végére
    for (const id of stateIds) {
        if (!visited.has(id)) order.push(id);
    }

    return order;
}

/**
 * Automatikus grid pozíció kiszámítása topológiai sorrend alapján.
 *
 * @param {number} index - Pozíció a rendezett tömbben
 * @returns {{ x: number, y: number }}
 */
function autoLayoutPosition(index) {
    const row = Math.floor(index / NODES_PER_ROW);
    const col = index % NODES_PER_ROW;
    return {
        x: START_X + col * NODE_HORIZONTAL_GAP,
        y: START_Y + row * NODE_VERTICAL_GAP
    };
}

// ── compiledToGraph ─────────────────────────────────────────────────────────

/**
 * Compiled JSON → xyflow graph állapot konverzió.
 * Betöltéskor és importkor használatos.
 *
 * @param {Object} compiled - A workflows.compiled JSON
 * @param {Object|null} savedGraph - Mentett graph (pozíciók + viewport), ha van
 * @returns {{ nodes: Object[], edges: Object[], metadata: Object, viewport: Object|null }}
 */
export function compiledToGraph(compiled, savedGraph = null) {
    if (!compiled || !compiled.states) {
        return { nodes: [], edges: [], metadata: emptyMetadata(), viewport: null };
    }

    const positions = savedGraph?.positions || {};
    const order = topologicalOrder(compiled.states, compiled.transitions || []);
    const orderIndex = new Map(order.map((id, i) => [id, i]));

    const nodes = compiled.states.map(state => {
        const idx = orderIndex.get(state.id) ?? compiled.states.indexOf(state);
        return {
            id: state.id,
            type: 'stateNode',
            position: positions[state.id] || autoLayoutPosition(idx),
            data: {
                id: state.id,
                label: state.label,
                color: state.color,
                duration: state.duration || { perPage: 0, fixed: 0 },
                isInitial: state.isInitial || false,
                isTerminal: state.isTerminal || false,
                validations: compiled.validations?.[state.id] || { onEntry: [], requiredToEnter: [], requiredToExit: [] },
                commands: compiled.commands?.[state.id] || [],
                statePermissions: compiled.statePermissions?.[state.id] || []
            }
        };
    });

    const edges = (compiled.transitions || []).map(t => ({
        id: `${t.from}__${t.to}`,
        source: t.from,
        target: t.to,
        type: 'transitionEdge',
        data: {
            label: t.label || '',
            direction: t.direction || 'forward',
            allowedGroups: t.allowedGroups || []
        }
    }));

    const metadata = {
        contributorGroups: compiled.contributorGroups || [],
        leaderGroups: compiled.leaderGroups || [],
        elementPermissions: compiled.elementPermissions || {},
        capabilities: compiled.capabilities || {}
    };

    const viewport = savedGraph?.viewport || null;

    return { nodes, edges, metadata, viewport };
}

// ── graphToCompiled ─────────────────────────────────────────────────────────

/**
 * Xyflow graph állapot → compiled JSON konverzió.
 * Mentéskor használatos.
 *
 * @param {Object[]} nodes - xyflow node-ok
 * @param {Object[]} edges - xyflow edge-ek
 * @param {Object} metadata - Workflow-szintű adatok
 * @returns {Object} compiled JSON (version nélkül — a CF állítja be)
 */
export function graphToCompiled(nodes, edges, metadata) {
    const states = nodes.map(n => ({
        id: n.id,
        label: n.data.label,
        color: n.data.color,
        duration: n.data.duration,
        isInitial: n.data.isInitial,
        isTerminal: n.data.isTerminal
    }));

    const transitions = edges.map(e => ({
        from: e.source,
        to: e.target,
        label: e.data.label,
        direction: e.data.direction,
        allowedGroups: e.data.allowedGroups
    }));

    const validations = {};
    const commands = {};
    const statePermissions = {};

    for (const n of nodes) {
        validations[n.id] = n.data.validations || { onEntry: [], requiredToEnter: [], requiredToExit: [] };
        commands[n.id] = n.data.commands || [];
        statePermissions[n.id] = n.data.statePermissions || [];
    }

    return {
        states,
        transitions,
        validations,
        commands,
        elementPermissions: metadata.elementPermissions || {},
        contributorGroups: metadata.contributorGroups || [],
        leaderGroups: metadata.leaderGroups || [],
        statePermissions,
        capabilities: metadata.capabilities || {}
    };
}

// ── Graph pozíciók kinyerése mentéshez ──────────────────────────────────────

/**
 * Xyflow node-okból kinyeri a pozíciókat a graph mezőhöz.
 *
 * @param {Object[]} nodes - xyflow node-ok
 * @param {Object|null} viewport - xyflow viewport { x, y, zoom }
 * @returns {Object} graph JSON (DB-be menthető)
 */
export function extractGraphData(nodes, viewport) {
    const positions = {};
    for (const n of nodes) {
        positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    }
    return { positions, viewport: viewport || null };
}

// ── Segédfüggvények ─────────────────────────────────────────────────────────

function emptyMetadata() {
    return {
        contributorGroups: [],
        leaderGroups: [],
        elementPermissions: {},
        capabilities: {}
    };
}
