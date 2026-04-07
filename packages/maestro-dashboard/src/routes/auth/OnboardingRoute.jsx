/**
 * Maestro Dashboard — OnboardingRoute (placeholder)
 *
 * Az `/onboarding` route. Az első belépéskor itt hoz létre a user új
 * organization-t és editorial office-t. Fázis 1 / B.4-ben kapja meg a tényleges
 * 4-collection write logikát (organizations, organizationMemberships,
 * editorialOffices, editorialOfficeMemberships).
 */

import React from 'react';

export default function OnboardingRoute() {
    return (
        <div className="login-card">
            <div className="form-heading">Üdv a Maestro-nál</div>
            <p style={{ color: 'var(--text-secondary, #999)' }}>
                Hamarosan elérhető (Fázis 1 / B.4).
            </p>
        </div>
    );
}
