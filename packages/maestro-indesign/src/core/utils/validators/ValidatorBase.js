/**
 * @fileoverview Absztrakt ősosztály a Maestro rendszer összes validátora számára.
 * Meghatározza a standard interfészt, amelyet minden specifikus validátornak implementálnia kell.
 */

export class ValidatorBase {
    /**
     * Validátor Hatókörök (Scopes)
     */
    static get SCOPES() {
        return {
            ARTICLE: 'article',
            PUBLICATION: 'publication'
        };
    }

    /**
     * @param {string} scope - A validátor hatóköre (ValidatorBase.SCOPES.ARTICLE vagy ValidatorBase.SCOPES.PUBLICATION).
     */
    constructor(scope) {
        if (new.target === ValidatorBase) {
            throw new TypeError("Cannot construct Abstract instances directly");
        }
        
        const validScopes = Object.values(ValidatorBase.SCOPES);
        if (!validScopes.includes(scope)) {
            throw new Error(`Invalid validator scope: '${scope}'. Allowed values: ${validScopes.join(', ')}`);
        }
        
        this.scope = scope;
    }

    /**
     * Validálja a megadott célobjektumot (Cikk vagy Kiadvány).
     * @param {Object} target - A validálandó entitás.
     * @returns {Promise<Object>} Validációs eredmény { isValid: boolean, errors: [], warnings: [], timestamp: number }
     */
    async validate(target) {
        throw new Error("Method 'validate()' must be implemented.");
    }

    /**
     * Segédfüggvény sikeres eredmény formázásához
     */
    success(warnings = []) {
        return {
            isValid: true,
            errors: [],
            warnings: warnings,
            timestamp: Date.now()
        };
    }

    /**
     * Segédfüggvény sikertelen eredmény formázásához
     */
    failure(errors, warnings = []) {
        return {
            isValid: false,
            errors: Array.isArray(errors) ? errors : [errors],
            warnings: warnings,
            timestamp: Date.now()
        };
    }
}
