/**
 * Maestro Dashboard — Workflow Compiler
 *
 * compiled JSON ↔ xyflow graph konverzió (Designer betöltés / mentés).
 *
 * `compiled.requiredGroupSlugs[]` (A.1.5 / ADR 0008) a kanonikus slug-lista;
 * a `contributorGroups[]` és `leaderGroups[]` ebből autogenerálódnak. Régi
 * (requiredGroupSlugs nélküli) compiled-re a `reconstructRequiredGroupSlugs()`
 * read-time fallback-et ad — DB-be nem ír vissza.
 */

import { validateCompiledSlugs } from '@shared/compiledValidator.js';

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

// ── requiredGroupSlugs helperek (A.1.5) ─────────────────────────────────────

/**
 * Begyűjti a compiled JSON minden mezőjéből a hivatkozott csoport-slug-okat.
 * A `requiredGroupSlugs` rekonstrukciójához (legacy load) és a hard contract
 * validációhoz egyaránt használt.
 *
 * Mezők, amelyek slug-ot hivatkoznak:
 *   - transitions[].allowedGroups
 *   - commands[stateId][*].allowedGroups
 *   - elementPermissions[scope][element].groups (csak ha type === 'groups')
 *   - leaderGroups[]
 *   - statePermissions[stateId][]
 *   - contributorGroups[].slug
 *   - capabilities[name][]
 *
 * @param {Object} compiled
 * @returns {Set<string>}
 */
export function collectAllReferencedSlugs(compiled) {
    const slugs = new Set();
    if (!compiled) return slugs;

    for (const t of compiled.transitions || []) {
        for (const slug of t.allowedGroups || []) slugs.add(slug);
    }
    for (const cmds of Object.values(compiled.commands || {})) {
        for (const cmd of cmds || []) {
            for (const slug of cmd.allowedGroups || []) slugs.add(slug);
        }
    }
    for (const elems of Object.values(compiled.elementPermissions || {})) {
        for (const perm of Object.values(elems || {})) {
            if (perm?.type === 'groups') {
                for (const slug of perm.groups || []) slugs.add(slug);
            }
        }
    }
    for (const slug of compiled.leaderGroups || []) slugs.add(slug);
    for (const slugList of Object.values(compiled.statePermissions || {})) {
        for (const slug of slugList || []) slugs.add(slug);
    }
    for (const cg of compiled.contributorGroups || []) {
        if (cg?.slug) slugs.add(cg.slug);
    }
    for (const slugList of Object.values(compiled.capabilities || {})) {
        for (const slug of slugList || []) slugs.add(slug);
    }

    return slugs;
}

/**
 * Read-time fallback rekonstrukció: legacy `compiled` (requiredGroupSlugs
 * nélkül) → minimum-viable `requiredGroupSlugs[]` az összes hivatkozott
 * slug-ból. Az `isContributorGroup` / `isLeaderGroup` a meglévő
 * `contributorGroups[]` / `leaderGroups[]`-ből vezetődik le; a `label` szintén
 * a `contributorGroups[]`-ból (ha hiányzik, a `slug` a fallback). A `color` és
 * `description` üresen marad — a felhasználó mentéskor pótolhatja.
 *
 * NEM DB-migráció — DB-be vissza nem ír.
 *
 * @param {Object} compiled
 * @returns {Array<{ slug: string, label: string, description: string, color: string, isContributorGroup: boolean, isLeaderGroup: boolean }>}
 */
export function reconstructRequiredGroupSlugs(compiled) {
    const allSlugs = collectAllReferencedSlugs(compiled);
    const labelMap = new Map((compiled.contributorGroups || []).map(cg => [cg.slug, cg.label]));
    const contributorSet = new Set((compiled.contributorGroups || []).map(cg => cg.slug));
    const leaderSet = new Set(compiled.leaderGroups || []);

    return [...allSlugs].sort().map(slug => ({
        slug,
        label: labelMap.get(slug) || slug,
        description: '',
        color: '',
        isContributorGroup: contributorSet.has(slug),
        isLeaderGroup: leaderSet.has(slug)
    }));
}

/**
 * `requiredGroupSlugs` lista normalizálása: a hiányzó mezőket alapértelmezett
 * értékre állítja, a slug nélküli elemeket kiszűri. A graphToCompiled idempotens
 * kimenet-építéséhez kötelező.
 */
function normalizeRequiredGroupSlugs(list) {
    return (list || [])
        .filter(g => g?.slug)
        .map(g => ({
            slug: g.slug,
            label: g.label || g.slug,
            description: g.description || '',
            color: g.color || '',
            isContributorGroup: g.isContributorGroup === true,
            isLeaderGroup: g.isLeaderGroup === true
        }));
}

// ── Import normalize + validate (A.1.9) ─────────────────────────────────────

