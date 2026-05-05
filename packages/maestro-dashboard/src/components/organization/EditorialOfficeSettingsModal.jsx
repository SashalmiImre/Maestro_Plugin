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
import PermissionSetsTab from './PermissionSetsTab.jsx';
import WorkflowExtensionsTab from './WorkflowExtensionsTab.jsx';
import { DATABASE_ID, COLLECTIONS } from '../../config.js';

// ADR 0008 / A.4.3 — permission set CRUD tab.
// ADR 0007 Phase 0 / B.5.1 — workflow extensions CRUD tab.
const TAB_DEFS = [
    { id: 'general', label: 'Általános' },
    { id: 'groups', label: 'Csoportok' },
    { id: 'permission-sets', label: 'Jogosultság-csoportok' },
    { id: 'extensions', label: 'Bővítmények' }
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
 * A.4 / ADR 0008 — szelektív fetch fallback. Csak a collection-not-found
 * jellegű hibát nyeli el (Appwrite 404 vagy `collection_not_found` reason),
 * minden mást továbbdob — különben a hálózati / ACL hiba némán üres listának
 * látszana és a UI hamis "nincs adat" állapotot mutatna.
 *
 * @param {*} err - eldobott Appwrite Exception (vagy fetch error)
 * @param {string} label - debug címke (`'permissionSets'`, `'groupPermissionSets'`)
 * @returns {{ documents: [] }} ha a hiba schema-hiány; egyébként throw
 */
function fallbackOnMissingSchema(err, label) {
    const code = err?.code;
    const type = err?.type;
    const message = err?.message || '';
    const isMissing =
        code === 404 ||
        type === 'collection_not_found' ||
        type === 'database_not_found' ||
        message.toLowerCase().includes('collection_not_found') ||
        message.toLowerCase().includes('collection with the requested id could not be found');
    if (isMissing) {
        console.warn(`[EditorialOfficeSettingsModal] ${label} schema nincs bootstrap-elve — üres listára esünk.`);
        return { documents: [] };
    }
    throw err;
}

/**
 * B.5.1 stop-time follow-up — lapozott listDocuments. A `workflows` és
 * `workflowExtensions` collection-ön a 100-as `Query.limit` silent truncate-et
 * okozna 100+ doc-os office-on (a `WorkflowExtensionsTab` "X workflow
 * hivatkozik rá" badge alulszámolna; az archive-confirm warning hiányos
 * listát adna; a Bővítmények tab nem mutatna minden extension-t).
 * `Query.cursorAfter` doc-`$id`-n alapuló lapozással biztonságosan
 * összegyűjti az összeset, `HARD_LIMIT` az infinite-loop ellen véd.
 *
 * @returns {Promise<{ documents: Object[] }>} a teljes lista — a hívó
 *   ugyanúgy `result.documents`-ot olvas, mint a `listDocuments`-nél
 */
async function listAllPaginated(databases, collectionId, queries) {
    const PAGE_SIZE = 100;
    const HARD_LIMIT = 1000;
    const all = [];
    let cursor = null;
    while (all.length < HARD_LIMIT) {
        const pageQueries = [...queries, Query.limit(PAGE_SIZE)];
        if (cursor) pageQueries.push(Query.cursorAfter(cursor));
        const page = await databases.listDocuments({
            databaseId: DATABASE_ID,
            collectionId,
            queries: pageQueries
        });
        all.push(...page.documents);
        if (page.documents.length < PAGE_SIZE) break;
        cursor = page.documents[page.documents.length - 1].$id;
    }
    if (all.length >= HARD_LIMIT) {
        console.warn(
            `[EditorialOfficeSettingsModal] ${collectionId} HARD_LIMIT (${HARD_LIMIT}) — ennyi doc egy office-ban valószínűleg hibás állapot.`
        );
    }
    return { documents: all };
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

    // --- Groups + Permission Sets tab adata (a shell tölti, a tab propon kapja) ---
    // ADR 0008 (A.4): a permissionSets / groupPermissionSets-et is itt töltjük,
    // mert mind a `groups` tab (csoport-permissionSet hozzárendelés / A.4.5),
    // mind a jövőbeli `permission-sets` tab (A.4.3) ugyanezt használja.
    const [groups, setGroups] = useState([]);
    const [groupMemberships, setGroupMemberships] = useState([]);
    const [officeMembers, setOfficeMembers] = useState([]);
    const [permissionSets, setPermissionSets] = useState([]);
    const [groupPermissionSets, setGroupPermissionSets] = useState([]);
    // B.5.1 — workflow extensions a "Bővítmények" tabhoz; a `workflows`
    // a hivatkozó-warning panelhez (a Phase 0 hatókör csak az office
    // saját workflow-jain scan-el — cross-office hivatkozást szándékosan
    // nem mutatunk, az office Settings UI scope-on kívül esik).
    const [workflowExtensions, setWorkflowExtensions] = useState([]);
    const [workflows, setWorkflows] = useState([]);
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
            const [
                groupsResult,
                membershipsResult,
                officeMembersResult,
                permissionSetsResult,
                groupPermissionSetsResult,
                workflowExtensionsResult,
                workflowsResult
            ] = await Promise.all([
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
                // A.4 / ADR 0008 — szelektív fallback: csak akkor fallback-elünk
                // üres tömbre, ha a collection NEM létezik (`schema_missing`
                // szerű hiba — Appwrite 404). Hálózati / ACL / egyéb tranziens
                // hiba dobódjon tovább, hogy a fő catch-ágban a felhasználó
                // értelmes "Hiba az adatok betöltésekor" üzenetet kapjon —
                // különben a UI némán "nincs jogosultság-csoport"-ot mutatna
                // (Codex review).
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.PERMISSION_SETS,
                    queries: [
                        Query.equal('editorialOfficeId', editorialOfficeId),
                        Query.limit(100)
                    ]
                }).catch((err) => fallbackOnMissingSchema(err, 'permissionSets')),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUP_PERMISSION_SETS,
                    queries: [
                        Query.equal('editorialOfficeId', editorialOfficeId),
                        Query.limit(500)
                    ]
                }).catch((err) => fallbackOnMissingSchema(err, 'groupPermissionSets')),
                // B.5.1 / ADR 0007 Phase 0 — workflow extensions. **Lapozott**
                // (B.5.1 stop-time follow-up): a 100-as `Query.limit` silent
                // truncate-et adott, ami a Bővítmények tab listáját
                // alulszámolná 100+ extension-ös office-on. Ha a collection
                // nincs bootstrap-elve (`bootstrap_workflow_extension_schema`
                // owner-only action még nem futott), üres listát mutatunk —
                // a UI továbbra is működik, csak a "Nincs még bővítmény"
                // empty-state jelenik meg.
                listAllPaginated(databases, COLLECTIONS.WORKFLOW_EXTENSIONS, [
                    Query.equal('editorialOfficeId', editorialOfficeId)
                ]).catch((err) => fallbackOnMissingSchema(err, 'workflowExtensions')),
                // Workflows — a "X workflow hivatkozik rá" badge + archive
                // confirm dialógus warning-jához kell. **Lapozott** (B.5.1
                // stop-time follow-up): 100+ workflow-os office-on a 100-as
                // cap silent under-report-ot okozott a hivatkozás-számláláson
                // — a felhasználó "0 workflow hivatkozik rá"-t látott volna
                // egy archiválás-blokkoló valódi referencia mellett.
                listAllPaginated(databases, COLLECTIONS.WORKFLOWS, [
                    Query.equal('editorialOfficeId', editorialOfficeId)
                ]).catch((err) => fallbackOnMissingSchema(err, 'workflows'))
            ]);

            if (gen !== loadGenRef.current) return;

            setGroups(groupsResult.documents);
            setGroupMemberships(membershipsResult.documents);
            setOfficeMembers(officeMembersResult.documents);
            setPermissionSets(permissionSetsResult.documents);
            setGroupPermissionSets(groupPermissionSetsResult.documents);
            setWorkflowExtensions(workflowExtensionsResult.documents);
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
                            permissionSets={permissionSets}
                            groupPermissionSets={groupPermissionSets}
                            isLoading={isLoading}
                            isOrgAdmin={isOrgAdmin}
                            onReload={loadData}
                        />
                    )}

                    {activeTab === 'permission-sets' && (
                        <PermissionSetsTab
                            office={office}
                            permissionSets={permissionSets}
                            groupPermissionSets={groupPermissionSets}
                            groups={groups}
                            isLoading={isLoading}
                            isOrgAdmin={isOrgAdmin}
                            onReload={loadData}
                        />
                    )}

                    {activeTab === 'extensions' && (
                        <WorkflowExtensionsTab
                            office={office}
                            extensions={workflowExtensions}
                            workflows={workflows}
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
