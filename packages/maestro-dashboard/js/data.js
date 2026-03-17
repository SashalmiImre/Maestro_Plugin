/**
 * Maestro Dashboard — Adat réteg
 *
 * Read-only adat lekérés: kiadványok, cikkek, határidők, validációk.
 * Csapattag feloldás Cloud Function-nel.
 */

import { Databases, Functions, Query } from 'appwrite';
import { getClient } from './auth.js';
import {
    DATABASE_ID, COLLECTIONS, GET_TEAM_MEMBERS_FUNCTION_ID,
    TEAMS, TEAM_CACHE_DURATION_MS
} from './config.js';

// ─── Appwrite szolgáltatások (lazy init a login után) ───────────────────────

let databases = null;
let functions = null;

/** A login után hívandó, hogy a databases/functions kliensek éljenek. */
export function initServices() {
    const client = getClient();
    databases = new Databases(client);
    functions = new Functions(client);
}

/** Lapozás méret az Appwrite lekérdezésekhez. */
const PAGE_SIZE = 100;

// ─── Adat állapot ───────────────────────────────────────────────────────────

let publications = [];
let articles = [];
let deadlines = [];
let validations = [];
let activePublicationId = null;

export const getPublications = () => publications;
export const getArticles = () => articles;
export const getDeadlines = () => deadlines;
export const getValidations = () => validations;
export const getActivePublicationId = () => activePublicationId;

// ─── Változás-értesítések ───────────────────────────────────────────────────

const listeners = new Set();

/**
 * Feliratkozás adat változásokra.
 * @param {Function} callback — Híváskor: { type: 'publications'|'articles'|'deadlines'|'validations' }
 * @returns {Function} Leiratkozó függvény.
 */
export function onDataChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}

function notifyListeners(type) {
    for (const cb of listeners) {
        try { cb({ type }); } catch { /* ne akadjon el */ }
    }
}

// ─── Kiadványok lekérése ────────────────────────────────────────────────────

/**
 * Lekéri az összes kiadványt lapozással.
 * @returns {Promise<Array>}
 */
