/**
 * Maestro Dashboard — InviteRoute (B.4 placeholder finomítás)
 *
 * Az `/invite?token=` route. B.4-ben csak a token tárolás kerül be:
 * - Anonymous user → token mentés localStorage-ba + redirect /register.
 *   A regisztráció után az onboarding flow felismeri a tárolt tokent.
 * - Bejelentkezett user → token mentés + redirect /onboarding. Az
 *   acceptInvite() valódi flow-ját a B.5 implementálja, miután az
 *   `organization-membership-guard` Cloud Function felkerült (a guard
 *   nélkül a kliens nem tudná létrehozni az `organizationMemberships`
 *   rekordot saját magának).
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
        // Token mentése (a B.5-ös acceptInvite() ezt fogja olvasni)
        try { localStorage.setItem(STORAGE_KEY, token); } catch { /* nem baj */ }

        if (user) {
            // Bejelentkezett user → onboarding (B.5 itt fogja elfogadni a meghívót)
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
