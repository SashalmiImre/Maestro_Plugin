/**
 * @fileoverview Ellenőrzi, hogy egy cikk megfelel-e a munkafolyamat-állapot követelményeinek.
 * Az állapotátmenethez szükséges összes validációt (fájl létezés, oldalszám, fájlnév, preflight)
 * ez az osztály koordinálja a workflow.validations requiredToEnter/requiredToExit alapján.
 */

import { ValidatorBase } from "./ValidatorBase.js";
import { PreflightValidator } from "./PreflightValidator.js";
import { getStateValidations } from "maestro-shared/workflowRuntime.js";
import { isExtensionRef, parseExtensionRef } from "maestro-shared/extensionContract.js";
import { VALIDATOR_TYPES } from "../validationConstants.js";
import { isValidFileName, toAbsoluteArticlePath, escapePathForExtendScript } from "../pathUtils.js";
import { dispatchExtensionValidator } from "../extensions/extensionRegistry.js";
import { logWarn } from "../logger.js";

/** Gyorsítótárazott PreflightValidator példány. */
const preflightValidator = new PreflightValidator();

export class StateComplianceValidator extends ValidatorBase {
    constructor() {
        super('article');
    }

    /**
     * Állapot-specifikus validáció futtatása.
     *
     * @param {Object} context - { article, workflow, targetState, publicationRootPath }
     * @param {Object} context.article - A validálandó cikk objektum
     * @param {Object} [context.workflow] - A compiled workflow JSON (DataContext.workflow)
     * @param {string} [context.targetState] - Célállapot string ID (ha átmenet-validáció)
     * @param {string} [context.publicationRootPath] - Kiadvány gyökér útvonala
     * @returns {Promise<Object>} Validációs eredmény { isValid, errors[], warnings[], timestamp }
     */
    async validate(context) {
        const { article, workflow, targetState } = context;
        if (!article) return this.failure("Nincs cikk megadva.");

        // requiredToEnter + requiredToExit összegyűjtése
        let requiredChecks = [];

        if (targetState !== undefined && workflow) {
            // Átmenet-validáció: kilépési + belépési feltételek
            const exitValidations = getStateValidations(workflow, article.state);
            const enterValidations = getStateValidations(workflow, targetState);
            const exitReqs = exitValidations?.requiredToExit || [];
            const enterReqs = enterValidations?.requiredToEnter || [];
            requiredChecks = [...new Set([...exitReqs, ...enterReqs])];
        } else if (workflow) {
            // Statikus validáció: belépési feltételek a jelenlegi állapothoz
            const stateValidations = getStateValidations(workflow, article.state);
            requiredChecks = stateValidations?.requiredToEnter || [];
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
                    await this._checkFileAccessibleImpl(article, results, context.publicationRootPath);
                    break;

                case VALIDATOR_TYPES.PAGE_NUMBER_CHECK:
                    this._checkPageNumbers(article, results);
                    break;

                case VALIDATOR_TYPES.FILENAME_VERIFICATION:
                    this._checkFileName(article, results);
                    break;

                case VALIDATOR_TYPES.PREFLIGHT_CHECK: {
                    // Ha nincs explicit options, onEntry config-ból keresi
                    if (Object.keys(options).length === 0 && workflow && targetState) {
                        const enterValidations = getStateValidations(workflow, targetState);
                        const entryConfig = enterValidations?.onEntry
                            ?.find(v => v.validator === VALIDATOR_TYPES.PREFLIGHT_CHECK);
                        if (entryConfig?.options) options = entryConfig.options;
                    }
                    await this._checkPreflight(article, options, results);
                    break;
                }

                default: {
                    // Workflow extension hivatkozás (`ext.<slug>`) — B.4.2 / ADR 0007 Phase 0.
                    // Az `options` Phase 0-ban (B.0.4) NEM kerül továbbításra a `maestroExtension(input)`-be.
                    if (isExtensionRef(validatorName)) {
                        const ref = parseExtensionRef(validatorName);
                        await this._checkExtensionValidator(ref.slug, article, context.extensions, results);
                    } else {
                        // Defense-in-depth: a server-oldali workflow compile szűr ismeretlen validator
                        // típust, de ha valami csendben átment, a no-op skip helyett legalább logoljunk.
                        logWarn(`[StateComplianceValidator] Ismeretlen validator-típus: ${validatorName}`);
                    }
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

    /**
     * Fájl létezés ellenőrzése InDesign ExtendScript-tel.
     * Publikus belépési pont a validationRunner FILE_ACCESSIBLE case számára.
     *
     * @param {Object} article - A validálandó cikk objektum
     * @param {string} [publicationRootPath] - Kiadvány gyökér útvonala
     * @returns {Promise<Object>} Validációs eredmény { isValid, errors[], warnings[], timestamp }
     */
    async checkFileAccessible(article, publicationRootPath) {
        const results = { isValid: true, errors: [], warnings: [] };
        await this._checkFileAccessibleImpl(article, results, publicationRootPath);
        return results.isValid ? this.success(results.warnings) : this.failure(results.errors, results.warnings);
    }

    // ── Privát check metódusok ──────────────────────────────────────────────

    /**
     * Fájl létezés ellenőrzés implementáció (belső és publikus API közös magja).
     */
    async _checkFileAccessibleImpl(article, results, publicationRootPath) {
        const path = article.filePath || article.FilePath;
        if (!path) {
            results.isValid = false;
            results.errors.push(`Nincs fájl útvonal megadva. (ID: ${article.$id})`);
            return;
        }
        try {
            const mappedPath = toAbsoluteArticlePath(decodeURI(path), publicationRootPath || "");
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

    /**
     * Workflow extension validator dispatch (`ext.<slug>` — ADR 0007 Phase 0, B.4.2).
     *
     * A `extensionRegistry` az aktivált publikáció `compiledExtensionSnapshot`-jából épül
     * (`buildExtensionRegistry`); fail-closed: hiányzó registry / unknown slug / kind-mismatch
     * → `[ext.<slug>] ...` prefixált error a `results.errors`-ba.
     */
    async _checkExtensionValidator(slug, article, extensionRegistry, results) {
        const result = await dispatchExtensionValidator(extensionRegistry, slug, { article });
        if (!result.isValid) {
            results.isValid = false;
            results.errors.push(...result.errors);
        }
        if (result.warnings?.length > 0) {
            results.warnings.push(...result.warnings);
        }
    }
}
