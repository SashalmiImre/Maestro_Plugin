/**
 * Maestro Dashboard — PermissionSetEditor (ADR 0008 / A.4.4)
 *
 * Permission set létrehozó / szerkesztő modal-tartalom. A `PermissionSetsTab`
 * nyitja meg `useModal().openModal(<PermissionSetEditor ... />, ...)`-szal.
 *
 * **8 logikai csoport-fa + 38 checkbox** (PERMISSION_GROUPS a `maestro-shared/
 * permissions.js`-ben). A `permissionSets.permissions[]` mező CSAK office-scope
 * slug-okat tárolhat — az org-scope (`org.*`) slug-okat read-only / disabled
 * formában megjelenítjük, hogy a felhasználó tudja, mit ad meg az
 * `organizationMemberships.role` és mit a permission set:
 *
 *   - **Org-scope (5 slug)**: read-only, info-tooltipekkel ("ezt csak owner /
 *     admin role kapja, NEM permission set-en át").
 *   - **Office-scope (33 slug)**: szerkeszthető checkbox-ok.
 *
 * **Slug immutable**: új létrehozáskor szerkeszthető (auto-generálódik a
 * name-ből, de override-olható), létezőnél read-only.
 *
 * **TOCTOU guard**: szerkesztéskor a `expectedUpdatedAt` a meglévő doc
 * `$updatedAt`-jéből jön — `concurrent_modification` 409 esetén a
 * `errorMessage()` mapping mutatja az "újratöltés szükséges" üzenetet.
 */

