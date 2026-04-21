/**
 * Maestro Dashboard — WorkflowLibraryPanel
 *
 * Közös workflow könyvtár panel (#82). Két kontextusban használható:
 *   - `context="breadcrumb"` — dashboard fejléc → Designer oldal navigáció.
 *   - `context="publication-assignment"` — kiadvány General fül, a kiválasztott
 *     workflow-t `onSelect` callback adja vissza a hívónak.
 *
 * Aktív lista: `DataContext.workflows` (Realtime, 3-way visibility).
 * Archivált lista: tab-váltáskor külön fetch, nem függ a Realtime bus-tól.
 *
 * Jogosultság-gate-ek a CF-ben enforce-olva (#81, fail-closed); itt csak UI-t
 * szűrünk, hogy biztosan elutasított hívást ne küldjünk:
 *   - Rename / description / archive: `createdBy === caller` VAGY org owner/admin.
 *   - Visibility váltás: csak `createdBy === caller` (tulajdonos).
 *   - Duplikálás + új létrehozás: org owner/admin.
 */

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Query } from 'appwrite';
import { useData } from '../../contexts/DataContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import usePopoverClose from '../../hooks/usePopoverClose.js';
import {
    WORKFLOW_VISIBILITY,
    WORKFLOW_VISIBILITY_RANK,
    WORKFLOW_VISIBILITY_LABELS
} from '@shared/constants.js';
import { DATABASE_ID, COLLECTIONS } from '../../config.js';
import {
    buildWorkflowVisibilityQueries,
    getWorkflowVisibility
} from '../../utils/workflowVisibility.js';
import {
    archiveWorkflow,
    restoreWorkflow,
    updateWorkflowMetadata,
    duplicateWorkflow,
    bootstrapWorkflowSchema
} from '../../features/workflowDesigner/api.js';
import { openCreateWorkflowModal } from './CreateWorkflowModal.jsx';
import { workflowPath } from '../../routes/paths.js';

const VISIBILITY_DESCRIPTIONS = {
    [WORKFLOW_VISIBILITY.PUBLIC]: 'Az Appwrite instance bármely authentikált tagja látja.',
    [WORKFLOW_VISIBILITY.ORGANIZATION]: 'A szervezet bármely szerkesztőségének tagjai láthatják és használhatják.',
    [WORKFLOW_VISIBILITY.EDITORIAL_OFFICE]: 'Csak ennek a szerkesztőségnek a tagjai láthatják.'
};

const SCOPE_FILTER = {
    ALL: 'all',
    OFFICE: 'office',
    ORGANIZATION: 'organization',
    PUBLIC: 'public'
};

const SCOPE_FILTER_LABELS = {
    [SCOPE_FILTER.ALL]: 'Mind',
    [SCOPE_FILTER.OFFICE]: 'Szerkesztőség',
    [SCOPE_FILTER.ORGANIZATION]: 'Szervezet',
    [SCOPE_FILTER.PUBLIC]: 'Publikus'
};

function formatDate(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
    } catch {
        return '';
    }
}

/**
 * @param {Object} props
 * @param {'breadcrumb'|'publication-assignment'} props.context
 * @param {string} [props.currentWorkflowId] — kiválasztott workflow (highlight)
 * @param {(workflowId: string) => void} [props.onSelect] — publication-assignment-hez
 */
