/**
 * @file ScopeMissingPlaceholder.jsx
 * @description Placeholder UI, amikor a Plugin nem tud aktív szerkesztőségi scope-ot választani.
 *
 * Variants: `loading` (spinner), `no-membership` (user nem tagja semelyik orgnak),
 * `no-office-in-org` (van org-tagság, de nincs office az aktív orgban — különben
 * infinite spinner lenne), `error` (memberships fetch hiba). A multi-org/office
 * switch UI Fázis 6-ban érkezik; most ez a minimum placeholder.
 */

import React from 'react';
import { Loading } from '../../common/Loading/Loading.jsx';
import { DASHBOARD_URL } from '../../../core/config/appwriteConfig.js';

const containerStyle = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '24px',
    textAlign: 'center'
};

const bodyStyle = { maxWidth: '320px', marginBottom: '16px' };
const urlStyle = { maxWidth: '320px', opacity: 0.7, marginBottom: '16px' };
const headingStyle = { marginBottom: '12px' };

const VARIANTS = {
    'no-membership': {
        heading: 'Még nincs aktív szerkesztőséged',
        body: 'Ahhoz, hogy a Maestro Plugint használni tudd, először a Dashboardon kell szervezetet létrehoznod vagy meghívót elfogadnod.',
        showUrl: true,
        retryVariant: 'secondary',
        retryLabel: 'Újraellenőrzés'
    },
    'no-office-in-org': {
        heading: 'Nincs elérhető szerkesztőség',
        body: 'A szervezetedben jelenleg nincs olyan szerkesztőség, amelynek tagja lennél. Kérd meg a szervezeti adminisztrátort, hogy rendeljen hozzá egy szerkesztőséghez a Dashboardon.',
        showUrl: true,
        retryVariant: 'secondary',
        retryLabel: 'Újraellenőrzés'
    },
    error: {
        heading: 'A szerkesztőség betöltése sikertelen',
        body: 'Nem sikerült lekérni a tagsági adataidat. Ellenőrizd a kapcsolatot, majd próbáld újra.',
        showUrl: false,
        retryVariant: 'primary',
        retryLabel: 'Újrapróbálás'
    }
};

/**
 * @param {{
 *   variant: 'loading'|'no-membership'|'no-office-in-org'|'error',
 *   onRetry?: () => void
 * }} props
 */
export const ScopeMissingPlaceholder = ({ variant = 'loading', onRetry }) => {
    if (variant === 'loading') {
        return <Loading message="Szerkesztőség betöltése..." showSpinner={true} />;
    }

    const config = VARIANTS[variant] || VARIANTS.error;

    return (
        <div style={containerStyle}>
            <sp-heading level="3" style={headingStyle}>
                {config.heading}
            </sp-heading>
            <sp-body size="s" style={bodyStyle}>
                {config.body}
            </sp-body>
            {config.showUrl && (
                <sp-detail style={urlStyle}>
                    {DASHBOARD_URL}
                </sp-detail>
            )}
            {onRetry && (
                <sp-button variant={config.retryVariant} onClick={onRetry}>
                    {config.retryLabel}
                </sp-button>
            )}
        </div>
    );
};
