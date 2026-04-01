/**
 * Maestro Dashboard — Bejelentkezés nézet
 */

import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function LoginView() {
    const { login } = useAuth();
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
        <div className="login-container">
            <div className="login-card">
                <h1>Maestro</h1>
                <p className="subtitle">Bejelentkezés a műhely-nyomkövetőbe</p>
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="email">Email</label>
                        <input
                            type="email"
                            id="email"
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
        </div>
    );
}
