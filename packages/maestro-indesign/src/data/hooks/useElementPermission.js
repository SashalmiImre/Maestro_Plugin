/**
 * @fileoverview UI elem jogosultsági hook-ok.
 *
 * Az elementPermissions.js konfigurációt és a UserContext-et összekapcsolva
 * határozza meg, hogy az adott UI elem szerkeszthető-e az aktuális
 * felhasználó számára.
 *
 * @module data/hooks/useElementPermission
 */

import { useMemo } from "react";

import { useUser } from "../../core/contexts/UserContext.jsx";

import {
    ARTICLE_ELEMENT_PERMISSIONS,
    PUBLICATION_ELEMENT_PERMISSIONS,
    checkElementPermission,
    canEditContributorDropdown
} from "../../core/utils/workflow/elementPermissions.js";

/**
 * Egyetlen UI elem jogosultsági állapotát adja vissza.
 *
 * @param {string} elementKey - Az elem kulcsa (pl. 'articlePages', 'publicationLayouts').
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function useElementPermission(elementKey) {
    const { user } = useUser();

    return useMemo(() => {
        const permission = ARTICLE_ELEMENT_PERMISSIONS[elementKey]
            ?? PUBLICATION_ELEMENT_PERMISSIONS[elementKey];

        // Ismeretlen kulcs → engedélyezett (fejlesztési kényelemből)
        if (permission === undefined) {
            return { allowed: true };
        }

        return checkElementPermission(permission, user);
    }, [elementKey, user?.groupSlugs, user?.labels]);
}

/**
 * Több UI elem jogosultsági állapotát adja vissza egyszerre.
 * Hatékony: egyetlen useMemo-ban számolja ki az összeset.
 *
 * @param {string[]} elementKeys - Elemkulcsok tömbje.
 * @returns {Object.<string, { allowed: boolean, reason?: string }>}
 */
export function useElementPermissions(elementKeys) {
    const { user } = useUser();

    return useMemo(() => {
        const result = {};
        for (const key of elementKeys) {
            const permission = ARTICLE_ELEMENT_PERMISSIONS[key]
                ?? PUBLICATION_ELEMENT_PERMISSIONS[key];

            result[key] = permission === undefined
                ? { allowed: true }
                : checkElementPermission(permission, user);
        }
        return result;
    }, [elementKeys, user?.groupSlugs, user?.labels]);
}

/**
 * Minden contributor dropdown-hoz kiszámítja a jogosultságot
 * a felhasználó csapattagsága/label-jei és a cikk állapota alapján.
 *
 * @param {number} articleState - A cikk aktuális workflow állapota.
 * @param {string[]} groupSlugs - Az elérhető csoportok slug-jai
 *   (a useContributorGroups().groups.map(g => g.slug) eredménye).
 * @returns {Object.<string, { allowed: boolean, reason?: string }>}
 *   Kulcs: teamSlug (pl. "designers"), Érték: jogosultsági eredmény.
 */
export function useContributorPermissions(articleState, groupSlugs) {
    const { user } = useUser();

    return useMemo(() => {
        const result = {};
        for (const slug of (groupSlugs || [])) {
            result[slug] = canEditContributorDropdown(user, slug, articleState);
        }
        return result;
    }, [user?.groupSlugs, user?.labels, articleState, groupSlugs]);
}
