/**
 * @fileoverview Központi vezérlő (orchestrator) a validációk futtatásához.
 * A tényleges ellenőrzéseket egyszerűsített Validator osztályoknak delegálja.
 */

import { FileSystemValidator, StateComplianceValidator, PublicationStructureValidator, DatabaseIntegrityValidator, PreflightValidator } from "./validators/index.js";
import { VALIDATOR_TYPES } from "./validationConstants.js";

// Példányok gyorsítótárazása (cache)
const validators = {
    fileSystem: new FileSystemValidator(),
    stateCompliance: new StateComplianceValidator(),
    publicationStructure: new PublicationStructureValidator(),
    databaseIntegrity: new DatabaseIntegrityValidator(),
    preflight: new PreflightValidator()
};

/**
 * Validál egy cikket vagy kiadványt a kért típusok alapján.
 * 
 * @param {Object} target - A validálandó entitás (cikk objektum vagy kiadvány objektum).
 * @param {string|string[]} checkTypes - Egyetlen futtatandó típus vagy típusok tömbje (pl. 'file_exists', 'state_compliance').
 * @param {Object} [context] - További kontextus (pl. targetState, teljes kiadvány adatok).
 * 
 * @returns {Promise<Object>} Kombinált validációs eredmények.
 */
export const validate = async (target, checkTypes, context = {}) => {
    const checks = Array.isArray(checkTypes) ? checkTypes : [checkTypes];
    
    // Alapértelmezett eredmény struktúra
    const results = {
        isValid: true,
        errors: [],
        warnings: [],
        details: {} // Validatoronkénti eredmények
    };

    for (const check of checks) {
        let result = null;

        switch (check) {
            case VALIDATOR_TYPES.FILE_ACCESSIBLE:
            case VALIDATOR_TYPES.FILE_SYSTEM:
                // Ellenőrzi, hogy a fájl fizikailag létezik-e (Alapkövetelmény)
                // A dedikált 'validateArticle' függvényt használjuk, amely az InDesign scripten keresztül
                // ellenőrzi a fájl létezését.
                result = await validateArticle(target);
                break;

            case VALIDATOR_TYPES.STATE_COMPLIANCE:
                result = await validators.stateCompliance.validate({
                    article: target,
                    targetState: context.targetState
                });
                break;

            case VALIDATOR_TYPES.DATABASE_INTEGRITY:
                result = await validators.databaseIntegrity.validate({
                    article: target,
                    autoCorrect: context.autoCorrect
                });
                break;

            case VALIDATOR_TYPES.PUBLICATION_STRUCTURE:
                result = await validators.publicationStructure.validate({
                    publication: target,
                    articles: context.articles
                });
                break;

            case VALIDATOR_TYPES.PREFLIGHT_CHECK:
                result = await validators.preflight.validate({
                    article: target,
                    options: context.options
                });
                break;
        }

        if (result) {
            results.details[check] = result;
            if (!result.isValid) {
                results.isValid = false;
                results.errors.push(...result.errors);
            }
            if (result.warnings) {
                results.warnings.push(...result.warnings);
            }
            // Infrastruktúra-flag propagálás (pl. csatolatlan meghajtó)
            if (result.skipped) {
                results.skipped = true;
                if (result.unmountedDrives) {
                    results.unmountedDrives = result.unmountedDrives;
                }
            }
        }
    }

    return results;
};

/**
 * Fájl létezés ellenőrzése InDesign ExtendScript-tel.
 * Standalone változat — az állapotátmenet-validáció a StateComplianceValidator-ban fut.
 *
 * @param {Object} article - A validálandó cikk (filePath vagy FilePath mezővel)
 * @returns {Promise<Object>} { isValid, errors[], warnings[] }
 */
export const validateArticle = async (article) => {
    const { resolvePlatformPath, escapePathForExtendScript } = require("./pathUtils.js");
    const results = { isValid: true, errors: [], warnings: [] };
    const path = article.filePath || article.FilePath;
    
    if (!path) {
        results.isValid = false;
        results.errors.push(`Nincs fájl útvonal megadva. (ID: ${article.$id})`);
        return results;
    }

    try {
        const mappedPath = resolvePlatformPath(decodeURI(path));
        const safePath = escapePathForExtendScript(mappedPath);
        const script = `var f = new File("${safePath}"); f.exists;`;
        
        const exists = await require("indesign").app.doScript(
            script,
            require("indesign").ScriptLanguage.JAVASCRIPT
        );

        if (!exists) {
            results.isValid = false;
            results.errors.push("A fájl nem található: " + mappedPath);
        }
    } catch (e) {
        results.isValid = false;
        results.errors.push("Fájlrendszer hiba: " + e.message);
    }

    return results;
};
