/**
 * Maestro Dashboard — Workflow Validator
 *
 * Pre-save validáció a compiled JSON számára.
 * Ellenőrzi a workflow konzisztenciáját mentés előtt.
 *
 * @param {Object} compiled - A graphToCompiled() kimenete
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateWorkflow(compiled) {
    const errors = [];

    if (!compiled || !compiled.states) {
        errors.push('A workflow nem tartalmaz állapotokat.');
        return { valid: false, errors };
    }

    const { states, transitions } = compiled;

    // 1. Pontosan 1 isInitial állapot
    const initialStates = states.filter(s => s.isInitial);
    if (initialStates.length === 0) {
        errors.push('Nincs kezdőállapot megjelölve. Pontosan egy állapotnak kell kezdőnek lennie.');
    } else if (initialStates.length > 1) {
        errors.push(`Több kezdőállapot van megjelölve: ${initialStates.map(s => s.id).join(', ')}. Csak egy lehet.`);
    }

    // 2. Egyedi state ID-k
    const stateIds = new Set();
    for (const s of states) {
        if (stateIds.has(s.id)) {
            errors.push(`Duplikált állapot azonosító: "${s.id}".`);
        }
        stateIds.add(s.id);
    }

    // 3. State ID regex: [a-z0-9_]+
    const stateIdRegex = /^[a-z0-9_]+$/;
    for (const s of states) {
        if (!stateIdRegex.test(s.id)) {
            errors.push(`Érvénytelen állapot azonosító: "${s.id}". Csak kisbetűk, számok és aláhúzás megengedett.`);
        }
    }

    // 4. Transition-ök létező state-ekre hivatkoznak
    for (const t of (transitions || [])) {
        if (!stateIds.has(t.from)) {
            errors.push(`Az átmenet forrása nem létező állapot: "${t.from}".`);
        }
        if (!stateIds.has(t.to)) {
            errors.push(`Az átmenet célja nem létező állapot: "${t.to}".`);
        }
    }

    // 5. Nincs forward transition terminal állapotból
    const terminalIds = new Set(states.filter(s => s.isTerminal).map(s => s.id));
    for (const t of (transitions || [])) {
        if (t.direction === 'forward' && terminalIds.has(t.from)) {
            errors.push(`Végállapotból ("${t.from}") nem indulhat előre irányú átmenet.`);
        }
    }

    // 6. Egyedi (from, to) párok
    const transitionPairs = new Set();
    for (const t of (transitions || [])) {
        const key = `${t.from}__${t.to}`;
        if (transitionPairs.has(key)) {
            errors.push(`Duplikált átmenet: "${t.from}" → "${t.to}".`);
        }
        transitionPairs.add(key);
    }

    // 7. Üres allowedGroups = figyelmeztetés (nem blokkoló, de jelezzük)
    for (const t of (transitions || [])) {
        if (!t.allowedGroups || t.allowedGroups.length === 0) {
            errors.push(`Az átmenet "${t.from}" → "${t.to}" nem tartalmaz engedélyezett csoportot. Senki nem fogja tudni végrehajtani.`);
        }
    }

    return { valid: errors.length === 0, errors };
}
