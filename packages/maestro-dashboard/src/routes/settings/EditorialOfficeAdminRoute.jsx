/**
 * Maestro Dashboard — EditorialOfficeAdminRoute
 *
 * A `/settings/editorial-office` route. Az aktív szerkesztőség kezelése:
 * - Szerkesztőség info (név, slug)
 * - Tagok és csoportok mátrix (user-központú nézet, toggle badge-ek)
 * - Csoportok összesítés (tagszámmal, link a GroupsRoute-ra)
 * - Workflow designer link
 *
 * Fázis 6
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Databases, Functions, Query } from 'appwrite';
import { getClient, useAuth } from '../../contexts/AuthContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { DATABASE_ID, COLLECTIONS, FUNCTIONS } from '../../config.js';

/**
 * CF hívás helper — OrganizationAdminRoute mintájára.
 */
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

/**
 * Magyar hibaüzenetek.
 */
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

export default function EditorialOfficeAdminRoute() {
    const { user, organizations, editorialOffices } = useAuth();
    const { activeOrganizationId, activeEditorialOfficeId } = useScope();

    const office = editorialOffices?.find(o => o.$id === activeEditorialOfficeId) || null;
    const org = organizations?.find(o => o.$id === activeOrganizationId) || null;

    // --- Adat state-ek ---
    const [groups, setGroups] = useState([]);
    const [groupMemberships, setGroupMemberships] = useState([]);
    const [officeMembers, setOfficeMembers] = useState([]);
    const [hasWorkflow, setHasWorkflow] = useState(false);
    const [isOrgAdmin, setIsOrgAdmin] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [actionError, setActionError] = useState('');
    const [actionPending, setActionPending] = useState(null); // 'toggle:userId:groupId'

    /** Fetch generáció-számláló — scope-váltáskor az elavult válasz eldobása. */
    const loadGenRef = useRef(0);

    const client = getClient();
    const databases = new Databases(client);
    const functions = new Functions(client);

    // --- Derived struktúrák ---

    /** Névfeloldás Map — groupMemberships denormalizált mezőiből. */
    const userNameMap = useMemo(() => {
        const map = new Map();
        for (const gm of groupMemberships) {
            if (!map.has(gm.userId)) {
                map.set(gm.userId, { name: gm.userName || null, email: gm.userEmail || null });
            }
        }
        return map;
    }, [groupMemberships]);

    /** O(1) lookup: a user tagja-e a csoportnak? */
    const membershipLookup = useMemo(() => {
        const set = new Set();
        for (const gm of groupMemberships) {
            set.add(`${gm.userId}:${gm.groupId}`);
        }
        return set;
    }, [groupMemberships]);

    /** Csoportonkénti tagszám. */
    const groupMemberCounts = useMemo(() => {
        const counts = new Map();
        for (const gm of groupMemberships) {
            counts.set(gm.groupId, (counts.get(gm.groupId) || 0) + 1);
        }
        return counts;
    }, [groupMemberships]);

    // --- Adatok betöltése ---

    const loadData = useCallback(async () => {
        if (!activeEditorialOfficeId || !activeOrganizationId) {
            ++loadGenRef.current;
            setGroups([]);
            setGroupMemberships([]);
            setOfficeMembers([]);
            setHasWorkflow(false);
            setIsOrgAdmin(false);
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        // Stale adat törlés office-váltáskor
        setGroups([]);
        setGroupMemberships([]);
        setOfficeMembers([]);
        setHasWorkflow(false);
        setIsOrgAdmin(false);

        const gen = ++loadGenRef.current;

        try {
            const [groupsResult, membershipsResult, officeMembersResult, orgMembersResult, workflowsResult] = await Promise.all([
                // Csoportok
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUPS,
                    queries: [
                        Query.equal('editorialOfficeId', activeEditorialOfficeId),
                        Query.limit(100)
                    ]
                }),
                // Csoporttagságok (denormalizált userName/userEmail)
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
                    queries: [
                        Query.equal('editorialOfficeId', activeEditorialOfficeId),
                        Query.limit(500)
                    ]
                }),
                // Office tagok
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.EDITORIAL_OFFICE_MEMBERSHIPS,
                    queries: [
                        Query.equal('editorialOfficeId', activeEditorialOfficeId),
                        Query.limit(200)
                    ]
                }),
                // Saját org tagság (admin jogosultság ellenőrzés — csak 1 doc)
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.ORGANIZATION_MEMBERSHIPS,
                    queries: [
                        Query.equal('organizationId', activeOrganizationId),
                        Query.equal('userId', user?.$id || ''),
                        Query.limit(1)
                    ]
                }),
                // Workflow létezés check (csak 1 doc kell)
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.WORKFLOWS,
                    queries: [
                        Query.equal('editorialOfficeId', activeEditorialOfficeId),
                        Query.limit(1)
                    ]
                })
            ]);

            // Elavult válasz eldobása (scope-váltás közben érkezett)
            if (gen !== loadGenRef.current) return;

            setGroups(groupsResult.documents);
            setGroupMemberships(membershipsResult.documents);
            setOfficeMembers(officeMembersResult.documents);
            setHasWorkflow(workflowsResult.documents.length > 0);

            // Jogosultság: a user owner/admin-e az orgban?
            const myMembership = orgMembersResult.documents[0];
            setIsOrgAdmin(myMembership?.role === 'owner' || myMembership?.role === 'admin');
        } catch (err) {
            if (gen !== loadGenRef.current) return;
            console.error('[EditorialOfficeAdminRoute] Adatok betöltése sikertelen:', err);
            setActionError('Hiba az adatok betöltésekor.');
        } finally {
            if (gen === loadGenRef.current) setIsLoading(false);
        }
    }, [activeEditorialOfficeId, activeOrganizationId]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // --- Csoport toggle ---

    /** Csak a groupMemberships újratöltése — a toggle után a többi adat nem változik. */
    async function reloadGroupMemberships() {
        const result = await databases.listDocuments({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
            queries: [
                Query.equal('editorialOfficeId', activeEditorialOfficeId),
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
            // Scope-váltás közben érkezett válasz eldobása
            if (gen !== loadGenRef.current) return;
            await reloadGroupMemberships();
        } catch (err) {
            if (gen !== loadGenRef.current) return;
            setActionError(errorMessage(err.message));
        } finally {
            if (gen === loadGenRef.current) setActionPending(null);
        }
    }

    // --- Render ---

    if (!activeEditorialOfficeId) {
        return (
            <div className="login-card" style={{ maxWidth: 700 }}>
                <div className="form-heading">Szerkesztőség kezelése</div>
                <p>Nincs aktív szerkesztőség kiválasztva.</p>
                <div className="auth-bottom-link">
                    <Link to="/">Vissza a Dashboardra</Link>
                </div>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="login-card" style={{ maxWidth: 700 }}>
                <div className="form-heading">Szerkesztőség kezelése</div>
                <p>Betöltés...</p>
            </div>
        );
    }

    return (
        <div className="login-card" style={{ maxWidth: 700 }}>
            <div className="form-heading">Szerkesztőség kezelése</div>

            {actionError && <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>}

            {/* ═══ 1. Szerkesztőség info ═══ */}
            <div style={{ marginBottom: 20, borderBottom: '1px solid #333', paddingBottom: 16 }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                    Szerkesztőség
                </h3>
                <div style={{ fontSize: 13 }}>
                    <span>{office?.name || '—'}</span>
                    <span style={{ color: '#888', fontSize: 11, marginLeft: 6 }}>({office?.slug})</span>
                </div>
                {org && (
                    <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                        Szervezet: {org.name}
                    </div>
                )}
            </div>

            {/* ═══ 2. Tagok és csoportok mátrix ═══ */}
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

            {/* ═══ 3. Csoportok összesítés ═══ */}
            <div style={{ marginBottom: 20, borderBottom: '1px solid #333', paddingBottom: 16 }}>
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

                <Link
                    to="/settings/groups"
                    style={{ fontSize: 12, color: '#adc6ff', textDecoration: 'none' }}
                >
                    Részletes csoportkezelés →
                </Link>
            </div>

            {/* ═══ 4. Workflow ═══ */}
            <div style={{ marginBottom: 20, paddingBottom: 16 }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                    Workflow
                </h3>

                {hasWorkflow ? (
                    <Link
                        to={`/admin/office/${activeEditorialOfficeId}/workflow`}
                        style={{ fontSize: 12, color: '#adc6ff', textDecoration: 'none' }}
                    >
                        Workflow tervező megnyitása →
                    </Link>
                ) : (
                    <p style={{ fontSize: 12, color: '#888', margin: '4px 0' }}>
                        Nincs workflow konfigurálva.
                    </p>
                )}
            </div>

            {/* ═══ Navigáció ═══ */}
            <div className="auth-bottom-link" style={{ marginTop: 16 }}>
                <Link to="/">Vissza a Dashboardra</Link>
            </div>
        </div>
    );
}
