/**
 * Maestro Dashboard — EditorialOfficeSettings / WorkflowExtensionsTab
 * (B.5.1, ADR 0007 Phase 0)
 *
 * Workflow extension lista + CRUD belépési pontok. A `WorkflowExtensionEditor`
 * modal a létrehozást és szerkesztést kezeli. Minta: `PermissionSetsTab`.
 *
 * **Phase 0 hatókör (B.5)**: minden extension `editorial_office` visibility
 * + `article` scope (a server-side enum-fail-closed-tól öröklődik). Az
 * archivált extension-ek külön opt-in toggle mögött jelennek meg, mint a
 * permission set-eknél — a `userHasPermission()` és a Plugin runtime is
 * skip-eli az archivált extension-eket.
 *
 * **Implicit restore explicit gombbal** (Codex tervi review fix): a
 * server `update_workflow_extension` `archivedAt: null`-lal triggereli a
 * visszaállítást (dupla auth: `extension.edit` + `extension.archive`), de
 * a UI-on egy explicit "Visszaállítás" gomb hívja, NEM az editor save
 * mellékhatása.
 *
 * **Kind chip + workflow-hivatkozás warning** (Codex blind spot fix):
 * archive után a tab a hivatkozó workflow-kat egy info-szöveg-rel
 * mutatja — nem csak "majd 7 napos retention". Phase 0-ban ez best-effort
 * lokális scan a `workflows[]`-on (a snapshot-os pubokat NEM érinti).
 */

