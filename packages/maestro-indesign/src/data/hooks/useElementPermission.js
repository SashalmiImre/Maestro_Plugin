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
import { clientHasPermission } from "maestro-shared/permissions.js";

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

// ── Office-scope permission slug hookok (A.5.2, ADR 0008) ──────────────────
//
// A `useUserPermission(slug)` és `useUserPermissions(slugs[])` a 33 office-scope
// slug egyikére (`publication.create`, `workflow.edit`, stb.) ad UI-rétegű
// választ. **NEM helyettesíti a server-side guardot** — a végleges authority
// a CF `userHasPermission()`. A `user.permissions` egy snapshot, ami stale
// lehet (Realtime push előtt) — ezért a hívók fail-closed-ot kapnak loading
// (`null`) állapotban (a `clientHasPermission(null, slug) === false`).
//
// A `useElementPermission` továbbra is a workflow-runtime `groupSlugs` ágon
// működik (cikk-szintű elem-engedélyek) — a két réteg AND-elve használandó:
//   const elementPerm = useElementPermission('publicationLayouts');
//   const userPerm    = useUserPermission('publication.settings.edit');
//   const allowed     = elementPerm.allowed && userPerm.allowed;

/**
 * Egyetlen office-scope permission slug ellenőrzése.
 *
 * @param {string} slug - 33 office-scope slug egyike (pl. `'publication.create'`)
 * @returns {{ allowed: boolean, loading: boolean }}
 */
export function useUserPermission(slug) {
    const { user } = useUser();

    return useMemo(() => {
        const loading = user?.permissions === null || user?.permissions === undefined;
        if (loading) return { allowed: false, loading: true };
        try {
            return { allowed: clientHasPermission(user.permissions, slug), loading: false };
        } catch (err) {
            // A `clientHasPermission` throw-ol, ha a slug nem office-scope (org.* vagy
            // ismeretlen). Fail-closed UI-szinten — fejlesztési hiba, ne crashítsuk
            // a komponenst.
            return { allowed: false, loading: false };
        }
    }, [user?.permissions, slug]);
}

/**
 * Több office-scope permission slug ellenőrzése egyszerre.
 *
 * A `slugs` array referencia-stabilizáció: a join-jét string kulcsként
 * használjuk a memo-ban, hogy a hívó inline literal `[a, b]` (új ref minden
 * render-en) ne triggereljen felesleges újraszámolást.
 *
 * @param {string[]} slugs - 33 office-scope slug részhalmaza
 * @returns {{ permissions: Object.<string, boolean>, loading: boolean }}
 */
export function useUserPermissions(slugs) {
    const { user } = useUser();
    const slugsKey = Array.isArray(slugs) ? slugs.join('|') : '';

    return useMemo(() => {
        const loading = user?.permissions === null || user?.permissions === undefined;
        const result = {};
        for (const slug of (slugs || [])) {
            if (loading) {
                result[slug] = false;
                continue;
            }
            try {
                result[slug] = clientHasPermission(user.permissions, slug);
            } catch (err) {
                result[slug] = false;
            }
        }
        return { permissions: result, loading };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.permissions, slugsKey]);
}
