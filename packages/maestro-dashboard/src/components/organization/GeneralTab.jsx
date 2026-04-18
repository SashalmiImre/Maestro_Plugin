/**
 * Maestro Dashboard — OrganizationSettings / GeneralTab
 *
 * A szervezet beállítás modal „Általános" füle:
 *   - Szervezet neve (inline szerkesztés, admin/owner)
 *   - Szerkesztőségek listája + „+ Új szerkesztőség" gomb
 *     (a gomb admin/ownernek — a CreateEditorialOfficeModal-t nyitja)
 *   - Veszélyes zóna (owner-only) — szervezet kaszkád törlése
 *     konkrét számokkal: X szerkesztőség, Y kiadvány, Z cikk, W tag stb.
 */

import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import DangerZone from '../DangerZone.jsx';
import CreateEditorialOfficeModal from './CreateEditorialOfficeModal.jsx';

function errorMessage(reason) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (reason.includes('invalid_name')) return 'A név nem lehet üres és nem haladhatja meg a 128 karaktert.';
    if (reason.includes('insufficient_role')) return 'Nincs jogosultságod ehhez a művelethez.';
    if (reason.includes('not_a_member')) return 'Nem vagy tagja ennek a szervezetnek.';
    if (reason.includes('organization_update_failed')) return 'A szervezet frissítése sikertelen. Próbáld újra.';
    if (reason.includes('delete_failed') || reason.includes('delete_organization_failed')) return 'A szervezet törlése sikertelen. Próbáld újra.';
    if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) {
        return 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';
    }
    return reason;
}

/**
 * @param {Object} props
 * @param {Object} props.org — a szervezet rekord (AuthContext.organizations-ből)
 * @param {'owner'|'admin'|'member'|null} props.callerRole
 * @param {Array} props.offices — szerkesztőségek a szervezetben
 * @param {number} props.membersCount
 * @param {number} props.pendingInvitesCount
 * @param {number} props.publicationsCount — kaszkád megerősítéshez
 * @param {number} props.articlesCount — kaszkád megerősítéshez
 */
