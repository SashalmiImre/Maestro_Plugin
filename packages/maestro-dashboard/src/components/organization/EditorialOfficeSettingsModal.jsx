/**
 * Maestro Dashboard — EditorialOfficeSettingsModal
 *
 * Szerkesztőség kezelő modal (Általános / Csoportok / Workflow fülek). A
 * BreadcrumbDropdown szerkesztőség-dropdownjának „Beállítások" menüpontja
 * nyitja meg. Aktív fül localStorage-ben perzisztált.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Databases, Functions, Query } from 'appwrite';
import { getClient, useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import Tabs from '../Tabs.jsx';
import EditorialOfficeGeneralTab from './EditorialOfficeGeneralTab.jsx';
import { DATABASE_ID, COLLECTIONS, FUNCTIONS } from '../../config.js';

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

async function callOrgAction(functions, action, payload) {
    const execution = await functions.createExecution({
        functionId: FUNCTIONS.INVITE_TO_ORGANIZATION,
        body: JSON.stringify({ action, ...payload }),
        async: false,
        method: 'POST',
        headers: { 'content-type': 'application/json' }
    });

    let response;
    try {
        response = JSON.parse(execution.responseBody || '{}');
    } catch {
        throw new Error('Érvénytelen válasz a szervertől.');
    }

    if (!response.success) {
        throw new Error(response.reason || 'Ismeretlen hiba.');
    }
    return response;
}

function errorMessage(reason) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('not_a_member')) return 'Nem vagy tagja ennek a szervezetnek.';
    if (reason.includes('insufficient_role')) return 'Nincs jogosultságod ehhez a művelethez.';
    if (reason.includes('user_not_office_member')) return 'A felhasználó nem tagja a szerkesztőségnek.';
    if (reason.includes('already_member')) return 'A felhasználó már tagja a csoportnak.';
    if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) {
        return 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';
    }
    return reason;
}

/**
 * Toggle badge egy csoporthoz — színes ha aktív, szürke ha nem.
 */
