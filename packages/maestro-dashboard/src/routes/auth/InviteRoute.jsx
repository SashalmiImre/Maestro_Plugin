/**
 * Maestro Dashboard — InviteRoute (B.5 — token tárolás, accept az OnboardingRoute-on)
 *
 * Az `/invite?token=` route. Csak a token tárolás történik itt:
 * - Anonymous user → token mentés localStorage-ba + redirect /register.
 *   A regisztráció után az onboarding flow felismeri a tárolt tokent.
 * - Bejelentkezett user → token mentés + redirect /onboarding.
 *
 * A meghívó tényleges elfogadása az `OnboardingRoute`-ban történik:
 * az ottani UI észleli a localStorage-beli pending tokent és felajánlja
 * az `AuthContext.acceptInvite()` (→ `invite-to-organization` CF, accept ág)
 * meghívását. A kliens szándékosan nem hozza létre közvetlenül az
 * `organizationMemberships` rekordot — a tenant collection-ök ACL-je
 * `read("users")` only, az írás csak az API key-t használó CF-en keresztül
 * történhet.
 *
 * A route szándékosan publikus (az App.jsx-ben az AuthSplitLayout alatt
 * van, nem a ProtectedRoute alatt) — különben az új user nem tudná a
 * meghívó link mentén regisztrálni.
 */

import React, { useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

const STORAGE_KEY = 'maestro.pendingInviteToken';

export default function InviteRoute() {
    const { user, loading } = useAuth();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const token = searchParams.get('token');

    useEffect(() => {
        if (loading) return;
        if (!token) {
            navigate('/login', { replace: true });
            return;
        }
        // Token mentése — az OnboardingRoute acceptInvite() ágja olvassa
        try { localStorage.setItem(STORAGE_KEY, token); } catch { /* nem baj */ }

        if (user) {
            // Bejelentkezett user → onboarding (ott történik az acceptInvite())
            navigate('/onboarding', { replace: true });
        } else {
            // Anonymous → register (a regisztráció után automatikusan megy az onboarding-ra)
            navigate('/register', { replace: true });
        }
    }, [token, user, loading, navigate]);

    return (
        <div className="login-card">
            <div className="form-heading">Meghívó feldolgozása</div>
            <div className="auth-info">Egy pillanat...</div>
        </div>
    );
}
