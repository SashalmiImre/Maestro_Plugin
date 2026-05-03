/**
 * Maestro Dashboard — EmptyRequiredGroupsDialog (ADR 0008 / A.4.8)
 *
 * Modal-tartalom, ami az `activate_publication` 409 `empty_required_groups`
 * válaszra jelenik meg. A CF response `slugs[]` tartalmazza a hiányzó
 * csoport slug-jait — a UI listázza, és egy CTA-val átnavigál a
 * `EditorialOfficeSettingsModal` „Csoportok" fülére, ahol a felhasználó
 * tagokat adhat hozzá.
 *
 * **Slug → label feloldás**: a kiadványhoz rendelt workflow `compiled.requiredGroupSlugs[]`-ból
 * próbáljuk megkapni az emberi olvasható label-t. Ha nem találjuk
 * (a workflow doc nincs a kontextusban), a slug-ot mutatjuk.
 */

import React from 'react';
import { useModal } from '../../contexts/ModalContext.jsx';
import EditorialOfficeSettingsModal from '../organization/EditorialOfficeSettingsModal.jsx';

/**
 * @param {Object} props
 * @param {Object} props.publication - a kiadvány doc
 * @param {string[]} props.missingSlugs - a CF response `slugs` tömbje
 * @param {Object|null} [props.workflowCompiled] - opcionális, a kiadványhoz rendelt
 *   workflow compiled JSON-ja (a `requiredGroupSlugs[]` label feloldáshoz)
 */
export default function EmptyRequiredGroupsDialog({ publication, missingSlugs = [], workflowCompiled = null }) {
    const { closeModal, openModal } = useModal();

    // Slug → label térkép a workflow compiled-ből (best-effort).
    const labelMap = new Map();
    if (Array.isArray(workflowCompiled?.requiredGroupSlugs)) {
        for (const g of workflowCompiled.requiredGroupSlugs) {
            if (g?.slug) labelMap.set(g.slug, g.label || g.slug);
        }
    }

    function handleNavigateToGroups() {
        // Bezárjuk ezt a modalt, és megnyitjuk a szerkesztőség beállítások
        // modalt a Csoportok fülön. A modal-stack megengedi, hogy a parent
        // (PublicationSettingsModal vagy DashboardLayout) alatt új réteget
        // nyissunk — a felhasználó a tag-hozzáadás után kézzel zárja vagy
        // visszanavigál.
        closeModal();
        openModal(
            <EditorialOfficeSettingsModal
                editorialOfficeId={publication.editorialOfficeId}
                initialTab="groups"
            />,
            { size: 'lg', title: 'Szerkesztőség beállítások — Csoportok' }
        );
    }

    return (
        <div className="publication-form empty-required-groups">
            <p>
                A(z) <strong>„{publication.name}"</strong> kiadvány aktiválásához az alábbi
                felhasználó-csoportoknak <strong>legalább 1 tagja</strong> kell legyen.
                A workflow ezeket a csoportokat hivatkozza
                a <code>requiredGroupSlugs</code>-ban — üres csoport esetén a
                cikk-szintű állapot-átmenetek nem futnának.
            </p>

            <ul className="empty-required-groups__list">
                {missingSlugs.length === 0 ? (
                    <li className="empty-required-groups__placeholder">
                        (A szerver nem küldött részletes slug-listát.)
                    </li>
                ) : missingSlugs.map((slug) => {
                    const label = labelMap.get(slug);
                    return (
                        <li key={slug} className="empty-required-groups__item">
                            <span className="empty-required-groups__name">{label || slug}</span>
                            {label && (
                                <code className="empty-required-groups__slug">{slug}</code>
                            )}
                            <span className="eo-chip eo-chip--zero-tag empty-required-groups__zero-tag">0 tag</span>
                        </li>
                    );
                })}
            </ul>

            <p className="empty-required-groups__hint">
                Tipp: a tag-hozzáadás után térj vissza ide és próbáld újra az aktiválást.
                Az aktiválás csak akkor sikerül, ha minden hivatkozott csoportnak van legalább 1 tagja.
            </p>

            <div className="modal-actions empty-required-groups__actions">
                <button
                    type="button"
                    onClick={closeModal}
                    className="btn-secondary"
                >Mégse</button>
                <button
                    type="button"
                    onClick={handleNavigateToGroups}
                    className="btn-primary"
                >Tagok hozzáadása</button>
            </div>
        </div>
    );
}
