/**
 * Maestro Dashboard — DeadlinesTab
 *
 * A PublicationSettingsModal „Határidők" füle. A plugin DeadlinesSection portja.
 *
 * Funkciók:
 *   - Határidő lista: kezdő- és végoldal + dátum + idő + törlés
 *   - Új határidő hozzáadása (a következő szabad tartomány + aktuális dátum/idő)
 *   - Mezők blur mentéssel (oldalszám → int, dátum + idő → ISO datetime)
 *   - Validáció a shared deadlineValidator függvényeivel (inline piros keret)
 *   - Teljes lista validáció (átfedés, lefedettség, tartományok) — hiba kártyák
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

export default function DeadlinesTab({ publication }) {
    const { deadlines, createDeadline, updateDeadline, deleteDeadline } = useData();
    const { showToast } = useToast();
    const confirm = useConfirm();

    // Aktivált publikáción a határidők SZERKEZETE (oldalszám, darabszám) zárolt,
    // hogy a fedés-invariáns ne romolhasson el szerver-oldali revalidálás nélkül.
    // A dátum + idő továbbra is szerkeszthető, mert az nem bontja a fedést.
    const isActivated = publication.isActivated === true;
    const structureLockTitle = isActivated
        ? 'Határidők szerkezete aktivált kiadványon nem módosítható. Deaktiváld előbb a fedés módosításához.'
        : undefined;

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
        // Defenzív guard: ha a publikáció közben aktivált lett (Realtime update
        // a felhasználó gépelése alatt), eldobjuk a függő lokális módosítást.
        if (isActivated) {
            clearLocalField(`${deadline.$id}.${field}`);
            return;
        }
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
            showToast(`Mentés sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
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
            showToast(`Mentés sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
        }
    }

    async function handleAdd() {
        if (isActivated) return;
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
            showToast(
                'Nincs több szabad oldal a kiadvány fedésében — bővítsd a kiadvány terjedelmét, vagy módosíts egy meglévő határidőt.',
                'warning'
            );
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
            showToast('Új határidő létrehozva', 'success');
        } catch (err) {
            console.error('[DeadlinesTab] Create failed:', err);
            showToast(`Létrehozás sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
        }
    }

    async function handleDelete(deadline) {
        if (isActivated) return;
        const ok = await confirm({
            title: 'Határidő törlése',
            message: `Biztosan törlöd a(z) ${deadline.startPage}–${deadline.endPage}. oldalakhoz tartozó határidőt?`,
            confirmLabel: 'Törlés',
            variant: 'danger'
        });
        if (!ok) return;

        try {
            await deleteDeadline(deadline.$id);
            showToast('Határidő törölve', 'success');
        } catch (err) {
            console.error('[DeadlinesTab] Delete failed:', err);
            showToast(`Törlés sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
        }
    }

    return (
        <div className="publication-form">
            {pubDeadlines.length === 0 && (
                <div className="form-empty-state">
                    Ehhez a kiadványhoz még nincs határidő megadva.
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
                            placeholder="Kezdő"
                            value={getFieldValue(deadline.$id, 'startPage', deadline.startPage)}
                            onChange={(e) => setFieldValue(deadline.$id, 'startPage', e.target.value)}
                            onBlur={() => handlePageBlur(deadline, 'startPage')}
                            disabled={isActivated}
                            title={structureLockTitle}
                        />
                        <span className="deadline-separator">–</span>
                        <input
                            type="number"
                            min="1"
                            className="deadline-page-input"
                            placeholder="Utolsó"
                            value={getFieldValue(deadline.$id, 'endPage', deadline.endPage)}
                            onChange={(e) => setFieldValue(deadline.$id, 'endPage', e.target.value)}
                            onBlur={() => handlePageBlur(deadline, 'endPage')}
                            disabled={isActivated}
                            title={structureLockTitle}
                        />
                        <input
                            type="text"
                            className={`deadline-date-input ${invalidFields[dateKey] ? 'invalid-input' : ''}`}
                            placeholder="ÉÉÉÉ.HH.NN"
                            value={getFieldValue(deadline.$id, 'date', getDateFromDatetime(deadline.datetime))}
                            onChange={(e) => setFieldValue(deadline.$id, 'date', e.target.value)}
                            onBlur={() => handleDatetimeBlur(deadline, 'date')}
                        />
                        <input
                            type="text"
                            className={`deadline-time-input ${invalidFields[timeKey] ? 'invalid-input' : ''}`}
                            placeholder="ÓÓ:PP"
                            value={getFieldValue(deadline.$id, 'time', getTimeFromDatetime(deadline.datetime))}
                            onChange={(e) => setFieldValue(deadline.$id, 'time', e.target.value)}
                            onBlur={() => handleDatetimeBlur(deadline, 'time')}
                        />
                        <button
                            type="button"
                            className="btn-danger-icon"
                            onClick={() => handleDelete(deadline)}
                            title={isActivated ? structureLockTitle : 'Határidő törlése'}
                            aria-label="Határidő törlése"
                            disabled={isActivated}
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
                disabled={isActivated}
                title={structureLockTitle}
            >
                + Új határidő
            </button>

            {/* Validációs hibák */}
            {errors.length > 0 && (
                <div className="validation-cards">
                    {errors.map((msg, i) => (
                        <div key={`err-${i}`} className="validation-card validation-card-error">
                            {msg}
                        </div>
                    ))}
                </div>
            )}

            {/* Figyelmeztetések (csak hibák nélkül mutatjuk) */}
            {errors.length === 0 && warnings.length > 0 && (
                <div className="validation-cards">
                    {warnings.map((msg, i) => (
                        <div key={`warn-${i}`} className="validation-card validation-card-warning">
                            {msg}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
