/**
 * Maestro Dashboard — OnboardingRoute (B.4 placeholder finomítás)
 *
 * Az `/onboarding` route. Az első belépéskor itt hoz létre a user új
 * organization-t és editorial office-t. A tényleges 4-collection write
 * logikát (organizations, organizationMemberships, editorialOffices,
 * editorialOfficeMemberships) a Fázis 1 / B.5 lépés implementálja, miután
 * az `organization-membership-guard` Cloud Function felkerült.
 *
 * B.4-ben a placeholder mellé kerül egy „Kijelentkezés" gomb, hogy a
 * user ne ragadjon be a ProtectedRoute redirect miatt (membership nélkül
 * minden védett route ide vezetne).
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

export default function OnboardingRoute() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    async function handleLogout() {
        await logout();
        navigate('/login', { replace: true });
    }

    return (
        <div className="login-card">
            <div className="form-heading">Üdv a Maestro-nál, {user?.name}</div>
            <p className="auth-help">
                Még nincs szervezeted. Hamarosan itt hozhatsz létre egyet, vagy fogadhatsz el meghívót (Fázis 1 / B.5).
            </p>
            <button type="button" className="login-btn" onClick={handleLogout}>
                Kijelentkezés
            </button>
        </div>
    );
}
