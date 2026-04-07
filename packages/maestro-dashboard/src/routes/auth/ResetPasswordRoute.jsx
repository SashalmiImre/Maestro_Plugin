/**
 * Maestro Dashboard — ResetPasswordRoute (placeholder)
 *
 * A `/reset-password?userId=&secret=` route. Fázis 1 / B.4-ben kapja meg a
 * tényleges `account.updateRecovery(userId, secret, password)` hívást.
 */

import React from 'react';

export default function ResetPasswordRoute() {
    return (
        <div className="login-card">
            <div className="form-heading">Új jelszó beállítása</div>
            <p style={{ color: 'var(--text-secondary, #999)' }}>
                Hamarosan elérhető (Fázis 1 / B.4).
            </p>
        </div>
    );
}
