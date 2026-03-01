import React, { useState, useEffect, useRef } from "react";

// Components
import { CollapsibleSection } from "../../../common/CollapsibleSection.jsx";
import { ValidatedTextField } from "../../../common/ValidatedTextField.jsx";
import { ConfirmDialog } from "../../../common/ConfirmDialog.jsx";
import { CustomCheckbox } from "../../../common/CustomCheckbox.jsx";

// Contexts & Hooks
import { useDeadlines } from "../../../../data/hooks/useDeadlines.js";
import { useToast } from "../../../common/Toast/ToastContext.jsx";

// Config & Constants
import { STORAGE_KEYS, UI_TIMING, TOAST_TYPES } from "../../../../core/utils/constants.js";

// Utils
import { logError } from "../../../../core/utils/logger.js";
import { DeadlineValidator } from "../../../../core/utils/validators/DeadlineValidator.js";

// Singleton validátor instance
const deadlineValidator = new DeadlineValidator();

// ─── Validációs kártya stílusok (Toast-szerű megjelenítés) ──────────────────

const CARD_COLORS = {
    error: '#d7373f',
    warning: '#e68619'
};

const CardIcon = ({ type }) => {
    if (type === 'error') {
        return (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginRight: "8px", marginTop: "1px" }}>
                <circle cx="12" cy="12" r="10" fill="white" fillOpacity="0.3" />
                <path d="M8 8l8 8M16 8l-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" />
            </svg>
        );
    }
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginRight: "8px", marginTop: "1px" }}>
            <circle cx="12" cy="12" r="10" fill="white" fillOpacity="0.3" />
            <path d="M12 8v5" stroke="white" strokeWidth="2" strokeLinecap="round" />
            <circle cx="12" cy="16" r="1.2" fill="white" />
        </svg>
    );
};

// ─── Datetime konverziós segédfüggvények ─────────────────────────────────────

/** ISO datetime string → dátum rész ("ÉÉÉÉ.HH.NN") */
const getDateFromDatetime = (isoString) => {
    if (!isoString) return '';
    const match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
};

