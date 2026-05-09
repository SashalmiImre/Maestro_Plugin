/**
 * Maestro Dashboard — ProtectedRoute
 *
 * Auth gate:
 * - Loading állapotban spinner overlay.
 * - Ha nincs bejelentkezett user → /login redirect.
 * - Ha a memberships fetch HIBÁRA futott (membershipsError) → retry képernyő.
 *   NEM redirektelünk onboarding-ra, mert az adversarial review #1 szerint
 *   egy átmeneti backend hiba nem zárhat ki egy meglévő tenantot a dashboardból.
 * - Ha be van jelentkezve, sikeresen betöltöttük a tagságait, de tényleg
 *   üres → /onboarding redirect (kivéve, ha már a /onboarding route-on
 *   vagyunk — különben végtelen redirect ciklus). Az /invite publikus
 *   route, sosem éri el ezt a guardot.
 */

import React, { useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useScope } from '../contexts/ScopeContext.jsx';
import BrandHero from './auth/BrandHero.jsx';
import OrganizationOrphanedView from './OrganizationOrphanedView.jsx';

export default function ProtectedRoute() {
    const {
        user,
        loading,
        organizations,
        membershipsError,
        reloadMemberships,
        logout
    } = useAuth();
    const { activeOrganizationId } = useScope();
    const location = useLocation();
    const navigate = useNavigate();
    const [isRetrying, setIsRetrying] = useState(false);

    async function handleRetry() {
        setIsRetrying(true);
        try {
            await reloadMemberships();
        } finally {
            setIsRetrying(false);
        }
    }

    async function handleLogout() {
        await logout();
        navigate('/login', { replace: true });
    }

    if (loading) {
        return (
            <div className="loading-overlay">
                <div className="spinner" />
                <span>Betöltés...</span>
            </div>
        );
    }

    if (!user) {
        return <Navigate to="/login" replace state={{ from: location }} />;
    }

    // Memberships fetch hiba — retry képernyő. NEM redirect onboarding-ra,
    // mert üres organizations lehet egy átmeneti hiba is, és a placeholder
    // onboarding kizárná a meglévő tenantot a dashboardból.
    //
    // A login/register/invite oldalakkal azonos `AuthSplitLayout` kerettel
    // (BrandHero + glassmorphism kártya) jelenítjük meg, hogy a felhasználó
    // ne egy csupasz kártyát lásson a semmi közepén.
    if (membershipsError) {
        return (
            <div className="login-container">
                <BrandHero />
                <div className="login-card auth-error-card">
                    <div className="form-heading">Hiba a tagságok betöltésekor</div>
                    <p className="auth-help">
                        Nem sikerült lekérni a szervezeted adatait. Ez lehet átmeneti hálózati
                        vagy szerveroldali hiba — próbáld újra. Ha tartósan fennáll, jelentkezz
                        ki és próbálj újra belépni.
                    </p>
                    <button
                        type="button"
                        className="login-btn"
                        onClick={handleRetry}
                        disabled={isRetrying}
                    >
                        {isRetrying ? 'Újrapróbálkozás...' : 'Újra'}
                    </button>
                    <div className="auth-bottom-link">
                        <button
                            type="button"
                            className="auth-link auth-link-button"
                            onClick={handleLogout}
                        >
                            Kijelentkezés
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // Sikeres fetch + tényleg üres → onboarding. Az /invite route az App.jsx
    // szerint publikus (AuthSplitLayout alatt), így sosem éri el ezt a guardot
    // — kizárólag az /onboarding-ot kell kivételként kezelni, hogy ne dobja
    // önmagára vissza a usert egy redirect ciklusban.
    if (organizations.length === 0 && location.pathname !== '/onboarding') {
        return <Navigate to="/onboarding" replace />;
    }

    // D.2.3 (2026-05-09) — orphan org block view. Codex Q3 review: az org
    // látható marad a `organizations` listán (NEM filterelünk az
    // AuthContext-en), de az aktív org `status === 'orphaned'` esetén a
    // dashboard helyett egy speciális blokkoló view jelenik meg. A user
    // másik orgra válthat (ha van) vagy kijelentkezhet. A backend
    // `userHasOrgPermission()` orphan-guard úgyis 403-mal ad vissza minden
    // `org.*` write-műveletet, de a UI-szintű tisztázás megelőzi a "minden
    // gomb 403"-os UX-zavart. Az `/onboarding` és `/settings/*` route-okat
    // engedjük át, hogy az "új szervezet létrehozása" út továbbra is járható
    // legyen — egy másik orgban a user lehet aktív.
    const activeOrg = (organizations || []).find((o) => o.$id === activeOrganizationId);
    const isOrphan = activeOrg?.status === 'orphaned';
    const isAuxRoute = location.pathname.startsWith('/onboarding') ||
                       location.pathname.startsWith('/settings');
    if (isOrphan && !isAuxRoute) {
        return <OrganizationOrphanedView />;
    }

    return <Outlet />;
}
