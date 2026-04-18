/**
 * Maestro Dashboard — EditorialOfficeSettings / WorkflowTab
 *
 * A szerkesztőség „Workflow" füle:
 *   - Workflow-k listája — inline rename, láthatóság dropdown, létrehozó info.
 *   - „+ Új workflow" — default workflow klónból (a CF kezeli).
 *   - Duplikálás — a forrás compiled JSON klónja, öröklött láthatósággal.
 *   - Törlés — csak ha egyetlen publikáció sem hivatkozik rá (CF scan).
 *   - Designer link — a meglévő `/admin/office/:officeId/workflow/:workflowId` útra.
 *
 * A compiled JSON-t NEM szerkeszti — arra a WorkflowDesigner szolgál. Ez csak
 * a metaadatokra (név, láthatóság) + lifecycle műveletekre fókuszál.
 */

import React, { useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfirm } from '../ConfirmDialog.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import usePopoverClose from '../../hooks/usePopoverClose.js';
import { WORKFLOW_VISIBILITY, WORKFLOW_VISIBILITY_DEFAULT } from '@shared/constants.js';
import {
    createWorkflow,
    updateWorkflowMetadata,
    duplicateWorkflow,
    deleteWorkflow
} from '../../features/workflowDesigner/api.js';

const VISIBILITY_LABELS = {
    [WORKFLOW_VISIBILITY.ORGANIZATION]: 'Szervezet',
    [WORKFLOW_VISIBILITY.EDITORIAL_OFFICE]: 'Szerkesztőség'
};

const VISIBILITY_DESCRIPTIONS = {
    [WORKFLOW_VISIBILITY.ORGANIZATION]: 'A szervezet bármely szerkesztőségének tagjai láthatják és használhatják.',
    [WORKFLOW_VISIBILITY.EDITORIAL_OFFICE]: 'Csak ennek a szerkesztőségnek a tagjai láthatják.'
};

/**
 * @param {Object} props
 * @param {Object} props.office — szerkesztőség rekord
 * @param {Array} props.workflows — workflow dokumentumok (az office-ban)
 * @param {boolean} props.isLoading
 * @param {boolean} props.isOrgAdmin — caller org owner/admin
 * @param {() => Promise<void>} props.onReload
 */
