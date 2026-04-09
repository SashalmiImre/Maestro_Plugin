/**
 * Maestro Dashboard — Fejléc
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useScope } from '../contexts/ScopeContext.jsx';

export default function DashboardHeader() {
    const { user, logout } = useAuth();
    const { activeEditorialOfficeId } = useScope();

    return (
        <div className="dashboard-header">
            <h1>Maestro</h1>
            <div className="user-info">
                <span>{user?.name || user?.email}</span>
                {activeEditorialOfficeId && (
                    <Link
                        to={`/admin/office/${activeEditorialOfficeId}/workflow`}
                        className="auth-link"
                    >
                        Workflow tervező
                    </Link>
                )}
                <Link to="/settings/organization" className="auth-link">Szervezet</Link>
                <Link to="/settings/groups" className="auth-link">Csoportok</Link>
                <Link to="/settings/password" className="auth-link">Jelszó módosítása</Link>
                <button className="logout-btn" onClick={logout}>Kijelentkezés</button>
            </div>
        </div>
    );
}
