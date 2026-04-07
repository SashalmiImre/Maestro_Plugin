/**
 * Maestro Dashboard — RegisterRoute
 *
 * A `/register` route. Új fiók létrehozása + verifikációs e-mail kiküldése.
 *
 * Lépések:
 * 1. Form validáció (jelszó hossz, egyezés)
 * 2. AuthContext.register() — fiók + verifikációs e-mail
 * 3. Success állapot — „Ellenőrizd az e-mailedet" képernyő
 *
 * A tab navigáció (Bejelentkezés / Regisztráció) ugyanaz a struktúra,
 * mint a LoginRoute-on, hogy az átkapcsolás konzisztens legyen.
 *
 * Adversarial review #2 fix — partial success branch:
 * Ha a register() `verification_send_failed` kódú hibát dob, az azt jelenti,
 * hogy a fiók már létrejött, de a verifikációs e-mail küldése elszállt.
 * Ilyenkor egy „partial success" képernyőt mutatunk, ahonnan a user a
 * resendVerification() segítségével újra megpróbálhatja a verifikációt.
 * A user nem reked az „account already exists" zsákutcában.
 */

import React, { useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

export default function RegisterRoute() {
    const { register, resendVerification } = useAuth();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [passwordConfirm, setPasswordConfirm] = useState('');
    const [error, setError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    // 'idle' | 'success' (verification e-mail elment) |
    // 'verification_failed' (fiók létrejött, de e-mail elszállt)
    const [phase, setPhase] = useState('idle');
    const [isResending, setIsResending] = useState(false);
    const [resendNotice, setResendNotice] = useState('');

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
            await register(name.trim(), email.trim(), password);
            setPhase('success');
        } catch (err) {
            // Speciális branch: a fiók már létrejött, csak a verifikációs
            // e-mail küldés szállt el. A user resendVerification-nel tudja
            // újrapróbálni — a password state-et SZÁNDÉKOSAN megőrizzük,
            // mert a resendVerification ideiglenes session-höz használja.
            if (err?.code === 'verification_send_failed') {
                setPhase('verification_failed');
                return;
            }
            // Normál hiba ág — a password state minimalizálása érdekében
            // ürítjük a jelszó mezőket. A user a hiba elolvasása után
            // úgyis újra beírja, ha újra próbálkozik.
            setPassword('');
            setPasswordConfirm('');
            const msg = err?.message || '';
            if (msg.includes('user with the same email')) {
                setError('Ez az e-mail cím már regisztrált. Próbálj bejelentkezni vagy használd az „Elfelejtett jelszó" linket.');
            } else if (msg.includes('Invalid `email`')) {
                setError('Érvénytelen e-mail cím.');
            } else if (msg.toLowerCase().includes('password')) {
                setError('Érvénytelen jelszó (min. 8 karakter).');
            } else {
                setError('Regisztrációs hiba. Próbáld újra később.');
            }
        } finally {
            setIsSubmitting(false);
        }
    }

    /**
     * A „verification_failed" branch-ből hívott újraküldési akció.
     * Az e-mail és jelszó még a form state-ben él (nem ürítettük), így a
     * resendVerification ezeket használja a session-höz.
     */
    async function handleResendVerification() {
        setResendNotice('');
        setError('');
        setIsResending(true);
        try {
            await resendVerification(email.trim(), password);
            setPhase('success');
        } catch (err) {
            const msg = err?.message || '';
            if (msg.toLowerCase().includes('rate')) {
                setResendNotice('Túl sok kérés. Próbáld újra néhány perc múlva.');
            } else if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('failed to fetch')) {
                setResendNotice('Hálózati hiba. Próbáld újra.');
            } else {
                setResendNotice('Nem sikerült újraküldeni a verifikációs e-mailt. Próbáld újra később.');
            }
        } finally {
            setIsResending(false);
        }
    }

    if (phase === 'success') {
        return (
            <div className="login-card">
                <div className="auth-tabs">
                    <NavLink to="/login" className="auth-tab">Bejelentkezés</NavLink>
                    <NavLink to="/register" className="auth-tab active">Regisztráció</NavLink>
                </div>
                <div className="auth-success-large">
                    <h2>Ellenőrizd az e-mailedet</h2>
                    <p>Küldtünk egy megerősítő linket a <strong>{email}</strong> címre. Kattints a linkre a fiók aktiválásához.</p>
                    <p className="auth-help">A link 1 órán át érvényes. Ha nem érkezett meg, ellenőrizd a spam mappát.</p>
                </div>
                <div className="auth-bottom-link">
                    <Link to="/login">Vissza a bejelentkezéshez</Link>
                </div>
            </div>
        );
    }

    if (phase === 'verification_failed') {
        return (
            <div className="login-card">
                <div className="auth-tabs">
                    <NavLink to="/login" className="auth-tab">Bejelentkezés</NavLink>
                    <NavLink to="/register" className="auth-tab active">Regisztráció</NavLink>
                </div>
                <div className="auth-success-large">
                    <h2>Fiók létrehozva</h2>
                    <p>
                        A <strong>{email}</strong> címmel regisztráltad a fiókod, de a
                        verifikációs e-mailt nem sikerült most kiküldeni.
                    </p>
                    <p className="auth-help">
                        Próbáld újra elküldeni a verifikációs linket. Ha tartósan nem
                        sikerül, vedd fel a kapcsolatot az adminisztrátorral.
                    </p>
                </div>
                <button
                    type="button"
                    className="login-btn"
                    onClick={handleResendVerification}
                    disabled={isResending}
                >
                    {isResending ? 'Küldés...' : 'Verifikációs e-mail újraküldése'}
                </button>
                {resendNotice && <div className="login-error">{resendNotice}</div>}
                <div className="auth-bottom-link">
                    <Link to="/login">Vissza a bejelentkezéshez</Link>
                </div>
            </div>
        );
    }

    return (
        <div className="login-card">
            <div className="auth-tabs">
                <NavLink to="/login" className="auth-tab">Bejelentkezés</NavLink>
                <NavLink to="/register" className="auth-tab active">Regisztráció</NavLink>
            </div>
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label htmlFor="reg-name">Név</label>
                    <input
                        id="reg-name"
                        type="text"
                        autoComplete="name"
                        required
                        value={name}
                        onChange={e => setName(e.target.value)}
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="reg-email">Email</label>
                    <input
                        id="reg-email"
                        type="email"
                        placeholder="pelda@email.com"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="reg-password">Jelszó (min. 8 karakter)</label>
                    <input
                        id="reg-password"
                        type="password"
                        autoComplete="new-password"
                        required
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="reg-password-confirm">Jelszó megerősítése</label>
                    <input
                        id="reg-password-confirm"
                        type="password"
                        autoComplete="new-password"
                        required
                        value={passwordConfirm}
                        onChange={e => setPasswordConfirm(e.target.value)}
                    />
                </div>
                <button type="submit" className="login-btn" disabled={isSubmitting}>
                    {isSubmitting ? 'Regisztráció...' : 'Regisztráció'}
                </button>
                {error && <div className="login-error">{error}</div>}
            </form>
        </div>
    );
}
