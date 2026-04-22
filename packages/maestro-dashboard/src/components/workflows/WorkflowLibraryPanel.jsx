/**
 * Maestro Dashboard — WorkflowLibraryPanel
 *
 * Közös workflow könyvtár panel (#82). Két kontextusban használható:
 *   - `context="breadcrumb"` — dashboard fejléc → Designer oldal navigáció.
 *   - `context="publication-assignment"` — kiadvány General fül, a kiválasztott
 *     workflow-t `onSelect` callback adja vissza a hívónak.
 *
 * Aktív lista: `DataContext.workflows` (Realtime, 3-way visibility).
 * Archivált lista: `DataContext.archivedWorkflows` (Realtime, eager fetch scope-ra).
 *
 * Jogosultság-gate-ek a CF-ben enforce-olva (#81, fail-closed); itt csak UI-t
 * szűrünk, hogy biztosan elutasított hívást ne küldjünk:
 *   - Rename / description / archive: `createdBy === caller` VAGY org owner/admin.
 *   - Visibility váltás: csak `createdBy === caller` (tulajdonos).
 *   - Duplikálás + új létrehozás: org owner/admin.
 *
 * UX:
 *   - Scope szűrő `SegmentedToggle`-lal: többszörös kijelölés (union), legalább
 *     1 kategória mindig aktív. A „Szerkesztőség" kategória szigorú: csak a
 *     saját office-ban létrehozott, office-visibility workflow-k férnek át.
 *   - Nézet-váltó (lista / rács), localStorage-ben perzisztált.
 *   - Tab + szűrő váltásnál a lista magassága `AnimatedAutoHeight`-tal animál.
 */

