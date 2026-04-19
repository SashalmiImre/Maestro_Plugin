/**
 * Maestro Dashboard — BreadcrumbHeader
 *
 * Breadcrumb fejléc: Maestro logó → Szervezet → Szerkesztőség → Publikáció.
 * Minden dropdown tetején „Beállítások", alatta ABC rendezett opciók.
 * Jobb oldalon: nézet váltó (táblázat/elrendezés), szűrő gomb, UserAvatar.
 *
 * A „Beállítások" menüpontok egyelőre a meglévő route-okra navigálnak;
 * a modal-alapú beállítások a Fázis 4-ben érkeznek.
 */

import React, { useMemo } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useScope } from '../contexts/ScopeContext.jsx';
import { useData } from '../contexts/DataContext.jsx';
import { useModal } from '../contexts/ModalContext.jsx';
import { useTheme } from '../hooks/useTheme.js';
import BreadcrumbDropdown from './BreadcrumbDropdown.jsx';
import UserAvatar from './UserAvatar.jsx';
import PublicationSettingsModal from './publications/PublicationSettingsModal.jsx';
import OrganizationSettingsModal from './organization/OrganizationSettingsModal.jsx';
import EditorialOfficeSettingsModal from './organization/EditorialOfficeSettingsModal.jsx';
import CreateOrganizationModal from './organization/CreateOrganizationModal.jsx';
import MaestroSettingsModal from './organization/MaestroSettingsModal.jsx';

/**
 * @param {Object} props
 * @param {Function} props.onPublicationSelect — (publicationId) => void
 * @param {number} props.articleCount — szűrt cikkek száma
 * @param {boolean} props.isFilterActive — aktív szűrők vannak-e
 * @param {Function} props.onFilterToggle — szűrősáv ki/be
 */
