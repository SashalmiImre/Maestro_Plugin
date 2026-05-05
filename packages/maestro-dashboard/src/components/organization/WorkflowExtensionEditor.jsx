/**
 * Maestro Dashboard — WorkflowExtensionEditor (B.5.2, ADR 0007 Phase 0)
 *
 * Workflow extension létrehozó / szerkesztő modal-tartalom. A
 * `WorkflowExtensionsTab` nyitja meg `useModal().openModal(...)`-szal.
 *
 * **Phase 0 hatókör (B.0.4 + B.5)**:
 *   - `kind` (validator | command) szerkeszthető — bár a Plugin runtime
 *     más-más dispatch-et hív, a slug az `ext.<slug>` ref-ben mindkét
 *     kindra azonos formátumú.
 *   - `scope` UI-ban NEM jelenik meg (server-side enum csak `'article'`).
 *   - `visibility` UI-ban NEM jelenik meg (server-side enum csak
 *     `'editorial_office'` a CRUD action-ben). Phase 1+ a `extension.share`
 *     slug bevezetésével válik élessé.
 *
 * **Slug immutable**: új létrehozáskor szerkeszthető (auto-generálódik a
 * name-ből, override-olható), létezőnél read-only — pont mint a permission
 * set / group / workflow slug-jainál.
 *
 * **Code mező**: monospace textarea (line-numbers nélkül; CodeMirror
 * Phase 0-ban overengineering). Server-side acorn ECMA3 pre-parse + AST
 * top-level `function maestroExtension(input)` ellenőrzés. Parse-hiba
 * line/column-nal jön — a UI a textarea-t scroll-olja a hibás sorra +
 * fókuszt állít rá.
 *
 * **Implicit restore**: a B.3.1 szándékosan nem ad külön
 * `restore_workflow_extension` action-t — az `update_workflow_extension`
 * `archivedAt: null`-lal triggereli a visszaállítást, **dupla auth**
 * (`extension.edit` + `extension.archive`) kellene hozzá. A UI a
 * `WorkflowExtensionsTab`-on explicit "Visszaállítás" gombot ad (Codex
 * tervi review fix), nem keveri össze az editor-ral.
 *
 * **TOCTOU guard**: szerkesztéskor az `expectedUpdatedAt` a meglévő doc
 * `$updatedAt`-jéből jön — `version_conflict` 409 esetén az
 * `errorMessage()` mapping mutatja az "újratöltés szükséges" üzenetet.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import {
    EXTENSION_KIND_VALUES,
    EXTENSION_NAME_MAX_LENGTH,
    EXTENSION_SLUG_MAX_LENGTH,
    MAESTRO_EXTENSION_GLOBAL_NAME
} from '@shared/extensionContract.js';
import { slugify, SLUG_CONSTRAINTS } from '../../utils/slugify.js';
import { mapErrorReason } from '../../utils/inviteFunctionErrorMessages.js';

const { SLUG_REGEX } = SLUG_CONSTRAINTS;

// Operatív cap a server `EXTENSION_CODE_MAX_LENGTH`-szel betűre egyező —
// helpers/constants.js 256 KB. Ha a séma 1 MB-ot enged, az operatív cap
// szigorúbb (Phase 0 tipikus extension 5-50 KB).
const EXTENSION_CODE_MAX_LENGTH = 262144;

/**
 * A user által létrehozott új extension `code` mezőjének kiindulási
 * sablonja. A kötelező top-level `function maestroExtension(input)`
 * deklarációt mutatja, amit a server AST pre-parse-szel ellenőriz —
 * nélküle 400 `missing_maestro_extension_function`. A kommentek a
 * Phase 0 JSON I/O kontraktust dokumentálják (`extensionContract.js`).
 */
