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
 *
 * Reconnect-time resync (A.4.9 review fix):
 * Az Appwrite Web SDK 24.1.1 `client.subscribe()` szinkron unsubscribe-ot
 * ad vissza, és a callback CSAK `event` típusú push-okat kap — a WS
 * `open` / `close` és az SDK belső `connected` üzenete nem látszik a
 * publikus API-n. Ha a WS megszakad és újrakapcsolódik, a disconnect
 * ablakban érkező mutációkat sosem látjuk push-ként → a Realtime-vezérelt
 * cache-ek (pl. `useContributorGroups`, `AuthContext` memberships,
 * `DataContext` aktív kiadvány) néma stale-ben ragadnak a következő
 * mount-ig. Védelem: a `client.realtime.createSocket`-et egyszer
 * kicseréljük egy wrapper-re, ami minden új socket-re `open`/`close`
 * listener-t aggat, és a második (és további) sikeres `open` után
 * meghívja a feliratkozók `onReconnect` callback-jét. Az első `open`
 * (kezdeti kapcsolódás) NEM trigger-eli — a fogyasztók mount-effect-je
 * úgyis lekérte az adatot, fals duplikált fetch-et kerülünk.
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
/** @type {Map<number, () => void>} */
const reconnectListeners = new Map();
let nextId = 0;
let currentUnsubscribe = null;
let currentChannels = new Set();
let rebuildTimer = null;

// Reconnect-detect állapot (lásd file-szintű kommentet).
let socketHookInstalled = false;
let lastObservedSocket = null;
let hasBeenConnected = false;
let pendingResync = false;

function rebuild() {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
        rebuildTimer = null;
        doRebuild();
    }, 50);
}

function fireReconnectListeners() {
    reconnectListeners.forEach((cb, id) => {
        try {
            cb();
        } catch (err) {
            console.error('[realtimeBus] onReconnect handler error (subscriptionId=%s):', id, err);
        }
    });
}

function handleSocketOpen() {
    // Csak a reconnect-et jelezzük — az első sikeres kapcsolódást NEM,
    // különben a fogyasztó mount-effect-jének fetch-jét megduplázná.
    if (hasBeenConnected && pendingResync) {
        pendingResync = false;
        fireReconnectListeners();
    }
    hasBeenConnected = true;
}

function handleSocketClose() {
    // Csak akkor jelöljük rá a "resync szükséges" flag-et, ha már egyszer
    // megnyílt a WS — különben a kezdeti kapcsolódási kísérlet közbeni
    // sikertelen close-ok hamisan reconnect-et jelenetnének az első open-nél.
    if (hasBeenConnected) pendingResync = true;
}

/**
 * Az Appwrite Web SDK 24.1.1 nem tesz közzé `onReconnect` callback-et a
 * publikus subscribe API-n, és a `subscribe()` szinkron unsubscribe
 * függvényt ad (nem promise-t, ahogy a feladatleírás feltételezte). Az
 * egyetlen alacsony szintű hookpont a `client.realtime.socket` WebSocket
 * instance-en az `open`/`close` event — viszont ez a socket minden
 * reconnect-nél új instance, így nem elég egyszer feliratkozni. Az SDK
 * `client.realtime.createSocket()` függvény az egyetlen hely, ahol a
 * socket cseréje kontrollálva történik (a close-handler is innen hív
 * újra reconnect után). Ezt egyszer monkey-patcheljük, hogy minden új
 * socket példányra felaggassuk a saját listener-einket.
 *
 * Idempotens: csak az első bus rebuild fut le. Védve van az SDK upgrade
 * ellen is — ha a `realtime.createSocket` API eltűnik, csak warn-t logolunk
 * és a reconnect-detection inaktív marad (a meglévő subscribe továbbra is
 * működik).
 */
function installSocketHook() {
    if (socketHookInstalled) return;
    socketHookInstalled = true;

    const realtime = getClient()?.realtime;
    if (!realtime || typeof realtime.createSocket !== 'function') {
        console.warn('[realtimeBus] Appwrite SDK realtime API nem elérhető — reconnect detection inaktív');
        return;
    }

    const original = realtime.createSocket;
    realtime.createSocket = function patchedCreateSocket(...args) {
        const result = original.apply(this, args);
        try {
            const socket = realtime.socket;
            // A SDK `createSocket()` no-op-pá válik, ha az URL nem változott
            // és a socket még OPEN — ilyenkor a `realtime.socket` ugyanaz a
            // példány, amire már aggattunk listener-t. A duplikációt elkerüljük
            // a `lastObservedSocket` referencia-összevetéssel.
            if (socket && socket !== lastObservedSocket) {
                lastObservedSocket = socket;
                socket.addEventListener('open', handleSocketOpen);
                socket.addEventListener('close', handleSocketClose);
            }
        } catch (err) {
            console.error('[realtimeBus] socket hook hiba:', err);
        }
        return result;
    };
}

function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

function doRebuild() {
    // Az első aktív feliratkozáskor felaggatjuk a reconnect-detect hookot.
    // Itt biztosan van legalább egy handler, így a `client.subscribe()` hívás
    // a `realtime.connect()`-en keresztül létrehozza a socket-et, és a
    // wrapper `createSocket` aggatja rá a listener-eket.
    installSocketHook();

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
 * @param {{ onReconnect?: () => void }} [options]
 *        `onReconnect`: opcionális, a WS sikeres ÚJRAkapcsolódásakor (nem az
 *        első kapcsolódáskor) hívódik. Tipikus használat: a fogyasztó cache-ének
 *        invalidálása + adatok újratöltése, hogy a disconnect-ablakban érkezett
 *        szerver-mutációk ne maradjanak észrevétlenül a kliensen. A callback
 *        a unsubscribe-bal együtt automatikusan eltávolítódik.
 * @returns {() => void} — unsubscribe függvény
 */
export function subscribeRealtime(channels, callback, options) {
    const list = Array.isArray(channels) ? channels : [channels];
    const id = nextId++;
    handlers.set(id, { channels: new Set(list), callback });
    const onReconnect = options?.onReconnect;
    if (typeof onReconnect === 'function') {
        reconnectListeners.set(id, onReconnect);
    }
    rebuild();
    return () => {
        handlers.delete(id);
        reconnectListeners.delete(id);
        rebuild();
    };
}
