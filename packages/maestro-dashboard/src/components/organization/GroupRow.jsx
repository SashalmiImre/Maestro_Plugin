/**
 * Maestro Dashboard — GroupRow (ADR 0008 / A.4.1, A.4.2, A.4.5)
 *
 * Egy csoport sor + kibontható szerkesztő panel az `EditorialOfficeGroupsTab`-on.
 *
 * **Slug immutable** (ADR 0008 A.4): a `slug` csak megjelenítve, NEM
 * szerkeszthető — a workflow `compiled.requiredGroupSlugs[]` slug-okra
 * hivatkozik. Szerkeszthető mezők (A.2.6 `update_group_metadata` action):
 *   - `label` (DB-mező: `name`) — UI label
 *   - `description` — opcionális leírás (max 500 char, nullable)
 *   - `color` — CSS hex, nullable
 *   - `isContributorGroup` — közreműködő csoport flag (workflow-runtime)
 *   - `isLeaderGroup` — vezető csoport flag (workflow-runtime)
 *
 * **Permission set hozzárendelés (A.4.5)**: a csoporthoz tartozó
 * `groupPermissionSets` rekordok kezelése (`assign_permission_set_to_group` /
 * `unassign_permission_set_from_group` CF action-ök). Multi-select
 * checkbox-lista, scope-szűrt (csak az adott office permission set-jei).
 *
 * **Csoport detail panel (A.4.2)**: a `compiled.requiredGroupSlugs[]`-ban a
 * group.slug-ot hivatkozó workflow-k listája. Üres-csoport warning
 * (member-count = 0) az aktivált pub-okra hivatkozó snapshot védelem
 * mellett is felszínre kerül.
 *
 * **Archive/restore + delete**: az archive ugyanazt a `group_in_use`
 * blocker-set-et használja, mint a `delete_group`. Az archived sor
 * vizuálisan elsötétül, és csak a "Visszaállítás" / "Törlés" gomb látszik.
 */

import React, { useMemo, useState } from 'react';
import { COLOR_PRESETS } from '../../utils/colorPresets.js';

/**
 * @param {Object} props
 * @param {Object} props.group — `groups` doc
 * @param {number} props.memberCount — tagok száma a csoportban
 * @param {Array} props.permissionSets — az office összes (nem-archivált + archivált) permission set-je
 * @param {Array} props.groupPermissionSets — az office groupPermissionSets junction rekordjai
 * @param {Map<string, Array<{id:string,name:string,visibility?:string}>>} props.slugToWorkflows —
 *   slug → hivatkozó workflow-k térképe (parent-ben memoizált, hogy a sor-render
 *   ne parse-olja újra a workflow JSON-jokat)
 * @param {Array<{id:string,name:string}>} [props.parseErrorWorkflows] — a parent-ben gyűjtött
 *   parse-failed workflow-k (worst-case `group_in_use` blocker jelzéshez)
 * @param {boolean} props.isOrgAdmin — caller org owner/admin
 * @param {boolean} props.canEdit — meglévő `actionPending` flag-tel kombinált editable
 * @param {string|null} props.actionPending — folyamatban lévő művelet kulcsa (`group:${$id}:${kind}`)
 * @param {(kind: string, payload?: any) => Promise<void>} props.onAction —
 *   action-handler. `kind` ∈ { 'updateMetadata', 'archive', 'restore', 'delete', 'assignPermSet', 'unassignPermSet' }
 * @param {(message: string) => void} props.setError — közös error setter
 */
