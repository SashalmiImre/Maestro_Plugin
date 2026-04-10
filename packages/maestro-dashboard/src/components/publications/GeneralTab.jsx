/**
 * Maestro Dashboard — GeneralTab
 *
 * A PublicationSettingsModal „Általános" füle. A plugin
 * PublicationProperties/GeneralSection portja.
 *
 * Mezők:
 *   - Név (blur mentés)
 *   - Fedés kezdete / vége (blur mentés, number)
 *   - Gyökérmappa (csak olvasható — Dashboard-ról nem módosítjuk)
 *   - Hétvégék kihagyása (azonnali mentés)
 *   - Workflow (dropdown, change-re ment — csak egy workflow esetén letiltva)
 */

import React, { useState, useEffect } from 'react';
import { useData } from '../../contexts/DataContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';

export default function GeneralTab({ publication }) {
    const { workflows, updatePublication } = useData();
    const { showToast } = useToast();

    // Lokális state a blur mentéshez
    const [name, setName] = useState(publication.name || '');
    const [coverageStart, setCoverageStart] = useState(String(publication.coverageStart ?? ''));
    const [coverageEnd, setCoverageEnd] = useState(String(publication.coverageEnd ?? ''));

    // Prop szinkronizáció — ha a Realtime frissíti a publikációt
    useEffect(() => { setName(publication.name || ''); }, [publication.name]);
    useEffect(() => { setCoverageStart(String(publication.coverageStart ?? '')); }, [publication.coverageStart]);
    useEffect(() => { setCoverageEnd(String(publication.coverageEnd ?? '')); }, [publication.coverageEnd]);

    // Mező-szintű hibák (formátum / üresség)
    const [fieldErrors, setFieldErrors] = useState({});

    async function saveField(field, value) {
        try {
            await updatePublication(publication.$id, { [field]: value });
        } catch (err) {
            console.error(`[GeneralTab] ${field} mentése sikertelen:`, err);
            showToast(`„${field}" mentése sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
        }
    }

    function handleNameBlur() {
        const trimmed = name.trim();
        if (!trimmed) {
            setFieldErrors((e) => ({ ...e, name: 'A név nem lehet üres.' }));
            setName(publication.name || '');
            return;
        }
        setFieldErrors((e) => { const next = { ...e }; delete next.name; return next; });
        if (trimmed !== publication.name) saveField('name', trimmed);
    }

    function handleCoverageBlur(field, value, setter) {
        const parsed = parseInt(value, 10);
        if (isNaN(parsed) || parsed < 1) {
            setFieldErrors((e) => ({ ...e, [field]: 'Érvénytelen oldalszám.' }));
            setter(String(publication[field] ?? ''));
            return;
        }
        // Bounds check: coverageStart ≤ coverageEnd
        if (field === 'coverageStart' && publication.coverageEnd != null && parsed > publication.coverageEnd) {
            setFieldErrors((e) => ({ ...e, coverageStart: 'A kezdőoldal nem lehet nagyobb, mint a végoldal.' }));
            setter(String(publication.coverageStart ?? ''));
            return;
        }
        if (field === 'coverageEnd' && publication.coverageStart != null && parsed < publication.coverageStart) {
            setFieldErrors((e) => ({ ...e, coverageEnd: 'A végoldal nem lehet kisebb, mint a kezdőoldal.' }));
            setter(String(publication.coverageEnd ?? ''));
            return;
        }
        setFieldErrors((e) => { const next = { ...e }; delete next[field]; return next; });
        if (parsed !== publication[field]) saveField(field, parsed);
    }

    async function handleExcludeWeekendsToggle(e) {
        const next = e.target.checked;
        await saveField('excludeWeekends', next);
    }

    async function handleWorkflowChange(e) {
        const next = e.target.value;
        if (!next || next === publication.workflowId) return;
        await saveField('workflowId', next);
        showToast('Workflow megváltozott — az új szabályok a következő átmeneteknél lépnek életbe.', 'info');
    }

    const workflowDisabled = workflows.length <= 1;

    return (
        <div className="publication-form">
            {/* Név */}
            <div className="form-group">
                <label htmlFor="ps-name">Név</label>
                <input
                    id="ps-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={handleNameBlur}
                    className={fieldErrors.name ? 'invalid-input' : ''}
                />
                {fieldErrors.name && <div className="form-error">{fieldErrors.name}</div>}
            </div>

            {/* Fedés */}
            <div className="form-row">
                <div className="form-group form-col">
                    <label htmlFor="ps-cstart">Fedés kezdete</label>
                    <input
                        id="ps-cstart"
                        type="number"
                        min="1"
                        value={coverageStart}
                        onChange={(e) => setCoverageStart(e.target.value)}
                        onBlur={() => handleCoverageBlur('coverageStart', coverageStart, setCoverageStart)}
                        className={fieldErrors.coverageStart ? 'invalid-input' : ''}
                    />
                    {fieldErrors.coverageStart && <div className="form-error">{fieldErrors.coverageStart}</div>}
                </div>
                <div className="form-group form-col">
                    <label htmlFor="ps-cend">Fedés vége</label>
                    <input
                        id="ps-cend"
                        type="number"
                        min="1"
                        value={coverageEnd}
                        onChange={(e) => setCoverageEnd(e.target.value)}
                        onBlur={() => handleCoverageBlur('coverageEnd', coverageEnd, setCoverageEnd)}
                        className={fieldErrors.coverageEnd ? 'invalid-input' : ''}
                    />
                    {fieldErrors.coverageEnd && <div className="form-error">{fieldErrors.coverageEnd}</div>}
                </div>
            </div>

            {/* Gyökérmappa — csak olvasható */}
            <div className="form-group">
                <label htmlFor="ps-rootpath">Gyökérmappa</label>
                <input
                    id="ps-rootpath"
                    type="text"
                    value={publication.rootPath || ''}
                    readOnly
                    className="form-input-readonly"
                    title="A gyökérmappa a Dashboard-ról nem módosítható."
                />
            </div>

            {/* Hétvégék kihagyása */}
            <div className="form-group form-checkbox-group">
                <label className="form-checkbox-label">
                    <input
                        type="checkbox"
                        checked={publication.excludeWeekends ?? true}
                        onChange={handleExcludeWeekendsToggle}
                    />
                    <span>Hétvégék kihagyása a sürgősség-számításban</span>
                </label>
            </div>

            {/* Workflow */}
            <div className="form-group">
                <label htmlFor="ps-workflow">Workflow</label>
                <select
                    id="ps-workflow"
                    className="form-select"
                    value={publication.workflowId || ''}
                    onChange={handleWorkflowChange}
                    disabled={workflowDisabled}
                >
                    {workflows.length === 0 && <option value="">— Nincs elérhető workflow —</option>}
                    {!publication.workflowId && workflows.length > 0 && (
                        <option value="">Válassz workflow-t…</option>
                    )}
                    {workflows.map((wf) => (
                        <option key={wf.$id} value={wf.$id}>{wf.name}</option>
                    ))}
                </select>
            </div>
        </div>
    );
}
