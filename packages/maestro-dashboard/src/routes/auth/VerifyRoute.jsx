/**
 * Maestro Dashboard — VerifyRoute (placeholder)
 *
 * A `/verify?userId=&secret=` route. Fázis 1 / B.4-ben kapja meg a tényleges
 * `account.updateVerification(userId, secret)` hívást.
 */

import React from 'react';

export default function VerifyRoute() {
    return (
        <div className="login-card">
            <div className="form-heading">E-mail megerősítés</div>
            <p style={{ color: 'var(--text-secondary, #999)' }}>
                Hamarosan elérhető (Fázis 1 / B.4).
            </p>
        </div>
    );
}
