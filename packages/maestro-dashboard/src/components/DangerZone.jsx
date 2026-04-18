/**
 * Maestro Dashboard — DangerZone
 *
 * Közös „Veszélyes zóna" szekció destruktív műveletekhez (szervezet /
 * szerkesztőség / publikáció kaszkád törlés). A három felhasználási hely
 * (OrganizationSettingsModal, EditorialOfficeSettingsModal, GeneralTab)
 * eredetileg inline másolatokat tartalmazott — ez eliminálja a duplikációt,
 * és a piros palettát a `.danger-zone` CSS osztályban centralizálja.
 */

import React from 'react';

/**
 * @param {Object} props
 * @param {string} [props.title='Veszélyes zóna'] — szekció fejléc
 * @param {React.ReactNode} props.description — magyarázó szöveg
 * @param {string} props.buttonLabel — gomb felirat alap állapotban
 * @param {string} [props.pendingLabel='Törlés folyamatban…'] — gomb felirat töltés közben
 * @param {boolean} props.isPending — a törlés művelet fut-e
 * @param {() => void} props.onDelete — gomb click handler
 */
export default function DangerZone({
    title = 'Veszélyes zóna',
    description,
    buttonLabel,
    pendingLabel = 'Törlés folyamatban…',
    isPending,
    onDelete
}) {
    return (
        <div className="danger-zone">
            <h3 className="danger-zone-title">{title}</h3>
            <p className="danger-zone-description">{description}</p>
            <button
                type="button"
                className="danger-action"
                onClick={onDelete}
                disabled={isPending}
            >
                {isPending ? pendingLabel : buttonLabel}
            </button>
        </div>
    );
}
