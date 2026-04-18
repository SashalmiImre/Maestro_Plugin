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
    const { verifyEmail } = useAuth();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const userId = searchParams.get('userId');
    const secret = searchParams.get('secret');
    const [status, setStatus] = useState('verifying'); // verifying | success | error
    const [errorMsg, setErrorMsg] = useState('');
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
                    <div className="auth-bottom-link">
                        <Link to="/login">Vissza a bejelentkezéshez</Link>
                    </div>
                </>
            )}
        </div>
    );
}
