/**
 * @fileoverview Validáció rendszer konstansai.
 * Tartalmazza a validátor típusokat és forrás azonosítókat.
 *
 * @module utils/validationConstants
 */

// =============================================================================
// Validátor Típusok
// =============================================================================

/**
 * Validátor típusok enum.
 * A validationRunner és StateComplianceValidator switch-case kulcsai,
 * valamint a WORKFLOW_CONFIG requiredToEnter/requiredToExit értékei.
 *
 * @enum {string}
 */
export const VALIDATOR_TYPES = {
    FILE_ACCESSIBLE: 'file_accessible',             // Fájl létezik és elérhető
    FILE_SYSTEM: 'file_system',                     // Fájlrendszer általános ellenőrzés
    STATE_COMPLIANCE: 'state_compliance',           // Állapot-megfelelőség koordinátor
    DATABASE_INTEGRITY: 'database_integrity',       // Adatbázis integritás
    PUBLICATION_STRUCTURE: 'publication_structure', // Kiadvány struktúra (átfedés)
    PREFLIGHT_CHECK: 'preflight_check',             // InDesign Preflight profil
    PAGE_NUMBER_CHECK: 'page_number_check',         // Oldalszám ellenőrzés
    FILENAME_VERIFICATION: 'filename_verification'  // Fájlnév validáció
};

// =============================================================================
// Validáció Források
// =============================================================================

/**
 * Validáció források enum.
 * A validációs eredmények forrásának azonosítására szolgál.
 * Az updateArticleValidation / clearArticleValidation hívások source paramétere.
 *
 * @enum {string}
 */
export const VALIDATION_SOURCES = {
    PREFLIGHT: 'preflight',             // Preflight ellenőrzés eredménye
    STRUCTURE: 'structure',             // Kiadvány struktúra / átfedés ellenőrzés
    USER: 'user',                       // Felhasználói üzenet / validáció
    SYSTEM_OVERRIDE: 'system_override'  // Rendszer hiba (pl. visszaminősítés)
};
