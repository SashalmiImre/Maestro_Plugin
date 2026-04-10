/**
 * Maestro Dashboard — Modal
 *
 * Portál-alapú modal komponens. Lekerekített sarkú kártya háttér blur-rel,
 * ESC billentyű, focus trap, és CSS transition mount/unmount-nál.
 *
 * Egymásra épülő (nested) modalokat is támogat a ModalContext stack-en
 * keresztül — minden újabb réteg blur-öli az előzőt.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

/**
 * Globális scroll lock számláló. Amíg legalább egy modal nyitva van,
 * a body scroll le van tiltva. Csak az utolsó modal unmount-ja állítja
 * vissza — megoldja a nested modal scroll lock problémát.
 *
 * Strict Mode (dev): a dupla effect mount/unmount szimmetrikus,
 * így a számláló konzisztens marad (++/-- páros).
 */
let scrollLockCount = 0;

/**
 * @param {Object} props
 * @param {'sm'|'md'|'lg'|'xl'} [props.size='md'] — kártya szélesség
 * @param {string} [props.title] — opcionális fejléc cím
 * @param {Function} props.onClose — bezárás callback
 * @param {Function} [props.onBeforeClose] — dirty-form guard: ha false-t ad vissza, nem zárul be
 * @param {boolean} [props.closeOnBackdrop=true] — háttérre kattintás bezár-e
 * @param {number} [props.zIndex] — explicit z-index (ModalContext stack esetén)
 * @param {React.ReactNode} props.children
 */
export default function Modal({
    size = 'md',
    title,
    onClose,
    onBeforeClose,
    closeOnBackdrop = true,
    zIndex,
    children
}) {
    const cardRef = useRef(null);
    const previousFocusRef = useRef(null);

    // Bezárás kísérlet — onBeforeClose guard-dal
    const attemptClose = useCallback(() => {
        if (onBeforeClose && onBeforeClose() === false) return;
        onClose();
    }, [onClose, onBeforeClose]);

    // ESC billentyű — csak a legfelső modal reagál
    const overlayRef = useRef(null);
    useEffect(() => {
        function handleKeyDown(e) {
            if (e.key !== 'Escape') return;
            // Csak a legfelső (utolsó DOM-beli) overlay kezeli az ESC-et
            const allOverlays = document.querySelectorAll('.modal-overlay');
            if (allOverlays.length === 0) return;
            if (allOverlays[allOverlays.length - 1] !== overlayRef.current) return;
            e.stopPropagation();
            attemptClose();
        }
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [attemptClose]);

    // Focus trap + eredeti fókusz visszaállítás
    useEffect(() => {
        previousFocusRef.current = document.activeElement;
        let rafId = requestAnimationFrame(() => {
            if (cardRef.current) {
                const firstFocusable = cardRef.current.querySelector(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                );
                if (firstFocusable) firstFocusable.focus();
                else cardRef.current.focus();
            }
        });

        return () => {
            cancelAnimationFrame(rafId);
            if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
                previousFocusRef.current.focus();
            }
        };
    }, []);

    // Focus trap: Tab billentyűvel a kártyán belül marad
    useEffect(() => {
        function handleTab(e) {
            if (e.key !== 'Tab' || !cardRef.current) return;

            const focusable = cardRef.current.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            );
            if (focusable.length === 0) {
                e.preventDefault();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];

            if (e.shiftKey) {
                if (document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        }
        document.addEventListener('keydown', handleTab);
        return () => document.removeEventListener('keydown', handleTab);
    }, []);

    // Body scroll lock — globális számláló, csak az utolsó modal állítja vissza
    useEffect(() => {
        scrollLockCount++;
        if (scrollLockCount === 1) {
            document.body.style.overflow = 'hidden';
        }
        return () => {
            scrollLockCount--;
            if (scrollLockCount === 0) {
                document.body.style.overflow = '';
            }
        };
    }, []);

    function handleBackdropClick(e) {
        if (e.target === e.currentTarget && closeOnBackdrop) {
            attemptClose();
        }
    }

    const overlayStyle = zIndex != null ? { zIndex } : undefined;

    return createPortal(
        <div
            ref={overlayRef}
            className="modal-overlay"
            style={overlayStyle}
            onClick={handleBackdropClick}
        >
            <div
                ref={cardRef}
                className={`modal-card modal-${size}`}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-label={title || 'Párbeszédablak'}
            >
                {title && (
                    <div className="modal-header">
                        <h2 className="modal-title">{title}</h2>
                        <button
                            type="button"
                            className="modal-close-btn"
                            onClick={attemptClose}
                            aria-label="Bezárás"
                        >
                            ✕
                        </button>
                    </div>
                )}
                <div className="modal-body">
                    {children}
                </div>
            </div>
        </div>,
        document.body
    );
}
