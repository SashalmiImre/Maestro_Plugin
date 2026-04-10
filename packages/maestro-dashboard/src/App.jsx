/**
 * Maestro Dashboard — Gyökér komponens
 *
 * react-router-dom alapú routing. A public auth route-ok (login, register,
 * verify, forgot/reset password) az AuthSplitLayout-ot használják, a védett
 * route-okat ProtectedRoute védi.
 *
 * A „/" route a DashboardLayout-on keresztül rendereli a child view-kat
 * (táblázat: index, elrendezés: /layout). A /admin/office/:officeId/workflow
 * route a Workflow Designer-t nyitja meg.
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
import SettingsPasswordRoute from './routes/settings/SettingsPasswordRoute.jsx';
import GroupsRoute from './routes/settings/GroupsRoute.jsx';
import OrganizationAdminRoute from './routes/settings/OrganizationAdminRoute.jsx';
import EditorialOfficeAdminRoute from './routes/settings/EditorialOfficeAdminRoute.jsx';
import DashboardLayout from './routes/dashboard/DashboardLayout.jsx';
import TableViewRoute from './routes/dashboard/TableViewRoute.jsx';
import LayoutViewRoute from './routes/dashboard/LayoutViewRoute.jsx';
import WorkflowDesignerPage from './features/workflowDesigner/WorkflowDesignerPage.jsx';

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

/**
 * A Workflow Designer-hez szintén szükséges a DataProvider (workflow fetch)
 * és ToastProvider (toast értesítések).
 */
function WorkflowDesignerWithProviders() {
    return (
        <ToastProvider>
            <DataProvider>
                <WorkflowDesignerPage />
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
                        {/* Védett auth-szerű route-ok (onboarding, settings) */}
                        <Route element={<AuthSplitLayout />}>
                            <Route path="/onboarding" element={<OnboardingRoute />} />
                            <Route path="/settings/password" element={<SettingsPasswordRoute />} />
                            <Route path="/settings/groups" element={<GroupsRoute />} />
                            <Route path="/settings/organization" element={<OrganizationAdminRoute />} />
                            <Route path="/settings/editorial-office" element={<EditorialOfficeAdminRoute />} />
                        </Route>

                        {/* Tényleges dashboard — child route-okkal (table/layout) */}
                        <Route path="/" element={<DashboardLayoutWithProviders />}>
                            <Route index element={<TableViewRoute />} />
                            <Route path="layout" element={<LayoutViewRoute />} />
                        </Route>

                        {/* Workflow Designer */}
                        <Route
                            path="/admin/office/:officeId/workflow"
                            element={<WorkflowDesignerWithProviders />}
                        />
                    </Route>

                    {/* Fallback */}
                    <Route path="*" element={<Navigate to="/login" replace />} />
                </Routes>
            </ScopeProvider>
        </AuthProvider>
    );
}
