/**
 * Maestro Dashboard — Realtime Bus
 *
 * Egyetlen `client.subscribe()` hívás az összes csatornára, ami a
 * feliratkozó modulokból érkezik (AuthContext tenant csatornák +
 * DataContext adat csatornák). Belül dispatch-eli a bejövő eseményeket
 * a regisztrált handler-ek csatorna-halmazához.
 *
 * Miért: az Appwrite Cloud custom domain (api.maestro.emago.hu) a
 * kliens SDK 24.1.1 `channel[slot][]=query` per-subscription formátumával
 * csak a SLOT 0-hoz (első subscribe) route-ol eseményeket. A SLOT 1-re
 * (második subscribe ugyanazon WS-en) soha nem érkezik event. Emiatt
 * két külön subscribe helyett EGY feliratkozást használunk, és magunk
 * dispatch-eljük a callback-eket csatorna alapján.
 *
 * Debounce (50ms) kezeli a gyakori regisztráció / deregisztráció
 * burst-öket (pl. React dev mode dupla effect), hogy ne építsük újra
 * a WS-t minden regisztrációra. Ha a csatorna-unió változatlan
 * (átfedő subscribe / unsubscribe részhalmazra), a WS nem is épül újra.
 */

import { getClient } from './AuthContext.jsx';
import { DATABASE_ID } from '../config.js';

/**
 * Collection-szintű Appwrite Realtime csatorna név.
 * @param {string} collectionId
 */
export function collectionChannel(collectionId) {
    return `databases.${DATABASE_ID}.collections.${collectionId}.documents`;
}

/**
 * Document-szintű Appwrite Realtime csatorna név.
 * @param {string} collectionId
 * @param {string} documentId
 */
export function documentChannel(collectionId, documentId) {
    return `databases.${DATABASE_ID}.collections.${collectionId}.documents.${documentId}`;
}

/** @type {Map<number, { channels: Set<string>, callback: (r: any) => void }>} */
const handlers = new Map();
let nextId = 0;
let currentUnsubscribe = null;
let currentChannels = new Set();
let rebuildTimer = null;

function rebuild() {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
        rebuildTimer = null;
        doRebuild();
    }, 50);
}

function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

function doRebuild() {
    const union = new Set();
    handlers.forEach((h) => h.channels.forEach((c) => union.add(c)));

    // Ha az aktív csatorna-halmaz nem változott, a WS-t sem kell újraépíteni.
    // Új handler az átfedő csatornán azonnal megkapja az eseményeket a
    // modul-szintű `handlers` Map iterációján keresztül.
    if (setsEqual(union, currentChannels)) return;

    if (currentUnsubscribe) {
        try { currentUnsubscribe(); } catch { /* noop */ }
        currentUnsubscribe = null;
    }
    currentChannels = union;

    if (union.size === 0) return;

    const client = getClient();
    const allChannels = Array.from(union);
    currentUnsubscribe = client.subscribe(allChannels, (response) => {
        const eventChannels = response?.channels || [];
        handlers.forEach((h) => {
            for (const ch of eventChannels) {
                if (h.channels.has(ch)) {
                    try {
                        h.callback(response);
                    } catch (err) {
                        console.error('[realtimeBus] handler error:', err);
                    }
                    return;
                }
            }
        });
    });
}

/**
 * Feliratkozás egy csatornára vagy csatorna-halmazra a megosztott WS-en.
 * API kompatibilis a `client.subscribe()`-el: `string | string[]`-et fogad el.
 *
 * @param {string | string[]} channels — csatorna név(ek)
 * @param {(response: any) => void} callback — bejövő event handler
 * @returns {() => void} — unsubscribe függvény
 */
export function subscribeRealtime(channels, callback) {
    const list = Array.isArray(channels) ? channels : [channels];
    const id = nextId++;
    handlers.set(id, { channels: new Set(list), callback });
    rebuild();
    return () => {
        handlers.delete(id);
        rebuild();
    };
}
