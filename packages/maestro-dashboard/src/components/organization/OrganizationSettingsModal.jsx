/**
 * Maestro Dashboard — OrganizationSettingsModal
 *
 * Az aktív szervezet kezelő modal (Fázis 8-ban lett modal-ra portolva
 * a régi `OrganizationAdminRoute`-ból). A BreadcrumbDropdown szervezet-
 * dropdownjának „Beállítások" menüpontja nyitja meg.
 *
 * Tartalom:
 *   - Szervezet neve (admin inline szerkesztés)
 *   - Felhasználó meghívása (email + role)
 *   - Függő meghívók listája (link másolás)
 *   - Tagok listája (névfeloldás groupMemberships-ből)
 *   - Szerkesztőségek listája (workflow tervező link)
 *   - Veszélyes zóna — szervezet kaszkád törlés (csak `owner`)
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Databases, Functions, Query } from 'appwrite';
import { getClient, useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import DangerZone from '../DangerZone.jsx';
import { DATABASE_ID, COLLECTIONS, FUNCTIONS, DASHBOARD_URL } from '../../config.js';

/**
 * CF hívás helper — a régi route-ból örökölt forma (a CF response-ját
 * ellenőrzi és a `reason` alapján dob).
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

function errorMessage(reason) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (reason.includes('invalid_name')) return 'A név nem lehet üres és nem haladhatja meg a 128 karaktert.';
    if (reason.includes('invalid_email')) return 'Érvénytelen e-mail cím formátum.';
    if (reason.includes('invalid_role')) return 'Érvénytelen szerepkör.';
    if (reason.includes('not_a_member')) return 'Nem vagy tagja ennek a szervezetnek.';
    if (reason.includes('insufficient_role')) return 'Nincs jogosultságod ehhez a művelethez.';
    if (reason.includes('update_failed')) return 'A szervezet frissítése sikertelen. Próbáld újra.';
    if (reason.includes('delete_failed')) return 'A szervezet törlése sikertelen. Próbáld újra.';
    if (reason.includes('organization_not_found')) return 'A szervezet nem található.';
    if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) {
        return 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';
    }
    return reason;
}

function roleLabel(role) {
    switch (role) {
        case 'owner': return 'Tulajdonos';
        case 'admin': return 'Admin';
        case 'member': return 'Tag';
        default: return role;
    }
}

/**
 * @param {Object} props
 * @param {string} props.organizationId — a kezelendő szervezet $id-ja
 */
