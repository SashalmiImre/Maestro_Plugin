/**
 * Maestro Dashboard — SettingsAccountRoute
 *
 * A `/settings/account` route. Self-service profile-screen két szekcióval:
 *
 *   1. **Saját szervezetek** — listázza az `organizations`-ot, ahol a user
 *      tag. Per-org "Elhagyás" gomb → `leaveOrganization()` AuthContext method.
 *      Backend last-owner / last-member block.
 *
 *   2. **Veszélyes zóna — Fiók törlése** — `deleteMyAccount()` self-service
 *      cross-org cleanup + `users.delete(callerId)`. Email-typed verification
 *      ConfirmDialog. Sikeres call után best-effort `account.deleteSession`
 *      + redirect `/login`.
 *
 * Részletek: [[Döntések/0013-self-service-account-management]]
 *
 * Az `AuthSplitLayout` alatti settings-route-ok NEM kapnak `ModalProvider`-t
 * (csak a Dashboard ág). Ezért egy lokális `ModalProvider` wrapper kell a
 * `useConfirm()` használatához. A `App.jsx` a `<SettingsAccountWithProviders />`-t
 * mountolja.
 */

import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ModalProvider } from '../../contexts/ModalContext.jsx';
import { ToastProvider } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';

function errorMessage(reason) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('not_authenticated')) return 'Be kell jelentkezned újra.';
    if (reason.includes('last_owner_block')) return 'Utolsó tulajdonos vagy ebben a szervezetben — előbb adj át tulajdonjogot egy másik tagnak.';
    if (reason.includes('last_member_block')) return 'Egyedüli tag vagy ebben a szervezetben — a "Saját szervezetek" alatt töröld a szervezetet helyette.';
    if (reason.includes('last_owner_in_orgs')) return 'A felsorolt szervezetekben utolsó tulajdonos vagy. Először adj át tulajdonjogot, vagy töröld a szervezetet.';
    if (reason.includes('confirm_required')) return 'A megerősítés hiányzik — frissítsd az oldalt és próbáld újra.';
    if (reason.includes('partial_cleanup')) return 'A fiók-törlés részben sikerült — próbáld újra. Ha újra hibázik, fordulj a támogatáshoz.';
    if (reason.includes('user_delete_failed')) return 'A fiók-törlés végső lépése sikertelen — manuális admin-segítség szükséges.';
    if (reason.includes('too_many_orgs')) return 'Túl sok szervezetben vagy tag a fiók-törléshez. Előbb lépj ki néhányból manuálisan, majd próbáld újra.';
    if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) return 'Hálózati hiba. Próbáld újra.';
    return 'Hiba történt. Próbáld újra.';
}

