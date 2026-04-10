/**
 * Maestro Dashboard — OrganizationAdminRoute
 *
 * A `/settings/organization` route. Az aktív szervezet kezelése:
 * - Szervezet nevének szerkesztése
 * - Új felhasználó meghívása (email + role → token link)
 * - Függő meghívók listája
 * - Tagok listája (névfeloldás groupMemberships-ből)
 * - Szerkesztőségek listája (workflow designer linkkel)
 *
 * Fázis 6
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Databases, Functions, Query } from 'appwrite';
import { getClient, useAuth } from '../../contexts/AuthContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { DATABASE_ID, COLLECTIONS, FUNCTIONS, DASHBOARD_URL } from '../../config.js';

/**
 * CF hívás helper — GroupsRoute mintájára.
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
 * Magyar hibaüzenetek a CF hibakódokhoz.
 */
function errorMessage(reason) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';

    if (reason.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (reason.includes('invalid_name')) return 'A név nem lehet üres és nem haladhatja meg a 128 karaktert.';
    if (reason.includes('invalid_email')) return 'Érvénytelen e-mail cím formátum.';
    if (reason.includes('invalid_role')) return 'Érvénytelen szerepkör.';
    if (reason.includes('not_a_member')) return 'Nem vagy tagja ennek a szervezetnek.';
    if (reason.includes('insufficient_role')) return 'Nincs jogosultságod ehhez a művelethez.';
    if (reason.includes('update_failed')) return 'A szervezet frissítése sikertelen. Próbáld újra.';
    if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) {
        return 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';
    }

    return reason;
}

/**
 * Role megjelenítő — magyar nyelvű badge szöveg.
 */
function roleLabel(role) {
    switch (role) {
        case 'owner': return 'Tulajdonos';
        case 'admin': return 'Admin';
        case 'member': return 'Tag';
        default: return role;
    }
}

