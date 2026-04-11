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
 *   - Workflow (dropdown, change-re ment — csak egy workflow esetén, vagy
 *     aktivált kiadványnál letiltva)
 *
 * Aktiválás:
 *   - A tab alján „Aktiválás" szekció: ha még nincs aktiválva, a gomb csak
 *     akkor engedett, ha a workflow + határidők mind érvényesek. Megerősítés
 *     ConfirmDialog-gal. Ha már aktivált, zöld státusz + időbélyeg.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { validatePublicationActivation } from '@shared/publicationActivation.js';
import { useData } from '../../contexts/DataContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';

function formatActivatedAt(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
        return iso;
    }
}

export default function GeneralTab({ publication }) {
    const { workflows, deadlines, articles, updatePublication } = useData();
    const { showToast } = useToast();
    const confirm = useConfirm();

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

    const isActivated = publication.isActivated === true;

    // Fázis 6 — ha van cikk, a workflow nem módosítható. A modal csak az aktív
    // publikációra nyílik (BreadcrumbHeader), a DataContext `articles` pedig
    // pontosan az aktív publikáció cikkeit tartja — Realtime-ready, nincs
    // szükség külön query-re.
    const hasArticles = useMemo(
        () => articles.some((a) => a.publicationId === publication.$id),
        [articles, publication.$id]
    );
    const workflowDisabled = workflows.length <= 1 || isActivated || hasArticles;

    // Publikáció-hoz tartozó deadline-ok (scope-on belül, DataContext szűr)
    const pubDeadlines = useMemo(
        () => deadlines.filter((d) => d.publicationId === publication.$id),
        [deadlines, publication.$id]
    );

    const activation = useMemo(
        () => validatePublicationActivation(publication, pubDeadlines),
        [publication, pubDeadlines]
    );

    async function handleActivateClick() {
        if (!activation.isValid) return;
        const confirmMessage = (
            <>
                <p>Az aktiválás után a kiadvány megjelenik a pluginban, és a szerkesztők elkezdhetnek cikkeket felvenni rá.</p>
                <p><strong>A következő paraméterek aktiválás után nem módosíthatók:</strong></p>
                <ul>
                    <li>Workflow — a felhasználói jogosultságok ehhez kötődnek</li>
                    <li>Határidők szerkezete (oldalszám tartományok, darabszám) — a teljes fedés invariáns megőrzéséhez</li>
                </ul>
                <p>A layoutok, a határidő-dátumok és a közreműködők továbbra is szerkeszthetők maradnak.</p>
                <p>Biztosan aktiválod a(z) <strong>{publication.name}</strong> kiadványt?</p>
            </>
        );
        const ok = await confirm({
            title: 'Kiadvány aktiválása',
            message: confirmMessage,
            confirmLabel: 'Aktiválás',
            cancelLabel: 'Mégse',
            variant: 'normal'
        });
        if (!ok) return;
        try {
            await updatePublication(publication.$id, {
                isActivated: true,
                activatedAt: new Date().toISOString()
            });
            showToast('A kiadvány aktiválva.', 'success');
        } catch (err) {
            console.error('[GeneralTab] Aktiválás sikertelen:', err);
            showToast(`Aktiválás sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
        }
    }

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
                    title={
                        isActivated
                            ? 'Workflow aktiválás után nem módosítható.'
                            : hasArticles
                                ? 'A kiadványhoz már tartoznak cikkek — a workflow nem módosítható.'
                                : undefined
                    }
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

            {/* Aktiválás szekció */}
            <div className="form-group publication-activation">
                <label>Aktiválás</label>
                {isActivated ? (
                    <div className="activation-status activation-status-active">
                        <span className="activation-badge">✓ Aktiválva</span>
                        {publication.activatedAt && (
                            <span className="activation-date">{formatActivatedAt(publication.activatedAt)}</span>
                        )}
                    </div>
                ) : (
                    <>
                        {activation.errors.length > 0 && (
                            <ul className="form-error activation-errors">
                                {activation.errors.map((err, i) => (
                                    <li key={i}>{err}</li>
                                ))}
                            </ul>
                        )}
                        <button
                            type="button"
                            className="btn-primary activation-button"
                            disabled={!activation.isValid}
                            onClick={handleActivateClick}
                        >
                            Aktiválás
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
