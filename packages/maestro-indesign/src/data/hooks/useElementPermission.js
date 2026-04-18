/**
 * @fileoverview UI elem jogosultsági hook-ok.
 *
 * A compiled workflow `elementPermissions`-t és a UserContext-et összekapcsolva
 * határozza meg, hogy az adott UI elem szerkeszthető-e az aktuális
 * felhasználó számára.
 *
 * A publikus API (useElementPermission, useElementPermissions, useContributorPermissions)
 * **nem változott** — csak a belső implementáció delegál a workflowRuntime-ra.
 *
 * @module data/hooks/useElementPermission
 */

import { useMemo } from "react";

import { useUser } from "../../core/contexts/UserContext.jsx";
import { useData } from "../../core/contexts/DataContext.jsx";

import {
    canEditElement,
    canEditContributorDropdown,
    canUserAccessInState
} from "maestro-shared/workflowRuntime.js";

/**
 * Egyetlen UI elem jogosultsági állapotát adja vissza.
 *
 * @param {string} elementKey - Az elem kulcsa (pl. 'articlePages', 'publicationLayouts').
 * @param {string} [scope] - 'article' vagy 'publication'. Ha nincs megadva, mindkettőben keres.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function useElementPermission(elementKey, scope) {
    const { user } = useUser();
    const { workflow } = useData();

    return useMemo(() => {
        if (!workflow) return { allowed: false, reason: 'Workflow betöltés alatt...' };
        const userGroups = user?.groupSlugs || [];

        // Ha a scope explicit, azt használjuk; különben mindkettőben keresünk
        if (scope) {
            return canEditElement(workflow, scope, elementKey, userGroups);
        }
        // Először article scope-ban keresünk, ha ott definiálva van; különben publication
        if (workflow?.elementPermissions?.article?.[elementKey] !== undefined) {
            return canEditElement(workflow, 'article', elementKey, userGroups);
        }
        return canEditElement(workflow, 'publication', elementKey, userGroups);
    }, [elementKey, scope, workflow, user?.groupSlugs]);
}

/**
 * Több UI elem jogosultsági állapotát adja vissza egyszerre.
 *
 * @param {string[]} elementKeys - Elemkulcsok tömbje.
 * @param {string} [scope] - 'article' vagy 'publication'.
 * @returns {Object.<string, { allowed: boolean, reason?: string }>}
 */
export function useElementPermissions(elementKeys, scope) {
    const { user } = useUser();
    const { workflow } = useData();

    return useMemo(() => {
        if (!workflow) {
            const result = {};
            for (const key of elementKeys) result[key] = { allowed: false, reason: 'Workflow betöltés alatt...' };
            return result;
        }

        const userGroups = user?.groupSlugs || [];
        const result = {};
        for (const key of elementKeys) {
            if (scope) {
                result[key] = canEditElement(workflow, scope, key, userGroups);
            } else {
                // Keresés mindkét scope-ban (article first)
                if (workflow?.elementPermissions?.article?.[key] !== undefined) {
                    result[key] = canEditElement(workflow, 'article', key, userGroups);
                } else {
                    result[key] = canEditElement(workflow, 'publication', key, userGroups);
                }
            }
        }
        return result;
    }, [elementKeys, scope, workflow, user?.groupSlugs]);
}

/**
 * Minden contributor dropdown-hoz kiszámítja a jogosultságot
 * a felhasználó csoporttagsága és a cikk állapota alapján.
 *
 * @param {string} articleState - A cikk aktuális workflow állapota (string ID).
 * @param {string[]} groupSlugs - Az elérhető csoportok slug-jai.
 * @returns {Object.<string, { allowed: boolean, reason?: string }>}
 */
export function useContributorPermissions(articleState, groupSlugs) {
    const { user } = useUser();
    const { workflow } = useData();

    return useMemo(() => {
        const result = {};
        const userGroups = user?.groupSlugs || [];
        for (const slug of (groupSlugs || [])) {
            if (!workflow) {
                result[slug] = { allowed: false, reason: 'Workflow betöltés alatt...' };
            } else {
                result[slug] = canEditContributorDropdown(workflow, slug, userGroups, articleState);
            }
        }
        return result;
    }, [workflow, user?.groupSlugs, articleState, groupSlugs]);
}

/**
 * Állapotfüggő hozzáférés ellenőrzése (fájlmegnyitás, parancsok).
 *
 * @param {string} stateId - A cikk aktuális állapota.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function useStateAccessPermission(stateId) {
    const { user } = useUser();
    const { workflow } = useData();

    return useMemo(() => {
        if (!workflow) return { allowed: true };
        const userGroups = user?.groupSlugs || [];
        return canUserAccessInState(workflow, userGroups, stateId);
    }, [workflow, user?.groupSlugs, stateId]);
}
