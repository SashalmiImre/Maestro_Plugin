/**
 * Maestro Dashboard — DashboardLayout
 *
 * A védett „/" route layout-wrappere. Shell komponens: kezeli a kiadvány
 * váltást, szűrést, és Outlet kontextusban adja át a szűrt cikkeket
 * a child route-oknak (TableViewRoute, LayoutViewRoute).
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useData } from '../../contexts/DataContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useFilters } from '../../hooks/useFilters.js';
import { STORAGE_KEYS } from '../../config.js';
import { buildPlaceholderRows } from '@shared/pageGapUtils.js';

import DashboardHeader from '../../components/DashboardHeader.jsx';
import Sidebar from '../../components/Sidebar.jsx';
import ContentHeader from '../../components/ContentHeader.jsx';
import FilterBar from '../../components/FilterBar.jsx';

export default function DashboardLayout() {
    const { user } = useAuth();
    const {
        publications, articles, activePublicationId,
        isLoading, fetchPublications, switchPublication,
        fetchAllGroupMembers
    } = useData();
    const { showToast } = useToast();
    const location = useLocation();

    const [isFilterOpen, setIsFilterOpen] = useState(false);
    const [isInitialized, setIsInitialized] = useState(false);

    const filters = useFilters();

    // Aktív nézet az URL-ből (alapértelmezett: table)
    const activeView = location.pathname === '/layout' ? 'layout' : 'table';

    // Inicializálás: kiadványok lekérése + utolsó kiadvány visszaállítása
    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const pubs = await fetchPublications();
                if (cancelled) return;

                // Csoporttagok lekérése háttérben (lock nevek feloldásához)
                fetchAllGroupMembers().catch(() => {});

                // Kiadvány visszaállítása: URL paraméter (plugin-ből) > localStorage > első kiadvány
                const params = new URLSearchParams(window.location.search);
                const urlPubId = params.get('pub');
                if (urlPubId) {
                    // URL takarítás — pub paraméter eltávolítása a címsorból
                    const cleanUrl = new URL(window.location.href);
                    cleanUrl.searchParams.delete('pub');
                    window.history.replaceState({}, '', cleanUrl.toString());
                }
                const targetId = (urlPubId && pubs.some(p => p.$id === urlPubId)) ? urlPubId
                    : localStorage.getItem(STORAGE_KEYS.SELECTED_PUBLICATION);
                if (cancelled) return;
                if (targetId && pubs.some(p => p.$id === targetId)) {
                    await switchPublication(targetId);
                } else if (pubs.length > 0) {
                    await switchPublication(pubs[0].$id);
                }
            } catch (err) {
                if (!cancelled) {
                    showToast('Adatok betöltése sikertelen: ' + (err?.message || 'Ismeretlen hiba'), 'error');
                }
            } finally {
                if (!cancelled) setIsInitialized(true);
            }
        })();

        return () => { cancelled = true; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Kiadvány váltás kezelő
    const handlePublicationSelect = useCallback(async (publicationId) => {
        localStorage.setItem(STORAGE_KEYS.SELECTED_PUBLICATION, publicationId);
        try {
            await switchPublication(publicationId);
        } catch {
            showToast('Cikkek betöltése sikertelen', 'error');
        }
    }, [switchPublication, showToast]);

    // Szűrt cikkek
    const filteredArticles = useMemo(
        () => filters.applyFilters(articles, user),
        [articles, user, filters.applyFilters]
    );

    // Aktív kiadvány
    const publication = useMemo(
        () => publications.find(p => p.$id === activePublicationId),
        [publications, activePublicationId]
    );

    // Placeholder sorok (az ÖSSZES cikkből — szűrés előtt)
    const placeholderRows = useMemo(
        () => buildPlaceholderRows(articles, publication),
        [articles, publication]
    );

    // Táblázat adatok: szűrt cikkek + placeholder sorok (ha engedélyezve)
    const tableData = useMemo(() => {
        if (filters.showOnlyMine || !filters.showPlaceholders) return filteredArticles;
        return [...filteredArticles, ...placeholderRows];
    }, [filteredArticles, placeholderRows, filters.showPlaceholders, filters.showOnlyMine]);

    // Aktív kiadvány neve
    const contentTitle = useMemo(() => {
        if (!activePublicationId) return 'Válassz egy kiadványt';
        return publication ? publication.name : 'Kiadvány';
    }, [activePublicationId, publication]);

    // Outlet kontextus a child route-oknak
    const outletContext = useMemo(() => ({
        filteredArticles,
        tableData
    }), [filteredArticles, tableData]);

    return (
        <div className="dashboard active">
            <DashboardHeader />

            <div className="dashboard-body">
                <Sidebar onSelect={handlePublicationSelect} />

                <div className="main-content">
                    <ContentHeader
                        title={contentTitle}
                        articleCount={filteredArticles.length}
                        activeView={activeView}
                        isFilterActive={filters.isFilterActive}
                        onFilterToggle={() => setIsFilterOpen(prev => !prev)}
                    />

                    <FilterBar
                        isOpen={isFilterOpen}
                        statusFilter={filters.statusFilter}
                        showIgnored={filters.showIgnored}
                        showOnlyMine={filters.showOnlyMine}
                        showPlaceholders={filters.showPlaceholders}
                        onToggleStatus={filters.toggleStatus}
                        onSetShowIgnored={filters.setShowIgnored}
                        onSetShowOnlyMine={filters.setShowOnlyMine}
                        onSetShowPlaceholders={filters.setShowPlaceholders}
                        isFilterActive={filters.isFilterActive}
                        onReset={filters.resetFilters}
                    />

                    {/* Child route renderelés */}
                    {isLoading && !isInitialized ? (
                        <div className="loading-overlay">
                            <div className="spinner" />
                            <span>Betöltés...</span>
                        </div>
                    ) : !activePublicationId ? (
                        <div className="empty-state">Válassz egy kiadványt a bal oldali listából</div>
                    ) : isLoading ? (
                        <div className="loading-overlay">
                            <div className="spinner" />
                            <span>Betöltés...</span>
                        </div>
                    ) : (
                        <Outlet context={outletContext} />
                    )}
                </div>
            </div>
        </div>
    );
}
