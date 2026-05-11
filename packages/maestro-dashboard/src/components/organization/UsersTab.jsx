/**
 * Maestro Dashboard — OrganizationSettings / UsersTab
 *
 * A szervezet beállítás modal „Felhasználók" füle:
 *   - Toolbar: kereső + szerepkör-szűrő + „+ Meghívás" CTA + függőben badge
 *   - Függő meghívók collapsible (admin/owner)
 *   - Tagok role szerint csoportosítva (Tulajdonos / Admin / Tag) — color-marker
 *   - Meghívási történet (admin/owner, opcionális)
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
import { useConfirm } from '../ConfirmDialog.jsx';
import InviteModal from './InviteModal.jsx';

function errorMessage(reason, retryAfterSec) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (reason.includes('invalid_email')) return 'Érvénytelen e-mail cím formátum.';
    if (reason.includes('invalid_role')) return 'Érvénytelen szerepkör.';
    if (reason.includes('not_a_member')) return 'Nem vagy tagja ennek a szervezetnek.';
    if (reason.includes('insufficient_role')) return 'Nincs jogosultságod ehhez a művelethez.';
    if (reason.includes('insufficient_permission')) return 'Nincs jogosultságod ehhez a művelethez.';
    // ADR 0012 — admin-kick hibakódok
    if (reason.includes('cannot_remove_self')) return 'Saját magadat nem tudod eltávolítani innen — használd a "Fiókom" / "Szervezet elhagyása" funkciót.';
    if (reason.includes('requires_owner_for_owner_removal')) return 'Tulajdonos eltávolításához tulajdonosi jogosultság szükséges.';
    if (reason.includes('cannot_remove_last_owner')) return 'Ez a szervezet utolsó tulajdonosa — előbb adj át tulajdonjogot egy másik tagnak.';
    if (reason.includes('membership_not_found')) return 'A felhasználó már nem tagja ennek a szervezetnek.';
    if (reason.includes('team_cleanup_failed')) return 'Hozzáférési listák tisztítása sikertelen — próbáld újra.';
    if (reason.includes('office_memberships_failed')) return 'Szerkesztőségi tagságok tisztítása sikertelen — próbáld újra.';
    if (reason.includes('group_memberships_failed')) return 'Csoporttagságok tisztítása sikertelen — próbáld újra.';
    if (reason.includes('member_removal_failed')) return 'A tag eltávolítása nem sikerült. Próbáld újra.';
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

/**
 * Avatar-monogram a megjelenítendő név első karakteréből (Unicode-safe,
 * uppercase). Üres / hiányzó név esetén `?`.
 */
function avatarInitials(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return '?';
    return trimmed.charAt(0).toUpperCase();
}