import React, { useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { mapErrorReason } from '../../utils/inviteFunctionErrorMessages.js';
import { isExtensionRef } from '@shared/extensionContract.js';
import WorkflowExtensionEditor from './WorkflowExtensionEditor.jsx';

const EXTENSION_ERROR_OVERRIDES = {
    extension_not_found:
        'A bővítmény nem található (talán közben törölték).',
    extension_slug_taken: 'Ezzel a slug-gal már létezik bővítmény ebben a szerkesztőségben.',
    version_conflict:
        'Időközben valaki más is módosította ezt a bővítményt. Töltsd újra és próbáld meg újra.',
    unsupported_visibility:
        'Phase 0-ban csak szerkesztőség-szintű (editorial_office) láthatóság engedett.'
};

function errorMessage(reason) {
    return mapErrorReason(reason, EXTENSION_ERROR_OVERRIDES);
}

/**
 * Egy `compiled` workflow JSON-ben felsorol minden `ext.<slug>` ref-et —
 * mind a `validations`, mind a `commands` ágon. A return egy `Set<slug>`,
 * a slug-prefix nélkül (csak a tiszta slug-okkal). Phase 0 hatókör:
 * `validations[stateName].{onEntry, requiredToEnter, requiredToExit}` és
 * `commands[stateName][].id`. Az `extensionContract.js` `isExtensionRef`
 * a kanonikus boolean check.
 */
function collectExtensionSlugsFromCompiled(compiled) {
    const slugs = new Set();
    if (!compiled || typeof compiled !== 'object') return slugs;

    const validations = compiled.validations;
    if (validations && typeof validations === 'object') {
        for (const stateBlock of Object.values(validations)) {
            if (!stateBlock || typeof stateBlock !== 'object') continue;
            for (const lane of ['onEntry', 'requiredToEnter', 'requiredToExit']) {
                const list = stateBlock[lane];
                if (!Array.isArray(list)) continue;
                for (const item of list) {
                    const ref = typeof item === 'string' ? item : item?.validator;
                    if (typeof ref === 'string' && isExtensionRef(ref)) {
                        slugs.add(ref.slice('ext.'.length));
                    }
                }
            }
        }
    }

    const commands = compiled.commands;
    if (commands && typeof commands === 'object') {
        for (const list of Object.values(commands)) {
            if (!Array.isArray(list)) continue;
            for (const item of list) {
                const ref = item?.id;
                if (typeof ref === 'string' && isExtensionRef(ref)) {
                    slugs.add(ref.slice('ext.'.length));
                }
            }
        }
    }

    return slugs;
}

/**
 * Az office összes (nem archivált) workflow-ját átfutja, és minden
 * extension-slug-hoz visszaadja a hivatkozó workflow-k név-listáját. A
 * `compiled` JSON-string vagy object lehet a doc-on; mindkét alakot
 * elfogadjuk. Hibatűrő: a parse-fail vagy non-canonical alakot a
 * `unparseable[]` listába gyűjti, hogy a UI jelezze a felhasználónak —
 * különben a "0 workflow hivatkozik rá" badge silent under-report
 * volna malformed compiled-on (Codex stop-time M3 fix).
 *
 * @returns {{ refs: Map<string, string[]>, unparseable: string[] }}
 */
function buildWorkflowReferencesBySlug(workflows) {
    const refs = new Map();
    const unparseable = [];
    if (!Array.isArray(workflows)) return { refs, unparseable };
    for (const wf of workflows) {
        if (wf?.archivedAt) continue;
        let compiled = wf?.compiled;
        if (typeof compiled === 'string') {
            try { compiled = JSON.parse(compiled); }
            catch {
                unparseable.push(wf.name || wf.$id);
                continue;
            }
        }
        if (!compiled || typeof compiled !== 'object') {
            unparseable.push(wf.name || wf.$id);
            continue;
        }
        const slugs = collectExtensionSlugsFromCompiled(compiled);
        for (const slug of slugs) {
            const list = refs.get(slug) || [];
            list.push(wf.name || wf.$id);
            refs.set(slug, list);
        }
    }
    return { refs, unparseable };
}

/**
 * @param {Object} props
 * @param {Object} props.office — a szerkesztőség rekord
 * @param {Array} props.extensions — az office összes workflow extension-e (archivált is)
 * @param {Array} props.workflows — az office összes (nem archivált) workflow-ja a referenced-by-warning-hoz
 * @param {boolean} props.isLoading
 * @param {boolean} props.isOrgAdmin — UI permission gate (Codex 4-es pont): a "+" gomb csak admin-nak
 * @param {() => Promise<void>} props.onReload
 */
export default function WorkflowExtensionsTab({
    office,
    extensions,
    workflows,
    isLoading,
    isOrgAdmin,
    onReload
}) {
    const { archiveWorkflowExtension, restoreWorkflowExtension } = useAuth();
    const { openModal } = useModal();
    const confirm = useConfirm();

    const [actionPending, setActionPending] = useState(null);
    const [actionError, setActionError] = useState('');
    const [showArchived, setShowArchived] = useState(false);

    // ── Derived: workflow-referencia szám / extension ───────────────────────
    const { refs: workflowRefsBySlug, unparseable: unparseableWorkflows } = useMemo(
        () => buildWorkflowReferencesBySlug(workflows),
        [workflows]
    );

    const visibleExtensions = useMemo(() => {
        return (extensions || []).filter((ext) => showArchived || !ext.archivedAt);
    }, [extensions, showArchived]);

    const archivedCount = useMemo(
        () => (extensions || []).reduce((acc, ext) => acc + (ext.archivedAt ? 1 : 0), 0),
        [extensions]
    );

    // ── Handlers ────────────────────────────────────────────────────────────
    function openCreateEditor() {
        openModal(
            <WorkflowExtensionEditor
                editorialOfficeId={office.$id}
                onSaved={onReload}
            />,
            { size: 'lg', title: 'Új bővítmény' }
        );
    }

    function openEditEditor(ext) {
        openModal(
            <WorkflowExtensionEditor
                editorialOfficeId={office.$id}
                existing={ext}
                onSaved={onReload}
            />,
            { size: 'lg', title: `Bővítmény szerkesztése: ${ext.name}` }
        );
    }

    async function handleArchive(ext) {
        const referencingWorkflows = workflowRefsBySlug.get(ext.slug) || [];
        const ok = await confirm({
            title: 'Bővítmény archiválása',
            message: (
                <>
                    <p>
                        A(z) <strong>„{ext.name}"</strong> (<code>ext.{ext.slug}</code>){' '}
                        bővítmény <strong>archiválódik</strong>. A Plugin runtime az
                        archivált bővítményeket a registry build-ben nem oldja fel,
                        így a Designer választható listájából eltűnik.
                    </p>
                    {referencingWorkflows.length > 0 ? (
                        <p>
                            <strong>{referencingWorkflows.length} aktuális workflow hivatkozik rá</strong>:{' '}
                            {referencingWorkflows.slice(0, 5).join(', ')}
                            {referencingWorkflows.length > 5 ? `, … (+${referencingWorkflows.length - 5})` : ''}.
                            Új aktiválás 422 hibára fut, amíg vissza nem állítod, vagy a
                            workflow-ból ki nem szeded a hivatkozást.
                        </p>
                    ) : (
                        <p>
                            Egyetlen aktuális workflow sem hivatkozik rá.
                        </p>
                    )}
                    {/* A 0 workflow-ref nem jelenti, hogy a kód senkinél nem fut:
                        snapshot-os pub-ok az immutable snapshot-on futnak tovább. */}
                    <p>
                        <strong>Figyelem</strong>: ha van olyan aktivált publikáció,
                        amely az archiválandó bővítményt korábban már rögzítette a
                        saját <code>compiledExtensionSnapshot</code>-jában, az
                        immutable snapshot-on <strong>továbbra is futtatja</strong>{' '}
                        a kódot — az archiválás csak az új aktiválásokat blokkolja.
                    </p>
                </>
            ),
            confirmLabel: 'Archiválás',
            cancelLabel: 'Mégse',
            variant: 'danger'
        });
        if (!ok) return;

        setActionPending(`archive:${ext.$id}`);
        setActionError('');
        try {
            await archiveWorkflowExtension(ext.$id, ext.$updatedAt);
            await onReload();
        } catch (err) {
            setActionError(errorMessage(err.message || err.code || ''));
        } finally {
            setActionPending(null);
        }
    }

    async function handleRestore(ext) {
        setActionPending(`restore:${ext.$id}`);
        setActionError('');
        try {
            await restoreWorkflowExtension(ext.$id, ext.$updatedAt);
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
                <div className="login-error workflow-extension-editor__error">{actionError}</div>
            )}

            {unparseableWorkflows.length > 0 && (
                <div className="permission-set-editor__warning permission-set-editor__warning--info">
                    ℹ {unparseableWorkflows.length} workflow <code>compiled</code> JSON-je
                    nem volt parse-olható — ezeknél nem tudjuk megmondani, hogy
                    hivatkoznak-e bármelyik bővítményre. Az érintettek:&nbsp;
                    {unparseableWorkflows.slice(0, 3).map((name, i) => (
                        <code key={i}>
                            {name}{i < Math.min(unparseableWorkflows.length, 3) - 1 ? ',' : ''}
                        </code>
                    ))}
                    {unparseableWorkflows.length > 3 && <> +{unparseableWorkflows.length - 3} további</>}.
                    Archiválás előtt érdemes a Workflow Designerből újra-mentened ezeket.
                </div>
            )}

            <div className="permission-sets-toolbar">
                <h3 className="permission-sets-toolbar__title">
                    Bővítmények{' '}
                    <span className="permission-sets-toolbar__count">
                        ({visibleExtensions.length}{archivedCount > 0 ? ` / ${(extensions || []).length}` : ''})
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
                        + Új bővítmény
                    </button>
                )}
            </div>

            {visibleExtensions.length === 0 ? (
                <p className="permission-sets-empty">
                    {(extensions || []).length === 0
                        ? 'Nincs még bővítmény ebben a szerkesztőségben. Hozz létre egyet a „+ Új bővítmény" gombbal — a Workflow Designerben validátorként vagy parancsként hivatkozható.'
                        : 'Minden bővítmény archivált — pipáld be az „Archiváltak megjelenítése" jelölőt a megtekintéshez.'}
                </p>
            ) : (
                <ul className="permission-sets-list">
                    {visibleExtensions.map((ext) => {
                        const isArchived = !!ext.archivedAt;
                        const refList = workflowRefsBySlug.get(ext.slug) || [];
                        const isPending = actionPending === `archive:${ext.$id}` ||
                                          actionPending === `restore:${ext.$id}`;

                        return (
                            <li
                                key={ext.$id}
                                className={`permission-sets-row${isArchived ? ' permission-sets-row--archived' : ''}`}
                            >
                                <div className="permission-sets-row__header">
                                    <span className="permission-sets-row__name">{ext.name}</span>
                                    <span className="permission-sets-row__slug">
                                        (ext.{ext.slug})
                                    </span>
                                    <span className="eo-chip">
                                        {ext.kind === 'validator' ? 'Validátor' : 'Parancs'}
                                    </span>
                                    <span className="eo-chip">
                                        {refList.length} workflow hivatkozik rá
                                    </span>
                                    {isArchived && (
                                        <span className="eo-chip">archivált</span>
                                    )}
                                    {isOrgAdmin && (
                                        <div className="permission-sets-row__actions">
                                            {!isArchived && (
                                                <button
                                                    type="button"
                                                    onClick={() => openEditEditor(ext)}
                                                    disabled={!!actionPending}
                                                    className="btn-ghost-sm"
                                                >Szerkesztés</button>
                                            )}
                                            {!isArchived && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleArchive(ext)}
                                                    disabled={isPending}
                                                    className="btn-danger-outline-sm"
                                                >
                                                    {actionPending === `archive:${ext.$id}` ? '...' : 'Archiválás'}
                                                </button>
                                            )}
                                            {isArchived && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleRestore(ext)}
                                                    disabled={isPending}
                                                    className="btn-primary-sm"
                                                >
                                                    {actionPending === `restore:${ext.$id}` ? '...' : 'Visszaállítás'}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                                {refList.length > 0 && (
                                    <div className="permission-sets-row__assigned">
                                        {refList.slice(0, 6).map((name, i) => (
                                            <span
                                                key={i}
                                                className="permission-sets-row__assigned-name"
                                            >{name}</span>
                                        ))}
                                        {refList.length > 6 && (
                                            <span className="permission-sets-row__assigned-name">
                                                +{refList.length - 6}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {!isOrgAdmin && (
                <p className="permission-sets-non-admin-hint">
                    Bővítmény létrehozásához / módosításához szervezeti admin jogosultság szükséges.
                </p>
            )}
        </>
    );
}
