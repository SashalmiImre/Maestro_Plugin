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
import '../css/styles.css';

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
