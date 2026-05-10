/**
 * Maestro Dashboard — OrganizationSettings / GeneralTab
 *
 * A szervezet beállítás modal „Általános" füle:
 *   - Megnevezés card: szervezet neve (inline szerkesztés, admin/owner) + slug
 *   - Szerkesztőségek lista: clickable card-row-k „Megnyitás →" link-affordanciával
 *     + „+ Új szerkesztőség" CTA (admin/owner)
 *   - Veszélyes zóna (owner-only) — szervezet kaszkád törlése konkrét számokkal
 */

import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
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
    const { setActiveOrganization, setActiveOffice } = useScope();
    const { openModal, closeModal } = useModal();
    const { showToast } = useToast();
    const confirm = useConfirm();
    const navigate = useNavigate();

    const [isEditingName, setIsEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const [actionPending, setActionPending] = useState(null);
    const [actionError, setActionError] = useState('');
    const [slugCopied, setSlugCopied] = useState(false);

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

    function handleStartEdit() {
        if (!isOrgAdmin) return;
        setNameDraft(org?.name || '');
        setIsEditingName(true);
    }

    async function handleCopySlug() {
        if (!org?.slug) return;
        try {
            await navigator.clipboard.writeText(org.slug);
            setSlugCopied(true);
            setTimeout(() => setSlugCopied(false), 1500);
        } catch {
            // Clipboard API nem elérhető — csendes no-op (a slug látható, kézzel másolható).
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

    // A workflow-k saját `/workflows/:id` route-on élnek (nem office-kötött),
    // a library-t a breadcrumb chip nyitja. Ez a gomb csak a scope-ot billenti
    // a user helyébe, majd a dashboard-ra ugrik — onnan nyithat workflow-t.
    function handleOpenWorkflowDesigner(officeId) {
        setActiveOrganization(org.$id);
        setActiveOffice(officeId);
        closeModal();
        navigate('/');
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
            const reloadOk = await reloadMemberships();
            if (!reloadOk) {
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

            {/* ═══ Megnevezés card ═══ */}
            <section className="org-settings-section">
                <h3 className="org-settings-section-label">Megnevezés</h3>
                <div className="org-settings-card org-settings-card--rows">
                    {/* Név sor — inline edit */}
                    <div className="org-settings-field-row">
                        <span className="org-settings-field-label">Név</span>
                        {isEditingName && isOrgAdmin ? (
                            <div className="org-settings-name-edit">
                                <input
                                    type="text"
                                    className="org-settings-name-input"
                                    value={nameDraft}
                                    onChange={e => setNameDraft(e.target.value)}
                                    disabled={actionPending === 'rename'}
                                    maxLength={128}
                                    autoFocus
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') handleSaveName();
                                        if (e.key === 'Escape') setIsEditingName(false);
                                    }}
                                />
                                <button
                                    type="button"
                                    className="btn-primary org-settings-name-save"
                                    onClick={handleSaveName}
                                    disabled={!!actionPending}
                                >
                                    {actionPending === 'rename' ? '…' : 'Mentés'}
                                </button>
                                <button
                                    type="button"
                                    className="btn-secondary org-settings-name-cancel"
                                    onClick={() => setIsEditingName(false)}
                                    disabled={!!actionPending}
                                >
                                    Mégse
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="org-settings-field-value org-settings-field-value--editable"
                                onClick={handleStartEdit}
                                disabled={!isOrgAdmin || !!actionPending}
                                title={isOrgAdmin ? 'Kattints a szerkesztéshez' : 'Csak admin módosíthatja'}
                                aria-label={`Szervezet neve: ${org?.name || '—'}${isOrgAdmin ? ' — szerkesztés' : ''}`}
                            >
                                <span>{org?.name || '—'}</span>
                                {isOrgAdmin && (
                                    <span className="org-settings-field-pen" aria-hidden="true">✎</span>
                                )}
                            </button>
                        )}
                    </div>

                    {/* Slug sor — read-only + copy */}
                    <div className="org-settings-field-row">
                        <span className="org-settings-field-label">Slug</span>
                        <div className="org-settings-field-value org-settings-field-value--mono">
                            <span>{org?.slug || '—'}</span>
                            {org?.slug && (
                                <button
                                    type="button"
                                    className="org-settings-copy-btn"
                                    onClick={handleCopySlug}
                                    aria-label="Slug másolása"
                                    title={slugCopied ? 'Másolva!' : 'Slug másolása'}
                                >
                                    {slugCopied ? '✓' : '⧉'}
                                </button>
                            )}
                        </div>
                    </div>

                    <p className="org-settings-card-hint">
                        A slug az URL-ben szereplő egyedi azonosító. Csak admin-tool módosíthatja.
                    </p>
                </div>
            </section>

            {/* ═══ Szerkesztőségek ═══ */}
            <section className="org-settings-section">
                <div className="org-settings-section-header">
                    <h3 className="org-settings-section-label">
                        Szerkesztőségek <span className="org-settings-section-count">({offices.length})</span>
                    </h3>
                    {isOrgAdmin && (
                        <button
                            type="button"
                            className="btn-primary org-settings-section-cta"
                            onClick={handleOpenCreateOffice}
                        >
                            + Új szerkesztőség
                        </button>
                    )}
                </div>

                {offices.length === 0 ? (
                    <p className="org-settings-empty">Nincsenek szerkesztőségek.</p>
                ) : (
                    <ul className="org-settings-office-list">
                        {offices.map(office => (
                            <li key={office.$id}>
                                <button
                                    type="button"
                                    className="org-settings-office-row"
                                    onClick={() => handleOpenWorkflowDesigner(office.$id)}
                                    title={'A szerkesztőség aktívvá válik; a workflow-kat a breadcrumb „Workflow" chipről nyithatod meg.'}
                                >
                                    <span className="org-settings-office-icon" aria-hidden="true">📰</span>
                                    <span className="org-settings-office-text">
                                        <span className="org-settings-office-name">{office.name}</span>
                                        <span className="org-settings-office-meta">{office.slug}</span>
                                    </span>
                                    <span className="org-settings-office-link">Megnyitás →</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

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
