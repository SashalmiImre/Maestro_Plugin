/**
 * Maestro Dashboard — ResetPasswordRoute
 *
 * A `/reset-password?userId=&secret=` route. Új jelszó form +
 * `confirmRecovery()` hívás. Sikeres jelszó frissítés után átirányít a
 * /login?reset=1 oldalra, ahol a LoginRoute success bannert mutat.
 *
 * Hiányos query paraméterek (userId vagy secret) esetén hibaüzenet +
 * link az /forgot-password oldalra.
 */

import React, { useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

export default function ResetPasswordRoute() {
    const { confirmRecovery } = useAuth();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const userId = searchParams.get('userId');
    const secret = searchParams.get('secret');
    const [password, setPassword] = useState('');
    const [passwordConfirm, setPasswordConfirm] = useState('');
    const [error, setError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    async function handleSubmit(e) {
        e.preventDefault();
        setError('');
        if (password.length < 8) {
            setError('A jelszónak legalább 8 karakter hosszúnak kell lennie.');
            return;
        }
        if (password !== passwordConfirm) {
            setError('A két jelszó nem egyezik.');
            return;
        }
        setIsSubmitting(true);
        try {
            await confirmRecovery(userId, secret, password);
            navigate('/login?reset=1', { replace: true });
        } catch (err) {
            const msg = err?.message || '';
            if (msg.includes('expired') || msg.includes('Invalid token')) {
                setError('A jelszó-visszaállító link érvénytelen vagy lejárt.');
            } else {
                setError('Hiba a jelszó frissítésénél. Próbáld újra.');
            }
        } finally {
            setIsSubmitting(false);
        }
    }

    if (!userId || !secret) {
        return (
            <div className="login-card">
                <div className="form-heading">Új jelszó beállítása</div>
                <div className="login-error">Hiányos jelszó-visszaállító link.</div>
                <div className="auth-bottom-link">
                    <Link to="/forgot-password">Új link kérése</Link>
                </div>
            </div>
        );
    }

    return (
        <div className="login-card">
            <div className="form-heading">Új jelszó beállítása</div>
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label htmlFor="reset-password">Új jelszó (min. 8 karakter)</label>
                    <input
                        id="reset-password"
                        type="password"
                        autoComplete="new-password"
                        required
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="reset-password-confirm">Jelszó megerősítése</label>
                    <input
                        id="reset-password-confirm"
                        type="password"
                        autoComplete="new-password"
                        required
                        value={passwordConfirm}
                        onChange={e => setPasswordConfirm(e.target.value)}
                    />
                </div>
                <button type="submit" className="login-btn" disabled={isSubmitting}>
                    {isSubmitting ? 'Mentés...' : 'Új jelszó beállítása'}
                </button>
                {error && <div className="login-error">{error}</div>}
            </form>
        </div>
    );
}
