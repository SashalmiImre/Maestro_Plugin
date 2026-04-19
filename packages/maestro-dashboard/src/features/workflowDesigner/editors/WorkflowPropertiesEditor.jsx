/**
 * Maestro Dashboard — WorkflowPropertiesEditor
 *
 * Workflow-szintű tulajdonságok — megjelenik, ha nincs kijelölés a canvason.
 * Tartalmazza: verzió, leaderGroups, contributorGroups + placeholder tabok.
 */

import React, { useCallback } from 'react';
import GroupMultiSelectField from '../fields/GroupMultiSelectField.jsx';

/**
 * @param {Object} props
 * @param {number} props.version - Workflow verzió
 * @param {Object} props.metadata - { contributorGroups, leaderGroups, elementPermissions, capabilities }
 * @param {Function} props.onMetadataChange - (newMetadata) => void
 * @param {string[]} props.availableGroups - Elérhető csoport slug-ok
 */
export default function WorkflowPropertiesEditor({ version, metadata, onMetadataChange, availableGroups }) {
    const handleLeaderGroupsChange = useCallback((groups) => {
        onMetadataChange({ ...metadata, leaderGroups: groups });
    }, [metadata, onMetadataChange]);

    return (
        <div className="properties-editor">
            <h3 className="properties-editor__title">Workflow</h3>

            {/* Verzió */}
            <div className="designer-field">
                <label className="designer-field__label">Verzió</label>
                <span className="designer-field__value">v{version}</span>
            </div>

            {/* Leader csoportok */}
            <GroupMultiSelectField
                label="Vezető csoportok (minden jogosultságot megkerülnek)"
                value={metadata.leaderGroups || []}
                availableGroups={availableGroups}
                onChange={handleLeaderGroupsChange}
            />

            {/* Contributor csoportok — read-only listázás.
                #75: explicit „csak olvasható" jelzés + utalás a forrásra
                (Szerkesztőség → Csoportok), mert a chip-stílus alapján
                a felhasználó kattinthatónak hihette. */}
            <div className="designer-field">
                <label className="designer-field__label">
                    Contributor csoportok
                    <span className="designer-field__readonly-badge" aria-label="Csak olvasható">
                        csak olvasható
                    </span>
                </label>
                <p className="designer-field__help">
                    A csoportokat a Szerkesztőség beállításai → Csoportok fülön
                    kezelheted. Itt csak a workflow szempontjából elérhető
                    listát látod.
                </p>
                <div className="designer-field__chips designer-field__chips--readonly">
                    {(metadata.contributorGroups || []).length === 0 ? (
                        <span className="designer-field__empty">Nincsenek contributor csoportok</span>
                    ) : (
                        (metadata.contributorGroups || []).map(cg => (
                            <span
                                key={cg.slug}
                                className="designer-chip designer-chip--readonly"
                                title={`${cg.label} (${cg.slug}) — csak olvasható`}
                            >
                                {cg.label}
                                <span className="designer-chip__slug" aria-hidden="true">{cg.slug}</span>
                            </span>
                        ))
                    )}
                </div>
            </div>

            {/*
             * Korábban itt voltak az „Elem jogosultságok" és „Képességek"
             * placeholder szekciók „Hamarosan" badge-dzsel. Amíg nincs
             * funkció mögöttük, elrejtjük — a feature bevezetésekor
             * visszakerülnek. Így a UI nem terhelődik funkciótlan
             * elemekkel, és nem jelenik meg inkonzisztens frázishasználat.
             */}
        </div>
    );
}
