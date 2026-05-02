/**
 * Maestro Dashboard — CreateWorkflowModal
 *
 * Új workflow létrehozása a design rendszerrel konzisztens modal-ban. A
 * korábbi `window.prompt()` hívásokat váltja ki (WorkflowLibraryPanel +
 * WorkflowDesignerPage "+ Új workflow" gombjaiból).
 *
 * Mezők:
 *   - Név (kötelező, max 128 karakter)
 *   - JSON import (opcionális) — egy korábban exportált workflow fájl
 *     beolvasása, a létrehozott workflow default compiled tartalma helyett
 *     az importált tartalom kerül mentésre (version=1).
 *
 * Kétlépcsős create-from-JSON flow:
 *   1. `createWorkflow(officeId, name)` — a CF default compiled + graph-fel
 *      jelöli meg az új doc-ot (version=1).
 *   2. Ha JSON import történt, `saveWorkflow(..., imported.compiled,
 *      imported.graph, 1)` felülírja a tartalmat. Ha ez elbukik, warning
 *      toast jelzi, hogy a workflow létrejött (default tartalommal), de a
 *      manual import-ot a designerben kell elvégezni.
 *
 * A `parseImportFile` validálja a `maestro_workflow_export: true` marker-t
 * és a `compiled.states` jelenlétét. A verzió/migrációs ellenőrzések
 * későbbi iterációk hatáskörében vannak.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { createWorkflow, saveWorkflow } from '../../features/workflowDesigner/api.js';
import { parseImportFile } from '../../features/workflowDesigner/exportImport.js';
import { normalizeAndValidateImport } from '../../features/workflowDesigner/compiler.js';
import { summarizeValidationErrors } from '@shared/compiledValidator.js';
import { workflowPath } from '../../routes/paths.js';

const NAME_MAX = 128;

/**
 * @param {Object} props
 * @param {string} props.editorialOfficeId — a létrehozás helye
 * @param {boolean} [props.navigateOnSuccess=true] — sikeres create után navigáljon-e a designerre
 */
