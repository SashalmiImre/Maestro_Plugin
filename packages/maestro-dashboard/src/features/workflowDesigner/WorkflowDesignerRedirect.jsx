/**
 * Maestro Dashboard — Workflow Designer Redirect
 *
 * Fázis 7 backward-compat: a régi `/admin/office/:officeId/workflow` URL
 * automatikusan az adott szerkesztőség első workflow-jára irányít át
 * (név szerint rendezve). Ez a komponens a `DataContext.workflows`-ból
 * olvas — ez a state a DataProvider fetch-re tölt be (Fázis 4).
 *
 * Ha nincs workflow a szerkesztőségben, hibaüzenetet jelenít meg.
 */

import React, { useMemo } from 'react';
import { Navigate, useParams, Link } from 'react-router-dom';
import { useData } from '../../contexts/DataContext.jsx';
import './workflowDesigner.css';

export default function WorkflowDesignerRedirect() {
    const { officeId } = useParams();
    const { workflows, isLoading } = useData();

    // Scope-szűrés + név szerinti rendezés (a fetch már office-scope-ban
    // tölt, de redundáns védelem: több provider példány esetén is helyes.)
    const sortedWorkflows = useMemo(() => {
        return (workflows || [])
            .filter(wf => wf.editorialOfficeId === officeId)
            .slice()
            .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'hu'));
    }, [workflows, officeId]);

    if (isLoading) {
        return (
            <div className="workflow-designer-page">
                <div className="loading-overlay">
                    <div className="spinner" />
                    <span>Workflow-k betöltése...</span>
                </div>
            </div>
        );
    }

    if (sortedWorkflows.length === 0) {
        return (
            <div className="workflow-designer-page">
                <div className="workflow-designer-scaffold">
                    <Link to="/" className="auth-link" style={{ marginBottom: 16, display: 'inline-block' }}>
                        ← Vissza a kiadványokhoz
                    </Link>
                    <p style={{ color: 'var(--c-error, #f87171)' }}>
                        Nincs workflow ehhez a szerkesztőséghez. Kérj segítséget a rendszergazdától.
                    </p>
                </div>
            </div>
        );
    }

    const firstWorkflowId = sortedWorkflows[0].$id;
    return <Navigate to={`/admin/office/${officeId}/workflow/${firstWorkflowId}`} replace />;
}
