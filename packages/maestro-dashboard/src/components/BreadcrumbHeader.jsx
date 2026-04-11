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
import BreadcrumbDropdown from './BreadcrumbDropdown.jsx';
import UserAvatar from './UserAvatar.jsx';
import CreatePublicationModal from './publications/CreatePublicationModal.jsx';
import PublicationSettingsModal from './publications/PublicationSettingsModal.jsx';
import OrganizationSettingsModal from './organization/OrganizationSettingsModal.jsx';
import EditorialOfficeSettingsModal from './organization/EditorialOfficeSettingsModal.jsx';

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

    // Publikációk dropdown items
    const pubItems = useMemo(
        () => (publications || []).map(p => ({ id: p.$id, name: p.name })),
        [publications]
    );

    // User avatar menü
    const userMenuItems = useMemo(() => [
        { label: 'Jelszó módosítása', onClick: () => navigate('/settings/password') },
        { label: 'Kijelentkezés', onClick: logout, danger: true }
    ], [navigate, logout]);

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

    // ── Kiadvány modalok ──────────────────────────────────────────────────
    function handleCreatePublication() {
        openModal(<CreatePublicationModal />, {
            size: 'md',
            title: 'Új kiadvány'
        });
    }

    function handlePublicationSettings() {
        if (!activePublicationId) return;
        const activePub = publications.find(p => p.$id === activePublicationId);
        openModal(<PublicationSettingsModal publicationId={activePublicationId} />, {
            size: 'lg',
            title: activePub?.name || 'Kiadvány beállításai'
        });
    }

    // ── Szervezet / Szerkesztőség modalok ─────────────────────────────────
    function handleOrganizationSettings() {
        if (!activeOrganizationId) return;
        const activeOrg = (organizations || []).find(o => o.$id === activeOrganizationId);
        openModal(<OrganizationSettingsModal organizationId={activeOrganizationId} />, {
            size: 'lg',
            title: activeOrg?.name || 'Szervezet beállításai'
        });
    }

    function handleEditorialOfficeSettings() {
        if (!activeEditorialOfficeId) return;
        const activeOffice = (editorialOffices || []).find(o => o.$id === activeEditorialOfficeId);
        openModal(<EditorialOfficeSettingsModal editorialOfficeId={activeEditorialOfficeId} />, {
            size: 'lg',
            title: activeOffice?.name || 'Szerkesztőség beállításai'
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
                    onSettings={activeOrganizationId ? handleOrganizationSettings : undefined}
                    settingsLabel="Szervezet beállításai"
                />

                <span className="breadcrumb-separator" aria-hidden="true">/</span>

                <BreadcrumbDropdown
                    label="Szerkesztőség"
                    activeId={activeEditorialOfficeId}
                    items={officeItems}
                    onSelect={handleOfficeSelect}
                    onSettings={activeEditorialOfficeId ? handleEditorialOfficeSettings : undefined}
                    settingsLabel="Szerkesztőség beállításai"
                />

                <span className="breadcrumb-separator" aria-hidden="true">/</span>

                <BreadcrumbDropdown
                    label="Kiadvány"
                    activeId={activePublicationId}
                    items={pubItems}
                    onSelect={onPublicationSelect}
                    onSettings={activePublicationId ? handlePublicationSettings : undefined}
                    settingsLabel="Kiadvány beállításai"
                    onCreate={activeEditorialOfficeId ? handleCreatePublication : undefined}
                    createLabel="Új kiadvány"
                />
            </div>

            {/* ── Jobb oldal: nézet váltó + szűrő + cikkszám + avatar ── */}
            <div className="breadcrumb-right">
                <div className="view-toggle">
                    <Link
                        to="/"
                        className={`view-btn ${activeView === 'table' ? 'active' : ''}`}
                        title="Táblázat nézet"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <line x1="3" y1="6" x2="21" y2="6"/>
                            <line x1="3" y1="12" x2="21" y2="12"/>
                            <line x1="3" y1="18" x2="21" y2="18"/>
                        </svg>
                    </Link>
                    <Link
                        to="/layout"
                        className={`view-btn ${activeView === 'layout' ? 'active' : ''}`}
                        title="Elrendezés nézet"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
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
                    onClick={onFilterToggle}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