import React, { useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../../contexts/DataContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { usePrompt } from '../PromptDialog.jsx';
import usePopoverClose from '../../hooks/usePopoverClose.js';
import { useOrgRole } from '../../hooks/useOrgRole.js';
import {
    WORKFLOW_VISIBILITY,
    WORKFLOW_VISIBILITY_RANK,
    WORKFLOW_VISIBILITY_LABELS,
    WORKFLOW_ARCHIVE_RETENTION_DAYS
} from '@shared/constants.js';
import { getWorkflowVisibility } from '../../utils/workflowVisibility.js';
import { workflowPath } from '../../routes/paths.js';
import {
    archiveWorkflow,
    restoreWorkflow,
    updateWorkflowMetadata,
    duplicateWorkflow
} from '../../features/workflowDesigner/api.js';
import SegmentedToggle from '../SegmentedToggle.jsx';
import AnimatedAutoHeight from '../AnimatedAutoHeight.jsx';
import { openCreateWorkflowModal } from './CreateWorkflowModal.jsx';

const VISIBILITY_DESCRIPTIONS = {
    [WORKFLOW_VISIBILITY.PUBLIC]: 'Az Appwrite instance bármely authentikált tagja látja.',
    [WORKFLOW_VISIBILITY.ORGANIZATION]: 'A szervezet bármely szerkesztőségének tagjai láthatják és használhatják.',
    [WORKFLOW_VISIBILITY.EDITORIAL_OFFICE]: 'Csak ennek a szerkesztőségnek a tagjai láthatják.'
};

const SCOPE_FILTER_OPTIONS = [
    {
        value: WORKFLOW_VISIBILITY.EDITORIAL_OFFICE,
        label: 'Szerkesztőség',
        title: 'Csak a saját szerkesztőséged office-szintű workflow-i.'
    },
    {
        value: WORKFLOW_VISIBILITY.ORGANIZATION,
        label: 'Szervezet',
        title: 'A szervezet bármely szerkesztőségének látható workflow-i.'
    },
    {
        value: WORKFLOW_VISIBILITY.PUBLIC,
        label: 'Publikus',
        title: 'Az Appwrite instance bármely tagjának látható workflow-i.'
    }
];

const VIEW_MODE_STORAGE_KEY = 'maestro.dashboard.workflowLibrary.viewMode';
const VIEW_MODE_LIST = 'list';
const VIEW_MODE_GRID = 'grid';

const SCOPE_FILTER_STORAGE_KEY = 'maestro.dashboard.workflowLibrary.scopeFilter';
const DEFAULT_SCOPE_FILTER = [WORKFLOW_VISIBILITY.EDITORIAL_OFFICE];

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
 * @param {string} archivedAtIso
 * @returns {{ iso: string, daysRemaining: number }|null}
 */
function computeDeletionEta(archivedAtIso) {
    if (!archivedAtIso) return null;
    const archivedAt = new Date(archivedAtIso).getTime();
    if (!Number.isFinite(archivedAt)) return null;
    const deletionMs = archivedAt + WORKFLOW_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const daysRemaining = Math.max(0, Math.ceil((deletionMs - Date.now()) / (24 * 60 * 60 * 1000)));
    return { iso: new Date(deletionMs).toISOString(), daysRemaining };
}

function loadInitialViewMode() {
    try {
        const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
        if (stored === VIEW_MODE_GRID || stored === VIEW_MODE_LIST) return stored;
    } catch {
        /* localStorage blocked → default */
    }
    return VIEW_MODE_LIST;
}

function loadInitialScopeFilter() {
    try {
        const raw = localStorage.getItem(SCOPE_FILTER_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                const validValues = parsed.filter((v) =>
                    Object.values(WORKFLOW_VISIBILITY).includes(v)
                );
                if (validValues.length > 0) return new Set(validValues);
            }
        }
    } catch {
        /* korrupt érték / localStorage blokkolt → default */
    }
    return new Set(DEFAULT_SCOPE_FILTER);
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
    const {
        workflows, workflowsLoading,
        archivedWorkflows, archivedWorkflowsError, archivedWorkflowsLoading,
        getMemberName
    } = useData();
    const { user } = useAuth();
    const { activeOrganizationId, activeEditorialOfficeId } = useScope();
    const { openModal, closeModal } = useModal();
    const { showToast } = useToast();
    const confirm = useConfirm();
    const prompt = usePrompt();

    const [searchQuery, setSearchQuery] = useState('');
    const [scopeFilter, setScopeFilter] = useState(loadInitialScopeFilter);
    const [tab, setTab] = useState('active');
    const [actionPending, setActionPending] = useState(null);
    const [openKebabId, setOpenKebabId] = useState(null);
    const [viewMode, setViewMode] = useState(loadInitialViewMode);

    const kebabRef = useRef(null);
    usePopoverClose(kebabRef, !!openKebabId, () => setOpenKebabId(null));

    // ── Caller jogosultság ───
    const { isOrgAdmin } = useOrgRole(activeOrganizationId);

    function updateViewMode(next) {
        setViewMode(next);
        try {
            localStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
        } catch {
            /* nem kritikus — a session-re érvényes marad */
        }
    }

    function updateScopeFilter(next) {
        setScopeFilter(next);
        try {
            localStorage.setItem(SCOPE_FILTER_STORAGE_KEY, JSON.stringify(Array.from(next)));
        } catch {
            /* nem kritikus — a session-re érvényes marad */
        }
    }

    // ── Szűrt + rendezett lista ───
    const visibleWorkflows = useMemo(() => {
        const source = tab === 'archived' ? archivedWorkflows : workflows;
        const lowerQuery = searchQuery.trim().toLowerCase();

        return [...(source || [])]
            .filter((wf) => {
                const visibility = getWorkflowVisibility(wf);
                if (!scopeFilter.has(visibility)) return false;
                // A „Szerkesztőség" kategória szigorú: csak a saját office-ban
                // létrehozott workflow-kat mutatja — idegen office-szintű
                // workflow-k (amiket a user org-adminként esetleg lát) itt nem
                // jelennek meg. A duplikáláshoz a kebab menü külön útvonal.
                if (
                    visibility === WORKFLOW_VISIBILITY.EDITORIAL_OFFICE
                    && wf.editorialOfficeId !== activeEditorialOfficeId
                ) {
                    return false;
                }
                if (!lowerQuery) return true;
                const nameMatch = (wf.name || '').toLowerCase().includes(lowerQuery);
                const descMatch = (wf.description || '').toLowerCase().includes(lowerQuery);
                return nameMatch || descMatch;
            })
            .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'hu'));
    }, [tab, workflows, archivedWorkflows, scopeFilter, searchQuery, activeEditorialOfficeId]);

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
        const trimmed = await prompt({
            title: 'Workflow átnevezése',
            label: 'Add meg az új nevet.',
            initialValue: current,
            maxLength: 128,
            validate: (v) => {
                const t = v.trim();
                if (!t) return 'A név nem lehet üres.';
                if (t.length > 128) return 'A név legfeljebb 128 karakter lehet.';
                return null;
            },
            confirmLabel: 'Átnevezés'
        });
        if (trimmed === null || trimmed === current) return;
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
        const trimmed = await prompt({
            title: 'Leírás szerkesztése',
            label: 'Rövid leírás (max 500 karakter). Hagyd üresen a leírás törléséhez.',
            initialValue: current,
            maxLength: 500,
            multiline: true,
            validate: (v) => (v.length > 500 ? 'A leírás legfeljebb 500 karakter lehet.' : null),
            confirmLabel: 'Mentés'
        });
        if (trimmed === null || trimmed === current) return;
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
                        A(z) <strong>„{workflow.name}"</strong> workflow archiválódik és{' '}
                        {WORKFLOW_ARCHIVE_RETENTION_DAYS} napig visszaállítható az „Archivált"
                        fülből.
                    </p>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        A futó (aktivált) kiadványok saját snapshot-juk alapján továbbra is
                        működnek. {WORKFLOW_ARCHIVE_RETENTION_DAYS} nap után a rendszer véglegesen
                        törli.
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
            // A listák frissülése a DataContext Realtime workflow handler-jén keresztül
            // történik (archivált → aktív átvándorlás).
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
    const listClassName = `workflow-library-list${viewMode === VIEW_MODE_GRID ? ' workflow-library-list--grid' : ''}`;

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
                <div className="workflow-library-toolbar-row">
                    <SegmentedToggle
                        options={SCOPE_FILTER_OPTIONS}
                        selected={scopeFilter}
                        onChange={updateScopeFilter}
                        ariaLabel="Szűrés láthatóság szerint"
                    />
                    <div className="view-toggle workflow-library-view-toggle" role="group" aria-label="Nézet váltás">
                        <button
                            type="button"
                            className={`view-btn${viewMode === VIEW_MODE_LIST ? ' active' : ''}`}
                            onClick={() => updateViewMode(VIEW_MODE_LIST)}
                            aria-pressed={viewMode === VIEW_MODE_LIST}
                            title="Soros nézet"
                        >
                            ☰
                        </button>
                        <button
                            type="button"
                            className={`view-btn${viewMode === VIEW_MODE_GRID ? ' active' : ''}`}
                            onClick={() => updateViewMode(VIEW_MODE_GRID)}
                            aria-pressed={viewMode === VIEW_MODE_GRID}
                            title="Rácsos nézet"
                        >
                            ▦
                        </button>
                    </div>
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
                    Archivált ({archivedCount})
                </button>
            </div>

            {tab === 'archived' && archivedWorkflowsError && (
                <div className="form-error-global">{archivedWorkflowsError}</div>
            )}

            <AnimatedAutoHeight>
                {visibleWorkflows.length === 0 ? (
                    <div className="form-empty-state">
                        {/* Loading → empty state: fetch-ablak alatt ne „Nincs
                            workflow." flicker-t mutassunk az eager fetch alatt. */}
                        {(tab === 'archived' ? archivedWorkflowsLoading : workflowsLoading)
                            ? 'Betöltés…'
                            : searchQuery || scopeFilter.size < SCOPE_FILTER_OPTIONS.length
                                ? 'Nincs találat a szűrőknek.'
                                : tab === 'archived'
                                    ? 'Nincs archivált workflow.'
                                    : 'Nincs elérhető workflow.'}
                    </div>
                ) : (
                    <ul className={listClassName}>
                        {visibleWorkflows.map((workflow) => {
                            const visibility = getWorkflowVisibility(workflow);
                            const isOwner = workflow.createdBy === user?.$id;
                            const isOwnOffice = workflow.editorialOfficeId === activeEditorialOfficeId;
                            const canManage = isOwner || isOrgAdmin;
                            const canChangeVisibility = isOwner;
                            const isCurrent = workflow.$id === currentWorkflowId;
                            const isActionPendingForThis = actionPending && actionPending.endsWith(`:${workflow.$id}`);
                            const deletionEta = tab === 'archived' ? computeDeletionEta(workflow.archivedAt) : null;

                            return (
                                <li
                                    key={workflow.$id}
                                    className={`workflow-library-card${isCurrent ? ' is-current' : ''}`}
                                >
                                    <div className="workflow-library-card-main">
                                        <div className="workflow-library-card-header">
                                            <h4 className="workflow-library-card-name">
                                                {workflow.name}
                                                {isCurrent && <span className="badge badge--current">Aktuális</span>}
                                            </h4>
                                            <span
                                                className={`badge badge--${visibility}`}
                                                title={VISIBILITY_DESCRIPTIONS[visibility]}
                                            >
                                                {WORKFLOW_VISIBILITY_LABELS[visibility]}
                                            </span>
                                            {!isOwnOffice && (
                                                <span
                                                    className="badge badge--foreign"
                                                    title="Másik szerkesztőségből származik — szerkesztéshez duplikáld."
                                                >
                                                    Idegen
                                                </span>
                                            )}
                                            {isOwner && (
                                                <span className="badge badge--own" title="Te vagy a tulajdonos.">
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
                                                <span>Archiválva: {formatDate(workflow.archivedAt)}</span>
                                            )}
                                            {deletionEta && (
                                                <span
                                                    className="badge badge--warning"
                                                    title={`Törlés várható: ${formatDate(deletionEta.iso)}`}
                                                >
                                                    Törlés {deletionEta.daysRemaining} nap múlva
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
            </AnimatedAutoHeight>

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
