/**
 * Maestro Dashboard — ProtectedRoute
 *
 * Auth gate: ha nincs bejelentkezett user, /login redirect.
 * Loading állapotban spinner overlay.
 *
 * Megjegyzés: az `organizations.length === 0 → /onboarding` redirect
 * Fázis 1 / B.4-ben jön, a `fetchMemberships` helperrel együtt.
 */

import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function ProtectedRoute() {
    const { user, loading } = useAuth();
    const location = useLocation();

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

    return <Outlet />;
}
