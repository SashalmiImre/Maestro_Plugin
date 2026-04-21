/**
 * Maestro Dashboard — EditorialOfficeSettingsModal
 *
 * Szerkesztőség kezelő modal (Általános / Csoportok fülek). A BreadcrumbDropdown
 * szerkesztőség-dropdownjának „Beállítások" menüpontja nyitja meg. Aktív fül
 * localStorage-ben perzisztált.
 *
 * A workflow-k kezelése (#82–#86) a közös `WorkflowLibraryPanel` modalba
 * költözött — a breadcrumb „Workflow" chip-jéből érhető el, scope-független
 * böngészéssel (3-way visibility: public / organization / editorial_office).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Query } from 'appwrite';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useData } from '../../contexts/DataContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useTenantRealtimeRefresh } from '../../hooks/useTenantRealtimeRefresh.js';
import { useOrgRole } from '../../hooks/useOrgRole.js';
import Tabs from '../Tabs.jsx';
import AnimatedAutoHeight from '../AnimatedAutoHeight.jsx';
import EditorialOfficeGeneralTab from './EditorialOfficeGeneralTab.jsx';
import EditorialOfficeGroupsTab from './EditorialOfficeGroupsTab.jsx';
import { DATABASE_ID, COLLECTIONS } from '../../config.js';

const TAB_DEFS = [
    { id: 'general', label: 'Általános' },
    { id: 'groups', label: 'Csoportok' }
];

const ACTIVE_TAB_STORAGE_KEY = 'maestro.editorialOfficeSettingsActiveTab';

function getStoredTab() {
    try {
        const value = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
        if (value && TAB_DEFS.some(t => t.id === value)) return value;
    } catch { /* SSR / quota / parse */ }
    return 'general';
}

/**
 * @param {Object} props
 * @param {string} props.editorialOfficeId — a kezelendő szerkesztőség $id-ja
 * @param {string} [props.initialTab] — kezdeti fül override (különben a localStorage)
 */
export default function EditorialOfficeSettingsModal({ editorialOfficeId, initialTab }) {
    const { organizations, editorialOffices } = useAuth();
    const { databases } = useData();
    const { closeModal } = useModal();

    const office = editorialOffices?.find(o => o.$id === editorialOfficeId) || null;
    const org = office ? organizations?.find(o => o.$id === office.organizationId) || null : null;
    const { role: callerRole, isOrgAdmin } = useOrgRole(office?.organizationId);

    const [activeTab, setActiveTab] = useState(() => initialTab || getStoredTab());

    // --- Groups tab adata (a shell tölti, a tab propon kapja) ---
    const [groups, setGroups] = useState([]);
    const [groupMemberships, setGroupMemberships] = useState([]);
    const [officeMembers, setOfficeMembers] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState('');

    const loadGenRef = useRef(0);

    function handleTabChange(tabId) {
        setActiveTab(tabId);
        try { localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tabId); }
        catch { /* quota ignore */ }
    }

    // --- Adatok betöltése ---

    const loadData = useCallback(async () => {
        if (!editorialOfficeId) {
            ++loadGenRef.current;
            setIsLoading(false);
            return;
        }

        setLoadError('');
        const gen = ++loadGenRef.current;
        // Csak az első (mount) betöltésnél jelzünk loading-ot — a Realtime
        // reload közben a régi adatot tartjuk, nincs villogás.
        if (gen === 1) setIsLoading(true);

        try {
            const [groupsResult, membershipsResult, officeMembersResult] = await Promise.all([
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUPS,
                    queries: [
                        Query.equal('editorialOfficeId', editorialOfficeId),
                        Query.limit(100)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
                    queries: [
                        Query.equal('editorialOfficeId', editorialOfficeId),
                        Query.limit(500)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.EDITORIAL_OFFICE_MEMBERSHIPS,
                    queries: [
                        Query.equal('editorialOfficeId', editorialOfficeId),
                        Query.limit(200)
                    ]
                })
            ]);

            if (gen !== loadGenRef.current) return;

            setGroups(groupsResult.documents);
            setGroupMemberships(membershipsResult.documents);
            setOfficeMembers(officeMembersResult.documents);
        } catch (err) {
            if (gen !== loadGenRef.current) return;
            console.error('[EditorialOfficeSettingsModal] Adatok betöltése sikertelen:', err);
            setLoadError('Hiba az adatok betöltésekor.');
        } finally {
            if (gen === loadGenRef.current) setIsLoading(false);
        }
    }, [editorialOfficeId, databases]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // Scope-szűrt Realtime refresh: csak a saját `editorialOfficeId` eventjei
    // triggerelik a reload-ot (300 ms debounce a hook-ban). Más office / tenant
    // event-je nem kelti fel a modal-t, így nincs keresztül-tenant zaj.
    useTenantRealtimeRefresh({
        scopeField: 'editorialOfficeId',
        scopeId: editorialOfficeId,
        reload: loadData
    });

    // --- Render ---

    if (!editorialOfficeId || !office) {
        return (
            <div className="publication-form">
                <div className="form-empty-state">
                    A szerkesztőség nem található vagy törölve lett.
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
            <Tabs tabs={TAB_DEFS} activeTab={activeTab} onTabChange={handleTabChange} />

            <AnimatedAutoHeight>
                <div className="publication-tab-content">
                    {activeTab !== 'general' && loadError && (
                        <div className="login-error" style={{ marginBottom: 12 }}>{loadError}</div>
                    )}

                    {activeTab === 'general' && (
                        <EditorialOfficeGeneralTab
                            office={office}
                            org={org}
                            callerRole={callerRole}
                        />
                    )}

                    {activeTab === 'groups' && (
                        <EditorialOfficeGroupsTab
                            office={office}
                            groups={groups}
                            groupMemberships={groupMemberships}
                            officeMembers={officeMembers}
                            isLoading={isLoading}
                            isOrgAdmin={isOrgAdmin}
                            onReload={loadData}
                        />
                    )}
                </div>
            </AnimatedAutoHeight>
        </div>
    );
}
