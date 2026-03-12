/**
 * @fileoverview UI elem jogosultsági konfiguráció és ellenőrzés.
 *
 * Központi, deklaratív konfiguráció, amely meghatározza, mely csapatok/labelek
 * szerkeszthetik az egyes UI elemeket. Két típusú jogosultság létezik:
 *
 * 1. **Állapotfüggetlen** (ARTICLE/PUBLICATION_ELEMENT_PERMISSIONS):
 *    A csapat-hozzárendelés nem függ a cikk állapotától.
 *
 * 2. **Állapotfüggő** (canUserAccessInState):
 *    Fájlmegnyitás és parancsok — tervezők/művészeti vezetők mindig,
 *    mások csak a STATE_PERMISSIONS szerinti állapotaikban.
 *
 * @module utils/workflow/elementPermissions
 */

import { STATE_PERMISSIONS, labelMatchesSlug } from "./workflowConstants.js";

// ─── Jogosultsági szintek ───────────────────────────────────────────────────

/**
 * Bárki, akinek van legalább egy csapattagsága vagy label-je.
 * Csapat/label nélküli felhasználó számára az elem disabled.
 *
 * @type {Symbol}
 */
export const ANY_TEAM = Symbol('ANY_TEAM');

// ─── Cikk-szintű jogosultságok ─────────────────────────────────────────────

/**
 * Cikk-szintű UI elem jogosultságok (állapotfüggetlen).
 *
 * Kulcs: logikai elemcsoport azonosító.
 * Érték: csapat-slug tömb VAGY ANY_TEAM szimbólum.
 *
 * A csapat-ellenőrzés: user.teamIds VAGY user.labels tartalmazza-e
 * valamelyik slug-ot.
 *
 * Megjegyzés: openFile és commands NEM szerepelnek itt —
 * állapotfüggő logikával működnek (ld. canUserAccessInState).
 *
 * @type {Object.<string, string[]|Symbol>}
 */
export const ARTICLE_ELEMENT_PERMISSIONS = {
    // ── GeneralSection ─────────────────────────────────────────
    articleName:         ["editors", "designers", "managing_editors", "art_directors"],
    articlePages:        ["designers", "art_directors"],
    articleLayout:       ["designers", "art_directors"],

    // ── ContributorsSection — per-dropdown jogosultság (ld. canEditContributorDropdown)

    // ── ValidationSection ──────────────────────────────────────
    validationForm:      ANY_TEAM,
    validationActions:   ANY_TEAM,

    // ── PropertiesPanel fejléc ─────────────────────────────────
    ignoreToggle:        ["editors", "designers", "managing_editors", "art_directors"],
};

// ─── Kiadvány-szintű jogosultságok ─────────────────────────────────────────

/**
 * Kiadvány-szintű UI elem jogosultságok.
 * Nincs article kontextus — csak csapat/label alapján.
 *
 * @type {Object.<string, string[]|Symbol>}
 */
export const PUBLICATION_ELEMENT_PERMISSIONS = {
    publicationProperties:   ["managing_editors", "art_directors"],
    publicationGeneral:      ["editors", "managing_editors", "art_directors"],
    publicationLayouts:      ["designers", "art_directors"],
    publicationDeadlines:    ["editors", "managing_editors", "art_directors"],
    publicationContributors: ["editors", "managing_editors", "art_directors"],
};

// ─── Jogosultság-ellenőrző függvények ──────────────────────────────────────

