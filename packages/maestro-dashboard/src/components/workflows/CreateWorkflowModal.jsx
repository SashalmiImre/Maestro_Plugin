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

import React, { useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { createWorkflow, saveWorkflow } from '../../features/workflowDesigner/api.js';
import { parseImportFile } from '../../features/workflowDesigner/exportImport.js';

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
    const fileInputRef = useRef(null);

    const trimmedName = name.trim();
    const nameError = useMemo(() => {
        if (!trimmedName) return 'A név megadása kötelező.';
        if (trimmedName.length > NAME_MAX) return `A név legfeljebb ${NAME_MAX} karakter lehet.`;
        return '';
    }, [trimmedName]);

    const hasNameError = touched && !!nameError;
    const canSubmit = !nameError && !isSubmitting;

    async function handleFileChange(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        setImportError('');

        const { compiled, graph, error } = await parseImportFile(file);
        if (error) {
            setImportError(error);
            setImportedData(null);
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

        try {
            // 1. Create — default compiled + graph (version=1)
            const created = await createWorkflow(editorialOfficeId, trimmedName);

            // 2. Optional overwrite az importált tartalommal
            if (importedData) {
                try {
                    await saveWorkflow(
                        editorialOfficeId,
                        created.workflowId,
                        importedData.compiled,
                        importedData.graph,
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
                navigate(`/admin/office/${editorialOfficeId}/workflow/${created.workflowId}`);
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
