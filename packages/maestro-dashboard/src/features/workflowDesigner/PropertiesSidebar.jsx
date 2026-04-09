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
 */
export default function PropertiesSidebar({
    selectedNode, selectedEdge,
    onNodeDataChange, onEdgeDataChange,
    onDeleteNode, onDeleteEdge,
    availableGroups,
    version, metadata, onMetadataChange
}) {
    return (
        <div className="properties-sidebar">
            {selectedNode ? (
                <StatePropertiesEditor
                    node={selectedNode}
                    onDataChange={onNodeDataChange}
                    availableGroups={availableGroups}
                    onDelete={onDeleteNode}
                />
            ) : selectedEdge ? (
                <TransitionPropertiesEditor
                    edge={selectedEdge}
                    onDataChange={onEdgeDataChange}
                    availableGroups={availableGroups}
                    onDelete={onDeleteEdge}
                />
            ) : (
                <WorkflowPropertiesEditor
                    version={version}
                    metadata={metadata}
                    onMetadataChange={onMetadataChange}
                    availableGroups={availableGroups}
                />
            )}
        </div>
    );
}
