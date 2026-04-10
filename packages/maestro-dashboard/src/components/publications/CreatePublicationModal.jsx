/**
 * Maestro Dashboard — CreatePublicationModal
 *
 * Új kiadvány létrehozása minimális mezőkkel. Sikeres mentés után automatikusan
 * létrehoz egy „A" layout-ot, hogy a cikkek azonnal hozzá rendelhetők legyenek.
 * A részletes beállítások (Layoutok, Határidők, Közreműködők) a
 * PublicationSettingsModal-ban érhetők el.
 *
 * Mezők:
 *   - Név (kötelező)
 *   - Gyökérmappa (kötelező, kanonikus formátum: /ShareName/relative/path)
 *   - Fedés kezdete / vége (két number input — oldalszám)
 *   - Hétvégék kihagyása (checkbox)
 *   - Workflow (dropdown, auto-disabled ha csak egy workflow van)
 *
 * Az új kiadvány `isActivated = false` — a Plugin csak Fázis 5-ben kapcsolódik
 * be az aktiválási logikába, így a létrehozás nem érinti a plugin-oldali
 * listát.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { useData } from '../../contexts/DataContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';

const DEFAULT_LAYOUT_NAME = 'A';

export default function CreatePublicationModal() {
    const { workflows, createPublication, createLayout } = useData();
    const { closeModal } = useModal();
    const { showToast } = useToast();

    // ─── Form állapot ───────────────────────────────────────────────────────
    const [name, setName] = useState('');
    const [rootPath, setRootPath] = useState('/');
    const [coverageStart, setCoverageStart] = useState('1');
    const [coverageEnd, setCoverageEnd] = useState('');
    const [excludeWeekends, setExcludeWeekends] = useState(true);
    const [workflowId, setWorkflowId] = useState(
        workflows.length === 1 ? workflows[0].$id : ''
    );
    const [touched, setTouched] = useState({});
    const [submitError, setSubmitError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    // A modal megnyílhat még a `workflows` lekérés befejeződése előtt. Amint a lista
    // betöltődött (0 → 1 átmenet), automatikusan kiválasztjuk az egyetlen workflow-t,
    // különben a select disabled + üres érték miatt a form beragadna.
    useEffect(() => {
        if (workflows.length === 1 && !workflowId) {
            setWorkflowId(workflows[0].$id);
        }
    }, [workflows, workflowId]);

    // ─── Validáció ──────────────────────────────────────────────────────────
    const errors = useMemo(() => {
        const next = {};

        if (!name.trim()) next.name = 'A név nem lehet üres.';

        if (!rootPath.trim()) {
            next.rootPath = 'A gyökérmappa nem lehet üres.';
        } else if (!rootPath.startsWith('/')) {
            next.rootPath = 'A gyökérmappának / karakterrel kell kezdődnie.';
        } else if (rootPath.trim() === '/') {
            next.rootPath = 'Adj meg egy kanonikus útvonalat (pl. /Story/2026/March).';
        }

        const startNum = parseInt(coverageStart, 10);
        const endNum = parseInt(coverageEnd, 10);
        if (isNaN(startNum) || startNum < 1) {
            next.coverageStart = 'A kezdőoldal legalább 1 legyen.';
        }
        if (isNaN(endNum) || endNum < 1) {
            next.coverageEnd = 'A végoldal legalább 1 legyen.';
        }
        if (!isNaN(startNum) && !isNaN(endNum) && startNum > endNum) {
            next.coverageEnd = 'A végoldal nem lehet kisebb, mint a kezdőoldal.';
        }

        if (workflows.length === 0) {
            next.workflowId = 'Nincs workflow az aktív szerkesztőségben.';
        } else if (!workflowId) {
            next.workflowId = 'Válassz workflow-t.';
        }

        return next;
    }, [name, rootPath, coverageStart, coverageEnd, workflowId, workflows]);

    const hasErrors = Object.keys(errors).length > 0;

    // ─── Submit ─────────────────────────────────────────────────────────────
    async function handleSubmit(e) {
        e?.preventDefault?.();
        setTouched({
            name: true, rootPath: true, coverageStart: true, coverageEnd: true, workflowId: true
        });
        if (hasErrors || isSubmitting) return;

        setIsSubmitting(true);
        setSubmitError('');

        try {
            const publication = await createPublication({
                name: name.trim(),
                rootPath: rootPath.trim(),
                coverageStart: parseInt(coverageStart, 10),
                coverageEnd: parseInt(coverageEnd, 10),
                excludeWeekends,
                workflowId,
                isActivated: false
            });

            // Automatikus „A" layout — ha elbukik, a kiadvány már létrejött,
            // csak figyelmeztetést mutatunk (layout kézzel létrehozható).
            try {
                await createLayout({
                    publicationId: publication.$id,
                    name: DEFAULT_LAYOUT_NAME,
                    order: 0
                });
            } catch (layoutErr) {
                console.warn('[CreatePublicationModal] Alapértelmezett layout létrehozása sikertelen:', layoutErr);
                showToast('A kiadvány létrejött, de az alapértelmezett layout létrehozása sikertelen volt.', 'warning');
            }

            showToast(`„${publication.name}" kiadvány létrehozva.`, 'success');
            closeModal();
        } catch (err) {
            console.error('[CreatePublicationModal] Létrehozás hiba:', err);
            setSubmitError(err?.message || 'Ismeretlen hiba a kiadvány létrehozásakor.');
        } finally {
            setIsSubmitting(false);
        }
    }

    function markTouched(field) {
        setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
    }

    const workflowDisabled = workflows.length <= 1;

    return (
        <form className="publication-form" onSubmit={handleSubmit}>
            {/* Név */}
            <div className="form-group">
                <label htmlFor="cp-name">Név</label>
                <input
                    id="cp-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => markTouched('name')}
                    className={touched.name && errors.name ? 'invalid-input' : ''}
                    placeholder="pl. Story 2026/3"
                    autoFocus
                />
                {touched.name && errors.name && (
                    <div className="form-error">{errors.name}</div>
                )}
            </div>

            {/* Gyökérmappa */}
            <div className="form-group">
                <label htmlFor="cp-rootpath">Gyökérmappa</label>
                <input
                    id="cp-rootpath"
                    type="text"
                    value={rootPath}
                    onChange={(e) => setRootPath(e.target.value)}
                    onBlur={() => markTouched('rootPath')}
                    className={touched.rootPath && errors.rootPath ? 'invalid-input' : ''}
                    placeholder="/Story/2026/March"
                />
                {touched.rootPath && errors.rootPath && (
                    <div className="form-error">{errors.rootPath}</div>
                )}
            </div>

            {/* Fedés */}
            <div className="form-row">
                <div className="form-group form-col">
                    <label htmlFor="cp-cstart">Fedés kezdete</label>
                    <input
                        id="cp-cstart"
                        type="number"
                        min="1"
                        value={coverageStart}
                        onChange={(e) => setCoverageStart(e.target.value)}
                        onBlur={() => markTouched('coverageStart')}
                        className={touched.coverageStart && errors.coverageStart ? 'invalid-input' : ''}
                    />
                    {touched.coverageStart && errors.coverageStart && (
                        <div className="form-error">{errors.coverageStart}</div>
                    )}
                </div>
                <div className="form-group form-col">
                    <label htmlFor="cp-cend">Fedés vége</label>
                    <input
                        id="cp-cend"
                        type="number"
                        min="1"
                        value={coverageEnd}
                        onChange={(e) => setCoverageEnd(e.target.value)}
                        onBlur={() => markTouched('coverageEnd')}
                        className={touched.coverageEnd && errors.coverageEnd ? 'invalid-input' : ''}
                        placeholder="pl. 96"
                    />
                    {touched.coverageEnd && errors.coverageEnd && (
                        <div className="form-error">{errors.coverageEnd}</div>
                    )}
                </div>
            </div>

            {/* Hétvégék kihagyása */}
            <div className="form-group form-checkbox-group">
                <label className="form-checkbox-label">
                    <input
                        type="checkbox"
                        checked={excludeWeekends}
                        onChange={(e) => setExcludeWeekends(e.target.checked)}
                    />
                    <span>Hétvégék kihagyása a sürgősség-számításban</span>
                </label>
            </div>

            {/* Workflow dropdown */}
            <div className="form-group">
                <label htmlFor="cp-workflow">Workflow</label>
                <select
                    id="cp-workflow"
                    className={`form-select ${touched.workflowId && errors.workflowId ? 'invalid-input' : ''}`}
                    value={workflowId}
                    onChange={(e) => setWorkflowId(e.target.value)}
                    onBlur={() => markTouched('workflowId')}
                    disabled={workflowDisabled}
                >
                    {workflows.length === 0 && (
                        <option value="">— Nincs elérhető workflow —</option>
                    )}
                    {workflows.length > 1 && !workflowId && (
                        <option value="">Válassz workflow-t…</option>
                    )}
                    {workflows.map((wf) => (
                        <option key={wf.$id} value={wf.$id}>{wf.name}</option>
                    ))}
                </select>
                {touched.workflowId && errors.workflowId && (
                    <div className="form-error">{errors.workflowId}</div>
                )}
            </div>

            {/* Általános hiba */}
            {submitError && (
                <div className="form-error form-error-global">{submitError}</div>
            )}

            {/* Akciók */}
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
                    disabled={isSubmitting || hasErrors}
                >
                    {isSubmitting ? 'Létrehozás…' : 'Létrehozás'}
                </button>
            </div>
        </form>
    );
}
