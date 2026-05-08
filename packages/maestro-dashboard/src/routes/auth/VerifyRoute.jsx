/**
 * Maestro Dashboard — VerifyRoute
 *
 * A `/verify?userId=&secret=` route. Mount-kor azonnal triggereli az
 * `account.updateVerification(userId, secret)` hívást, és a callback
 * eredményétől függően mutat verifying / success / error állapotot.
 *
 * Sikeres megerősítés után 1.5 másodperccel a /login?verified=1 oldalra
 * navigál, ahol a LoginRoute success bannert mutat.
 *
 * StrictMode dupla mount védelem: ranRef biztosítja, hogy a verifyEmail()
 * csak egyszer fusson le (az Appwrite secret egyszer használható, dupla
 * hívás „expired" hibát adna).
 */

import React, { useEffect, useState, useRef } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

export default function VerifyRoute() {
    const { verifyEmail, resendVerification } = useAuth();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const userId = searchParams.get('userId');
    const secret = searchParams.get('secret');
    const [status, setStatus] = useState('verifying'); // verifying | success | error | resend_form | resend_success
    const [errorMsg, setErrorMsg] = useState('');
    // 2026-05-08: resend-verification mini-form. Az Appwrite secret 1 órán
    // át érvényes, és sokszor a Gmail link-preview bot elhasználja, mielőtt
    // a user rákattint. Az error ágról most direkt új linket lehet kérni
    // (email + password szükséges, mert a resendVerification ezzel állítja
    // be az ideiglenes session-t).
    const [resendEmail, setResendEmail] = useState('');
    const [resendPassword, setResendPassword] = useState('');
    const [resendError, setResendError] = useState('');
    const [resendBusy, setResendBusy] = useState(false);
    const ranRef = useRef(false);
    // A success → /login redirect timer azonosítója. A cleanup törli, hogy
    // ne fussanak árva navigációk az unmount után (pl. ha a user közben
    // máshová navigál a 1.5s alatt).
    const redirectTimerRef = useRef(null);

    useEffect(() => {
        // Közös cleanup minden ágra: ha van élő redirect timer, töröljük.
        const cleanup = () => {
            if (redirectTimerRef.current !== null) {
                clearTimeout(redirectTimerRef.current);
                redirectTimerRef.current = null;
            }
        };

        if (ranRef.current) return cleanup; // StrictMode dupla mount védelem
        ranRef.current = true;

        if (!userId || !secret) {
            setStatus('error');
            setErrorMsg('Hiányos verifikációs link.');
            return cleanup;
        }

        (async () => {
            try {
                await verifyEmail(userId, secret);
                setStatus('success');
                redirectTimerRef.current = setTimeout(() => {
                    redirectTimerRef.current = null;
                    navigate('/login?verified=1', { replace: true });
                }, 1500);
            } catch (err) {
                setStatus('error');
                const msg = err?.message || '';
                if (msg.includes('expired') || msg.includes('Invalid token')) {
                    setErrorMsg('A verifikációs link érvénytelen vagy lejárt.');
                } else {
                    setErrorMsg('Verifikációs hiba. Próbáld újra később.');
                }
            }
        })();

        return cleanup;
    }, [userId, secret, verifyEmail, navigate]);

    return (
        <div className="login-card">
            <div className="form-heading">E-mail megerősítés</div>
            {status === 'verifying' && <div className="auth-info">Megerősítés folyamatban...</div>}
            {status === 'success' && (
                <div className="auth-success-large">
                    <h2>Sikeres megerősítés</h2>
                    <p>Átirányítunk a bejelentkezéshez...</p>
                </div>
            )}
            {status === 'error' && (
                <>
                    <div className="login-error">{errorMsg}</div>
                    <p className="auth-help" style={{ marginTop: 12 }}>
                        Gyakori ok: az e-mail kliens (pl. Gmail) link-előnézete már
                        megnyitotta a linket, vagy a verifikáció óta több mint egy óra
                        telt el. Kérj új linket az alábbi mezőkkel:
                    </p>
                    <button
                        type="button"
                        className="login-btn"
                        onClick={() => setStatus('resend_form')}
                        style={{ marginTop: 8 }}
                    >
                        Új verifikációs e-mail kérése
                    </button>
                    <div className="auth-bottom-link">
                        <Link to="/login">Vissza a bejelentkezéshez</Link>
                    </div>
                </>
            )}
            {status === 'resend_form' && (
                <form
                    onSubmit={async (e) => {
                        e.preventDefault();
                        setResendError('');
                        setResendBusy(true);
                        try {
                            await resendVerification(resendEmail.trim(), resendPassword);
                            setStatus('resend_success');
                        } catch (err) {
                            const msg = err?.message || '';
                            if (msg.toLowerCase().includes('rate')) {
                                setResendError('Túl sok kérés. Próbáld újra néhány perc múlva.');
                            } else if (
                                msg.toLowerCase().includes('invalid') ||
                                msg.toLowerCase().includes('credentials')
                            ) {
                                setResendError('Hibás e-mail vagy jelszó.');
                            } else if (
                                msg.toLowerCase().includes('network') ||
                                msg.toLowerCase().includes('failed to fetch')
                            ) {
                                setResendError('Hálózati hiba. Próbáld újra.');
                            } else {
                                setResendError('Nem sikerült új verifikációs e-mailt küldeni. Próbáld újra később.');
                            }
                        } finally {
                            setResendBusy(false);
                        }
                    }}
                >
                    <div className="form-group">
                        <label htmlFor="resend-email">Email</label>
                        <input
                            id="resend-email"
                            type="email"
                            autoComplete="email"
                            required
                            value={resendEmail}
                            onChange={(e) => setResendEmail(e.target.value)}
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="resend-password">Jelszó</label>
                        <input
                            id="resend-password"
                            type="password"
                            autoComplete="current-password"
                            required
                            value={resendPassword}
                            onChange={(e) => setResendPassword(e.target.value)}
                        />
                    </div>
                    <button type="submit" className="login-btn" disabled={resendBusy}>
                        {resendBusy ? 'Küldés…' : 'Új link kérése'}
                    </button>
                    {resendError && <div className="login-error">{resendError}</div>}
                    <div className="auth-bottom-link">
                        <Link to="/login">Vissza a bejelentkezéshez</Link>
                    </div>
                </form>
            )}
            {status === 'resend_success' && (
                <div className="auth-success-large">
                    <h2>Új link elküldve</h2>
                    <p>
                        Új verifikációs linket küldtünk a <strong>{resendEmail}</strong>{' '}
                        címre. Ellenőrizd az Inbox-ot és a Spam mappát.
                    </p>
                    <p className="auth-help">
                        Tipp: amint megérkezik az új link, kattints rá <em>azonnal</em>,
                        mielőtt az e-mail kliens link-előnézete elhasználná.
                    </p>
                    <div className="auth-bottom-link">
                        <Link to="/login">Vissza a bejelentkezéshez</Link>
                    </div>
                </div>
            )}
        </div>
    );
}
