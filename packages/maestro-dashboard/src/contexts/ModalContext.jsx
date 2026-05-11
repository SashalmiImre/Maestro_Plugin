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
 *
 * Scope-váltás auto-close:
 *   Az aktív szervezet / szerkesztőség ID megváltozása automatikusan bezárja
 *   a teljes modal stack-et. Ennek oka: a legtöbb nyitott modal (org settings,
 *   publication settings, create flows) egy konkrét scope-hoz kötődik — ha a
 *   user másik org-ra / office-ra vált (akár manuálisan a dropdown-ból, akár
 *   automatikusan stale ID védelemmel), a modal adatai félrevezetővé válnak.
 *   Az új office létrehozás (`CreateEditorialOfficeModal`) szándékosan is
 *   erre az auto-close-ra támaszkodik a sikeres scope-váltás után.
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef, createRef } from 'react';
import Modal from '../components/Modal.jsx';
import { useScope } from './ScopeContext.jsx';

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
    // Stack: [{ id, element, props, ref }]
    //
    // A `ref` egy `createRef()` minden új entry-nél — a Modal komponensre mutat,
    // és a `closeModal()` / `closeModalById()` / scope-auto-close ezen át hívja
    // a Modal `requestClose()` imperative API-ját. Ezzel a Mégse-gombok és bármely
    // belső close-csatorna is végigfut a 200ms fade+slide+scale exit animáción
    // (ugyanaz az út, mint az ESC/backdrop/✕). A tényleges stack-slice a Modal
    // `onClose` prop callback-jén keresztül jön vissza, az animáció VÉGÉN.
    const [stack, setStack] = useState([]);

    // ScopeContext opcionális — ha a ModalProvider-t kívülről ScopeProvider nem
    // wrappeli (pl. egy jövőbeli teszt-harness), az auto-close kikapcsolt marad.
    const scope = useScope();
    const activeOrgId = scope?.activeOrganizationId ?? null;
    const activeOfficeId = scope?.activeEditorialOfficeId ?? null;

    /**
     * Új modal megnyitása.
     * @param {React.ReactElement} element — a modal tartalma (children-ként kerül a Modal-ba)
     * @param {Object} [props] — Modal props (size, title, onBeforeClose, onAfterClose, closeOnBackdrop)
     * @returns {number} — modal ID (closeModalById-hoz)
     */
    // `stackRef` a closeModal/closeModalById getter-éhez (render-en kívüli
    // imperatív hívás) — a mutációt a `setStack` updaterekben végezzük, így
    // nem kell külön `useEffect [stack]` szinkronizáció (egy felesleges
    // effect-fázis modal-nyit/zár-onkénti megspórolva).
    const stackRef = useRef([]);

    const openModal = useCallback((element, props = {}) => {
        const id = ++nextModalId;
        setStack(prev => {
            const next = [...prev, { id, element, props, ref: createRef() }];
            stackRef.current = next;
            return next;
        });
        return id;
    }, []);

    // A tényleges stack-eltávolítás a Modal `onClose` callback-jén át jön
    // vissza, amikor a 200ms-os záró-animáció lefutott (Modal.jsx setTimeout).
    // Külön névvel, mert a closeModal/closeModalById „kérés" → animált zárás,
    // míg ez az „animáció vége → commit".
    const commitClose = useCallback((id) => {
        setStack(prev => {
            const next = prev.filter(m => m.id !== id);
            stackRef.current = next;
            return next;
        });
    }, []);

    // Belső segéd: kérjük az adott entry-től az animált zárást a ref-en át.
    // `queueMicrotask` defer-eli az imperatív hívást, hogy a Modal `setIsClosing`
    // a JELENLEGI React render-fázis BEFEJEZÉSE UTÁN fusson. Anélkül a setState
    // egy MÁSIK komponensen render-közben "Cannot update a component while
    // rendering a different component" warning-ot dobott. A microtask 1-2µs
    // késleltetés vizuálisan láthatatlan a 200ms-os animációhoz képest.
    function requestEntryClose(entry) {
        const handle = entry.ref?.current;
        if (handle && typeof handle.requestClose === 'function') {
            queueMicrotask(() => handle.requestClose());
        } else {
            queueMicrotask(() => commitClose(entry.id));
        }
    }

    /** A legfelső modal animált bezárása. */
    const closeModal = useCallback(() => {
        const top = stackRef.current[stackRef.current.length - 1];
        if (top) requestEntryClose(top);
    }, []);

    /**
     * Egy konkrét modal animált bezárása ID alapján.
     * (Hasznos ha a modal saját magát akarja bezárni — Mégse / Mentés gomb.)
     */
    const closeModalById = useCallback((id) => {
        const entry = stackRef.current.find(m => m.id === id);
        if (entry) requestEntryClose(entry);
    }, []);

    // Scope auto-close — csak tényleges váltásnál zárjuk a stack-et, nem
    // a kezdeti mount-kor. A ref eltárolja az előző scope-ot, így a mount-
    // effectben nem villan be üres modal-stack felesleges setState.
    //
    // Animált csukás: mindegyik entry-re külön `requestClose()` — Modal-onként
    // saját 200ms-os fade-out, párhuzamosan. Stacked esetben a fade-out-ok
    // overlap-elnek (vizuálisan rendben, a backdrop blur réteg összemosódik).
    // A tényleges stack-slice egyenként, az animációk végén jön a commitClose-on.
    const prevScopeRef = useRef({ org: activeOrgId, office: activeOfficeId });
    useEffect(() => {
        const prev = prevScopeRef.current;
        if (prev.org !== activeOrgId || prev.office !== activeOfficeId) {
            prevScopeRef.current = { org: activeOrgId, office: activeOfficeId };
            for (const entry of stackRef.current) requestEntryClose(entry);
        }
    }, [activeOrgId, activeOfficeId]);

    return (
        <ModalContext.Provider value={{ openModal, closeModal, closeModalById, modalCount: stack.length }}>
            {children}
            {stack.map((entry, index) => (
                <Modal
                    key={entry.id}
                    ref={entry.ref}
                    zIndex={BASE_Z_INDEX + index * 10}
                    onClose={() => commitClose(entry.id)}
                    {...entry.props}
                >
                    {entry.element}
                </Modal>
            ))}
        </ModalContext.Provider>
    );
}
