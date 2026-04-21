/**
 * Maestro Dashboard — CopyDialog
 *
 * Read-only érték megjelenítése vágólapra-másolással. A `ConfirmDialog` /
 * `PromptDialog` mintáját követi: önmagában nem renderel Modal-t, a
 * `useCopyDialog()` hook nyitja meg a ModalContext-en keresztül.
 *
 * A hívó akkor használja, amikor a `navigator.clipboard.writeText()` nem
 * elérhető (pl. insecure origin, régi böngésző, UXP-szerű sandbox) — a
 * dialog read-only input mezőben mutatja az értéket, auto-fókusz + select,
 * így a user `Ctrl+C`-vel manuálisan másolhat. A „Másolás" gomb újra
 * megpróbálja a clipboard API-t — ha menne, success toast; ha nem megy,
 * a read-only mező manuális másolás marad.
 *
 * Használat:
 *   const copyDialog = useCopyDialog();
 *   copyDialog({ title: 'Meghívó link', value: 'https://…' });
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { useModal } from '../contexts/ModalContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';

/**
 * @param {Object} props
 * @param {string} props.title
 * @param {string} props.value — a másolandó szöveg (read-only mezőben jelenik meg)
 * @param {string|React.ReactNode} [props.description] — magyarázó sor az input fölött
 * @param {string} [props.closeLabel='Bezárás']
 * @param {string} [props.copyLabel='Másolás']
 * @param {Function} props.onClose
 */
export default function CopyDialog({
    title,
    value,
    description,
    closeLabel = 'Bezárás',
    copyLabel = 'Másolás',
    onClose
}) {
    const { showToast } = useToast();
    const inputRef = useRef(null);

    // Explicit focus + select — a clipboard-denied fallback-nél a user Ctrl+C-vel
    // másol, így a value-nak ki kell lennie jelölve a mount után. Az `onFocus`-ra
    // nem támaszkodunk (nem minden böngészőben fire-ol programmatic focus-ra).
    useEffect(() => {
        const timer = setTimeout(() => {
            inputRef.current?.focus();
            inputRef.current?.select?.();
        }, 50);
        return () => clearTimeout(timer);
    }, []);

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(value);
            showToast('Másolva a vágólapra.', 'success');
        } catch {
            // A fallback a read-only input manuális kijelölése marad —
            // újra-select, hogy a user azonnal Ctrl+C-vel másolhasson.
            inputRef.current?.focus();
            inputRef.current?.select?.();
            showToast('A böngésző nem engedi a másolást. Jelöld ki Ctrl+C-vel.', 'warning');
        }
    }

    return (
        <div className="confirm-dialog">
            <h3 className="confirm-dialog-title">{title}</h3>
            {description && (
                <div className="confirm-dialog-message">{description}</div>
            )}

            <div className="confirm-dialog-verification">
                <input
                    ref={inputRef}
                    type="text"
                    className="confirm-dialog-input"
                    value={value}
                    readOnly
                    onFocus={(e) => e.target.select()}
                    spellCheck={false}
                />
            </div>

            <div className="confirm-dialog-actions">
                <button
                    type="button"
                    className="confirm-dialog-btn confirm-dialog-btn-cancel"
                    onClick={onClose}
                >
                    {closeLabel}
                </button>
                <button
                    type="button"
                    className="confirm-dialog-btn confirm-dialog-btn-normal"
                    onClick={handleCopy}
                >
                    {copyLabel}
                </button>
            </div>
        </div>
    );
}

/**
 * useCopyDialog() hook — read-only érték + vágólap-másolás dialog.
 *
 * @returns {(options: Object) => void}
 */
export function useCopyDialog() {
    const { openModal, closeModalById } = useModal();

    return useCallback((options = {}) => {
        let modalId;

        function handleClose() {
            closeModalById(modalId);
        }

        modalId = openModal(
            <CopyDialog
                {...options}
                onClose={handleClose}
            />,
            {
                size: 'sm',
                closeOnBackdrop: true
            }
        );
    }, [openModal, closeModalById]);
}
