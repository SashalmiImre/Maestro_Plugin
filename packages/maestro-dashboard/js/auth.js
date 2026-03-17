/**
 * Maestro Dashboard — Autentikáció
 *
 * Bejelentkezés, kijelentkezés, session ellenőrzés.
 * Az Appwrite Web SDK böngészőben natívan kezeli a cookie-kat.
 */

import { Client, Account, Teams } from 'appwrite';
import { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID } from './config.js';

// ─── Appwrite kliens ────────────────────────────────────────────────────────

const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID);

const account = new Account(client);
const teams = new Teams(client);

/**
 * @returns {Client} Az Appwrite kliens példány (data.js és realtime.js használja).
 */
export const getClient = () => client;

/**
 * @returns {Account} Az Appwrite Account példány.
 */
export const getAccount = () => account;

// ─── Aktuális felhasználó ───────────────────────────────────────────────────

let currentUser = null;

export const getCurrentUser = () => currentUser;

// ─── Session ellenőrzés (oldal betöltéskor) ─────────────────────────────────

/**
 * Ellenőrzi, hogy van-e aktív session.
 * Ha igen, lekéri a felhasználó adatait és csapattagságait.
 *
 * @returns {Promise<Object|null>} A felhasználó objektum, vagy null.
 */
export async function checkSession() {
    try {
        const user = await account.get();
        const teamIds = await fetchTeamIds();
        currentUser = { ...user, teamIds };
        return currentUser;
    } catch {
        currentUser = null;
        return null;
    }
}

// ─── Bejelentkezés ──────────────────────────────────────────────────────────

/**
 * Bejelentkezés email + jelszó alapján.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<Object>} A felhasználó objektum.
 * @throws {Error} Hibás adatok vagy hálózati hiba esetén.
 */
export async function login(email, password) {
    await account.createEmailPasswordSession(email, password);
    const user = await account.get();
    const teamIds = await fetchTeamIds();
    currentUser = { ...user, teamIds };
    return currentUser;
}

// ─── Kijelentkezés ──────────────────────────────────────────────────────────

/**
 * Kijelentkezés — session törlése.
 */
export async function logout() {
    try {
        await account.deleteSession('current');
    } catch {
        // Ha a session már nem létezik, nem baj
    }
    currentUser = null;
}

// ─── Csapattagság lekérés ───────────────────────────────────────────────────

/**
 * Lekéri a bejelentkezett felhasználó csapattagságait.
 *
 * @returns {Promise<string[]>} A csapat slug-ok tömbje (pl. ['designers', 'art_directors']).
 */
async function fetchTeamIds() {
    try {
        const result = await teams.list();
        return result.teams.map(t => t.$id);
    } catch {
        return [];
    }
}
