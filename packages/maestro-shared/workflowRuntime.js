/**
 * Maestro Shared — Workflow Runtime
 *
 * Fogyasztói helperek a `workflows.compiled` JSON fölött.
 * Minden függvény tiszta (pure) — a compiled objektumot első paraméterként kapja.
 * Ez az egyetlen interfész a compiled JSON-hoz: soha nem szabad közvetlenül
 * mezőket olvasni, mert a séma változhat.
 *
 * @module shared/workflowRuntime
 */

// ─── State lekérdezések ────────────────────────────────────────────────────

/**
 * Visszaadja az összes állapotot a compiled-ból.
 *
 * @param {Object} compiled - A workflows.compiled JSON.
 * @returns {Array<{id: string, label: string, color: string, duration: Object, isInitial: boolean, isTerminal: boolean}>}
 */
export function getAllStates(compiled) {
    return compiled?.states ?? [];
}

/**
 * Visszaadja egy adott állapot konfigurációját.
 *
 * @param {Object} compiled
 * @param {string} stateId - Az állapot azonosítója (pl. "designing").
 * @returns {{id: string, label: string, color: string, duration: Object, isInitial: boolean, isTerminal: boolean}|null}
 */
export function getStateConfig(compiled, stateId) {
    return compiled?.states?.find(s => s.id === stateId) ?? null;
}

/**
 * Visszaadja az állapot megjelenített címkéjét.
 *
 * @param {Object} compiled
 * @param {string} stateId
 * @returns {string}
 */
export function getStateLabel(compiled, stateId) {
    return getStateConfig(compiled, stateId)?.label ?? stateId;
}

/**
 * Visszaadja az állapot színét.
 *
 * @param {Object} compiled
 * @param {string} stateId
 * @returns {string}
 */
export function getStateColor(compiled, stateId) {
    return getStateConfig(compiled, stateId)?.color ?? '#999999';
}

/**
 * Visszaadja az állapot sürgősség-számítási időtartamát.
 *
 * @param {Object} compiled
 * @param {string} stateId
 * @returns {{perPage: number, fixed: number}|null}
 */
export function getStateDuration(compiled, stateId) {
    return getStateConfig(compiled, stateId)?.duration ?? null;
}

/**
 * Visszaadja az induló (initial) állapot ID-ját.
 *
 * @param {Object} compiled
 * @returns {string|null}
 */
export function getInitialState(compiled) {
    const initial = compiled?.states?.find(s => s.isInitial);
    return initial?.id ?? null;
}

/**
 * Ellenőrzi, hogy az adott állapot induló állapot-e.
 *
 * @param {Object} compiled
 * @param {string} stateId
 * @returns {boolean}
 */
export function isInitialState(compiled, stateId) {
    return getStateConfig(compiled, stateId)?.isInitial === true;
}

/**
 * Ellenőrzi, hogy az adott állapot végállapot-e.
 *
 * @param {Object} compiled
 * @param {string} stateId
 * @returns {boolean}
 */
export function isTerminalState(compiled, stateId) {
    return getStateConfig(compiled, stateId)?.isTerminal === true;
}

// ─── Transition lekérdezések ───────────────────────────────────────────────

/**
 * Visszaadja az adott állapotból kiinduló átmeneteket.
 *
 * @param {Object} compiled
 * @param {string} currentState - Az aktuális állapot ID.
 * @returns {Array<{from: string, to: string, label: string, direction: string, allowedGroups: string[]}>}
 */
export function getAvailableTransitions(compiled, currentState) {
    return compiled?.transitions?.filter(t => t.from === currentState) ?? [];
}

/**
 * Ellenőrzi, hogy az átmenet érvényes-e (létezik from→to pár).
 *
 * @param {Object} compiled
 * @param {string} fromState
 * @param {string} toState
 * @returns {boolean}
 */
export function validateTransition(compiled, fromState, toState) {
    return getAvailableTransitions(compiled, fromState).some(t => t.to === toState);
}

// ─── Jogosultsági ellenőrzések ─────────────────────────────────────────────

/**
 * Ellenőrzi, hogy a felhasználó csoporttagságai alapján elmozgathatja-e
 * a cikket az adott állapotból.
 *
 * A leaderGroups tagjai automatikusan jogosultak.
 *
 * @param {Object} compiled
 * @param {string} currentState - A cikk aktuális állapota.
 * @param {string[]} userGroupSlugs - A felhasználó csoporttagságai.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function canUserMoveArticle(compiled, currentState, userGroupSlugs) {
    if (!compiled || !userGroupSlugs) {
        return { allowed: false, reason: "Hiányzó workflow konfiguráció vagy felhasználói adatok." };
    }

    // Leader csoportok tagjai mindig mozgathatnak
    if (_isLeaderMember(compiled, userGroupSlugs)) {
        return { allowed: true };
    }

    const requiredGroups = compiled.statePermissions?.[currentState];
    if (!requiredGroups || requiredGroups.length === 0) {
        return { allowed: true };
    }

    const hasAccess = requiredGroups.some(slug => userGroupSlugs.includes(slug));
    if (hasAccess) {
        return { allowed: true };
    }

    return { allowed: false, reason: "Nincs jogosultságod a cikk mozgatásához ebben az állapotban." };
}

/**
 * Ellenőrzi, hogy az adott átmenethez van-e jogosultsága a felhasználónak.
 * Per-transition szintű ellenőrzés az allowedGroups alapján.
 *
 * @param {Object} compiled
 * @param {string} fromState
 * @param {string} toState
 * @param {string[]} userGroupSlugs
 * @returns {{allowed: boolean, reason?: string}}
 */
