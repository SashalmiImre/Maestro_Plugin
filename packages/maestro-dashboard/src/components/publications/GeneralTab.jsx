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
import { WORKFLOW_VISIBILITY_DEFAULT, WORKFLOW_VISIBILITY_LABELS } from '@shared/constants.js';
import { useData } from '../../contexts/DataContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useOrgRole } from '../../hooks/useOrgRole.js';
import { showAutoseedWarnings } from '../../utils/autoseedWarnings.js';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { DATABASE_ID, COLLECTIONS } from '../../config.js';
import DangerZone from '../DangerZone.jsx';
import WorkflowLibraryPanel from '../workflows/WorkflowLibraryPanel.jsx';

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
    const { workflows, deadlines, articles, databases, updatePublication, deletePublication, applyPublicationPatchLocal } = useData();
    const { activatePublication, assignWorkflowToPublication } = useAuth();
    const { isOrgAdmin: canDeletePublication } = useOrgRole(publication.organizationId);
    const { openModal, closeModal } = useModal();
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

    // Fázis 8 — kiadvány törlés folyamatjelző
    const [isDeleting, setIsDeleting] = useState(false);

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

    async function handleWorkflowSelect(workflowId) {
        if (!workflowId || workflowId === publication.workflowId) return;
        try {
            // A.2.3 (ADR 0008) — szerver-CF action a direkt
            // `saveField('workflowId', ...)` helyett. A CF autoseed-eli
            // a workflow `requiredGroupSlugs[]`-t (idempotens), így a
            // contributor mátrix a következő Realtime push-ban azonnal
            // megjelenik. A direkt updateDocument megkerülné az autoseedet.
            const response = await assignWorkflowToPublication(publication.$id, workflowId, publication.$updatedAt);
            // Lokális state patch — fresh doc a CF response-ban (autoritatív
            // `$updatedAt`); ha hiányzik, csak a workflowId-t patcheljük + a
            // fallback timestampet a helper teszi rá.
            applyPublicationPatchLocal(publication.$id, response?.publication || { workflowId });
            const seeded = response?.autoseed?.created || [];
            const note = seeded.length > 0
                ? `Workflow megváltozott — új csoportok: ${seeded.join(', ')}.`
                : 'Workflow megváltozott — az új szabályok a következő átmeneteknél lépnek életbe.';
            showToast(note, 'info');
            showAutoseedWarnings(showToast, response?.autoseed?.warnings, 'GeneralTab.assignWorkflow');
        } catch (err) {
            console.error('[GeneralTab] Workflow hozzárendelés sikertelen:', err);
            const reason = err?.code || err?.message || 'ismeretlen hiba';
            const message =
                reason === 'publication_active_workflow_locked'
                    ? 'Aktivált kiadvány workflow-ja nem cserélhető. Deaktiváld előbb.'
                    : reason === 'workflow_scope_mismatch'
                        ? 'A workflow scope-ja nem illik a kiadvány szerkesztőségéhez.'
                        : reason === 'concurrent_modification'
                            ? 'A kiadvány módosult a betöltés óta. Frissítsd az oldalt.'
                            : `Workflow hozzárendelés sikertelen: ${reason}`;
            showToast(message, 'error');
        }
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

    // A workflow-váltás akkor tiltott, ha a kiadvány már aktív, vagy ha
    // vannak cikkek (a workflow állapotgépe határozná meg érvénytelen
    // átmeneteket). Egyébként a library könyvtárból bárhonnan választható.
    const workflowDisabled = isActivated || hasArticles;

    // A jelenlegi workflow dokumentum (a library lista összegzése UI-ra).
    // A `workflows` lista aktív workflow-kat tart (archiváltakat nem) — ha a
    // publikáció workflowId-ja archivált workflow-ra mutat, direkt fetch-el
    // kérjük le, hogy a név + láthatóság chip megjelenjen.
    const [archivedFallback, setArchivedFallback] = useState(null);
    const inlineWorkflow = useMemo(
        () => workflows.find((wf) => wf.$id === publication.workflowId) || null,
        [workflows, publication.workflowId]
    );
    useEffect(() => {
        const wfId = publication.workflowId;
        if (!wfId || inlineWorkflow) {
            setArchivedFallback(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const doc = await databases.getDocument(
                    DATABASE_ID,
                    COLLECTIONS.WORKFLOWS,
                    wfId
                );
                if (!cancelled) setArchivedFallback(doc);
            } catch {
                if (!cancelled) setArchivedFallback(null);
            }
        })();
        return () => { cancelled = true; };
    }, [databases, publication.workflowId, inlineWorkflow]);
    const currentWorkflow = inlineWorkflow || archivedFallback;

    function handleOpenWorkflowLibrary() {
        if (workflowDisabled) return;
        openModal(
            <WorkflowLibraryPanel
                context="publication-assignment"
                currentWorkflowId={publication.workflowId}
                onSelect={handleWorkflowSelect}
            />,
            { size: 'xl', title: 'Workflow kiválasztása' }
        );
    }

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
                <p>Aktiválás után <strong>a workflow nem módosítható</strong> — a felhasználói jogosultságok ehhez kötődnek. A layoutok, a határidők (oldalszám tartományok, darabszám és dátumok) és a közreműködők továbbra is szerkeszthetők maradnak.</p>
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
            // A.2.2 (ADR 0008) — szinkron CF action. A direkt
            // `updatePublication({ isActivated: true })` megkerülné az
            // autoseed + `empty_required_groups` checket.
            const response = await activatePublication(publication.$id, publication.$updatedAt);
            // Lokális state patch — a CF response.publication a fresh
            // doc (autoritatív `$updatedAt`-tel), így a Realtime stale-guard
            // megvédi a régi push-tól. Fallback: csak az aktiválási mezőkre
            // patch, ha a CF nem küldte volna a teljes doc-ot.
            applyPublicationPatchLocal(publication.$id, response?.publication || {
                isActivated: true,
                activatedAt: response?.activatedAt || new Date().toISOString()
            });
            const note = response?.autoseed?.created?.length
                ? ` (új csoportok: ${response.autoseed.created.join(', ')})`
                : '';
            showToast(`A kiadvány aktiválva.${note}`, 'success');
            showAutoseedWarnings(showToast, response?.autoseed?.warnings, 'GeneralTab.activate');
        } catch (err) {
            console.error('[GeneralTab] Aktiválás sikertelen:', err);
            const reason = err?.code || err?.message || 'ismeretlen hiba';
            // A leggyakoribb ismert reasonöket UI-friendly üzenetté fordítjuk.
            // A teljes részletes lista (slugs, affectedPublications) a UI A.4
            // feladat szerint külön modallal jelenik meg.
            const message =
                reason === 'empty_required_groups'
                    ? `Az aktiváláshoz minden csoportnak legalább 1 tagja kell legyen. Hiányzó csoportok: ${(err.slugs || []).join(', ')}`
                    : reason === 'concurrent_modification'
                        ? 'A kiadvány módosult a betöltés óta. Frissítsd az oldalt.'
                        : reason === 'invalid_deadlines'
                            ? `Érvénytelen határidők: ${(err.errors || []).join('; ')}`
                            : `Aktiválás sikertelen: ${reason}`;
            showToast(message, 'error');
        }
    }

    // Fázis 8 — Veszélyes zóna: a „Kiadvány törlése" gomb ideiglenesen csak
    // a publikáció szervezetének owner/admin tagjainak (`canDeletePublication`).
    // Szerver-oldalon DB ACL + validate-publication-update CF véd; ezt egy
    // későbbi részletes UI jog rendszer felülírja.

    async function handleDeletePublication() {
        const confirmMessage = (
            <>
                <p>
                    A kiadvány <strong>véglegesen törlődik</strong> az összes cikkel, layouttal,
                    határidővel és thumbnail fájllal együtt.
                </p>
                <p><strong>Ez a művelet nem visszavonható.</strong></p>
            </>
        );
        const ok = await confirm({
            title: 'Kiadvány törlése',
            message: confirmMessage,
            verificationExpected: publication.name,
            confirmLabel: 'Végleges törlés',
            cancelLabel: 'Mégse',
            variant: 'danger'
        });
        if (!ok) return;

        setIsDeleting(true);
        try {
            await deletePublication(publication.$id);
            closeModal();
            showToast(`A(z) „${publication.name}" kiadvány törölve lett.`, 'success');
        } catch (err) {
            console.error('[GeneralTab] Publikáció törlése sikertelen:', err);
            showToast(`Törlés sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
            setIsDeleting(false);
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

            {/* Gyökérmappa — csak olvasható. A Plugin folder picker (#34) állítja be
                az első megnyitáskor; a Dashboard nem szerkesztheti. */}
            <div className="form-group">
                <label htmlFor="ps-rootpath">Gyökérmappa</label>
                <input
                    id="ps-rootpath"
                    type="text"
                    value={publication.rootPath || ''}
                    readOnly
                    className="form-input-readonly"
                    placeholder="Még nincs beállítva"
                    title="A gyökérmappa a Dashboard-ról nem módosítható."
                />
                <div className="form-hint">
                    {publication.rootPath
                        ? 'A Pluginból beállítva. A gyökérmappa nem módosítható.'
                        : 'Még nincs beállítva — a Pluginban a kiadvány „Gyökérmappa beállítása" gombjával állítható be.'}
                </div>
            </div>

            {/* Hétvégék kihagyása */}
            <div className="form-group form-checkbox-group">
                <label className="form-checkbox-label">
                    <input
                        type="checkbox"
                        checked={publication.excludeWeekends ?? true}
                        onChange={handleExcludeWeekendsToggle}
                    />
                    <span> Hétvégék kihagyása a sürgősség-számításban</span>
                </label>
            </div>

            {/* Workflow — a korábbi dropdown helyett a közös WorkflowLibraryPanel
                modal-t nyitjuk meg. A kártyás lista támogatja a szűrést, a 3-way
                visibility-t és a megtekintés/duplikálás akciókat. */}
            <div className="form-group">
                <label>Workflow</label>
                <div className="publication-workflow-picker">
                    <div className="publication-workflow-picker__display">
                        {currentWorkflow ? (
                            <>
                                <span className="publication-workflow-picker__name">{currentWorkflow.name}</span>
                                <span
                                    className={`publication-workflow-picker__chip is-${currentWorkflow.visibility || WORKFLOW_VISIBILITY_DEFAULT}`}
                                >
                                    {WORKFLOW_VISIBILITY_LABELS[currentWorkflow.visibility || WORKFLOW_VISIBILITY_DEFAULT]}
                                </span>
                            </>
                        ) : (
                            <span className="publication-workflow-picker__empty">Még nincs workflow választva</span>
                        )}
                    </div>
                    <button
                        type="button"
                        className="btn-secondary"
                        onClick={handleOpenWorkflowLibrary}
                        disabled={workflowDisabled}
                        title={
                            isActivated
                                ? 'Workflow aktiválás után nem módosítható.'
                                : hasArticles
                                    ? 'A kiadványhoz már tartoznak cikkek — a workflow nem módosítható.'
                                    : 'Workflow kiválasztása a könyvtárból'
                        }
                    >
                        {currentWorkflow ? 'Cserélés…' : 'Kiválaszt…'}
                    </button>
                </div>
                {workflows.length === 0 && (
                    <div className="form-hint">
                        Nincs elérhető workflow ehhez a szerkesztőséghez. Kérd meg a szervezet adminját, hogy hozzon létre egyet, vagy nyisd meg a Workflow könyvtárat a breadcrumb-ból.
                    </div>
                )}
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

            {canDeletePublication && (
                <DangerZone
                    description="A kiadvány véglegesen törlődik az összes cikkel, layouttal, határidővel és thumbnail fájllal együtt. Ez a művelet nem visszavonható."
                    buttonLabel="Kiadvány törlése"
                    isPending={isDeleting}
                    onDelete={handleDeletePublication}
                />
            )}
        </div>
    );
}
