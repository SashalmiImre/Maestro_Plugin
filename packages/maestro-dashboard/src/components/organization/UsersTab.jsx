/**
 * Maestro Dashboard — OrganizationSettings / UsersTab
 *
 * A szervezet beállítás modal „Felhasználók" füle:
 *   - Felhasználó meghívása (email + role + opcionális üzenet) — admin/owner
 *   - Függő meghívók listája link-másolással — admin/owner
 *   - Tagok listája csoportosítva: Tulajdonosok / Adminok / Tagok
 *
 * A member névfeloldás az aktív szerkesztőségen kívüli tagokra nem mindig
 * működik (a `groupMemberships` scope editorial office-ra van szűrve) —
 * ilyenkor a user ID-re esik vissza a megjelenítés.
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { DASHBOARD_URL } from '../../config.js';

function errorMessage(reason) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (reason.includes('invalid_email')) return 'Érvénytelen e-mail cím formátum.';
    if (reason.includes('invalid_role')) return 'Érvénytelen szerepkör.';
    if (reason.includes('not_a_member')) return 'Nem vagy tagja ennek a szervezetnek.';
    if (reason.includes('insufficient_role')) return 'Nincs jogosultságod ehhez a művelethez.';
    if (reason.includes('already_member')) return 'A felhasználó már tagja a szervezetnek.';
    if (reason.includes('already_invited')) return 'Ehhez az e-mail címhez már van függőben lévő meghívó.';
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

/** Member csoportosítás — stabil sorrend: owner → admin → member. */
function groupMembersByRole(members) {
    const buckets = { owner: [], admin: [], member: [] };
    for (const m of members) {
        (buckets[m.role] || (buckets[m.role] = [])).push(m);
    }
    return buckets;
}

/**
 * @param {Object} props
 * @param {Object} props.org — a szervezet rekord
 * @param {'owner'|'admin'|'member'|null} props.callerRole
 * @param {Array} props.members — organizationMemberships rekordok (a szervezetre)
 * @param {Array} props.pendingInvites — pending invite rekordok
 * @param {Map} props.userNameMap — userId → { name, email } (groupMemberships-ből)
 * @param {Function} props.onInviteSent — callback a pending invite lista újratöltésére
 */
export default function UsersTab({
    org,
    callerRole,
    members,
    pendingInvites,
    userNameMap,
    onInviteSent
}) {
    const { user, createInvite } = useAuth();

    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRole, setInviteRole] = useState('member');
    const [inviteMessage, setInviteMessage] = useState('');
    const [inviteSuccess, setInviteSuccess] = useState('');
    const [actionError, setActionError] = useState('');
    const [actionPending, setActionPending] = useState(null);
    const [copiedId, setCopiedId] = useState(null);
    const copyTimerRef = useRef(null);

    const isOrgAdmin = callerRole === 'owner' || callerRole === 'admin';

    useEffect(() => () => {
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    }, []);

    const grouped = useMemo(() => groupMembersByRole(members), [members]);

    async function handleInvite(e) {
        e.preventDefault();
        const trimmedEmail = inviteEmail.trim().toLowerCase();
        if (!trimmedEmail) return;

        setActionPending('invite');
        setActionError('');
        setInviteSuccess('');

        try {
            const result = await createInvite(
                org.$id,
                trimmedEmail,
                inviteRole,
                inviteMessage.trim() || undefined
            );
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
            if (onInviteSent) await onInviteSent();
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

    function renderMemberRow(m) {
        const resolved = userNameMap.get(m.userId);
        const isSelf = m.userId === user?.$id;
        const displayName = resolved?.name
            || resolved?.email
            || (isSelf ? (user.name || user.email || m.userId) : m.userId);
        const displayEmail = resolved?.name && resolved?.email ? resolved.email : null;

        return (
            <li key={m.$id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 13, padding: '3px 0'
            }}>
                <span>{displayName}</span>
                {displayEmail && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({displayEmail})</span>
                )}
                {isSelf && (
                    <span style={{
                        fontSize: 10, color: 'var(--text-muted)',
                        background: 'var(--bg-elevated)', padding: '1px 6px', borderRadius: 3
                    }}>
                        te
                    </span>
                )}
            </li>
        );
    }

    function renderMemberGroup(label, list, color) {
        if (list.length === 0) return null;
        return (
            <div style={{ marginBottom: 12 }}>
                <h4 style={{
                    margin: '0 0 4px 0',
                    fontSize: 11, fontWeight: 600,
                    color,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px'
                }}>
                    {label} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({list.length})</span>
                </h4>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {list.map(renderMemberRow)}
                </ul>
            </div>
        );
    }

    return (
        <>
            {actionError && (
                <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>
            )}

            {/* ═══ Felhasználó meghívása ═══ */}
            {isOrgAdmin && (
                <div style={{ marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
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
                                background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--outline-variant)',
                                borderRadius: 4
                            }}
                        />
                        <select
                            value={inviteRole}
                            onChange={e => setInviteRole(e.target.value)}
                            disabled={!!actionPending}
                            style={{
                                fontSize: 12, padding: '6px 8px',
                                background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--outline-variant)',
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
                                background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--outline-variant)',
                                borderRadius: 4, resize: 'vertical', fontFamily: 'inherit'
                            }}
                        />
                        <button
                            type="submit"
                            disabled={!!actionPending}
                            style={{
                                background: 'var(--accent-solid)', color: '#fff', border: 'none',
                                padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
                                fontSize: 12
                            }}
                        >
                            {actionPending === 'invite' ? '...' : 'Meghívó küldése'}
                        </button>
                    </form>

                    {inviteSuccess && (
                        <div style={{ color: 'var(--c-success)', fontSize: 12, marginTop: 6 }}>
                            {inviteSuccess}
                        </div>
                    )}
                </div>
            )}

            {/* ═══ Függő meghívók ═══ */}
            {isOrgAdmin && pendingInvites.length > 0 && (
                <div style={{ marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
                    <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                        Függő meghívók <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>({pendingInvites.length})</span>
                    </h3>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {pendingInvites.map(inv => (
                            <li key={inv.$id} style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                fontSize: 13, padding: '4px 0'
                            }}>
                                <span>{inv.email}</span>
                                <span style={{
                                    fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-elevated)',
                                    padding: '1px 6px', borderRadius: 3
                                }}>
                                    {roleLabel(inv.role)}
                                </span>
                                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                    Lejár: {new Date(inv.expiresAt).toLocaleDateString('hu-HU')}
                                </span>
                                <button
                                    onClick={() => handleCopyLink(inv)}
                                    disabled={!!actionPending}
                                    style={{
                                        marginLeft: 'auto', background: 'none',
                                        border: '1px solid var(--outline-variant)', color: 'var(--text-secondary)',
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

            {/* ═══ Tagok szerepkörönként ═══ */}
            <div style={{ marginBottom: 20 }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>
                    Tagok <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>({members.length})</span>
                </h3>

                {members.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>
                        Nincsenek tagok.
                    </p>
                ) : (
                    <>
                        {renderMemberGroup('Tulajdonosok', grouped.owner, 'var(--accent)')}
                        {renderMemberGroup('Adminok', grouped.admin, 'var(--text-secondary)')}
                        {renderMemberGroup('Tagok', grouped.member, 'var(--text-muted)')}
                    </>
                )}
            </div>
        </>
    );
}