function defaultCodeTemplate(kind) {
    const isValidator = kind === 'validator';
    const inputSig = isValidator
        ? '// input.article — a vizsgált cikk objektuma'
        : '// input.article — a parancs forrás cikk objektuma\n    // input.publicationRoot — a publikáció root path-ja (vagy null)';
    const returnSig = isValidator
        ? `return {
        isValid: true,        // boolean
        errors: [],           // string[]
        warnings: []          // string[]
    };`
        : `return {
        success: true,        // boolean
        // error: '...',      // opcionális string ha success=false
        // message: '...'     // opcionális string a UI toast-hoz
    };`;
    return `// Maestro workflow ${isValidator ? 'validátor' : 'parancs'} bővítmény (Phase 0).
// A top-level "${MAESTRO_EXTENSION_GLOBAL_NAME}(input)" függvény a Plugin
// runtime egyetlen belépési pontja — ne nevezd át, ne ágyazd be másik
// függvénybe (a server AST pre-parse 400 hibát ad).

function ${MAESTRO_EXTENSION_GLOBAL_NAME}(input) {
    ${inputSig}

    ${returnSig}
}
`;
}

/**
 * Reason / err.message → user-friendly üzenet. A server `errors[]` array-t
 * ad `invalid_extension_code`-on, ezt külön ágban olvassuk ki, hogy a
 * line/column info ne vesszen el.
 */
function errorMessage(reason, errors) {
    return mapErrorReason(reason, {
        invalid_extension_code: () => {
            if (Array.isArray(errors) && errors.length > 0) {
                const e = errors[0];
                if (e.code === 'syntax_error' && e.line) {
                    return `ExtendScript szintaxis hiba a ${e.line}. sor ${
                        (e.column ?? 0) + 1
                    }. oszlopában: ${e.message || 'parse error'}`;
                }
                if (e.code === 'missing_maestro_extension_function') {
                    return `Hiányzik a top-level "function ${MAESTRO_EXTENSION_GLOBAL_NAME}(input)" deklaráció.`;
                }
                if (e.code === 'duplicate_maestro_extension_function') {
                    return `Több "function ${MAESTRO_EXTENSION_GLOBAL_NAME}" deklaráció — pontosan egy lehet.`;
                }
                if (e.code === 'code_too_long') return e.message;
                if (e.code === 'empty_code') return 'Az extension code nem lehet üres.';
                if (e.code === 'invalid_code_type') return e.message;
                return e.message || 'Érvénytelen extension code.';
            }
            return 'Érvénytelen extension code.';
        },
        extension_slug_taken: 'Ezzel a slug-gal már létezik bővítmény ebben a szerkesztőségben.',
        slug_immutable: 'A slug nem módosítható.',
        invalid_slug: 'A slug csak kisbetűt, számot és kötőjelet tartalmazhat (kb-style).',
        invalid_kind: 'Érvénytelen típus (engedett: validator vagy command).',
        invalid_scope: 'Érvénytelen scope (Phase 0: csak article).',
        unsupported_visibility:
            'Phase 0-ban csak szerkesztőség-szintű (editorial_office) láthatóság engedett.',
        version_conflict:
            'Időközben valaki más is módosította ezt a bővítményt. Töltsd újra és próbáld meg újra.',
        extension_not_found: 'A bővítmény nem található (talán közben archiválva / törölve lett).'
    });
}

/**
 * @param {Object} props
 * @param {string} props.editorialOfficeId — az új / meglévő extension scope-ja
 * @param {Object|null} [props.existing] — szerkesztés esetén a meglévő extension doc
 * @param {() => Promise<void>} props.onSaved — sikeres mentés után a parent reload-ja
 */