/** ADR 0010 W3 — meghívó kézbesítési-status badge címke + variáns. */
function deliveryStatusBadge(status) {
    switch (status) {
        case 'sent':      return { label: 'Kiküldve',          variant: 'neutral' };
        case 'delivered': return { label: 'Kézbesítve',        variant: 'success' };
        case 'bounced':   return { label: 'Visszapattant',     variant: 'error' };
        case 'failed':    return { label: 'Kézbesítési hiba',  variant: 'error' };
        case 'pending':   return { label: 'Várakozik',         variant: 'muted' };
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

const ROLE_FILTER_OPTIONS = [
    { value: 'all',    label: 'Mind' },
    { value: 'owner',  label: 'Tulajdonos' },
    { value: 'admin',  label: 'Admin' },
    { value: 'member', label: 'Tag' }
];

/**
 * @param {Object} props
 * @param {Object} props.org — a szervezet rekord
 * @param {'owner'|'admin'|'member'|null} props.callerRole
 * @param {Array} props.members — organizationMemberships rekordok (a szervezetre)
 * @param {Array} props.pendingInvites — pending invite rekordok
 * @param {Map} props.userNameMap — userId → { name, email } (groupMemberships-ből)
 * @param {Function} props.onInviteSent — callback a pending invite lista újratöltésére
 * @param {Function} [props.onMembersRefresh] — opcionális teljes loadData() trigger.
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
    const { user, resendInviteEmail, changeOrganizationMemberRole, removeOrganizationMember } = useAuth();
    const { openModal } = useModal();
    const copyDialog = useCopyDialog();
    const confirm = useConfirm();

    const [actionError, setActionError] = useState('');
    const [actionPending, setActionPending] = useState(null);
    const [copiedId, setCopiedId] = useState(null);
    const copyTimerRef = useRef(null);

    // Toolbar állapot — kereső + szerepkör-szűrő. Csak kliens-oldali filter,
    // a server-fetch továbbra is a teljes listát kéri (kis lista, max ~200).
    const [searchQuery, setSearchQuery] = useState('');
    const [roleFilter, setRoleFilter] = useState('all');

    // Függő meghívók collapsible — alapból nyitva, ha van pending; user
    // bezárhatja, hogy a tagok-listára fókuszáljon.
    const [pendingExpanded, setPendingExpanded] = useState(true);
    // Meghívási történet ugyancsak collapsible — alapból zárva, a footer
    // alatt ritkán használt; csak admin/owner férhet hozzá.
    const [historyExpanded, setHistoryExpanded] = useState(false);

    const isOrgAdmin = callerRole === 'owner' || callerRole === 'admin';

    useEffect(() => () => {
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    }, []);

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

    /** Search + role-filter alkalmazva. A kereső név + email mezőre megy. */
    const filteredMembers = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return members.filter(m => {
            if (roleFilter !== 'all' && m.role !== roleFilter) return false;
            if (!q) return true;
            const resolved = userNameMap.get(m.userId);
            const isSelf = m.userId === user?.$id;
            const name = (resolved?.name
                || (isSelf ? user?.name : null)
                || ''
            ).toLowerCase();
            const email = (resolved?.email
                || (isSelf ? user?.email : null)
                || ''
            ).toLowerCase();
            return name.includes(q) || email.includes(q);
        });
    }, [members, searchQuery, roleFilter, userNameMap, user]);

    const grouped = useMemo(() => groupMembersByRole(filteredMembers), [filteredMembers]);

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
    /**
     * 2026-05-10 ([[Döntések/0012-org-member-removal-cascade]]) — admin-kick.
     *
     * Backend védelmi rétegek (CF `remove_organization_member`):
     * self-block, owner-touch (admin nem érint owner-t), last-owner guard,
     * STRICT team-cleanup (per-office + org + admin-team), DB cascade.
     * UI csak az UX-szintű egyértelmű eseteket szűri (gomb hide self/owner-on-admin).
     *
     * Email-typed verification ConfirmDialog-on át — a `member.userEmail`
     * denormalizált a [[ADR 0009]] alapján, pontosan az látszik a UI-on.
     * Legacy/null-denormalizált rekordnál fallback `member.userId` (ritka).
     */
    async function handleRemoveMember(member) {
        if (member.userId === user?.$id) {
            // UX-szintű early return — backend self-block-ja erre 403-mal
            // védekezne, de soha ne is kelljen.
            setActionError('Saját magadat nem tudod eltávolítani innen.');
            return;
        }

        const resolved = userNameMap.get(member.userId);
        const displayName = resolved?.name || resolved?.email || member.userEmail || member.userId;
        const verificationTarget = member.userEmail || resolved?.email || null;

        // Confirmation: ha van email, email-typed strict verification.
        // Ha nincs (legacy null), egyszerű igen/nem (a backend a hard-guardja).
        const ok = await confirm({
            title: 'Tag eltávolítása',
            message: (
                <>
                    <p>
                        <strong>{displayName}</strong> tagot eltávolítod a <strong>{org.name}</strong> szervezetből.
                    </p>
                    <ul style={{ marginTop: 12, marginBottom: 12, paddingLeft: 20, lineHeight: 1.6 }}>
                        <li>A felhasználó fiókja <strong>megmarad</strong>, más szervezetekben tovább dolgozhat.</li>
                        <li>A szervezet csoport- és szerkesztőség-tagságai megszűnnek.</li>
                        <li>Bármikor újra meghívhatod ugyanezzel az e-maillel.</li>
                    </ul>
                </>
            ),
            verificationExpected: verificationTarget,
            confirmLabel: 'Eltávolítás',
            cancelLabel: 'Mégsem',
            variant: 'danger'
        });

        if (!ok) return;

        setActionPending(`remove:${member.$id}`);
        setActionError('');

        try {
            await removeOrganizationMember(org.$id, member.userId);
            if (onMembersRefresh) {
                try {
                    await onMembersRefresh();
                } catch (refreshErr) {
                    console.warn('[UsersTab] onMembersRefresh sikertelen:', refreshErr);
                }
            }
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

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

    /** Egyetlen tag-sor: avatar + név/meta + (te badge) + role-control. */
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

        // 2026-05-10 ([[Döntések/0012]]) — admin-kick gomb láthatóság:
        //   - csak owner / admin caller látja (isOrgAdmin)
        //   - NEM látszik self-row-on (backend self-block)
        //   - admin caller NEM láthatja owner-row-on (UX előszűrés a backend
        //     owner-touch guard előtt; owner-caller LÁTHATJA, mert tudhatja
        //     törölni másik owner-t, csak last-owner véd ellene)
        const canRemoveThisMember = isOrgAdmin
            && !isSelf
            && !(callerRole === 'admin' && m.role === 'owner');
        const isProcessingRemove = actionPending === `remove:${m.$id}`;

        return (
            <li key={m.$id} className="org-settings-member-row">
                <div className={`org-settings-member-avatar org-settings-member-avatar--${m.role}`}>
                    {avatarInitials(displayName)}
                </div>
                <div className="org-settings-member-text">
                    <div className="org-settings-member-name-line">
                        <span className="org-settings-member-name">{displayName}</span>
                        {isSelf && (
                            <span className="org-settings-badge org-settings-badge--self">te</span>
                        )}
                    </div>
                    {displayEmail && (
                        <div className="org-settings-member-email">{displayEmail}</div>
                    )}
                </div>
                <div className="org-settings-member-action">
                    {canChangeThisMemberRole ? (
                        <select
                            className="org-settings-role-select"
                            value={m.role}
                            onChange={(e) => handleRoleChange(m, e.target.value)}
                            disabled={!!actionPending}
                            aria-label={`${displayName} szerepkörének módosítása`}
                        >
                            <option value="owner">Tulajdonos</option>
                            <option value="admin">Admin</option>
                            <option value="member">Tag</option>
                        </select>
                    ) : (
                        <span className={`org-settings-role-pill org-settings-role-pill--${m.role}`}>
                            {roleLabel(m.role)}
                        </span>
                    )}
                    {isProcessingRole && (
                        <span className="org-settings-role-spinner" aria-hidden="true">…</span>
                    )}
                    {canRemoveThisMember && (
                        <button
                            type="button"
                            className="org-settings-member-remove-btn"
                            onClick={() => handleRemoveMember(m)}
                            disabled={!!actionPending}
                            aria-label={`${displayName} eltávolítása a szervezetből`}
                            title="Tag eltávolítása"
                        >
                            {isProcessingRemove ? '…' : '×'}
                        </button>
                    )}
                </div>
            </li>
        );
    }

    /** Role-szekció (Tulajdonos / Admin / Tag) — color-marker dot + label. */
    function renderMemberGroup(roleKey, label, list) {
        // A grouped objektum CSAK az org-allowed role-okra (owner/admin/member) van
        // kalibrálva. Egzotikus role-érték (history/legacy) esetén üres listát
        // kapunk — nem dobunk error-t, csak nem rendereljük a szekciót.
        if (!Array.isArray(list)) return null;
        // D.0.1 — az „Admin (0)" üres-állapot szándékosan látszik, hogy a
        // szerepkör létezését megerősítse a felhasználónak (nem hiba, csak
        // jelenleg nincs benne tag).
        const isEmpty = list.length === 0;
        return (
            <div key={roleKey} className={`org-settings-member-group org-settings-member-group--${roleKey}${isEmpty ? ' is-empty' : ''}`}>
                <h4 className="org-settings-member-group-label">
                    <span className={`org-settings-role-dot org-settings-role-dot--${roleKey}`} aria-hidden="true" />
                    <span>{label} <span className="org-settings-section-count">({list.length})</span></span>
                </h4>
                {isEmpty ? (
                    <p className="org-settings-member-group-empty">
                        {roleKey === 'admin'
                            ? 'Még nincs admin tag.'
                            : roleKey === 'owner'
                                ? 'Még nincs tulajdonos.'
                                : 'Még nincs tag.'}
                    </p>
                ) : (
                    <ul className="org-settings-member-list">
                        {list.map(renderMemberRow)}
                    </ul>
                )}
            </div>
        );
    }

    return (
        <>
            {actionError && (
                <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>
            )}

            {/* ═══ Toolbar — kereső + filter + meghívás CTA + függőben badge ═══ */}
            <section className="org-settings-section org-settings-section--toolbar">
                <div className="org-settings-toolbar">
                    <div className="org-settings-toolbar-search">
                        <input
                            type="search"
                            className="org-settings-search-input"
                            placeholder="Tag keresése név vagy email szerint…"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            aria-label="Tag keresése"
                        />
                    </div>
                    <select
                        className="org-settings-role-filter"
                        value={roleFilter}
                        onChange={e => setRoleFilter(e.target.value)}
                        aria-label="Szerepkör szerint szűrés"
                    >
                        {ROLE_FILTER_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>
                                Szerepkör: {opt.label}
                            </option>
                        ))}
                    </select>
                    {isOrgAdmin && (
                        <button
                            type="button"
                            className="btn-primary org-settings-toolbar-cta"
                            onClick={handleOpenInviteModal}
                            disabled={!!actionPending}
                        >
                            + Meghívás
                        </button>
                    )}
                    {isOrgAdmin && pendingInvites.length > 0 && (
                        <button
                            type="button"
                            className="org-settings-pending-badge"
                            onClick={() => setPendingExpanded(v => !v)}
                            aria-expanded={pendingExpanded}
                            title={pendingExpanded ? 'Függő meghívók elrejtése' : 'Függő meghívók mutatása'}
                        >
                            {pendingInvites.length} függőben
                        </button>
                    )}
                </div>
            </section>

            {/* ═══ Függő meghívók collapsible (admin/owner) ═══ */}
            {isOrgAdmin && pendingInvites.length > 0 && pendingExpanded && (
                <section className="org-settings-section">
                    <h3 className="org-settings-section-label">
                        Függő meghívók <span className="org-settings-section-count">({pendingInvites.length})</span>
                    </h3>
                    <ul className="org-settings-pending-list">
                        {pendingInvites.map(inv => {
                            const badge = deliveryStatusBadge(inv.lastDeliveryStatus);
                            const isResending = actionPending === `resend:${inv.$id}`;
                            const expiresAt = inv.expiresAt
                                ? new Date(inv.expiresAt).toLocaleDateString('hu-HU')
                                : '?';
                            return (
                                <li key={inv.$id} className="org-settings-pending-row">
                                    <div className="org-settings-member-avatar org-settings-member-avatar--pending" aria-hidden="true">
                                        ?
                                    </div>
                                    <div className="org-settings-member-text">
                                        <div className="org-settings-member-name-line">
                                            <span className="org-settings-member-name">{inv.email}</span>
                                            {badge && (
                                                <span
                                                    className={`org-settings-delivery-badge org-settings-delivery-badge--${badge.variant}`}
                                                    title={inv.lastDeliveryError || badge.label}
                                                >
                                                    {badge.label}
                                                </span>
                                            )}
                                        </div>
                                        <div className="org-settings-member-email">
                                            {roleLabel(inv.role)} · lejár: {expiresAt}
                                        </div>
                                    </div>
                                    <div className="org-settings-pending-actions">
                                        <button
                                            type="button"
                                            className="btn-secondary org-settings-pending-btn"
                                            onClick={() => handleResendInvite(inv)}
                                            disabled={!!actionPending}
                                            title="E-mail újraküldése"
                                        >
                                            {isResending ? 'Küldés…' : 'Újraküldés'}
                                        </button>
                                        <button
                                            type="button"
                                            className="btn-secondary org-settings-pending-btn"
                                            onClick={() => handleCopyLink(inv)}
                                            disabled={!!actionPending}
                                            title="Meghívó link másolása"
                                        >
                                            {copiedId === inv.$id ? 'Másolva!' : 'Link másolása'}
                                        </button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            )}

            {/* ═══ Tagok role szerint csoportosítva ═══ */}
            <section className="org-settings-section">
                {members.length === 0 ? (
                    <p className="org-settings-empty">Nincsenek tagok.</p>
                ) : filteredMembers.length === 0 ? (
                    <p className="org-settings-empty">
                        Nincs találat a szűrésnek megfelelő taggal.
                    </p>
                ) : (
                    <>
                        {renderMemberGroup('owner', 'Tulajdonos', grouped.owner)}
                        {renderMemberGroup('admin', 'Admin', grouped.admin)}
                        {renderMemberGroup('member', 'Tag', grouped.member)}
                    </>
                )}
            </section>

            {/* ═══ Meghívási történet (E blokk, Q1 ACL) — collapsible ═══ */}
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
                <section className="org-settings-section org-settings-section--history">
                    <button
                        type="button"
                        className="org-settings-history-toggle"
                        onClick={() => setHistoryExpanded(v => !v)}
                        aria-expanded={historyExpanded}
                    >
                        <span aria-hidden="true">{historyExpanded ? '▾' : '▸'}</span>
                        <span>Meghívási történet <span className="org-settings-section-count">({inviteHistory.length})</span></span>
                    </button>
                    {historyExpanded && (
                        <ul className="org-settings-history-list">
                            {inviteHistory.map(h => {
                                const finalLabel = (() => {
                                    switch (h.finalStatus) {
                                        case 'accepted': return { text: 'Elfogadva',  variant: 'success' };
                                        case 'declined': return { text: 'Elutasítva', variant: 'muted' };
                                        case 'expired':  return { text: 'Lejárt',     variant: 'muted' };
                                        default:         return { text: h.finalStatus || '?', variant: 'muted' };
                                    }
                                })();
                                const finalAt = h.finalAt
                                    ? new Date(h.finalAt).toLocaleDateString('hu-HU')
                                    : '?';
                                return (
                                    <li key={h.$id} className="org-settings-history-row">
                                        <span className="org-settings-history-email">{h.email}</span>
                                        <span className="org-settings-history-role">{roleLabel(h.role)}</span>
                                        <span className={`org-settings-history-final org-settings-history-final--${finalLabel.variant}`}>
                                            {finalLabel.text}
                                        </span>
                                        <span className="org-settings-history-date">{finalAt}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            )}
        </>
    );
}
