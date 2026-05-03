/**
 * Maestro Dashboard — EditorialOfficeSettings / GroupsTab
 *
 * A szerkesztőség „Csoportok" füle (ADR 0008 / A.4.1, A.4.2, A.4.5):
 *   - Csoport-lista — minden sor `GroupRow` (kibontható szerkesztő panel:
 *     `label` / `description` / `color` / `isContributorGroup` /
 *     `isLeaderGroup` szerkesztés, permission set hozzárendelés,
 *     workflow-hivatkozások listája, archive/restore/delete).
 *   - Új csoport létrehozás (manuális — workflow-driven autoseed mellett).
 *     A `slug` immutable, csak a `name` / DB-`name` mezőt vesszük új
 *     csoport létrehozásakor (a CF generálja a slug-ot).
 *   - Tag × csoport mátrix (változatlan inline toggle).
 *
 * **Slug immutable** (ADR 0008 A.4): a `slug` mező nem szerkeszthető —
 * a workflow `compiled.requiredGroupSlugs[]` slug-okra hivatkozik.
 *
 * **Default csoport-védelem eltávolítva** (Codex A.4 roast): a régi
 * kliens-oldali `DEFAULT_GROUP_SLUGS` blokk eltűnt — a CF `delete_group` /
 * `archive_group` blocker-set-je (workflow / aktív pub / cikk hivatkozás)
 * a kanonikus forrás. A.2.7 szerinti `group_in_use` 409 a UI-ban
 * `errorMessage()` mappinggel jelenik meg.
 */

import React, { useState, useMemo } from 'react';
import { parseCompiledWorkflow } from '@shared/parseCompiledWorkflow.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useData } from '../../contexts/DataContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { mapErrorReason } from '../../utils/inviteFunctionErrorMessages.js';
import GroupRow from './GroupRow.jsx';

const GROUP_ERROR_OVERRIDES = {
    invalid_label: 'A csoport neve nem lehet üres és nem haladhatja meg a 128 karaktert.',
    invalid_name: 'A csoport neve nem lehet üres és nem haladhatja meg a 128 karaktert.',
    name_empty: 'A csoport neve nem lehet üres és nem haladhatja meg a 128 karaktert.',
    name_too_short: 'A csoport neve nem lehet üres és nem haladhatja meg a 128 karaktert.',
    name_taken: 'Ezen a néven már létezik csoport a szerkesztőségben.',
    group_slug_taken: 'A generált slug foglalt — próbáld meg kicsit eltérő névvel.',
    group_in_use:
        'Ez a csoport használatban van (workflow, publikáció vagy cikk hivatkozik rá) — előbb távolítsd el a hivatkozásokat.',
    group_not_found: 'A csoport nem található (talán közben törölték).',
    user_not_office_member: 'A felhasználó nem tagja a szerkesztőségnek.',
    target_user_not_office_member: 'A felhasználó nem tagja a szerkesztőségnek.',
    cascade_delete_failed: 'A csoport tagságainak törlése sikertelen. Próbáld újra.',
    office_mismatch: 'A jogosultság-csoport másik szerkesztőséghez tartozik.',
    group_create_failed: 'A művelet sikertelen. Próbáld újra.',
    group_update_failed: 'A művelet sikertelen. Próbáld újra.',
    group_delete_failed: 'A művelet sikertelen. Próbáld újra.',
    group_archive_failed: 'A művelet sikertelen. Próbáld újra.',
    group_restore_failed: 'A művelet sikertelen. Próbáld újra.',
    group_member_add_failed: 'A művelet sikertelen. Próbáld újra.',
    group_member_remove_failed: 'A művelet sikertelen. Próbáld újra.',
    permission_set_assign_failed: 'A művelet sikertelen. Próbáld újra.',
    permission_set_unassign_failed: 'A művelet sikertelen. Próbáld újra.'
};

function errorMessage(reason) {
    return mapErrorReason(reason, GROUP_ERROR_OVERRIDES);
}

/**
 * Toggle badge egy csoporthoz a tag×csoport mátrixban — színes ha aktív, szürke ha nem.
 */
function GroupBadge({ label, color, isActive, isPending, canEdit, onToggle }) {
    const accentBg = color || 'var(--accent-solid)';
    return (
        <span
            onClick={canEdit && !isPending ? onToggle : undefined}
            style={{
                display: 'inline-block',
                fontSize: 10,
                padding: '2px 8px',
                borderRadius: 3,
                cursor: canEdit && !isPending ? 'pointer' : 'default',
                marginRight: 4,
                marginBottom: 2,
                border: isActive ? `1px solid ${accentBg}` : '1px solid var(--outline-variant)',
                background: isActive
                    ? (color ? `rgb(from ${color} r g b / 0.18)` : 'rgb(from var(--accent-solid) r g b / 0.15)')
                    : 'var(--bg-elevated)',
                color: isActive ? (color ? 'var(--text-primary)' : 'var(--accent)') : 'var(--text-muted)',
                opacity: isPending ? 0.5 : 1,
                transition: 'all 0.15s ease',
                userSelect: 'none'
            }}
        >
            {isPending ? '...' : label}
        </span>
    );
}

