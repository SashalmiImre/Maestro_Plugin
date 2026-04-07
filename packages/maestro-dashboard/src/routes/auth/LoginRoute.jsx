/**
 * Maestro Dashboard — LoginRoute
 *
 * A `/login` route. A meglévő components/LoginView.jsx form-tartalmából
 * kiemelve, a brand részt az AuthSplitLayout adja.
 *
 * Sikeres bejelentkezés után a useAuth setUser-je triggereli a ProtectedRoute
 * redirectet — ezt React Router automatikusan kezeli, mert a /login route
 * publikus, és a / route már védett.
 */

import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

export default function LoginRoute() {
    const { login } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    async function handleSubmit(e) {
        e.preventDefault();
        setError('');
        setIsSubmitting(true);

        try {
            await login(email.trim(), password);
            // Bejelentkezés után visszanavigálunk az eredeti deep link-re
            // (pathname + search + hash mind megőrződik), vagy a `/`-ra ha
            // nem onnan jött a user. A teljes location objektumot adjuk át
            // a navigate-nek, hogy pl. a `/invite?token=...` query string
            // ne vesszen el.
            const from = location.state?.from;
            navigate(from || '/', { replace: true });
        } catch (err) {
            const msg = err?.message || '';
            if (msg.includes('Invalid credentials') || msg.includes('Invalid email')) {
                setError('Hibás email vagy jelszó.');
            } else if (msg.includes('not been verified')) {
                setError('Hibás bejelentkezési adatok vagy megerősítetlen fiók.');
            } else if (msg.toLowerCase().includes('session') && msg.toLowerCase().includes('active')) {
                setError('Már van aktív bejelentkezés. Frissítsd az oldalt.');
            } else {
                setError('Bejelentkezési hiba. Próbáld újra később.');
            }
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <div className="login-card">
            <div className="form-heading">Bejelentkezés</div>
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label htmlFor="email">Email</label>
                    <input
                        type="email"
                        id="email"
                        placeholder="pelda@email.com"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="password">Jelszó</label>
                    <input
                        type="password"
                        id="password"
                        placeholder="••••••••"
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                    />
                </div>
                <button type="submit" className="login-btn" disabled={isSubmitting}>
                    {isSubmitting ? 'Bejelentkezés...' : 'Bejelentkezés'}
                </button>
                {error && <div className="login-error">{error}</div>}
            </form>
        </div>
    );
}
