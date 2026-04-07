/**
 * Maestro Dashboard — InviteRoute (placeholder)
 *
 * Az `/invite?token=` route. Fázis 1 / B.4-ben kapja meg a tényleges
 * meghívó token validáció + AuthContext.acceptInvite() hívást.
 */

import React from 'react';

export default function InviteRoute() {
    return (
        <div className="login-card">
            <div className="form-heading">Meghívó elfogadása</div>
            <p style={{ color: 'var(--text-secondary, #999)' }}>
                Hamarosan elérhető (Fázis 1 / B.4).
            </p>
        </div>
    );
}
