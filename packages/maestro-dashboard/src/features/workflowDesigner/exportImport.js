/**
 * Maestro Dashboard — Workflow Export / Import
 *
 * JSON formátumú export és import logika a workflow designerhez.
 */

import { graphToCompiled, extractGraphData } from './compiler.js';

/**
 * Workflow exportálása JSON fájlba.
 * Letölti a böngészőben.
 *
 * @param {Object[]} nodes - xyflow node-ok
 * @param {Object[]} edges - xyflow edge-ek
 * @param {Object} metadata - Workflow-szintű adatok
 * @param {Object|null} viewport - xyflow viewport
 */
export function exportWorkflow(nodes, edges, metadata, viewport) {
    const compiled = graphToCompiled(nodes, edges, metadata);
    const graph = extractGraphData(nodes, viewport);

    const exportData = {
        maestro_workflow_export: true,
        exportedAt: new Date().toISOString(),
        compiled,
        graph
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();

    URL.revokeObjectURL(url);
}

// S.4 R.S.4.2 close (2026-05-15) — defense-in-depth file-upload guard-ok.
// A `<input type="file" accept=".json">` UI-hint, NEM enforce-olt (curl
// vagy DevTools-bypass ellen). A central `parseImportFile`-ban ellenőrizzük
// size + MIME ELŐSZÖR — egy 1 GB JSON-fájlt NE próbáljunk `file.text()`-szel
// memóriába olvasni (browser OOM crash).
const MAX_IMPORT_FILE_SIZE = 5 * 1024 * 1024; // 5 MB — workflow JSON tipikusan <500 KB
const ALLOWED_IMPORT_MIME_TYPES = new Set([
    'application/json',
    'text/json',
    // Egyes böngészők NEM állítják be a `file.type`-ot a `.json` fájlokra
    // (üres string). Engedjük, hogy a `JSON.parse` legyen a végső validátor.
    ''
]);

/**
 * Import fájl validálása és feldolgozása.
 *
 * @param {File} file - A feltöltött JSON fájl
 * @returns {Promise<{ compiled: Object, graph: Object|null, error: string|null }>}
 */
export async function parseImportFile(file) {
    try {
        // S.4 R.S.4.2 fix: size + MIME pre-check. A `<input accept>` csak
        // UI-hint; programatikus / DevTools-bypass ellen explicit védés.
        if (typeof file.size === 'number' && file.size > MAX_IMPORT_FILE_SIZE) {
            const sizeMB = (file.size / 1024 / 1024).toFixed(2);
            return {
                compiled: null,
                graph: null,
                error: `Fájl túl nagy (${sizeMB} MB > 5 MB max). A workflow JSON tipikusan <500 KB.`
            };
        }
        if (file.type && !ALLOWED_IMPORT_MIME_TYPES.has(file.type)) {
            return {
                compiled: null,
                graph: null,
                error: `Érvénytelen fájltípus (${file.type}). Csak JSON fájlt fogad el.`
            };
        }

        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.maestro_workflow_export) {
            return { compiled: null, graph: null, error: 'Nem Maestro workflow export fájl.' };
        }
        if (!data.compiled || !data.compiled.states) {
            return { compiled: null, graph: null, error: 'Hiányos workflow adat — nincsenek állapotok.' };
        }

        return {
            compiled: data.compiled,
            graph: data.graph || null,
            error: null
        };
    } catch (err) {
        return { compiled: null, graph: null, error: 'Érvénytelen JSON fájl.' };
    }
}

/**
 * Import diff kiszámítása a jelenlegi és az importálandó workflow között.
 *
 * @param {Object[]} currentNodes - Jelenlegi xyflow node-ok
 * @param {Object[]} currentEdges - Jelenlegi xyflow edge-ek
 * @param {Object} currentMetadata - Jelenlegi metadata
 * @param {Object} importedCompiled - Importált compiled JSON
 * @returns {{ addedStates: string[], removedStates: string[], changedTransitions: number, metadataChanges: string[] }}
 */
export function computeImportDiff(currentNodes, currentEdges, currentMetadata, importedCompiled) {
    const currentIds = new Set(currentNodes.map(n => n.id));
    const importedIds = new Set((importedCompiled.states || []).map(s => s.id));

    const addedStates = [...importedIds].filter(id => !currentIds.has(id));
    const removedStates = [...currentIds].filter(id => !importedIds.has(id));

    const currentTransitions = new Set(currentEdges.map(e => `${e.source}__${e.target}`));
    const importedTransitions = new Set(
        (importedCompiled.transitions || []).map(t => `${t.from}__${t.to}`)
    );
    let changedTransitions = 0;
    for (const t of importedTransitions) {
        if (!currentTransitions.has(t)) changedTransitions++;
    }
    for (const t of currentTransitions) {
        if (!importedTransitions.has(t)) changedTransitions++;
    }

    // Metadata / ACL / jogosultsági változások detektálása
    const metadataChanges = [];

    const curLeaders = JSON.stringify(currentMetadata.leaderGroups || []);
    const impLeaders = JSON.stringify(importedCompiled.leaderGroups || []);
    if (curLeaders !== impLeaders) metadataChanges.push('Vezető csoportok');

    const curElementPerms = JSON.stringify(currentMetadata.elementPermissions || {});
    const impElementPerms = JSON.stringify(importedCompiled.elementPermissions || {});
    if (curElementPerms !== impElementPerms) metadataChanges.push('Elem jogosultságok');

    const curCapabilities = JSON.stringify(currentMetadata.capabilities || {});
    const impCapabilities = JSON.stringify(importedCompiled.capabilities || {});
    if (curCapabilities !== impCapabilities) metadataChanges.push('Képességek');

    // Validációk és parancsok változása az állapotokra
    let validationChanges = false;
    let commandChanges = false;
    let permissionChanges = false;
    for (const state of (importedCompiled.states || [])) {
        const currentNode = currentNodes.find(n => n.id === state.id);
        if (!currentNode) continue;
        if (JSON.stringify(importedCompiled.validations?.[state.id]) !== JSON.stringify(currentNode.data.validations)) {
            validationChanges = true;
        }
        if (JSON.stringify(importedCompiled.commands?.[state.id]) !== JSON.stringify(currentNode.data.commands)) {
            commandChanges = true;
        }
        if (JSON.stringify(importedCompiled.statePermissions?.[state.id]) !== JSON.stringify(currentNode.data.statePermissions)) {
            permissionChanges = true;
        }
    }
    if (validationChanges) metadataChanges.push('Validációs szabályok');
    if (commandChanges) metadataChanges.push('Parancsok');
    if (permissionChanges) metadataChanges.push('Állapot jogosultságok');

    return { addedStates, removedStates, changedTransitions, metadataChanges };
}

