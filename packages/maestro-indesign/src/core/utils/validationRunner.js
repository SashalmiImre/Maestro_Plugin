/**
 * @fileoverview Központi vezérlő (orchestrator) a validációk futtatásához.
 * A tényleges ellenőrzéseket egyszerűsített Validator osztályoknak delegálja.
 */

import { StateComplianceValidator, PublicationStructureValidator, DatabaseIntegrityValidator, PreflightValidator } from "./validators/index.js";
import { VALIDATOR_TYPES } from "./validationConstants.js";
import { toAbsoluteArticlePath } from "./pathUtils.js";

// Példányok gyorsítótárazása (cache)
const validators = {
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
                // Fájl létezés ellenőrzés — a StateComplianceValidator-ra delegálunk
                result = await validators.stateCompliance.checkFileAccessible(
                    target, context.publicationRootPath
                );
                break;

            case VALIDATOR_TYPES.STATE_COMPLIANCE:
                result = await validators.stateCompliance.validate({
                    article: target,
                    workflow: context.workflow,
                    targetState: context.targetState,
                    publicationRootPath: context.publicationRootPath
                });
                break;

            case VALIDATOR_TYPES.DATABASE_INTEGRITY: {
                const dbAbsPath = context.publicationRootPath
                    ? toAbsoluteArticlePath(target.filePath, context.publicationRootPath)
                    : target.filePath;
                result = await validators.databaseIntegrity.validate({
                    article: target,
                    autoCorrect: context.autoCorrect,
                    absoluteFilePath: dbAbsPath
                });
                break;
            }

            case VALIDATOR_TYPES.PUBLICATION_STRUCTURE:
                result = await validators.publicationStructure.validate({
                    publication: target,
                    articles: context.articles
                });
                break;

            case VALIDATOR_TYPES.PREFLIGHT_CHECK: {
                const pfAbsPath = context.publicationRootPath
                    ? toAbsoluteArticlePath(target.filePath, context.publicationRootPath)
                    : target.filePath;
                result = await validators.preflight.validate({
                    article: target,
                    options: context.options,
                    absoluteFilePath: pfAbsPath
                });
                break;
            }
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

