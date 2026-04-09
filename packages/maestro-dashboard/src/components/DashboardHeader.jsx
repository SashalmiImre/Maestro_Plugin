/**
 * Maestro Dashboard — Fejléc
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function DashboardHeader() {
    const { user, logout } = useAuth();

    return (
        <div className="dashboard-header">
            <h1>Maestro</h1>
            <div className="user-info">
                <span>{user?.name || user?.email}</span>
                <Link to="/settings/password" className="auth-link">Jelszó módosítása</Link>
                <button className="logout-btn" onClick={logout}>Kijelentkezés</button>
            </div>
        </div>
    );
}