export default function OrganizationSettingsModal({ organizationId }) {
    const { user, organizations, createInvite, reloadMemberships, deleteOrganization } = useAuth();
    const { closeModal } = useModal();
    const { showToast } = useToast();
    const confirm = useConfirm();
    const navigate = useNavigate();

    // Org dokumentum az AuthContext memberships-ből (Realtime-ready)
    const org = organizations?.find(o => o.$id === organizationId) || null;

    // --- Adat state-ek ---
    const [members, setMembers] = useState([]);
    const [pendingInvites, setPendingInvites] = useState([]);
    const [offices, setOffices] = useState([]);
    const [userNameMap, setUserNameMap] = useState(new Map());
    const [callerRole, setCallerRole] = useState(null);
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

    // --- Clipboard visszajelzés ---
    const [copiedId, setCopiedId] = useState(null);
    const copyTimerRef = useRef(null);

    // Appwrite kliens-példányokat memoizáljuk — egyszer jönnek létre a modal
    // élettartama alatt, nem minden render-kor (különben a loadData /
    // reloadInvites useCallback-jei felesleges dep-pel csak „véletlenül"
    // működnének).
    const client = getClient();
    const databases = useMemo(() => new Databases(client), [client]);
    const functions = useMemo(() => new Functions(client), [client]);

    const isOrgAdmin = callerRole === 'owner' || callerRole === 'admin';
    const isOrgOwner = callerRole === 'owner';

    // --- Adatok betöltése ---

    const loadData = useCallback(async () => {
        if (!organizationId) {
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        setMembers([]);
        setPendingInvites([]);
        setOffices([]);
        setUserNameMap(new Map());
        setCallerRole(null);

        try {
            const [membersResult, invitesResult, officesResult, groupMembersResult] = await Promise.all([
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.ORGANIZATION_MEMBERSHIPS,
                    queries: [
                        Query.equal('organizationId', organizationId),
                        Query.limit(200)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.ORGANIZATION_INVITES,
                    queries: [
                        Query.equal('organizationId', organizationId),
                        Query.equal('status', 'pending'),
                        Query.limit(100)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.EDITORIAL_OFFICES,
                    queries: [
                        Query.equal('organizationId', organizationId),
                        Query.limit(100)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
                    queries: [
                        Query.equal('organizationId', organizationId),
                        Query.limit(500)
                    ]
                })
            ]);

            setMembers(membersResult.documents);
            setPendingInvites(invitesResult.documents);
            setOffices(officesResult.documents);

            // Caller role — owner vs admin vs member megkülönböztetéshez
            const myMembership = membersResult.documents.find(m => m.userId === user?.$id);
            setCallerRole(myMembership?.role || null);

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
            console.error('[OrganizationSettingsModal] Adatok betöltése sikertelen:', err);
            setActionError('Hiba az adatok betöltésekor.');
        } finally {
            setIsLoading(false);
        }
    }, [organizationId, user?.$id, databases]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    /** Csak a pending invite listát frissítjük. */
    const reloadInvites = useCallback(async () => {
        if (!organizationId) return;
        try {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.ORGANIZATION_INVITES,
                queries: [
                    Query.equal('organizationId', organizationId),
                    Query.equal('status', 'pending'),
                    Query.limit(100)
                ]
            });
            setPendingInvites(result.documents);
        } catch { loadData(); }
    }, [organizationId, databases, loadData]);

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
                organizationId,
                name: trimmed
            });
            setIsEditingName(false);
            try { await reloadMemberships(); } catch { /* membershipsError kezeli */ }
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
            const result = await createInvite(organizationId, trimmedEmail, inviteRole, inviteMessage.trim() || undefined);
            const link = `${DASHBOARD_URL}/invite?token=${result.token}`;

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

    async function handleCopyLink(invite) {
        const link = `${DASHBOARD_URL}/invite?token=${invite.token}`;
        try {
            await navigator.clipboard.writeText(link);
            setCopiedId(invite.$id);
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
            copyTimerRef.current = setTimeout(() => setCopiedId(null), 2000);
        } catch {
            window.prompt('Másold ki a meghívó linket:', link);
        }
    }

    // --- Workflow designer link — modal bezárása utáni navigáció ---
    function handleOpenWorkflowDesigner(officeId) {
        closeModal();
        navigate(`/admin/office/${officeId}/workflow`);
    }

    // --- Szervezet törlés (kaszkád) ---

    async function handleDeleteOrganization() {
        if (!org) return;

        const confirmMessage = (
            <>
                <p>
                    A szervezet <strong>véglegesen törlődik</strong> az összes szerkesztőséggel,
                    kiadvánnyal, cikkel, layouttal, határidővel, csoporttal, csoporttagsággal
                    és meghívóval együtt.
                </p>
                <p><strong>Ez a művelet nem visszavonható.</strong></p>
            </>
        );

        const ok = await confirm({
            title: 'Szervezet törlése',
            message: confirmMessage,
            verificationExpected: org.name,
            confirmLabel: 'Végleges törlés',
            cancelLabel: 'Mégse',
            variant: 'danger'
        });
        if (!ok) return;

        setActionPending('delete');
        setActionError('');
        try {
            await deleteOrganization(organizationId);
            closeModal();
            showToast(`A(z) „${org.name}" szervezet törölve lett.`, 'success');
            try { await reloadMemberships(); } catch { /* ScopeContext auto-pick kezeli */ }
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
            setActionPending(null);
        }
    }

    // --- Render ---

    if (!organizationId || !org) {
        return (
            <div className="publication-form">
                <div className="form-empty-state">
                    A szervezet nem található vagy törölve lett.
                </div>
                <div className="modal-actions">
                    <button type="button" className="btn-secondary" onClick={closeModal}>
                        Bezárás
                    </button>
                </div>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="publication-form">
                <div className="form-empty-state">Betöltés…</div>
            </div>
        );
    }

    return (
        <div className="publication-settings-modal">
            <div className="publication-tab-content">
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
                            <span style={{ fontSize: 14 }}>{org?.name || '—'}</span>
                            <span style={{ color: '#888', fontSize: 11 }}>({org?.slug})</span>
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

                {/* ═══ 2. Meghívó küldése ═══ */}
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

                {/* ═══ 3. Függő meghívók ═══ */}
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
                                const isSelf = m.userId === user?.$id;
                                const displayName = resolved?.name || resolved?.email || (isSelf ? (user.name || user.email || m.userId) : m.userId);
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
                <div style={{ marginBottom: 20, borderBottom: isOrgOwner ? '1px solid #333' : 'none', paddingBottom: 16 }}>
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
                                    <button
                                        type="button"
                                        onClick={() => handleOpenWorkflowDesigner(office.$id)}
                                        style={{
                                            marginLeft: 'auto', fontSize: 11,
                                            color: '#adc6ff', textDecoration: 'none',
                                            background: 'none', border: 'none', cursor: 'pointer',
                                            padding: 0
                                        }}
                                    >
                                        Workflow tervező →
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {isOrgOwner && (
                    <DangerZone
                        description="A szervezet véglegesen törlődik az összes szerkesztőséggel, kiadvánnyal, cikkel, layouttal, határidővel, csoporttagsággal és meghívóval együtt. Ez a művelet nem visszavonható."
                        buttonLabel="Szervezet törlése"
                        isPending={!!actionPending}
                        onDelete={handleDeleteOrganization}
                    />
                )}
            </div>
        </div>
    );
}