function SettingsAccountInner() {
    const { user, organizations, leaveOrganization, deleteMyAccount, reloadMemberships, logout } = useAuth();
    const navigate = useNavigate();
    const confirm = useConfirm();
    const [actionPending, setActionPending] = useState(null);
    const [error, setError] = useState('');
    const [info, setInfo] = useState('');

    async function handleLeaveOrganization(org) {
        setError('');
        setInfo('');

        const ok = await confirm({
            title: 'Szervezet elhagyása',
            message: (
                <>
                    <p>
                        Elhagyod a <strong>{org.name}</strong> szervezetet.
                    </p>
                    <ul style={{ marginTop: 12, marginBottom: 12, paddingLeft: 20, lineHeight: 1.6 }}>
                        <li>A felhasználói fiókod <strong>megmarad</strong>, más szervezetekben tovább él.</li>
                        <li>Csoport- és szerkesztőség-tagságaid ebben a szervezetben megszűnnek.</li>
                        <li>A szervezet adatait, kiadványait <strong>nem látod többé</strong>.</li>
                        <li>Ha vissza akarsz térni, a tulajdonosnak újra meg kell hívnia.</li>
                    </ul>
                </>
            ),
            verificationExpected: org.slug || org.name,
            confirmLabel: 'Elhagyás',
            cancelLabel: 'Mégsem',
            variant: 'danger'
        });

        if (!ok) return;

        setActionPending(`leave:${org.$id}`);
        try {
            await leaveOrganization(org.$id);
            setInfo(`Sikeresen kiléptél a "${org.name}" szervezetből.`);
            await reloadMemberships();
        } catch (err) {
            setError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    async function handleDeleteAccount() {
        setError('');
        setInfo('');

        if (!user?.email) {
            setError('A fiókodhoz nem érhető el az e-mail cím — fordulj a támogatáshoz.');
            return;
        }

        const ok = await confirm({
            title: 'Fiók törlése',
            message: (
                <>
                    <p>
                        <strong>Véglegesen törlöd a fiókodat.</strong>
                    </p>
                    <ul style={{ marginTop: 12, marginBottom: 12, paddingLeft: 20, lineHeight: 1.6 }}>
                        <li>Eltűnsz <strong>minden</strong> szervezetből, ahol jelenleg tag vagy ({organizations?.length || 0} szervezet).</li>
                        <li>A fiókod <strong>nem állítható vissza</strong>.</li>
                        <li>Audit-rekordjaid orphan-né válnak (jogi kötelezettségek miatt megőrződnek, de nem köthetők személyhez).</li>
                        <li>Ha valamelyik szervezetben utolsó tulajdonos vagy és vannak más tagok, először át kell adnod a tulajdonjogot — különben a művelet leáll.</li>
                    </ul>
                </>
            ),
            verificationExpected: user.email,
            confirmLabel: 'Fiók törlése',
            cancelLabel: 'Mégsem',
            variant: 'danger'
        });

        if (!ok) return;

        setActionPending('delete-account');
        try {
            await deleteMyAccount();

            // ADR 0013 M5 fix — best-effort logout. A backend session-t a
            // `users.delete` érvénytelenítette, a logout()-ban hívott
            // `account.deleteSession` 401/404-et adhat — ezt a logout() belül
            // try/catch-eli. Stop-time review m1: NEM hívunk direkt
            // `getAccount().deleteSession`-t (redundáns lenne a logout-tal).
            try {
                await logout();
            } catch (logoutErr) {
                console.warn('[SettingsAccount] logout cleanup bukott (acceptable):', logoutErr);
            }

            navigate('/login', { replace: true });
        } catch (err) {
            setError(errorMessage(err.message || err.code || ''));
            setActionPending(null);
        }
    }

    const orgList = Array.isArray(organizations) ? organizations : [];

    return (
        <div className="login-card" style={{ maxWidth: 560 }}>
            <div className="form-heading">Saját fiókom</div>

            {info && (
                <div className="auth-success" style={{ marginBottom: 16 }}>
                    {info}
                </div>
            )}
            {error && (
                <div className="login-error" style={{ marginBottom: 16 }}>
                    {error}
                </div>
            )}

            <section style={{ marginTop: 16 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 8px' }}>
                    Saját szervezeteim
                </h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
                    Az alábbi szervezetekben vagy tag. Az "Elhagyás" gomb kivesz az adott szervezetből (a fiókod megmarad).
                </p>
                {orgList.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        Jelenleg egyetlen szervezetnek sem vagy tagja.
                    </p>
                ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {orgList.map(org => {
                            const isPending = actionPending === `leave:${org.$id}`;
                            return (
                                <li
                                    key={org.$id}
                                    style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                        gap: 12, padding: '10px 12px',
                                        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                                        borderRadius: 6
                                    }}
                                >
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                                            {org.name}
                                        </div>
                                        {org.slug && (
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                                                {org.slug}
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => handleLeaveOrganization(org)}
                                        disabled={!!actionPending}
                                        style={{
                                            padding: '6px 14px', fontSize: 12, borderRadius: 4,
                                            border: '1px solid var(--outline-variant)', background: 'transparent',
                                            color: 'var(--text-secondary)', cursor: 'pointer',
                                            opacity: actionPending && !isPending ? 0.5 : 1
                                        }}
                                    >
                                        {isPending ? 'Folyamatban…' : 'Elhagyás'}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <section style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--border)' }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-danger, #d33)', margin: '0 0 8px' }}>
                    Veszélyes zóna
                </h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 16px', lineHeight: 1.5 }}>
                    A fiók-törlés <strong>visszafordíthatatlan</strong>: minden szervezetből eltűnsz,
                    a fiókod nem állítható vissza, az e-mail-címed felszabadul új regisztrációra.
                </p>
                <button
                    type="button"
                    onClick={handleDeleteAccount}
                    disabled={!!actionPending}
                    style={{
                        padding: '10px 20px', fontSize: 13, fontWeight: 500, borderRadius: 4,
                        border: 'none', background: 'var(--c-danger, #d33)', color: '#fff',
                        cursor: actionPending ? 'not-allowed' : 'pointer',
                        opacity: actionPending ? 0.6 : 1
                    }}
                >
                    {actionPending === 'delete-account' ? 'Törlés folyamatban…' : 'Fiók törlése'}
                </button>
            </section>

            <div className="auth-bottom-link" style={{ marginTop: 24 }}>
                <Link to="/">Vissza a Dashboardra</Link>
            </div>
        </div>
    );
}

export default function SettingsAccountRoute() {
    return (
        <ToastProvider>
            <ModalProvider>
                <SettingsAccountInner />
            </ModalProvider>
        </ToastProvider>
    );
}
