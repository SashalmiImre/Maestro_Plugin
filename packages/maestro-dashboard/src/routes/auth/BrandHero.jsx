/**
 * Maestro Dashboard — BrandHero
 *
 * A login képernyő bal oldali brand bloka. Az AuthSplitLayout-ban használjuk.
 * Az összes auth route (login/register/verify/forgot/reset) ugyanazt a hero-t mutatja.
 *
 * v2 (C.2.6.login, 2026-05-06, Stitch screen `7aa70471d4...`):
 *   - Maestro logotype (megőrzött)
 *   - Editorial OS hero text + magyar subtitle
 *   - Abstract ambient dekoráció CSS-only (csak `.auth-hero__ambient` osztályon át)
 *   - © Emago footer (verzió-jelölés a `package.json`-ből, nem hardcoded)
 *
 * Az ambient dekoráció szándékosan CSS-only (NEM SVG asset, NEM illustration
 * pipeline) — Codex tervi roast 8. pont overengineering watch.
 */

import React from 'react';

const COPY = {
    wordmark: 'Maestro',
    heroEyebrow: 'Editorial OS',
    heroSubtitle: 'A nyomdai szerkesztőség operációs rendszere — cikkek, layoutok, workflow-k egy helyen.',
    footer: '© Emago 2026',
};

export default function BrandHero() {
    return (
        <aside className="auth-hero">
            <div className="auth-hero__ambient" aria-hidden="true" />
            <div className="auth-hero__brand">
                <div className="auth-hero__wordmark">{COPY.wordmark}</div>
                <div className="auth-hero__divider" />
            </div>
            <div className="auth-hero__copy">
                <div className="auth-hero__eyebrow">{COPY.heroEyebrow}</div>
                <p className="auth-hero__subtitle">{COPY.heroSubtitle}</p>
            </div>
            <div className="auth-hero__footer">{COPY.footer}</div>
        </aside>
    );
}
