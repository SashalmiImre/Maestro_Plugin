/**
 * Maestro Dashboard — SettingsPasswordRoute
 *
 * A `/settings/password` route. Bejelentkezett user saját jelszavának
 * módosítása (a meglévő jelszó + új jelszó megadásával). A recovery flow
 * (ForgotPasswordRoute + ResetPasswordRoute) külön, kijelentkezett állapotra
 * szolgál — ez a route a már bejelentkezett user önkéntes módosítási útja.
 *
 * Az `AuthContext.updatePassword(oldPassword, newPassword)` → `account.updatePassword`
 * hívást használja. Siker esetén a user továbbra is bejelentkezve marad, a
 * success banner + "Vissza a Dashboardra" link ad visszajelzést.
 */

import React, { useState, useEffect } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import { useAuth, getAccount } from '../../contexts/AuthContext.jsx';

export default function SettingsPasswordRoute() {
    const { updatePassword } = useAuth();
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
    const [phase, setPhase] = useState('idle'); // 'idle' | 'success'
    const [error, setError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Session hygiene — más eszközök kijelentkeztetése jelszócsere után
    const [otherSessions, setOtherSessions] = useState(null); // null = még nem kérdezett
    const [sessionCleanupDone, setSessionCleanupDone] = useState(false);
    const [isCleaningUp, setIsCleaningUp] = useState(false);

    // Dirty form guard — navigáció figyelmeztetés kitöltött mezőknél
    const isDirty = oldPassword.length > 0 || newPassword.length > 0 || newPasswordConfirm.length > 0;

    // beforeunload: böngésző bezárás / újratöltés
    useEffect(() => {
        if (!isDirty) return;
        const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [isDirty]);

    // Session lista lekérése sikeres jelszócsere után
    useEffect(() => {
        if (phase !== 'success') return;
        let cancelled = false;
        (async () => {
            try {
                const { sessions } = await getAccount().listSessions();
                const others = sessions.filter(s => !s.current);
                if (!cancelled) setOtherSessions(others);
            } catch {
                // Ha nem sikerül lekérdezni, nem mutatjuk a gombot
                if (!cancelled) setOtherSessions([]);
            }
        })();
        return () => { cancelled = true; };
    }, [phase]);

    async function handleLogoutOthers() {
        if (!otherSessions || otherSessions.length === 0) return;
        setIsCleaningUp(true);
        try {
            const account = getAccount();
            await Promise.allSettled(otherSessions.map(s => account.deleteSession({ sessionId: s.$id })));
            // Friss session lista lekérése — a már törölt sessionök nem jelennek meg
            try {
                const { sessions } = await account.listSessions();
                const remaining = sessions.filter(s => !s.current);
                setOtherSessions(remaining);
                setSessionCleanupDone(remaining.length === 0);
            } catch {
                // Ha a friss lista nem kérhető le, a gomb marad — a user újra próbálhatja
            }
        } catch {
            // Hálózati hiba — a gomb marad, a user újra próbálhatja
        } finally {
            setIsCleaningUp(false);
        }
    }

    // react-router navigáció blokkolás (auth redirect-ek kiengedve)
    const blocker = useBlocker(({ currentLocation, nextLocation }) =>
        isDirty
        && currentLocation.pathname !== nextLocation.pathname
        && nextLocation.pathname !== '/login'
        && nextLocation.pathname !== '/onboarding'
    );

    async function handleSubmit(e) {
        e.preventDefault();
        // Dupla submit guard (belt-and-suspenders a `disabled` gomb mellé).
        if (isSubmitting) return;
        setError('');

        // Kliens-oldali validáció — az Appwrite is ellenőrzi, de jobb UX,
        // ha a triviális hibáknál nincs hálózati round-trip.
        if (oldPassword.length === 0) {
            setError('Add meg a jelenlegi jelszavadat.');
            return;
        }
        if (newPassword.length < 8) {
            setError('Az új jelszónak legalább 8 karakter hosszúnak kell lennie.');
            return;
        }
        if (newPassword !== newPasswordConfirm) {
            setError('A két új jelszó nem egyezik.');
            return;
        }
        if (oldPassword === newPassword) {
            setError('Az új jelszó nem lehet azonos a régivel.');
            return;
        }

        setIsSubmitting(true);
        try {
            await updatePassword(oldPassword, newPassword);
            setPhase('success');
            setOldPassword('');
            setNewPassword('');
            setNewPasswordConfirm('');
        } catch (err) {
            // Appwrite hibaformátum: { type, code, message }. A `type` adja a
            // strukturált azonosítót, string match csak hálózati / ismeretlen
            // hibákra fallback — egyezik a ForgotPasswordRoute mintával.
            const type = err?.type || '';
            const code = err?.code;
            const msg = err?.message || '';
            const lower = msg.toLowerCase();

            if (type === 'user_invalid_credentials') {
                setError('A jelenlegi jelszó hibás.');
            } else if (type === 'password_recently_used' || type === 'password_personal_data') {
                setError('Ez a jelszó nem használható. Válassz egy korábban nem használt, személyes adatot nem tartalmazó jelszót.');
            } else if (type === 'general_argument_invalid' || lower.includes('password must be') || lower.includes('password too short')) {
                setError('Az új jelszó túl rövid vagy nem felel meg a követelményeknek.');
            } else if (type === 'general_rate_limit_exceeded' || code === 429) {
                setError('Túl sok kérés. Próbáld újra néhány perc múlva.');
            } else if (lower.includes('network') || lower.includes('failed to fetch')) {
                setError('Hálózati hiba. Próbáld újra.');
            } else {
                // Operatív/konfigurációs hibák — surface-oljuk, hogy a user
                // retry-olhasson és az ops is észlelje az outage-et.
                console.warn('[SettingsPassword] updatePassword sikertelen:', { type, code, message: msg });
                setError('Hiba a jelszó frissítésénél. Próbáld újra.');
            }
        } finally {
            setIsSubmitting(false);
        }
    }

    if (phase === 'success') {
        return (
            <div className="login-card">
                <div className="form-heading">Jelszó módosítása</div>
                <div className="auth-success">Jelszavad sikeresen módosítva.</div>

                {/* Session hygiene: más eszközök kijelentkeztetése */}
                {sessionCleanupDone ? (
                    <p style={{ fontSize: 13, color: '#81c784', margin: '12px 0 0' }}>
                        Minden más eszköz kijelentkeztetve.
                    </p>
                ) : otherSessions && otherSessions.length > 0 ? (
                    <button
                        type="button"
                        onClick={handleLogoutOthers}
                        disabled={isCleaningUp}
                        style={{
                            marginTop: 12, padding: '8px 16px', fontSize: 13,
                            borderRadius: 4, border: '1px solid #555',
                            background: 'transparent', color: '#ccc', cursor: 'pointer',
                            opacity: isCleaningUp ? 0.6 : 1
                        }}
                    >
                        {isCleaningUp
                            ? 'Kijelentkeztetés...'
                            : `Más eszközök kijelentkeztetése (${otherSessions.length} aktív)`
                        }
                    </button>
                ) : null}

                <div className="auth-bottom-link">
                    <Link to="/">Vissza a Dashboardra</Link>
                </div>
            </div>
        );
    }

    return (
        <div className="login-card">
            <div className="form-heading">Jelszó módosítása</div>
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label htmlFor="settings-old-password">Jelenlegi jelszó</label>
                    <input
                        id="settings-old-password"
                        type="password"
                        autoComplete="current-password"
                        required
                        value={oldPassword}
                        onChange={e => setOldPassword(e.target.value)}
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="settings-new-password">Új jelszó (min. 8 karakter)</label>
                    <input
                        id="settings-new-password"
                        type="password"
                        autoComplete="new-password"
                        required
                        value={newPassword}
                        onChange={e => setNewPassword(e.target.value)}
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="settings-new-password-confirm">Új jelszó megerősítése</label>
                    <input
                        id="settings-new-password-confirm"
                        type="password"
                        autoComplete="new-password"
                        required
                        value={newPasswordConfirm}
                        onChange={e => setNewPasswordConfirm(e.target.value)}
                    />
                </div>
                <button type="submit" className="login-btn" disabled={isSubmitting}>
                    {isSubmitting ? 'Mentés...' : 'Jelszó módosítása'}
                </button>
                {error && <div className="login-error">{error}</div>}
            </form>
            <div className="auth-bottom-link">
                <Link to="/">Mégse</Link>
            </div>

            {/* Navigáció blokkoló dialógus */}
            {blocker.state === 'blocked' && (
                <div
                    style={{
                        position: 'fixed', inset: 0, zIndex: 9999,
                        background: 'rgba(0,0,0,0.55)', display: 'flex',
                        alignItems: 'center', justifyContent: 'center'
                    }}
                    onClick={() => blocker.reset()}
                >
                    <div
                        style={{
                            background: '#1e1e1e', borderRadius: 8, padding: '24px 28px',
                            maxWidth: 420, width: '90%', border: '1px solid #444'
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <h3 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600, color: '#e0e0e0' }}>
                            Nem mentett változások
                        </h3>
                        <p style={{ fontSize: 13, color: '#999', margin: '0 0 16px' }}>
                            A jelszómezők ki vannak töltve. Biztosan elhagyod az oldalt?
                        </p>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                            <button
                                type="button"
                                onClick={() => blocker.reset()}
                                style={{
                                    padding: '6px 16px', fontSize: 13, borderRadius: 4,
                                    border: '1px solid #555', background: 'transparent',
                                    color: '#ccc', cursor: 'pointer'
                                }}
                            >
                                Maradok
                            </button>
                            <button
                                type="button"
                                onClick={() => blocker.proceed()}
                                style={{
                                    padding: '6px 16px', fontSize: 13, borderRadius: 4,
                                    border: 'none', background: '#e53935', color: '#fff',
                                    cursor: 'pointer'
                                }}
                            >
                                Elhagyom
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
