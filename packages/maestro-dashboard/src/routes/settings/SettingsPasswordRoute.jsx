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

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

export default function SettingsPasswordRoute() {
    const { updatePassword } = useAuth();
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
    const [phase, setPhase] = useState('idle'); // 'idle' | 'success'
    const [error, setError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

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
        </div>
    );
}