/**
 * Importált compiled+graph normalizálása és hard contract validációja.
 * A `compiledToGraph → graphToCompiled` round-trip rekonstruálja a hiányzó
 * `requiredGroupSlugs[]`-t és autogenerálja a `contributorGroups` /
 * `leaderGroups` mezőket — onnantól a `validateCompiledSlugs` ugyanazon a
 * normalized formán fut, mint a Designer mentésnél (azonos hibaüzenetek).
 *
 * Használja: [CreateWorkflowModal](../../components/workflows/CreateWorkflowModal.jsx)
 * (új workflow + JSON import) és [ImportDialog](./ImportDialog.jsx)
 * (Designer-en belüli import).
 *
 * @param {Object} compiled - Importált workflow compiled JSON.
 * @param {Object|null} [graph] - Opcionális graph (positions + viewport).
 * @returns {{
 *   ok: true,
 *   normalizedCompiled: Object,
 *   normalizedGraph: Object,
 *   nodes: Object[],
 *   edges: Object[],
 *   metadata: Object,
 *   viewport: Object|null,
 *   validation: import('@shared/compiledValidator.js').ValidationResult
 * } | {
 *   ok: false,
 *   structuralError: string
 * }}
 */
export function normalizeAndValidateImport(compiled, graph = null) {
    // Raw input pre-validáció — fail-fast a típushibákra (`requiredGroupSlugs:
    // 'string'`, `leaderGroups: 'admins'`), különben a round-trip rekonstrukció
    // elmaszkolná. Legacy compiled (NINCS `requiredGroupSlugs` mező) esetén a
    // raw checket KIHAGYJUK — különben minden slug `unknown_group_slug` lenne
    // (üres allowed Set), és a meglévő export-fájlok unloadable-vé válnának.
    // A normalized re-check (round-trip után) ekkor is fut.
    const hasRawRequiredGroupSlugs = compiled?.requiredGroupSlugs != null;
    const rawValidation = hasRawRequiredGroupSlugs
        ? validateCompiledSlugs(compiled)
        : { valid: true, errors: [] };

    let round;
    try {
        round = compiledToGraph(compiled, graph);
    } catch (err) {
        return { ok: false, structuralError: err?.message || String(err) };
    }
    let normalizedCompiled;
    try {
        normalizedCompiled = graphToCompiled(round.nodes, round.edges, round.metadata);
    } catch (err) {
        return { ok: false, structuralError: err?.message || String(err) };
    }
    const normalizedGraph = extractGraphData(round.nodes, round.viewport);
    const validation = rawValidation.valid
        ? validateCompiledSlugs(normalizedCompiled)
        : rawValidation;

    return {
        ok: true,
        normalizedCompiled,
        normalizedGraph,
        nodes: round.nodes,
        edges: round.edges,
        metadata: round.metadata,
        viewport: round.viewport,
        validation
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

    // A.1.5: a `requiredGroupSlugs` mostantól a kanonikus slug-lista. Ha a
    // compiled-ben van, közvetlenül használjuk; ha nincs (legacy doc), read-time
    // fallback-ként rekonstruáljuk az összes referencia-mezőből. A meglévő
    // `contributorGroups` és `leaderGroups` mezőket továbbra is visszaadjuk
    // a metadata-ba — a UI még ezeket szerkeszti (A.4.6 fogja átállítani a
    // `requiredGroupSlugs[]` flag-szerkesztésre).
    const requiredGroupSlugs = Array.isArray(compiled.requiredGroupSlugs)
        ? normalizeRequiredGroupSlugs(compiled.requiredGroupSlugs)
        : reconstructRequiredGroupSlugs(compiled);

    const metadata = {
        requiredGroupSlugs,
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

    // A.1.5 (ADR 0008): a `requiredGroupSlugs[]` a kanonikus slug-lista; az
    // autogenerált `contributorGroups[]` és `leaderGroups[]` ennek `isContributorGroup`
    // / `isLeaderGroup` flag-jeiből származnak. Ha a UI még a régi
    // metadata.contributorGroups / leaderGroups mezőket szerkeszti
    // (A.4.6 előtt), azokból rekonstruáljuk a `requiredGroupSlugs[]`-t.
    const baseCompiledForReconstruct = {
        transitions,
        commands,
        elementPermissions: metadata.elementPermissions || {},
        leaderGroups: metadata.leaderGroups || [],
        statePermissions,
        contributorGroups: metadata.contributorGroups || [],
        capabilities: metadata.capabilities || {}
    };
    const requiredGroupSlugs = Array.isArray(metadata.requiredGroupSlugs) && metadata.requiredGroupSlugs.length > 0
        ? normalizeRequiredGroupSlugs(metadata.requiredGroupSlugs)
        : reconstructRequiredGroupSlugs(baseCompiledForReconstruct);

    const autoContributorGroups = requiredGroupSlugs
        .filter(g => g.isContributorGroup)
        .map(g => ({ slug: g.slug, label: g.label }));
    const autoLeaderGroups = requiredGroupSlugs
        .filter(g => g.isLeaderGroup)
        .map(g => g.slug);

    return {
        states,
        transitions,
        validations,
        commands,
        elementPermissions: metadata.elementPermissions || {},
        requiredGroupSlugs,
        contributorGroups: autoContributorGroups,
        leaderGroups: autoLeaderGroups,
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
        requiredGroupSlugs: [],
        contributorGroups: [],
        leaderGroups: [],
        elementPermissions: {},
        capabilities: {}
    };
}
