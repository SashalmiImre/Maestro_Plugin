/**
 * Maestro Dashboard — EditorialOfficeSettings / PermissionSetsTab (ADR 0008 / A.4.3)
 *
 * Permission set lista + CRUD belépési pontok. A `PermissionSetEditor` modal
 * a létrehozást és szerkesztést kezeli.
 *
 * **A 3 default permission set** (`owner_base`, `admin_base`, `member_base`)
 * a `bootstrap_organization` és `create_editorial_office` során auto-seed-elődik
 * — ez a tab tehát soha nem üres egy korrekt deploy-on. Ha a fetch hibára
 * üres tömböt ad, az a schema-bootstrap hiányára utal (lásd a shell
 * `fallbackOnMissingSchema`).
 *
 * **Archived permission set-ek**: külön szekció (collapse, opt-in show), a
 * lista alatt. A `userHasPermission()` az archivált set-eket skip-eli, de
 * a junction `groupPermissionSets` rekordok intaktan maradnak (Codex (b)
 * opció) — ezért `restore` után visszaáll a működő hozzárendelés.
 */

import React, { useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { mapErrorReason } from '../../utils/inviteFunctionErrorMessages.js';
import PermissionSetEditor from './PermissionSetEditor.jsx';

const PERM_SET_ERROR_OVERRIDES = {
    permission_set_not_found:
        'A jogosultság-csoport nem található (talán közben törölték).'
};

function errorMessage(reason) {
    return mapErrorReason(reason, PERM_SET_ERROR_OVERRIDES);
}

/**
 * @param {Object} props
 * @param {Object} props.office — a szerkesztőség rekord
 * @param {Array} props.permissionSets — az office összes permission set-je (archivált is)
 * @param {Array} props.groupPermissionSets — junction rekordok (a hozzárendelés-számláláshoz)
 * @param {Array} props.groups — az office csoportjai (a junction → csoportnév feloldáshoz)
 * @param {boolean} props.isLoading
 * @param {boolean} props.isOrgAdmin
 * @param {() => Promise<void>} props.onReload
 */
export default function PermissionSetsTab({
    office,
    permissionSets,
    groupPermissionSets,
    groups,
    isLoading,
    isOrgAdmin,
    onReload
}) {
    const { archivePermissionSet, restorePermissionSet } = useAuth();
    const { openModal } = useModal();
    const confirm = useConfirm();

    const [actionPending, setActionPending] = useState(null);
    const [actionError, setActionError] = useState('');
    const [showArchived, setShowArchived] = useState(false);

    // ── Derived: csoport-hozzárendelés szám / set ───────────────────────────
    const groupAssignmentCount = useMemo(() => {
        const counts = new Map();
        for (const j of groupPermissionSets) {
            counts.set(j.permissionSetId, (counts.get(j.permissionSetId) || 0) + 1);
        }
        return counts;
    }, [groupPermissionSets]);

    const groupNameById = useMemo(() => {
        const map = new Map();
        for (const g of groups) map.set(g.$id, g.name || g.slug);
        return map;
    }, [groups]);

    const groupNamesBySet = useMemo(() => {
        const map = new Map();
        for (const j of groupPermissionSets) {
            const list = map.get(j.permissionSetId) || [];
            const gName = groupNameById.get(j.groupId);
            if (gName) list.push(gName);
            map.set(j.permissionSetId, list);
        }
        return map;
    }, [groupPermissionSets, groupNameById]);

    const visibleSets = useMemo(() => {
        return permissionSets.filter((ps) => showArchived || !ps.archivedAt);
    }, [permissionSets, showArchived]);

    const archivedCount = useMemo(
        () => permissionSets.reduce((acc, ps) => acc + (ps.archivedAt ? 1 : 0), 0),
        [permissionSets]
    );

    // ── Handlers ────────────────────────────────────────────────────────────
    function openCreateEditor() {
        openModal(
            <PermissionSetEditor
                editorialOfficeId={office.$id}
                onSaved={onReload}
            />,
            { size: 'lg', title: 'Új jogosultság-csoport' }
        );
    }

    function openEditEditor(permSet) {
        openModal(
            <PermissionSetEditor
                editorialOfficeId={office.$id}
                existing={permSet}
                onSaved={onReload}
            />,
            { size: 'lg', title: `Jogosultság-csoport szerkesztése: ${permSet.name}` }
        );
    }

    async function handleArchive(permSet) {
        const ok = await confirm({
            title: 'Jogosultság-csoport archiválása',
            message: (
                <>
                    <p>
                        A(z) <strong>„{permSet.name}"</strong> jogosultság-csoport <strong>archiválódik</strong>.
                        A csoporthoz rendelt kapcsolatok intaktan maradnak (a junction rekordok nem törlődnek),
                        de az <code>userHasPermission()</code> az archivált set-eket skip-eli — gyakorlatilag
                        kivonja a hatás alól, amíg vissza nem állítod.
                    </p>
                </>
            ),
            confirmLabel: 'Archiválás',
            cancelLabel: 'Mégse',
            variant: 'danger'
        });
        if (!ok) return;

        setActionPending(`archive:${permSet.$id}`);
        setActionError('');
        try {
            await archivePermissionSet(permSet.$id, permSet.$updatedAt);
            await onReload();
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    async function handleRestore(permSet) {
        setActionPending(`restore:${permSet.$id}`);
        setActionError('');
        try {
            await restorePermissionSet(permSet.$id, permSet.$updatedAt);
            await onReload();
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    // ── Render ──────────────────────────────────────────────────────────────
    if (isLoading) {
        return <div className="form-empty-state">Betöltés…</div>;
    }

    return (
        <>
            {actionError && (
                <div className="login-error permission-set-editor__error">{actionError}</div>
            )}

            <div className="permission-sets-toolbar">
                <h3 className="permission-sets-toolbar__title">
                    Jogosultság-csoportok{' '}
                    <span className="permission-sets-toolbar__count">
                        ({visibleSets.length}{archivedCount > 0 ? ` / ${permissionSets.length}` : ''})
                    </span>
                </h3>
                {archivedCount > 0 && (
                    <label className="permission-sets-toolbar__archived-toggle">
                        <input
                            type="checkbox"
                            checked={showArchived}
                            onChange={(e) => setShowArchived(e.target.checked)}
                        />
                        Archiváltak megjelenítése ({archivedCount})
                    </label>
                )}
                {isOrgAdmin && (
                    <button
                        type="button"
                        onClick={openCreateEditor}
                        disabled={!!actionPending}
                        className="btn-primary-sm permission-sets-toolbar__add"
                    >
                        + Új jogosultság-csoport
                    </button>
                )}
            </div>

            {visibleSets.length === 0 ? (
                <p className="permission-sets-empty">
                    {permissionSets.length === 0
                        ? 'Nincsenek jogosultság-csoportok. (A bootstrap normál esetben létrehozza az owner_base / admin_base / member_base default set-eket.)'
                        : 'Minden jogosultság-csoport archivált — pipáld be az „Archiváltak megjelenítése" jelölőt a megtekintéshez.'}
                </p>
            ) : (
                <ul className="permission-sets-list">
                    {visibleSets.map((ps) => {
                        const isArchived = !!ps.archivedAt;
                        const assignedCount = groupAssignmentCount.get(ps.$id) || 0;
                        const assignedNames = groupNamesBySet.get(ps.$id) || [];
                        const isPending = actionPending === `archive:${ps.$id}` ||
                                          actionPending === `restore:${ps.$id}`;

                        return (
                            <li
                                key={ps.$id}
                                className={`permission-sets-row${isArchived ? ' permission-sets-row--archived' : ''}`}
                            >
                                <div className="permission-sets-row__header">
                                    <span className="permission-sets-row__name">{ps.name}</span>
                                    <span className="permission-sets-row__slug">({ps.slug})</span>
                                    <span className="eo-chip">
                                        {(ps.permissions || []).length} permission
                                    </span>
                                    <span className="eo-chip">
                                        {assignedCount} csoporthoz rendelve
                                    </span>
                                    {isArchived && (
                                        <span className="eo-chip">archivált</span>
                                    )}
                                    {isOrgAdmin && (
                                        <div className="permission-sets-row__actions">
                                            {!isArchived && (
                                                <button
                                                    type="button"
                                                    onClick={() => openEditEditor(ps)}
                                                    disabled={!!actionPending}
                                                    className="btn-ghost-sm"
                                                >Szerkesztés</button>
                                            )}
                                            {!isArchived && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleArchive(ps)}
                                                    disabled={isPending}
                                                    className="btn-danger-outline-sm"
                                                >
                                                    {actionPending === `archive:${ps.$id}` ? '...' : 'Archiválás'}
                                                </button>
                                            )}
                                            {isArchived && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleRestore(ps)}
                                                    disabled={isPending}
                                                    className="btn-primary-sm"
                                                >
                                                    {actionPending === `restore:${ps.$id}` ? '...' : 'Visszaállítás'}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                                {ps.description && (
                                    <p className="permission-sets-row__description">
                                        {ps.description}
                                    </p>
                                )}
                                {assignedNames.length > 0 && (
                                    <div className="permission-sets-row__assigned">
                                        {assignedNames.map((name, i) => (
                                            <span
                                                key={i}
                                                className="permission-sets-row__assigned-name"
                                            >{name}</span>
                                        ))}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {!isOrgAdmin && (
                <p className="permission-sets-non-admin-hint">
                    Jogosultság-csoport módosításához szervezeti admin jogosultság szükséges.
                </p>
            )}
        </>
    );
}
