/**
 * Maestro Dashboard — Gyökér komponens
 *
 * react-router-dom alapú routing. A public auth route-ok (login, register,
 * verify, forgot/reset password) az AuthSplitLayout-ot használják, a védett
 * route-okat ProtectedRoute védi. A `/` route a DashboardLayout-on keresztül
 * rendereli a meglévő DashboardView-t.
 *
 * Fázis 1 / B.3 — router skeleton. A B.4 fogja megírni a tényleges
 * register/verify/forgot/reset/onboarding/invite implementációt.
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { ScopeProvider } from './contexts/ScopeContext.jsx';
import { ToastProvider } from './contexts/ToastContext.jsx';
import { DataProvider } from './contexts/DataContext.jsx';

import ProtectedRoute from './routes/ProtectedRoute.jsx';
import AuthSplitLayout from './routes/auth/AuthSplitLayout.jsx';
import LoginRoute from './routes/auth/LoginRoute.jsx';
import RegisterRoute from './routes/auth/RegisterRoute.jsx';
import VerifyRoute from './routes/auth/VerifyRoute.jsx';
import ForgotPasswordRoute from './routes/auth/ForgotPasswordRoute.jsx';
import ResetPasswordRoute from './routes/auth/ResetPasswordRoute.jsx';
import OnboardingRoute from './routes/auth/OnboardingRoute.jsx';
import InviteRoute from './routes/auth/InviteRoute.jsx';
import DashboardLayout from './routes/dashboard/DashboardLayout.jsx';

/**
 * A védett dashboard ágon DataProvider + ToastProvider szükséges. A v7
 * layout route element propjába tesszük, hogy ne wrapper-eljük a teljes
 * Routes fát az adat rétegbe (a publikus auth route-ok nem igényelnek adatot).
 */
function DashboardLayoutWithProviders() {
    return (
        <ToastProvider>
            <DataProvider>
                <DashboardLayout />
            </DataProvider>
        </ToastProvider>
    );
}

export default function App() {
    return (
        <AuthProvider>
            <ScopeProvider>
                <Routes>
                    {/* Public auth routes */}
                    <Route element={<AuthSplitLayout />}>
                        <Route path="/login" element={<LoginRoute />} />
                        <Route path="/register" element={<RegisterRoute />} />
                        <Route path="/verify" element={<VerifyRoute />} />
                        <Route path="/forgot-password" element={<ForgotPasswordRoute />} />
                        <Route path="/reset-password" element={<ResetPasswordRoute />} />
                        {/*
                         * Az /invite route szándékosan publikus: a B.4-es InviteRoute
                         * mindkét ágat kezeli — bejelentkezett user esetén acceptInvite()
                         * + redirect /, anonymous user esetén token mentés localStorage-ba
                         * + redirect /register?invite=... Ha ProtectedRoute mögé tennénk,
                         * az új user nem tudna a meghívó link mentén regisztrálni.
                         */}
                        <Route path="/invite" element={<InviteRoute />} />
                    </Route>

                    {/* Protected routes — auth gate */}
                    <Route element={<ProtectedRoute />}>
                        {/* Védett auth-szerű route-ok (onboarding) */}
                        <Route element={<AuthSplitLayout />}>
                            <Route path="/onboarding" element={<OnboardingRoute />} />
                        </Route>
                        {/* Tényleges dashboard */}
                        <Route path="/" element={<DashboardLayoutWithProviders />} />
                    </Route>

                    {/* Fallback */}
                    <Route path="*" element={<Navigate to="/login" replace />} />
                </Routes>
            </ScopeProvider>
        </AuthProvider>
    );
}
