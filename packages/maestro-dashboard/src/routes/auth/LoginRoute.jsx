/**
 * Maestro Dashboard — LoginRoute
 *
 * A `/login` route. A meglévő components/LoginView.jsx form-tartalmából
 * kiemelve, a brand részt az AuthSplitLayout adja.
 *
 * Sikeres bejelentkezés után a useAuth setUser-je triggereli a ProtectedRoute
 * redirectet — ezt React Router automatikusan kezeli, mert a /login route
 * publikus, és a / route már védett.
 *
 * v2 (C.2.6.login, 2026-05-06):
 *   - LABELS objektum (Copy-hygiene, design-system.md `Copy-hygiene` szekció)
 *   - Eye-toggle a jelszó inputon (inline SVG, NEM ikon-könyvtár — Codex 8. pont)
 *   - Auth-tabs megőrzött a többi auth-route konzisztenciájáért (Codex 5. pont scope-cut)
 */

import React, { useState } from 'react';
import { useNavigate, useLocation, NavLink, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
// 2026-05-08 (UX feedback): a PendingInviteBanner csak a /register-en marad
// (ott actionable: „add meg a meghívás e-mail-címét"). A /login-on a user már
// regisztrált, a banner nem ad új információt, csak ismétli magát a verifikáció
// után — ezért szándékosan nem importáljuk be ide.

const LABELS = {
    tabLogin: 'Bejelentkezés',
    tabRegister: 'Regisztráció',
    verifiedNotice: 'E-mail megerősítve. Most már bejelentkezhetsz.',
    resetNotice: 'Jelszavad sikeresen módosítva. Jelentkezz be az új jelszóval.',
    emailLabel: 'E-mail cím',
    emailPlaceholder: 'pelda@email.com',
    passwordLabel: 'Jelszó',
    passwordPlaceholder: '••••••••',
    showPassword: 'Jelszó megjelenítése',
    hidePassword: 'Jelszó elrejtése',
    forgotLink: 'Elfelejtett jelszó?',
    submitIdle: 'Belépés',
    submitBusy: 'Belépés...',
    errorInvalidCredentials: 'Hibás e-mail vagy jelszó.',
    // 2026-05-09 (E2E user feedback): Chrome néha a felhasználó nevét húzza
    // be az email mezőbe (autofill cache mismatch). Ha az input nem
    // email-szerű, visszajelzést adunk a Belépés előtt, hogy a user
    // észrevegye a hibát mielőtt 401-et kap a szervertől.
    errorEmailFormat: 'Az e-mail-cím @-jelet kell tartalmazzon. (Tipp: a Chrome néha a nevedet húzza be ide automatikusan — írd át a teljes e-mail-címedre.)',
    errorUnverified: 'Hibás bejelentkezési adatok vagy megerősítetlen fiók.',
    errorActiveSession: 'Már van aktív bejelentkezés. Frissítsd az oldalt.',
    errorGeneric: 'Bejelentkezési hiba. Próbáld újra később.',
};

// Egyszerű email-format-check (NEM teljes RFC, csak alap heuristic).
// Tartalmaz @-et, és előtte/utána van legalább 1 karakter, valamint a
// utána van pont. A részletes validáció a szervernél történik.
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginRoute() {
    const { login } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const verifiedFlag = searchParams.get('verified');
    const resetFlag = searchParams.get('reset');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    async function handleSubmit(e) {
        e.preventDefault();
        setError('');

        // 2026-05-09 (E2E user feedback) — előzetes email-formátum check.
        // Chrome autofill néha a nevet húzza be az email mezőbe; egy
        // korai client-side hint a usernek tisztább, mint egy szerver-401.
        const trimmedEmail = email.trim();
        if (!EMAIL_LIKE.test(trimmedEmail)) {
            setError(LABELS.errorEmailFormat);
            return;
        }

        setIsSubmitting(true);

        try {
            await login(trimmedEmail, password);
            // Bejelentkezés után visszanavigálunk az eredeti deep link-re
            // (pathname + search + hash mind megőrződik), vagy a `/`-ra ha
            // nem onnan jött a user.
            //
            // A ProtectedRoute a teljes Location objektumot ad át a
            // `state.from`-ban (useLocation() eredménye). A React Router
            // `navigate()` ugyan elfogadja a Location-t is, de a biztonság
            // kedvéért explicit stringgé normalizáljuk a pathname+search+hash
            // összefűzésével — így a `/invite?token=...` query string és a
            // hash fragmentek is megőrződnek, a Location.state pedig nem
            // szivárog tovább véletlenül az új route state-jébe.
            const from = location.state?.from;
            let redirectTo = '/';
            if (typeof from === 'string' && from) {
                redirectTo = from;
            } else if (from && typeof from === 'object') {
                redirectTo = `${from.pathname || '/'}${from.search || ''}${from.hash || ''}`;
            }
            navigate(redirectTo, { replace: true });
        } catch (err) {
            const msg = err?.message || '';
            const lower = msg.toLowerCase();
            if (msg.includes('Invalid credentials') || msg.includes('Invalid email')) {
                setError(LABELS.errorInvalidCredentials);
            } else if (msg.includes('not been verified')) {
                setError(LABELS.errorUnverified);
            } else if (lower.includes('session') && lower.includes('active')) {
                setError(LABELS.errorActiveSession);
            } else {
                setError(LABELS.errorGeneric);
            }
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <div className="login-card">
            <div className="auth-tabs">
                <NavLink to="/login" className={({ isActive }) => `auth-tab ${isActive ? 'active' : ''}`}>
                    {LABELS.tabLogin}
                </NavLink>
                <NavLink to="/register" className={({ isActive }) => `auth-tab ${isActive ? 'active' : ''}`}>
                    {LABELS.tabRegister}
                </NavLink>
            </div>
            {verifiedFlag === '1' && (
                <div className="auth-success">{LABELS.verifiedNotice}</div>
            )}
            {resetFlag === '1' && (
                <div className="auth-success">{LABELS.resetNotice}</div>
            )}
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label htmlFor="email">{LABELS.emailLabel}</label>
                    <input
                        type="email"
                        id="email"
                        placeholder={LABELS.emailPlaceholder}
                        autoComplete="email"
                        required
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="password">{LABELS.passwordLabel}</label>
                    <div className="form-input-with-toggle">
                        <input
                            type={showPassword ? 'text' : 'password'}
                            id="password"
                            placeholder={LABELS.passwordPlaceholder}
                            autoComplete="current-password"
                            required
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                        />
                        <button
                            type="button"
                            className="form-input-toggle"
                            onClick={() => setShowPassword(s => !s)}
                            aria-label={showPassword ? LABELS.hidePassword : LABELS.showPassword}
                            aria-pressed={showPassword}
                        >
                            <PasswordToggleIcon visible={showPassword} />
                        </button>
                    </div>
                </div>
                <div className="form-row-end">
                    <Link to="/forgot-password" className="auth-link">{LABELS.forgotLink}</Link>
                </div>
                <button type="submit" className="login-btn" disabled={isSubmitting}>
                    {isSubmitting ? LABELS.submitBusy : LABELS.submitIdle}
                </button>
                {error && <div className="login-error">{error}</div>}
            </form>
        </div>
    );
}

/**
 * Egyszerű, könyvtár-független ikon a jelszó láthatósághoz.
 * Codex 8. pont overengineering watch: NEM hozunk be új ikon-könyvtárat,
 * az `IconButton` standardizálás (design-system.md TODO) sem ennek a
 * commitnak a hatóköre — csak ezt a két ikon-állapotot inline-oljuk.
 */
function PasswordToggleIcon({ visible }) {
    if (visible) {
        // "Slashed eye" — a jelszó látható, kattintásra elrejti
        return (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 3l18 18" />
                <path d="M10.6 6.13A10.94 10.94 0 0112 6c5 0 9.27 3.11 11 7.5a11.78 11.78 0 01-3.07 4.32" />
                <path d="M6.71 6.71C4.7 8.06 3.13 10.05 2 12.5 3.73 16.89 8 20 13 20a10.94 10.94 0 003.86-.7" />
                <path d="M9.88 9.88a3 3 0 104.24 4.24" />
            </svg>
        );
    }
    // "Open eye" — a jelszó rejtett, kattintásra megjeleníti
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12.5C3.73 8.11 8 5 13 5s9.27 3.11 11 7.5C22.27 16.89 18 20 13 20S3.73 16.89 2 12.5z" />
            <circle cx="13" cy="12.5" r="3" />
        </svg>
    );
}
