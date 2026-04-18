/**
 * Maestro Dashboard — PublicationSettingsModal
 *
 * Egy létező publikáció teljes beállításait szerkesztő container modal.
 * 4 fül: Általános / Layoutok / Határidők / Közreműködők.
 *
 * A modalt a ModalContext nyitja meg — a `publicationId` prop a DataContext
 * `publications` listájából oldódik fel, így a Realtime frissítések
 * automatikusan megjelennek a formban (nem stale prop).
 */

import React, { useState, useMemo } from 'react';
import { useData } from '../../contexts/DataContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import Tabs from '../Tabs.jsx';
import AnimatedAutoHeight from '../AnimatedAutoHeight.jsx';
import GeneralTab from './GeneralTab.jsx';
import LayoutsTab from './LayoutsTab.jsx';
import DeadlinesTab from './DeadlinesTab.jsx';
import ContributorsTab from './ContributorsTab.jsx';

const TAB_DEFS = [
    { id: 'general', label: 'Általános' },
    { id: 'layouts', label: 'Layoutok' },
    { id: 'deadlines', label: 'Határidők' },
    { id: 'contributors', label: 'Közreműködők' }
];

/**
 * @param {Object} props
 * @param {string} props.publicationId — a szerkesztendő kiadvány $id-je
 * @param {string} [props.initialTab='general']
 */
export default function PublicationSettingsModal({ publicationId, initialTab = 'general' }) {
    const { publications } = useData();
    const { closeModal } = useModal();
    const [activeTab, setActiveTab] = useState(initialTab);

    const publication = useMemo(
        () => publications.find((p) => p.$id === publicationId) || null,
        [publications, publicationId]
    );

    if (!publication) {
        return (
            <div className="publication-form">
                <div className="form-empty-state">
                    A kiadvány nem található vagy törölve lett.
                </div>
                <div className="modal-actions">
                    <button type="button" className="btn-secondary" onClick={closeModal}>
                        Bezárás
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="publication-settings-modal">
            <Tabs tabs={TAB_DEFS} activeTab={activeTab} onTabChange={setActiveTab} />

            <AnimatedAutoHeight>
                <div className="publication-tab-content">
                    {activeTab === 'general' && <GeneralTab publication={publication} />}
                    {activeTab === 'layouts' && <LayoutsTab publication={publication} />}
                    {activeTab === 'deadlines' && <DeadlinesTab publication={publication} />}
                    {activeTab === 'contributors' && <ContributorsTab publication={publication} />}
                </div>
            </AnimatedAutoHeight>
        </div>
    );
}
