/**
 * @fileoverview Ellenőrzi, hogy egy cikk megfelel-e a munkafolyamat-állapot követelményeinek.
 * Az állapotátmenethez szükséges összes validációt (fájl létezés, oldalszám, fájlnév, preflight)
 * ez az osztály koordinálja a WORKFLOW_CONFIG requiredToEnter/requiredToExit alapján.
 */

import { ValidatorBase } from "./ValidatorBase.js";
import { PreflightValidator } from "./PreflightValidator.js";
import { WORKFLOW_CONFIG } from "../workflow/workflowConstants.js";
import { VALIDATOR_TYPES } from "../validationConstants.js";
import { isValidFileName, resolvePlatformPath, escapePathForExtendScript } from "../pathUtils.js";

/** Gyorsítótárazott PreflightValidator példány. */
const preflightValidator = new PreflightValidator();

export class StateComplianceValidator extends ValidatorBase {
    constructor() {
        super('article');
    }

    /**
     * Állapot-specifikus validáció futtatása.
     *
     * @param {Object} context - { article: Object, targetState: number }
     * @param {Object} context.article - A validálandó cikk objektum
     * @param {number} [context.targetState] - Célállapot (ha átmenet-validáció; hiánya statikus ellenőrzést jelent)
     * @returns {Promise<Object>} Validációs eredmény { isValid, errors[], warnings[], timestamp }
     */
    async validate(context) {
        const { article, targetState } = context;
        if (!article) return this.failure("Nincs cikk megadva.");

        // requiredToEnter + requiredToExit összegyűjtése
        let requiredChecks = [];

        if (targetState !== undefined) {
            // Átmenet-validáció: kilépési + belépési feltételek
            const exitReqs = WORKFLOW_CONFIG[article.state]?.validations?.requiredToExit || [];
            const enterReqs = WORKFLOW_CONFIG[targetState]?.validations?.requiredToEnter || [];
            requiredChecks = [...new Set([...exitReqs, ...enterReqs])];
        } else {
            // Statikus validáció: belépési feltételek a jelenlegi állapothoz
            requiredChecks = WORKFLOW_CONFIG[article.state]?.validations?.requiredToEnter || [];
        }

        const results = { isValid: true, errors: [], warnings: [] };

        for (const checkItem of requiredChecks) {
            const checkConfig = typeof checkItem === 'string'
                ? { validator: checkItem, options: {} }
                : checkItem;

            const { validator: validatorName } = checkConfig;
            let options = checkConfig.options || {};

            switch (validatorName) {
                case VALIDATOR_TYPES.FILE_ACCESSIBLE:
                    await this._checkFileAccessible(article, results);
                    break;

                case VALIDATOR_TYPES.PAGE_NUMBER_CHECK:
                    this._checkPageNumbers(article, results);
                    break;

                case VALIDATOR_TYPES.FILENAME_VERIFICATION:
                    this._checkFileName(article, results);
                    break;

                case VALIDATOR_TYPES.PREFLIGHT_CHECK: {
                    // Legacy fallback: ha nincs explicit options, onEntry config-ból keresi
                    if (Object.keys(options).length === 0) {
                        const entryConfig = WORKFLOW_CONFIG[targetState]
                            ?.validations?.onEntry
                            ?.find(v => v.validator === VALIDATOR_TYPES.PREFLIGHT_CHECK);
                        if (entryConfig?.options) options = entryConfig.options;
                    }
                    await this._checkPreflight(article, options, results);
                    break;
                }
            }
        }

        if (results.isValid) {
            return this.success(results.warnings);
        }

        // Infrastruktúra-flag propagálás (pl. csatolatlan meghajtó → preflight kihagyva)
        const base = this.failure(results.errors, results.warnings);
        if (results.skipped) {
            base.skipped = true;
            base.unmountedDrives = results.unmountedDrives;
        }
        return base;
    }

    // ── Privát check metódusok ──────────────────────────────────────────────

    /**
     * Fájl létezés ellenőrzése InDesign ExtendScript-tel.
     */
    async _checkFileAccessible(article, results) {
        const path = article.filePath || article.FilePath;
        if (!path) {
            results.isValid = false;
            results.errors.push(`Nincs fájl útvonal megadva. (ID: ${article.$id})`);
            return;
        }
        try {
            const mappedPath = resolvePlatformPath(decodeURI(path));
            const safePath = escapePathForExtendScript(mappedPath);
            const script = `var f = new File("${safePath}"); f.exists;`;
            const exists = await require("indesign").app.doScript(
                script, require("indesign").ScriptLanguage.JAVASCRIPT
            );
            if (!exists) {
                results.isValid = false;
                results.errors.push("A fájl nem található: " + mappedPath);
            }
        } catch (e) {
            results.isValid = false;
            results.errors.push("Fájlrendszer hiba: " + e.message);
        }
    }

    /**
     * Oldalszám érvényesség ellenőrzése.
     */
    _checkPageNumbers(article, results) {
        if (typeof article.startPage !== 'number' || typeof article.endPage !== 'number') {
            results.isValid = false;
            results.errors.push("Hiányzó vagy érvénytelen oldalszámok ehhez az állapothoz.");
        }
    }

    /**
     * Fájlnév érvényesség ellenőrzése.
     */
    _checkFileName(article, results) {
        const name = article.name || article.Name;
        if (!name || !isValidFileName(name)) {
            results.isValid = false;
            results.errors.push("Érvénytelen fájlnév: tiltott karaktereket tartalmaz vagy nem felel meg a szabályoknak.");
        }
    }

    /**
     * Preflight ellenőrzés delegálása a PreflightValidator-nak.
     */
    async _checkPreflight(article, options, results) {
        const result = await preflightValidator.validate({ article, options });
        if (!result.isValid) {
            results.isValid = false;
            results.errors.push(...result.errors);
        }
        if (result.warnings?.length > 0) {
            results.warnings.push(...result.warnings);
        }
        if (result.skipped) {
            results.skipped = true;
            results.unmountedDrives = result.unmountedDrives;
        }
    }
}