export default function OrganizationAdminRoute() {
    const { user, organizations, createInvite, reloadMemberships } = useAuth();
    const { activeOrganizationId } = useScope();

    // Org dokumentum az AuthContext memberships-ből (nincs extra query)
    const org = organizations?.find(o => o.$id === activeOrganizationId) || null;

    // --- Adat state-ek ---
    const [members, setMembers] = useState([]);
    const [pendingInvites, setPendingInvites] = useState([]);
    const [offices, setOffices] = useState([]);
    const [userNameMap, setUserNameMap] = useState(new Map());
    const [isOrgAdmin, setIsOrgAdmin] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [actionError, setActionError] = useState('');
    const [actionPending, setActionPending] = useState(null);

    // --- Org név szerkesztés ---
    const [isEditingName, setIsEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState('');

    // --- Meghívó form ---
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRole, setInviteRole] = useState('member');
    const [inviteMessage, setInviteMessage] = useState('');
    const [inviteSuccess, setInviteSuccess] = useState('');

    // --- Clipboard „Másolva!" visszajelzés ---
    const [copiedId, setCopiedId] = useState(null);
    const copyTimerRef = useRef(null);

    const client = getClient();
    const databases = new Databases(client);
    const functions = new Functions(client);

    // --- Adatok betöltése ---

    const loadData = useCallback(async () => {
        if (!activeOrganizationId) {
            setMembers([]);
            setPendingInvites([]);
            setOffices([]);
            setUserNameMap(new Map());
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        // Org-váltáskor azonnal töröljük a régi adatokat — ne maradjon stale adat másik orgból
        setMembers([]);
        setPendingInvites([]);
        setOffices([]);
        setUserNameMap(new Map());
        setIsOrgAdmin(false);
        try {
            const [membersResult, invitesResult, officesResult, groupMembersResult] = await Promise.all([
                // Tagok
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.ORGANIZATION_MEMBERSHIPS,
                    queries: [
                        Query.equal('organizationId', activeOrganizationId),
                        Query.limit(200)
                    ]
                }),
                // Függő meghívók
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.ORGANIZATION_INVITES,
                    queries: [
                        Query.equal('organizationId', activeOrganizationId),
                        Query.equal('status', 'pending'),
                        Query.limit(100)
                    ]
                }),
                // Szerkesztőségek
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.EDITORIAL_OFFICES,
                    queries: [
                        Query.equal('organizationId', activeOrganizationId),
                        Query.limit(100)
                    ]
                }),
                // GroupMemberships a névfeloldáshoz (userName/userEmail denormalizált)
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
                    queries: [
                        Query.equal('organizationId', activeOrganizationId),
                        Query.limit(500)
                    ]
                })
            ]);

            setMembers(membersResult.documents);
            setPendingInvites(invitesResult.documents);
            setOffices(officesResult.documents);

            // Jogosultság: a user owner/admin-e ebben az orgban?
            const myMembership = membersResult.documents.find(m => m.userId === user?.$id);
            setIsOrgAdmin(myMembership?.role === 'owner' || myMembership?.role === 'admin');

            // Névfeloldás Map építése
            const nameMap = new Map();
            for (const gm of groupMembersResult.documents) {
                if (!nameMap.has(gm.userId)) {
                    nameMap.set(gm.userId, {
                        name: gm.userName || null,
                        email: gm.userEmail || null
                    });
                }
            }
            setUserNameMap(nameMap);
        } catch (err) {
            console.error('[OrganizationAdminRoute] Adatok betöltése sikertelen:', err);
            setActionError('Hiba az adatok betöltésekor.');
        } finally {
            setIsLoading(false);
        }
    }, [activeOrganizationId]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    /** Meghívó küldés után csak a pending invite listát frissítjük. */
    const reloadInvites = useCallback(async () => {
        if (!activeOrganizationId) return;
        try {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.ORGANIZATION_INVITES,
                queries: [
                    Query.equal('organizationId', activeOrganizationId),
                    Query.equal('status', 'pending'),
                    Query.limit(100)
                ]
            });
            setPendingInvites(result.documents);
        } catch { loadData(); }
    }, [activeOrganizationId]);

    // Cleanup a copy timer-hez
    useEffect(() => {
        return () => {
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        };
    }, []);

    // --- Org név mentése ---

    async function handleSaveName() {
        const trimmed = nameDraft.trim();
        if (!trimmed || trimmed === org?.name) {
            setIsEditingName(false);
            return;
        }

        setActionPending('rename');
        setActionError('');

        try {
            await callOrgAction(functions, 'update_organization', {
                organizationId: activeOrganizationId,
                name: trimmed
            });
            // A reloadMemberships frissíti az AuthContext organizations-t → a derived org automatikusan frissül
            setIsEditingName(false);
            try { await reloadMemberships(); } catch { /* membershipsError state kezeli */ }
        } catch (err) {
            setActionError(errorMessage(err.message));
        } finally {
            setActionPending(null);
        }
    }

    // --- Meghívó küldése ---

    async function handleInvite(e) {
        e.preventDefault();
        const trimmedEmail = inviteEmail.trim().toLowerCase();
        if (!trimmedEmail) return;

        setActionPending('invite');
        setActionError('');
        setInviteSuccess('');

        try {
            const result = await createInvite(activeOrganizationId, trimmedEmail, inviteRole, inviteMessage.trim() || undefined);
            const link = `${DASHBOARD_URL}/invite?token=${result.token}`;

            // Vágólapra másolás
            try {
                await navigator.clipboard.writeText(link);
                setInviteSuccess('Meghívó link a vágólapra másolva!');
            } catch {
                setInviteSuccess(`Meghívó link: ${link}`);
            }

            setInviteEmail('');
            setInviteRole('member');
            setInviteMessage('');
            await reloadInvites();
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    // --- Link másolása (függő meghívóknál) ---

    async function handleCopyLink(invite) {
        const link = `${DASHBOARD_URL}/invite?token=${invite.token}`;
        try {
            await navigator.clipboard.writeText(link);
            setCopiedId(invite.$id);
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
            copyTimerRef.current = setTimeout(() => setCopiedId(null), 2000);
        } catch {
            // Fallback — prompt-ban mutatjuk a linket
            window.prompt('Másold ki a meghívó linket:', link);
        }
    }

    // --- Render ---

    if (!activeOrganizationId) {
        return (
            <div className="login-card" style={{ maxWidth: 700 }}>
                <div className="form-heading">Szervezet kezelése</div>
                <p>Nincs aktív szervezet kiválasztva.</p>
                <div className="auth-bottom-link">
                    <Link to="/">Vissza a Dashboardra</Link>
                </div>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="login-card" style={{ maxWidth: 700 }}>
                <div className="form-heading">Szervezet kezelése</div>
                <p>Betöltés...</p>
            </div>
        );
    }

    return (
        <div className="login-card" style={{ maxWidth: 700 }}>
            <div className="form-heading">Szervezet kezelése</div>

            {actionError && <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>}

            {/* ═══ 1. Szervezet neve ═══ */}
            <div style={{ marginBottom: 20, borderBottom: '1px solid #333', paddingBottom: 16 }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                    Szervezet neve
                </h3>

                {isEditingName && isOrgAdmin ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                            type="text"
                            value={nameDraft}
                            onChange={e => setNameDraft(e.target.value)}
                            disabled={actionPending === 'rename'}
                            maxLength={128}
                            autoFocus
                            style={{
                                flex: 1, fontSize: 13, padding: '6px 8px',
                                background: '#222', color: '#ccc', border: '1px solid #555',
                                borderRadius: 4
                            }}
                            onKeyDown={e => {
                                if (e.key === 'Enter') handleSaveName();
                                if (e.key === 'Escape') setIsEditingName(false);
                            }}
                        />
                        <button
                            onClick={handleSaveName}
                            disabled={!!actionPending}
                            style={{
                                background: '#2563eb', color: '#fff', border: 'none',
                                padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
                                fontSize: 12
                            }}
                        >
                            {actionPending === 'rename' ? '...' : 'Mentés'}
                        </button>
                        <button
                            onClick={() => setIsEditingName(false)}
                            disabled={!!actionPending}
                            style={{
                                background: 'none', color: '#ccc', border: '1px solid #666',
                                padding: '6px 10px', borderRadius: 4, cursor: 'pointer',
                                fontSize: 12
                            }}
                        >
                            Mégse
                        </button>
                    </div>
                ) : (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{ fontSize: 14 }}>
                            {org?.name || '—'}
                        </span>
                        <span style={{ color: '#888', fontSize: 11 }}>
                            ({org?.slug})
                        </span>
                        {isOrgAdmin && (
                            <button
                                onClick={() => {
                                    setNameDraft(org?.name || '');
                                    setIsEditingName(true);
                                }}
                                disabled={!!actionPending}
                                style={{
                                    marginLeft: 'auto', background: 'none', border: '1px solid #666',
                                    color: '#ccc', padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
                                    fontSize: 11
                                }}
                            >
                                Szerkesztés
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* ═══ 2. Meghívó küldése (csak owner/admin) ═══ */}
            {isOrgAdmin && (
                <div style={{ marginBottom: 20, borderBottom: '1px solid #333', paddingBottom: 16 }}>
                    <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                        Felhasználó meghívása
                    </h3>

                    <form onSubmit={handleInvite} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                            type="email"
                            placeholder="E-mail cím"
                            value={inviteEmail}
                            onChange={e => setInviteEmail(e.target.value)}
                            disabled={!!actionPending}
                            required
                            style={{
                                flex: '1 1 200px', fontSize: 12, padding: '6px 8px',
                                background: '#222', color: '#ccc', border: '1px solid #555',
                                borderRadius: 4
                            }}
                        />
                        <select
                            value={inviteRole}
                            onChange={e => setInviteRole(e.target.value)}
                            disabled={!!actionPending}
                            style={{
                                fontSize: 12, padding: '6px 8px',
                                background: '#222', color: '#ccc', border: '1px solid #555',
                                borderRadius: 4
                            }}
                        >
                            <option value="member">Tag</option>
                            <option value="admin">Admin</option>
                        </select>
                        <textarea
                            placeholder="Opcionális üzenet a meghívottnak"
                            value={inviteMessage}
                            onChange={e => setInviteMessage(e.target.value)}
                            disabled={!!actionPending}
                            maxLength={500}
                            rows={2}
                            style={{
                                flex: '1 1 100%', fontSize: 12, padding: '6px 8px',
                                background: '#222', color: '#ccc', border: '1px solid #555',
                                borderRadius: 4, resize: 'vertical', fontFamily: 'inherit'
                            }}
                        />
                        <button
                            type="submit"
                            disabled={!!actionPending}
                            style={{
                                background: '#2563eb', color: '#fff', border: 'none',
                                padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
                                fontSize: 12
                            }}
                        >
                            {actionPending === 'invite' ? '...' : 'Meghívó küldése'}
                        </button>
                    </form>

                    {inviteSuccess && (
                        <div style={{ color: '#4ade80', fontSize: 12, marginTop: 6 }}>
                            {inviteSuccess}
                        </div>
                    )}
                </div>
            )}

            {/* ═══ 3. Függő meghívók (csak owner/admin — token érzékeny adat) ═══ */}
            {isOrgAdmin && pendingInvites.length > 0 && (
                <div style={{ marginBottom: 20, borderBottom: '1px solid #333', paddingBottom: 16 }}>
                    <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                        Függő meghívók
                    </h3>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {pendingInvites.map(inv => (
                            <li key={inv.$id} style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                fontSize: 13, padding: '4px 0'
                            }}>
                                <span>{inv.email}</span>
                                <span style={{
                                    fontSize: 10, color: '#888', background: '#282a30',
                                    padding: '1px 6px', borderRadius: 3
                                }}>
                                    {roleLabel(inv.role)}
                                </span>
                                <span style={{ color: '#888', fontSize: 11 }}>
                                    Lejár: {new Date(inv.expiresAt).toLocaleDateString('hu-HU')}
                                </span>
                                <button
                                    onClick={() => handleCopyLink(inv)}
                                    disabled={!!actionPending}
                                    style={{
                                        marginLeft: 'auto', background: 'none',
                                        border: '1px solid #666', color: '#ccc',
                                        padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                                        fontSize: 11
                                    }}
                                >
                                    {copiedId === inv.$id ? 'Másolva!' : 'Link másolása'}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* ═══ 4. Tagok ═══ */}
            <div style={{ marginBottom: 20, borderBottom: '1px solid #333', paddingBottom: 16 }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                    Tagok <span style={{ color: '#888', fontWeight: 400, fontSize: 12 }}>({members.length})</span>
                </h3>

                {members.length === 0 ? (
                    <p style={{ fontSize: 12, color: '#888', margin: '4px 0' }}>Nincsenek tagok.</p>
                ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {members.map(m => {
                            const resolved = userNameMap.get(m.userId);
                            const displayName = resolved?.name || resolved?.email || m.userId;
                            const displayEmail = resolved?.name && resolved?.email ? resolved.email : null;

                            return (
                                <li key={m.$id} style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    fontSize: 13, padding: '3px 0'
                                }}>
                                    <span>{displayName}</span>
                                    {displayEmail && (
                                        <span style={{ color: '#888', fontSize: 11 }}>({displayEmail})</span>
                                    )}
                                    <span style={{
                                        fontSize: 10,
                                        color: m.role === 'owner' ? '#adc6ff' : '#888',
                                        background: '#282a30',
                                        padding: '1px 6px', borderRadius: 3
                                    }}>
                                        {roleLabel(m.role)}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {/* ═══ 5. Szerkesztőségek ═══ */}
            <div style={{ marginBottom: 20, paddingBottom: 16 }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                    Szerkesztőségek <span style={{ color: '#888', fontWeight: 400, fontSize: 12 }}>({offices.length})</span>
                </h3>

                {offices.length === 0 ? (
                    <p style={{ fontSize: 12, color: '#888', margin: '4px 0' }}>Nincsenek szerkesztőségek.</p>
                ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {offices.map(office => (
                            <li key={office.$id} style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                fontSize: 13, padding: '3px 0'
                            }}>
                                <span>{office.name}</span>
                                <span style={{ color: '#888', fontSize: 11 }}>({office.slug})</span>
                                <Link
                                    to={`/admin/office/${office.$id}/workflow`}
                                    style={{
                                        marginLeft: 'auto', fontSize: 11,
                                        color: '#adc6ff', textDecoration: 'none'
                                    }}
                                >
                                    Workflow tervező →
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* ═══ Navigáció ═══ */}
            <div className="auth-bottom-link" style={{ marginTop: 16 }}>
                <Link to="/">Vissza a Dashboardra</Link>
            </div>
        </div>
    );
}
