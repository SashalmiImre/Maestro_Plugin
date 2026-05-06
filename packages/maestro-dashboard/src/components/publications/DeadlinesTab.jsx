/**
 * Maestro Dashboard — DeadlinesTab
 *
 * A PublicationSettingsModal „Határidők" füle. A plugin DeadlinesSection portja.
 *
 * Funkciók:
 *   - Timeline áttekintés (C.2.3, 2026-05-06): horizontal track a coverage
 *     `[coverageStart, coverageEnd]` tartományán, a határidőkkel mint tickek.
 *   - Határidő lista: kezdő- és végoldal + dátum + idő + törlés
 *   - Új határidő hozzáadása (a következő szabad tartomány + aktuális dátum/idő)
 *   - Mezők blur mentéssel (oldalszám → int, dátum + idő → ISO datetime)
 *   - Validáció a shared deadlineValidator függvényeivel (inline piros keret)
 *   - Teljes lista validáció (átfedés, lefedettség, tartományok) — hiba kártyák
 *     + full-width warning banner az első sorrendi warning-hoz (Stitch v2 spec).
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useData } from '../../contexts/DataContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import {
    validateDeadlines,
    isValidDate,
    isValidTime,
    getDateFromDatetime,
    getTimeFromDatetime,
    buildDatetime
} from '@shared/deadlineValidator.js';

const VALIDATION_DEBOUNCE_MS = 300;

const LABELS = {
    timelineTitle: 'Ütemezési áttekintés',
    timelineEmpty: 'Még nincs határidő — az áttekintés a Határidők lista alatti gombbal jelenik meg.',
    timelineSinglePage: 'Egyoldalas kiadvány — a vízszintes timeline-nak nincs értelmes felosztása. A határidő közvetlenül a lista alatt szerkeszthető.',
    timelinePageMarker: 'oldal',
    listEmpty: 'Ehhez a kiadványhoz még nincs határidő megadva.',
    fieldStartPlaceholder: 'Kezdő',
    fieldEndPlaceholder: 'Utolsó',
    fieldDatePlaceholder: 'ÉÉÉÉ.HH.NN',
    fieldTimePlaceholder: 'ÓÓ:PP',
    deleteTitle: 'Határidő törlése',
    addButton: '+ Új határidő',
    confirmTitle: 'Határidő törlése',
    confirmMsg: (deadline) =>
        `Biztosan törlöd a(z) ${deadline.startPage}–${deadline.endPage}. oldalakhoz tartozó határidőt?`,
    confirmCta: 'Törlés',
    addCreated: 'Új határidő létrehozva',
    addNoRoom: 'Nincs több szabad oldal a kiadvány fedésében — bővítsd a kiadvány terjedelmét, vagy módosíts egy meglévő határidőt.',
    saveFailed: (msg) => `Mentés sikertelen: ${msg || 'ismeretlen hiba'}`,
    createFailed: (msg) => `Létrehozás sikertelen: ${msg || 'ismeretlen hiba'}`,
    deleteFailed: (msg) => `Törlés sikertelen: ${msg || 'ismeretlen hiba'}`,
    deleted: 'Határidő törölve',
    bannerWarningTitle: 'Ütemezési hiányosság',
};

/** Hónap-rövidítés magyarul (pl. "máj. 12. · 18:00"). */
const HU_MONTHS_SHORT = ['jan.', 'feb.', 'márc.', 'ápr.', 'máj.', 'jún.', 'júl.', 'aug.', 'szept.', 'okt.', 'nov.', 'dec.'];

