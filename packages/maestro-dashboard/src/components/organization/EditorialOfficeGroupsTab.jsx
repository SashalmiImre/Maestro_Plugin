/**
 * Maestro Dashboard — EditorialOfficeSettings / GroupsTab
 *
 * A szerkesztőség „Csoportok" füle:
 *   - Csoport CRUD (inline create, inline rename, delete megerősítéssel).
 *     A slug rename-kor nem változik — a workflow compiled JSON a slug-okra
 *     hivatkozik, slug változás kaszkád-patch-et igényelne.
 *   - Tag × csoport mátrix (meglévő logika) — minden office-tag minden csoporthoz
 *     togggle badge-dzsel.
 *   - Jogosultság-sablon placeholder szekció (a jövőbeli workflow-permission
 *     editor helye).
 */

import React, { useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { DEFAULT_GROUPS } from '@shared/groups.js';

const DEFAULT_GROUP_SLUGS = new Set(DEFAULT_GROUPS.map(g => g.slug));

function errorMessage(reason) {
    if (typeof reason !== 'string') return 'Ismeretlen hiba történt.';
    if (reason.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (reason.includes('invalid_name') || reason.includes('name_empty') || reason.includes('name_too_short')) {
        return 'A csoport neve nem lehet üres és nem haladhatja meg a 128 karaktert.';
    }
    if (reason.includes('name_taken')) return 'Ezen a néven már létezik csoport a szerkesztőségben.';
    if (reason.includes('group_slug_taken')) return 'A generált slug foglalt — próbáld meg kicsit eltérő névvel.';
    if (reason.includes('default_group_protected')) {
        return 'Az alapértelmezett csoportok nem törölhetők.';
    }
    if (reason.includes('group_in_use')) return 'Ez a csoport használatban van (workflow, publikáció vagy cikk hivatkozik rá) — előbb távolítsd el a hivatkozásokat.';
    if (reason.includes('group_not_found')) return 'A csoport nem található (talán közben törölték).';
    if (reason.includes('insufficient_role')) return 'Nincs jogosultságod ehhez a művelethez.';
    if (reason.includes('not_a_member')) return 'Nem vagy tagja ennek a szervezetnek.';
    if (reason.includes('user_not_office_member') || reason.includes('target_user_not_office_member')) {
        return 'A felhasználó nem tagja a szerkesztőségnek.';
    }
    if (reason.includes('cascade_delete_failed')) {
        return 'A csoport tagságainak törlése sikertelen. Próbáld újra.';
    }
    if (reason.includes('group_create_failed') || reason.includes('group_update_failed') || reason.includes('group_delete_failed') || reason.includes('group_member_add_failed') || reason.includes('group_member_remove_failed')) {
        return 'A művelet sikertelen. Próbáld újra.';
    }
    if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) {
        return 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';
    }
    return reason;
}

/**
 * Toggle badge egy csoporthoz — színes ha aktív, szürke ha nem.
 */
function GroupBadge({ label, isActive, isPending, canEdit, onToggle }) {
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
                border: isActive ? '1px solid var(--accent-solid)' : '1px solid var(--outline-variant)',
                background: isActive ? 'rgb(from var(--accent-solid) r g b / 0.15)' : 'var(--bg-elevated)',
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
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
 * @param {Array} props.groups — groups collection dokumentumok (az office-ban)
 * @param {Array} props.groupMemberships — groupMemberships dokumentumok
 * @param {Array} props.officeMembers — editorialOfficeMemberships dokumentumok
 * @param {boolean} props.isLoading — adat betöltés folyamatban
 * @param {boolean} props.isOrgAdmin — caller org owner/admin
 * @param {() => Promise<void>} props.onReload — shell data reload callback
 */
export default function EditorialOfficeGroupsTab({
    office,
    groups,
    groupMemberships,
    officeMembers,
    isLoading,
    isOrgAdmin,
    onReload
}) {
    const { addGroupMember, removeGroupMember, createGroup, renameGroup, deleteGroup } = useAuth();
    const confirm = useConfirm();

    const [actionPending, setActionPending] = useState(null);
    const [actionError, setActionError] = useState('');

    const [isCreatingGroup, setIsCreatingGroup] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');

    const [editingGroupId, setEditingGroupId] = useState(null);
    const [editDraft, setEditDraft] = useState('');

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

    async function handleSaveRename(group) {
        const trimmed = editDraft.trim();
        if (!trimmed || trimmed === group.name) {
            setEditingGroupId(null);
            return;
        }

        setActionPending(`rename:${group.$id}`);
        setActionError('');
        try {
            await renameGroup(group.$id, trimmed);
            setEditingGroupId(null);
            await onReload();
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    async function handleDeleteGroup(group) {
        const memberCount = groupMemberCounts.get(group.$id) || 0;
        const confirmMessage = (
            <>
                <p>
                    A(z) <strong>„{group.name}"</strong> csoport törlődik
                    {memberCount > 0 && (
                        <> az összes <strong>{memberCount} csoporttagsággal</strong> együtt</>
                    )}.
                </p>
                <p>Ez a művelet nem visszavonható.</p>
            </>
        );

        const ok = await confirm({
            title: 'Csoport törlése',
            message: confirmMessage,
            confirmLabel: 'Törlés',
            cancelLabel: 'Mégse',
            variant: 'danger'
        });
        if (!ok) return;

        setActionPending(`delete:${group.$id}`);
        setActionError('');
        try {
            await deleteGroup(group.$id);
            await onReload();
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    function beginRename(group) {
        setEditingGroupId(group.$id);
        setEditDraft(group.name);
        setActionError('');
    }

    function cancelRename() {
        setEditingGroupId(null);
        setEditDraft('');
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                        Csoportok{' '}
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
                            ({groups.length})
                        </span>
                    </h3>
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

                {groups.length === 0 && !isCreatingGroup ? (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>
                        Nincsenek csoportok.
                    </p>
                ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 8px 0' }}>
                        {groups.map(group => {
                            const isEditing = editingGroupId === group.$id;
                            const isRenamePending = actionPending === `rename:${group.$id}`;
                            const isDeletePending = actionPending === `delete:${group.$id}`;
                            const memberCount = groupMemberCounts.get(group.$id) || 0;
                            const isDefault = group.isDefault === true || DEFAULT_GROUP_SLUGS.has(group.slug);

                            return (
                                <li key={group.$id} style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    fontSize: 13, padding: '4px 0'
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
                                                    if (e.key === 'Enter') handleSaveRename(group);
                                                    if (e.key === 'Escape') cancelRename();
                                                }}
                                            />
                                            <button
                                                onClick={() => handleSaveRename(group)}
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
                                            <span>{group.name}</span>
                                            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({group.slug})</span>
                                            <span style={{
                                                fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-elevated)',
                                                padding: '1px 6px', borderRadius: 3
                                            }}>
                                                {memberCount} tag
                                            </span>
                                            {isOrgAdmin && (
                                                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                                                    <button
                                                        type="button"
                                                        onClick={() => beginRename(group)}
                                                        disabled={!!actionPending}
                                                        style={{
                                                            background: 'none', color: 'var(--text-secondary)',
                                                            border: '1px solid var(--outline-variant)', padding: '2px 8px',
                                                            borderRadius: 4, cursor: 'pointer', fontSize: 10
                                                        }}
                                                    >
                                                        Átnevezés
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleDeleteGroup(group)}
                                                        disabled={!!actionPending || isDefault}
                                                        title={isDefault
                                                            ? 'Az alapértelmezett csoportok nem törölhetők.'
                                                            : undefined}
                                                        style={{
                                                            background: 'none',
                                                            color: isDefault ? 'var(--text-muted)' : 'var(--c-danger, #ef6060)',
                                                            border: `1px solid ${isDefault ? 'var(--border)' : 'var(--c-danger-border, #7a2d2d)'}`,
                                                            padding: '2px 8px', borderRadius: 4,
                                                            cursor: (actionPending || isDefault) ? 'not-allowed' : 'pointer',
                                                            fontSize: 10
                                                        }}
                                                    >
                                                        {isDeletePending ? '...' : 'Törlés'}
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </li>
                            );
                        })}
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
            <div style={{ marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
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
                ) : groups.length === 0 ? (
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
                                        {groups.map(group => {
                                            const key = `${member.userId}:${group.$id}`;
                                            const isActive = membershipLookup.has(key);
                                            const isPending = actionPending === `toggle:${member.userId}:${group.$id}`;

                                            return (
                                                <GroupBadge
                                                    key={group.$id}
                                                    label={group.name}
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

            {/* ═══ Jogosultság-sablon placeholder ═══ */}
            <div style={{ marginBottom: 8 }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>
                    Jogosultság-sablonok
                </h3>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0', fontStyle: 'italic' }}>
                    A csoportokhoz rendelt jogosultság-sablonok a jövőben itt lesznek
                    szerkeszthetők. Jelenleg a workflow-specifikus jogosultságokat a
                    Workflow Designer kezeli.
                </p>
            </div>
        </>
    );
}
