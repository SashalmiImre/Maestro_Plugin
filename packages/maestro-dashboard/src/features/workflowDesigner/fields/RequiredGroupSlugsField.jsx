/**
 * Maestro Dashboard — RequiredGroupSlugsField (ADR 0008 / A.4.6)
 *
 * A workflow `compiled.requiredGroupSlugs[]` kanonikus slug-listájának
 * szerkesztője. Egy sor = egy slug + label + description + color +
 * isContributorGroup + isLeaderGroup.
 *
 * **Slug immutable új sornál is** mentés után: új sor hozzáadásakor a slug
 * szerkeszthető (és valididál a CF regex-szel `^[a-z0-9]+(?:-[a-z0-9]+)*$`),
 * de mentett munkamenetben már stabil hivatkozás (a workflow másik mezője
 * — pl. `transitions.allowedGroups` — hivatkozhatja). Ezért a UI a
 * "draft" state-ben is csak akkor enged slug-átnevezést, ha a slug még
 * nem hivatkozott más graph-mezőből (graph-szintű check) — ezt a hard
 * contract validátor fogja a save-time-on jelezni `unknown_group_slug`-gal,
 * ezért itt nem dupliáljuk a check-et.
 *
 * **Compiler integráció**: a `metadata.requiredGroupSlugs[]`-t változtatja;
 * a compiler `graphToCompiled()` ebből származtatja a `compiled.contributorGroups[]`
 * és `compiled.leaderGroups[]` mezőket (autogenerált — nem a felhasználó
 * szerkeszti).
 */

import React, { useState, useCallback } from 'react';
import { slugify, SLUG_CONSTRAINTS } from '../../../utils/slugify.js';
import { COLOR_PRESETS } from '../../../utils/colorPresets.js';

const { SLUG_REGEX } = SLUG_CONSTRAINTS;

/**
 * @param {Object} props
 * @param {Array<{ slug: string, label: string, description?: string, color?: string, isContributorGroup?: boolean, isLeaderGroup?: boolean }>} props.value
 * @param {(next: Array) => void} props.onChange
 * @param {boolean} [props.disabled=false]
 */