export default function WorkflowExtensionEditor({ editorialOfficeId, existing = null, onSaved }) {
    const isEdit = !!existing;
    const { createWorkflowExtension, updateWorkflowExtension } = useAuth();
    const { closeModal } = useModal();

    const [name, setName] = useState(existing?.name || '');
    const [slug, setSlug] = useState(existing?.slug || '');
    const [slugTouched, setSlugTouched] = useState(isEdit); // szerkesztéskor ne auto-suggest-eljünk
    const [kind, setKind] = useState(existing?.kind || 'validator');
    const [code, setCode] = useState(
        existing?.code ?? defaultCodeTemplate(existing?.kind || 'validator')
    );

    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [parseErrorLine, setParseErrorLine] = useState(null);

    const codeRef = useRef(null);

    // Ha a parse hiba beállította a `parseErrorLine`-t, a textarea fókuszt és
    // selection-t kap a hibás sor elejére — a Codex blind spot fix-e.
    useEffect(() => {
        if (parseErrorLine == null || !codeRef.current) return;
        const ta = codeRef.current;
        const lines = code.split('\n');
        const lineIdx = Math.max(0, Math.min(parseErrorLine - 1, lines.length - 1));
        let offset = 0;
        for (let i = 0; i < lineIdx; i++) offset += lines[i].length + 1;
        try {
            ta.focus();
            ta.setSelectionRange(offset, offset + (lines[lineIdx]?.length || 0));
            // A textarea scrollTop kiszámítása vízkeresztül: a font-size
            // és line-height pontatlan, ezért a sor magasságát approximáljuk
            // (16px egy ~13px font + 1.4 line-height-tal).
            const lineHeight = 18;
            ta.scrollTop = Math.max(0, lineIdx * lineHeight - ta.clientHeight / 2);
        } catch {
            // setSelectionRange dobhat IE-szerűen rejtett edge-en, de
            // modern böngészőkben nem várt — fail-safe ignore.
        }
    }, [parseErrorLine, code]);

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

    function handleKindChange(newKind) {
        setKind(newKind);
        // Ha a code még az alapsablon (kötés a régi kindhoz), frissítjük a
        // sablont — különben a user sok ExtendScript-et veszítene egy
        // véletlen radio-kattintással.
        if (!isEdit && code === defaultCodeTemplate(kind)) {
            setCode(defaultCodeTemplate(newKind));
        }
    }

    async function handleSubmit(e) {
        e.preventDefault();
        if (submitting) return;

        const trimmedName = name.trim();
        const trimmedSlug = slug.trim();

        if (!trimmedName) {
            setError('A név kötelező.');
            return;
        }
        if (trimmedName.length > EXTENSION_NAME_MAX_LENGTH) {
            setError(`A név legfeljebb ${EXTENSION_NAME_MAX_LENGTH} karakter lehet.`);
            return;
        }
        if (!isEdit) {
            if (!trimmedSlug || !SLUG_REGEX.test(trimmedSlug)) {
                setError('A slug csak kisbetűt, számot és kötőjelet tartalmazhat (kb-style).');
                return;
            }
            if (trimmedSlug.length > EXTENSION_SLUG_MAX_LENGTH) {
                setError(`A slug legfeljebb ${EXTENSION_SLUG_MAX_LENGTH} karakter lehet.`);
                return;
            }
        }
        if (!EXTENSION_KIND_VALUES.includes(kind)) {
            setError('Érvénytelen típus.');
            return;
        }
        if (!code || !code.trim()) {
            setError('A kód nem lehet üres.');
            return;
        }
        if (code.length > EXTENSION_CODE_MAX_LENGTH) {
            setError(`A kód legfeljebb ${EXTENSION_CODE_MAX_LENGTH} karakter lehet.`);
            return;
        }

        setSubmitting(true);
        setError('');
        setParseErrorLine(null);
        try {
            if (isEdit) {
                // Slug NEM kerül a payload-ba (a server `slug_immutable`-ot adna).
                const patch = { name: trimmedName, kind, code };
                await updateWorkflowExtension(existing.$id, patch, existing.$updatedAt);
            } else {
                await createWorkflowExtension({
                    editorialOfficeId,
                    name: trimmedName,
                    slug: trimmedSlug,
                    kind,
                    code
                });
            }
            await onSaved?.();
            closeModal();
        } catch (err) {
            const reason = err.code || err.message || '';
            const errors = err.errors || err.response?.errors;
            setError(errorMessage(reason, errors));
            // Parse-hiba esetén a textarea-t a hibás sorra ugrasztjuk.
            if (Array.isArray(errors) && errors.length > 0 && errors[0].line) {
                setParseErrorLine(errors[0].line);
            }
        } finally {
            setSubmitting(false);
        }
    }

    // ── Origi-vs-current diff hint a Save gomb disabled state-jéhez ─────────
    // Új létrehozáskor a `code` mindig non-empty (default template) — a Codex
    // stop-time M2 fix: a default-template-tel egyező `code`-ot NEM tekintjük
    // dirty-nek, különben a Save gomb az első renderből aktív lenne és a user
    // azonnal kapna missing name/slug validation-error-t. Ehelyett legalább a
    // name vagy slug kitöltése (vagy a code template módosítása) kell.
    const isDirty = useMemo(() => {
        if (!isEdit) {
            const codeIsCustomized = code.trim() !== '' && code !== defaultCodeTemplate(kind);
            return Boolean(name.trim() || slug.trim() || codeIsCustomized);
        }
        return (
            name.trim() !== (existing.name || '') ||
            kind !== existing.kind ||
            code !== (existing.code || '')
        );
    }, [name, slug, kind, code, isEdit, existing]);

    return (
        <form onSubmit={handleSubmit} className="publication-form workflow-extension-editor">
            {error && (
                <div className="login-error workflow-extension-editor__error">{error}</div>
            )}

            <div className="workflow-extension-editor__row">
                <label className="eo-form-stack">
                    <span className="eo-form-stack__label eo-form-stack__label--upper">
                        Név <span className="eo-form-stack__required">*</span>
                    </span>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => handleNameChange(e.target.value)}
                        maxLength={EXTENSION_NAME_MAX_LENGTH}
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
                        maxLength={EXTENSION_SLUG_MAX_LENGTH}
                        readOnly={isEdit}
                        required
                        pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
                        className={`eo-input${isEdit ? ' eo-input--readonly' : ''}`}
                    />
                </label>
            </div>

            <div className="workflow-extension-editor__kind">
                <span className="eo-form-stack__label eo-form-stack__label--upper">
                    Típus <span className="eo-form-stack__required">*</span>
                </span>
                <div className="designer-field__chips" role="radiogroup" aria-label="Bővítmény típusa">
                    {EXTENSION_KIND_VALUES.map((k) => (
                        <button
                            key={k}
                            type="button"
                            role="radio"
                            aria-checked={kind === k}
                            className={`designer-chip ${kind === k ? 'designer-chip--active' : ''}`}
                            onClick={() => handleKindChange(k)}
                            disabled={isEdit}
                            title={isEdit
                                ? 'A típus szerkesztés közben nem módosítható (a hivatkozó workflow-k aktiváláskor extension_kind_mismatch-csel elszállnának). Ha kind-cserére van szükség, archiváld ezt és hozz létre újat.'
                                : k === 'validator'
                                    ? 'Validátor: cikk-alapú ellenőrzés. Visszaadja: { isValid, errors[], warnings[] }.'
                                    : 'Parancs: cikk-alapú akció. Visszaadja: { success, error?, message? }.'}
                        >
                            {k === 'validator' ? 'Validátor' : 'Parancs'}
                        </button>
                    ))}
                </div>
                <p className="workflow-extension-editor__kind-hint">
                    Phase 0 hatókör: a bővítmény scope-ja mindig <code>article</code>, láthatósága mindig{' '}
                    <code>editorial_office</code>. (A jövőbeli kibővítés ADR 0007 Phase 1+.)
                </p>
            </div>

            <label className="eo-form-stack workflow-extension-editor__code-label">
                <span className="eo-form-stack__label eo-form-stack__label--upper">
                    Kód (ExtendScript) <span className="eo-form-stack__required">*</span>
                    <span className="eo-form-stack__hint">
                        — ECMA3 / max {Math.round(EXTENSION_CODE_MAX_LENGTH / 1024)} KB
                    </span>
                </span>
                <textarea
                    ref={codeRef}
                    value={code}
                    onChange={(e) => {
                        setCode(e.target.value);
                        if (parseErrorLine != null) setParseErrorLine(null);
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    rows={20}
                    maxLength={EXTENSION_CODE_MAX_LENGTH}
                    className="eo-input workflow-extension-editor__code"
                />
            </label>

            <div className="modal-actions workflow-extension-editor__actions">
                <button
                    type="button"
                    onClick={closeModal}
                    disabled={submitting}
                    className="btn-secondary"
                >Mégse</button>
                <button
                    type="submit"
                    disabled={submitting || !isDirty}
                    className="btn-primary"
                >
                    {submitting ? 'Mentés…' : (isEdit ? 'Módosítások mentése' : 'Létrehozás')}
                </button>
            </div>
        </form>
    );
}