export default function BreadcrumbHeader({
    onPublicationSelect,
    articleCount,
    isFilterActive,
    onFilterToggle
}) {
    const { user, organizations, editorialOffices, logout } = useAuth();
    const { activeOrganizationId, activeEditorialOfficeId, setActiveOrganization, setActiveOffice } = useScope();
    const { publications, activePublicationId } = useData();
    const { openModal } = useModal();
    const { theme, toggleTheme } = useTheme();
    const navigate = useNavigate();
    const location = useLocation();

    const activeView = location.pathname === '/layout' ? 'layout' : 'table';

    // Szervezetek dropdown items
    const orgItems = useMemo(
        () => (organizations || []).map(o => ({ id: o.$id, name: o.name })),
        [organizations]
    );

    // Szerkesztőségek — csak az aktív szervezethez tartozók
    const officeItems = useMemo(
        () => (editorialOffices || [])
            .filter(o => o.organizationId === activeOrganizationId)
            .map(o => ({ id: o.$id, name: o.name })),
        [editorialOffices, activeOrganizationId]
    );

    // Publikációk — csak az aktív szerkesztőséghez tartozók
    const pubItems = useMemo(
        () => (publications || [])
            .filter(p => p.editorialOfficeId === activeEditorialOfficeId)
            .map(p => ({ id: p.$id, name: p.name })),
        [publications, activeEditorialOfficeId]
    );

    // Scope-érvényesség: a Beállítások menüpontot csak akkor engedjük, ha
    // az aktív ID valóban a jelenlegi szűrt listában van. Scope-váltás
    // pillanatában (vagy üres scope-ban) a stale ID idegen rekord modalját
    // nyitná meg — az `onSettings` undefined-olásával a BreadcrumbDropdown
    // `isStatic` ágba kerül (nincs chevron, nincs menü).
    const isActiveOrgInScope = !!activeOrganizationId &&
        orgItems.some(o => o.id === activeOrganizationId);
    const isActiveOfficeInScope = !!activeEditorialOfficeId &&
        officeItems.some(o => o.id === activeEditorialOfficeId);
    const isActivePubInScope = !!activePublicationId &&
        pubItems.some(p => p.id === activePublicationId);

    // User avatar menü
    const userMenuItems = useMemo(() => [
        {
            label: 'Maestro beállítások',
            onClick: () => openModal(<MaestroSettingsModal />, {
                size: 'md',
                title: 'Maestro beállítások'
            })
        },
        {
            label: 'Új szervezet…',
            onClick: () => openModal(<CreateOrganizationModal />, {
                size: 'sm',
                title: 'Új szervezet'
            })
        },
        { label: 'Jelszó módosítása', onClick: () => navigate('/settings/password') },
        {
            label: theme === 'light' ? 'Sötét téma' : 'Világos téma',
            onClick: toggleTheme
        },
        { label: 'Kijelentkezés', onClick: logout, danger: true }
    ], [navigate, logout, theme, toggleTheme, openModal]);

    // Szervezet váltás — az office is resetelődik a ScopeContext auto-pick-kel
    function handleOrgSelect(orgId) {
        if (orgId !== activeOrganizationId) {
            setActiveOrganization(orgId);
            // Az office auto-pick effect a ScopeContext-ben kezeli a váltást
        }
    }

    function handleOfficeSelect(officeId) {
        if (officeId !== activeEditorialOfficeId) {
            setActiveOffice(officeId);
        }
    }

    // ── Kiadvány modal ────────────────────────────────────────────────────
    function handlePublicationSettings() {
        if (!activePublicationId) return;
        openModal(<PublicationSettingsModal publicationId={activePublicationId} />, {
            size: 'lg',
            title: <PublicationSettingsTitle publicationId={activePublicationId} />
        });
    }

    // ── Szervezet / Szerkesztőség modalok ─────────────────────────────────
    function handleOrganizationSettings() {
        if (!activeOrganizationId) return;
        openModal(<OrganizationSettingsModal organizationId={activeOrganizationId} />, {
            size: 'lg',
            title: <OrganizationSettingsTitle organizationId={activeOrganizationId} />
        });
    }

    function handleEditorialOfficeSettings() {
        if (!activeEditorialOfficeId) return;
        openModal(<EditorialOfficeSettingsModal editorialOfficeId={activeEditorialOfficeId} />, {
            size: 'lg',
            title: <EditorialOfficeSettingsTitle editorialOfficeId={activeEditorialOfficeId} />
        });
    }

    return (
        <div className="breadcrumb-header">
            {/* ── Bal oldal: logó + breadcrumb dropdown-ok ── */}
            <div className="breadcrumb-left">
                <Link to="/" className="breadcrumb-logo">
                    Maestro
                </Link>

                <span className="breadcrumb-separator" aria-hidden="true">/</span>

                <BreadcrumbDropdown
                    label="Szervezet"
                    activeId={activeOrganizationId}
                    items={orgItems}
                    onSelect={handleOrgSelect}
                    onSettings={isActiveOrgInScope ? handleOrganizationSettings : undefined}
                    moreItemsLabel="További szervezetek"
                />

                <span className="breadcrumb-separator" aria-hidden="true">/</span>

                <BreadcrumbDropdown
                    label="Szerkesztőség"
                    activeId={activeEditorialOfficeId}
                    items={officeItems}
                    onSelect={handleOfficeSelect}
                    onSettings={isActiveOfficeInScope ? handleEditorialOfficeSettings : undefined}
                    moreItemsLabel="További szerkesztőségek"
                />

                <span className="breadcrumb-separator" aria-hidden="true">/</span>

                <BreadcrumbDropdown
                    label="Kiadvány"
                    activeId={activePublicationId}
                    items={pubItems}
                    onSelect={onPublicationSelect}
                    onSettings={isActivePubInScope ? handlePublicationSettings : undefined}
                    moreItemsLabel="További kiadványok"
                    disabled={pubItems.length === 0 && !isActivePubInScope}
                    disabledTitle="Először hozz létre egy kiadványt a Szerkesztőség beállításokban"
                />
            </div>

            {/* ── Jobb oldal: nézet váltó + szűrő + cikkszám + avatar ── */}
            <div className="breadcrumb-right">
                <div className="view-toggle">
                    <Link
                        to="/"
                        className={`view-btn ${activeView === 'table' ? 'active' : ''}`}
                        title="Táblázat nézet"
                        aria-label="Táblázat nézet"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <line x1="3" y1="6" x2="21" y2="6"/>
                            <line x1="3" y1="12" x2="21" y2="12"/>
                            <line x1="3" y1="18" x2="21" y2="18"/>
                        </svg>
                    </Link>
                    <Link
                        to="/layout"
                        className={`view-btn ${activeView === 'layout' ? 'active' : ''}`}
                        title="Elrendezés nézet"
                        aria-label="Elrendezés nézet"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <rect x="3" y="3" width="7" height="7" rx="1"/>
                            <rect x="14" y="3" width="7" height="7" rx="1"/>
                            <rect x="3" y="14" width="7" height="7" rx="1"/>
                            <rect x="14" y="14" width="7" height="7" rx="1"/>
                        </svg>
                    </Link>
                </div>

                {activePublicationId && (
                    <span className="article-count">{articleCount} cikk</span>
                )}

                <button
                    className={`filter-toggle-btn ${isFilterActive ? 'active' : ''}`}
                    title="Szűrők"
                    aria-label={isFilterActive ? 'Szűrők bezárása' : 'Szűrők megnyitása'}
                    aria-expanded={isFilterActive}
                    onClick={onFilterToggle}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polygon points="22,3 2,3 10,12.46 10,19 14,21 14,12.46"/>
                    </svg>
                </button>

                <UserAvatar
                    name={user?.name || user?.email}
                    menuItems={userMenuItems}
                />
            </div>
        </div>
    );
}

/**
 * Reaktív modal-fejléc komponensek. A ModalContext a `title` prop-ot a stack-ben
 * tárolja, így egy statikus string nem frissül az AuthContext / DataContext
 * state-változásaira (rename Realtime event). React elementként átadva a
 * komponens saját maga feliratkozik a context-re, és a név frissül a modal
 * fejlécében is.
 */
export function OrganizationSettingsTitle({ organizationId }) {
    const { organizations } = useAuth();
    const org = (organizations || []).find(o => o.$id === organizationId);
    return org?.name || 'Szervezet beállításai';
}

export function EditorialOfficeSettingsTitle({ editorialOfficeId }) {
    const { editorialOffices } = useAuth();
    const office = (editorialOffices || []).find(o => o.$id === editorialOfficeId);
    return office?.name || 'Szerkesztőség beállításai';
}

export function PublicationSettingsTitle({ publicationId }) {
    const { publications } = useData();
    const pub = (publications || []).find(p => p.$id === publicationId);
    return pub?.name || 'Kiadvány beállításai';
}
