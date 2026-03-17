/**
 * Maestro Dashboard — Realtime feliratkozások
 *
 * Appwrite Web SDK Realtime — cikkek, kiadványok, határidők, validációk.
 */

import { getClient } from './auth.js';
import { DATABASE_ID, COLLECTIONS } from './config.js';
import {
    applyArticleEvent,
    applyPublicationEvent,
    applyDeadlineEvent,
    applyValidationEvent
} from './data.js';

let unsubscribe = null;

// ─── Csatorna nevek ─────────────────────────────────────────────────────────

const channel = (collection) =>
    `databases.${DATABASE_ID}.collections.${collection}.documents`;

// ─── Event típus meghatározása ──────────────────────────────────────────────

/**
 * Meghatározza az esemény típusát az events[] tömbből.
 * @param {string[]} events
 * @returns {'create'|'update'|'delete'|null}
 */
function getEventType(events) {
    for (const e of events) {
        if (e.includes('.create')) return 'create';
        if (e.includes('.update')) return 'update';
        if (e.includes('.delete')) return 'delete';
    }
    return null;
}

/**
 * Meghatározza, melyik collection-höz tartozik az esemény.
 * @param {string[]} channels
 * @returns {string|null}
 */
function getCollection(channels) {
    for (const ch of channels) {
        if (ch.includes(COLLECTIONS.ARTICLES)) return 'articles';
        if (ch.includes(COLLECTIONS.PUBLICATIONS)) return 'publications';
        if (ch.includes(COLLECTIONS.DEADLINES)) return 'deadlines';
        if (ch.includes(COLLECTIONS.USER_VALIDATIONS)) return 'validations';
    }
    return null;
}

// ─── Feliratkozás ───────────────────────────────────────────────────────────

/**
 * Elindítja a Realtime feliratkozásokat.
 * Automatikusan kezeli a cikk/kiadvány/határidő/validáció eseményeket.
 */
export function subscribeRealtime() {
    // Előző feliratkozás leállítása
    if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
    }

    const client = getClient();
    
    // Guard: bail out if client is not available
    if (!client) {
        console.warn('Realtime client not available, cannot subscribe');
        return;
    }

    unsubscribe = client.subscribe([
        channel(COLLECTIONS.ARTICLES),
        channel(COLLECTIONS.PUBLICATIONS),
        channel(COLLECTIONS.DEADLINES),
        channel(COLLECTIONS.USER_VALIDATIONS)
    ], (response) => {
        const eventType = getEventType(response.events);
        if (!eventType) return;

        const collection = getCollection(response.channels);
        if (!collection) return;

        const payload = response.payload;

        try {
            switch (collection) {
                case 'articles':
                    applyArticleEvent(eventType, payload);
                    break;
                case 'publications':
                    applyPublicationEvent(eventType, payload);
                    break;
                case 'deadlines':
                    applyDeadlineEvent(eventType, payload);
                    break;
                case 'validations':
                    applyValidationEvent(eventType, payload);
                    break;
            }
        } catch (error) {
            console.error('Realtime event handler error', {
                eventType,
                collection,
                payload,
                error: error?.message || error
            });
        }
    });
}

// ─── Leiratkozás ────────────────────────────────────────────────────────────

/**
 * Leállítja a Realtime feliratkozásokat (kijelentkezéskor).
 */
export function unsubscribeRealtime() {
    if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
    }
}
