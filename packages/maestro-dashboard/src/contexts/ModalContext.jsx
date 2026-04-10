/**
 * Maestro Dashboard — ModalContext
 *
 * Modal stack kezelés. Minden `openModal()` hívás egy új réteget ad a stackhez,
 * növekvő z-index-szel és a mögöttes tartalom blur-özésével. A `closeModal()`
 * a legfelső réteget távolítja el.
 *
 * Használat:
 *   const { openModal, closeModal } = useModal();
 *   openModal(<PublicationSettingsModal pubId={id} />);
 *
 * A modal tartalma a `useModal()` hook-on keresztül éri el a `closeModal`-t —
 * nincs szükség `cloneElement` prop injection-re.
 */

import React, { createContext, useContext, useState, useCallback } from 'react';
import Modal from '../components/Modal.jsx';

const ModalContext = createContext(null);

/** @returns {{ openModal: Function, closeModal: Function, closeModalById: Function, modalCount: number }} */
export function useModal() {
    const ctx = useContext(ModalContext);
    if (!ctx) throw new Error('useModal() kizárólag ModalProvider-en belül használható.');
    return ctx;
}

const BASE_Z_INDEX = 1000;
let nextModalId = 0;

export function ModalProvider({ children }) {
    // Stack: [{ id, element, props }]
    const [stack, setStack] = useState([]);

    /**
     * Új modal megnyitása.
     * @param {React.ReactElement} element — a modal tartalma (children-ként kerül a Modal-ba)
     * @param {Object} [props] — Modal props (size, title, onBeforeClose, closeOnBackdrop)
     * @returns {number} — modal ID (closeModalById-hoz)
     */
    const openModal = useCallback((element, props = {}) => {
        const id = ++nextModalId;
        setStack(prev => [...prev, { id, element, props }]);
        return id;
    }, []);

    /** A legfelső modal bezárása. */
    const closeModal = useCallback(() => {
        setStack(prev => prev.slice(0, -1));
    }, []);

    /**
     * Egy konkrét modal bezárása ID alapján.
     * (Hasznos ha a modal saját magát akarja bezárni.)
     */
    const closeModalById = useCallback((id) => {
        setStack(prev => prev.filter(m => m.id !== id));
    }, []);

    return (
        <ModalContext.Provider value={{ openModal, closeModal, closeModalById, modalCount: stack.length }}>
            {children}
            {stack.map((entry, index) => (
                <Modal
                    key={entry.id}
                    zIndex={BASE_Z_INDEX + index * 10}
                    onClose={() => closeModalById(entry.id)}
                    {...entry.props}
                >
                    {entry.element}
                </Modal>
            ))}
        </ModalContext.Provider>
    );
}
