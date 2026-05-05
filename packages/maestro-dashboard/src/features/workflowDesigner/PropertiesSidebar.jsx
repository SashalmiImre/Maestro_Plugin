/**
 * Maestro Dashboard — PropertiesSidebar
 *
 * Jobb oldali panel — a kijelölés alapján dinamikusan rendereli
 * a megfelelő szerkesztőt (state, transition, vagy workflow-szintű).
 */

import React from 'react';
import StatePropertiesEditor from './editors/StatePropertiesEditor.jsx';
import TransitionPropertiesEditor from './editors/TransitionPropertiesEditor.jsx';
import WorkflowPropertiesEditor from './editors/WorkflowPropertiesEditor.jsx';

/**
 * @param {Object} props
 * @param {Object|null} props.selectedNode - Kiválasztott xyflow node (vagy null)
 * @param {Object|null} props.selectedEdge - Kiválasztott xyflow edge (vagy null)
 * @param {Function} props.onNodeDataChange - Node adat módosítás callback
 * @param {Function} props.onEdgeDataChange - Edge adat módosítás callback
 * @param {Function} props.onDeleteNode - Node törlés callback
 * @param {Function} props.onDeleteEdge - Edge törlés callback
 * @param {string[]} props.availableGroups - Elérhető csoport slug-ok
 * @param {number} props.version - Workflow verzió
 * @param {Object} props.metadata - Workflow-szintű adatok
 * @param {Function} props.onMetadataChange - Metadata módosítás callback
 * @param {Object<string,string>} [props.stateLabels] - State slug → label térkép (TransitionPropertiesEditor #65)
 * @param {Array<{slug: string, name: string, kind: 'validator'|'command', archivedAt: string|null}>} [props.extensions]
 *   - Az office workflow extension-listája (B.5.3, ADR 0007 Phase 0). A
 *   `ValidationListField` és `CommandListField` a built-in registry mellé
 *   `ext.<slug>` chip-eket renderel. Az `archivedAt !== null` extension a
 *   választható listából kimarad, de stale ref-ként read-only chip-ként
 *   megjelenik (Codex tervi roast 5-ös pont).
 * @param {boolean} [props.isCollapsed] - Összecsukott állapot (#73)
 * @param {Function} [props.onToggleCollapsed] - Toggle callback (#73)
 * @param {boolean} [props.isReadOnly=false] - Foreign workflow / nincs jogosultság — disabled UI (A.4.6)
 */
export default function PropertiesSidebar({
    selectedNode, selectedEdge,
    onNodeDataChange, onEdgeDataChange,
    onDeleteNode, onDeleteEdge,
    availableGroups,
    version, metadata, onMetadataChange,
    stateLabels,
    extensions,
    isCollapsed = false,
    onToggleCollapsed,
    isReadOnly = false
}) {
    // #73: összecsukott módban csak a toggle gomb + vertikális címke.
    // A panel content render is le van kapcsolva — nem renderelünk (felesleges work).
    if (isCollapsed) {
        const collapsedLabel = selectedNode
            ? 'Állapot tulajdonságok'
            : selectedEdge
                ? 'Átmenet tulajdonságok'
                : 'Workflow tulajdonságok';
        return (
            <div className="properties-sidebar properties-sidebar--collapsed">
                <button
                    type="button"
                    className="workflow-designer-collapse-btn workflow-designer-collapse-btn--sidebar"
                    onClick={onToggleCollapsed}
                    aria-label="Tulajdonságok panel kibontása"
                    aria-expanded="false"
                    title="Tulajdonságok panel kibontása"
                >
                    <span aria-hidden="true">‹</span>
                </button>
                <div className="properties-sidebar__collapsed-label" aria-hidden="true">
                    {collapsedLabel}
                </div>
            </div>
        );
    }

    return (
        <div className="properties-sidebar">
            {onToggleCollapsed && (
                <button
                    type="button"
                    className="workflow-designer-collapse-btn workflow-designer-collapse-btn--sidebar-inline"
                    onClick={onToggleCollapsed}
                    aria-label="Tulajdonságok panel összecsukása"
                    aria-expanded="true"
                    title="Tulajdonságok panel összecsukása"
                >
                    <span aria-hidden="true">›</span>
                </button>
            )}
            {selectedNode ? (
                <StatePropertiesEditor
                    node={selectedNode}
                    onDataChange={onNodeDataChange}
                    availableGroups={availableGroups}
                    onDelete={onDeleteNode}
                    extensions={extensions}
                    isReadOnly={isReadOnly}
                />
            ) : selectedEdge ? (
                <TransitionPropertiesEditor
                    edge={selectedEdge}
                    onDataChange={onEdgeDataChange}
                    availableGroups={availableGroups}
                    onDelete={onDeleteEdge}
                    stateLabels={stateLabels}
                    isReadOnly={isReadOnly}
                />
            ) : (
                <WorkflowPropertiesEditor
                    version={version}
                    metadata={metadata}
                    onMetadataChange={onMetadataChange}
                    isReadOnly={isReadOnly}
                />
            )}
        </div>
    );
}