export default function GeneralTab({
    org,
    callerRole,
    offices,
    membersCount,
    pendingInvitesCount,
    publicationsCount,
    articlesCount
}) {
    const { renameOrganization, deleteOrganization, reloadMemberships } = useAuth();
    const { openModal, closeModal } = useModal();
    const { showToast } = useToast();
    const confirm = useConfirm();
    const navigate = useNavigate();

    const [isEditingName, setIsEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const [actionPending, setActionPending] = useState(null);
    const [actionError, setActionError] = useState('');

    const isOrgAdmin = callerRole === 'owner' || callerRole === 'admin';
    const isOrgOwner = callerRole === 'owner';

    async function handleSaveName() {
        const trimmed = nameDraft.trim();
        if (!trimmed || trimmed === org?.name) {
            setIsEditingName(false);
            return;
        }

        setActionPending('rename');
        setActionError('');
        try {
            await renameOrganization(org.$id, trimmed);
            setIsEditingName(false);
            const ok = await reloadMemberships();
            if (!ok) {
                // A CF sikeres volt, csak a lista szinkron bukott. Non-blocking
                // warning — a user tudja, hogy a változás érvényes, de frissítés kell.
                showToast('A név módosult, de a listád frissítése sikertelen. Frissítsd az oldalt.', 'warning');
            }
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    function handleOpenCreateOffice() {
        openModal(
            <CreateEditorialOfficeModal
                organizationId={org.$id}
                switchScopeOnSuccess
            />,
            { title: 'Új szerkesztőség', size: 'small' }
        );
    }

    function handleOpenWorkflowDesigner(officeId) {
        closeModal();
        navigate(`/admin/office/${officeId}/workflow`);
    }

    const cascadeNode = useMemo(() => (
        <>
            <p>
                A szervezet <strong>véglegesen törlődik</strong> az összes kapcsolódó
                adattal együtt:
            </p>
            <ul>
                <li><strong>{offices.length}</strong> szerkesztőség</li>
                <li><strong>{publicationsCount}</strong> kiadvány</li>
                <li><strong>{articlesCount}</strong> cikk</li>
                <li><strong>{membersCount}</strong> tag</li>
                {pendingInvitesCount > 0 && (
                    <li><strong>{pendingInvitesCount}</strong> függő meghívó</li>
                )}
            </ul>
            <p>
                A kapcsolódó layoutok, határidők, csoportok, csoporttagságok és
                workflow-k is törlődnek.
            </p>
            <p><strong>Ez a művelet nem visszavonható.</strong></p>
        </>
    ), [offices.length, publicationsCount, articlesCount, membersCount, pendingInvitesCount]);

    async function handleDeleteOrganization() {
        if (!org) return;

        const ok = await confirm({
            title: 'Szervezet törlése',
            message: cascadeNode,
            verificationExpected: org.name,
            confirmLabel: 'Végleges törlés',
            cancelLabel: 'Mégse',
            variant: 'danger'
        });
        if (!ok) return;

        setActionPending('delete');
        setActionError('');
        try {
            await deleteOrganization(org.$id);
            closeModal();
            showToast(`A(z) „${org.name}" szervezet törölve lett.`, 'success');
            const ok = await reloadMemberships();
            if (!ok) {
                // Szervezet tényleg törölve a szerveren; csak a kliens lista
                // friss állapota nem frissült. Egy második, diszkrét toast
                // mondja meg, hogy frissítés kell — a `ScopeContext` amúgy is
                // auto-pick-el egy másik org-ra, ha van.
                showToast('A kliens szinkron sikertelen. Frissítsd az oldalt.', 'warning');
            }
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
            setActionPending(null);
        }
    }

    return (
        <>
            {actionError && (
                <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>
            )}

            {/* ═══ Szervezet neve ═══ */}
            <div style={{ marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
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
                                background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--outline-variant)',
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
                                background: 'var(--accent-solid)', color: '#fff', border: 'none',
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
                                background: 'none', color: 'var(--text-secondary)', border: '1px solid var(--outline-variant)',
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
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({org?.slug})</span>
                        {isOrgAdmin && (
                            <button
                                onClick={() => {
                                    setNameDraft(org?.name || '');
                                    setIsEditingName(true);
                                }}
                                disabled={!!actionPending}
                                style={{
                                    marginLeft: 'auto', background: 'none', border: '1px solid var(--outline-variant)',
                                    color: 'var(--text-secondary)', padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
                                    fontSize: 11
                                }}
                            >
                                Szerkesztés
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* ═══ Szerkesztőségek + „+ Új" ═══ */}
            <div style={{ marginBottom: 20, borderBottom: isOrgOwner ? '1px solid var(--border)' : 'none', paddingBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                        Szerkesztőségek <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>({offices.length})</span>
                    </h3>
                    {isOrgAdmin && (
                        <button
                            type="button"
                            onClick={handleOpenCreateOffice}
                            style={{
                                marginLeft: 'auto',
                                background: 'var(--accent-solid)', color: '#fff', border: 'none',
                                padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
                                fontSize: 11
                            }}
                        >
                            + Új szerkesztőség
                        </button>
                    )}
                </div>

                {offices.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>
                        Nincsenek szerkesztőségek.
                    </p>
                ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {offices.map(office => (
                            <li key={office.$id} style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                fontSize: 13, padding: '3px 0'
                            }}>
                                <span>{office.name}</span>
                                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({office.slug})</span>
                                <button
                                    type="button"
                                    onClick={() => handleOpenWorkflowDesigner(office.$id)}
                                    style={{
                                        marginLeft: 'auto', fontSize: 11,
                                        color: 'var(--accent)', textDecoration: 'none',
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

            {/* ═══ Veszélyes zóna — csak owner ═══ */}
            {isOrgOwner && (
                <DangerZone
                    description={
                        <>
                            A szervezet véglegesen törlődik az összes szerkesztőséggel,
                            kiadvánnyal, cikkel, layouttal, határidővel, csoporttagsággal
                            és meghívóval együtt. Ez a művelet nem visszavonható.
                        </>
                    }
                    buttonLabel="Szervezet törlése"
                    isPending={actionPending === 'delete'}
                    onDelete={handleDeleteOrganization}
                />
            )}
        </>
    );
}
