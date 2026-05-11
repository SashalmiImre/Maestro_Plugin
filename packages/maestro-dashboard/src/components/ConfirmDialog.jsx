/**
 * Maestro Dashboard — ConfirmDialog
 *
 * Megerősítő dialógus tartalom. Támogatja a „név begépelés" verifikációt
 * (törlés megerősítéshez) és az egyszerű igen/nem megerősítést is.
 *
 * Önmagában nem renderel Modal-t — a `useConfirm()` hook nyitja meg
 * a ModalContext-en keresztül, így nested modalban is biztonságosan
 * használható (nincs double-wrap).
 *
 * Használat:
 *   const confirm = useConfirm();
 *   const ok = await confirm({ title: 'Törlés', message: 'Biztos?' });
 *   if (ok) { ... }
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useModal } from '../contexts/ModalContext.jsx';

/**
 * @param {Object} props
 * @param {string} props.title — dialógus cím
 * @param {string|React.ReactNode} props.message — leíró szöveg
 * @param {Function} props.onConfirm — megerősítés callback
 * @param {Function} props.onCancel — mégsem / bezárás callback
 * @param {string} [props.verificationExpected] — ha megadott, a felhasználónak
 *   pontosan ezt a szöveget kell begépelnie a megerősítéshez
 * @param {string} [props.confirmLabel='Törlés'] — megerősítő gomb felirata
 * @param {string} [props.cancelLabel='Mégsem'] — mégsem gomb felirata
 * @param {boolean} [props.isAlert=false] — ha true, nincs mégsem gomb
 * @param {'danger'|'normal'} [props.variant='danger'] — megerősítő gomb stílus
 */
export default function ConfirmDialog({
    title,
    message,
    onConfirm,
    onCancel,
    verificationExpected,
    confirmLabel,
    cancelLabel = 'Mégsem',
    isAlert = false,
    variant = 'danger'
}) {
    const [input, setInput] = useState('');
    const inputRef = useRef(null);

    // Auto-fókusz az input mezőre
    useEffect(() => {
        if (verificationExpected && inputRef.current) {
            const timer = setTimeout(() => inputRef.current?.focus(), 100);
            return () => clearTimeout(timer);
        }
    }, [verificationExpected]);

    const isConfirmDisabled = verificationExpected
        ? input !== verificationExpected
        : false;

    const defaultLabel = isAlert ? 'OK' : 'Törlés';

    function handleKeyDown(e) {
        if (e.key === 'Enter' && !isConfirmDisabled) {
            e.preventDefault();
            onConfirm();
        }
    }

    return (
        <div className="confirm-dialog">
            <h3 className="confirm-dialog-title">{title}</h3>
            <div className="confirm-dialog-message">{message}</div>

            {verificationExpected && (
                <div className="confirm-dialog-verification">
                    <label className="confirm-dialog-label">
                        A megerősítéshez írd be: <strong>{verificationExpected}</strong>
                    </label>
                    <input
                        ref={inputRef}
                        type="text"
                        className="confirm-dialog-input"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={verificationExpected}
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>
            )}

            <div className="confirm-dialog-actions">
                {!isAlert && (
                    <button
                        type="button"
                        className="confirm-dialog-btn confirm-dialog-btn-cancel"
                        onClick={onCancel}
                    >
                        {cancelLabel}
                    </button>
                )}
                <button
                    type="button"
                    className={`confirm-dialog-btn confirm-dialog-btn-${variant}`}
                    onClick={onConfirm}
                    disabled={isConfirmDisabled}
                >
                    {confirmLabel || defaultLabel}
                </button>
            </div>
        </div>
    );
}

/**
 * useConfirm() hook — Promise-alapú megerősítő dialógus.
 *
 * A ModalContext-en keresztül nyitja meg a ConfirmDialog-ot,
 * és a felhasználó válaszát (true/false) Promise-ként adja vissza.
 *
 * @returns {(options: Object) => Promise<boolean>}
 *
 * Használat:
 *   const confirm = useConfirm();
 *   const ok = await confirm({ title: 'Törlés', message: 'Biztos?', verificationExpected: 'Kiadvány neve' });
 */
export function useConfirm() {
    const { openModal, closeModalById } = useModal();

    return useCallback((options = {}) => {
        return new Promise((resolve) => {
            // A user választása egy ref-ben, amit a Promise resolve-ja olvas
            // ki a záró animáció VÉGÉN (Modal `onAfterClose`). Default: false
            // (Cancel/ESC/backdrop/✕ mind a default ágra futnak, csak az OK gomb
            // állítja át `true`-ra).
            const resultRef = { current: false };
            let modalId;

            modalId = openModal(
                <ConfirmDialog
                    {...options}
                    onConfirm={() => { resultRef.current = true; closeModalById(modalId); }}
                    onCancel={() => { resultRef.current = false; closeModalById(modalId); }}
                />,
                {
                    size: 'sm',
                    closeOnBackdrop: !options.isAlert,
                    onAfterClose: () => resolve(resultRef.current)
                }
            );
        });
    }, [openModal, closeModalById]);
}
