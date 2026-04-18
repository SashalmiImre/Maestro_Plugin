/**
 * Maestro Shared — Validator Registry
 *
 * Validátor ID → megjelenítési név leképezés.
 * A Dashboard designer UI-ja innen listázza az elérhető validátorokat;
 * az InDesign plugin a StateComplianceValidator-ban hivatkozik rájuk.
 *
 * Új validátor = új bejegyzés itt + új implementáció a plugin
 * `src/core/utils/validators/` mappájában.
 *
 * @module shared/validatorRegistry
 */

/**
 * Az összes elérhető validátor definíciója.
 *
 * @type {Object.<string, { label: string, description?: string }>}
 */
export const VALIDATOR_REGISTRY = {
    file_accessible:       { label: 'Fájl elérhető',        description: 'Fájl létezik és elérhető a fájlrendszeren' },
    page_number_check:     { label: 'Oldalszám ellenőrzés',  description: 'Az oldalszám érvényes és a kiadvány lefedettségén belül van' },
    filename_verification: { label: 'Fájlnév ellenőrzés',    description: 'A fájlnév formátuma megfelel a konvencióknak' },
    preflight_check:       { label: 'Preflight',              description: 'InDesign Preflight profil futtatása' }
};

/**
 * Visszaadja egy validátor megjelenített címkéjét.
 *
 * @param {string} validatorId
 * @returns {string}
 */
export function getValidatorLabel(validatorId) {
    return VALIDATOR_REGISTRY[validatorId]?.label ?? validatorId;
}