export default function WorkflowLibraryPanel({
    context = 'breadcrumb',
    currentWorkflowId,
    onSelect
}) {
    const navigate = useNavigate();
    const { workflows, getMemberName, databases } = useData();
    const { user, orgMemberships } = useAuth();
    const { activeOrganizationId, activeEditorialOfficeId } = useScope();
    const { openModal, closeModal } = useModal();
    const { showToast } = useToast();
    const confirm = useConfirm();

    const [searchQuery, setSearchQuery] = useState('');
    const [scopeFilter, setScopeFilter] = useState(SCOPE_FILTER.ALL);
    const [tab, setTab] = useState('active');
    const [archivedWorkflows, setArchivedWorkflows] = useState([]);
    const [archivedLoading, setArchivedLoading] = useState(false);
    const [archivedError, setArchivedError] = useState('');
    const [actionPending, setActionPending] = useState(null);
    const [openKebabId, setOpenKebabId] = useState(null);

    const kebabRef = useRef(null);
    usePopoverClose(kebabRef, !!openKebabId, () => setOpenKebabId(null));

    // ── Caller jogosultság ───
    const callerOrgRole = useMemo(() => {
        if (!user?.$id || !activeOrganizationId) return null;
        const membership = (orgMemberships || []).find(
            (m) => m.organizationId === activeOrganizationId && m.userId === user.$id
        );
        return membership?.role || null;
    }, [orgMemberships, user?.$id, activeOrganizationId]);

    const isOrgAdmin = callerOrgRole === 'owner' || callerOrgRole === 'admin';

    // ── Archivált fetch ───
    // Auto-heal: ha a `archivedAt` attribútum nincs még a collection schema-ban
    // (régebbi Appwrite instance, nem futott a bootstrap_workflow_schema action),
    // akkor csendben meghívjuk a schema bootstrap CF action-t és újrapróbáljuk
    // a lekérést. A bootstrap idempotens és server-side owner-gated — nem-owner
    // user-nél a hiba felszínre kerül a hívónál.
    const schemaHealedRef = useRef(false);
    // Per-org denial cache: ha egy orgban a user nem owner, itt rögzítjük azt az orgId-t.
    // Org-váltáskor (ahol owner lehet) ne blokkoljon a cache — ezért Set, nem boolean.
    const bootstrapDeniedOrgsRef = useRef(new Set());
    const runArchivedQuery = useCallback(async () => {
        return databases.listDocuments({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.WORKFLOWS,
            queries: [
                ...buildWorkflowVisibilityQueries({
                    organizationId: activeOrganizationId,
                    editorialOfficeId: activeEditorialOfficeId,
                    archived: true
                }),
                Query.orderDesc('archivedAt'),
                Query.limit(100)
            ]
        });
    }, [databases, activeEditorialOfficeId, activeOrganizationId]);

    const fetchArchived = useCallback(async () => {
        if (!activeEditorialOfficeId || !activeOrganizationId) return;
        setArchivedLoading(true);
        setArchivedError('');
        try {
            let result;
            try {
                result = await runArchivedQuery();
            } catch (err) {
                const msg = err?.message || '';
                const isSchemaMiss = msg.includes('archivedAt') &&
                    (msg.includes('not found in schema') || msg.includes('Attribute not found'));
                if (!isSchemaMiss || schemaHealedRef.current) throw err;

                // Ez az org már kapott owner-denial-t → ne spammeljük a CF-et. Org-váltás után
                // (ahol a user owner lehet) a cache nem blokkol, mert más orgId.
                if (bootstrapDeniedOrgsRef.current.has(activeOrganizationId)) {
                    setArchivedError('Az archiválási funkció még nincs aktiválva ebben a környezetben. Kérd meg a szervezet owner-ét, hogy futtassa a workflow schema bootstrap-ot.');
                    return;
                }

                console.info('[WorkflowLibraryPanel] archivedAt schema hiány — bootstrap futtatás…');
                try {
                    await bootstrapWorkflowSchema();
                } catch (bootstrapErr) {
                    // `err.code === 'insufficient_role'` → non-owner, cache-eljük az aktív orgra
                    // hogy a tab újranyitás ne hívja újra a CF-et, de másik orgban (ahol owner lehet) érvényes maradjon.
                    if (bootstrapErr?.code === 'insufficient_role') {
                        bootstrapDeniedOrgsRef.current.add(activeOrganizationId);
                        setArchivedError('Az archiválási funkció még nincs aktiválva ebben a környezetben. Kérd meg a szervezet owner-ét, hogy futtassa a workflow schema bootstrap-ot.');
                    } else {
                        setArchivedError('Az archivált workflow-k lekérése nem elérhető — a workflows collection schema hiányos (archivedAt). Owner-ként futtasd a bootstrap_workflow_schema CF action-t.');
                    }
                    return;
                }

                // Bootstrap sikerült → query retry. Ha az Appwrite attribute propagation
                // még nem végzett, célzott üzenet: a user pár másodperc múlva újrapróbálkozhat.
                try {
                    result = await runArchivedQuery();
                } catch (retryErr) {
                    const retryMsg = retryErr?.message || '';
                    const stillMissing = retryMsg.includes('archivedAt') &&
                        (retryMsg.includes('not found in schema') || retryMsg.includes('Attribute not found'));
                    if (stillMissing) {
                        // Ref false marad → következő tab-váltás újrapróbálja (bootstrap már kész, csak query retry).
                        setArchivedError('A schema bootstrap sikerült, de az attribútum még propagál — nyisd meg újra az archivált fület pár másodperc múlva.');
                        return;
                    }
                    throw retryErr;
                }
                // Csak a teljes heal (bootstrap + első sikeres query) után billen true-ra.
                schemaHealedRef.current = true;
            }
            setArchivedWorkflows(result.documents);
        } catch (err) {
            console.error('[WorkflowLibraryPanel] Archivált lekérés hiba:', err);
            setArchivedError(err?.message || 'Archivált workflow-k lekérése sikertelen.');
        } finally {
            setArchivedLoading(false);
        }
    }, [activeEditorialOfficeId, activeOrganizationId, runArchivedQuery]);

    useEffect(() => {
        if (tab === 'archived') fetchArchived();
    }, [tab, fetchArchived]);

    // ── Szűrt + rendezett lista ───
    const visibleWorkflows = useMemo(() => {
        const source = tab === 'archived' ? archivedWorkflows : workflows;
        const lowerQuery = searchQuery.trim().toLowerCase();

        return [...(source || [])]
            .filter((wf) => {
                const visibility = getWorkflowVisibility(wf);
                if (scopeFilter === SCOPE_FILTER.OFFICE && visibility !== WORKFLOW_VISIBILITY.EDITORIAL_OFFICE) return false;
                if (scopeFilter === SCOPE_FILTER.ORGANIZATION && visibility !== WORKFLOW_VISIBILITY.ORGANIZATION) return false;
                if (scopeFilter === SCOPE_FILTER.PUBLIC && visibility !== WORKFLOW_VISIBILITY.PUBLIC) return false;
                if (!lowerQuery) return true;
                const nameMatch = (wf.name || '').toLowerCase().includes(lowerQuery);
                const descMatch = (wf.description || '').toLowerCase().includes(lowerQuery);
                return nameMatch || descMatch;
            })
            .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'hu'));
    }, [tab, workflows, archivedWorkflows, scopeFilter, searchQuery]);

    // ── Akciók ───
    function handleSelect(workflow) {
        if (context === 'publication-assignment') {
            if (onSelect) onSelect(workflow.$id);
            closeModal();
            return;
        }
        // breadcrumb — Designer megnyitás. A scope NEM vált át a workflow
        // office-ára: a WorkflowDesignerPage membership-alapon dönt a
        // szerkeszthetőségről, így az aktív scope érintetlenül maradhat.
        closeModal();
        navigate(workflowPath(workflow.$id));
    }

    async function handleDuplicate(workflow) {
        if (!activeEditorialOfficeId) return;
        setActionPending(`duplicate:${workflow.$id}`);
        try {
            const res = await duplicateWorkflow(activeEditorialOfficeId, workflow.$id);
            showToast(
                res.crossTenant
                    ? `„${res.name}" átmásolva a szerkesztőségedbe.`
                    : `„${res.name}" duplikálva.`,
                'success'
            );
            if (context === 'breadcrumb') {
                closeModal();
                navigate(workflowPath(res.workflowId));
            }
        } catch (err) {
            showToast(err?.message || 'Duplikálás sikertelen.', 'error');
        } finally {
            setActionPending(null);
        }
    }

    async function handleRename(workflow) {
        const current = workflow.name || '';
        const input = window.prompt('Új név:', current);
        if (input === null) return;
        const trimmed = input.trim();
        if (!trimmed || trimmed === current) return;
        setActionPending(`rename:${workflow.$id}`);
        try {
            await updateWorkflowMetadata(workflow.editorialOfficeId, workflow.$id, { name: trimmed });
            showToast('Workflow átnevezve.', 'success');
        } catch (err) {
            showToast(err?.message || 'Átnevezés sikertelen.', 'error');
        } finally {
            setActionPending(null);
        }
    }

    async function handleEditDescription(workflow) {
        const current = workflow.description || '';
        const input = window.prompt('Rövid leírás (max 500 karakter):', current);
        if (input === null) return;
        const trimmed = input.trim();
        if (trimmed === current) return;
        setActionPending(`desc:${workflow.$id}`);
        try {
            await updateWorkflowMetadata(workflow.editorialOfficeId, workflow.$id, {
                description: trimmed || null
            });
            showToast('Leírás frissítve.', 'success');
        } catch (err) {
            showToast(err?.message || 'Leírás mentése sikertelen.', 'error');
        } finally {
            setActionPending(null);
        }
    }

    async function handleChangeVisibility(workflow, nextVisibility) {
        const currentVisibility = getWorkflowVisibility(workflow);
        if (nextVisibility === currentVisibility) return;
        const currentRank = WORKFLOW_VISIBILITY_RANK[currentVisibility] ?? 1;
        const nextRank = WORKFLOW_VISIBILITY_RANK[nextVisibility] ?? 1;
        const isShrinkage = nextRank < currentRank;

        setActionPending(`visibility:${workflow.$id}`);
        try {
            await updateWorkflowMetadata(workflow.editorialOfficeId, workflow.$id, {
                visibility: nextVisibility
            });
            showToast(`Láthatóság: ${WORKFLOW_VISIBILITY_LABELS[nextVisibility]}.`, isShrinkage ? 'warning' : 'success');
        } catch (err) {
            if (err?.code === 'visibility_shrinkage_warning') {
                const count = err.count || 0;
                const msg = (
                    <>
                        <p>
                            A szűkítés után <strong>{count}</strong> kiadvány nem érné el a workflow-t
                            (ezek másik szerkesztőséghez vagy szervezethez tartoznak).
                        </p>
                        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            A futó kiadványok snapshot-juk alapján továbbra is működnek, de új
                            kiadvány ezt a workflow-t már nem tudja kiválasztani.
                        </p>
                        <p>Biztos tovább akarod szűkíteni?</p>
                    </>
                );
                const ok = await confirm({
                    title: 'Láthatóság szűkítése',
                    message: msg,
                    confirmLabel: 'Tovább szűkítem',
                    cancelLabel: 'Mégse',
                    variant: 'normal'
                });
                if (!ok) {
                    setActionPending(null);
                    return;
                }
                try {
                    await updateWorkflowMetadata(workflow.editorialOfficeId, workflow.$id, {
                        visibility: nextVisibility,
                        force: true
                    });
                    showToast(`Láthatóság: ${WORKFLOW_VISIBILITY_LABELS[nextVisibility]}.`, 'warning');
                } catch (retryErr) {
                    showToast(retryErr?.message || 'Láthatóság módosítása sikertelen.', 'error');
                }
            } else {
                showToast(err?.message || 'Láthatóság módosítása sikertelen.', 'error');
            }
        } finally {
            setActionPending(null);
        }
    }

    async function handleArchive(workflow) {
        const ok = await confirm({
            title: 'Workflow archiválása',
            message: (
                <>
                    <p>
                        A(z) <strong>„{workflow.name}"</strong> workflow archiválódik és 7 napig
                        visszaállítható az „Archivált" fülből.
                    </p>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        A futó (aktivált) kiadványok saját snapshot-juk alapján továbbra is
                        működnek. 7 nap után a rendszer véglegesen törli.
                    </p>
                </>
            ),
            confirmLabel: 'Archiválás',
            cancelLabel: 'Mégse',
            variant: 'normal'
        });
        if (!ok) return;
        setActionPending(`archive:${workflow.$id}`);
        try {
            await archiveWorkflow(workflow.editorialOfficeId, workflow.$id);
            showToast('Workflow archiválva.', 'success');
        } catch (err) {
            showToast(err?.message || 'Archiválás sikertelen.', 'error');
        } finally {
            setActionPending(null);
        }
    }

    async function handleRestore(workflow) {
        setActionPending(`restore:${workflow.$id}`);
        try {
            await restoreWorkflow(workflow.editorialOfficeId, workflow.$id);
            showToast('Workflow visszaállítva.', 'success');
            await fetchArchived();
        } catch (err) {
            showToast(err?.message || 'Visszaállítás sikertelen.', 'error');
        } finally {
            setActionPending(null);
        }
    }

    function handleCreateNew() {
        if (!activeEditorialOfficeId) return;
        // A könyvtár modal bezárása előbb — a CreateWorkflowModal sikeres
        // mentés után a Designer oldalra navigál, a Library modal-ra nincs
        // szükség. Ha megszakítja a user, a Library a breadcrumb-ból újra
        // nyitható.
        closeModal();
        openCreateWorkflowModal(openModal, activeEditorialOfficeId);
    }

    const activeCount = workflows?.length || 0;
    const archivedCount = archivedWorkflows?.length || 0;

    return (
        <div className="workflow-library">
            <div className="workflow-library-toolbar">
                <input
                    type="search"
                    className="workflow-library-search"
                    placeholder="Keresés név vagy leírás alapján…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                />
                <div className="workflow-library-chips" role="group" aria-label="Szűrés láthatóság szerint">
                    {Object.values(SCOPE_FILTER).map((key) => (
                        <button
                            key={key}
                            type="button"
                            className={`workflow-library-chip${scopeFilter === key ? ' is-active' : ''}`}
                            onClick={() => setScopeFilter(key)}
                        >
                            {SCOPE_FILTER_LABELS[key]}
                        </button>
                    ))}
                </div>
            </div>

            <div className="tabs workflow-library-tabs">
                <button
                    type="button"
                    className={`tab${tab === 'active' ? ' active' : ''}`}
                    onClick={() => setTab('active')}
                >
                    Aktív ({activeCount})
                </button>
                <button
                    type="button"
                    className={`tab${tab === 'archived' ? ' active' : ''}`}
                    onClick={() => setTab('archived')}
                >
                    Archivált{tab === 'archived' || archivedCount > 0 ? ` (${archivedCount})` : ''}
                </button>
            </div>

            {tab === 'archived' && archivedError && (
                <div className="form-error-global">{archivedError}</div>
            )}

            {tab === 'archived' && archivedLoading ? (
                <div className="form-empty-state">Betöltés…</div>
            ) : visibleWorkflows.length === 0 ? (
                <div className="form-empty-state">
                    {searchQuery || scopeFilter !== SCOPE_FILTER.ALL
                        ? 'Nincs találat a szűrőknek.'
                        : tab === 'archived'
                            ? 'Nincs archivált workflow.'
                            : 'Nincs elérhető workflow.'}
                </div>
            ) : (
                <ul className="workflow-library-list">
                    {visibleWorkflows.map((workflow) => {
                        const visibility = getWorkflowVisibility(workflow);
                        const isOwner = workflow.createdBy === user?.$id;
                        const isOwnOffice = workflow.editorialOfficeId === activeEditorialOfficeId;
                        const canManage = isOwner || isOrgAdmin;
                        const canChangeVisibility = isOwner;
                        const isCurrent = workflow.$id === currentWorkflowId;
                        const isActionPendingForThis = actionPending && actionPending.endsWith(`:${workflow.$id}`);

                        return (
                            <li
                                key={workflow.$id}
                                className={`workflow-library-card${isCurrent ? ' is-current' : ''}`}
                            >
                                <div className="workflow-library-card-main">
                                    <div className="workflow-library-card-header">
                                        <h4 className="workflow-library-card-name">
                                            {workflow.name}
                                            {isCurrent && <span className="workflow-library-badge is-current">Aktuális</span>}
                                        </h4>
                                        <span
                                            className={`workflow-library-chip-visibility is-${visibility}`}
                                            title={VISIBILITY_DESCRIPTIONS[visibility]}
                                        >
                                            {WORKFLOW_VISIBILITY_LABELS[visibility]}
                                        </span>
                                        {!isOwnOffice && (
                                            <span
                                                className="workflow-library-badge is-foreign"
                                                title="Másik szerkesztőségből származik — szerkesztéshez duplikáld."
                                            >
                                                Idegen
                                            </span>
                                        )}
                                        {isOwner && (
                                            <span className="workflow-library-badge is-own" title="Te vagy a tulajdonos.">
                                                Saját
                                            </span>
                                        )}
                                    </div>

                                    {workflow.description && (
                                        <p className="workflow-library-card-desc">{workflow.description}</p>
                                    )}

                                    <div className="workflow-library-card-meta">
                                        {workflow.createdBy && (
                                            <span>{getMemberName(workflow.createdBy) || 'Ismeretlen'}</span>
                                        )}
                                        {workflow.$createdAt && (
                                            <span>{formatDate(workflow.$createdAt)}</span>
                                        )}
                                        {tab === 'archived' && workflow.archivedAt && (
                                            <span className="workflow-library-archived-at">
                                                Archiválva: {formatDate(workflow.archivedAt)}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className="workflow-library-card-actions">
                                    {tab === 'active' && (
                                        <>
                                            <button
                                                type="button"
                                                className="btn-primary"
                                                disabled={!!actionPending}
                                                onClick={() => handleSelect(workflow)}
                                            >
                                                {context === 'publication-assignment' ? 'Kiválaszt' : 'Megnyit'}
                                            </button>
                                            {!isOwnOffice && isOrgAdmin && (
                                                <button
                                                    type="button"
                                                    className="btn-secondary"
                                                    disabled={!!actionPending}
                                                    onClick={() => handleDuplicate(workflow)}
                                                    title="Másolat készítése a saját szerkesztőségedbe"
                                                >
                                                    {isActionPendingForThis && actionPending.startsWith('duplicate')
                                                        ? '…'
                                                        : 'Duplikál & szerkeszt'}
                                                </button>
                                            )}
                                        </>
                                    )}
                                    {tab === 'archived' && canManage && (
                                        <button
                                            type="button"
                                            className="btn-secondary"
                                            disabled={!!actionPending}
                                            onClick={() => handleRestore(workflow)}
                                        >
                                            {isActionPendingForThis && actionPending.startsWith('restore')
                                                ? '…'
                                                : 'Visszaállít'}
                                        </button>
                                    )}

                                    {tab === 'active' && (canManage || isOwnOffice) && (
                                        <div
                                            ref={openKebabId === workflow.$id ? kebabRef : null}
                                            className="workflow-library-kebab"
                                        >
                                            <button
                                                type="button"
                                                className="workflow-library-kebab-btn"
                                                onClick={() => setOpenKebabId((prev) => (prev === workflow.$id ? null : workflow.$id))}
                                                disabled={!!actionPending}
                                                aria-haspopup="menu"
                                                aria-expanded={openKebabId === workflow.$id}
                                                title="További műveletek"
                                            >
                                                ⋯
                                            </button>
                                            {openKebabId === workflow.$id && (
                                                <ul role="menu" className="workflow-library-kebab-menu">
                                                    {isOwnOffice && isOrgAdmin && (
                                                        <li>
                                                            <button
                                                                type="button"
                                                                role="menuitem"
                                                                onClick={() => { setOpenKebabId(null); handleDuplicate(workflow); }}
                                                            >
                                                                Duplikálás
                                                            </button>
                                                        </li>
                                                    )}
                                                    {canManage && (
                                                        <>
                                                            <li>
                                                                <button
                                                                    type="button"
                                                                    role="menuitem"
                                                                    onClick={() => { setOpenKebabId(null); handleRename(workflow); }}
                                                                >
                                                                    Átnevezés
                                                                </button>
                                                            </li>
                                                            <li>
                                                                <button
                                                                    type="button"
                                                                    role="menuitem"
                                                                    onClick={() => { setOpenKebabId(null); handleEditDescription(workflow); }}
                                                                >
                                                                    Leírás…
                                                                </button>
                                                            </li>
                                                        </>
                                                    )}
                                                    {canChangeVisibility && (
                                                        <li className="workflow-library-kebab-submenu">
                                                            <span className="workflow-library-kebab-label">Láthatóság</span>
                                                            <div className="workflow-library-kebab-visibility">
                                                                {Object.values(WORKFLOW_VISIBILITY).map((v) => (
                                                                    <button
                                                                        key={v}
                                                                        type="button"
                                                                        className={v === visibility ? 'is-active' : ''}
                                                                        onClick={() => { setOpenKebabId(null); handleChangeVisibility(workflow, v); }}
                                                                        title={VISIBILITY_DESCRIPTIONS[v]}
                                                                    >
                                                                        {WORKFLOW_VISIBILITY_LABELS[v]}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        </li>
                                                    )}
                                                    {canManage && (
                                                        <li>
                                                            <button
                                                                type="button"
                                                                role="menuitem"
                                                                className="is-danger"
                                                                onClick={() => { setOpenKebabId(null); handleArchive(workflow); }}
                                                            >
                                                                Archivál
                                                            </button>
                                                        </li>
                                                    )}
                                                </ul>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            <div className="workflow-library-footer">
                {isOrgAdmin && tab === 'active' && (
                    <button
                        type="button"
                        className="btn-primary"
                        onClick={handleCreateNew}
                        disabled={!!actionPending}
                    >
                        + Új workflow
                    </button>
                )}
                <button
                    type="button"
                    className="btn-secondary"
                    onClick={closeModal}
                    disabled={!!actionPending}
                >
                    Bezár
                </button>
            </div>
        </div>
    );
}
