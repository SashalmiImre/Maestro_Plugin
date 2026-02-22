/**
 * @fileoverview Központi vezérlő (orchestrator) a validációk futtatásához.
 * A tényleges ellenőrzéseket egyszerűsített Validator osztályoknak delegálja.
 */

import { FileSystemValidator, StateComplianceValidator, PublicationStructureValidator, DatabaseIntegrityValidator, PreflightValidator } from "./validators/index.js";

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
            case 'file_accessible':
            case 'file_system':
                // Ellenőrzi, hogy a fájl fizikailag létezik-e (Alapkövetelmény)
                // A dedikált 'validateArticle' függvényt használjuk, amely az InDesign scripten keresztül
                // ellenőrzi a fájl létezését.
                result = await validateArticle(target);
                break;
                
            case 'state_compliance':
                result = await validators.stateCompliance.validate({ 
                    article: target, 
                    targetState: context.targetState 
                });
                break;
                
            case 'database_integrity':
                result = await validators.databaseIntegrity.validate({
                    article: target,
                    autoCorrect: context.autoCorrect
                });
                break;

            case 'publication_structure':
                result = await validators.publicationStructure.validate({
                    publication: target,
                    articles: context.articles
                });
                break;

            case 'preflight_check':
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
 * Legacy kompatibilitás: Standard 'validateArticle' függvény.
 * Alapvető fájl létezést ellenőriz.
 */
export const validateArticle = async (article) => {
    // Egyelőre átirányítjuk ezt az új rendszerünkön keresztül
    // A StateCompliance használatával, ami belsőleg meghívja a 'file_accessible'-t a WorkflowConstants-on keresztül
    // VAGY feltételezzük, hogy ez az ellenőrzés azt jelenti: "Létezik-e a fájl?"
    
    // Az eredeti logika újraimplementálása itt a biztonság érdekében, amíg a FileSystemValidator nem lesz robusztus az egyes fájlokhoz
    // Az eredeti logika az indesign doScript-et használta.
    // Használjuk az új DatabaseIntegrityValidator-t, ami közvetve ellenőrzi a fájlhozzáférést scripten keresztül?
    // Nem, az az oldalszámokat ellenőrzi.
    // Tartsuk meg az eredeti logikát ehhez a specifikus export függvényhez, kissé módosítva, hogy tisztább legyen,
    // vagy hagyatkozzunk arra, hogy a WorkflowEngine meghívja az új 'validate' orchestratort.
    
    // Az új tervhez igazodva:
    // Ezt a függvényt a WorkflowEngine importálja.
    // Át kellene irányítanunk az új architektúra használatára.
    
    // A 'file_accessible' esetében maradhatunk az eredeti implementáció logikájánál,
    // DE átmozgatva egy Validator osztályba, ha tisztaságot akarunk.
    // A korlátokat figyelembe véve, tartsuk meg a legacy törzset itt a 100%-os biztonság érdekében a "validateArticle" esetében,
    // de jelöljük meg mint Legacy.
    
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