/**
 * Ellenőrzi, hogy a felhasználó szerkesztheti-e az adott UI elemet.
 *
 * @param {string[]|Symbol} permission - Az elem jogosultsági konfigurációja.
 * @param {Object} user - A felhasználó objektum.
 * @param {string[]} [user.teamIds] - A felhasználó csapattagságai.
 * @param {string[]} [user.labels] - A felhasználó címkéi.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkElementPermission(permission, user) {
    if (!user) {
        return { allowed: false, reason: "Nincs bejelentkezett felhasználó." };
    }

    const userTeams = user.teamIds || [];
    const userLabels = user.labels || [];

    // ANY_TEAM: legalább egy csapat/label kell
    if (permission === ANY_TEAM) {
        if (userTeams.length > 0 || userLabels.length > 0) {
            return { allowed: true };
        }
        return { allowed: false, reason: "Nincs jogosultságod az elem szerkesztéséhez." };
    }

    // Konkrét csapat-slug tömb
    if (Array.isArray(permission)) {
        const hasAccess = permission.some(slug =>
            userTeams.includes(slug) || labelMatchesSlug(userLabels, slug)
        );
        if (hasAccess) {
            return { allowed: true };
        }
        return { allowed: false, reason: "Nincs jogosultságod az elem szerkesztéséhez." };
    }

    // Ismeretlen konfiguráció → engedélyezett (fejlesztési kényelem)
    return { allowed: true };
}

/**
 * Állapotfüggő jogosultság ellenőrzése fájlmegnyitáshoz és parancsokhoz.
 *
 * Tervezők és művészeti vezetők mindig hozzáférhetnek.
 * Mások csak akkor, ha a cikk olyan állapotban van, ahol nekik
 * van STATE_PERMISSIONS jogosultságuk.
 *
 * @param {Object} user - A felhasználó objektum.
 * @param {number} articleState - A cikk aktuális workflow állapota.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canUserAccessInState(user, articleState) {
    if (!user) {
        return { allowed: false, reason: "Nincs bejelentkezett felhasználó." };
    }

    const alwaysAllowed = ["designers", "art_directors"];
    const userTeams = user.teamIds || [];
    const userLabels = user.labels || [];

    // Tervezők és művészeti vezetők mindig hozzáférhetnek
    if (alwaysAllowed.some(slug => userTeams.includes(slug) || labelMatchesSlug(userLabels, slug))) {
        return { allowed: true };
    }

    // Mások: van-e STATE_PERMISSIONS jogosultságuk ehhez az állapothoz?
    const stateTeams = STATE_PERMISSIONS[articleState];
    if (stateTeams?.some(slug => userTeams.includes(slug) || labelMatchesSlug(userLabels, slug))) {
        return { allowed: true };
    }

    return { allowed: false, reason: "Nincs jogosultságod ehhez a művelethez ebben az állapotban." };
}

// ─── Vezetői csapatok ────────────────────────────────────────────────────────

/**
 * Vezetői pozíciók: bármely contributor dropdown-ot szerkeszthetik,
 * bármely állapotban.
 *
 * @type {string[]}
 */
export const LEADER_TEAMS = ["managing_editors", "art_directors"];

/**
 * Ellenőrzi, hogy a felhasználó szerkesztheti-e az adott contributor
 * dropdown-ot a cikk aktuális állapotában.
 *
 * Szabályok:
 * 1. Vezetők (managing_editors, art_directors) → bármely dropdown, bármely állapot.
 * 2. Nem-vezetők → csak a saját csapatjuknak/label-jüknek megfelelő dropdown,
 *    és csak ha a cikk állapota számukra aktív (STATE_PERMISSIONS).
 *
 * @param {Object} user - Felhasználó objektum.
 * @param {string[]} [user.teamIds] - Csapattagságok.
 * @param {string[]} [user.labels] - Címkék (label override).
 * @param {string} teamSlug - A dropdown-hoz tartozó csapat slug (pl. "designers").
 * @param {number} articleState - A cikk aktuális workflow állapota.
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canEditContributorDropdown(user, teamSlug, articleState) {
    if (!user) {
        return { allowed: false, reason: "Nincs bejelentkezett felhasználó." };
    }

    const userTeams = user.teamIds || [];
    const userLabels = user.labels || [];

    // Vezetők mindig szerkeszthetnek bármely dropdown-ot
    if (LEADER_TEAMS.some(slug => userTeams.includes(slug) || labelMatchesSlug(userLabels, slug))) {
        return { allowed: true };
    }

    // Nem-vezető: a felhasználó tagja-e (teamIds/labels) ennek a csapatnak?
    const isMemberOfTeam = userTeams.includes(teamSlug) || labelMatchesSlug(userLabels, teamSlug);
    if (!isMemberOfTeam) {
        return { allowed: false, reason: "Nincs jogosultságod ehhez a mezőhöz." };
    }

    // A csapat rendelkezik-e jogosultsággal ebben az állapotban?
    const stateTeams = STATE_PERMISSIONS[articleState];
    if (stateTeams && stateTeams.includes(teamSlug)) {
        return { allowed: true };
    }

    return { allowed: false, reason: "Ebben az állapotban nem szerkesztheted ezt a mezőt." };
}
