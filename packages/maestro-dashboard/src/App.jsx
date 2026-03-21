/**
 * Maestro Dashboard — Gyökér komponens
 *
 * Auth routing: LoginView ↔ DashboardView.
 */

import React from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import { ToastProvider } from './contexts/ToastContext.jsx';
import { DataProvider } from './contexts/DataContext.jsx';
import LoginView from './components/LoginView.jsx';
import DashboardView from './components/DashboardView.jsx';

function AppContent() {
    const { user, loading } = useAuth();

    if (loading) {
        return (
            <div className="loading-overlay">
                <div className="spinner" />
                <span>Betöltés...</span>
            </div>
        );
    }

    if (!user) {
        return <LoginView />;
    }

    return (
        <ToastProvider>
            <DataProvider>
                <DashboardView />
            </DataProvider>
        </ToastProvider>
    );
}

export default function App() {
    return (
        <AuthProvider>
            <AppContent />
        </AuthProvider>
    );
}
