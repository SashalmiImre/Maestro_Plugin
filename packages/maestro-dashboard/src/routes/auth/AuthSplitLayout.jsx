/**
 * Maestro Dashboard — AuthSplitLayout
 *
 * Bal hero (BrandHero) + jobb glassmorphism kártya layout-wrapper.
 * A child route komponens (Outlet) tartalmazza a kártyát.
 *
 * A meglévő `.login-container` / `.login-brand` / `.login-card` CSS class-okat
 * használja a `packages/maestro-dashboard/css/styles.css`-ben.
 */

import React from 'react';
import { Outlet } from 'react-router-dom';
import BrandHero from './BrandHero.jsx';

export default function AuthSplitLayout() {
    return (
        <div className="login-container">
            <BrandHero />
            <Outlet />
        </div>
    );
}
