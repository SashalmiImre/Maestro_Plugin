/**
 * Maestro Dashboard — Modal
 *
 * Portál-alapú modal komponens. Lekerekített sarkú kártya háttér blur-rel,
 * ESC billentyű, focus trap, és CSS transition mount/unmount-nál.
 *
 * Egymásra épülő (nested) modalokat is támogat a ModalContext stack-en
 * keresztül — minden újabb réteg blur-öli az előzőt.
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
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
 * Bezárás-animáció hossza ms-ben — szinkronban a `modal.css`
 * `modalFadeOut` / `modalSlideOut` keyframe-jeivel.
 *
 * Miért: nyitásra `modalFadeIn` (0.2s) van, de bezárásra korábban
 * azonnali unmount történt — a `backdrop-filter: blur(8px)` réteg
 * abrupt eltűnése a háttér ArticleTable / LayoutView újra-festését
 * okozta, ami villanásnak látszott. A szimmetrikus fade-out simítja
 * ezt: az overlay opacity-jét lassan visszaviszi 0-ra a unmount előtt.
 */
const CLOSE_ANIMATION_MS = 200;

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
    const closingRef = useRef(false);
    const closeTimerRef = useRef(null);
    const [isOpen, setIsOpen] = useState(false);
    const [isClosing, setIsClosing] = useState(false);

    // Mount-ot követő rAF: a CSS-ben az alapérték `opacity: 0` + transition;
    // egy frame múlva a `.is-open` átkapcsolja `opacity: 1`-re és a transition
    // az aktuális komputált értékből interpolál. Strict Mode-ban a dupla
    // mount/unmount-ra a rAF-et cancel-eljük, hogy ne maradjon árva.
    useEffect(() => {
        const rafId = requestAnimationFrame(() => setIsOpen(true));
        return () => cancelAnimationFrame(rafId);
    }, []);

    // Bezárás kísérlet — onBeforeClose guard-dal. Két fázis:
    //   1) `isClosing=true` → a CSS `is-closing` osztály opacity-t 0-ra,
    //      kártyát kicsit lejjebb+kicsinyíti az AKTUÁLIS állapotból
    //      (transition interpolál — nincs snap mid-open close esetén).
    //   2) `CLOSE_ANIMATION_MS` után tényleges `onClose()` (unmount).
    // A `closingRef` re-entrancy guard: gyors duplakattintás a backdrop-on
    // vagy ESC ne indítson párhuzamos záró timer-t.
    const attemptClose = useCallback(() => {
        if (closingRef.current) return;
        if (onBeforeClose && onBeforeClose() === false) return;
        closingRef.current = true;
        setIsClosing(true);
        closeTimerRef.current = setTimeout(() => {
            closeTimerRef.current = null;
            onClose();
        }, CLOSE_ANIMATION_MS);
    }, [onClose, onBeforeClose]);

    // Pending close-timer takarítás: ha a parent (pl. scope auto-close)
    // előbb unmount-ol, mint hogy a setTimeout lejárna, ne maradjon
    // árva timer (potenciális onClose-hívás már unmountolt komponensre).
    useEffect(() => () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    }, []);

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
    // Figyelem: ha valamelyik belső mező `autoFocus`-t használ, azt nem szabad
    // felülbírálni — különben a kierőltetett blur elindítaná a touched/invalid
    // állapotot a mezőn még mielőtt a felhasználó bármit csinált volna.
    useEffect(() => {
        previousFocusRef.current = document.activeElement;
        let rafId = requestAnimationFrame(() => {
            if (!cardRef.current) return;
            // Ha az autoFocus már a kártyán belülre állította a fókuszt, hagyjuk békén.
            if (cardRef.current.contains(document.activeElement)) return;
            const firstFocusable = cardRef.current.querySelector(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            );
            if (firstFocusable) firstFocusable.focus();
            else cardRef.current.focus();
        });

        return () => {
            cancelAnimationFrame(rafId);
            // `preventScroll: true` — a focus restore alapértelmezetten
            // `scrollIntoView`-t hív, ami a háttér tartalmat (ArticleTable
            // sora, LayoutView page-slot) elgörgetheti, ha az előző fókusz
            // pont nem éppen viewport-ban van. Az ugrás "villanásnak" látszik
            // a fade-out közben.
            if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
                previousFocusRef.current.focus({ preventScroll: true });
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

    const overlayClass = `modal-overlay${isOpen ? ' is-open' : ''}${isClosing ? ' is-closing' : ''}`;
    const cardClass = `modal-card modal-${size}${isOpen ? ' is-open' : ''}${isClosing ? ' is-closing' : ''}`;

    return createPortal(
        <div
            ref={overlayRef}
            className={overlayClass}
            style={overlayStyle}
            onClick={handleBackdropClick}
        >
            <div
                ref={cardRef}
                className={cardClass}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-label={typeof title === 'string' ? title : 'Párbeszédablak'}
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
