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
import { useModal } from '../../contexts/ModalContext.jsx';
import { DASHBOARD_URL } from '../../config.js';
import { useCopyDialog } from '../CopyDialog.jsx';
import InviteModal from './InviteModal.jsx';

function errorMessage(reason, retryAfterSec) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (reason.includes('invalid_email')) return 'Érvénytelen e-mail cím formátum.';
    if (reason.includes('invalid_role')) return 'Érvénytelen szerepkör.';
    if (reason.includes('not_a_member')) return 'Nem vagy tagja ennek a szervezetnek.';
    if (reason.includes('insufficient_role')) return 'Nincs jogosultságod ehhez a művelethez.';
    if (reason.includes('insufficient_permission')) return 'Nincs jogosultságod ehhez a művelethez.';
    if (reason.includes('already_member')) return 'A felhasználó már tagja a szervezetnek.';
    if (reason.includes('already_invited')) return 'Ehhez az e-mail címhez már van függőben lévő meghívó.';
    // ADR 0010 W2/W3 — meghívási flow hibakódok
    if (reason.includes('rate_limited')) return 'Túl sok próbálkozás — próbáld meg később.';
    if (reason.includes('resend_cooldown')) {
        // D.5.4 — a `retryAfterSec` a CF response-ból érkezik (`callInviteFunction`
        // wrapped err.response). Codex review fix (MINOR): `typeof === 'number'`
        // hogy a `retryAfterSec === 0` se essen vissza generikusra (boundary case).
        return typeof retryAfterSec === 'number'
            ? `Az utolsó kiküldés óta nem telt el egy perc — várj még ${retryAfterSec} másodpercet.`
            : 'Az utolsó kiküldés óta kevesebb mint egy perc telt el — várj egy kicsit az újraküldéssel.';
    }
    if (reason.includes('invite_not_pending')) return 'Ez a meghívó már nem aktív (elfogadták vagy visszavonták).';
    if (reason.includes('invite_expired')) return 'A meghívó lejárt — generálj új meghívót.';
    if (reason.includes('email_send_failed')) return 'Az e-mail kiküldése sikertelen. Próbáld újra később.';
    if (reason.includes('invite_resend_failed')) return 'A meghívó újraküldése sikertelen. Próbáld újra később.';
    // 2026-05-07: org-role változtatáshoz tartozó hibakódok.
    if (reason.includes('cannot_change_own_role')) {
        return 'A saját szerepköröd nem módosíthatod. Egy másik tulajdonosnak kell elvégeznie.';
    }
    if (reason.includes('cannot_demote_last_owner')) {
        return 'Ez a szervezet utolsó tulajdonosa — előbb promote-olj egy másik tagot tulajdonosra.';
    }
    if (reason.includes('requires_owner_for_owner_role_change')) {
        return 'Tulajdonosi szerepkör változtatásához tulajdonosi jogosultság szükséges.';
    }
    if (reason.includes('membership_not_found')) {
        return 'A felhasználó már nem tagja ennek a szervezetnek.';
    }
    if (reason.includes('role_change_failed')) {
        return 'A szerepkör módosítása nem sikerült. Próbáld újra.';
    }
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

