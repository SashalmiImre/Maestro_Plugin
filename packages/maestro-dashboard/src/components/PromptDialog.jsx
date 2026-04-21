/**
 * Maestro Dashboard — PromptDialog
 *
 * Egysoros / többsoros szöveges bemenet dialógus. A `ConfirmDialog` mintáját
 * követi: önmagában nem renderel Modal-t, a `usePrompt()` hook nyitja meg a
 * ModalContext-en keresztül, így nested modalban is biztonságosan használható.
 *
 * Használat:
 *   const prompt = usePrompt();
 *   const value = await prompt({
 *     title: 'Új név',
 *     initialValue: workflow.name,
 *     maxLength: 128,
 *     validate: (v) => v.trim() ? null : 'A név nem lehet üres.'
 *   });
 *   if (value === null) return;   // user megszakította
 *   // value = trimmelt érték
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useModal } from '../contexts/ModalContext.jsx';

/**
 * @param {Object} props
 * @param {string} props.title
 * @param {string} [props.label]            — input fölötti magyarázó szöveg
 * @param {string} [props.initialValue='']
 * @param {string} [props.placeholder]
 * @param {number} [props.maxLength]
 * @param {boolean} [props.multiline=false] — textarea helyett input
 * @param {(value: string) => string|null} [props.validate] — error szöveg vagy null
 * @param {string} [props.confirmLabel='Mentés']
 * @param {string} [props.cancelLabel='Mégsem']
 * @param {Function} props.onConfirm — trimmelt értékkel hívódik
 * @param {Function} props.onCancel
 */
export default function PromptDialog({
    title,
    label,
    initialValue = '',
    placeholder,
    maxLength,
    multiline = false,
    validate,
    confirmLabel = 'Mentés',
    cancelLabel = 'Mégsem',
    onConfirm,
    onCancel
}) {
    const [value, setValue] = useState(initialValue);
    const [touched, setTouched] = useState(false);
    const inputRef = useRef(null);

    useEffect(() => {
        const timer = setTimeout(() => {
            inputRef.current?.focus();
            inputRef.current?.select?.();
        }, 50);
        return () => clearTimeout(timer);
    }, []);

    const error = useMemo(
        () => (validate ? validate(value) : null),
        [validate, value]
    );
    const isDisabled = Boolean(error);

    function handleSubmit() {
        if (isDisabled) {
            setTouched(true);
            return;
        }
        onConfirm(value.trim());
    }

    function handleKeyDown(e) {
        if (!multiline && e.key === 'Enter') {
            e.preventDefault();
            handleSubmit();
        }
    }

    const InputComponent = multiline ? 'textarea' : 'input';
    const inputProps = {
        ref: inputRef,
        className: `confirm-dialog-input${touched && error ? ' invalid-input' : ''}`,
        value,
        onChange: (e) => setValue(e.target.value),
        onBlur: () => setTouched(true),
        onKeyDown: handleKeyDown,
        placeholder,
        maxLength,
        autoComplete: 'off',
        spellCheck: false
    };
    if (multiline) {
        inputProps.rows = 4;
        inputProps.style = { resize: 'vertical', minHeight: 96 };
    } else {
        inputProps.type = 'text';
    }

    return (
        <div className="confirm-dialog">
            <h3 className="confirm-dialog-title">{title}</h3>
            {label && <div className="confirm-dialog-message">{label}</div>}

            <div className="confirm-dialog-verification">
                <InputComponent {...inputProps} />
                {touched && error && (
                    <div className="form-error">{error}</div>
                )}
            </div>

            <div className="confirm-dialog-actions">
                <button
                    type="button"
                    className="confirm-dialog-btn confirm-dialog-btn-cancel"
                    onClick={onCancel}
                >
                    {cancelLabel}
                </button>
                <button
                    type="button"
                    className="confirm-dialog-btn confirm-dialog-btn-normal"
                    onClick={handleSubmit}
                    disabled={isDisabled && touched}
                >
                    {confirmLabel}
                </button>
            </div>
        </div>
    );
}

/**
 * usePrompt() hook — Promise-alapú szöveges bemenet.
 *
 * @returns {(options: Object) => Promise<string|null>} — trimmelt érték vagy null (mégsem)
 */
export function usePrompt() {
    const { openModal, closeModalById } = useModal();

    return useCallback((options = {}) => {
        return new Promise((resolve) => {
            let modalId;

            function handleConfirm(value) {
                closeModalById(modalId);
                resolve(value);
            }

            function handleCancel() {
                closeModalById(modalId);
                resolve(null);
            }

            modalId = openModal(
                <PromptDialog
                    {...options}
                    onConfirm={handleConfirm}
                    onCancel={handleCancel}
                />,
                {
                    size: 'sm',
                    closeOnBackdrop: true,
                    onBeforeClose: () => {
                        handleCancel();
                        return false;
                    }
                }
            );
        });
    }, [openModal, closeModalById]);
}
