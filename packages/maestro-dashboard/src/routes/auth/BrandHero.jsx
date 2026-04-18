/**
 * Maestro Dashboard — BrandHero
 *
 * A login képernyő bal oldali brand bloka. Az AuthSplitLayout-ban használjuk.
 * A meglévő LoginView .login-brand bloka emeltük ki, hogy az összes auth route
 * (login/register/verify/forgot/reset) ugyanazt a hero-t mutassa.
 */

import React from 'react';

export default function BrandHero() {
    return (
        <div className="login-brand">
            <div className="wordmark">Maestro</div>
            <div className="tagline">Szerkesztőségi munkafolyamat</div>
            <div className="divider" />
        </div>
    );
}
