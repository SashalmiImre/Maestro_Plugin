/**
 * @fileoverview Ellenőrzi, hogy egy cikk megfelel-e a specifikus munkafolyamat-állapotának (Workflow State) követelményeinek.
 */

import { ValidatorBase } from "./ValidatorBase.js";
import { WORKFLOW_STATES, WORKFLOW_CONFIG } from "../workflow/workflowConstants.js";

export class StateComplianceValidator extends ValidatorBase {
    constructor() {
        super('article');
    }

    /**
     * @param {Object} context - { article: Object, targetState: number }
     */
    async validate(context) {
        const { article, targetState } = context;
        if (!article) return this.failure("No article provided.");

        let requiredChecks = [];

        if (targetState !== undefined) {
            // Transition validation: Current Exit + Target Entry
            const exitReqs = WORKFLOW_CONFIG[article.state]?.validations?.requiredToExit || [];
            const enterReqs = WORKFLOW_CONFIG[targetState]?.validations?.requiredToEnter || [];
            requiredChecks = [...new Set([...exitReqs, ...enterReqs])];
        } else {
            // Static validation: Current Entry (Is it valid to be here?)
            requiredChecks = WORKFLOW_CONFIG[article.state]?.validations?.requiredToEnter || [];
        }
        const errors = [];
        
        // Ez a logika tükrözi a régi WorkflowEngine.validateTransition-t, de tisztább
        // Ez a logika tükrözi a régi WorkflowEngine.validateTransition-t, de tisztább
        for (const checkItem of requiredChecks) {
            const checkConfig = typeof checkItem === 'string' 
                ? { validator: checkItem, options: {} } 
                : checkItem;
            
            const validatorName = checkConfig.validator;
            
            if (validatorName === 'preflight_check') {
                // Helykitöltő a Preflight logikához
                // Ha implementálnánk a preflight-ot, itt futtatnánk.
                // Egyelőre feltételezzük, hogy átmegy, vagy átugorjuk mint "Nincs implementálva"
                // errors.push("Preflight Validation Failed"); 
            }
            
            if (validatorName === 'page_number_check') {
                // Biztosítjuk, hogy az oldalszámok érvényes számok
                 if (typeof article.startPage !== 'number' || typeof article.endPage !== 'number') {
                     errors.push("Missing valid page numbers for this state.");
                 }
            }
        }

        return errors.length > 0 ? this.failure(errors) : this.success();
    }
}