export async function fetchPublications() {
    const allDocuments = [];
    let offset = 0;

    while (true) {
        const result = await databases.listDocuments(DATABASE_ID, COLLECTIONS.PUBLICATIONS, [
            Query.limit(PAGE_SIZE),
            Query.offset(offset),
            Query.orderAsc('name')
        ]);

        allDocuments.push(...result.documents);

        if (result.documents.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    publications = allDocuments;
    notifyListeners('publications');
    return publications;
}

// ─── Aktív kiadvány váltása + adat lekérés ──────────────────────────────────

/**
 * Kiadvány váltás — lekéri a cikkeket, határidőket és validációkat.
 * @param {string} publicationId
 */
export async function switchPublication(publicationId) {
    activePublicationId = publicationId;

    // Párhuzamos lekérés
    const [articlesResult, deadlinesResult, validationsResult] = await Promise.all([
        databases.listDocuments(DATABASE_ID, COLLECTIONS.ARTICLES, [
            Query.equal('publicationId', publicationId),
            Query.limit(1000),
            Query.orderAsc('startPage')
        ]).catch(() => ({ documents: [] })),
        databases.listDocuments(DATABASE_ID, COLLECTIONS.DEADLINES, [
            Query.equal('publicationId', publicationId),
            Query.limit(100)
        ]).catch(() => ({ documents: [] })),
        databases.listDocuments(DATABASE_ID, COLLECTIONS.USER_VALIDATIONS, [
            Query.equal('publicationId', publicationId),
            Query.limit(1000)
        ]).catch(() => ({ documents: [] }))
    ]);

    articles = articlesResult.documents;
    deadlines = deadlinesResult.documents;
    validations = validationsResult.documents;

    notifyListeners('articles');
    notifyListeners('deadlines');
    notifyListeners('validations');
}

// ─── Realtime frissítések alkalmazása ───────────────────────────────────────

/**
 * Cikk Realtime frissítés alkalmazása (create/update/delete).
 * $updatedAt elavulás-védelemmel.
 */
export function applyArticleEvent(eventType, payload) {
    if (payload.publicationId !== activePublicationId) return;

    if (eventType === 'delete') {
        articles = articles.filter(a => a.$id !== payload.$id);
    } else {
        const idx = articles.findIndex(a => a.$id === payload.$id);
        if (idx >= 0) {
            // Elavulás-védelem
            const local = articles[idx];
            if (local.$updatedAt && payload.$updatedAt &&
                new Date(local.$updatedAt) > new Date(payload.$updatedAt)) {
                return;
            }
            articles = [...articles];
            articles[idx] = payload;
        } else {
            articles = [...articles, payload];
        }
    }
    notifyListeners('articles');
}

/** Kiadvány Realtime frissítés alkalmazása. */
export function applyPublicationEvent(eventType, payload) {
    if (eventType === 'delete') {
        publications = publications.filter(p => p.$id !== payload.$id);
    } else {
        const idx = publications.findIndex(p => p.$id === payload.$id);
        if (idx >= 0) {
            publications = [...publications];
            publications[idx] = payload;
        } else {
            publications = [...publications, payload];
        }
    }
    notifyListeners('publications');
}

/** Határidő Realtime frissítés alkalmazása. */
export function applyDeadlineEvent(eventType, payload) {
    if (payload.publicationId !== activePublicationId) return;

    if (eventType === 'delete') {
        deadlines = deadlines.filter(d => d.$id !== payload.$id);
    } else {
        const idx = deadlines.findIndex(d => d.$id === payload.$id);
        if (idx >= 0) {
            deadlines = [...deadlines];
            deadlines[idx] = payload;
        } else {
            deadlines = [...deadlines, payload];
        }
    }
    notifyListeners('deadlines');
}

/** Felhasználói validáció Realtime frissítés alkalmazása. */
export function applyValidationEvent(eventType, payload) {
    if (payload.publicationId !== activePublicationId) return;

    if (eventType === 'delete') {
        validations = validations.filter(v => v.$id !== payload.$id);
    } else {
        const idx = validations.findIndex(v => v.$id === payload.$id);
        if (idx >= 0) {
            validations = [...validations];
            validations[idx] = payload;
        } else {
            validations = [...validations, payload];
        }
    }
    notifyListeners('validations');
}

// ─── Csapattag feloldás (lock owner nevek) ──────────────────────────────────

/** Cache: userId → userName */
let memberCache = new Map();
let memberCacheTime = 0;

/**
 * Lekéri az összes csapattag nevét (deduplikálva).
 * 5 perces memória cache.
 *
 * @returns {Promise<Map<string, string>>} userId → userName
 */
export async function fetchAllTeamMembers() {
    const now = Date.now();
    if (memberCache.size > 0 && (now - memberCacheTime) < TEAM_CACHE_DURATION_MS) {
        return memberCache;
    }

    const allTeamIds = Object.values(TEAMS);
    const results = await Promise.allSettled(
        allTeamIds.map(teamId =>
            functions.createExecution(
                GET_TEAM_MEMBERS_FUNCTION_ID,
                JSON.stringify({ teamId }),
                false
            )
        )
    );

    const map = new Map();
    for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        try {
            const response = JSON.parse(result.value.responseBody);
            if (response.success && response.members) {
                for (const m of response.members) {
                    if (!map.has(m.userId)) {
                        map.set(m.userId, m.name);
                    }
                }
            }
        } catch { /* parse hiba — kihagyjuk */ }
    }

    memberCache = map;
    memberCacheTime = now;
    return map;
}

/**
 * Felold egy userId-t névre.
 * @param {string} userId
 * @returns {string|null}
 */
export function getMemberName(userId) {
    return memberCache.get(userId) || null;
}
