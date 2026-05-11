/**
 * Maestro Dashboard — Modal
 *
 * Portál-alapú modal komponens. Lekerekített sarkú kártya háttér blur-rel,
 * ESC billentyű, focus trap, és CSS transition mount/unmount-nál.
 *
 * Egymásra épülő (nested) modalokat is támogat a ModalContext stack-en
 * keresztül — minden újabb réteg blur-öli az előzőt.
 */

import React, { useEffect, useRef, useCallback, useState, useImperativeHandle, forwardRef } from 'react';
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
 * @param {Function} props.onClose — bezárás callback (a záró animáció UTÁN fut le)
 * @param {Function} [props.onBeforeClose] — dirty-form guard: ha false-t ad vissza, nem zárul be
 * @param {Function} [props.onAfterClose] — záró animáció UTÁN, az `onClose` előtt fut.
 *   Ide hívd a Promise-resolve-ot (useConfirm/usePrompt), hogy az `await confirm()`
 *   a tényleges animált záráshoz igazodjon.
 * @param {boolean} [props.closeOnBackdrop=true] — háttérre kattintás bezár-e
 * @param {number} [props.zIndex] — explicit z-index (ModalContext stack esetén)
 * @param {React.ReactNode} props.children
 *
 * Imperative API (ref-en át):
 *   ref.current.requestClose() — kívülről indított animált zárás (Mégse-gomb,
 *     scope-váltás auto-close stb.). Ugyanazon `attemptClose()` útvonalon megy,
 *     mint az ESC/backdrop/✕ — `onBeforeClose` guard érvényes, `closingRef`
 *     re-entrancy védi, és a 200ms-os fade-out animáció lefut.
 */
const Modal = forwardRef(function Modal({
    size = 'md',
    title,
    onClose,
    onBeforeClose,
    onAfterClose,
    closeOnBackdrop = true,
    zIndex,
    children
}, ref) {
    const cardRef = useRef(null);
    const previousFocusRef = useRef(null);
    const closingRef = useRef(false);
    const closeTimerRef = useRef(null);
    const [isClosing, setIsClosing] = useState(false);

    // A nyitás-animációt a CSS `@keyframes` mount-ról automatikusan játszik
    // (lásd `modal.css`). A korábbi JS-state + rAF + setIsOpen minta a
    // WorkflowDesigner re-render-ciklusa alatt cancelálódó rAF miatt
    // stuck-on hagyta a modal-t — a CSS-only enter független a render-pipeline-tól.

    // Az `onClose` / `onAfterClose` ref-pinning: a parent (ModalProvider) minden
    // render-en új arrow-okat ad át — ezzel az `attemptClose` deps-szel csak
    // `onBeforeClose`-tól függ (ritkán változó), így az `useImperativeHandle`
    // és a globális ESC-listener nem re-mountol minden render-en.
    const onCloseRef = useRef(onClose);
    const onAfterCloseRef = useRef(onAfterClose);
    onCloseRef.current = onClose;
    onAfterCloseRef.current = onAfterClose;

    // `closingRef` re-entrancy guard: gyors duplakattintás a backdrop-on / ESC-en
    // / Mégse-gombon ne indítson párhuzamos záró timer-t. Az `onClose` a
    // 200ms-os animáció VÉGÉN fut le (stack-slice → unmount), az `onAfterClose`
    // utána (Promise-resolve hely a useConfirm/usePrompt-nak).
    const attemptClose = useCallback(() => {
        if (closingRef.current) return;
        if (onBeforeClose && onBeforeClose() === false) return;
        closingRef.current = true;
        setIsClosing(true);
        closeTimerRef.current = setTimeout(() => {
            closeTimerRef.current = null;
            onCloseRef.current?.();
            if (onAfterCloseRef.current) onAfterCloseRef.current();
        }, CLOSE_ANIMATION_MS);
    }, [onBeforeClose]);

    // Imperative API: a ModalProvider a stack-ben tartott ref-en át hívja a
    // `requestClose()`-t, amikor `closeModal()` / `closeModalById()` / scope-
    // váltás auto-close történik. Ezzel a Mégse-gomb és bármely belső close-
    // gomb is ugyanazt a 200ms fade+slide+scale exit animációt fussa, mint az
    // ESC / backdrop / ✕. A `closingRef.current` guard mindkét csatornát védi.
    useImperativeHandle(ref, () => ({
        requestClose: attemptClose
    }), [attemptClose]);

    // Pending close-timer takarítás: ha a parent (pl. scope auto-close)
    // előbb unmount-ol, mint hogy a setTimeout lejárna, ne maradjon
    // árva timer (potenciális onClose-hívás már unmountolt komponensre).
    //
    // Stack-leak guard: ha a unmount éppen az `is-closing` 200ms-os ablakban
    // történik (a timer még pending), a `commitClose` sose fut → a
    // ModalProvider stack-ben árva entry marad (legrosszabb esetben fantom
    // Modal a következő openModal után). A cleanup itt synchron meghívja az
    // `onClose`-t (`commitClose(id)`) is, hogy a stack-slice mindenképp
    // lemenjen. Ha közben a teljes ModalProvider unmountolt, a setState
    // egy "no-op on unmounted component" lesz (csendes), nem regresszió.
    useEffect(() => () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
            // Pending exit-animáció félbeszakítva: zárjuk a stack-entry-t
            // hogy a ModalProvider ne tartson fantomot. Az onAfterClose
            // (Promise resolve) is fut, hogy a `useConfirm`/`usePrompt`
            // hívó `await` continuation-je ne lógjon örökre.
            try { onCloseRef.current?.(); } catch { /* unmount race */ }
            try { onAfterCloseRef.current?.(); } catch { /* unmount race */ }
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

    const overlayClass = `modal-overlay${isClosing ? ' is-closing' : ''}`;
    const cardClass = `modal-card modal-${size}${isClosing ? ' is-closing' : ''}`;

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
});

export default Modal;