export function hasTransitionPermission(compiled, fromState, toState, userGroupSlugs) {
    if (_isLeaderMember(compiled, userGroupSlugs)) {
        return { allowed: true };
    }

    const transition = compiled?.transitions?.find(t => t.from === fromState && t.to === toState);
    if (!transition) {
        return { allowed: false, reason: "Érvénytelen átmenet." };
    }

    if (!transition.allowedGroups || transition.allowedGroups.length === 0) {
        return { allowed: false, reason: "Ez az átmenet nincs engedélyezve." };
    }

    const hasAccess = transition.allowedGroups.some(slug => userGroupSlugs.includes(slug));
    if (hasAccess) {
        return { allowed: true };
    }

    return { allowed: false, reason: "Nincs jogosultságod ehhez az átmenethez." };
}

// ─── UI elem jogosultságok ─────────────────────────────────────────────────

/**
 * Ellenőrzi, hogy a felhasználó szerkesztheti-e az adott UI elemet.
 *
 * @param {Object} compiled
 * @param {string} scope - "article" vagy "publication".
 * @param {string} elementKey - Az elem kulcsa (pl. "articleName", "publicationProperties").
 * @param {string[]} userGroupSlugs - A felhasználó csoporttagságai.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function canEditElement(compiled, scope, elementKey, userGroupSlugs) {
    if (!compiled || !userGroupSlugs) {
        return { allowed: false, reason: "Hiányzó konfiguráció." };
    }

    const perm = compiled.elementPermissions?.[scope]?.[elementKey];
    if (!perm) {
        // Ismeretlen elem → engedélyezett (fejlesztési kényelem)
        return { allowed: true };
    }

    // Leader csoportok tagjai mindig szerkeszthetnek
    if (_isLeaderMember(compiled, userGroupSlugs)) {
        return { allowed: true };
    }

    if (perm.type === 'anyMember') {
        if (userGroupSlugs.length > 0) {
            return { allowed: true };
        }
        return { allowed: false, reason: "Nincs jogosultságod az elem szerkesztéséhez." };
    }

    if (perm.type === 'groups') {
        const hasAccess = perm.groups?.some(slug => userGroupSlugs.includes(slug));
        if (hasAccess) {
            return { allowed: true };
        }
        return { allowed: false, reason: "Nincs jogosultságod az elem szerkesztéséhez." };
    }

    if (perm.type === 'none') {
        return { allowed: false, reason: "Ez a mező csak olvasható." };
    }

    // Ismeretlen típus → engedélyezett
    return { allowed: true };
}

/**
 * Állapotfüggő jogosultság ellenőrzése fájlmegnyitáshoz és parancsokhoz.
 *
 * A leaderGroups tagjai mindig hozzáférhetnek.
 * Mások csak akkor, ha az állapot statePermissions-ében szerepelnek.
 *
 * @param {Object} compiled
 * @param {string[]} userGroupSlugs
 * @param {string} stateId - A cikk aktuális állapota.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function canUserAccessInState(compiled, userGroupSlugs, stateId) {
    if (!compiled || !userGroupSlugs) {
        return { allowed: false, reason: "Hiányzó konfiguráció." };
    }

    // Leader csoportok tagjai mindig hozzáférhetnek
    if (_isLeaderMember(compiled, userGroupSlugs)) {
        return { allowed: true };
    }

    // Van-e statePermissions jogosultsága ebben az állapotban?
    const stateGroups = compiled.statePermissions?.[stateId];
    if (stateGroups?.some(slug => userGroupSlugs.includes(slug))) {
        return { allowed: true };
    }

    return { allowed: false, reason: "Nincs jogosultságod ehhez a művelethez ebben az állapotban." };
}

/**
 * Ellenőrzi, hogy a felhasználó szerkesztheti-e az adott contributor
 * dropdown-ot a cikk aktuális állapotában.
 *
 * Vezetők (leaderGroups) → bármely dropdown, bármely állapot.
 * Nem-vezetők → csak a saját csoportjuknak megfelelő dropdown,
 * és csak ha a cikk állapota számukra aktív (statePermissions).
 *
 * @param {Object} compiled
 * @param {string} groupSlug - A dropdown-hoz tartozó csoport slug (pl. "designers").
 * @param {string[]} userGroupSlugs
 * @param {string} currentState - A cikk aktuális állapota.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function canEditContributorDropdown(compiled, groupSlug, userGroupSlugs, currentState) {
    if (!compiled || !userGroupSlugs) {
        return { allowed: false, reason: "Hiányzó konfiguráció." };
    }

    // Vezetők mindig szerkeszthetnek bármely dropdown-ot
    if (_isLeaderMember(compiled, userGroupSlugs)) {
        return { allowed: true };
    }

    // Nem-vezető: tagja-e ennek a csoportnak?
    if (!userGroupSlugs.includes(groupSlug)) {
        return { allowed: false, reason: "Nincs jogosultságod ehhez a mezőhöz." };
    }

    // A csoport jogosult-e ebben az állapotban?
    const stateGroups = compiled.statePermissions?.[currentState];
    if (stateGroups && stateGroups.includes(groupSlug)) {
        return { allowed: true };
    }

    return { allowed: false, reason: "Ebben az állapotban nem szerkesztheted ezt a mezőt." };
}

// ─── Command jogosultságok ─────────────────────────────────────────────────

/**
 * Visszaadja az adott állapotban elérhető parancsokat.
 *
 * @param {Object} compiled
 * @param {string} stateId
 * @returns {Array<{id: string, allowedGroups: string[]}>}
 */
