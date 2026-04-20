/**
 * Maestro Dashboard — /workflows/new belépési pont
 *
 * Új workflow létrehozás URL-je. A route mount-jakor megnyitja a
 * `CreateWorkflowModal`-t az aktív szerkesztőségre; sikeres create esetén
 * a modal maga navigál `/workflows/:id`-re. Mégse esetén a modal bezárul,
 * ilyenkor visszanavigálunk `/`-ra.
 *
 * Miért nem navigate('/')-ra rögtön mount-kor? Mert a ModalProvider ennek
 * a route-nak a szülőjében (`WorkflowDesignerWithProviders`) él — ha mount
 * közben átírányítunk, a provider unmount-ol még a modal rajzolása előtt,
 * és a modal soha nem jelenik meg. Ehelyett itt maradunk, amíg a modal
 * van nyitva; záráskor a `modalCount` 1→0 átmenetnél navigálunk.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { openCreateWorkflowModal } from '../../components/workflows/CreateWorkflowModal.jsx';

export default function WorkflowNewRoute() {
    const navigate = useNavigate();
    const { loading, user, editorialOffices, orgMemberships } = useAuth();
    const { activeEditorialOfficeId } = useScope();
    const { openModal, modalCount } = useModal();
    const { showToast } = useToast();

    // Az aktív office org-jában owner/admin? A `create_workflow` CF action
    // csak ezeket fogadja el (insufficient_role különben). A member-szerepű
    // user ne kerüljön be egy olyan modalba, amit úgysem tud lementeni.
    const canCreateWorkflow = useMemo(() => {
        if (!user?.$id || !activeEditorialOfficeId) return false;
        const office = (editorialOffices || []).find(o => o.$id === activeEditorialOfficeId);
        const orgId = office?.organizationId;
        if (!orgId) return false;
        const m = (orgMemberships || []).find(
            (mm) => mm.organizationId === orgId && mm.userId === user.$id
        );
        return m?.role === 'owner' || m?.role === 'admin';
    }, [orgMemberships, editorialOffices, user?.$id, activeEditorialOfficeId]);

    // StrictMode double-mount + re-render guard: csak egyszer nyitjuk meg.
    const hasOpenedRef = useRef(false);
    // Az előző `modalCount` érték — a navigation csak valódi 1→0 átmenetnél
    // fut, nem a kezdeti 0-s állapotban (amikor a modal még nincs nyitva).
    const prevModalCountRef = useRef(0);
    // Egyszeri toast + redirect insufficient_role esetén.
    const hasNotifiedRef = useRef(false);

    useEffect(() => {
        if (hasOpenedRef.current) return;
        if (!activeEditorialOfficeId) return;
        if (!canCreateWorkflow) return;
        hasOpenedRef.current = true;
        openCreateWorkflowModal(openModal, activeEditorialOfficeId);
    }, [activeEditorialOfficeId, canCreateWorkflow, openModal]);

    // Ha a memberships betöltött és a user nem admin/owner, toast + redirect.
    // A `loading`-ra várunk, hogy a friss session resolve előtti null
    // orgMemberships ne triggereljen hamis toastot.
    useEffect(() => {
        if (loading) return;
        if (!activeEditorialOfficeId) return;
        if (canCreateWorkflow) return;
        if (hasNotifiedRef.current) return;
        hasNotifiedRef.current = true;
        showToast('Új workflow létrehozásához admin jogosultság szükséges.', 'error');
        navigate('/', { replace: true });
    }, [loading, activeEditorialOfficeId, canCreateWorkflow, showToast, navigate]);

    useEffect(() => {
        const prev = prevModalCountRef.current;
        prevModalCountRef.current = modalCount;
        // Csak a tényleges modal-zárásnál (prev>0 → 0) navigálunk. Sikeres
        // submit esetén a modal már `/workflows/:id`-re ugrott — WorkflowNewRoute
        // unmount-olt, ez az effect nem fut.
        if (prev > 0 && modalCount === 0) {
            navigate('/', { replace: true });
        }
    }, [modalCount, navigate]);

    // Scope init race (#83 harden Iter 3): a ScopeProvider memberships-alapon
    // auto-pickeli az első office-t egy useEffect-ben. Ha a user fresh session
    // vagy deep link-en érkezik /workflows/new-ra, az aktív office egy tickig
    // null lehet. Ilyenkor NEM redirectelünk — várunk a scope resolve-ra.
    // Csak akkor küldjük vissza /-re, ha a memberships már betöltött és
    // tényleg nincs egy office sem (onboarding-edge).
    if (!activeEditorialOfficeId) {
        if (!loading && (editorialOffices || []).length === 0) {
            return <Navigate to="/" replace />;
        }
        return (
            <div className="workflow-designer-page">
                <div className="loading-overlay">
                    <div className="spinner" />
                    <span>Betöltés…</span>
                </div>
            </div>
        );
    }

    // A modal mögött látszó placeholder — cancel után egy pillanatra látható
    // a navigate('/') előtt.
    return (
        <div className="workflow-designer-page">
            <div className="workflow-designer-scaffold">
                <p style={{ color: 'var(--text-muted)' }}>Új workflow létrehozása folyamatban…</p>
            </div>
        </div>
    );
}
