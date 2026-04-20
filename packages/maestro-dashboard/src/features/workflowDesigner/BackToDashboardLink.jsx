/**
 * Maestro Dashboard — "Vissza a kiadványokhoz" link a Workflow Designer
 * hibaoldalakhoz / scaffold-hez. A toolbar ikonos back-gombja (workflow-
 * designer-toolbar__back) külön UI — ott szándékosan más stílus.
 */

import React from 'react';
import { Link } from 'react-router-dom';

export default function BackToDashboardLink() {
    return (
        <Link to="/" className="auth-link" style={{ marginBottom: 16, display: 'inline-block' }}>
            ← Vissza a kiadványokhoz
        </Link>
    );
}
