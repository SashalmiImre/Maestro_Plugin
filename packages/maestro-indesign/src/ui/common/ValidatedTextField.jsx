import React, { useRef, useEffect } from "react";

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
 * It also handles the tricky Part of getting the DOM reference, falling back to ID lookup
 * if the ref returns a module object (common UXP/React issue).
 * 
 * @param {Object} props
 * @param {Function} props.onValidate - Called when value is committed (Enter or Blur). Receives the event.
 * @param {Function} [props.onInput] - Standard onInput handler
 * @param {Function} [props.onChange] - Standard onChange handler (careful: triggers per keystroke in UXP)
 * @param {string} [props.id] - ID is strongly recommended for fallback lookup
 * @param {any} [props.forwardedRef] - Ref to forward to the underlying element
 */
export const ValidatedTextField = ({ onValidate, forwardedRef, onKeyDown, invalid, ...props }) => {
    const internalRef = useRef(null);
    const ref = internalRef;

    // Sync forwardedRef with internal ref
    useEffect(() => {
        if (!forwardedRef) return;

        if (typeof forwardedRef === 'function') {
            forwardedRef(internalRef.current);
        } else {
            // Assume object ref
            forwardedRef.current = internalRef.current;
        }

        return () => {
            if (typeof forwardedRef === 'function') {
                forwardedRef(null);
            }
        };
    }, [forwardedRef]);

    useEffect(() => {
        // Resolve the DOM element
        let inputElement = ref.current;

        // Fallback to ID lookup if ref is not an HTMLElement (e.g. module export in UXP)
        if (inputElement && !(inputElement instanceof HTMLElement) && props.id) {
            inputElement = document.getElementById(props.id);
        }

        // Event handler wrapper
        const handleCommit = (e) => {
            if (onValidate) {
                // Ensure we pass the event with the current value
                onValidate(e);
            }
        };

        // Keydown handler to check for Enter
        const handleKeyDown = (e) => {
            if (e.key === 'Enter') {
                // Blur triggers focusout, which handles commit
                // This prevents duplicate commit calls (once for Enter, once for resulting Blur)
                inputElement.blur();
            }
            if (onKeyDown) {
                onKeyDown(e);
            }
        };

        if (inputElement) {
            inputElement.addEventListener('keydown', handleKeyDown);
            inputElement.addEventListener('focusout', handleCommit);
            // We can also listen to 'change' if UXP fixes it in future, but focusout is reliable for blur
        }

        return () => {
            if (inputElement) {
                inputElement.removeEventListener('keydown', handleKeyDown);
                inputElement.removeEventListener('focusout', handleCommit);
            }
        };
    }, [onValidate, props.id, onKeyDown]); // Re-attach if handlers or ID change

    return (
        <sp-textfield
            ref={ref}
            {...props}
            {...(invalid ? { invalid: true } : {})}
        />
    );
};