/**
 * @param {Object} props
 * @param {Object} props.office — a szerkesztőség rekord
 * @param {Array} props.groups — groups collection dokumentumok (az office-ban, archivált is)
 * @param {Array} props.groupMemberships — groupMemberships dokumentumok
 * @param {Array} props.officeMembers — editorialOfficeMemberships dokumentumok
 * @param {Array} props.permissionSets — permissionSets dokumentumok az office-ban (archivált is)
 * @param {Array} props.groupPermissionSets — groupPermissionSets junction rekordok
 * @param {boolean} props.isLoading — adat betöltés folyamatban
 * @param {boolean} props.isOrgAdmin — caller org owner/admin
 * @param {() => Promise<void>} props.onReload — shell data reload callback
 */
export default function EditorialOfficeGroupsTab({
    office,
    groups,
    groupMemberships,
    officeMembers,
    permissionSets,
    groupPermissionSets,
    isLoading,
    isOrgAdmin,
    onReload
}) {
    const {
        addGroupMember,
        removeGroupMember,
        createGroup,
        updateGroupMetadata,
        archiveGroup,
        restoreGroup,
        deleteGroup,
        assignPermissionSetToGroup,
        unassignPermissionSetFromGroup
    } = useAuth();
    const { workflows } = useData();
    const confirm = useConfirm();

    const [actionPending, setActionPending] = useState(null);
    const [actionError, setActionError] = useState('');

    const [isCreatingGroup, setIsCreatingGroup] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');

    const [showArchived, setShowArchived] = useState(false);

    // --- Derived struktúrák ---

    const userNameMap = useMemo(() => {
        const map = new Map();
        for (const gm of groupMemberships) {
            if (!map.has(gm.userId)) {
                map.set(gm.userId, { name: gm.userName || null, email: gm.userEmail || null });
            }
        }
        return map;
    }, [groupMemberships]);

    const membershipLookup = useMemo(() => {
        const set = new Set();
        for (const gm of groupMemberships) {
            set.add(`${gm.userId}:${gm.groupId}`);
        }
        return set;
    }, [groupMemberships]);

    const groupMemberCounts = useMemo(() => {
        const counts = new Map();
        for (const gm of groupMemberships) {
            counts.set(gm.groupId, (counts.get(gm.groupId) || 0) + 1);
        }
        return counts;
    }, [groupMemberships]);

    const visibleGroups = useMemo(() => {
        return groups.filter((g) => showArchived || !g.archivedAt);
    }, [groups, showArchived]);

    // A workflow `compiled.requiredGroupSlugs[]` parse-olását egyszer csináljuk
    // workflow-listánként (NEM sor-render-enként): `slugToWorkflows` Map adja
    // O(1) lookup-pal a hivatkozó workflow-kat. A parse-failed workflow-k
    // külön gyűjtve a worst-case `group_in_use` blocker UI-jához.
    // (Simplify pass: GroupRow-ról emelve N×M JSON.parse storm csökkentésére.)
    const { slugToWorkflows, parseErrorWorkflows } = useMemo(() => {
        const map = new Map();
        const broken = [];
        if (!Array.isArray(workflows)) return { slugToWorkflows: map, parseErrorWorkflows: broken };
        for (const wf of workflows) {
            const compiled = parseCompiledWorkflow(wf?.compiled);
            if (!compiled) {
                broken.push({ id: wf.$id, name: wf.name || wf.slug });
                continue;
            }
            const refs = Array.isArray(compiled.requiredGroupSlugs) ? compiled.requiredGroupSlugs : [];
            for (const r of refs) {
                if (!r?.slug) continue;
                if (!map.has(r.slug)) map.set(r.slug, []);
                map.get(r.slug).push({
                    id: wf.$id,
                    name: wf.name || wf.slug,
                    visibility: wf.visibility
                });
            }
        }
        return { slugToWorkflows: map, parseErrorWorkflows: broken };
    }, [workflows]);

    const archivedCount = useMemo(
        () => groups.reduce((acc, g) => acc + (g.archivedAt ? 1 : 0), 0),
        [groups]
    );

    // A mátrixban csak a NEM-archivált csoportokat mutatjuk (toggle nem értelmes
    // archivált csoportra, és vizuálisan zsúfolt lenne).
    const matrixGroups = useMemo(
        () => groups.filter((g) => !g.archivedAt),
        [groups]
    );

    // --- Handlers ---

    async function handleToggleGroup(userId, groupId, isCurrentlyMember) {
        const pendingKey = `toggle:${userId}:${groupId}`;
        setActionPending(pendingKey);
        setActionError('');
        try {
            if (isCurrentlyMember) {
                await removeGroupMember(groupId, userId);
            } else {
                await addGroupMember(groupId, userId);
            }
            await onReload();
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    async function handleCreateGroup() {
        const trimmed = newGroupName.trim();
        if (!trimmed || !office?.$id) return;

        setActionPending('create');
        setActionError('');
        try {
            await createGroup(office.$id, trimmed);
            setNewGroupName('');
            setIsCreatingGroup(false);
            await onReload();
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    /**
     * Egy `GroupRow`-ból érkező action-handler. A `kind` szerinti `actionPending`
     * kulcsot állítjuk be (`group:${groupId}:${kind}` formátumban — a sorban
     * a per-button "..." spinner-hez), majd hívjuk a megfelelő AuthContext
     * callback-et és reload-olunk.
     *
     * **Visszatérési érték**: `true` siker esetén, `false` ha a műveletet a user
     * megszakította (confirm), `false` hiba esetén (a `setActionError` kapja
     * a részletet). A `GroupRow` ezzel dönti el, hogy a draft form-ot bezárja-e
     * (a sikeres mentés után tisztul, hibás esetén marad a draft + látszik az
     * error). Codex review fix.
     */
    async function handleGroupAction(group, kind, payload) {
        let pendingKey = `group:${group.$id}:${kind}`;
        if (kind === 'assignPermSet' || kind === 'unassignPermSet') {
            pendingKey = `${pendingKey}:${payload?.permissionSetId}`;
        }
        setActionPending(pendingKey);
        setActionError('');

        try {
            if (kind === 'updateMetadata') {
                await updateGroupMetadata(group.$id, payload);
            } else if (kind === 'archive') {
                const ok = await confirm({
                    title: 'Csoport archiválása',
                    message: (
                        <>
                            <p>
                                A(z) <strong>„{group.name}"</strong> csoport <strong>archiválódik</strong>.
                                Az aktív kiadványok snapshot-ja védi a futó munkát, de új
                                workflow-hozzárendelésnél már nem fog felajánlódni.
                            </p>
                            <p style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                A csoport visszaállítható az „Archivált csoportok megjelenítése" listából.
                            </p>
                        </>
                    ),
                    confirmLabel: 'Archiválás',
                    cancelLabel: 'Mégse',
                    variant: 'danger'
                });
                if (!ok) {
                    setActionPending(null);
                    return false;
                }
                await archiveGroup(group.$id);
            } else if (kind === 'restore') {
                await restoreGroup(group.$id);
            } else if (kind === 'delete') {
                const memberCount = groupMemberCounts.get(group.$id) || 0;
                const ok = await confirm({
                    title: 'Csoport végleges törlése',
                    message: (
                        <>
                            <p>
                                A(z) <strong>„{group.name}"</strong> csoport <strong>végleg törlődik</strong>
                                {memberCount > 0 && (
                                    <> az összes <strong>{memberCount} csoporttagsággal</strong> együtt</>
                                )}.
                            </p>
                            <p>Ez a művelet nem visszavonható.</p>
                            <p style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                Ha a csoport workflow-hivatkozott vagy aktív kiadványban van,
                                a szerver <code>group_in_use</code> hibával válaszol.
                            </p>
                        </>
                    ),
                    confirmLabel: 'Végleges törlés',
                    cancelLabel: 'Mégse',
                    variant: 'danger'
                });
                if (!ok) {
                    setActionPending(null);
                    return false;
                }
                await deleteGroup(group.$id);
            } else if (kind === 'assignPermSet') {
                await assignPermissionSetToGroup(group.$id, payload.permissionSetId);
            } else if (kind === 'unassignPermSet') {
                await unassignPermissionSetFromGroup(group.$id, payload.permissionSetId);
            }
            await onReload();
            return true;
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
            return false;
        } finally {
            setActionPending(null);
        }
    }

    // --- Render ---

    if (isLoading) {
        return <div className="form-empty-state">Betöltés…</div>;
    }

    return (
        <>
            {actionError && (
                <div className="login-error" style={{ marginBottom: 12 }}>{actionError}</div>
            )}

            {/* ═══ Csoportok lista + CRUD ═══ */}
            <div style={{ marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                        Csoportok{' '}
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
                            ({visibleGroups.length}{archivedCount > 0 ? ` / ${groups.length}` : ''})
                        </span>
                    </h3>
                    {archivedCount > 0 && (
                        <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={showArchived}
                                onChange={(e) => setShowArchived(e.target.checked)}
                            />
                            Archiváltak megjelenítése ({archivedCount})
                        </label>
                    )}
                    {isOrgAdmin && !isCreatingGroup && (
                        <button
                            type="button"
                            onClick={() => {
                                setIsCreatingGroup(true);
                                setNewGroupName('');
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
                            + Új csoport
                        </button>
                    )}
                </div>

                {visibleGroups.length === 0 && !isCreatingGroup ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>
                        Nincsenek csoportok. (Workflow aktiválásakor / hozzárendelésekor a hiányzó <code>requiredGroupSlugs</code>
                        autoseed-elnek — manuálisan is létrehozható a „+ Új csoport" gombbal.)
                    </p>
                ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 8px 0' }}>
                        {visibleGroups.map((group) => (
                            <GroupRow
                                key={group.$id}
                                group={group}
                                memberCount={groupMemberCounts.get(group.$id) || 0}
                                permissionSets={permissionSets}
                                groupPermissionSets={groupPermissionSets}
                                slugToWorkflows={slugToWorkflows}
                                parseErrorWorkflows={parseErrorWorkflows}
                                isOrgAdmin={isOrgAdmin}
                                canEdit={!actionPending}
                                actionPending={actionPending}
                                onAction={(kind, payload) => handleGroupAction(group, kind, payload)}
                                setError={setActionError}
                            />
                        ))}
                    </ul>
                )}

                {isCreatingGroup && isOrgAdmin && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                        <input
                            type="text"
                            value={newGroupName}
                            onChange={e => setNewGroupName(e.target.value)}
                            placeholder="Új csoport neve…"
                            disabled={actionPending === 'create'}
                            maxLength={128}
                            autoFocus
                            style={{
                                flex: 1, fontSize: 12, padding: '4px 6px',
                                background: 'var(--bg-base)', color: 'var(--text-primary)',
                                border: '1px solid var(--outline-variant)', borderRadius: 4
                            }}
                            onKeyDown={e => {
                                if (e.key === 'Enter') handleCreateGroup();
                                if (e.key === 'Escape') setIsCreatingGroup(false);
                            }}
                        />
                        <button
                            onClick={handleCreateGroup}
                            disabled={!!actionPending || !newGroupName.trim()}
                            style={{
                                background: 'var(--accent-solid)', color: '#fff', border: 'none',
                                padding: '4px 12px', borderRadius: 4,
                                cursor: (actionPending || !newGroupName.trim()) ? 'not-allowed' : 'pointer',
                                fontSize: 11
                            }}
                        >
                            {actionPending === 'create' ? '...' : 'Hozzáadás'}
                        </button>
                        <button
                            onClick={() => setIsCreatingGroup(false)}
                            disabled={!!actionPending}
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

            {/* ═══ Tagok és csoportok mátrix ═══ */}
            <div style={{ marginBottom: 8 }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                    Tagok és csoportok{' '}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
                        ({officeMembers.length} tag)
                    </span>
                </h3>

                {officeMembers.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>
                        Nincsenek tagok a szerkesztőségben.
                    </p>
                ) : matrixGroups.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>
                        Hozz létre csoportot, hogy tagokat tudj hozzárendelni.
                    </p>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {officeMembers.map(member => {
                            const resolved = userNameMap.get(member.userId);
                            const displayName = resolved?.name || resolved?.email || member.userId;
                            const displayEmail = resolved?.name && resolved?.email ? resolved.email : null;

                            return (
                                <div key={member.$id} style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    fontSize: 13, padding: '4px 0',
                                    flexWrap: 'wrap'
                                }}>
                                    <div style={{ minWidth: 140, flexShrink: 0 }}>
                                        <span>{displayName}</span>
                                        {displayEmail && (
                                            <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 4 }}>
                                                ({displayEmail})
                                            </span>
                                        )}
                                    </div>

                                    <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                                        {matrixGroups.map(group => {
                                            const key = `${member.userId}:${group.$id}`;
                                            const isActive = membershipLookup.has(key);
                                            const isPending = actionPending === `toggle:${member.userId}:${group.$id}`;

                                            return (
                                                <GroupBadge
                                                    key={group.$id}
                                                    label={group.name}
                                                    color={group.color}
                                                    isActive={isActive}
                                                    isPending={isPending}
                                                    canEdit={isOrgAdmin && !actionPending}
                                                    onToggle={() => handleToggleGroup(member.userId, group.$id, isActive)}
                                                />
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {!isOrgAdmin && officeMembers.length > 0 && (
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, fontStyle: 'italic' }}>
                        Csoporttagság módosításához szervezeti admin jogosultság szükséges.
                    </p>
                )}
            </div>
        </>
    );
}
