/**
 * Maestro Dashboard — Workflow Designer legacy URL redirectek
 *
 * 1) `WorkflowDesignerRedirect` — a régi `/admin/office/:officeId/workflow`
 *    URL (workflowId nélkül) az URL-ben szereplő office első workflow-jára
 *    ugrik (név szerint rendezve). A DataContext-et szándékosan NEM használjuk:
 *    annak listája scope-szűrt, így cross-office bookmark üresnek tűnne.
 *    A komponens DataProvider-en KÍVÜL fut (AuthSplitLayout sibling), ezért
 *    a modul-szintű `getDatabases()`-t használja — stale-client nincs, mert
 *    a Dashboardon nincs endpoint-rotáció (az `EndpointManager` Plugin-only).
 *
 * 2) `LegacyWorkflowRedirect` — a régi `/admin/office/:officeId/workflow/:id`
 *    URL a workflowId-t átemeli az új `/workflows/:id`-re; az officeId-re
 *    nincs szükség (a doc maga tudja).
 */

import React, { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { Query } from 'appwrite';
import { getDatabases } from '../../contexts/AuthContext.jsx';
import { DATABASE_ID, COLLECTIONS } from '../../config.js';
import { workflowPath } from '../../routes/paths.js';
import BackToDashboardLink from './BackToDashboardLink.jsx';
import './workflowDesigner.css';

export default function WorkflowDesignerRedirect() {
    const { officeId } = useParams();
    const [state, setState] = useState({ status: 'loading', targetId: null, error: null });

    useEffect(() => {
        if (!officeId) {
            setState({ status: 'error', targetId: null, error: 'Hiányzó szerkesztőség azonosító.' });
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const databases = getDatabases();
                // Appwrite `orderAsc` bytewise rendez — a magyar ékezetes nevek
                // (Árvíz, Értekezés, Ősz…) nem a nyelvi várakozás szerint esnek
                // sorba. A legacy viselkedés (ld. pre-refactor client-side sort)
                // magyar collation-t várt, ezért itt is `localeCompare(..., 'hu')`-t
                // használunk. A limit feloldva, mert az első doc kiválasztása a
                // kliensoldali sort után történik.
                const result = await databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.WORKFLOWS,
                    queries: [
                        Query.equal('editorialOfficeId', officeId),
                        Query.isNull('archivedAt'),
                        Query.limit(100)
                    ]
                });
                if (cancelled) return;
                const sorted = [...result.documents].sort(
                    (a, b) => (a.name || '').localeCompare(b.name || '', 'hu')
                );
                const first = sorted[0];
                if (first) {
                    setState({ status: 'redirect', targetId: first.$id, error: null });
                } else {
                    setState({ status: 'empty', targetId: null, error: null });
                }
            } catch (err) {
                if (cancelled) return;
                setState({
                    status: 'error',
                    targetId: null,
                    error: err?.message || 'Workflow lekérdezési hiba.'
                });
            }
        })();
        return () => { cancelled = true; };
    }, [officeId]);

    if (state.status === 'redirect') {
        return <Navigate to={workflowPath(state.targetId)} replace />;
    }

    if (state.status === 'loading') {
        return (
            <div className="workflow-designer-page">
                <div className="loading-overlay">
                    <div className="spinner" />
                    <span>Workflow-k betöltése...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="workflow-designer-page">
            <div className="workflow-designer-scaffold">
                <BackToDashboardLink />
                <p style={{ color: 'var(--c-error, #f87171)' }}>
                    {state.status === 'empty'
                        ? 'Nincs workflow ehhez a szerkesztőséghez. Kérj segítséget a rendszergazdától.'
                        : state.error}
                </p>
            </div>
        </div>
    );
}

export function LegacyWorkflowRedirect() {
    const { workflowId } = useParams();
    return <Navigate to={workflowPath(workflowId)} replace />;
}
