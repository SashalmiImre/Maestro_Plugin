/**
 * Maestro Dashboard — EditorialOfficeSettings / GeneralTab
 *
 * A szerkesztőség beállítás modal „Általános" füle:
 *   - Név szerkesztés (inline, admin/owner) — a slug stabilitás miatt
 *     változatlan marad, csak a display name cserélhető.
 *   - „+ Új kiadvány" gomb — a CreatePublicationModal-t nyitja (ScopeContext-ből
 *     veszi az activeEditorialOfficeId-t, így prop nem szükséges).
 *   - Veszélyes zóna (owner/admin) — szerkesztőség kaszkád törlése.
 */

import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import DangerZone from '../DangerZone.jsx';
import CreatePublicationModal from '../publications/CreatePublicationModal.jsx';

function errorMessage(reason) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (reason.includes('invalid_name')) return 'A név nem lehet üres és nem haladhatja meg a 128 karaktert.';
    if (reason.includes('name_taken')) return 'Ezen a néven már létezik szerkesztőség a szervezetben.';
    if (reason.includes('insufficient_role')) return 'Nincs jogosultságod ehhez a művelethez.';
    if (reason.includes('not_a_member')) return 'Nem vagy tagja ennek a szervezetnek.';
    if (reason.includes('office_not_found')) return 'A szerkesztőség nem található.';
    if (reason.includes('office_update_failed') || reason.includes('update_failed')) {
        return 'A szerkesztőség frissítése sikertelen. Próbáld újra.';
    }
    if (reason.includes('delete_failed')) return 'A szerkesztőség törlése sikertelen. Próbáld újra.';
    if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) {
        return 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';
    }
    return reason;
}

/**
 * @param {Object} props
 * @param {Object} props.office — a szerkesztőség rekord
 * @param {Object|null} props.org — a parent szervezet rekord (vagy null)
 * @param {'owner'|'admin'|'member'|null} props.callerRole — a caller org-szintű szerepköre
 */
export default function EditorialOfficeGeneralTab({ office, org, callerRole }) {
    const { renameEditorialOffice, deleteEditorialOffice, reloadMemberships } = useAuth();
    const { openModal, closeModal } = useModal();
    const { activeEditorialOfficeId } = useScope();
    const { showToast } = useToast();
    const confirm = useConfirm();

    const [isEditingName, setIsEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const [actionPending, setActionPending] = useState(null);
    const [actionError, setActionError] = useState('');

    const isOrgAdmin = callerRole === 'owner' || callerRole === 'admin';
    // A CreatePublicationModal a ScopeContext activeEditorialOfficeId-jét olvassa — ha
    // ez a modal nem az aktív office-é (pl. user több office-ban admin, másikat nyitott
    // meg közvetlenül), a publikáció rossz scope-ba menne. A gombot letiltjuk ilyenkor.
    const isActiveOffice = office?.$id === activeEditorialOfficeId;

    async function handleSaveName() {
        const trimmed = nameDraft.trim();
        if (!trimmed || trimmed === office?.name) {
            setIsEditingName(false);
            return;
        }

        setActionPending('rename');
        setActionError('');
        try {
            await renameEditorialOffice(office.$id, trimmed);
            setIsEditingName(false);
            const ok = await reloadMemberships();
            if (!ok) {
                // A CF sikeres volt, csak a kliens lista szinkron bukott.
                // Non-blocking warning — a név érvényes a szerveren.
                showToast('A név módosult, de a listád frissítése sikertelen. Frissítsd az oldalt.', 'warning');
            }
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    function handleOpenCreatePublication() {
        if (!isActiveOffice) return;
        openModal(<CreatePublicationModal />, {
            title: 'Új kiadvány',
            size: 'small'
        });
    }

    async function handleDeleteOffice() {
        if (!office) return;

        const confirmMessage = (
            <>
                <p>
                    A szerkesztőség <strong>véglegesen törlődik</strong> az összes kiadvánnyal,
                    cikkel, layouttal, határidővel, csoporttal, csoporttagsággal és workflow-val
                    együtt.
                </p>
                <p>A szervezet és a többi szerkesztőség érintetlen marad.</p>
                <p><strong>Ez a művelet nem visszavonható.</strong></p>
            </>
        );

        const ok = await confirm({
            title: 'Szerkesztőség törlése',
            message: confirmMessage,
            verificationExpected: office.name,
            confirmLabel: 'Végleges törlés',
            cancelLabel: 'Mégse',
            variant: 'danger'
        });
        if (!ok) return;

        setActionPending('delete');
        setActionError('');
        try {
            await deleteEditorialOffice(office.$id);
            closeModal();
            showToast(`A(z) „${office.name}" szerkesztőség törölve lett.`, 'success');
            try { await reloadMemberships(); } catch { /* ScopeContext auto-pick kezeli */ }
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

            {/* ═══ Szerkesztőség neve ═══ */}
            <div style={{ marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                    Szerkesztőség neve
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
                        <span style={{ fontSize: 14 }}>{office?.name || '—'}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({office?.slug})</span>
                        {isOrgAdmin && (
                            <button
                                onClick={() => {
                                    setNameDraft(office?.name || '');
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

                {org && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                        Szervezet: {org.name}
                    </div>
                )}
            </div>

            {/* ═══ Kiadványok — „+ Új kiadvány" gomb ═══ */}
            <div style={{ marginBottom: 20, borderBottom: isOrgAdmin ? '1px solid var(--border)' : 'none', paddingBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                        Kiadványok
                    </h3>
                    {isOrgAdmin && (
                        <button
                            type="button"
                            onClick={handleOpenCreatePublication}
                            disabled={!isActiveOffice}
                            title={isActiveOffice
                                ? undefined
                                : 'Váltsd át erre a szerkesztőségre a breadcrumbban, hogy kiadványt hozz létre.'}
                            style={{
                                marginLeft: 'auto',
                                background: isActiveOffice ? 'var(--accent-solid)' : 'var(--bg-elevated)',
                                color: isActiveOffice ? '#fff' : 'var(--text-muted)',
                                border: 'none',
                                padding: '4px 10px', borderRadius: 4,
                                cursor: isActiveOffice ? 'pointer' : 'not-allowed',
                                fontSize: 11
                            }}
                        >
                            + Új kiadvány
                        </button>
                    )}
                </div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>
                    A kiadványok listája és részletes beállításai a Kiadvány menüben
                    (breadcrumb fejléc) érhetők el.
                </p>
            </div>

            {/* ═══ Veszélyes zóna — owner/admin ═══ */}
            {isOrgAdmin && (
                <DangerZone
                    description="A szerkesztőség véglegesen törlődik az összes kiadvánnyal, cikkel, layouttal, határidővel, csoporttal, csoporttagsággal és workflow-val együtt. A szervezet és a többi szerkesztőség érintetlen marad. Ez a művelet nem visszavonható."
                    buttonLabel="Szerkesztőség törlése"
                    isPending={actionPending === 'delete'}
                    onDelete={handleDeleteOffice}
                />
            )}
        </>
    );
}
