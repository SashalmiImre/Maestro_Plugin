/**
 * Maestro Dashboard — Elrendezés nézet route
 *
 * A „/layout" child route-ja. A LayoutView-t rendereli
 * a DashboardLayout által nyújtott Outlet kontextusból.
 */

import React from 'react';
import { useOutletContext } from 'react-router-dom';
import LayoutView from '../../components/LayoutView.jsx';

export default function LayoutViewRoute() {
    const { filteredArticles } = useOutletContext();

    return (
        <div className="layout-container">
            <LayoutView filteredArticles={filteredArticles} />
        </div>
    );
}
