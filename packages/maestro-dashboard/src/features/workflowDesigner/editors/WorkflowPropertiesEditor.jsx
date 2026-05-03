/**
 * Maestro Dashboard — WorkflowPropertiesEditor
 *
 * Workflow-szintű tulajdonságok — megjelenik, ha nincs kijelölés a canvason.
 * Tartalmazza: verzió + `requiredGroupSlugs[]` szerkesztő (A.4.6 / ADR 0008).
 *
 * **A.4.6 változás**: a régi külön `leaderGroups` MultiSelect és read-only
 * `contributorGroups` listázás eltűnik — a `requiredGroupSlugs[]` sorok
 * tartalmazzák az `isLeaderGroup` / `isContributorGroup` flag-eket. A
 * compiler `graphToCompiled()` ezekből autogenerálja a `compiled.leaderGroups[]`
 * és `compiled.contributorGroups[]` mezőket.
 */

import React, { useCallback } from 'react';
import RequiredGroupSlugsField from '../fields/RequiredGroupSlugsField.jsx';

/**
 * @param {Object} props
 * @param {number} props.version - Workflow verzió
 * @param {Object} props.metadata - { requiredGroupSlugs, contributorGroups, leaderGroups, elementPermissions, capabilities }
 * @param {Function} props.onMetadataChange - (newMetadata) => void
 * @param {boolean} [props.isReadOnly=false] - foreign workflow / no permission → disabled UI
 */
export default function WorkflowPropertiesEditor({ version, metadata, onMetadataChange, isReadOnly = false }) {
    const handleRequiredGroupSlugsChange = useCallback((nextSlugs) => {
        onMetadataChange({ ...metadata, requiredGroupSlugs: nextSlugs });
    }, [metadata, onMetadataChange]);

    return (
        <div className="properties-editor">
            <h3 className="properties-editor__title">Workflow</h3>

            {/* Verzió */}
            <div className="designer-field">
                <label className="designer-field__label">Verzió</label>
                <span className="designer-field__value">v{version}</span>
            </div>

            {/* requiredGroupSlugs[] szerkesztő */}
            <RequiredGroupSlugsField
                value={metadata.requiredGroupSlugs || []}
                onChange={handleRequiredGroupSlugsChange}
                disabled={isReadOnly}
            />

            {/*
             * Korábban itt voltak az „Elem jogosultságok" és „Képességek"
             * placeholder szekciók „Hamarosan" badge-dzsel. Amíg nincs
             * funkció mögöttük, elrejtjük — a feature bevezetésekor
             * visszakerülnek.
             */}
        </div>
    );
}
