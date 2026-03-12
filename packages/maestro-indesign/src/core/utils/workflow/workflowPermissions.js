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

import { STATE_PERMISSIONS, labelMatchesSlug } from "./workflowConstants.js";

/**
 * Ellenőrzi, hogy a felhasználó mozgathatja-e a cikket az aktuális állapotából.
 *
 * Logika:
 * 1. Ha az állapotnak nincs jogosultsági bejegyzése → bárki mozgathatja.
 * 2. Csapattagság (teamIds) VAGY label override szükséges a releváns csapatok valamelyikéhez.
 *
 * A közvetlen hozzárendelés (contributor mező) NEM ad önálló jogosultságot az állapotváltáshoz —
 * csapattagság vagy label mindig szükséges. Így elkerülhető, hogy egy véletlenül rossz mezőbe
 * beállított felhasználó (pl. editor a designerId-ban) a csapatától független jogot kapjon.
 *
 * @param {Object} article - A cikk objektum.
 * @param {number} currentState - A cikk jelenlegi állapota.
 * @param {Object} user - Az Appwrite felhasználó objektum.
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

    // 2. Csapattagság VAGY label alapján van-e jogosultság
    const userTeams = user.teamIds || [];
    const userLabels = user.labels || [];
    const hasTeamAccess = requiredTeams.some(slug =>
        userTeams.includes(slug) || labelMatchesSlug(userLabels, slug)
    );

    if (hasTeamAccess) {
        return { allowed: true };
    }

    return {
        allowed: false,
        reason: "Nincs jogosultságod a cikk mozgatásához ebből az állapotból. " +
                "Csak a releváns csapat tagjai végezhetik el az állapotváltást."
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
