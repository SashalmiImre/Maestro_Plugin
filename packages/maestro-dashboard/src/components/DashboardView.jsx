/**
 * Maestro Dashboard — Fő dashboard nézet
 *
 * DataProvider-ben fut. Kezeli a kiadvány váltást,
 * szűrést, nézet váltást (táblázat/layout).
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useData } from '../contexts/DataContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { useFilters } from '../hooks/useFilters.js';
import { STORAGE_KEYS } from '../config.js';

import DashboardHeader from './DashboardHeader.jsx';
import Sidebar from './Sidebar.jsx';
import ContentHeader from './ContentHeader.jsx';
import FilterBar from './FilterBar.jsx';
import ArticleTable from './ArticleTable.jsx';
import LayoutView from './LayoutView.jsx';

export default function DashboardView() {
    const { user } = useAuth();
    const {
        publications, articles, activePublicationId,
        isLoading, fetchPublications, switchPublication,
        fetchAllTeamMembers
    } = useData();
    const { showToast } = useToast();

    const [activeView, setActiveView] = useState('table');
    const [isFilterOpen, setIsFilterOpen] = useState(false);
    const [isInitialized, setIsInitialized] = useState(false);

    const filters = useFilters();

    // Inicializálás: kiadványok lekérése + utolsó kiadvány visszaállítása
    useEffect(() => {
        (async () => {
            try {
                const pubs = await fetchPublications();

                // Csapattagok lekérése háttérben (lock nevek feloldásához)
                fetchAllTeamMembers().catch(() => {});

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
                if (targetId && pubs.some(p => p.$id === targetId)) {
                    await switchPublication(targetId);
                } else if (pubs.length > 0) {
                    await switchPublication(pubs[0].$id);
                }
            } catch (err) {
                showToast('Adatok betöltése sikertelen: ' + (err?.message || 'Ismeretlen hiba'), 'error');
            } finally {
                setIsInitialized(true);
            }
        })();
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

    // Aktív kiadvány neve
    const contentTitle = useMemo(() => {
        if (!activePublicationId) return 'Válassz egy kiadványt';
        const pub = publications.find(p => p.$id === activePublicationId);
        return pub ? pub.name : 'Kiadvány';
    }, [publications, activePublicationId]);

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
                        onViewChange={setActiveView}
                        isFilterActive={filters.isFilterActive}
                        onFilterToggle={() => setIsFilterOpen(prev => !prev)}
                    />

                    <FilterBar
                        isOpen={isFilterOpen}
                        statusFilter={filters.statusFilter}
                        showIgnored={filters.showIgnored}
                        showOnlyMine={filters.showOnlyMine}
                        onToggleStatus={filters.toggleStatus}
                        onSetShowIgnored={filters.setShowIgnored}
                        onSetShowOnlyMine={filters.setShowOnlyMine}
                        onReset={filters.resetFilters}
                    />

                    {/* Tábla/Layout nézet */}
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
                        <>
                            <div className="table-container" style={{ display: activeView === 'table' ? '' : 'none' }}>
                                <ArticleTable filteredArticles={filteredArticles} />
                            </div>
                            <div className="layout-container" style={{ display: activeView === 'layout' ? '' : 'none' }}>
                                <LayoutView filteredArticles={filteredArticles} />
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