import React, { useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import {
    PERMISSION_GROUPS,
    OFFICE_SCOPE_PERMISSION_SLUG_SET,
    ORG_SCOPE_PERMISSION_SLUG_SET
} from '@shared/permissions.js';
import { slugify, SLUG_CONSTRAINTS } from '../../utils/slugify.js';
import { mapErrorReason } from '../../utils/inviteFunctionErrorMessages.js';

const { SLUG_REGEX } = SLUG_CONSTRAINTS;

function errorMessage(reason, errors, slugs) {
    return mapErrorReason(reason, {
        invalid_slug: 'A slug csak kisbetűt, számot és kötőjelet tartalmazhat (kb-style).',
        slug_immutable: 'A jogosultság-csoport slug-ja nem szerkeszthető.',
        // A CF `permission_set_slug_taken` reason-t adja; a substring `slug_taken`
        // amúgy is matchel-né, de explicit override-bal egyértelmű.
        permission_set_slug_taken: 'Ez a slug már foglalt a szerkesztőségben.',
        slug_taken: 'Ez a slug már foglalt a szerkesztőségben.',
        name_taken: 'Ezen a néven már létezik jogosultság-csoport.',
        org_scope_slug_not_allowed: () => {
            const list = (slugs || []).join(', ');
            return `Az org-scope slug-okat nem lehet permission set-be tenni: ${list || 'org.*'}.`;
        },
        invalid_permissions: () => {
            const detail = (errors || []).map((e) => `${e.code}: ${e.slug}`).join('; ');
            return `Érvénytelen permission slug-ok: ${detail || 'lásd console'}.`;
        }
    });
}

/**
 * @param {Object} props
 * @param {string} props.editorialOfficeId — az új / meglévő set scope-ja
 * @param {Object|null} [props.existing] — szerkesztés esetén a meglévő set doc
 * @param {() => Promise<void>} props.onSaved — sikeres mentés után a parent reload-ja
 */
export default function PermissionSetEditor({ editorialOfficeId, existing = null, onSaved }) {
    const isEdit = !!existing;
    const { createPermissionSet, updatePermissionSet } = useAuth();
    const { closeModal } = useModal();

    const [name, setName] = useState(existing?.name || '');
    const [slug, setSlug] = useState(existing?.slug || '');
    const [slugTouched, setSlugTouched] = useState(isEdit); // szerkesztéskor ne auto-suggest-eljünk
    const [description, setDescription] = useState(existing?.description || '');

    // Harden review fix: a meglévő `permissions[]` tartalmazhat (a) legacy
    // `org.*` slug-ot — ezt KIZÁRJUK (server-side `validatePermissionSetSlugs`
    // 400 `org_scope_slug_not_allowed`-zal visszadobná) ÉS (b) frontend-
    // ismeretlen office-scope slug-ot (pl. server-side bevezetett új slug,
    // a dashboard még nincs deploy-olva). Az ismeretlen office-scope slug-okat
    // **megőrizzük** (`unknownButPreserved`), különben a save destruktív
    // törléssel járna új slug bevezetésekor (Codex baseline review M1).
    //
    // - `initialSelected`: csak a frontend-ismert office-scope slug-ok →
    //   ezekhez van checkbox-render a 8 csoport-fában.
    // - `unknownButPreserved`: ismeretlen (de NEM org.*) slug-ok → a save
    //   payload-ba bekerülnek; a server dönt érvényességéről.
    // - `droppedSlugs`: csak `org.*` slug-ok — ezeket biztosan kizárjuk
    //   (security boundary: org-scope NEM kerülhet permission set-be).
    const { initialSelected, unknownButPreserved, droppedSlugs } = useMemo(() => {
        const sel = new Set();
        const unknown = [];
        const dropped = [];
        if (Array.isArray(existing?.permissions)) {
            for (const s of existing.permissions) {
                if (typeof s !== 'string' || !s) continue;
                if (ORG_SCOPE_PERMISSION_SLUG_SET.has(s)) {
                    dropped.push(s);
                } else if (OFFICE_SCOPE_PERMISSION_SLUG_SET.has(s)) {
                    sel.add(s);
                } else {
                    // Ismeretlen slug — a frontend snapshot régi lehet a
                    // serverhez képest. Megőrizzük; a server validál.
                    unknown.push(s);
                }
            }
        }
        return { initialSelected: sel, unknownButPreserved: unknown, droppedSlugs: dropped };
    }, [existing]);

    const [selectedSlugs, setSelectedSlugs] = useState(initialSelected);

    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    // ── Auto-slug a name-ből (csak új létrehozáskor + ha még nem szerkesztették) ─
    function handleNameChange(value) {
        setName(value);
        if (!isEdit && !slugTouched) {
            setSlug(slugify(value));
        }
    }

    function handleSlugChange(value) {
        setSlug(value);
        setSlugTouched(true);
    }

    // ── Csoport-fa render adat ──────────────────────────────────────────────
    const groupRender = useMemo(() => {
        return PERMISSION_GROUPS.map((g) => {
            const isOrgScope = g.scope === 'org';
            const totalAvailable = g.slugs.filter((s) => OFFICE_SCOPE_PERMISSION_SLUG_SET.has(s)).length;
            const selectedCount = g.slugs.reduce(
                (acc, s) => acc + (selectedSlugs.has(s) ? 1 : 0),
                0
            );
            return { group: g, isOrgScope, totalAvailable, selectedCount };
        });
    }, [selectedSlugs]);

    // ── Toggle handlers ─────────────────────────────────────────────────────
    function toggleSlug(s) {
        setSelectedSlugs((prev) => {
            const next = new Set(prev);
            if (next.has(s)) next.delete(s);
            else next.add(s);
            return next;
        });
    }

    function toggleGroupAll(g) {
        // CSAK office-scope slug-ok a csoportból (az org-scope-ot szándékosan kihagyjuk).
        const officeSlugs = g.slugs.filter((s) => OFFICE_SCOPE_PERMISSION_SLUG_SET.has(s));
        if (officeSlugs.length === 0) return; // org-only csoport, nincs mit toggle-ölni
        const allSelected = officeSlugs.every((s) => selectedSlugs.has(s));
        setSelectedSlugs((prev) => {
            const next = new Set(prev);
            if (allSelected) {
                officeSlugs.forEach((s) => next.delete(s));
            } else {
                officeSlugs.forEach((s) => next.add(s));
            }
            return next;
        });
    }

    // ── Mentés ──────────────────────────────────────────────────────────────
    async function handleSubmit(e) {
        e.preventDefault();
        if (submitting) return;
        const trimmedName = name.trim();
        const trimmedSlug = slug.trim();
        const trimmedDesc = description.trim();

        if (!trimmedName) {
            setError('A név kötelező.');
            return;
        }
        if (!isEdit) {
            if (!trimmedSlug || !SLUG_REGEX.test(trimmedSlug)) {
                setError('A slug csak kisbetűt, számot és kötőjelet tartalmazhat (kb-style).');
                return;
            }
        }

        setSubmitting(true);
        setError('');
        try {
            // Az ismeretlen-de-megőrzött slug-okat (server-side újabb taxonómia
            // potenciális elemei) a save payload-jába belevesszük; a server
            // dönt érvényességéről. Az `org.*` slug-ok (`droppedSlugs`)
            // biztosan kizárva — security boundary.
            const permissions = [...selectedSlugs, ...unknownButPreserved];
            if (isEdit) {
                await updatePermissionSet(
                    existing.$id,
                    { name: trimmedName, description: trimmedDesc || null, permissions },
                    existing.$updatedAt // TOCTOU guard
                );
            } else {
                await createPermissionSet({
                    editorialOfficeId,
                    name: trimmedName,
                    slug: trimmedSlug,
                    description: trimmedDesc || null,
                    permissions
                });
            }
            await onSaved?.();
            closeModal();
        } catch (err) {
            setError(errorMessage(
                err.message || err.code || '',
                err.errors || err.response?.errors,
                err.slugs || err.response?.slugs
            ));
        } finally {
            setSubmitting(false);
        }
    }

    // ── Render ──────────────────────────────────────────────────────────────
    return (
        <form onSubmit={handleSubmit} className="publication-form permission-set-editor">
            {error && (
                <div className="login-error permission-set-editor__error">{error}</div>
            )}

            <div className="permission-set-editor__row">
                <label className="eo-form-stack">
                    <span className="eo-form-stack__label eo-form-stack__label--upper">
                        Név <span className="eo-form-stack__required">*</span>
                    </span>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => handleNameChange(e.target.value)}
                        maxLength={128}
                        required
                        autoFocus
                        className="eo-input"
                    />
                </label>
                <label className="eo-form-stack">
                    <span className="eo-form-stack__label eo-form-stack__label--upper">
                        Slug <span className="eo-form-stack__required">*</span>
                        {isEdit && (
                            <span className="eo-form-stack__hint">(immutable)</span>
                        )}
                    </span>
                    <input
                        type="text"
                        value={slug}
                        onChange={(e) => handleSlugChange(e.target.value)}
                        maxLength={64}
                        readOnly={isEdit}
                        required
                        pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
                        className={`eo-input${isEdit ? ' eo-input--readonly' : ''}`}
                    />
                </label>
            </div>

            <label className="eo-form-stack permission-set-editor__description">
                <span className="eo-form-stack__label eo-form-stack__label--upper">Leírás (opcionális)</span>
                <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={500}
                    rows={2}
                    className="eo-input eo-input--textarea"
                />
            </label>

            <div className="permission-set-editor__permissions">
                <h3 className="permission-set-editor__heading">
                    Permission slug-ok
                    <span className="eo-form-stack__hint">
                        ({selectedSlugs.size} / 33 kiválasztva)
                    </span>
                </h3>

                {droppedSlugs.length > 0 && (
                    <div className="permission-set-editor__warning permission-set-editor__warning--error">
                        ⚠ A meglévő rekord {droppedSlugs.length} <code>org.*</code>{' '}
                        slug-ot tartalmaz — ezek <strong>kizárva</strong>{' '}
                        (org-scope kizárólag az <code>organizationMemberships.role</code>-on át):&nbsp;
                        {droppedSlugs.map((s, i) => (
                            <code key={s}>
                                {s}{i < droppedSlugs.length - 1 ? ',' : ''}
                            </code>
                        ))}
                    </div>
                )}

                {unknownButPreserved.length > 0 && (
                    <div className="permission-set-editor__warning permission-set-editor__warning--info">
                        ℹ A rekord {unknownButPreserved.length} olyan slug-ot tartalmaz, amit ez a
                        Dashboard-build nem ismer (újabb server-side taxonómia eleme lehet).
                        Ezeket <strong>megőrizzük</strong> — a server dönt érvényességéről
                        mentéskor:&nbsp;
                        {unknownButPreserved.map((s, i) => (
                            <code key={s}>
                                {s}{i < unknownButPreserved.length - 1 ? ',' : ''}
                            </code>
                        ))}
                    </div>
                )}

                <div className="permission-set-editor__groups">
                    {groupRender.map(({ group, isOrgScope, totalAvailable, selectedCount }) => (
                        <PermissionGroupSection
                            key={group.id}
                            group={group}
                            isOrgScope={isOrgScope}
                            selectedSlugs={selectedSlugs}
                            selectedCount={selectedCount}
                            totalAvailable={totalAvailable}
                            onToggleSlug={toggleSlug}
                            onToggleAll={() => toggleGroupAll(group)}
                        />
                    ))}
                </div>
            </div>

            <div className="modal-actions permission-set-editor__actions">
                <button
                    type="button"
                    onClick={closeModal}
                    disabled={submitting}
                    className="btn-secondary"
                >Mégse</button>
                <button
                    type="submit"
                    disabled={submitting}
                    className="btn-primary"
                >
                    {submitting ? 'Mentés…' : (isEdit ? 'Módosítások mentése' : 'Létrehozás')}
                </button>
            </div>
        </form>
    );
}