export default function RequiredGroupSlugsField({ value = [], onChange, disabled = false }) {
    const [adding, setAdding] = useState(false);
    const [draftLabel, setDraftLabel] = useState('');
    const [draftSlug, setDraftSlug] = useState('');
    const [draftSlugTouched, setDraftSlugTouched] = useState(false);
    const [error, setError] = useState('');

    // ── Mutátorok ───────────────────────────────────────────────────────────

    const updateRow = useCallback((idx, patch) => {
        const next = value.map((row, i) => i === idx ? { ...row, ...patch } : row);
        onChange(next);
    }, [value, onChange]);

    const removeRow = useCallback((idx) => {
        onChange(value.filter((_, i) => i !== idx));
    }, [value, onChange]);

    function handleNewLabelChange(v) {
        setDraftLabel(v);
        if (!draftSlugTouched) setDraftSlug(slugify(v));
    }

    function handleNewSlugChange(v) {
        setDraftSlug(v);
        setDraftSlugTouched(true);
    }

    function commitNew() {
        const trimmedLabel = draftLabel.trim();
        const trimmedSlug = draftSlug.trim();
        if (!trimmedLabel) {
            setError('A label nem lehet üres.');
            return;
        }
        if (!SLUG_REGEX.test(trimmedSlug)) {
            setError('A slug csak kisbetűt, számot és kötőjelet tartalmazhat (kb-style).');
            return;
        }
        if (value.some((r) => r.slug === trimmedSlug)) {
            setError(`A "${trimmedSlug}" slug már szerepel a listában.`);
            return;
        }
        onChange([
            ...value,
            {
                slug: trimmedSlug,
                label: trimmedLabel,
                description: '',
                color: '',
                isContributorGroup: false,
                isLeaderGroup: false
            }
        ]);
        setDraftLabel('');
        setDraftSlug('');
        setDraftSlugTouched(false);
        setError('');
        setAdding(false);
    }

    function cancelNew() {
        setDraftLabel('');
        setDraftSlug('');
        setDraftSlugTouched(false);
        setError('');
        setAdding(false);
    }

    // ── Render ──────────────────────────────────────────────────────────────

    return (
        <div className="designer-field">
            <label className="designer-field__label">
                Felhasználó-csoportok (<code>requiredGroupSlugs</code>)
            </label>
            <p className="designer-field__help">
                A workflow által hivatkozott felhasználó-csoportok kanonikus listája.
                A <code>statePermissions</code>, <code>transitions.allowedGroups</code> és
                hasonló mezők innen választhatnak slug-ot. Mentéskor a hard contract
                validátor (<code>unknown_group_slug</code>) ellenőrzi, hogy minden hivatkozott
                slug szerepel itt. A <code>contributor</code> / <code>leader</code> flag-ek
                a runtime jogosultság-bypass-okhoz.
            </p>

            {error && <div className="login-error required-group-slugs-field__error">{error}</div>}

            {value.length === 0 && !adding && (
                <p className="designer-field__empty required-group-slugs-field__empty">
                    Nincsenek csoportok. Adj hozzá legalább egyet, hogy a state-ek és átmenetek
                    hivatkozhassanak rá.
                </p>
            )}

            <ul className="required-group-slugs-field__list">
                {value.map((row, idx) => (
                    <li
                        key={row.slug || `new-${idx}`}
                        className="required-group-slugs-field__row"
                    >
                        <span
                            title="Szín"
                            className="required-group-slugs-field__swatch"
                            style={row.color ? { background: row.color } : undefined}
                        />
                        <input
                            type="text"
                            value={row.label || ''}
                            onChange={(e) => updateRow(idx, { label: e.target.value })}
                            placeholder="Label"
                            disabled={disabled}
                            maxLength={128}
                            className="eo-input required-group-slugs-field__label-input"
                        />
                        <code title="Slug — immutable mentés után" className="required-group-slugs-field__slug-display">
                            {row.slug}
                        </code>
                        <input
                            type="color"
                            value={row.color || '#cccccc'}
                            onChange={(e) => updateRow(idx, { color: e.target.value })}
                            disabled={disabled}
                            title="Szín"
                            className="required-group-slugs-field__color-input"
                        />
                        <label title="Közreműködő csoport (workflow-runtime)" className="required-group-slugs-field__flag">
                            <input
                                type="checkbox"
                                checked={!!row.isContributorGroup}
                                onChange={(e) => updateRow(idx, { isContributorGroup: e.target.checked })}
                                disabled={disabled}
                            />
                            contrib
                        </label>
                        <label title="Vezető csoport (workflow-runtime guard-bypass)" className="required-group-slugs-field__flag">
                            <input
                                type="checkbox"
                                checked={!!row.isLeaderGroup}
                                onChange={(e) => updateRow(idx, { isLeaderGroup: e.target.checked })}
                                disabled={disabled}
                            />
                            leader
                        </label>
                        <button
                            type="button"
                            onClick={() => removeRow(idx)}
                            disabled={disabled}
                            title="Törlés a listából (a save-time validátor blokkol, ha más mező hivatkozza)"
                            className="btn-ghost-sm required-group-slugs-field__remove"
                        >×</button>

                        <input
                            type="text"
                            value={row.description || ''}
                            onChange={(e) => updateRow(idx, { description: e.target.value })}
                            placeholder="Leírás (opcionális)"
                            disabled={disabled}
                            maxLength={500}
                            className="eo-input required-group-slugs-field__description-input"
                        />
                        <div className="required-group-slugs-field__color-presets">
                            {COLOR_PRESETS.map((c) => (
                                <span
                                    key={c}
                                    onClick={() => !disabled && updateRow(idx, { color: c })}
                                    title={c}
                                    aria-disabled={disabled || undefined}
                                    className="required-group-slugs-field__color-preset"
                                    style={{ background: c }}
                                />
                            ))}
                        </div>
                    </li>
                ))}
            </ul>

            {adding ? (
                <div className="required-group-slugs-field__add-form">
                    <input
                        type="text"
                        autoFocus
                        value={draftLabel}
                        onChange={(e) => handleNewLabelChange(e.target.value)}
                        placeholder="Label (pl. Szerkesztők)"
                        disabled={disabled}
                        maxLength={128}
                        className="eo-input"
                    />
                    <input
                        type="text"
                        value={draftSlug}
                        onChange={(e) => handleNewSlugChange(e.target.value)}
                        placeholder="slug (pl. editors)"
                        pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
                        disabled={disabled}
                        maxLength={64}
                        className="eo-input"
                    />
                    <div className="required-group-slugs-field__add-actions">
                        <button
                            type="button"
                            onClick={commitNew}
                            disabled={disabled}
                            className="btn-primary-sm"
                        >Hozzáad</button>
                        <button
                            type="button"
                            onClick={cancelNew}
                            disabled={disabled}
                            className="btn-secondary-sm"
                        >Mégse</button>
                    </div>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={() => setAdding(true)}
                    disabled={disabled}
                    className="btn-primary-sm"
                >+ Új csoport-slug</button>
            )}
        </div>
    );
}
