import React, { useRef, useEffect, useCallback } from "react";

/**
 * ValidatedTextField Component
 *
 * A wrapper around spectrum's sp-textfield that ensures reliable "commit" events
 * (Enter key and Blur) in the UXP environment.
 *
 * Problem: React's onChange fires on every keystroke in UXP sp-textfields, behaving like onInput.
 * Solution: This component attaches native event listeners (keydown for Enter, focusout for Blur)
 * to the underlying DOM element to trigger onValidate only when the user is done.
 *
 * UXP-specifikus megoldás: callback ref-et használunk a <sp-textfield>-en, hogy akkor is
 * felrakjuk a listenereket, amikor az elem késleltetve mountol (ref.current initial render-kor
 * null vagy nem-DOM wrapper). Fallback az ID-lookup-ra, ha a ref nem HTMLElement.
 *
 * @param {Object} props
 * @param {Function} props.onValidate - Called when value is committed (Enter or Blur). Receives the event.
 * @param {Function} [props.onInput] - Standard onInput handler
 * @param {Function} [props.onChange] - Standard onChange handler (careful: triggers per keystroke in UXP)
 * @param {string} [props.id] - ID is strongly recommended for fallback lookup
 * @param {any} [props.forwardedRef] - Ref to forward to the underlying element
 */
export const ValidatedTextField = ({ onValidate, forwardedRef, onKeyDown, invalid, type, value, ...restProps }) => {
    // UXP sp-textfield type="number" „nan"-t jelenít meg üres string értékre (Number("") → NaN).
    // Normalizáljuk: üres/null/NaN → undefined, hogy a mező valóban üres legyen.
    const normalizedValue = (type === "number" && (value === "" || value == null || (typeof value === "number" && !Number.isFinite(value))))
        ? undefined
        : value;

    // Ref-ek a friss callback-ekhez — a natív listener csak egyszer kerül fel mount-kor,
    // a callback identitás változása nem okoz re-subscribe-ot (elveszett focusout kockázat).
    const onValidateRef = useRef(onValidate);
    const onKeyDownRef = useRef(onKeyDown);
    useEffect(() => { onValidateRef.current = onValidate; }, [onValidate]);
    useEffect(() => { onKeyDownRef.current = onKeyDown; }, [onKeyDown]);

    // A detach függvényt ref-ben tároljuk: a callback ref mount-kor felrakja,
    // unmount-kor (React null-lal hívja a ref callback-et) leveszi.
    const detachRef = useRef(null);
    // Generation counter: minden assignRef hívás lépteti.
    // A microtask retry ellenőrzi, hogy a saját generációja még érvényes-e,
    // különben unmount után hozzá tudna rendelni listenereket egy detached elemhez.
    const generationRef = useRef(0);

    const attachListeners = useCallback((element, id) => {
        // Fallback ID-lookup, ha a ref nem HTMLElement (UXP kivétel: modul export wrapper)
        let inputElement = element;
        if (!(inputElement instanceof HTMLElement) && id) {
            inputElement = document.getElementById(id);
        }
        if (!inputElement) return null;

        const handleCommit = (e) => {
            if (onValidateRef.current) onValidateRef.current(e);
        };

        const handleKeyDown = (e) => {
            if (e.key === 'Enter') {
                // Blur triggers focusout → megakadályozza a dupla commit hívást
                inputElement.blur();
            }
            if (onKeyDownRef.current) onKeyDownRef.current(e);
        };

        inputElement.addEventListener('keydown', handleKeyDown);
        inputElement.addEventListener('focusout', handleCommit);

        return () => {
            inputElement.removeEventListener('keydown', handleKeyDown);
            inputElement.removeEventListener('focusout', handleCommit);
        };
    }, []);

    const assignRef = useCallback((element) => {
        // Új generáció — az előző microtask retry-ok (ha vannak) érvénytelenné válnak
        const myGeneration = ++generationRef.current;

        // Előző listenerek leszedése (pl. elem csere, unmount)
        if (detachRef.current) {
            detachRef.current();
            detachRef.current = null;
        }

        // forwardedRef tükrözése (mindig — új elemre és null-ra is)
        if (forwardedRef) {
            if (typeof forwardedRef === 'function') {
                forwardedRef(element);
            } else {
                forwardedRef.current = element;
            }
        }

        if (!element) return;

        const id = restProps.id;
        const detach = attachListeners(element, id);
        if (detach) {
            detachRef.current = detach;
            return;
        }

        // UXP edge case: ha mount-kor sem a ref, sem az ID-lookup nem ad használható elemet,
        // egyszeri microtask retry — az sp-textfield DOM csatolása aszinkron is megtörténhet.
        // Guard: ha közben unmount vagy új element érkezett (generationRef lépett), skipp.
        queueMicrotask(() => {
            if (myGeneration !== generationRef.current) return;
            if (detachRef.current) return;
            const retryDetach = attachListeners(element, id);
            if (retryDetach) detachRef.current = retryDetach;
        });
    }, [forwardedRef, restProps.id, attachListeners]);

    return (
        <sp-textfield
            ref={assignRef}
            type={type}
            value={normalizedValue}
            {...restProps}
            {...(invalid ? { invalid: true } : {})}
        />
    );
};