/**
 * Egy logikai csoport szekció (collapsible, alapértelmezetten kibontva).
 */
function PermissionGroupSection({
    group, isOrgScope, selectedSlugs, selectedCount, totalAvailable, onToggleSlug, onToggleAll
}) {
    const [isOpen, setIsOpen] = useState(true);

    const sectionClass = `permission-set-group${isOrgScope ? ' permission-set-group--org-scope' : ''}`;
    const caretClass = `permission-set-group__caret${isOrgScope ? ' permission-set-group__caret--align-right' : ''}`;

    return (
        <section className={sectionClass}>
            <header
                onClick={() => setIsOpen((v) => !v)}
                className="permission-set-group__header"
            >
                <span className="permission-set-group__title">{group.label}</span>
                <span className={`eo-chip${isOrgScope ? ' eo-chip--leader' : ''}`}>
                    {isOrgScope ? 'org-scope (csak role-on át)' : `${selectedCount} / ${totalAvailable}`}
                </span>
                {!isOrgScope && totalAvailable > 0 && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onToggleAll(); }}
                        className="btn-ghost-sm permission-set-group__toggle-all"
                    >
                        {selectedCount === totalAvailable ? 'Mind kikapcs' : 'Mind be'}
                    </button>
                )}
                <span className={caretClass}>
                    {isOpen ? '▲' : '▼'}
                </span>
            </header>

            {isOpen && (
                <div className="permission-set-group__body">
                    {group.description && (
                        <p className="permission-set-group__description">{group.description}</p>
                    )}
                    {group.slugs.map((s) => {
                        const checked = selectedSlugs.has(s);
                        const disabled = isOrgScope; // org-scope soha nem kerülhet permission set-be
                        const rowClass = `permission-set-group__slug-row${disabled ? ' permission-set-group__slug-row--locked' : ''}`;
                        return (
                            <label
                                key={s}
                                title={disabled ? 'Ezt a slug-ot kizárólag az organizationMemberships.role adja (owner/admin) — soha nem tárolható permission set-ben.' : undefined}
                                className={rowClass}
                            >
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={disabled}
                                    onChange={() => !disabled && onToggleSlug(s)}
                                />
                                <code className="permission-set-group__slug-code">{s}</code>
                            </label>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
