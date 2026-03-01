/**
 * @fileoverview Munkafolyamat jogosultsági ellenőrzés.
 * Meghatározza, hogy egy adott felhasználó mozgathatja-e a cikket
 * a jelenlegi állapotából.
 *
 * Jogosultsági források (prioritás sorrendben):
 * 1. Hozzárendelt felhasználó (article contributor mező) — közvetlen jogosultság
 * 2. Csapattagság (user.teamIds) — alap jogosultság a munkahelyi pozíció alapján
 * 3. Label override (user.labels) — plusz jogosultságok adminisztrátori hozzárendeléssel
 *
 * @module utils/workflow/workflowPermissions
 */

import { STATE_PERMISSIONS, TEAM_ARTICLE_FIELD } from "./workflowConstants.js";

/**
 * Ellenőrzi, hogy a felhasználó mozgathatja-e a cikket az aktuális állapotából.
 *
 * Logika:
 * 1. Ha az állapotnak nincs jogosultsági bejegyzése → bárki mozgathatja.
 * 2. Az állapothoz rendelt csapatok közül megnézi, van-e bármelyikhez
 *    hozzárendelt felhasználó a cikken (a TEAM_ARTICLE_FIELD leképezés alapján).
 * 3. Ha NINCS senki hozzárendelve egyetlen releváns csapatból sem →
 *    csapattagság (teamIds) vagy label szükséges.
 * 4. Ha VAN hozzárendelt felhasználó → a jelenlegi felhasználónak:
 *    a) az egyik hozzárendelt felhasználónak kell lennie, VAGY
 *    b) a releváns csapat tagjának kell lennie (teamIds), VAGY
 *    c) rendelkeznie kell az egyik releváns csapat slug-jával a labels tömbben.
 *
 * @param {Object} article - A cikk objektum (tartalmazza a contributor mezőket).
 * @param {number} currentState - A cikk jelenlegi állapota.
 * @param {Object} user - Az Appwrite felhasználó objektum.
 * @param {string} user.$id - A felhasználó egyedi azonosítója.
 * @param {string[]} [user.teamIds] - A felhasználó csapattagságai (alap jogosultság).
 * @param {string[]} [user.labels] - A felhasználó címkéi (label override).
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canUserMoveArticle(article, currentState, user) {
    // 1. Ha nincs jogosultsági konfiguráció ehhez az állapothoz → bárki mozgathatja
    const requiredTeams = STATE_PERMISSIONS[currentState];
    if (!requiredTeams || requiredTeams.length === 0) {
        return { allowed: true };
    }

    // 2. Összegyűjtjük a releváns cikkmezők értékeit (hozzárendelt userId-k)
    const assignedUserIds = new Set();

    for (const teamSlug of requiredTeams) {
        const fieldName = TEAM_ARTICLE_FIELD[teamSlug];
        if (fieldName) {
            const assignedId = article[fieldName];
            if (assignedId) {
                assignedUserIds.add(assignedId);
            }
        }
    }

    // Segéd: csapattagság VAGY label alapján van-e jogosultság
    const userTeams = user.teamIds || [];
    const userLabels = user.labels || [];
    const hasTeamAccess = requiredTeams.some(slug =>
        userTeams.includes(slug) || userLabels.includes(slug)
    );

    // 3. Ha NINCS senki hozzárendelve → csapattagság vagy label szükséges
    if (assignedUserIds.size === 0) {
        if (hasTeamAccess) {
            return { allowed: true };
        }
        return {
            allowed: false,
            reason: "Nincs jogosultságod a cikk mozgatásához ebből az állapotból. " +
                    "Csak a releváns csapat tagjai végezhetik el az állapotváltást."
        };
    }

    // 4a. A felhasználó az egyik hozzárendelt személy?
    if (assignedUserIds.has(user.$id)) {
        return { allowed: true };
    }

    // 4b. Csapattagság vagy label override
    if (hasTeamAccess) {
        return { allowed: true };
    }

    // Nem engedélyezett
    return {
        allowed: false,
        reason: "Nincs jogosultságod a cikk mozgatásához ebből az állapotból. " +
                "Csak a hozzárendelt munkatárs vagy az adott csapat tagja/címkével rendelkező felhasználó végezheti el az állapotváltást."
    };
}

/**
 * Kényelmi függvény: ellenőrzi a jogosultságot és visszaadja a boolean eredményt.
 * Használható feltételes megjelenítéshez (pl. gomb disabled állapot).
 *
 * @param {Object} article - A cikk objektum.
 * @param {number} currentState - A cikk jelenlegi állapota.
 * @param {Object} user - Az Appwrite felhasználó objektum.
 * @returns {boolean} Igaz, ha a felhasználó mozgathatja a cikket.
 */
export function hasTransitionPermission(article, currentState, user) {
    return canUserMoveArticle(article, currentState, user).allowed;
}