function GroupBadge({ label, isActive, isPending, canEdit, onToggle }) {
    return (
        <span
            onClick={canEdit && !isPending ? onToggle : undefined}
            style={{
                display: 'inline-block',
                fontSize: 10,
                padding: '2px 8px',
                borderRadius: 3,
                cursor: canEdit && !isPending ? 'pointer' : 'default',
                marginRight: 4,
                marginBottom: 2,
                border: isActive ? '1px solid #3b82f6' : '1px solid #555',
                background: isActive ? 'rgba(59, 130, 246, 0.15)' : '#282a30',
                color: isActive ? '#93bbfc' : '#666',
                opacity: isPending ? 0.5 : 1,
                transition: 'all 0.15s ease',
                userSelect: 'none'
            }}
        >
            {isPending ? '...' : label}
        </span>
    );
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
    const navigate = useNavigate();

    const office = editorialOffices?.find(o => o.$id === editorialOfficeId) || null;
    const org = office ? organizations?.find(o => o.$id === office.organizationId) || null : null;

    const [activeTab, setActiveTab] = useState(() => initialTab || getStoredTab());

    // --- Adat state-ek (Groups + Workflow tab-ok placeholder-jének) ---
    const [groups, setGroups] = useState([]);
    const [groupMemberships, setGroupMemberships] = useState([]);
    const [officeMembers, setOfficeMembers] = useState([]);
    const [hasWorkflow, setHasWorkflow] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [actionError, setActionError] = useState('');
    const [actionPending, setActionPending] = useState(null);

    const loadGenRef = useRef(0);

    const client = getClient();
    const databases = useMemo(() => new Databases(client), [client]);
    const functions = useMemo(() => new Functions(client), [client]);

    // A caller org-szintű role-ját az AuthContext orgMemberships state-ből olvassuk.
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

    // --- Derived struktúrák (Groups tab) ---

    const userNameMap = useMemo(() => {
        const map = new Map();
        for (const gm of groupMemberships) {
            if (!map.has(gm.userId)) {
                map.set(gm.userId, { name: gm.userName || null, email: gm.userEmail || null });
            }
        }
        return map;
    }, [groupMemberships]);

    const membershipLookup = useMemo(() => {
        const set = new Set();
        for (const gm of groupMemberships) {
            set.add(`${gm.userId}:${gm.groupId}`);
        }
        return set;
    }, [groupMemberships]);

    const groupMemberCounts = useMemo(() => {
        const counts = new Map();
        for (const gm of groupMemberships) {
            counts.set(gm.groupId, (counts.get(gm.groupId) || 0) + 1);
        }
        return counts;
    }, [groupMemberships]);

    // --- Adatok betöltése ---

    const loadData = useCallback(async () => {
        if (!editorialOfficeId) {
            ++loadGenRef.current;
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        setGroups([]);
        setGroupMemberships([]);
        setOfficeMembers([]);
        setHasWorkflow(false);

        const gen = ++loadGenRef.current;

        try {
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
                        Query.select(['$id']),
                        Query.limit(1)
                    ]
                })
            ]);

            if (gen !== loadGenRef.current) return;

            setGroups(groupsResult.documents);
            setGroupMemberships(membershipsResult.documents);
            setOfficeMembers(officeMembersResult.documents);
            setHasWorkflow(workflowsResult.documents.length > 0);
        } catch (err) {
            if (gen !== loadGenRef.current) return;
            console.error('[EditorialOfficeSettingsModal] Adatok betöltése sikertelen:', err);
            setActionError('Hiba az adatok betöltésekor.');
        } finally {
            if (gen === loadGenRef.current) setIsLoading(false);
        }
    }, [editorialOfficeId, databases]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // --- Csoport toggle (Groups tab) ---

    async function reloadGroupMemberships() {
        const result = await databases.listDocuments({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
            queries: [
                Query.equal('editorialOfficeId', editorialOfficeId),
                Query.limit(500)
            ]
        });
        setGroupMemberships(result.documents);
    }

    async function handleToggleGroup(userId, groupId, isCurrentlyMember) {
        const pendingKey = `toggle:${userId}:${groupId}`;
        const gen = loadGenRef.current;
        setActionPending(pendingKey);
        setActionError('');

        try {
            const action = isCurrentlyMember ? 'remove_group_member' : 'add_group_member';
            await callOrgAction(functions, action, { groupId, userId });
            if (gen !== loadGenRef.current) return;
            await reloadGroupMemberships();
        } catch (err) {
            if (gen !== loadGenRef.current) return;
            setActionError(errorMessage(err.message));
        } finally {
            if (gen === loadGenRef.current) setActionPending(null);
        }
    }

    function handleOpenWorkflowDesigner() {
        closeModal();
        navigate(`/admin/office/${editorialOfficeId}/workflow`);
    }

    function handleOpenGroupsRoute() {
        closeModal();
        navigate('/settings/groups');
    }

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
                {activeTab !== 'general' && actionError && (
                    <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>
                )}

                {activeTab === 'general' && (
                    <EditorialOfficeGeneralTab
                        office={office}
                        org={org}
                        callerRole={callerRole}
                    />
                )}

                {activeTab === 'groups' && (
                    <>
                        {isLoading ? (
                            <div className="form-empty-state">Betöltés…</div>
                        ) : (
                            <>
                                {/* ═══ Tagok és csoportok mátrix ═══ */}
                                <div style={{ marginBottom: 20, borderBottom: '1px solid #333', paddingBottom: 16 }}>
                                    <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                                        Tagok és csoportok{' '}
                                        <span style={{ color: '#888', fontWeight: 400, fontSize: 12 }}>
                                            ({officeMembers.length} tag, {groups.length} csoport)
                                        </span>
                                    </h3>

                                    {officeMembers.length === 0 ? (
                                        <p style={{ fontSize: 12, color: '#888', margin: '4px 0' }}>
                                            Nincsenek tagok a szerkesztőségben.
                                        </p>
                                    ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                            {officeMembers.map(member => {
                                                const resolved = userNameMap.get(member.userId);
                                                const displayName = resolved?.name || resolved?.email || member.userId;
                                                const displayEmail = resolved?.name && resolved?.email ? resolved.email : null;

                                                return (
                                                    <div key={member.$id} style={{
                                                        display: 'flex', alignItems: 'center', gap: 8,
                                                        fontSize: 13, padding: '4px 0',
                                                        flexWrap: 'wrap'
                                                    }}>
                                                        <div style={{ minWidth: 140, flexShrink: 0 }}>
                                                            <span>{displayName}</span>
                                                            {displayEmail && (
                                                                <span style={{ color: '#888', fontSize: 11, marginLeft: 4 }}>
                                                                    ({displayEmail})
                                                                </span>
                                                            )}
                                                        </div>

                                                        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                                                            {groups.map(group => {
                                                                const key = `${member.userId}:${group.$id}`;
                                                                const isActive = membershipLookup.has(key);
                                                                const isPending = actionPending === `toggle:${member.userId}:${group.$id}`;

                                                                return (
                                                                    <GroupBadge
                                                                        key={group.$id}
                                                                        label={group.name}
                                                                        isActive={isActive}
                                                                        isPending={isPending}
                                                                        canEdit={isOrgAdmin && !actionPending}
                                                                        onToggle={() => handleToggleGroup(member.userId, group.$id, isActive)}
                                                                    />
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {!isOrgAdmin && officeMembers.length > 0 && (
                                        <p style={{ fontSize: 11, color: '#888', marginTop: 8, fontStyle: 'italic' }}>
                                            Csoporttagság módosításához szervezeti admin jogosultság szükséges.
                                        </p>
                                    )}
                                </div>

                                {/* ═══ Csoportok összesítés ═══ */}
                                <div style={{ marginBottom: 20 }}>
                                    <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                                        Csoportok
                                    </h3>

                                    {groups.length === 0 ? (
                                        <p style={{ fontSize: 12, color: '#888', margin: '4px 0' }}>Nincsenek csoportok.</p>
                                    ) : (
                                        <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 8px 0' }}>
                                            {groups.map(group => (
                                                <li key={group.$id} style={{
                                                    display: 'flex', alignItems: 'center', gap: 8,
                                                    fontSize: 13, padding: '2px 0'
                                                }}>
                                                    <span>{group.name}</span>
                                                    <span style={{ color: '#888', fontSize: 11 }}>({group.slug})</span>
                                                    <span style={{
                                                        fontSize: 10, color: '#888', background: '#282a30',
                                                        padding: '1px 6px', borderRadius: 3
                                                    }}>
                                                        {groupMemberCounts.get(group.$id) || 0} tag
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}

                                    <button
                                        type="button"
                                        onClick={handleOpenGroupsRoute}
                                        style={{
                                            fontSize: 12, color: '#adc6ff', textDecoration: 'none',
                                            background: 'none', border: 'none', cursor: 'pointer', padding: 0
                                        }}
                                    >
                                        Részletes csoportkezelés →
                                    </button>
                                </div>
                            </>
                        )}
                    </>
                )}

                {activeTab === 'workflow' && (
                    <>
                        {isLoading ? (
                            <div className="form-empty-state">Betöltés…</div>
                        ) : (
                            <div style={{ marginBottom: 20 }}>
                                <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                                    Workflow
                                </h3>

                                {hasWorkflow ? (
                                    <button
                                        type="button"
                                        onClick={handleOpenWorkflowDesigner}
                                        style={{
                                            fontSize: 12, color: '#adc6ff', textDecoration: 'none',
                                            background: 'none', border: 'none', cursor: 'pointer', padding: 0
                                        }}
                                    >
                                        Workflow tervező megnyitása →
                                    </button>
                                ) : (
                                    <p style={{ fontSize: 12, color: '#888', margin: '4px 0' }}>
                                        Nincs workflow konfigurálva.
                                    </p>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