/** ADR 0010 W3 — meghívó kézbesítési-status badge címke + szín. */
function deliveryStatusBadge(status) {
    switch (status) {
        case 'sent':      return { label: 'Kiküldve',      color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' };
        case 'delivered': return { label: 'Kézbesítve',    color: 'var(--c-success)',      bg: 'var(--bg-elevated)' };
        case 'bounced':   return { label: 'Visszapattant', color: 'var(--c-error)',        bg: 'var(--bg-elevated)' };
        case 'failed':    return { label: 'Kézbesítési hiba', color: 'var(--c-error)',     bg: 'var(--bg-elevated)' };
        case 'pending':   return { label: 'Várakozik',     color: 'var(--text-muted)',     bg: 'var(--bg-elevated)' };
        default:          return null; // legacy invite — nincs status mező
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
 * @param {Function} [props.onMembersRefresh] — opcionális teljes loadData() trigger.
 *   A `handleRoleChange` ezt hívja a sikeres CF response után, hogy az
 *   azonos tab-ban azonnal lássuk a `role` mező változását — az `ORG_CHANNELS`
 *   `ORGANIZATION_MEMBERSHIPS` Realtime csatornája ugyan szintén reload-olna,
 *   de az 300ms debounce-on át, és a same-tab UX-hez azonnal kell.
 *   Codex review (2026-05-07): a kódbázis preferált mintája "explicit reload
 *   saját mutáció után + Realtime cross-tab szinkronra" — `GroupsRoute.jsx`
 *   precedensét követjük.
 */
export default function UsersTab({
    org,
    callerRole,
    members,
    pendingInvites,
    inviteHistory = [],
    userNameMap,
    onInviteSent,
    onMembersRefresh
}) {
    const { user, resendInviteEmail, changeOrganizationMemberRole } = useAuth();
    const { openModal } = useModal();
    const copyDialog = useCopyDialog();

    const [actionError, setActionError] = useState('');
    const [actionPending, setActionPending] = useState(null);
    const [copiedId, setCopiedId] = useState(null);
    const copyTimerRef = useRef(null);

    const isOrgAdmin = callerRole === 'owner' || callerRole === 'admin';

    useEffect(() => () => {
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    }, []);

    const grouped = useMemo(() => groupMembersByRole(members), [members]);

    /**
     * D.6.1 — duplikált megjelenítendő név detektálás. A `renderMemberRow`
     * alapesetben csak akkor mutatja az e-mail címet, ha mind a `name`,
     * mind az `email` ismert (`resolved?.name && resolved?.email`). Ez két
     * különböző user-fiók esetén (pl. „Sashalmi Imre" — két e-mail) félre-
     * vezető: mindkettőn ugyanaz a név látszik. Ezért minden olyan név,
     * ami legalább kétszer szerepel az `members` listán, kötelezően kapja
     * az e-mail badge-et (és `forceShowEmail` flag-et a self-row-ra is).
     */
    const duplicateDisplayNames = useMemo(() => {
        const counts = new Map();
        for (const m of members) {
            const resolved = userNameMap.get(m.userId);
            const isSelf = m.userId === user?.$id;
            const name = resolved?.name
                || resolved?.email
                || (isSelf ? (user?.name || user?.email || m.userId) : m.userId);
            counts.set(name, (counts.get(name) || 0) + 1);
        }
        const dupes = new Set();
        for (const [name, count] of counts) {
            if (count > 1) dupes.add(name);
        }
        return dupes;
    }, [members, userNameMap, user?.$id, user?.name, user?.email]);

    /**
     * ADR 0010 W2 — InviteModal-launcher. A meglévő inline form
     * lecserélődött egy felugró ablakra, amely multi-invite + lejárat-
     * választással + üzenettel támogatja a flow-t.
     */
    function handleOpenInviteModal() {
        openModal(
            <InviteModal organizationId={org.$id} onInviteSent={onInviteSent} />,
            { size: 'md', title: 'Új meghívó', closeOnBackdrop: false }
        );
    }

    /**
     * ADR 0010 W3 — pending invite e-mail újraküldése (admin gomb a függő
     * meghívók listán). A CF a `lastSentAt` és `lastDeliveryStatus` mezőket
     * frissíti, a Realtime cross-tab szinkron a UI-t.
     */
    async function handleResendInvite(invite) {
        setActionPending(`resend:${invite.$id}`);
        setActionError('');
        try {
            await resendInviteEmail(invite.$id);
            if (onInviteSent) await onInviteSent();
        } catch (err) {
            // D.5.4 — a `callInviteFunction` wrapped err.response-on
            // visszaadja a `retryAfterSec`-et a 429 cooldown ágon.
            const retryAfterSec = err?.response?.retryAfterSec;
            setActionError(errorMessage(err.message || err.code || '', retryAfterSec));
        } finally {
            setActionPending(null);
        }
    }

    /**
     * Org-tag role változtatása (2026-05-07). A backend hárítja a
     * privilege escalation-t (admin nem nyúl owner-hez, last-owner nem
     * demote-olható, self-edit blokkolva), itt csak az UX-szintű
     * azonnali eldobható eseteket szűrjük (pl. azonos role).
     *
     * Refresh stratégia (Codex review 2026-05-07):
     *   1. Sikeres CF response után **explicit `onMembersRefresh()`** — a
     *      same-tab UX-hez azonnal frissít, nem várjuk a 300ms Realtime
     *      debounce-ot. Ezt a kódbázis preferált mintája (GroupsRoute,
     *      AuthContext.reloadMemberships) is így használja.
     *   2. Cross-tab szinkron a `useTenantRealtimeRefresh` hook
     *      `ORGANIZATION_MEMBERSHIPS` csatornáján át, debounce-olva.
     */
    async function handleRoleChange(member, newRole) {
        if (member.role === newRole) return;
        if (member.userId === user?.$id) {
            // UX-szintű early return — a backend is 403-mal védekezne, de
            // ezt soha ne is kelljen körberöptetnünk.
            setActionError('A saját szerepköröd nem módosíthatod.');
            return;
        }

        setActionPending(`role:${member.$id}`);
        setActionError('');

        try {
            await changeOrganizationMemberRole(org.$id, member.userId, newRole);
            // Same-tab azonnali refresh — a Realtime debounce nélkül.
            if (onMembersRefresh) {
                try {
                    await onMembersRefresh();
                } catch (refreshErr) {
                    // A reload hibáját nem propagáljuk a user felé — a
                    // mutáció sikeres volt, és a Realtime fallback úgyis
                    // legkésőbb 300ms múlva frissít.
                    console.warn('[UsersTab] onMembersRefresh sikertelen:', refreshErr);
                }
            }
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
            copyDialog({
                title: 'Meghívó link',
                value: link,
                description: 'A böngésző nem engedi az automatikus másolást. Jelöld ki Ctrl+C-vel.'
            });
        }
    }

    function renderMemberRow(m) {
        const resolved = userNameMap.get(m.userId);
        const isSelf = m.userId === user?.$id;
        const displayName = resolved?.name
            || resolved?.email
            || (isSelf ? (user.name || user.email || m.userId) : m.userId);
        // D.6.1 — duplicate-name esetén kötelező e-mail; egyedi névnél
        // csak akkor, ha mindkét adat ismert (eredeti viselkedés).
        const isDuplicate = duplicateDisplayNames.has(displayName);
        const fallbackEmail = isSelf ? (user?.email || null) : null;
        const displayEmail = isDuplicate
            ? (resolved?.email || fallbackEmail || null)
            : (resolved?.name && resolved?.email ? resolved.email : null);

        // Role-dropdown 2026-05-07. Csak owner-caller láthatja, és csak
        // más tagra. Az admin-flow-t most kihagyjuk (admin csak meghívót
        // küldhet adott role-lal — a meglévő tag role-ját owner módosítja).
        // Self soha nem kap dropdown-ot — backend self-edit guard fedi le,
        // a UI-szintű visszafogás csak konzisztens UX-ért van.
        const canChangeThisMemberRole = callerRole === 'owner' && !isSelf;
        const isProcessingRole = actionPending === `role:${m.$id}`;

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
                {canChangeThisMemberRole && (
                    <select
                        value={m.role}
                        onChange={(e) => handleRoleChange(m, e.target.value)}
                        disabled={!!actionPending}
                        title="Szerepkör módosítása"
                        aria-label={`${displayName} szerepkörének módosítása`}
                        style={{
                            marginLeft: 'auto',
                            fontSize: 11, padding: '2px 6px',
                            background: 'var(--bg-base)', color: 'var(--text-primary)',
                            border: '1px solid var(--outline-variant)',
                            borderRadius: 3,
                            cursor: actionPending ? 'wait' : 'pointer'
                        }}
                    >
                        <option value="owner">Tulajdonos</option>
                        <option value="admin">Admin</option>
                        <option value="member">Tag</option>
                    </select>
                )}
                {isProcessingRole && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>…</span>
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

            {/* ═══ Felhasználó meghívása (ADR 0010 W2 — modal-launcher gomb) ═══ */}
            {isOrgAdmin && (
                <div style={{
                    marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 16,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12
                }}>
                    <div>
                        <h3 style={{ margin: '0 0 4px 0', fontSize: 14, fontWeight: 600 }}>
                            Felhasználó meghívása
                        </h3>
                        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                            E-mail meghívót küldhetsz egy vagy több címre, választható lejárattal.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={handleOpenInviteModal}
                        disabled={!!actionPending}
                        style={{
                            background: 'var(--accent-solid)', color: '#fff', border: 'none',
                            padding: '8px 16px', borderRadius: 4, cursor: actionPending ? 'wait' : 'pointer',
                            fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap'
                        }}
                    >
                        + Új meghívó
                    </button>
                </div>
            )}

            {/* ═══ Függő meghívók ═══ */}
            {isOrgAdmin && pendingInvites.length > 0 && (
                <div style={{ marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
                    <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                        Függő meghívók <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>({pendingInvites.length})</span>
                    </h3>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {pendingInvites.map(inv => {
                            const badge = deliveryStatusBadge(inv.lastDeliveryStatus);
                            const isResending = actionPending === `resend:${inv.$id}`;
                            return (
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
                                    {/* ADR 0010 W3 — kézbesítési state badge (csak ha a CF visszaadta) */}
                                    {badge && (
                                        <span
                                            title={inv.lastDeliveryError || badge.label}
                                            style={{
                                                fontSize: 10, color: badge.color, background: badge.bg,
                                                padding: '1px 6px', borderRadius: 3
                                            }}
                                        >
                                            {badge.label}
                                        </span>
                                    )}
                                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                        Lejár: {new Date(inv.expiresAt).toLocaleDateString('hu-HU')}
                                    </span>
                                    <button
                                        onClick={() => handleResendInvite(inv)}
                                        disabled={!!actionPending}
                                        title="E-mail újraküldése"
                                        style={{
                                            marginLeft: 'auto', background: 'none',
                                            border: '1px solid var(--outline-variant)', color: 'var(--text-secondary)',
                                            padding: '2px 8px', borderRadius: 4,
                                            cursor: actionPending ? 'wait' : 'pointer',
                                            fontSize: 11
                                        }}
                                    >
                                        {isResending ? 'Küldés…' : 'Újraküldés'}
                                    </button>
                                    <button
                                        onClick={() => handleCopyLink(inv)}
                                        disabled={!!actionPending}
                                        style={{
                                            background: 'none',
                                            border: '1px solid var(--outline-variant)', color: 'var(--text-secondary)',
                                            padding: '2px 8px', borderRadius: 4,
                                            cursor: actionPending ? 'wait' : 'pointer',
                                            fontSize: 11
                                        }}
                                    >
                                        {copiedId === inv.$id ? 'Másolva!' : 'Link másolása'}
                                    </button>
                                </li>
                            );
                        })}
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

            {/* ═══ Meghívási történet (E blokk, Q1 ACL) ═══ */}
            {/*
                Csak admin/owner látja (Pattern A — Codex pre-review): a
                `organizationInviteHistory` ACL `team:org_${orgId}_admins`-ra
                szűkül (E.3 ACL switch), így a member user 403-at kapna a
                listáznál (a `OrganizationSettingsModal.loadData` catch-eli
                üres tömbre). A render-gate `isOrgAdmin` ENNÉL kezdődik el —
                a member elől a teljes szekciót elrejtjük (privacy intent:
                ne legyen affordance a feature-re).
            */}
            {isOrgAdmin && inviteHistory.length > 0 && (
                <div style={{ marginBottom: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                    <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                        Meghívási történet <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>({inviteHistory.length})</span>
                    </h3>
                    <p style={{ margin: '0 0 8px 0', fontSize: 12, color: 'var(--text-muted)' }}>
                        Korábbi meghívók sorsa (elfogadva / elutasítva / lejárva).
                    </p>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {inviteHistory.map(h => {
                            const finalLabel = (() => {
                                switch (h.finalStatus) {
                                    case 'accepted': return { text: 'Elfogadva', color: 'var(--c-success)' };
                                    case 'declined': return { text: 'Elutasítva', color: 'var(--text-muted)' };
                                    case 'expired':  return { text: 'Lejárt',     color: 'var(--text-muted)' };
                                    default:         return { text: h.finalStatus || '?', color: 'var(--text-muted)' };
                                }
                            })();
                            const finalAt = h.finalAt
                                ? new Date(h.finalAt).toLocaleDateString('hu-HU')
                                : '?';
                            return (
                                <li key={h.$id} style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    fontSize: 13, padding: '4px 0',
                                    borderBottom: '1px solid var(--bg-elevated)'
                                }}>
                                    <span>{h.email}</span>
                                    <span style={{
                                        fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-elevated)',
                                        padding: '1px 6px', borderRadius: 3
                                    }}>
                                        {roleLabel(h.role)}
                                    </span>
                                    <span style={{
                                        fontSize: 10, color: finalLabel.color, background: 'var(--bg-elevated)',
                                        padding: '1px 6px', borderRadius: 3
                                    }}>
                                        {finalLabel.text}
                                    </span>
                                    <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
                                        {finalAt}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </>
    );
}
