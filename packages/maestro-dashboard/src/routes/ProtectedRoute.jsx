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

    // [[ADR 0013]] M1 stop-time fix — közös aux-route lista. Két helyen
    // használjuk: (a) az üres-orgList → /onboarding redirect alól mentes,
    // hogy a `/settings/account`-ról az utolsó org elhagyása után a user a
    // sikerüzenet elolvashassa, ne kerüljön azonnal /onboarding-ra; (b) a
    // frozen-org gate is ugyanezt a listát kérdezi le.
    const isAuxRoute = location.pathname.startsWith('/onboarding') ||
                       location.pathname.startsWith('/settings/password') ||
                       location.pathname.startsWith('/settings/account');

    // Sikeres fetch + tényleg üres → onboarding. Az /invite route az App.jsx
    // szerint publikus (AuthSplitLayout alatt), így sosem éri el ezt a guardot
    // — kizárólag az /onboarding-ot kell kivételként kezelni, hogy ne dobja
    // önmagára vissza a usert egy redirect ciklusban.
    const orgList = organizations || [];
    if (orgList.length === 0 && !isAuxRoute) {
        return <Navigate to="/onboarding" replace />;
    }

    // D.2.3 (2026-05-09) — frozen-tenant block view. A backend a `status` enum
    // két értékét write-blockolja: `orphaned` (utolsó owner törölte magát) és
    // `archived` (admin manuális). Mindkettőre a `userHasOrgPermission()`
    // orphan-guard 403-mal ad vissza minden `org.*` write-et, ezért UI-szinten
    // is egy speciális blokkoló view jelenik meg a "minden gomb 403"-os zavar
    // megelőzéséhez.
    //
    // Aux route-ok (átengedjük a blockerből):
    //   - `/onboarding` — új org létrehozása (recovery út, ha a user másik
    //     orgban admin)
    //   - `/settings/password` — saját jelszó-csere (self-mgmt, NEM org-szintű)
    //   - `/settings/account` ([[ADR 0013]] M3 fix) — self-service profile-screen
    //     (per-org leave + fiók-törlés). Ha az árva-org user-t blokkolnánk,
    //     nem jutna recovery-screen-hez.
    // Minden más settings (`/settings/groups` / `/settings/organization` /
    // `/settings/editorial-office`) blokkolt — ezek tenant-write-műveletek,
    // amiket a backend úgyis 403-mal eldob.
    //
    // TODO(D-blokk follow-up — shared `orgStatus` modul): az `isFrozen`
    // OR-chain duplikálja a backend `isOrgWriteBlocked()`-et. Egy shared
    // `packages/maestro-shared/orgStatus.js` modul után ide is `isOrgWriteBlocked(activeOrg?.status)`
    // hívást kell tenni, single-source-of-truth-tal.
    const activeOrg = orgList.find((o) => o.$id === activeOrganizationId);
    const isFrozen = activeOrg?.status === 'orphaned' || activeOrg?.status === 'archived';
    if (isFrozen && !isAuxRoute) {
        return <OrganizationOrphanedView />;
    }

    return <Outlet />;
}
