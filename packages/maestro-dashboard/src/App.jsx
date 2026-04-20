/**
 * Maestro Dashboard — Gyökér komponens + Router konfiguráció
 *
 * `createBrowserRouter` (data router) szükséges a `useBlocker` hook
 * működéséhez (SettingsPasswordRoute, WorkflowDesignerPage).
 *
 * A route struktúra:
 * - Public auth route-ok (login, register, verify, stb.) — AuthSplitLayout
 * - Protected route-ok — ProtectedRoute gate
 *   - Settings route-ok — AuthSplitLayout
 *   - Dashboard — DashboardLayout + child route-ok (table/layout)
 *   - Workflow Designer — külön full-screen layout
 * - Fallback → /login
 */

import React from 'react';
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
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
import DashboardLayout from './routes/dashboard/DashboardLayout.jsx';
import TableViewRoute from './routes/dashboard/TableViewRoute.jsx';
import LayoutViewRoute from './routes/dashboard/LayoutViewRoute.jsx';
import WorkflowDesignerPage from './features/workflowDesigner/WorkflowDesignerPage.jsx';
import WorkflowDesignerRedirect, { LegacyWorkflowRedirect } from './features/workflowDesigner/WorkflowDesignerRedirect.jsx';
import WorkflowNewRoute from './features/workflowDesigner/WorkflowNewRoute.jsx';
import { ModalProvider } from './contexts/ModalContext.jsx';

/**
 * A védett dashboard ágon DataProvider + ToastProvider + ModalProvider szükséges.
 */
function DashboardLayoutWithProviders() {
    return (
        <ToastProvider>
            <DataProvider>
                <ModalProvider>
                    <DashboardLayout />
                </ModalProvider>
            </DataProvider>
        </ToastProvider>
    );
}

/**
 * A Workflow Designer-hez szintén szükséges a DataProvider (workflow fetch)
 * és ToastProvider (toast értesítések). A gyermek komponens route-függő:
 * az új `/workflows/:workflowId` a `WorkflowDesignerPage`-t tölti a konkrét
 * doc-hoz; a `/workflows/new` a `WorkflowNewRoute`-on át nyitja a
 * CreateWorkflowModal-t. A legacy URL redirectek (WorkflowDesignerRedirect,
 * LegacyWorkflowRedirect) NEM szerepelnek itt — azok DataProvider nélkül
 * futnak (közvetlen Appwrite query / paraméter-továbbítás).
 */
function WorkflowDesignerWithProviders({ children }) {
    return (
        <ToastProvider>
            <DataProvider>
                <ModalProvider>
                    {children}
                </ModalProvider>
            </DataProvider>
        </ToastProvider>
    );
}

/**
 * Gyökér layout — AuthProvider + ScopeProvider wrappeli az egész alkalmazást.
 */
function RootLayout() {
    return (
        <AuthProvider>
            <ScopeProvider>
                <Outlet />
            </ScopeProvider>
        </AuthProvider>
    );
}

export const router = createBrowserRouter([
    {
        element: <RootLayout />,
        children: [
            // Public auth routes
            {
                element: <AuthSplitLayout />,
                children: [
                    { path: '/login', element: <LoginRoute /> },
                    { path: '/register', element: <RegisterRoute /> },
                    { path: '/verify', element: <VerifyRoute /> },
                    { path: '/forgot-password', element: <ForgotPasswordRoute /> },
                    { path: '/reset-password', element: <ResetPasswordRoute /> },
                    /*
                     * Az /invite route szándékosan publikus: a B.4-es InviteRoute
                     * mindkét ágat kezeli — bejelentkezett user esetén acceptInvite()
                     * + redirect /, anonymous user esetén token mentés localStorage-ba
                     * + redirect /register?invite=... Ha ProtectedRoute mögé tennénk,
                     * az új user nem tudna a meghívó link mentén regisztrálni.
                     */
                    { path: '/invite', element: <InviteRoute /> }
                ]
            },

            // Protected routes — auth gate
            {
                element: <ProtectedRoute />,
                children: [
                    // Védett auth-szerű route-ok (onboarding, settings)
                    {
                        element: <AuthSplitLayout />,
                        children: [
                            { path: '/onboarding', element: <OnboardingRoute /> },
                            { path: '/settings/password', element: <SettingsPasswordRoute /> },
                            { path: '/settings/groups', element: <GroupsRoute /> }
                        ]
                    },

                    // Tényleges dashboard — child route-okkal (table/layout)
                    {
                        path: '/',
                        element: <DashboardLayoutWithProviders />,
                        children: [
                            { index: true, element: <TableViewRoute /> },
                            { path: 'layout', element: <LayoutViewRoute /> }
                        ]
                    },

                    // Workflow Designer — új route: konkrét workflow szerkesztése
                    {
                        path: '/workflows/:workflowId',
                        element: (
                            <WorkflowDesignerWithProviders>
                                <WorkflowDesignerPage />
                            </WorkflowDesignerWithProviders>
                        )
                    },
                    // Workflow Designer — új workflow belépési pont (CreateWorkflowModal)
                    {
                        path: '/workflows/new',
                        element: (
                            <WorkflowDesignerWithProviders>
                                <WorkflowNewRoute />
                            </WorkflowDesignerWithProviders>
                        )
                    },
                    // Legacy URL-ek — redirect az új `/workflows/:id`-re.
                    // Egyik sem igényli a DataProvider-t: a listázó közvetlen
                    // Appwrite query-vel dolgozik az URL office-ára, a másik
                    // csak a paramétert továbbítja.
                    {
                        path: '/admin/office/:officeId/workflow',
                        element: <WorkflowDesignerRedirect />
                    },
                    {
                        path: '/admin/office/:officeId/workflow/:workflowId',
                        element: <LegacyWorkflowRedirect />
                    }
                ]
            },

            // Fallback
            { path: '*', element: <Navigate to="/login" replace /> }
        ]
    }
]);
