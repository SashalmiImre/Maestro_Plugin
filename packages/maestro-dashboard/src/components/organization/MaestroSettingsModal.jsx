/**
 * Maestro Dashboard — MaestroSettingsModal (#41)
 *
 * Az UserAvatar dropdown „Maestro beállítások" menüpontjából nyíló modal.
 * Két szekcióból áll:
 *
 *   1. „Szervezeteim" — a user által tagolt szervezetek listája. Minden sornál:
 *      - Org neve, szerepkör (Tulajdonos / Admin / Tag).
 *      - Aktív scope jelzés (jelenleg betöltve).
 *      - „Kilépés" gomb. Last-owner blokk: ha a user az utolsó owner és van
 *        más tag, a CF `last_owner_block` hibát ad → toast magyarázattal.
 *        Ha egyedüli tag, `last_member_block` → CTA a delete_organization-höz.
 *
 *   2. „Függő meghívók" — a user e-mail címére kiállított pending invite-ok.
 *      A CF `list_my_invites` action-je szolgáltatja API key-jel (a kliensnek
 *      nincs read joga az invite-okra, amíg nincs benne az org team-ben).
 *      Sorok: org név, meghívó user név, role badge, lejárat. Akciók:
 *      „Elfogadom" (acceptInvite) / „Elutasítom" (declineInvite).
 *
 * Sikeres flow után minden esetben `reloadMemberships()` + helyi invite
 * lista refresh, hogy az új scope azonnal kattintható legyen a breadcrumb-ban.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';

function roleLabel(role) {
    switch (role) {
        case 'owner': return 'Tulajdonos';
        case 'admin': return 'Admin';
        case 'member': return 'Tag';
        default: return role || '—';
    }
}

function roleAccent(role) {
    switch (role) {
        case 'owner': return 'var(--accent)';
        case 'admin': return 'var(--text-secondary)';
        default: return 'var(--text-muted)';
    }
}

function formatExpiry(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = Date.now();
    const diffMs = d.getTime() - now;
    if (diffMs <= 0) return 'lejárt';
    const days = Math.ceil(diffMs / 86400000);
    if (days === 1) return 'holnap lejár';
    if (days <= 7) return `${days} nap múlva lejár`;
    return d.toLocaleDateString('hu-HU');
}

function inviteErrorMessage(reason) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('invite_not_found')) return 'A meghívó nem található vagy már nem érvényes.';
    if (reason.includes('invite_not_pending')) return 'A meghívó már nem aktív.';
    if (reason.includes('invite_expired')) return 'A meghívó lejárt.';
    if (reason.includes('email_mismatch')) return 'Ezt a meghívót másik e-mail címre küldték.';
    if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) {
        return 'Hálózati hiba. Próbáld újra.';
    }
    return reason;
}

function leaveErrorMessage(reason) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('not_a_member')) return 'Már nem vagy tagja ennek a szervezetnek.';
    if (reason.includes('last_owner_block')) {
        return 'Te vagy az utolsó tulajdonos. Előbb adj át tulajdonost egy másik tagnak.';
    }
    if (reason.includes('last_member_block')) {
        return 'Te vagy az egyetlen tag. Inkább töröld a szervezetet.';
    }
    if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) {
        return 'Hálózati hiba. Próbáld újra.';
    }
    return reason;
}

export default function MaestroSettingsModal() {
    const {
        user,
        organizations,
        orgMemberships,
        listMyInvites,
        acceptInvite,
        declineInvite,
        leaveOrganization,
        reloadMemberships
    } = useAuth();
    const { activeOrganizationId } = useScope();
    const { closeModal } = useModal();
    const { showToast } = useToast();
    const confirm = useConfirm();

    const [invites, setInvites] = useState([]);
    const [invitesLoading, setInvitesLoading] = useState(true);
    const [invitesError, setInvitesError] = useState('');
    const [pendingAction, setPendingAction] = useState(null); // { kind: 'leave'|'accept'|'decline', id }

    // ── Szervezet → role index ───────────────────────────────────────────
    const roleByOrgId = useMemo(() => {
        const map = new Map();
        for (const m of orgMemberships || []) {
            if (m.userId === user?.$id) map.set(m.organizationId, m.role);
        }
        return map;
    }, [orgMemberships, user?.$id]);

    // ── Stabil ABC sorrend a szervezeteken ────────────────────────────────
    const sortedOrgs = useMemo(
        () => [...(organizations || [])].sort((a, b) =>
            (a.name || '').localeCompare(b.name || '', 'hu')
        ),
        [organizations]
    );

    // ── Pending invite-ok lekérése ────────────────────────────────────────
    const loadInvites = useCallback(async () => {
        setInvitesLoading(true);
        setInvitesError('');
        try {
            const list = await listMyInvites();
            setInvites(list);
        } catch (err) {
            setInvitesError(inviteErrorMessage(err?.code || err?.message || ''));
        } finally {
            setInvitesLoading(false);
        }
    }, [listMyInvites]);

    useEffect(() => {
        loadInvites();
    }, [loadInvites]);

    // ── Akciók ─────────────────────────────────────────────────────────────
    async function handleAccept(invite) {
        if (pendingAction) return;
        setPendingAction({ kind: 'accept', id: invite.$id });
        try {
            await acceptInvite(invite.token);
            showToast(`Csatlakoztál a(z) „${invite.organizationName || 'szervezet'}" szervezethez.`, 'success');
            // memberships már frissítve az acceptInvite-ban, csak az invite listát
            // takarítjuk
            setInvites(prev => prev.filter(i => i.$id !== invite.$id));
        } catch (err) {
            showToast(inviteErrorMessage(err?.code || err?.message || ''), 'error');
        } finally {
            setPendingAction(null);
        }
    }

    async function handleDecline(invite) {
        if (pendingAction) return;
        const ok = await confirm({
            title: 'Meghívó elutasítása',
            message: invite.organizationName
                ? `Biztosan elutasítod a „${invite.organizationName}" meghívóját? Ezt később nem tudod visszavonni.`
                : 'Biztosan elutasítod ezt a meghívót? Ezt később nem tudod visszavonni.',
            confirmLabel: 'Elutasítás',
            variant: 'danger'
        });
        if (!ok) return;

        setPendingAction({ kind: 'decline', id: invite.$id });
        try {
            await declineInvite(invite.token);
            setInvites(prev => prev.filter(i => i.$id !== invite.$id));
            showToast('A meghívó elutasítva.', 'info');
        } catch (err) {
            showToast(inviteErrorMessage(err?.code || err?.message || ''), 'error');
        } finally {
            setPendingAction(null);
        }
    }

    async function handleLeave(org) {
        if (pendingAction) return;
        const role = roleByOrgId.get(org.$id);
        const isActive = org.$id === activeOrganizationId;

        const messageLines = [
            `Biztosan kilépsz a(z) „${org.name}" szervezetből? `,
            'A szervezet adatai megmaradnak, de te elveszíted a hozzáférést — ',
            'csak új meghívással tudsz visszacsatlakozni.'
        ];
        if (isActive) {
            messageLines.push('\n\nMivel ez a jelenleg aktív szervezeted, a kilépés után átkerülsz egy másikra (vagy az onboarding képernyőre).');
        }

        const ok = await confirm({
            title: 'Kilépés a szervezetből',
            message: messageLines.join(''),
            verificationExpected: org.name,
            confirmLabel: 'Kilépés',
            variant: 'danger'
        });
        if (!ok) return;

        setPendingAction({ kind: 'leave', id: org.$id });
        try {
            await leaveOrganization(org.$id);
            showToast(`Kiléptél a(z) „${org.name}" szervezetből.`, 'success');
            // A reloadMemberships a ScopeContext auto-pick effektjét triggereli,
            // ami az aktív org-ot átállítja egy másikra (vagy /onboarding-ra).
            // A Modal scope-auto-close effekt erre a változásra a teljes
            // stack-et bezárja, így a setPendingAction(null) finally-ben
            // unmount warning-ot adhat — nincs dolgunk vele, defensive guard
            // amúgy sem kell, mert a ConfirmDialog már csukva.
            try {
                await reloadMemberships();
            } catch (refreshErr) {
                console.warn('[MaestroSettingsModal] reloadMemberships hiba a leave után:', refreshErr?.message);
            }
            // Ha nem az aktív org-ból léptünk ki, a modal nyitva marad —
            // azonnal frissítjük az invite listát, hátha visszacsatlakozási
            // flow-t kínálnánk (az org adminja küldhet új invitet).
            if (!isActive) {
                loadInvites();
            }
        } catch (err) {
            const code = err?.code || err?.message || '';
            // last_member_block esetén opcionálisan közvetlen útvonalat
            // ajánlhatnánk (delete_organization), de a deletion magasabb
            // blast radius-szel jár — explicit user akció kell, nem
            // automatikus felugró. A toast üzenete megmondja a teendőt.
            showToast(leaveErrorMessage(code), 'error');
        } finally {
            setPendingAction(null);
        }
    }

    // ── Render ─────────────────────────────────────────────────────────────
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>

            {/* ═══════════════ Szervezetek ═══════════════ */}
            <section>
                <h3 style={{
                    margin: '0 0 8px 0', fontSize: 14, fontWeight: 600,
                    color: 'var(--text-primary)'
                }}>
                    Szervezeteim <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
                        ({sortedOrgs.length})
                    </span>
                </h3>

                {sortedOrgs.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0' }}>
                        Még nem vagy tagja egyetlen szervezetnek sem.
                    </p>
                ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {sortedOrgs.map(org => {
                            const role = roleByOrgId.get(org.$id);
                            const isActive = org.$id === activeOrganizationId;
                            const isLeaving = pendingAction?.kind === 'leave' && pendingAction.id === org.$id;
                            return (
                                <li
                                    key={org.$id}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 10,
                                        padding: '10px 12px', borderRadius: 6,
                                        border: '1px solid var(--outline-variant)',
                                        background: isActive ? 'var(--bg-elevated)' : 'transparent',
                                        marginBottom: 6
                                    }}
                                >
                                    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span style={{
                                            fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
                                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                                        }}>
                                            {org.name}
                                        </span>
                                        {isActive && (
                                            <span style={{
                                                fontSize: 10, color: 'var(--accent)', background: 'var(--bg-base)',
                                                border: '1px solid var(--accent)',
                                                padding: '1px 6px', borderRadius: 3,
                                                whiteSpace: 'nowrap'
                                            }}>
                                                Aktív
                                            </span>
                                        )}
                                        <span style={{
                                            fontSize: 10, color: roleAccent(role),
                                            background: 'var(--bg-elevated)',
                                            padding: '1px 6px', borderRadius: 3,
                                            whiteSpace: 'nowrap'
                                        }}>
                                            {roleLabel(role)}
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => handleLeave(org)}
                                        disabled={!!pendingAction}
                                        className="danger-action"
                                        style={{
                                            background: 'none',
                                            border: '1px solid var(--outline-variant)',
                                            color: 'var(--c-error, #b3261e)',
                                            padding: '4px 12px', borderRadius: 4, cursor: 'pointer',
                                            fontSize: 12,
                                            opacity: pendingAction && !isLeaving ? 0.5 : 1
                                        }}
                                    >
                                        {isLeaving ? 'Kilépés…' : 'Kilépés'}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            {/* ═══════════════ Függő meghívók ═══════════════ */}
            <section>
                <h3 style={{
                    margin: '0 0 8px 0', fontSize: 14, fontWeight: 600,
                    color: 'var(--text-primary)'
                }}>
                    Függő meghívóim <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
                        ({invitesLoading ? '…' : invites.length})
                    </span>
                </h3>

                {invitesLoading && (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>
                        Meghívók betöltése…
                    </p>
                )}

                {!invitesLoading && invitesError && (
                    <div className="login-error" style={{ marginBottom: 8 }}>
                        {invitesError}
                        <button
                            type="button"
                            onClick={loadInvites}
                            style={{
                                marginLeft: 8, background: 'none', border: '1px solid var(--outline-variant)',
                                padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
                                color: 'var(--text-secondary)', fontSize: 11
                            }}
                        >
                            Újra
                        </button>
                    </div>
                )}

                {!invitesLoading && !invitesError && invites.length === 0 && (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>
                        Nincs függő meghívód.
                    </p>
                )}

                {!invitesLoading && invites.length > 0 && (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {invites.map(inv => {
                            const isAccepting = pendingAction?.kind === 'accept' && pendingAction.id === inv.$id;
                            const isDeclining = pendingAction?.kind === 'decline' && pendingAction.id === inv.$id;
                            return (
                                <li
                                    key={inv.$id}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 10,
                                        padding: '10px 12px', borderRadius: 6,
                                        border: '1px solid var(--outline-variant)',
                                        marginBottom: 6
                                    }}
                                >
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            fontSize: 13, fontWeight: 500, color: 'var(--text-primary)'
                                        }}>
                                            <span style={{
                                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                                            }}>
                                                {inv.organizationName || 'Ismeretlen szervezet'}
                                            </span>
                                            <span style={{
                                                fontSize: 10, color: roleAccent(inv.role),
                                                background: 'var(--bg-elevated)',
                                                padding: '1px 6px', borderRadius: 3,
                                                whiteSpace: 'nowrap'
                                            }}>
                                                {roleLabel(inv.role)}
                                            </span>
                                        </div>
                                        <div style={{
                                            fontSize: 11, color: 'var(--text-muted)', marginTop: 2,
                                            display: 'flex', gap: 8, flexWrap: 'wrap'
                                        }}>
                                            {inv.invitedByName && (
                                                <span>Meghívó: {inv.invitedByName}</span>
                                            )}
                                            <span>{formatExpiry(inv.expiresAt)}</span>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => handleDecline(inv)}
                                        disabled={!!pendingAction}
                                        style={{
                                            background: 'none',
                                            border: '1px solid var(--outline-variant)',
                                            color: 'var(--text-secondary)',
                                            padding: '4px 12px', borderRadius: 4, cursor: 'pointer',
                                            fontSize: 12,
                                            opacity: pendingAction && !isDeclining ? 0.5 : 1
                                        }}
                                    >
                                        {isDeclining ? 'Elutasítás…' : 'Elutasítás'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleAccept(inv)}
                                        disabled={!!pendingAction}
                                        style={{
                                            background: 'var(--accent-solid)',
                                            color: '#fff',
                                            border: 'none',
                                            padding: '4px 14px', borderRadius: 4, cursor: 'pointer',
                                            fontSize: 12,
                                            opacity: pendingAction && !isAccepting ? 0.5 : 1
                                        }}
                                    >
                                        {isAccepting ? 'Elfogadás…' : 'Elfogadom'}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <div className="modal-actions">
                <button
                    type="button"
                    className="btn-secondary"
                    onClick={closeModal}
                    disabled={!!pendingAction}
                >
                    Bezárás
                </button>
            </div>
        </div>
    );
}
