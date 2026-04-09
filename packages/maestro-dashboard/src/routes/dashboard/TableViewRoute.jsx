/**
 * Maestro Dashboard — Táblázat nézet route
 *
 * Az „/" index child route-ja. Az ArticleTable-t rendereli
 * a DashboardLayout által nyújtott Outlet kontextusból.
 */

import React from 'react';
import { useOutletContext } from 'react-router-dom';
import ArticleTable from '../../components/ArticleTable.jsx';

export default function TableViewRoute() {
    const { tableData } = useOutletContext();

    return (
        <div className="table-container">
            <ArticleTable filteredArticles={tableData} />
        </div>
    );
}
