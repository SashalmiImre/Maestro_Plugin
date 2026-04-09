/**
 * Maestro Dashboard — GroupsRoute
 *
 * A `/settings/groups` route. Az aktív szerkesztőség csoportjainak kezelése:
 * tagok listázása, tag hozzáadása, tag eltávolítása.
 *
 * A 7 alapértelmezett csoport a bootstrap_organization CF-ből jön.
 * Csoport create/delete egyelőre nincs (a 7 default elég).
 *
 * Fázis 2 / B.13
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Databases, Functions, Query } from 'appwrite';
import { getClient } from '../../contexts/AuthContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { DATABASE_ID, COLLECTIONS, FUNCTIONS } from '../../config.js';

export default function GroupsRoute() {
    const { user } = useAuth();
    const { activeEditorialOfficeId } = useScope();
    const [groups, setGroups] = useState([]);
    const [memberships, setMemberships] = useState([]); // az összes groupMembership a scope-ban
    const [eligibleUsers, setEligibleUsers] = useState([]); // office-tagok (hozzáadáshoz)
    const [isLoading, setIsLoading] = useState(true);
    const [actionError, setActionError] = useState('');
    const [actionPending, setActionPending] = useState(null); // 'add:groupId:userId' vagy 'remove:membershipId'

    const client = getClient();
    const databases = new Databases(client);
    const functions = new Functions(client);

    // --- Adatok betöltése ---

    const loadData = useCallback(async () => {
        if (!activeEditorialOfficeId) {
            setGroups([]);
            setMemberships([]);
            setEligibleUsers([]);
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        try {
            const [groupsResult, membershipsResult, officeMembersResult] = await Promise.all([
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUPS,
                    queries: [
                        Query.equal('editorialOfficeId', activeEditorialOfficeId),
                        Query.limit(100)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
                    queries: [
                        Query.equal('editorialOfficeId', activeEditorialOfficeId),
                        Query.limit(500)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.EDITORIAL_OFFICE_MEMBERSHIPS,
                    queries: [
                        Query.equal('editorialOfficeId', activeEditorialOfficeId),
                        Query.limit(200)
                    ]
                })
            ]);

            setGroups(groupsResult.documents);
            setMemberships(membershipsResult.documents);
            setEligibleUsers(officeMembersResult.documents);
        } catch (err) {
            console.error('[GroupsRoute] Adatok betöltése sikertelen:', err);
            setActionError('Hiba az adatok betöltésekor.');
        } finally {
            setIsLoading(false);
        }
    }, [activeEditorialOfficeId]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // --- CF hívás helper ---

    async function callGroupAction(action, payload) {
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

    // --- Tag hozzáadása ---

    async function handleAddMember(groupId, userId) {
        const pendingKey = `add:${groupId}:${userId}`;
        setActionPending(pendingKey);
        setActionError('');

        try {
            await callGroupAction('add_group_member', { groupId, userId });
            await loadData();
        } catch (err) {
            setActionError(`Hiba a tag hozzáadásakor: ${err.message}`);
        } finally {
            setActionPending(null);
        }
    }

    // --- Tag eltávolítása ---

    async function handleRemoveMember(groupId, userId) {
        const pendingKey = `remove:${groupId}:${userId}`;
        setActionPending(pendingKey);
        setActionError('');

        try {
            await callGroupAction('remove_group_member', { groupId, userId });
            await loadData();
        } catch (err) {
            setActionError(`Hiba a tag eltávolításakor: ${err.message}`);
        } finally {
            setActionPending(null);
        }
    }

    // --- Render ---

    if (!activeEditorialOfficeId) {
        return (
            <div className="login-card" style={{ maxWidth: 600 }}>
                <div className="form-heading">Csoportok</div>
                <p>Nincs aktív szerkesztőség kiválasztva.</p>
                <div className="auth-bottom-link">
                    <Link to="/">Vissza a Dashboardra</Link>
                </div>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="login-card" style={{ maxWidth: 600 }}>
                <div className="form-heading">Csoportok</div>
                <p>Betöltés...</p>
            </div>
        );
    }

    return (
        <div className="login-card" style={{ maxWidth: 700 }}>
            <div className="form-heading">Csoportok kezelése</div>

            {actionError && <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>}

            {groups.length === 0 && (
                <p>Nincsenek csoportok ebben a szerkesztőségben.</p>
            )}

            {groups.map(group => {
                const groupMembers = memberships.filter(m => m.groupId === group.$id);
                const memberUserIds = new Set(groupMembers.map(m => m.userId));
                // Tagként nem szereplő office-tagok
                const nonMembers = eligibleUsers.filter(u => !memberUserIds.has(u.userId));

                return (
                    <div key={group.$id} style={{ marginBottom: 20, borderBottom: '1px solid #333', paddingBottom: 16 }}>
                        <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                            {group.name} <span style={{ color: '#888', fontWeight: 400 }}>({group.slug})</span>
                        </h3>

                        {/* Tagok listája */}
                        {groupMembers.length === 0 ? (
                            <p style={{ fontSize: 12, color: '#888', margin: '4px 0' }}>Nincs tag.</p>
                        ) : (
                            <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 8px 0' }}>
                                {groupMembers.map(m => (
                                    <li key={m.$id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '2px 0' }}>
                                        <span>{m.userName || m.userEmail || m.userId}</span>
                                        {m.userEmail && m.userName && (
                                            <span style={{ color: '#888', fontSize: 11 }}>({m.userEmail})</span>
                                        )}
                                        <button
                                            onClick={() => handleRemoveMember(group.$id, m.userId)}
                                            disabled={!!actionPending}
                                            style={{
                                                marginLeft: 'auto', background: 'none', border: '1px solid #666',
                                                color: '#ccc', padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                                                fontSize: 11
                                            }}
                                        >
                                            {actionPending === `remove:${group.$id}:${m.userId}` ? '...' : 'Eltávolítás'}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}

                        {/* Tag hozzáadása dropdown */}
                        {nonMembers.length > 0 && (
                            <AddMemberDropdown
                                groupId={group.$id}
                                nonMembers={nonMembers}
                                actionPending={actionPending}
                                onAdd={handleAddMember}
                            />
                        )}
                    </div>
                );
            })}

            <div className="auth-bottom-link" style={{ marginTop: 16 }}>
                <Link to="/">Vissza a Dashboardra</Link>
            </div>
        </div>
    );
}

/**
 * Kis dropdown + gomb a tag hozzáadásához.
 */
function AddMemberDropdown({ groupId, nonMembers, actionPending, onAdd }) {
    const [selectedUserId, setSelectedUserId] = useState('');

    return (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
                value={selectedUserId}
                onChange={e => setSelectedUserId(e.target.value)}
                style={{
                    flex: 1, fontSize: 12, padding: '4px 6px',
                    background: '#222', color: '#ccc', border: '1px solid #555',
                    borderRadius: 4
                }}
            >
                <option value="">Tag hozzáadása...</option>
                {nonMembers.map(u => (
                    <option key={u.userId} value={u.userId}>
                        {u.userId}
                    </option>
                ))}
            </select>
            <button
                onClick={() => {
                    if (selectedUserId) {
                        onAdd(groupId, selectedUserId);
                        setSelectedUserId('');
                    }
                }}
                disabled={!selectedUserId || !!actionPending}
                style={{
                    background: '#2563eb', color: '#fff', border: 'none',
                    padding: '4px 12px', borderRadius: 4, cursor: 'pointer',
                    fontSize: 12
                }}
            >
                {actionPending === `add:${groupId}:${selectedUserId}` ? '...' : 'Hozzáadás'}
            </button>
        </div>
    );
}