function formatDeadlineShort(datetime) {
    if (!datetime) return '—';
    const d = new Date(datetime);
    if (Number.isNaN(d.getTime())) return '—';
    const month = HU_MONTHS_SHORT[d.getMonth()] || '';
    const day = d.getDate();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${month} ${day}. · ${hours}:${minutes}`;
}

export default function DeadlinesTab({ publication }) {
    const { deadlines, createDeadline, updateDeadline, deleteDeadline } = useData();
    const { showToast } = useToast();
    const confirm = useConfirm();

    // Fedés-invariáns megsértése nem blokkoló: aktivált publikáción is szabad a
    // szerkesztés, a `validateDeadlines()` warning kártyák jelzik a problémát.

    // Csak az aktív publikációhoz tartozó határidők, oldalsorrendben
    const pubDeadlines = useMemo(
        () =>
            deadlines
                .filter((d) => d.publicationId === publication.$id)
                .sort((a, b) => (a.startPage ?? 0) - (b.startPage ?? 0)),
        [deadlines, publication.$id]
    );

    // Lokális mezőértékek (blur mentéshez)
    const [localFields, setLocalFields] = useState({});
    const [invalidFields, setInvalidFields] = useState({});

    // Validációs eredmény — debounce-olt
    const [errors, setErrors] = useState([]);
    const [warnings, setWarnings] = useState([]);
    const debounceRef = useRef(null);

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            const result = validateDeadlines(publication, pubDeadlines);
            setErrors(result.errors || []);
            setWarnings(result.warnings || []);
        }, VALIDATION_DEBOUNCE_MS);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [pubDeadlines, publication?.coverageStart, publication?.coverageEnd]);

    function getFieldValue(deadlineId, field, serverValue) {
        const key = `${deadlineId}.${field}`;
        return localFields[key] !== undefined ? localFields[key] : (serverValue ?? '');
    }

    function setFieldValue(deadlineId, field, value) {
        const key = `${deadlineId}.${field}`;
        setLocalFields((prev) => ({ ...prev, [key]: value }));
        if (invalidFields[key]) {
            setInvalidFields((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
            });
        }
    }

    function clearLocalField(...keys) {
        setLocalFields((prev) => {
            const next = { ...prev };
            for (const k of keys) delete next[k];
            return next;
        });
    }

    async function handlePageBlur(deadline, field) {
        const key = `${deadline.$id}.${field}`;
        const local = localFields[key];
        if (local === undefined) return;

        const parsed = parseInt(local, 10);
        const value = isNaN(parsed) ? null : parsed;
        if (value === deadline[field]) {
            clearLocalField(key);
            return;
        }
        try {
            await updateDeadline(deadline.$id, { [field]: value });
            clearLocalField(key);
        } catch (err) {
            console.error('[DeadlinesTab] Page save failed:', err);
            showToast(LABELS.saveFailed(err?.message), 'error');
        }
    }

    async function handleDatetimeBlur(deadline, changedField) {
        const dateKey = `${deadline.$id}.date`;
        const timeKey = `${deadline.$id}.time`;
        const changedKey = `${deadline.$id}.${changedField}`;

        if (localFields[changedKey] === undefined) return;

        const datePart = localFields[dateKey] !== undefined
            ? localFields[dateKey]
            : getDateFromDatetime(deadline.datetime);
        const timePart = localFields[timeKey] !== undefined
            ? localFields[timeKey]
            : getTimeFromDatetime(deadline.datetime);

        // Formátum-ellenőrzés (inline piros keret)
        if (changedField === 'date' && datePart && !isValidDate(datePart)) {
            setInvalidFields((prev) => ({ ...prev, [dateKey]: true }));
            return;
        }
        if (changedField === 'time' && timePart && !isValidTime(timePart)) {
            setInvalidFields((prev) => ({ ...prev, [timeKey]: true }));
            return;
        }

        const newDatetime = buildDatetime(datePart, timePart);
        if (!newDatetime) return; // Hiányos — lokális state megmarad

        if (newDatetime === deadline.datetime) {
            clearLocalField(dateKey, timeKey);
            return;
        }

        try {
            await updateDeadline(deadline.$id, { datetime: newDatetime });
            clearLocalField(dateKey, timeKey);
        } catch (err) {
            console.error('[DeadlinesTab] Datetime save failed:', err);
            showToast(LABELS.saveFailed(err?.message), 'error');
        }
    }

    async function handleAdd() {
        const coverageStart = publication?.coverageStart ?? 1;
        const coverageEnd = publication?.coverageEnd ?? coverageStart;

        // Következő szabad tartomány
        let defaultStart = coverageStart;
        if (pubDeadlines.length > 0) {
            const last = pubDeadlines[pubDeadlines.length - 1];
            defaultStart = (last.endPage ?? coverageStart) + 1;
        }

        // Ha a coverage már teljesen lefedett (az utolsó határidő a coverageEnd-ig ment),
        // a `defaultStart` túllépne a coverageEnd-en → invalid tartomány. Ilyenkor nem
        // hozunk létre új rekordot, csak figyelmeztetünk.
        if (defaultStart > coverageEnd) {
            showToast(LABELS.addNoRoom, 'warning');
            return;
        }

        // Új határidő alapértelmezetten 1 oldal széles (defaultStart = defaultEnd);
        // a felhasználó bővíti igény szerint. A fenti guard után defaultStart <= coverageEnd.
        const defaultEnd = defaultStart;

        try {
            await createDeadline({
                publicationId: publication.$id,
                startPage: defaultStart,
                endPage: defaultEnd,
                datetime: new Date().toISOString()
            });
            showToast(LABELS.addCreated, 'success');
        } catch (err) {
            console.error('[DeadlinesTab] Create failed:', err);
            showToast(LABELS.createFailed(err?.message), 'error');
        }
    }

    async function handleDelete(deadline) {
        const ok = await confirm({
            title: LABELS.confirmTitle,
            message: LABELS.confirmMsg(deadline),
            confirmLabel: LABELS.confirmCta,
            variant: 'danger'
        });
        if (!ok) return;

        try {
            await deleteDeadline(deadline.$id);
            showToast(LABELS.deleted, 'success');
        } catch (err) {
            console.error('[DeadlinesTab] Delete failed:', err);
            showToast(LABELS.deleteFailed(err?.message), 'error');
        }
    }

    // Timeline tickek pozíciói — `(startPage - coverageStart) / coverageSpan * 100%`.
    // 1-page coverage degenerate eset (`coverageStart === coverageEnd`): minden
    // tick a 0%-on egymásra rajzolódna → ilyenkor `isDegenerate=true` jelzéssel
    // a track-helyett egy „nincs értelmes timeline" empty state-et renderelünk
    // (harden 2026-05-06, Codex adversarial P1-#2 fix).
    const isDegenerateCoverage = useMemo(() => {
        const start = publication?.coverageStart ?? 1;
        const end = publication?.coverageEnd ?? start;
        return end <= start;
    }, [publication?.coverageStart, publication?.coverageEnd]);

    const timelineTicks = useMemo(() => {
        if (isDegenerateCoverage) return [];
        const start = publication?.coverageStart ?? 1;
        const end = publication?.coverageEnd ?? start;
        const span = end - start;
        return pubDeadlines.map((d) => {
            const offset = ((d.startPage ?? start) - start) / span;
            const left = Math.max(0, Math.min(1, offset)) * 100;
            return {
                id: d.$id,
                left,
                page: d.startPage ?? start,
                pageEnd: d.endPage ?? d.startPage ?? start,
                label: formatDeadlineShort(d.datetime),
            };
        });
    }, [pubDeadlines, publication?.coverageStart, publication?.coverageEnd, isDegenerateCoverage]);

    // Nested ternary helyett if-else lánc — clarity > brevity (lásd Project rules).
    let timelineBody;
    if (isDegenerateCoverage) {
        timelineBody = <div className="deadline-timeline__empty">{LABELS.timelineSinglePage}</div>;
    } else if (timelineTicks.length === 0) {
        timelineBody = <div className="deadline-timeline__empty">{LABELS.timelineEmpty}</div>;
    } else {
        timelineBody = (
            <div className="deadline-timeline__track" role="presentation">
                {timelineTicks.map((tick) => (
                    <div
                        key={tick.id}
                        className="deadline-timeline__tick"
                        style={{ left: `${tick.left}%` }}
                    >
                        <div className="deadline-timeline__tick-stem" aria-hidden="true" />
                        <div className="deadline-timeline__tick-label">
                            <span className="deadline-timeline__tick-page">
                                {tick.page === tick.pageEnd ? `${tick.page}.` : `${tick.page}–${tick.pageEnd}.`}
                            </span>
                            <span className="deadline-timeline__tick-when">{tick.label}</span>
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className="publication-form">
            {/* C.2.3 timeline áttekintés — Stitch screen `a422b3d9...` ÜTEMEZÉSI ÁTTEKINTÉS */}
            <section className="deadline-timeline" aria-label={LABELS.timelineTitle}>
                <header className="deadline-timeline__header">
                    <h4 className="deadline-timeline__title">{LABELS.timelineTitle}</h4>
                    {pubDeadlines.length > 0 && publication?.coverageStart && publication?.coverageEnd && (
                        <div className="deadline-timeline__coverage">
                            <span>{publication.coverageStart}. {LABELS.timelinePageMarker}</span>
                            <span aria-hidden="true">→</span>
                            <span>{publication.coverageEnd}. {LABELS.timelinePageMarker}</span>
                        </div>
                    )}
                </header>
                {timelineBody}
            </section>

            {/* Full-width warning banner (Stitch v2: ÜTEMEZÉSI HIÁNYOSSÁG, warning-tinted bg + ikon).
                Csak ha errors.length === 0 (különben az error-kártyák jelennek meg lent) ÉS van warning.
                `role="note"` (NEM `role="status"`): a banner statikus advisory tartalom, nem tranziens
                live-feedback. A `role="status"` polite live region 300ms-enként újra-felolvastatja a
                screen reader-rel a debounce-olt validation-eredményt — recurring announcement zaj.
                Harden 2026-05-06, Codex adversarial P1-#3 fix. */}
            {errors.length === 0 && warnings.length > 0 && (
                <div className="validation-banner validation-banner--warning" role="note">
                    <span className="validation-banner__icon" aria-hidden="true">⚠</span>
                    <div className="validation-banner__body">
                        <div className="validation-banner__title">{LABELS.bannerWarningTitle}</div>
                        <ul className="validation-banner__list">
                            {warnings.map((msg, i) => (
                                <li key={`warn-${i}`}>{msg}</li>
                            ))}
                        </ul>
                    </div>
                </div>
            )}

            {pubDeadlines.length === 0 && (
                <div className="form-empty-state">
                    {LABELS.listEmpty}
                </div>
            )}

            {pubDeadlines.map((deadline) => {
                const dateKey = `${deadline.$id}.date`;
                const timeKey = `${deadline.$id}.time`;
                return (
                    <div key={deadline.$id} className="deadline-row">
                        <input
                            type="number"
                            min="1"
                            className="deadline-page-input"
                            placeholder={LABELS.fieldStartPlaceholder}
                            value={getFieldValue(deadline.$id, 'startPage', deadline.startPage)}
                            onChange={(e) => setFieldValue(deadline.$id, 'startPage', e.target.value)}
                            onBlur={() => handlePageBlur(deadline, 'startPage')}
                        />
                        <span className="deadline-separator">–</span>
                        <input
                            type="number"
                            min="1"
                            className="deadline-page-input"
                            placeholder={LABELS.fieldEndPlaceholder}
                            value={getFieldValue(deadline.$id, 'endPage', deadline.endPage)}
                            onChange={(e) => setFieldValue(deadline.$id, 'endPage', e.target.value)}
                            onBlur={() => handlePageBlur(deadline, 'endPage')}
                        />
                        <input
                            type="text"
                            className={`deadline-date-input ${invalidFields[dateKey] ? 'invalid-input' : ''}`}
                            placeholder={LABELS.fieldDatePlaceholder}
                            value={getFieldValue(deadline.$id, 'date', getDateFromDatetime(deadline.datetime))}
                            onChange={(e) => setFieldValue(deadline.$id, 'date', e.target.value)}
                            onBlur={() => handleDatetimeBlur(deadline, 'date')}
                        />
                        <input
                            type="text"
                            className={`deadline-time-input ${invalidFields[timeKey] ? 'invalid-input' : ''}`}
                            placeholder={LABELS.fieldTimePlaceholder}
                            value={getFieldValue(deadline.$id, 'time', getTimeFromDatetime(deadline.datetime))}
                            onChange={(e) => setFieldValue(deadline.$id, 'time', e.target.value)}
                            onBlur={() => handleDatetimeBlur(deadline, 'time')}
                        />
                        <button
                            type="button"
                            className="btn-danger-icon"
                            onClick={() => handleDelete(deadline)}
                            title={LABELS.deleteTitle}
                            aria-label={LABELS.deleteTitle}
                        >
                            ✕
                        </button>
                    </div>
                );
            })}

            <button
                type="button"
                className="btn-secondary btn-add-row"
                onClick={handleAdd}
            >
                {LABELS.addButton}
            </button>

            {/* Validációs hibák — keményebb feedback (banner alatt jelennek meg). */}
            {errors.length > 0 && (
                <div className="validation-cards">
                    {errors.map((msg, i) => (
                        <div key={`err-${i}`} className="validation-card validation-card-error">
                            {msg}
                        </div>
                    ))}
                </div>
            )}
            {/* A figyelmeztetéseket a fenti `validation-banner--warning` rendereli — Stitch v2
                spec szerint full-width banner, NEM külön kártya-blokk a lista alatt. */}
        </div>
    );
}
