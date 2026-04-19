/**
 * Maestro Dashboard — DashboardLayout
 *
 * A védett „/" route layout-wrappere. Shell komponens: kezeli a kiadvány
 * váltást, szűrést, és Outlet kontextusban adja át a szűrt cikkeket
 * a child route-oknak (TableViewRoute, LayoutViewRoute).
 *
 * A BreadcrumbHeader az egyetlen fejléc: logó → szervezet → szerkesztőség →
 * kiadvány breadcrumb, jobb oldalon nézet váltó + szűrő + avatar.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useData } from '../../contexts/DataContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useFilters } from '../../hooks/useFilters.js';
import { STORAGE_KEYS } from '../../config.js';
import { buildPlaceholderRows } from '@shared/pageGapUtils.js';

import BreadcrumbHeader, {
    OrganizationSettingsTitle,
    EditorialOfficeSettingsTitle
} from '../../components/BreadcrumbHeader.jsx';
import FilterBar from '../../components/FilterBar.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import EditorialOfficeSettingsModal from '../../components/organization/EditorialOfficeSettingsModal.jsx';
import OrganizationSettingsModal from '../../components/organization/OrganizationSettingsModal.jsx';

export default function DashboardLayout() {
    const { user } = useAuth();
    const { activeOrganizationId, activeEditorialOfficeId } = useScope();
    const {
        publications, articles, activePublicationId,
        isLoading, fetchPublications, switchPublication,
        fetchAllGroupMembers, fetchWorkflow
    } = useData();
    const { showToast } = useToast();
    const { openModal } = useModal();

    const [isFilterOpen, setIsFilterOpen] = useState(false);
    const [isInitialized, setIsInitialized] = useState(false);

    const filters = useFilters();

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

    // Scope váltás (szervezet / szerkesztőség) → kiadványok és workflow újralekérése
    const prevOfficeIdRef = useRef(activeEditorialOfficeId);
    useEffect(() => {
        if (!isInitialized) return;
        if (activeEditorialOfficeId === prevOfficeIdRef.current) return;
        prevOfficeIdRef.current = activeEditorialOfficeId;

        if (!activeEditorialOfficeId) return;

        let cancelled = false;

        (async () => {
            try {
                const pubs = await fetchPublications();
                if (cancelled) return;
                fetchWorkflow().catch(() => {});
                fetchAllGroupMembers().catch(() => {});
                if (pubs.length > 0) {
                    await switchPublication(pubs[0].$id);
                } else {
                    // Nincs kiadvány az új scope-ban — korábbi adat törlése
                    await switchPublication(null);
                }
            } catch {
                if (!cancelled) showToast('Adatok frissítése sikertelen', 'error');
            }
        })();

        return () => { cancelled = true; };
    }, [activeEditorialOfficeId, isInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

    // Üres office → új kiadvány auto-select. Ha a DataContext Realtime handlere
    // (scope-szűrt publications subscribe) új kiadványt ad a `publications`-höz,
    // de nincs aktív kiválasztás (init vagy `switchPublication(null)` után),
    // automatikusan az elsőre váltunk, hogy a felhasználó ne maradjon az
    // „Válassz egy kiadványt" üres állapoton egy másik tab-ban létrehozott
    // kiadvány után.
    useEffect(() => {
        if (!isInitialized) return;
        if (activePublicationId) return;
        if (publications.length === 0) return;
        switchPublication(publications[0].$id).catch(() => {});
    }, [publications, activePublicationId, isInitialized, switchPublication]);

    // Kiadvány váltás kezelő
    const handlePublicationSelect = useCallback(async (publicationId) => {
        localStorage.setItem(STORAGE_KEYS.SELECTED_PUBLICATION, publicationId);
        try {
            await switchPublication(publicationId);
        } catch {
            showToast('Cikkek betöltése sikertelen', 'error');
        }
    }, [switchPublication, showToast]);

    // Üres állapot akciók — office beállítások (kiadvány létrehozás) / szervezet beállítások
    const handleCreatePublication = useCallback(() => {
        if (!activeEditorialOfficeId) {
            showToast('Először válassz egy szerkesztőséget a fejlécben.', 'warning');
            return;
        }
        openModal(
            <EditorialOfficeSettingsModal
                editorialOfficeId={activeEditorialOfficeId}
                initialTab="general"
            />,
            {
                size: 'lg',
                title: <EditorialOfficeSettingsTitle editorialOfficeId={activeEditorialOfficeId} />
            }
        );
    }, [activeEditorialOfficeId, openModal, showToast]);

    const handleOpenOrgSettings = useCallback(() => {
        if (!activeOrganizationId) return;
        openModal(
            <OrganizationSettingsModal organizationId={activeOrganizationId} />,
            {
                size: 'lg',
                title: <OrganizationSettingsTitle organizationId={activeOrganizationId} />
            }
        );
    }, [activeOrganizationId, openModal]);

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

    // Outlet kontextus a child route-oknak
    const outletContext = useMemo(() => ({
        filteredArticles,
        tableData
    }), [filteredArticles, tableData]);

    return (
        <div className="dashboard active">
            <BreadcrumbHeader
                onPublicationSelect={handlePublicationSelect}
                articleCount={filteredArticles.length}
                isFilterActive={filters.isFilterActive}
                onFilterToggle={() => setIsFilterOpen(prev => !prev)}
            />

            <div className="dashboard-body">
                <div className="main-content">
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
                        publications.length === 0 ? (
                            <EmptyState
                                title="Még nincs kiadvány"
                                description="Ebben a szerkesztőségben még nincs kiadvány. Hozz létre egyet, hogy elkezdhesd a szerkesztést."
                                primaryAction={activeEditorialOfficeId ? {
                                    label: 'Kiadvány létrehozása',
                                    onClick: handleCreatePublication
                                } : undefined}
                                secondaryAction={activeOrganizationId ? {
                                    label: 'Szervezet beállításai',
                                    onClick: handleOpenOrgSettings
                                } : undefined}
                            />
                        ) : (
                            <EmptyState
                                title="Válassz egy kiadványt"
                                description="A fejléc Kiadvány menüjéből válaszd ki, melyik kiadványon szeretnél dolgozni."
                            />
                        )
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
