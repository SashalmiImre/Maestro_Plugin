/**
 * Maestro Dashboard — ForgotPasswordRoute
 *
 * A `/forgot-password` route. E-mail input → AuthContext.requestRecovery()
 * → success állapot.
 *
 * Adversarial review #3 fix: csak az e-mail enumeráció elleni védelmet
 * indokló hibákat (`user_not_found`) maszkoljuk success-ként. Az operatív/
 * konfigurációs hibák (rate limit, invalid callback URL, 5xx, általános
 * Appwrite hiba) látható error állapotot kapnak, hogy a user retry-olhasson
 * és az ops/support is észlelje, ha valami tényleg eltört. Korábban minden
 * nem-hálózati hiba success-be konvertálódott, ami egy csendes outage-et
 * tudott elrejteni.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

export default function ForgotPasswordRoute() {
    const { requestRecovery } = useAuth();
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSuccess, setIsSuccess] = useState(false);

    async function handleSubmit(e) {
        e.preventDefault();
        setError('');
        setIsSubmitting(true);
        try {
            await requestRecovery(email.trim());
            setIsSuccess(true);
        } catch (err) {
            // Appwrite hibaformátum: { type, code, message }. A `type` adja a
            // strukturált azonosítót, a `code` a HTTP státuszt.
            const type = err?.type || '';
            const code = err?.code;
            const msg = err?.message || '';
            const lower = msg.toLowerCase();

            // Anti-enumeration: csak a „user_not_found" típust maszkoljuk.
            if (type === 'user_not_found') {
                setIsSuccess(true);
            } else if (type === 'general_rate_limit_exceeded' || code === 429) {
                setError('Túl sok kérés. Próbáld újra néhány perc múlva.');
            } else if (type === 'general_argument_invalid' || lower.includes('invalid `email`')) {
                setError('Érvénytelen e-mail cím.');
            } else if (lower.includes('network') || lower.includes('failed to fetch')) {
                setError('Hálózati hiba. Próbáld újra.');
            } else {
                // Operatív/konfigurációs hibák — surface-oljuk, hogy a user
                // retry-olhasson és az ops is észlelje az outage-et.
                console.warn('[ForgotPassword] requestRecovery sikertelen:', { type, code, message: msg });
                setError('A kérést nem sikerült feldolgozni. Próbáld újra később.');
            }
        } finally {
            setIsSubmitting(false);
        }
    }

    if (isSuccess) {
        return (
            <div className="login-card">
                <div className="form-heading">Elfelejtett jelszó</div>
                <div className="auth-success-large">
                    <h2>Ellenőrizd az e-mailedet</h2>
                    <p>Ha létezik fiók a megadott címmel, küldtünk egy jelszó-visszaállító linket a <strong>{email}</strong> címre.</p>
                </div>
                <div className="auth-bottom-link">
                    <Link to="/login">Vissza a bejelentkezéshez</Link>
                </div>
            </div>
        );
    }

    return (
        <div className="login-card">
            <div className="form-heading">Elfelejtett jelszó</div>
            <p className="auth-help">Add meg az e-mail címedet, és küldünk egy linket a jelszó visszaállításához.</p>
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label htmlFor="forgot-email">Email</label>
                    <input
                        id="forgot-email"
                        type="email"
                        placeholder="pelda@email.com"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                    />
                </div>
                <button type="submit" className="login-btn" disabled={isSubmitting}>
                    {isSubmitting ? 'Küldés...' : 'Visszaállító link küldése'}
                </button>
                {error && <div className="login-error">{error}</div>}
            </form>
            <div className="auth-bottom-link">
                <Link to="/login">Vissza a bejelentkezéshez</Link>
            </div>
        </div>
    );
}