export default function EditorialOfficeWorkflowTab({
    office,
    workflows,
    isLoading,
    isOrgAdmin,
    onReload
}) {
    const navigate = useNavigate();
    const confirm = useConfirm();
    const { closeModal } = useModal();

    const [actionPending, setActionPending] = useState(null);
    const [actionError, setActionError] = useState('');

    const [isCreating, setIsCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [newVisibility, setNewVisibility] = useState(WORKFLOW_VISIBILITY_DEFAULT);

    const [editingId, setEditingId] = useState(null);
    const [editDraft, setEditDraft] = useState('');

    const [openKebabId, setOpenKebabId] = useState(null);
    const kebabRef = useRef(null);
    usePopoverClose(kebabRef, !!openKebabId, () => setOpenKebabId(null));

    const sortedWorkflows = useMemo(() => {
        return [...(workflows || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'hu'));
    }, [workflows]);

    function openDesigner(workflowId) {
        closeModal();
        navigate(`/admin/office/${office.$id}/workflow/${workflowId}`);
    }

    async function handleCreate() {
        const trimmed = newName.trim();
        if (!trimmed || !office?.$id) return;

        setActionPending('create');
        setActionError('');
        try {
            await createWorkflow(office.$id, trimmed, newVisibility);
            setNewName('');
            setNewVisibility(WORKFLOW_VISIBILITY_DEFAULT);
            setIsCreating(false);
            await onReload();
        } catch (err) {
            setActionError(err.message || 'Létrehozási hiba.');
        } finally {
            setActionPending(null);
        }
    }

    function beginRename(workflow) {
        setEditingId(workflow.$id);
        setEditDraft(workflow.name || '');
        setActionError('');
    }

    function cancelRename() {
        setEditingId(null);
        setEditDraft('');
    }

    async function handleSaveRename(workflow) {
        const trimmed = editDraft.trim();
        if (!trimmed || trimmed === workflow.name) {
            setEditingId(null);
            return;
        }

        setActionPending(`rename:${workflow.$id}`);
        setActionError('');
        try {
            await updateWorkflowMetadata(office.$id, workflow.$id, { name: trimmed });
            setEditingId(null);
            await onReload();
        } catch (err) {
            setActionError(err.message || 'Átnevezési hiba.');
        } finally {
            setActionPending(null);
        }
    }

    async function handleVisibilityChange(workflow, nextValue) {
        if (nextValue === workflow.visibility) return;

        setActionPending(`visibility:${workflow.$id}`);
        setActionError('');
        try {
            await updateWorkflowMetadata(office.$id, workflow.$id, { visibility: nextValue });
            await onReload();
        } catch (err) {
            setActionError(err.message || 'Láthatóság módosítási hiba.');
        } finally {
            setActionPending(null);
        }
    }

    async function handleDuplicate(workflow) {
        const defaultName = `${workflow.name} (másolat)`;
        const input = window.prompt('Duplikátum neve:', defaultName);
        if (input === null) return;
        const trimmed = input.trim();
        if (!trimmed) return;

        setActionPending(`duplicate:${workflow.$id}`);
        setActionError('');
        try {
            await duplicateWorkflow(office.$id, workflow.$id, trimmed);
            await onReload();
        } catch (err) {
            setActionError(err.message || 'Duplikálási hiba.');
        } finally {
            setActionPending(null);
        }
    }

    async function handleDelete(workflow) {
        const confirmMessage = (
            <>
                <p>
                    A(z) <strong>„{workflow.name}"</strong> workflow törlődik.
                </p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    A törlés csak akkor sikerül, ha egyetlen publikáció sem hivatkozik erre a workflow-ra.
                </p>
                <p>Ez a művelet nem visszavonható.</p>
            </>
        );

        const ok = await confirm({
            title: 'Workflow törlése',
            message: confirmMessage,
            confirmLabel: 'Törlés',
            cancelLabel: 'Mégse',
            variant: 'danger'
        });
        if (!ok) return;

        setActionPending(`delete:${workflow.$id}`);
        setActionError('');
        try {
            await deleteWorkflow(office.$id, workflow.$id);
            await onReload();
        } catch (err) {
            setActionError(err.message || 'Törlési hiba.');
        } finally {
            setActionPending(null);
        }
    }

    if (isLoading) {
        return <div className="form-empty-state">Betöltés…</div>;
    }

    return (
        <>
            {actionError && (
                <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>
            )}

            <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                        Workflow-k{' '}
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
                            ({sortedWorkflows.length})
                        </span>
                    </h3>
                    {isOrgAdmin && !isCreating && (
                        <button
                            type="button"
                            onClick={() => {
                                setIsCreating(true);
                                setNewName('');
                                setNewVisibility(WORKFLOW_VISIBILITY_DEFAULT);
                                setActionError('');
                            }}
                            disabled={!!actionPending}
                            style={{
                                marginLeft: 'auto',
                                background: 'var(--accent-solid)', color: '#fff', border: 'none',
                                padding: '4px 10px', borderRadius: 4,
                                cursor: actionPending ? 'not-allowed' : 'pointer',
                                fontSize: 11
                            }}
                        >
                            + Új workflow
                        </button>
                    )}
                </div>

                {sortedWorkflows.length === 0 && !isCreating ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>
                        Nincs workflow konfigurálva.
                    </p>
                ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 8px 0' }}>
                        {sortedWorkflows.map(workflow => {
                            const isEditing = editingId === workflow.$id;
                            const isRenamePending = actionPending === `rename:${workflow.$id}`;
                            const isDeletePending = actionPending === `delete:${workflow.$id}`;
                            const isDuplicatePending = actionPending === `duplicate:${workflow.$id}`;
                            const isVisibilityPending = actionPending === `visibility:${workflow.$id}`;
                            const visibility = workflow.visibility || WORKFLOW_VISIBILITY_DEFAULT;

                            return (
                                <li key={workflow.$id} style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    fontSize: 13, padding: '6px 0',
                                    borderBottom: '1px solid var(--border)'
                                }}>
                                    {isEditing && isOrgAdmin ? (
                                        <>
                                            <input
                                                type="text"
                                                value={editDraft}
                                                onChange={e => setEditDraft(e.target.value)}
                                                disabled={isRenamePending}
                                                maxLength={128}
                                                autoFocus
                                                style={{
                                                    flex: 1, fontSize: 12, padding: '4px 6px',
                                                    background: 'var(--bg-base)', color: 'var(--text-primary)',
                                                    border: '1px solid var(--outline-variant)', borderRadius: 4
                                                }}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') handleSaveRename(workflow);
                                                    if (e.key === 'Escape') cancelRename();
                                                }}
                                            />
                                            <button
                                                onClick={() => handleSaveRename(workflow)}
                                                disabled={!!actionPending}
                                                style={{
                                                    background: 'var(--accent-solid)', color: '#fff', border: 'none',
                                                    padding: '4px 10px', borderRadius: 4,
                                                    cursor: 'pointer', fontSize: 11
                                                }}
                                            >
                                                {isRenamePending ? '...' : 'Mentés'}
                                            </button>
                                            <button
                                                onClick={cancelRename}
                                                disabled={!!actionPending}
                                                style={{
                                                    background: 'none', color: 'var(--text-secondary)',
                                                    border: '1px solid var(--outline-variant)', padding: '4px 8px',
                                                    borderRadius: 4, cursor: 'pointer', fontSize: 11
                                                }}
                                            >
                                                Mégse
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <span style={{ flex: 1, fontWeight: 500 }}>{workflow.name}</span>

                                            <select
                                                value={visibility}
                                                onChange={e => handleVisibilityChange(workflow, e.target.value)}
                                                disabled={!isOrgAdmin || !!actionPending}
                                                title={VISIBILITY_DESCRIPTIONS[visibility]}
                                                style={{
                                                    fontSize: 11, padding: '2px 6px',
                                                    background: 'var(--bg-base)', color: 'var(--text-primary)',
                                                    border: '1px solid var(--outline-variant)', borderRadius: 4,
                                                    cursor: (!isOrgAdmin || actionPending) ? 'not-allowed' : 'pointer',
                                                    opacity: isVisibilityPending ? 0.5 : 1
                                                }}
                                            >
                                                <option value={WORKFLOW_VISIBILITY.EDITORIAL_OFFICE}>
                                                    {VISIBILITY_LABELS[WORKFLOW_VISIBILITY.EDITORIAL_OFFICE]}
                                                </option>
                                                <option value={WORKFLOW_VISIBILITY.ORGANIZATION}>
                                                    {VISIBILITY_LABELS[WORKFLOW_VISIBILITY.ORGANIZATION]}
                                                </option>
                                            </select>

                                            <div style={{ display: 'flex', gap: 6 }}>
                                                <button
                                                    type="button"
                                                    onClick={() => openDesigner(workflow.$id)}
                                                    disabled={!!actionPending}
                                                    title="Workflow tervező megnyitása"
                                                    style={{
                                                        background: 'none', color: 'var(--accent)',
                                                        border: '1px solid var(--outline-variant)', padding: '2px 8px',
                                                        borderRadius: 4, cursor: 'pointer', fontSize: 10
                                                    }}
                                                >
                                                    Tervező →
                                                </button>
                                                {isOrgAdmin && (
                                                    <div
                                                        ref={openKebabId === workflow.$id ? kebabRef : null}
                                                        style={{ position: 'relative' }}
                                                    >
                                                        <button
                                                            type="button"
                                                            onClick={() => setOpenKebabId(prev => prev === workflow.$id ? null : workflow.$id)}
                                                            disabled={!!actionPending}
                                                            title="További műveletek"
                                                            aria-label="További műveletek"
                                                            aria-haspopup="menu"
                                                            aria-expanded={openKebabId === workflow.$id}
                                                            style={{
                                                                background: 'none', color: 'var(--text-secondary)',
                                                                border: '1px solid var(--outline-variant)', padding: '2px 8px',
                                                                borderRadius: 4, cursor: 'pointer',
                                                                fontSize: 14, lineHeight: 1,
                                                                minWidth: 26
                                                            }}
                                                        >
                                                            {(isDuplicatePending || isDeletePending) ? '...' : '⋯'}
                                                        </button>
                                                        {openKebabId === workflow.$id && (
                                                            <ul
                                                                role="menu"
                                                                style={{
                                                                    position: 'absolute',
                                                                    top: 'calc(100% + 4px)', right: 0,
                                                                    listStyle: 'none',
                                                                    margin: 0, padding: 4,
                                                                    background: 'var(--bg-elevated, #1e1f24)',
                                                                    border: '1px solid var(--border, #3a3a3a)',
                                                                    borderRadius: 6, minWidth: 150,
                                                                    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                                                                    zIndex: 10
                                                                }}
                                                            >
                                                                <li>
                                                                    <button
                                                                        type="button"
                                                                        role="menuitem"
                                                                        onClick={() => { setOpenKebabId(null); beginRename(workflow); }}
                                                                        disabled={!!actionPending}
                                                                        style={{
                                                                            display: 'block', width: '100%',
                                                                            textAlign: 'left',
                                                                            background: 'none', color: 'var(--text-primary)',
                                                                            border: 'none', padding: '6px 10px',
                                                                            borderRadius: 4, cursor: 'pointer',
                                                                            fontSize: 12
                                                                        }}
                                                                    >
                                                                        Átnevezés
                                                                    </button>
                                                                </li>
                                                                <li>
                                                                    <button
                                                                        type="button"
                                                                        role="menuitem"
                                                                        onClick={() => { setOpenKebabId(null); handleDuplicate(workflow); }}
                                                                        disabled={!!actionPending}
                                                                        style={{
                                                                            display: 'block', width: '100%',
                                                                            textAlign: 'left',
                                                                            background: 'none', color: 'var(--text-primary)',
                                                                            border: 'none', padding: '6px 10px',
                                                                            borderRadius: 4, cursor: 'pointer',
                                                                            fontSize: 12
                                                                        }}
                                                                    >
                                                                        Duplikálás
                                                                    </button>
                                                                </li>
                                                                <li>
                                                                    <button
                                                                        type="button"
                                                                        role="menuitem"
                                                                        onClick={() => { setOpenKebabId(null); handleDelete(workflow); }}
                                                                        disabled={!!actionPending}
                                                                        style={{
                                                                            display: 'block', width: '100%',
                                                                            textAlign: 'left',
                                                                            background: 'none',
                                                                            color: 'var(--c-error, #ef6060)',
                                                                            border: 'none', padding: '6px 10px',
                                                                            borderRadius: 4, cursor: 'pointer',
                                                                            fontSize: 12
                                                                        }}
                                                                    >
                                                                        Törlés
                                                                    </button>
                                                                </li>
                                                            </ul>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}

                {isCreating && isOrgAdmin && (
                    <div style={{
                        display: 'flex', gap: 8, alignItems: 'center',
                        marginTop: 8, padding: 8,
                        background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 4
                    }}>
                        <input
                            type="text"
                            value={newName}
                            onChange={e => setNewName(e.target.value)}
                            placeholder="Workflow neve"
                            disabled={actionPending === 'create'}
                            maxLength={128}
                            autoFocus
                            style={{
                                flex: 1, fontSize: 12, padding: '4px 6px',
                                background: 'var(--bg-base)', color: 'var(--text-primary)',
                                border: '1px solid var(--outline-variant)', borderRadius: 4
                            }}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && newName.trim()) handleCreate();
                                if (e.key === 'Escape') {
                                    setIsCreating(false);
                                    setNewName('');
                                }
                            }}
                        />
                        <select
                            value={newVisibility}
                            onChange={e => setNewVisibility(e.target.value)}
                            disabled={actionPending === 'create'}
                            title={VISIBILITY_DESCRIPTIONS[newVisibility]}
                            style={{
                                fontSize: 11, padding: '4px 6px',
                                background: 'var(--bg-base)', color: 'var(--text-primary)',
                                border: '1px solid var(--outline-variant)', borderRadius: 4
                            }}
                        >
                            <option value={WORKFLOW_VISIBILITY.EDITORIAL_OFFICE}>
                                {VISIBILITY_LABELS[WORKFLOW_VISIBILITY.EDITORIAL_OFFICE]}
                            </option>
                            <option value={WORKFLOW_VISIBILITY.ORGANIZATION}>
                                {VISIBILITY_LABELS[WORKFLOW_VISIBILITY.ORGANIZATION]}
                            </option>
                        </select>
                        <button
                            onClick={handleCreate}
                            disabled={!newName.trim() || actionPending === 'create'}
                            style={{
                                background: 'var(--accent-solid)', color: '#fff', border: 'none',
                                padding: '4px 10px', borderRadius: 4,
                                cursor: (!newName.trim() || actionPending === 'create') ? 'not-allowed' : 'pointer',
                                fontSize: 11
                            }}
                        >
                            {actionPending === 'create' ? '...' : 'Hozzáadás'}
                        </button>
                        <button
                            onClick={() => {
                                setIsCreating(false);
                                setNewName('');
                            }}
                            disabled={actionPending === 'create'}
                            style={{
                                background: 'none', color: 'var(--text-secondary)',
                                border: '1px solid var(--outline-variant)', padding: '4px 8px',
                                borderRadius: 4, cursor: 'pointer', fontSize: 11
                            }}
                        >
                            Mégse
                        </button>
                    </div>
                )}
            </div>
        </>
    );
}