/** ISO datetime string → idő rész ("ÓÓ:PP") */
const getTimeFromDatetime = (isoString) => {
    if (!isoString) return '';
    const match = isoString.match(/T(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : '';
};

/** Dátum ("ÉÉÉÉ.HH.NN") + idő ("ÓÓ:PP") → ISO datetime string, vagy null ha nem érvényes */
const buildDatetime = (datePart, timePart) => {
    const dateMatch = datePart?.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
    const timeMatch = timePart?.match(/^(\d{2}):(\d{2})$/);
    if (!dateMatch || !timeMatch) return null;
    return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${timeMatch[1]}:${timeMatch[2]}:00.000+00:00`;
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * DeadlinesSection Component
 *
 * A kiadvány nyomdai határidőinek kezelése.
 * Funkciók:
 * - Határidő lista: kezdő/utolsó oldal + dátum + idő + törlés
 * - Új határidő hozzáadása
 * - Validáció: átfedés, lefedettség, formátum
 * - Hibák inline megjelenítése
 * - onValidationChange callback a szülőnek (kilépés blokkolás)
 *
 * Az adatbázisban egyetlen `datetime` (Appwrite Datetime) mező tárolja a dátumot és időt.
 * A UI két külön mezőben jeleníti meg (ÉÉÉÉ.HH.NN + ÓÓ:PP), mentéskor kombinálja őket.
 *
 * @param {Object} props
 * @param {Object} props.publication - A kiadvány objektum (coverageStart, coverageEnd, excludeWeekends)
 * @param {Function} props.onFieldUpdate - Mező frissítés callback: (fieldName, value) => void
 * @param {Function} props.onValidationChange - Callback: (hasErrors: boolean) => void
 */
export const DeadlinesSection = ({ publication, onFieldUpdate, onValidationChange }) => {
    const { deadlines, createDeadline, updateDeadline, deleteDeadline } = useDeadlines();
    const { showToast } = useToast();

    // Lokális state a mezőkhöz (Enter/blur mentéshez)
    const [localFields, setLocalFields] = useState({});

    // Validációs eredmények
    const [validationErrors, setValidationErrors] = useState([]);
    const [validationWarnings, setValidationWarnings] = useState([]);

    // Mező-szintű érvénytelenség (formátum-hiba vizuális jelzése)
    const [invalidFields, setInvalidFields] = useState({});

    // Törlés megerősítés
    const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, deadlineId: null });

    // Ref a validáció debounce-hoz
    const validationTimerRef = useRef(null);

    /**
     * Validáció futtatása a deadlines változásakor.
     */
    useEffect(() => {
        // Debounce — ne fusson minden billentyűleütésre
        if (validationTimerRef.current) clearTimeout(validationTimerRef.current);

        validationTimerRef.current = setTimeout(async () => {
            if (deadlines.length === 0) {
                setValidationErrors([]);
                setValidationWarnings([]);
                if (onValidationChange) onValidationChange(false);
                return;
            }

            const result = await deadlineValidator.validate(publication, deadlines);
            setValidationErrors(result.errors || []);
            setValidationWarnings(result.warnings || []);
            if (onValidationChange) onValidationChange(!result.isValid);
        }, UI_TIMING.VALIDATION_DEBOUNCE_MS);

        return () => {
            if (validationTimerRef.current) clearTimeout(validationTimerRef.current);
        };
    }, [deadlines, publication?.coverageStart, publication?.coverageEnd]);

    /**
     * Lokális mező lekérése (ha van lokális módosítás), egyébként a szerver érték.
     */
    const getFieldValue = (deadlineId, field, serverValue) => {
        const key = `${deadlineId}.${field}`;
        return localFields[key] !== undefined ? localFields[key] : (serverValue ?? "");
    };

    /**
     * Lokális mező frissítése.
     */
    const handleFieldInput = (deadlineId, field, value) => {
        const key = `${deadlineId}.${field}`;
        setLocalFields(prev => ({ ...prev, [key]: value }));
        // Érvénytelenség törlése gépeléskor
        if (invalidFields[key]) {
            setInvalidFields(prev => {
                const next = { ...prev };
                delete next[key];
                return next;
            });
        }
    };

    /**
     * Oldalszám mező mentése Enter/blur-kor (startPage, endPage).
     */
    const handlePageFieldSave = async (deadlineId, field, serverValue) => {
        const key = `${deadlineId}.${field}`;
        const localValue = localFields[key];

        // Ha nincs lokális módosítás, nem kell menteni
        if (localValue === undefined) return;

        // Szám mezők parse-olása
        const parsed = parseInt(localValue, 10);
        const valueToSave = isNaN(parsed) ? null : parsed;

        // Ha ugyanaz mint a szerver érték, nem kell menteni
        if (valueToSave === serverValue) {
            setLocalFields(prev => {
                const next = { ...prev };
                delete next[key];
                return next;
            });
            return;
        }

        try {
            await updateDeadline(deadlineId, { [field]: valueToSave });
            // Lokális state törlése
            setLocalFields(prev => {
                const next = { ...prev };
                delete next[key];
                return next;
            });
        } catch (error) {
            logError('[DeadlinesSection] Page field save failed:', error);
        }
    };

    /**
     * Dátum/idő mező mentése Enter/blur-kor.
     * Mindkét részt (dátum + idő) kombinálja egyetlen datetime mezővé.
     * Csak akkor ment, ha mindkét rész érvényes formátumú.
     */
    const handleDatetimeSave = async (deadlineId, changedField, deadline) => {
        const dateKey = `${deadlineId}.date`;
        const timeKey = `${deadlineId}.time`;
        const changedKey = `${deadlineId}.${changedField}`;

        // Ha nincs lokális módosítás a módosított mezőben, nem kell menteni
        if (localFields[changedKey] === undefined) return;

        // Aktuális értékek (lokális vagy szerveres)
        const datePart = localFields[dateKey] !== undefined
            ? localFields[dateKey]
            : getDateFromDatetime(deadline.datetime);
        const timePart = localFields[timeKey] !== undefined
            ? localFields[timeKey]
            : getTimeFromDatetime(deadline.datetime);

        // Formátum-validáció a módosított mezőre (azonnali vizuális visszajelzés)
        if (changedField === 'date' && datePart && !DeadlineValidator.isValidDate(datePart)) {
            setInvalidFields(prev => ({ ...prev, [dateKey]: true }));
            return;
        }
        if (changedField === 'time' && timePart && !DeadlineValidator.isValidTime(timePart)) {
            setInvalidFields(prev => ({ ...prev, [timeKey]: true }));
            return;
        }

        // ISO datetime összeállítása — csak ha mindkét rész érvényes formátumú
        const newDatetime = buildDatetime(datePart, timePart);
        if (!newDatetime) return; // Hiányos vagy érvénytelen formátum — helyi state megmarad

        // Ha ugyanaz mint a szerver érték, csak lokális state törlés
        if (newDatetime === deadline.datetime) {
            setLocalFields(prev => {
                const next = { ...prev };
                delete next[dateKey];
                delete next[timeKey];
                return next;
            });
            return;
        }

        try {
            await updateDeadline(deadlineId, { datetime: newDatetime });
            // Mindkét lokális state törlése (szinkronban vannak a szerverrel)
            setLocalFields(prev => {
                const next = { ...prev };
                delete next[dateKey];
                delete next[timeKey];
                return next;
            });
        } catch (error) {
            logError('[DeadlinesSection] Datetime save failed:', error);
        }
    };

    /**
     * Új határidő hozzáadása.
     * Alapértelmezett értékek: a kiadvány terjedelmének következő szabad tartománya.
     */
    const handleAddDeadline = async () => {
        const coverageStart = publication?.coverageStart ?? 1;
        const coverageEnd = publication?.coverageEnd ?? coverageStart;

        // A következő szabad tartomány megkeresése
        let defaultStart = coverageStart;
        if (deadlines.length > 0) {
            const sortedDeadlines = [...deadlines].sort((a, b) => (a.startPage ?? 0) - (b.startPage ?? 0));
            const lastDeadline = sortedDeadlines[sortedDeadlines.length - 1];
            defaultStart = (lastDeadline.endPage ?? coverageStart) + 1;
        }

        const defaultEnd = Math.min(defaultStart, coverageEnd);

        try {
            await createDeadline(publication.$id, {
                startPage: defaultStart,
                endPage: defaultEnd,
                datetime: new Date().toISOString()
            });
            showToast('Új határidő létrehozva', TOAST_TYPES.SUCCESS);
        } catch (error) {
            logError('[DeadlinesSection] Create failed:', error);
        }
    };

    /**
     * Határidő törlés indítása.
     */
    const handleDeleteRequest = (deadlineId) => {
        setDeleteConfirm({ isOpen: true, deadlineId });
    };

    /**
     * Törlés megerősítése.
     */
    const handleDeleteConfirm = async () => {
        const { deadlineId } = deleteConfirm;
        setDeleteConfirm({ isOpen: false, deadlineId: null });

        try {
            await deleteDeadline(deadlineId);
            showToast('Határidő törölve', TOAST_TYPES.SUCCESS);
        } catch (error) {
            logError('[DeadlinesSection] Delete failed:', error);
        }
    };

    /**
     * Törlés megszakítása.
     */
    const handleDeleteCancel = () => {
        setDeleteConfirm({ isOpen: false, deadlineId: null });
    };

    return (
        <>
            <CollapsibleSection
                title="HATÁRIDŐK"
                storageKey={STORAGE_KEYS.SECTION_PUBLICATION_DEADLINES_COLLAPSED}
            >
                <div style={{ display: "flex", flexDirection: "column" }}>
                    {/* Hétvégék kihagyása beállítás */}
                    <CustomCheckbox
                        checked={publication?.excludeWeekends ?? true}
                        onChange={() => {
                            if (onFieldUpdate) {
                                onFieldUpdate("excludeWeekends", !(publication?.excludeWeekends ?? true));
                            }
                        }}
                        style={{ marginBottom: "10px" }}
                    >
                        Hétvégék kihagyása
                    </CustomCheckbox>

                    {/* Határidő lista */}
                    {deadlines.map((deadline) => (
                        <div
                            key={deadline.$id}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                marginBottom: "6px"
                            }}
                        >
                            <div style={{ flex: 1, marginRight: "4px" }}>
                                <ValidatedTextField
                                    id={`deadline-start-${deadline.$id}`}
                                    type="number"
                                    placeholder="Kezdő"
                                    value={getFieldValue(deadline.$id, 'startPage', deadline.startPage)}
                                    onInput={(e) => handleFieldInput(deadline.$id, 'startPage', e.target.value)}
                                    onValidate={() => handlePageFieldSave(deadline.$id, 'startPage', deadline.startPage)}
                                    style={{ width: "100%" }}
                                />
                            </div>
                            <div style={{ flex: 1, marginRight: "4px" }}>
                                <ValidatedTextField
                                    id={`deadline-end-${deadline.$id}`}
                                    type="number"
                                    placeholder="Utolsó"
                                    value={getFieldValue(deadline.$id, 'endPage', deadline.endPage)}
                                    onInput={(e) => handleFieldInput(deadline.$id, 'endPage', e.target.value)}
                                    onValidate={() => handlePageFieldSave(deadline.$id, 'endPage', deadline.endPage)}
                                    style={{ width: "100%" }}
                                />
                            </div>
                            <div style={{ flex: 2, marginRight: "4px" }}>
                                <ValidatedTextField
                                    id={`deadline-date-${deadline.$id}`}
                                    type="text"
                                    placeholder="ÉÉÉÉ.HH.NN"
                                    value={getFieldValue(deadline.$id, 'date', getDateFromDatetime(deadline.datetime))}
                                    onInput={(e) => handleFieldInput(deadline.$id, 'date', e.target.value)}
                                    onValidate={() => handleDatetimeSave(deadline.$id, 'date', deadline)}
                                    invalid={!!invalidFields[`${deadline.$id}.date`]}
                                    style={{ width: "100%" }}
                                />
                            </div>
                            <div style={{ flex: 1, marginRight: "4px" }}>
                                <ValidatedTextField
                                    id={`deadline-time-${deadline.$id}`}
                                    type="text"
                                    placeholder="ÓÓ:PP"
                                    value={getFieldValue(deadline.$id, 'time', getTimeFromDatetime(deadline.datetime))}
                                    onInput={(e) => handleFieldInput(deadline.$id, 'time', e.target.value)}
                                    onValidate={() => handleDatetimeSave(deadline.$id, 'time', deadline)}
                                    invalid={!!invalidFields[`${deadline.$id}.time`]}
                                    style={{ width: "100%" }}
                                />
                            </div>
                            <sp-button
                                quiet
                                variant="negative"
                                size="s"
                                onClick={() => handleDeleteRequest(deadline.$id)}
                                title="Határidő törlése"
                            >
                                ✕
                            </sp-button>
                        </div>
                    ))}

                    {/* Új határidő gomb */}
                    <sp-button
                        quiet
                        variant="secondary"
                        size="s"
                        onClick={handleAddDeadline}
                        style={{ marginTop: "4px", alignSelf: "flex-start" }}
                    >
                        + Új határidő
                    </sp-button>

                    {/* Validációs hibák */}
                    {validationErrors.length > 0 && (
                        <div style={{ marginTop: "8px" }}>
                            {validationErrors.map((error, index) => (
                                <div
                                    key={`err-${index}`}
                                    style={{
                                        backgroundColor: CARD_COLORS.error,
                                        color: "white",
                                        padding: "8px 12px",
                                        borderRadius: "4px",
                                        display: "flex",
                                        alignItems: "flex-start",
                                        marginBottom: "6px",
                                        fontSize: "12px"
                                    }}
                                >
                                    <CardIcon type="error" />
                                    <span style={{ flex: 1 }}>{error}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Figyelmeztetések */}
                    {validationWarnings.length > 0 && validationErrors.length === 0 && (
                        <div style={{ marginTop: "8px" }}>
                            {validationWarnings.map((warning, index) => (
                                <div
                                    key={`warn-${index}`}
                                    style={{
                                        backgroundColor: CARD_COLORS.warning,
                                        color: "white",
                                        padding: "8px 12px",
                                        borderRadius: "4px",
                                        display: "flex",
                                        alignItems: "flex-start",
                                        marginBottom: "6px",
                                        fontSize: "12px"
                                    }}
                                >
                                    <CardIcon type="warning" />
                                    <span style={{ flex: 1 }}>{warning}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </CollapsibleSection>

            {/* Törlés megerősítő dialog */}
            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                title="Határidő törlése"
                message="Biztosan törölni szeretnéd ezt a határidőt?"
                confirmLabel="Törlés"
                onConfirm={handleDeleteConfirm}
                onCancel={handleDeleteCancel}
            />
        </>
    );
};
