/**
 * Maestro Dashboard — EditorialOfficeSettingsModal
 *
 * Szerkesztőség kezelő modal (Általános / Csoportok / Workflow fülek). A
 * BreadcrumbDropdown szerkesztőség-dropdownjának „Beállítások" menüpontja
 * nyitja meg. Aktív fül localStorage-ben perzisztált.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Databases, Query } from 'appwrite';
import { getClient, useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import Tabs from '../Tabs.jsx';
import EditorialOfficeGeneralTab from './EditorialOfficeGeneralTab.jsx';
import EditorialOfficeGroupsTab from './EditorialOfficeGroupsTab.jsx';
import EditorialOfficeWorkflowTab from './EditorialOfficeWorkflowTab.jsx';
import { DATABASE_ID, COLLECTIONS } from '../../config.js';

const TAB_DEFS = [
    { id: 'general', label: 'Általános' },
    { id: 'groups', label: 'Csoportok' },
    { id: 'workflow', label: 'Workflow' }
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
    const {
        user,
        organizations,
        editorialOffices,
        orgMemberships
    } = useAuth();
    const { closeModal } = useModal();

    const office = editorialOffices?.find(o => o.$id === editorialOfficeId) || null;
    const org = office ? organizations?.find(o => o.$id === office.organizationId) || null : null;

    const [activeTab, setActiveTab] = useState(() => initialTab || getStoredTab());

    // --- Groups + Workflow tab-ok adata (a shell tölti, a tabok propon kapják) ---
    const [groups, setGroups] = useState([]);
    const [groupMemberships, setGroupMemberships] = useState([]);
    const [officeMembers, setOfficeMembers] = useState([]);
    const [workflows, setWorkflows] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState('');

    const loadGenRef = useRef(0);

    const client = getClient();
    const databases = useMemo(() => new Databases(client), [client]);

    const callerRole = useMemo(() => {
        if (!office?.organizationId || !user?.$id) return null;
        const membership = (orgMemberships || []).find(
            m => m.organizationId === office.organizationId && m.userId === user.$id
        );
        return membership?.role || null;
    }, [orgMemberships, office?.organizationId, user?.$id]);

    const isOrgAdmin = callerRole === 'owner' || callerRole === 'admin';

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

        setIsLoading(true);
        setLoadError('');

        const gen = ++loadGenRef.current;

        try {
            // Workflows query: csak saját office workflow-i (visibility-től
            // függetlenül — legacy null és `organization` own-office is ide esik).
            // Szándékosan szcópolt: az `organization` láthatóság a Plugin-oldali
            // cross-office fogyasztás miatt létezik (DataContext Query.or), a
            // kezelés mindig az ownership office `Beállítások > Workflow` fülén
            // történik — így a scope_mismatch footgun elkerülve.
            const [groupsResult, membershipsResult, officeMembersResult, workflowsResult] = await Promise.all([
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
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.WORKFLOWS,
                    queries: [
                        Query.equal('editorialOfficeId', editorialOfficeId),
                        Query.limit(100)
                    ]
                })
            ]);

            if (gen !== loadGenRef.current) return;

            setGroups(groupsResult.documents);
            setGroupMemberships(membershipsResult.documents);
            setOfficeMembers(officeMembersResult.documents);
            setWorkflows(workflowsResult.documents);
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

                {activeTab === 'workflow' && (
                    <EditorialOfficeWorkflowTab
                        office={office}
                        workflows={workflows}
                        isLoading={isLoading}
                        isOrgAdmin={isOrgAdmin}
                        onReload={loadData}
                    />
                )}
            </div>
        </div>
    );
}