export default function GroupRow({
    group,
    memberCount,
    permissionSets,
    groupPermissionSets,
    slugToWorkflows,
    parseErrorWorkflows = [],
    isOrgAdmin,
    canEdit,
    actionPending,
    onAction,
    setError
}) {
    const isArchived = !!group.archivedAt;
    const [isExpanded, setIsExpanded] = useState(false);
    const [draft, setDraft] = useState(null);

    const isPending = actionPending && actionPending.startsWith(`group:${group.$id}:`);

    // ── Hozzárendelt permission set-ek (junction lookup) ────────────────────
    const assignedSetIds = useMemo(() => {
        const set = new Set();
        for (const j of groupPermissionSets) {
            if (j.groupId === group.$id) set.add(j.permissionSetId);
        }
        return set;
    }, [groupPermissionSets, group.$id]);

    // ── Workflow-hivatkozások (compiled.requiredGroupSlugs[] scan) ──────────
    // Codex review: parse-failed workflow-kat külön gyűjtjük, nehogy a "nincs
    // hivatkozás" hamis biztonságérzetet adjon, miközben a CF blocker-set
    // ugyanezt a workflow-t (parse-failed → fail-closed) blokk-okként számolja.
    //
    // A `slugToWorkflows` Map a parent-ben épül egyszer (per-workflows-change),
    // így a sor-render-enkénti N×M JSON.parse storm helyett O(1) Map-lookup.
    const referencingWorkflows = slugToWorkflows.get(group.slug) || [];

    // ── Draft init / reset ──────────────────────────────────────────────────
    function beginEdit() {
        setDraft({
            label: group.name || '',
            description: group.description || '',
            color: group.color || '',
            isContributorGroup: !!group.isContributorGroup,
            isLeaderGroup: !!group.isLeaderGroup
        });
        setIsExpanded(true);
        setError('');
    }

    function cancelEdit() {
        setDraft(null);
    }

    function toggleExpand() {
        setIsExpanded((v) => !v);
        if (isExpanded) setDraft(null);
    }

    // ── Mentés ──────────────────────────────────────────────────────────────
    async function handleSave() {
        if (!draft) return;
        const trimmedLabel = (draft.label || '').trim();
        if (!trimmedLabel) {
            setError('A csoport neve nem lehet üres.');
            return;
        }
        const patch = {};
        if (trimmedLabel !== group.name) patch.label = trimmedLabel;
        const newDescription = (draft.description || '').trim();
        const oldDescription = (group.description || '').trim();
        if (newDescription !== oldDescription) patch.description = newDescription || null;
        const newColor = (draft.color || '').trim();
        const oldColor = (group.color || '').trim();
        if (newColor !== oldColor) patch.color = newColor || null;
        if (!!draft.isContributorGroup !== !!group.isContributorGroup) {
            patch.isContributorGroup = !!draft.isContributorGroup;
        }
        if (!!draft.isLeaderGroup !== !!group.isLeaderGroup) {
            patch.isLeaderGroup = !!draft.isLeaderGroup;
        }

        if (Object.keys(patch).length === 0) {
            setDraft(null);
            return;
        }

        // Codex review fix: a draft form-ot CSAK siker esetén zárjuk be — ha a
        // CF hibát ad (`group_in_use`, `invalid_label`, `schema_missing`, stb.),
        // a felhasználó folytathassa a szerkesztést a setError-on át megjelenő
        // banner-rel, ne tűnjön el a beírt érték.
        const ok = await onAction('updateMetadata', patch);
        if (ok) setDraft(null);
    }

    async function handleArchive() {
        await onAction('archive');
    }
    async function handleRestore() {
        await onAction('restore');
    }
    async function handleDelete() {
        await onAction('delete');
    }
    async function handleTogglePermSet(permSetId, isAssigned) {
        await onAction(isAssigned ? 'unassignPermSet' : 'assignPermSet', { permissionSetId: permSetId });
    }

    // ── Render ──────────────────────────────────────────────────────────────
    const rowClassName = [
        'group-row',
        isExpanded && 'group-row--expanded',
        isArchived && 'group-row--archived'
    ].filter(Boolean).join(' ');

    return (
        <li className={rowClassName}>
            {/* Sor (összecsukott vagy fej) */}
            <div className="group-row__header" onClick={toggleExpand}>
                <span
                    className="eo-color-swatch"
                    style={group.color ? { background: group.color } : undefined}
                />
                <span className="group-row__name">{group.name}</span>
                <span className="group-row__slug">({group.slug})</span>
                <span className="eo-chip">{memberCount} tag</span>
                {group.isContributorGroup && (
                    <span className="eo-chip eo-chip--contrib" title="Közreműködő csoport (workflow-runtime)">
                        contrib
                    </span>
                )}
                {group.isLeaderGroup && (
                    <span className="eo-chip eo-chip--leader" title="Vezető csoport (workflow-runtime)">
                        leader
                    </span>
                )}
                {memberCount === 0 && referencingWorkflows.length > 0 && (
                    <span className="eo-chip eo-chip--empty" title="Üres csoport — a hivatkozó workflow-k aktiválása blokkolva van.">
                        üres
                    </span>
                )}
                {isArchived && (
                    <span className="eo-chip">archivált</span>
                )}
                <span className="group-row__caret">
                    {isExpanded ? '▲' : '▼'}
                </span>
            </div>

            {/* Kibontott panel */}
            {isExpanded && (
                <div className="group-row__panel">
                    {!draft && isOrgAdmin && !isArchived && (
                        <button
                            type="button"
                            onClick={beginEdit}
                            disabled={!canEdit}
                            className="btn-primary-sm group-row__edit-trigger"
                        >
                            Szerkesztés
                        </button>
                    )}

                    {/* Szerkesztő form */}
                    {draft && (
                        <div className="group-row__edit-form">
                            <label className="eo-form-stack">
                                <span className="eo-form-stack__label">Név</span>
                                <input
                                    type="text"
                                    value={draft.label}
                                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                                    maxLength={128}
                                    className="eo-input"
                                />
                            </label>
                            <label className="eo-form-stack">
                                <span className="eo-form-stack__label">Leírás (opcionális)</span>
                                <textarea
                                    value={draft.description}
                                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                                    maxLength={500}
                                    rows={2}
                                    className="eo-input eo-input--textarea"
                                />
                            </label>
                            <div className="group-row__color-row">
                                <span className="eo-form-stack__label">Szín:</span>
                                <input
                                    type="color"
                                    value={draft.color || '#cccccc'}
                                    onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                                    className="group-row__color-input"
                                />
                                <input
                                    type="text"
                                    value={draft.color}
                                    placeholder="#aabbcc"
                                    onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                                    maxLength={9}
                                    className="eo-input group-row__color-text"
                                />
                                <button
                                    type="button"
                                    onClick={() => setDraft({ ...draft, color: '' })}
                                    title="Szín törlése (default)"
                                    className="group-row__color-clear"
                                >×</button>
                                <div className="group-row__color-presets">
                                    {COLOR_PRESETS.map((c) => (
                                        <span
                                            key={c}
                                            onClick={() => setDraft({ ...draft, color: c })}
                                            title={c}
                                            className="group-row__color-preset"
                                            style={{ background: c }}
                                        />
                                    ))}
                                </div>
                            </div>
                            <label className="group-row__inline-flag">
                                <input
                                    type="checkbox"
                                    checked={!!draft.isContributorGroup}
                                    onChange={(e) => setDraft({ ...draft, isContributorGroup: e.target.checked })}
                                />
                                <span>Közreműködő csoport (<code>isContributorGroup</code>)</span>
                            </label>
                            <label className="group-row__inline-flag">
                                <input
                                    type="checkbox"
                                    checked={!!draft.isLeaderGroup}
                                    onChange={(e) => setDraft({ ...draft, isLeaderGroup: e.target.checked })}
                                />
                                <span>Vezető csoport (<code>isLeaderGroup</code>) — workflow-runtime guard-bypass</span>
                            </label>
                            <div className="group-row__edit-actions">
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={!canEdit || isPending}
                                    className="btn-primary-sm"
                                >
                                    {isPending && actionPending === `group:${group.$id}:updateMetadata` ? '...' : 'Mentés'}
                                </button>
                                <button
                                    type="button"
                                    onClick={cancelEdit}
                                    disabled={isPending}
                                    className="btn-secondary-sm"
                                >Mégse</button>
                            </div>
                        </div>
                    )}

                    {/* Permission set hozzárendelés (A.4.5) */}
                    {!isArchived && (
                        <div className="group-row__edit-section">
                            <h4 className="eo-subheading">Jogosultság-csoportok</h4>
                            {permissionSets.length === 0 ? (
                                <p className="eo-empty-hint">
                                    Nincsenek elérhető jogosultság-csoportok. (Hozz létre egyet a <em>Jogosultság-csoportok</em> fülön.)
                                </p>
                            ) : (
                                <div className="group-row__perm-set-list">
                                    {permissionSets.map((ps) => {
                                        const isAssigned = assignedSetIds.has(ps.$id);
                                        const isPsArchived = !!ps.archivedAt;
                                        const togglePending = actionPending === `group:${group.$id}:assignPermSet:${ps.$id}` ||
                                                              actionPending === `group:${group.$id}:unassignPermSet:${ps.$id}`;
                                        // Harden review fix: archivált permission set ÚJ assignment-je
                                        // dead junction-t hozna létre (`userHasPermission()` skip-eli).
                                        // Csak akkor toggle-elhető, ha már assigned (unassign engedett),
                                        // egyébként disabled — UX = "ezt csak unassign-elheted".
                                        const archivedNoOp = isPsArchived && !isAssigned;
                                        const rowClass = [
                                            'group-row__perm-set-row',
                                            isPsArchived && 'group-row__perm-set-row--archived',
                                            archivedNoOp && 'group-row__perm-set-row--locked'
                                        ].filter(Boolean).join(' ');
                                        return (
                                            <label key={ps.$id}
                                                title={archivedNoOp
                                                    ? 'Archivált jogosultság-csoport — új hozzárendelés inaktív lenne. Először állítsd vissza a Jogosultság-csoportok fülön.'
                                                    : undefined}
                                                className={rowClass}>
                                                <input
                                                    type="checkbox"
                                                    checked={isAssigned}
                                                    disabled={!isOrgAdmin || !canEdit || togglePending || archivedNoOp}
                                                    onChange={() => handleTogglePermSet(ps.$id, isAssigned)}
                                                />
                                                <span>{ps.name}</span>
                                                <span className="group-row__slug">({ps.slug})</span>
                                                {isPsArchived && (
                                                    <span className="eo-chip">archivált</span>
                                                )}
                                                {togglePending && <span className="group-row__perm-set-pending">...</span>}
                                            </label>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Workflow-hivatkozások (A.4.2 — csoport detail panel) */}
                    <div className="group-row__edit-section">
                        <h4 className="eo-subheading">Hivatkozó workflow-k</h4>
                        {referencingWorkflows.length === 0 ? (
                            <p className="eo-empty-hint">
                                Nincs olyan workflow, ami a <code>{group.slug}</code> slug-ot a <code>requiredGroupSlugs</code>-ban hivatkozza.
                            </p>
                        ) : (
                            <ul className="group-row__workflow-list">
                                {referencingWorkflows.map((w) => (
                                    <li key={w.id} className="group-row__workflow-item">
                                        {w.name}
                                        {w.visibility && (
                                            <span className="group-row__workflow-visibility">· {w.visibility}</span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {parseErrorWorkflows.length > 0 && (
                            <p className="eo-empty-hint eo-empty-hint--warning">
                                ⚠ {parseErrorWorkflows.length} workflow <code>compiled</code> JSON-ja hibás —
                                a CF blocker-scan ezekhez a worst-case "tartalmaz" eredményt veszi
                                (`group_in_use` 409 a törlésnél / archiválásnál).
                            </p>
                        )}
                    </div>

                    {/* Veszélyes zóna: archive / restore / delete */}
                    {isOrgAdmin && (
                        <div className="group-row__danger-zone">
                            <div className="group-row__danger-actions">
                                {!isArchived && (
                                    <button
                                        type="button"
                                        onClick={handleArchive}
                                        disabled={!canEdit || isPending}
                                        className="btn-danger-outline-sm"
                                    >
                                        {actionPending === `group:${group.$id}:archive` ? '...' : 'Archiválás'}
                                    </button>
                                )}
                                {isArchived && (
                                    <button
                                        type="button"
                                        onClick={handleRestore}
                                        disabled={!canEdit || isPending}
                                        className="btn-primary-sm"
                                    >
                                        {actionPending === `group:${group.$id}:restore` ? '...' : 'Visszaállítás'}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    disabled={!canEdit || isPending}
                                    className="btn-danger-outline-sm"
                                    title="Csoport végleges törlése. group_in_use blokk védi (workflow / aktív pub / cikk hivatkozás esetén 409)."
                                >
                                    {actionPending === `group:${group.$id}:delete` ? '...' : 'Törlés'}
                                </button>
                            </div>
                            <p className="group-row__danger-hint">
                                Az <em>archiválás</em> reverzibilis, a <em>törlés</em> nem. Mindkettő blokkolódik, ha a csoport
                                workflow-ban / aktív kiadványban / cikkben hivatkozott (<code>group_in_use</code>).
                            </p>
                        </div>
                    )}
                </div>
            )}
        </li>
    );
}