export function getStateCommands(compiled, stateId) {
    return compiled?.commands?.[stateId] ?? [];
}

/**
 * Ellenőrzi, hogy a felhasználó futtathatja-e az adott parancsot.
 *
 * @param {Object} compiled
 * @param {string} stateId - A cikk aktuális állapota.
 * @param {string} commandId - A parancs azonosítója (pl. "export_pdf").
 * @param {string[]} userGroupSlugs
 * @returns {{allowed: boolean, reason?: string}}
 */
export function canRunCommand(compiled, stateId, commandId, userGroupSlugs) {
    if (!compiled || !userGroupSlugs) {
        return { allowed: false, reason: "Hiányzó konfiguráció." };
    }

    // Leader csoportok tagjai mindig futtathatnak
    if (_isLeaderMember(compiled, userGroupSlugs)) {
        return { allowed: true };
    }

    const commands = getStateCommands(compiled, stateId);
    const cmd = commands.find(c => c.id === commandId);
    if (!cmd) {
        return { allowed: false, reason: "Ez a parancs nem érhető el ebben az állapotban." };
    }

    if (!cmd.allowedGroups || cmd.allowedGroups.length === 0) {
        return { allowed: false, reason: "Ehhez a parancshoz nincs jogosultságod." };
    }

    const hasAccess = cmd.allowedGroups.some(slug => userGroupSlugs.includes(slug));
    if (hasAccess) {
        return { allowed: true };
    }

    return { allowed: false, reason: "Ehhez a parancshoz nincs jogosultságod." };
}

// ─── Capability lekérdezések ───────────────────────────────────────────────

/**
 * Ellenőrzi, hogy a felhasználó rendelkezik-e egy exkluzív capability-vel.
 * A leaderGroups tagjai automatikusan rendelkeznek minden capability-vel.
 *
 * @param {Object} compiled
 * @param {string} capabilityName - A capability neve (pl. "canAddArticlePlan").
 * @param {string[]} userGroupSlugs
 * @returns {boolean}
 */
export function hasCapability(compiled, capabilityName, userGroupSlugs) {
    if (!compiled || !userGroupSlugs) return false;

    // Leader csoportok tagjai rendelkeznek minden capability-vel
    if (_isLeaderMember(compiled, userGroupSlugs)) return true;

    const groups = compiled.capabilities?.[capabilityName];
    if (!groups) return false;

    return groups.some(slug => userGroupSlugs.includes(slug));
}

// ─── Contributor csoport lekérdezések ──────────────────────────────────────

/**
 * Visszaadja a contributor csoportokat (ContributorsSection dropdown-ok).
 *
 * @param {Object} compiled
 * @returns {Array<{slug: string, label: string}>}
 */
export function getContributorGroups(compiled) {
    return compiled?.contributorGroups ?? [];
}

// ─── Leader csoport lekérdezések ───────────────────────────────────────────

/**
 * Ellenőrzi, hogy az adott csoport leader csoport-e.
 *
 * @param {Object} compiled
 * @param {string} slug
 * @returns {boolean}
 */
export function isLeaderGroup(compiled, slug) {
    return compiled?.leaderGroups?.includes(slug) ?? false;
}

// ─── Validáció lekérdezések ────────────────────────────────────────────────

/**
 * Visszaadja az adott állapot validációs konfigurációját.
 *
 * @param {Object} compiled
 * @param {string} stateId
 * @returns {{onEntry: Array, requiredToEnter: Array, requiredToExit: Array}|null}
 */
export function getStateValidations(compiled, stateId) {
    return compiled?.validations?.[stateId] ?? null;
}

// ─── Belső segédfüggvények ─────────────────────────────────────────────────

/**
 * Ellenőrzi, hogy a felhasználó tagja-e valamelyik leader csoportnak.
 *
 * @param {Object} compiled
 * @param {string[]} userGroupSlugs
 * @returns {boolean}
 * @private
 */
function _isLeaderMember(compiled, userGroupSlugs) {
    const leaders = compiled?.leaderGroups;
    if (!leaders || !userGroupSlugs) return false;
    return leaders.some(slug => userGroupSlugs.includes(slug));
}