export default function CreateWorkflowModal({ editorialOfficeId, navigateOnSuccess = true }) {
    const navigate = useNavigate();
    const { closeModal } = useModal();
    const { showToast } = useToast();

    const [name, setName] = useState('');
    const [touched, setTouched] = useState(false);
    const [submitError, setSubmitError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const [importedData, setImportedData] = useState(null); // { compiled, graph, fileName }
    const [importError, setImportError] = useState('');
    // Parse-in-flight state: a Submit gombot blokkolja, amíg egy import-fájl
    // parse-olódik. Különben a user a parse await ideje alatt IMPORT NÉLKÜL
    // hozhatna létre workflow-t — a háta mögött dobódna a kiválasztott fájl.
    const [isParsingImport, setIsParsingImport] = useState(false);
    const fileInputRef = useRef(null);
    // Out-of-order parse race-guard: két gyors fájlválasztás (lassú→gyors
    // completion) különben stale `importedData`-t commit-olna. Unmount-kor
    // is bumpoljuk, hogy a modal-bezárás közbeni in-flight parse callback ne
    // hívjon setState-et az unmount utáni állapoton.
    const parseSeqRef = useRef(0);
    useEffect(() => () => { parseSeqRef.current++; }, []);

    const trimmedName = name.trim();
    const nameError = useMemo(() => {
        if (!trimmedName) return 'A név megadása kötelező.';
        if (trimmedName.length > NAME_MAX) return `A név legfeljebb ${NAME_MAX} karakter lehet.`;
        return '';
    }, [trimmedName]);

    const hasNameError = touched && !!nameError;
    const canSubmit = !nameError && !isSubmitting && !isParsingImport;

    async function handleFileChange(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        // Reset + új seq-szám + parse-in-flight flag. A `canSubmit` figyel az
        // `isParsingImport`-ra, így a Submit gomb blokkolt amíg a parse fut.
        const seq = ++parseSeqRef.current;
        setImportError('');
        setImportedData(null);
        setIsParsingImport(true);

        let compiled, graph, error;
        try {
            ({ compiled, graph, error } = await parseImportFile(file));
        } finally {
            // Csak az utolsó parse takarítja a flag-et — különben egy újabb
            // (közben elindult) parse korai false-jával eltüntetnénk a guardot.
            if (seq === parseSeqRef.current) setIsParsingImport(false);
        }

        if (seq !== parseSeqRef.current) return;
        if (error) {
            setImportError(error);
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        setImportedData({ compiled, graph, fileName: file.name });
    }

    function clearImport() {
        setImportedData(null);
        setImportError('');
        if (fileInputRef.current) fileInputRef.current.value = '';
    }

    function triggerFilePicker() {
        fileInputRef.current?.click();
    }

    async function handleSubmit(e) {
        e?.preventDefault?.();
        setTouched(true);
        if (!canSubmit) return;
        if (!editorialOfficeId) {
            setSubmitError('Nincs aktív szerkesztőség.');
            return;
        }

        setIsSubmitting(true);
        setSubmitError('');

        // Pre-validáció a `createWorkflow` ELŐTT — különben érvénytelen
        // import árva default workflow-t hagyna a DB-ben (Codex stop-time
        // review 2026-05-02).
        let normalizedCompiled = null;
        let normalizedGraph = null;
        if (importedData) {
            const result = normalizeAndValidateImport(importedData.compiled, importedData.graph);
            if (!result.ok) {
                setSubmitError(
                    `Az importált fájl szerkezete érvénytelen: ${result.structuralError}. Ellenőrizd a JSON tartalmát és próbáld újra.`
                );
                setIsSubmitting(false);
                return;
            }
            if (!result.validation.valid) {
                setSubmitError(
                    `Az importált workflow érvénytelen csoport-hivatkozást tartalmaz: ${summarizeValidationErrors(result.validation)} Javítsd a fájlt és tölts fel újat, vagy importálás nélkül hozd létre a workflow-t.`
                );
                setIsSubmitting(false);
                return;
            }
            normalizedCompiled = result.normalizedCompiled;
            normalizedGraph = result.normalizedGraph;
        }

        try {
            // 1. Create — default compiled + graph (version=1)
            const created = await createWorkflow(editorialOfficeId, trimmedName);

            // 2. Optional overwrite az importált tartalommal (már validált)
            if (importedData) {
                try {
                    await saveWorkflow(
                        editorialOfficeId,
                        created.workflowId,
                        normalizedCompiled,
                        normalizedGraph,
                        1
                    );
                    showToast(`„${created.name}" létrehozva és importálva.`, 'success');
                } catch (saveErr) {
                    console.error('[CreateWorkflowModal] Import mentés sikertelen:', saveErr);
                    showToast(
                        `„${created.name}" létrejött, de az importálás sikertelen volt. Nyisd meg és próbáld újra az Import gombbal.`,
                        'warning',
                        8000
                    );
                }
            } else {
                showToast(`„${created.name}" létrehozva.`, 'success');
            }

            closeModal();
            if (navigateOnSuccess) {
                navigate(workflowPath(created.workflowId));
            }
        } catch (err) {
            console.error('[CreateWorkflowModal] Létrehozás hiba:', err);
            setSubmitError(err?.message || 'Ismeretlen hiba a workflow létrehozásakor.');
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <form className="publication-form" onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="cw-name">Név</label>
                <input
                    id="cw-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => setTouched(true)}
                    className={hasNameError ? 'invalid-input' : ''}
                    placeholder="pl. Napilap workflow"
                    maxLength={NAME_MAX}
                    autoFocus
                    disabled={isSubmitting}
                />
                {hasNameError ? (
                    <div className="form-error">{nameError}</div>
                ) : (
                    <div className="form-hint">
                        A default állapotgépből indul, ha nem importálsz JSON-t.
                    </div>
                )}
            </div>

            <div className="form-group">
                <label>JSON import (opcionális)</label>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                />
                {!importedData ? (
                    <button
                        type="button"
                        className="btn-secondary"
                        onClick={triggerFilePicker}
                        disabled={isSubmitting}
                    >
                        JSON workflow fájl beolvasása…
                    </button>
                ) : (
                    <div className="workflow-import-preview">
                        <div className="workflow-import-preview__info">
                            <strong>{importedData.fileName}</strong>
                            <span className="workflow-import-preview__meta">
                                {importedData.compiled?.states?.length || 0} állapot
                                {importedData.compiled?.transitions?.length
                                    ? `, ${importedData.compiled.transitions.length} átmenet`
                                    : ''}
                            </span>
                        </div>
                        <button
                            type="button"
                            className="btn-secondary"
                            onClick={clearImport}
                            disabled={isSubmitting}
                            title="Import eltávolítása — a default workflow-ból indul"
                        >
                            Eltávolít
                        </button>
                    </div>
                )}
                {importError && (
                    <div className="form-error" style={{ marginTop: 6 }}>{importError}</div>
                )}
                {!importError && (
                    <div className="form-hint">
                        Korábban exportált Maestro workflow JSON. Az importált tartalom
                        felülírja a default állapotgépet az első mentésnél.
                    </div>
                )}
            </div>

            {submitError && (
                <div className="form-error form-error-global">{submitError}</div>
            )}

            <div className="modal-actions">
                <button
                    type="button"
                    className="btn-secondary"
                    onClick={closeModal}
                    disabled={isSubmitting}
                >
                    Mégse
                </button>
                <button
                    type="submit"
                    className="btn-primary"
                    disabled={!canSubmit}
                >
                    {isSubmitting ? 'Létrehozás…' : 'Létrehozás'}
                </button>
            </div>
        </form>
    );
}

/**
 * Egy helyre konszolidálja a modal megnyitás default propjait (title + size),
 * hogy a hívóhelyek (breadcrumb library, designer toolbar, /workflows/new route)
 * ne drift-eljenek el.
 */
export function openCreateWorkflowModal(openModal, editorialOfficeId, modalProps) {
    openModal(
        <CreateWorkflowModal editorialOfficeId={editorialOfficeId} />,
        { title: 'Új workflow', size: 'sm', ...modalProps }
    );
}
