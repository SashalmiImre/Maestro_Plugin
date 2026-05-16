/**
 * Maestro Dashboard — React belépési pont
 *
 * Data router (`createBrowserRouter` + `RouterProvider`) — szükséges a
 * `useBlocker` hook használatához (SettingsPasswordRoute, WorkflowDesignerPage).
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './App.jsx';
import { THEME_STORAGE_KEY } from './hooks/useTheme.js';
// S.3.1 (2026-05-16) — önhostolt Inter variable font (300-800 weight).
// A korábbi `<link href="https://fonts.googleapis.com/...">` CDN-link a CSP
// `style-src 'self' 'unsafe-inline'`-en violation-t adott; az önhostolt
// változat NEM-third-party CDN, NEM-tracking, NEM-CSP-bővítés szükséges.
import '@fontsource-variable/inter';
import '../css/index.css';

// Korai téma bootstrap — még a React hidratálás ELŐTT, hogy ne villanjon
// a default sötét, ha a user light témát választott (vagy fordítva).
(function applyInitialTheme() {
    try {
        const saved = localStorage.getItem(THEME_STORAGE_KEY);
        if (saved === 'light' || saved === 'dark') {
            document.documentElement.dataset.theme = saved;
            return;
        }
        const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
        document.documentElement.dataset.theme = prefersLight ? 'light' : 'dark';
    } catch {
        document.documentElement.dataset.theme = 'dark';
    }
})();

// Böngésző zoom tiltás — csak a LayoutView saját zoomja engedélyezett
document.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault();
}, { passive: false });

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) {
        e.preventDefault();
    }
});

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <RouterProvider router={router} />
    </React.StrictMode>
);
