/**
 * @file realtimeClient.js
 * @description Appwrite Realtime WebSocket kliens az Adobe UXP környezethez.
 *
 * Fő felelősségek:
 * - Egyedi WebSocket implementáció a UXP platform korlátozásainak megkerülésére
 *   (cookie/header injekció query paramétereken + proxy-n keresztül)
 * - Csatorna-alapú feliratkozás kezelés (subscribe/unsubscribe)
 * - Kapcsolat-állapot figyelés és értesítés (connectionListeners)
 * - Szerverhiba ellenállóképesség: exponenciális backoff és cooldown mechanizmus
 * - Ghost socket védelem generáció-számlálóval
 * - Kényszerített újracsatlakozás (reconnect) alvás/hálózatkimaradás után
 * - Graceful shutdown (disconnect) a plugin leállásakor
 * - Singleton minta hot-reload támogatással (window.__maestroRealtimeInstance)
 *
 * UXP sajátosságok:
 * A UXP WebSocket API nem támogatja a cookie-k és custom headerek küldését
 * a handshake során. Ezért az auth adatokat URL query paraméterként küldjük,
 * és a proxy szerver (Railway / emago.hu) injektálja őket szabványos HTTP
 * headerekként az Appwrite felé.
 *
 * @see docs/REALTIME_ARCHITECTURE.md — Részletes architektúra és auth bridge leírás
 * @see src/core/config/recoveryManager.js — Központi recovery orchestrator
 * @see docs/PROXY_SERVER.md — Proxy szerver implementáció
 */
import { Client, Realtime, Query as AppwriteQuery } from "appwrite";
import { log, logError, logWarn, logDebug } from "../utils/logger.js";
import { MaestroEvent, dispatchMaestroEvent } from "./maestroEvents.js";
// MEGJEGYZÉS: A `client as mainClient` import cirkuláris függőséget hoz létre
// (appwriteConfig.js → realtimeClient.js ← appwriteConfig.js), de ez biztonságos,
// mert a `mainClient`-et csak az `_initClient()` metódusban használjuk, amely
// a konstruktor végén hívódik — addigra az appwriteConfig.js modul-szintű
// inicializálása már lefutott, és a `client` objektum elérhető.
import {
    APPWRITE_PROJECT_ID,
    APPWRITE_LOCALE,
    endpointManager,
    client as mainClient
} from "./appwriteConfig.js";

import { ID } from "appwrite";
import { REALTIME_CONFIG } from "../utils/constants.js";

/**
 * Appwrite Realtime WebSocket kliens, amely kezeli a valós idejű adatszinkronizációt
 * az Adobe UXP környezetben.
 *
 * Singleton mintát alkalmaz: egyetlen globális példány él a `window.__maestroRealtimeInstance`-ban.
 * Hot-reload esetén az előző példány automatikusan lekapcsolódik a duplikált kapcsolatok
 * megelőzésére.
 *
 * A szabványos Appwrite SDK `createSocket` metódusát felülírja egy egyedi implementációval,
 * amely query paramétereken keresztül küldi az auth adatokat a proxy szervernek.
 *
 * @class RealtimeClient
 */
class RealtimeClient {
    /**
     * Inicializálja a RealtimeClient példányt.
     *
     * Létrehozza a belső állapotkezelő struktúrákat:
     * - `subscriptions` (Map): Csatorna → leiratkozó függvény (vagy null, ha a feliratkozás folyamatban van)
     * - `callbacks` (Map): Csatorna → callback Set (a feliratkozók által regisztrált függvények)
     * - `connectionListeners` (Set): Kapcsolat-állapot változás figyelők
     * - `errorListeners` (Set): Hiba figyelők
     *
     * Kliens ID: Perzisztens egyedi azonosító (`localStorage`), amely az egyidejűség-kezeléshez
     * (concurrency control) szükséges. Újratöltések között megmarad.
     *
     * Azonnal meghívja az `_initClient()` metódust az Appwrite kliens és a WebSocket
     * kapcsolat inicializálásához.
     */
    constructor() {
        this.subscriptions = new Map();
        this.callbacks = new Map();
        this.connectionListeners = new Set();
        this.errorListeners = new Set();
        
        this.isConnected = false;
        this.lastError = null;
        this.lastActivity = Date.now();
        this.isReconnecting = false; // Párhuzamos reconnect() és close-handler backoff közös guardja
        // reconnect() rebuild alatt az open-time auto-notify-t a sub-pass utáni értékelésre halasztjuk.
        this._suppressOpenNotify = false;
        this.lastDisconnectTime = null; // Debug: időmérés szakadások közt

        // Szerver hiba kezelés: exponenciális backoff és cooldown
        this.consecutiveServerErrors = 0;
        this.serverErrorCooldownUntil = 0;
        this.MAX_CONSECUTIVE_SERVER_ERRORS = REALTIME_CONFIG.MAX_CONSECUTIVE_SERVER_ERRORS;
        this.SERVER_ERROR_BACKOFF_BASE_MS = REALTIME_CONFIG.SERVER_ERROR_BACKOFF_BASE_MS;

        // Unique Client ID for Concurrency Control
        // Persist across reloads to maintain identity
        if (typeof window !== 'undefined') {
            this.clientId = localStorage.getItem('maestro.clientId');
            if (!this.clientId) {
                this.clientId = ID.unique();
                localStorage.setItem('maestro.clientId', this.clientId);
            }
        } else {
            this.clientId = ID.unique(); // Fallback for non-browser env
        }
        
        logDebug(`[Realtime] [ID] Client ID: ${this.clientId}`);

        // Isolated Appwrite instance
        this.client = null;
        this.realtime = null;

        // Initialize immediately
        this.shouldReconnect = true;
        this._subscribedChannels = new Set(); // Nyomon követi, mely csatornák vannak az aktív socket-ben
        this._initClient();
    }

    /**
     * Friss Appwrite Client és Realtime példányt inicializál.
     *
     * Lépései:
     * 1. Új `Client` példány létrehozása az aktuális endpoint-tal (`endpointManager.getEndpoint()`)
     * 2. UXP-specifikus platform header beállítása (`X-Appwrite-Package-Name`)
     * 3. Session cookie injektálása a `localStorage` `cookieFallback` kulcsából
     *    (a UXP nem kezeli automatikusan a cookie-kat)
     * 4. `Realtime` példány létrehozása a kliensből
     * 5. A `createSocket` metódus felülírása egyedi WebSocket implementációval,
     *    amely query paramétereken keresztül küldi az auth adatokat a proxy-nak
     *
     * @private
     */
    _initClient() {
        logDebug('[Realtime] [INIT] Initializing isolated Client instance...');
        
        this.client = new Client()
            .setEndpoint(endpointManager.getEndpoint())
            .setProject(APPWRITE_PROJECT_ID)
            .setLocale(APPWRITE_LOCALE);

        // UXP környezetben a platform beállítása nem működik a setPlatform() metódussal,
        // ezért kézzel állítjuk be a fejlécet, hogy a szerver azonosítani tudja az alkalmazást.
        this.client.headers['X-Appwrite-Package-Name'] = "com.sashalmiimre.maestro";

        // Cookie fallback injectálása a Realtime kliensbe is
        // Ez kritikus, mert az elkülönített kliens nem kapja meg a main ablakban
        // globálisan patchelt fetch beállításokat.    
        if (typeof window !== 'undefined') {
            try {
                const cookieFallback = window.localStorage.getItem('cookieFallback');
                logDebug(`[Realtime] Project ID: ${APPWRITE_PROJECT_ID}`);
                logDebug(`[Realtime] Raw cookieFallback: ${cookieFallback ? 'FOUND' : 'MISSING'}`);

                if (cookieFallback) {
                    this.client.headers['X-Fallback-Cookies'] = cookieFallback;
                    
                    // Verify key match for SDK internal logic
                    const cookies = JSON.parse(cookieFallback);
                    const expectedKey = `a_session_${APPWRITE_PROJECT_ID}`;
                    if (cookies[expectedKey]) {
                        log(`[Realtime] [OK] Found valid session key: ${expectedKey}`);
                    } else {
                        logWarn(`[Realtime] [WARN] Session key missing! Expected: ${expectedKey}, Keys found: ${Object.keys(cookies).join(', ')}`);

                        // Fallback: a fő kliens headeréből próbáljuk visszaállítani a session-t.
                        // A fő kliens (appwriteConfig.js) a monkey-patched fetch-en keresztül
                        // a set-cookie headerekből frissíti a saját X-Fallback-Cookies fejlécét,
                        // ami tartalmazhatja az érvényes tokent akkor is, ha a localStorage elveszett.
                        try {
                            const mainCookies = JSON.parse(mainClient.headers['X-Fallback-Cookies'] || '{}');
                            if (mainCookies[expectedKey]) {
                                log('[Realtime] [RECOVERY] Session key visszaállítva a fő kliensből');
                                cookies[expectedKey] = mainCookies[expectedKey];
                                const restored = JSON.stringify(cookies);
                                window.localStorage.setItem('cookieFallback', restored);
                                // A friss cookieFallback-et alkalmazzuk erre a kliensre is
                                this.client.headers['X-Fallback-Cookies'] = restored;
                            }
                        } catch (e) {
                            logDebug('[Realtime] [RECOVERY] Fő kliens session fallback sikertelen:', e);
                        }
                    }

                    logDebug('[Realtime] [COOKIE] Session cookies injected');
                } else {
                    logWarn('[Realtime] [WARN] No session cookies found in localStorage');
                }
            } catch (e) {
                logError('[Realtime] Failed to inject cookies:', e);
            }
        }
            
        this.realtime = new Realtime(this.client);

        // Az Appwrite SDK createSocket felülírása UXP-specifikus WebSocket implementációval.
        // A részletes logika a privát metódusokban: _buildSocketUrl, _handleSocketOpen,
        // _handleSocketMessage, _handleSocketClose.
        this.realtime.createSocket = () => {
            const { url, session, channelArray } = this._buildSocketUrl();

            return new Promise((resolve) => {
                // Ellenőrizzük, hogy vannak-e új csatornák az aktív socket-hez képest
                const hasNewChannels = channelArray.some(ch => !this._subscribedChannels.has(ch));

                if (this.realtime.socket && (this.realtime.socket.readyState === WebSocket.CONNECTING || this.realtime.socket.readyState === WebSocket.OPEN)) {
                    if (!hasNewChannels) {
                        resolve();
                        return;
                    }
                    // Új csatornák vannak — zárjuk le a régit és építsünk újat
                    log(`[Realtime] [SYNC] Új csatornák észlelve, socket újraépítése (${channelArray.length} csatorna)...`);
                    try {
                        this.realtime.stopHeartbeat();
                        this.realtime.socket.close(1000, 'channel-update');
                    } catch (e) { /* ignore */ }
                }

                // Socket generáció növelése — CSAK ha tényleg új socketet hozunk létre.
                // A close handler ezzel ellenőrzi, hogy az aktuális socket-hez tartozik-e az esemény.
                this._socketGeneration = (this._socketGeneration || 0) + 1;
                const myGeneration = this._socketGeneration;

                this._subscribedChannels = new Set(channelArray);
                this.realtime.socket = new WebSocket(url);

                this.realtime.socket.addEventListener('open', () => this._handleSocketOpen(session, resolve));
                this.realtime.socket.addEventListener('message', (event) => this._handleSocketMessage(event));
                this.realtime.socket.addEventListener('close', (event) => this._handleSocketClose(event, myGeneration));
                this.realtime.socket.addEventListener('error', () => {
                    // Az 'error' után általában jön 'close' is, ott kezeljük az újrakapcsolódást.
                });
            });
        };
    }

    /**
     * Összeállítja a WebSocket URL-t az auth és csatorna paraméterekkel.
     *
     * Az Appwrite v24 activeSubscriptions Map-ből kinyeri a csatornákat,
     * per-slot query paramétereket épít (event routing-hoz szükséges),
     * és az auth adatokat query paraméterként fűzi hozzá (UXP proxy injection).
     *
     * @returns {{ url: string, session: string|null, channelArray: string[] }}
     * @private
     */
    _buildSocketUrl() {
        const allChannels = new Set();
        for (const sub of this.realtime.activeSubscriptions.values()) {
            for (const ch of sub.channels) {
                allChannels.add(ch);
            }
        }
        const channelArray = Array.from(allChannels);
        const query = new URLSearchParams();
        query.append('project', this.client.config.project);
        channelArray.forEach(ch => query.append('channels[]', ch));

        // v24 per-slot query paraméterek — a szerver ezek alapján rendeli hozzá
        // a subscription ID-kat a slotokhoz, amelyeket a handleResponseConnected()
        // eltárol, és a handleResponseEvent() az event routing-hoz használ.
        const selectAllQuery = AppwriteQuery.select(['*']).toString();
        for (const [slot, subscription] of this.realtime.activeSubscriptions) {
            const queries = subscription.queries.length === 0
                ? [selectAllQuery]
                : subscription.queries;
            for (const channel of subscription.channels) {
                for (const q of queries) {
                    query.append(`${channel}[${slot}][]`, q);
                }
            }
        }

        query.append('x-appwrite-package-name', "com.sashalmiimre.maestro");

        // Cookie fallback olvasása — session token kinyerése az auth frame-hez
        let session = null;
        try {
            if (typeof window !== 'undefined') {
                const cookieFallback = window.localStorage.getItem('cookieFallback');
                if (cookieFallback) {
                    query.append('x-fallback-cookies', cookieFallback);
                    const cookies = JSON.parse(cookieFallback);
                    session = cookies[`a_session_${this.client.config.project}`];
                }
            }
        } catch (e) {
            logError('[Realtime] Cookie read error:', e);
        }

        const url = this.client.config.endpointRealtime + '/realtime?' + query.toString();
        return { url, session, channelArray };
    }

    /**
     * Socket open event handler — auth frame küldés és heartbeat indítás.
     *
     * UXP sajátosság: a readyState nem mindig OPEN az open event-ben,
     * ezért 200ms retry-t alkalmazunk, ha az azonnali küldés nem lehetséges.
     *
     * @param {string|null} session - Session token (null ha nincs bejelentkezve)
     * @param {function} resolve - A createSocket Promise resolve függvénye
     * @private
     */
    _handleSocketOpen(session, resolve) {
        const socket = this.realtime.socket;
        logDebug('[Realtime] [OPEN] Socket Open');

        if (session) {
            const authData = JSON.stringify({
                type: 'authentication',
                data: { session }
            });

            logDebug('[Realtime] [AUTH] Sending auth frame...');

            // UXP WebSocket timing guard: readyState may not be OPEN yet
            if (socket.readyState === WebSocket.OPEN) {
                try {
                    socket.send(authData);
                } catch (err) {
                    logError('[Realtime] [FAIL] Auth frame send failed (immediate):', err);
                }
            } else {
                logWarn(`[Realtime] [WAIT] Socket not ready (state=${socket.readyState}), retrying in 200ms...`);
                setTimeout(() => {
                    if (socket.readyState === WebSocket.OPEN) {
                        try {
                            socket.send(authData);
                            logDebug('[Realtime] [AUTH] Auth frame sent after retry');
                        } catch (err) {
                            logError('[Realtime] [FAIL] Auth frame send failed (retry):', err);
                        }
                    } else {
                        logError('[Realtime] [FAIL] Socket still not ready after retry, skipping auth frame');
                    }
                }, REALTIME_CONFIG.AUTH_RETRY_DELAY_MS);
            }
        }

        this.realtime.reconnectAttempts = 0;
        this.realtime.onOpenCallbacks.forEach(callback => callback());
        this.realtime.startHeartbeat();

        // Reconnect() rebuild alatt a sikert a sub-pass dönti el — ne villanjon
        // fel hamis connected az allFailed előtt.
        if (!this._suppressOpenNotify) {
            this._notifyConnectionChange(true);
        }

        resolve();
    }

    /**
     * Socket message event handler — szerverhiba nyomkövetés és SDK delegálás.
     *
     * A szerver error üzenetek számlálóját kezeli, és küszöb elérésekor
     * cooldown-t aktivál. Sikeres adat esemény nullázza a számlálót.
     * Végül a nyers üzenetet az Appwrite SDK handleMessage-nek delegálja.
     *
     * @param {MessageEvent} event - A WebSocket message event
     * @private
     */
    _handleSocketMessage(event) {
        try {
            const message = JSON.parse(event.data);

            if (message.type === 'error') {
                const errorCode = message.data?.code;
                this.consecutiveServerErrors++;
                logError(
                    `[Realtime] [FAIL] Server Error (${this.consecutiveServerErrors}/${this.MAX_CONSECUTIVE_SERVER_ERRORS}):`,
                    message.data
                );

                if (this.consecutiveServerErrors >= this.MAX_CONSECUTIVE_SERVER_ERRORS) {
                    const cooldownMs = REALTIME_CONFIG.COOLDOWN_MS;
                    this.serverErrorCooldownUntil = Date.now() + cooldownMs;
                    logWarn(
                        `[Realtime] [PAUSE] Szerver hiba cooldown aktiválva (${cooldownMs / 1000}s). ` +
                        `${this.consecutiveServerErrors} egymás utáni hiba.`
                    );
                    this._notifyError({
                        message: `Appwrite szerver ismétlődő hiba (code: ${errorCode}). Újrapróbálkozás ${cooldownMs / 1000} másodperc múlva.`,
                        code: errorCode,
                        cooldownUntil: this.serverErrorCooldownUntil
                    });
                }
            } else if (message.type === 'event') {
                if (this.consecutiveServerErrors > 0) {
                    log(`[Realtime] [OK] Szerver hiba számláló nullázva (volt: ${this.consecutiveServerErrors})`);
                    this.consecutiveServerErrors = 0;
                    this.serverErrorCooldownUntil = 0;
                }
            }

            this.realtime.handleMessage(message);
        } catch (error) {
            // parse error — ignorálva
        }
    }

    /**
     * Socket close event handler — close code alapú döntés és reconnect logika.
     *
     * Ghost socket védelem: a generáció-számláló biztosítja, hogy régi socket-ek
     * close event-jei ne indítsanak felesleges reconnect ciklust.
     *
     * Close kód stratégia:
     * - 1000 (Normal): szándékos lezárás, nincs reconnect
     * - 1001 (Going Away): alkalmazás bezárul, reconnect mellőzve
     * - 1005/1006 (No Status / Abnormal): halott TCP → RecoveryManager-re bízva
     * - 1008 (Policy Violation): auth hiba → backoff-fal kezelt reconnect
     * - Egyéb: exponenciális backoff vagy SDK timeout
     *
     * @param {CloseEvent} event - A WebSocket close event
     * @param {number} myGeneration - A socket generáció-számlálója (ghost védelem)
     * @private
     */
    async _handleSocketClose(event, myGeneration) {
        // Ghost socket védelem
        if (myGeneration !== this._socketGeneration) {
            logDebug(`[Realtime] [GHOST] Régi socket close (gen ${myGeneration} vs ${this._socketGeneration}), ignorálva`);
            return;
        }

        log(`[Realtime] [CLOSED] Code=${event.code} Reason=${event.reason}`);
        this.realtime?.stopHeartbeat();
        this.realtime?.onCloseCallbacks?.forEach(callback => callback());

        // Debug: Időmérés szakadások között
        const now = Date.now();
        if (this.lastDisconnectTime) {
            const diffSec = ((now - this.lastDisconnectTime) / 1000).toFixed(1);
            logDebug(`[Realtime] [TIMER] Idő az előző szakadás óta: ${diffSec} másodperc`);
        } else {
            logDebug(`[Realtime] [TIMER] Első szakadás mérése indítva`);
        }
        this.lastDisconnectTime = now;

        if (!this.shouldReconnect) {
            logDebug('[Realtime] [STOP] Szándékos lecsatlakozás. Reconnect loop leállítva.');
            return;
        }

        // 1000 (Normal Closure) → szándékos lezárás
        if (event.code === 1000) {
            if (this.realtime) this.realtime.reconnect = true;
            return;
        }

        // 1001 (Going Away) → alkalmazás bezárul
        if (event.code === 1001) {
            log('[Realtime] [EXIT] Going Away (1001) — alkalmazás bezárása, reconnect mellőzve');
            return;
        }

        this._notifyConnectionChange(false);

        // 1005/1006 — halott TCP, RecoveryManager-re bízva
        if (event.code === 1005 || event.code === 1006) {
            log(`[Realtime] [SLEEP] Halott kapcsolat (${event.code}) — RecoveryManager-re bízva`);
            return;
        }

        // 1008 (Policy Violation) → auth probléma, backoff-fal
        if (event.code === 1008) {
            this.consecutiveServerErrors++;
            logWarn(
                `[Realtime] [WARN] Policy Violation (1008) - lehetséges auth hiba ` +
                `(${this.consecutiveServerErrors}/${this.MAX_CONSECUTIVE_SERVER_ERRORS})`
            );
            this.realtime.reconnect = true;
        }

        if (!this.realtime.reconnect) {
            this.realtime.reconnect = true;
            return;
        }

        // Cooldown ellenőrzése szerver hibák után
        if (this.serverErrorCooldownUntil > Date.now()) {
            const remainingMs = this.serverErrorCooldownUntil - Date.now();
            log(`[Realtime] [PAUSE] Cooldown aktív, várakozás ${Math.ceil(remainingMs / 1000)}s...`);
            await this.realtime.sleep(remainingMs);
            if (!this.realtime || !this.shouldReconnect) return;
            this.consecutiveServerErrors = 0;
            this.serverErrorCooldownUntil = 0;
        }

        // Exponenciális backoff szerver hibák alapján
        let timeout;
        if (this.consecutiveServerErrors > 0) {
            timeout = this._getServerErrorBackoff();
            log(
                `[Realtime] [WAIT] Server error backoff: ${timeout / 1000}s ` +
                `(${this.consecutiveServerErrors} egymás utáni hiba)`
            );
        } else {
            timeout = this.realtime.getTimeout();
        }

        log(`[Realtime] Reconnecting in ${timeout / 1000}s...`);
        await this.realtime.sleep(timeout);
        if (!this.realtime || !this.shouldReconnect) return;

        // Közös guard a reconnect()-tel: ha a RecoveryManager közben elindított
        // egy teljes újraépítést (destroy & rebuild), ne fusson párhuzamosan
        // a close-handler backoff ciklusa — a reconnect() mindent átvesz.
        if (this.isReconnecting) {
            log('[Realtime] [SKIP] reconnect() folyamatban — close-handler backoff kihagyva');
            return;
        }

        this.isReconnecting = true;
        this.realtime.reconnectAttempts++;
        try {
            await this.realtime.createSocket();
        } catch (error) {
            logError('[Realtime] Reconnect failed:', error);
        } finally {
            this.isReconnecting = false;
        }
    }

    /**
     * Kapcsolat-állapot változás figyelő regisztrálása.
     *
     * A callback azonnal meghívódik az aktuális állapottal (`isConnected`),
     * majd minden későbbi állapotváltozáskor is.
     *
     * @param {function(boolean): void} callback - Figyelő függvény, `true` ha kapcsolódva, `false` ha nem
     * @returns {function(): void} Leiratkozó függvény — meghívásával a figyelő eltávolítható
     */
    onConnectionChange(callback) {
        this.connectionListeners.add(callback);
        callback(this.isConnected);
        return () => this.connectionListeners.delete(callback);
    }

    /**
     * Hiba figyelő regisztrálása.
     *
     * A callback minden Realtime hibánál meghívódik (szerverhiba, feliratkozási hiba stb.).
     *
     * @param {function(Object): void} callback - Figyelő függvény, a hiba objektummal hívva
     * @returns {function(): void} Leiratkozó függvény
     */
    onError(callback) {
        this.errorListeners.add(callback);
        return () => this.errorListeners.delete(callback);
    }

    /**
     * Értesíti a kapcsolat-állapot figyelőket, ha az állapot ténylegesen megváltozott.
     *
     * Deduplikáció: csak akkor hív callback-eket, ha a `connected` paraméter
     * eltér az aktuális `isConnected` állapottól.
     *
     * @param {boolean} connected - Az új kapcsolat-állapot
     * @private
     */
    _notifyConnectionChange(connected) {
        if (this.isConnected !== connected) {
            this.isConnected = connected;
            if (process.env.NODE_ENV !== 'production') {
                log(`[Realtime] ${connected ? '[OK] Connected' : '[FAIL] Disconnected'}`);
            }
            this.connectionListeners.forEach(cb => {
                try { cb(connected); } catch (e) { logError(e); }
            });
        }
    }

    /**
     * Értesíti a hiba figyelőket egy Realtime hibáról.
     *
     * Tárolja az utolsó hibát (`lastError`), logolja, majd meghívja az összes
     * regisztrált error listener-t.
     *
     * @param {Object} error - A hiba objektum (message, code, és opcionálisan cooldownUntil)
     * @private
     */
    _notifyError(error) {
        this.lastError = error;
        logError("[Realtime] Error:", error);
        this.errorListeners.forEach(cb => {
            try { cb(error); } catch (e) { logError(e); }
        });
    }

    /**
     * SDK-szintű feliratkozást indít a megadott csatornára.
     *
     * Ha a csatornára már van aktív feliratkozás, nem csinál semmit (idempotens).
     * A dupla feliratkozás megelőzésére `null` placeholder-t helyez a `subscriptions` Map-be
     * az async setup idejére.
     *
     * Sikeres feliratkozás után a `subscriptions` Map-ben a csatornához a `close()` wrapper
     * függvény kerül. Ha közben `disconnect()` törölte a csatornát, az újonnan létrehozott
     * feliratkozás azonnal lezárul.
     *
     * @param {string} channel - Az Appwrite Realtime csatorna neve
     * @returns {Promise<boolean>} true ha sikeres, false ha sikertelen
     * @private
     */
    async _attemptSdkSubscription(channel) {
        if (this.subscriptions.has(channel)) return true;

        // Ensure we have a valid instance
        if (!this.realtime) this._initClient();

        if (process.env.NODE_ENV !== 'production') {
            log(`[Realtime] [SUB] Subscribing: ${channel}`);
        }

        // Null placeholder: megakadályozza a dupla feliratkozást az async setup közben
        this.subscriptions.set(channel, null);

        try {
            // Az Appwrite Realtime.subscribe() async — tároljuk a visszatérő close() funkciót
            const sub = await this.realtime.subscribe(channel, (response) => {
                this._notifyConnectionChange(true);
                this.lastActivity = Date.now();

                // Callback-ek meghívása
                // Megjegyzés: A végtelen ciklusokat az adatok összehasonlítása akadályozza meg
                // (a validátorok csak akkor írnak, ha eltérés van)
                if (this.callbacks.has(channel)) {
                    this.callbacks.get(channel).forEach(cb => {
                        try { cb(response); } catch (e) { logError(e); }
                    });
                }
            });

            if (!this.subscriptions.has(channel)) {
                // disconnect() törölte közben — azonnal lezárjuk
                try { sub.close().catch(() => {}); } catch (_) {}
                return;
            }

            // close() async — a .catch() biztosítja, hogy ne legyen unhandled rejection
            this.subscriptions.set(channel, () => sub.close().catch(() => {}));
            this._notifyConnectionChange(true);
            return true;

        } catch (err) {
            logError(`[Realtime] Subscription failed: ${channel}`, err);
            this._notifyError(err);
            this._notifyConnectionChange(false);
            this.subscriptions.delete(channel);  // placeholder törlése hiba esetén
            return false;
        }
    }

    /**
     * Feliratkozás egy Appwrite Realtime csatornára.
     *
     * Ha a csatornára még nincs aktív SDK feliratkozás, automatikusan elindítja
     * (`_attemptSdkSubscription`). Több callback is regisztrálható ugyanarra a csatornára —
     * mindegyik megkapja a bejövő Realtime eseményeket.
     *
     * @param {string} channel - Appwrite Realtime csatorna (pl. `databases.{dbId}.collections.{collId}.documents`)
     * @param {function(Object): void} callback - Eseménykezelő függvény, az Appwrite Realtime válasszal hívva
     * @returns {function(): void} Leiratkozó függvény — meghívásával a callback eltávolítható
     *   (ha ez volt az utolsó callback a csatornán, az SDK feliratkozás is lezárul)
     */
    subscribe(channel, callback) {
        if (!this.callbacks.has(channel)) {
            this.callbacks.set(channel, new Set());
        }
        this.callbacks.get(channel).add(callback);

        if (!this.subscriptions.has(channel)) {
            this._attemptSdkSubscription(channel);
        }

        return () => this.unsubscribe(channel, callback);
    }

    /**
     * Leiratkozás egy Appwrite Realtime csatornáról.
     *
     * Eltávolítja a megadott callback-et a csatorna figyelőiből. Ha ez volt az utolsó
     * callback a csatornán, az SDK feliratkozás is lezárul (a `close()` wrapper meghívásával),
     * és a csatorna törlődik a belső nyilvántartásból.
     *
     * @param {string} channel - Az Appwrite Realtime csatorna neve
     * @param {function(Object): void} callback - Az eltávolítandó eseménykezelő függvény
     */
    unsubscribe(channel, callback) {
        if (this.callbacks.has(channel)) {
            this.callbacks.get(channel).delete(callback);

            if (this.callbacks.get(channel).size === 0) {
                this.callbacks.delete(channel);
                if (this.subscriptions.has(channel)) {
                    const unsub = this.subscriptions.get(channel);
                    // unsub lehet null (setup folyamatban) vagy close() wrapper funkció
                    if (typeof unsub === "function") {
                        try { unsub(); } catch (e) {}
                    }
                    this.subscriptions.delete(channel);
                }
            }
        }
    }

    /**
     * Kényszerített újracsatlakozás: teljesen megsemmisíti a kapcsolatot és újat épít.
     *
     * Ez kritikus az alvás utáni helyreállításhoz, ahol az OS "nyitva" tartja a halott
     * socketet (TCP half-open állapot). A `RecoveryManager` hívja a health check után.
     *
     * Lépései:
     * 1. Disconnected jelzés a connection listener-eknek
     * 2. Régi WebSocket explicit lezárása (ghost socket bug megelőzése)
     * 3. Feliratkozások leiratkozása (no-op `createSocket`-tel a kaszkád-újraépítés ellen)
     * 4. Appwrite Client és Realtime példány megsemmisítése
     * 5. Szerverhiba számláló nullázása
     * 6. Új kliens inicializálása (`_initClient()`)
     * 7. Korábbi feliratkozások szinkron újraépítése
     * 8. `dataRefreshRequested` MaestroEvent dispatch a REST adat frissítéséhez
     *
     * Védelmek:
     * - `shouldReconnect` flag: `disconnect()` után nem reconnectel
     * - `isReconnecting` flag: közös — a close-handler belső reconnect ciklusa is ezt
     *   figyeli, hogy ne fusson párhuzamosan a `reconnect()`-tel
     *
     * @returns {Promise<{ ok: boolean, attempted: number, failed: number }>}
     *   `ok: true` ha legalább egy subscription sikeres volt (vagy nem volt subscribe
     *   igény). `ok: false` ha mindegyik sikertelen — ilyenkor a RecoveryManager dönt
     *   újrapróba ütemezéséről. Ha a reconnect-et kihagytuk (shutdown / párhuzamos),
     *   `attempted: 0, ok: true` — a hívó nem dolgoz fel kudarcként.
     */
    async reconnect() {
        // Shutdown védelem: disconnect() után ne reconnecteljünk
        if (!this.shouldReconnect) {
            log('[Realtime] [STOP] reconnect() kihagyva — disconnect() már meghívva');
            return { ok: true, attempted: 0, failed: 0 };
        }

        // Párhuzamos reconnect védelem — közös flag a close-handler ciklusával
        if (this.isReconnecting) {
            log('[Realtime] [WAIT] Reconnect már folyamatban, kihagyva');
            return { ok: true, attempted: 0, failed: 0 };
        }

        this.isReconnecting = true;
        this._suppressOpenNotify = true;

        logDebug('[Realtime] [SYNC] FORCE RECONNECT (Destroy & Rebuild)');

        let attempted = 0;
        let failed = 0;
        let threw = false;
        try {
            // 1. Disconnected jelzés
            this._notifyConnectionChange(false);

            // 2. Régi WebSocket explicit lezárása MIELŐTT bármit csinálnánk.
            //    Ez megakadályozza, hogy a régi socket close event-je
            //    a ghost socket bugot okozza (korrupt heartbeat / hamis disconnect).
            if (this.realtime?.socket) {
                try {
                    this.realtime.stopHeartbeat();
                    this.realtime.socket.close(1000, 'reconnect');
                } catch (e) { /* ignore */ }
            }

            // 3. Feliratkozások leiratkozása
            // No-op createSocket: megakadályozza, hogy az unsub() socket-újraépítést indítson
            if (this.realtime) {
                this.realtime.createSocket = () => Promise.resolve();
            }
            this.subscriptions.forEach((unsub) => {
                if (typeof unsub === "function") {
                    try { unsub(); } catch (e) {}
                }
            });
            this.subscriptions.clear();

            // 4. Instance megsemmisítése
            this.realtime = null;
            this.client = null;
            this._subscribedChannels = new Set();

            // Szerver hiba számláló nullázása az újraépítésnél
            this.consecutiveServerErrors = 0;
            this.serverErrorCooldownUntil = 0;

            // 5. Újrainicializálás
            this._initClient();

            // 6. Feliratkozások újraépítése — a hívások szinkron indulnak (nincs setTimeout
            //    delay), de megvárjuk a befejeződésüket, mielőtt az isReconnecting flag-et
            //    false-ra állítanánk. Ez megakadályozza, hogy egy gyors egymás utáni recovery
            //    újabb reconnect()-et indítson a feliratkozások létrejötte előtt.
            const channels = [...this.callbacks.keys()];
            attempted = channels.length;
            if (attempted > 0) {
                logDebug(`[Realtime] [SUB] Rebuilding ${attempted} subscriptions...`);
                const results = await Promise.all(
                    channels.map(ch => this._attemptSdkSubscription(ch))
                );
                failed = results.filter(ok => !ok).length;
                if (failed > 0) {
                    logWarn(`[Realtime] [WARN] ${failed}/${attempted} feliratkozás sikertelen az újraépítéskor`);
                }
            }
        } catch (error) {
            logError('[Realtime] Reconnect hiba:', error);
            threw = true;
        } finally {
            this.isReconnecting = false;
            this._suppressOpenNotify = false;
        }

        // Ha a try blokk exception-nel szállt ki (pl. _initClient vagy _attemptSdkSubscription),
        // a Realtime rendszer nem lett felépítve. Ne dispatcheljünk dataRefreshRequested-et:
        // az overlay-t megtévesztő módon eltüntetné, miközben nincs WS.
        if (threw) {
            this._notifyConnectionChange(false);
            this._notifyError({
                message: 'Reconnect hiba — a Realtime kapcsolat nem épült újra.',
                code: 'reconnect_exception'
            });
            return { ok: false, attempted, failed };
        }

        // Ha volt subscribe igény és MIND elbukott, a kapcsolat él, de eseményt nem kap.
        const allFailed = attempted > 0 && failed === attempted;
        if (allFailed) {
            this._notifyConnectionChange(false);
            this._notifyError({
                message: 'A Realtime feliratkozások újraépítése sikertelen — kapcsolat él, de nem kap eseményeket.',
                code: 'reconnect_all_failed'
            });
            // Nincs dataRefreshRequested: ha semmi nincs feliratkozva, egy sikeres
            // REST fetch csak megtévesztő healthy UI-t mutatna, miközben nincs Realtime.
            return { ok: false, attempted, failed };
        }

        if (this.realtime?.socket?.readyState === WebSocket.OPEN) {
            this._notifyConnectionChange(true);
        }

        // Adat frissítés jelzése: csak ha legalább egy sub él (vagy nem volt mit újraépíteni).
        if (typeof window !== 'undefined') {
            logDebug('[Realtime] [SYNC] Dispatching data refresh after reconnect');
            dispatchMaestroEvent(MaestroEvent.dataRefreshRequested);
        }

        return { ok: true, attempted, failed };
    }

    /**
     * Graceful shutdown: véglegesen lekapcsolja a Realtime klienst.
     *
     * A plugin leállásakor (`window.unload`) hívódik. Lépései:
     * 1. `shouldReconnect = false` — megakadályozza a jövőbeli reconnect kísérleteket
     * 2. No-op `createSocket` beállítása (az SDK close/unsubscribe callback-jei ne
     *    indítsanak socket-újraépítést a debounce lejárta után)
     * 3. Aktív WebSocket explicit lezárása (1000 kóddal)
     * 4. Összes feliratkozás cleanup (close wrapper funkciók meghívása)
     * 5. Belső állapot nullázása (`isConnected`, `lastActivity`, `realtime`, `client`)
     *
     * Fontos: A `_notifyConnectionChange()` szándékosan NEM hívódik, mert kilépéskor
     * nem akarunk recovery-t triggerelni a connection listener-eken keresztül.
     */
    disconnect() {
        this.shouldReconnect = false;

        // Leállítás utáni socket-újraépítési kísérletek megakadályozása.
        // Az Appwrite SDK close/unsubscribe callback-jei createSocket()-ot hívhatnak
        // (pl. a 1ms debounce lejárta után); a no-op csere megelőzi az unhandled rejection-t.
        if (this.realtime) {
            this.realtime.createSocket = () => Promise.resolve();
        }

        // Socket lezárása 1000-es kóddal a cleanup előtt
        if (this.realtime?.socket) {
            try {
                this.realtime.stopHeartbeat();
                this.realtime.socket.close(1000, 'Plugin shutdown');
            } catch (e) { /* ignore */ }
        }

        // Feliratkozások cleanup: close() wrapper funkciók meghívása
        this.subscriptions.forEach((unsub) => {
            if (typeof unsub === "function") {
                try { unsub(); } catch (e) {}
            }
        });
        this.subscriptions.clear();
        this.callbacks.clear();

        // _notifyConnectionChange() helyett közvetlen értékadás:
        // kilépéskor nem akarunk recovery-t triggerelni a connection listener-eken keresztül
        this.isConnected = false;
        this.lastActivity = null;
        this.realtime = null;
        this.client = null;
    }

    /**
     * Kiszámolja a szerver hiba utáni várakozási időt exponenciális backoff-fal.
     * @returns {number} Várakozási idő milliszekundumban (max 60s)
     * @private
     */
    _getServerErrorBackoff() {
        // 5s, 10s, 20s, 40s, max 60s
        const backoff = this.SERVER_ERROR_BACKOFF_BASE_MS * Math.pow(2, this.consecutiveServerErrors - 1);
        return Math.min(backoff, REALTIME_CONFIG.MAX_BACKOFF_MS);
    }

    /** @returns {boolean} Az aktuális kapcsolat állapota (true = kapcsolódva) */
    getConnectionStatus() { return this.isConnected; }

    /** @returns {Object|null} Az utolsó Realtime hiba objektum, vagy null ha nem volt hiba */
    getLastError() { return this.lastError; }

    /** @returns {number|null} Az utolsó Realtime aktivitás időbélyege (Date.now()), vagy null ha lekapcsolódott */
    getLastActivity() { return this.lastActivity; }

    /**
     * Igaz, ha a WebSocket éppen kapcsolódik (CONNECTING) vagy a reconnect()/close-handler
     * backoff éppen újrakapcsolódik. Ilyenkor a startup-fallback NE tépje szét az
     * in-flight socket-et egy felesleges recovery-vel.
     * @returns {boolean}
     */
    isHandshaking() {
        if (this.isReconnecting) return true;
        const sock = this.realtime?.socket;
        return sock?.readyState === WebSocket.CONNECTING;
    }

    /**
     * Van-e aktív feliratkozás (csatorna). A watchdog ennek hiányában nem
     * próbálkozik recovery-vel — nincs mit újraépíteni, a getConnectionStatus()
     * false lenne a végtelenségig.
     * @returns {boolean}
     */
    hasActiveSubscriptions() {
        return this.callbacks.size > 0;
    }

    // Az auto-reconnect loop és a window 'online' listener eltávolítva.
    // A RecoveryManager (recoveryManager.js) központilag kezeli az összes
    // recovery trigger-t (online, sleep, focus, realtime disconnect).
}

/**
 * Globális Singleton Minta UXP / Hot-Reload környezethez.
 *
 * A UXP plugin hot-reload-kor a modul újraértékelődik, ami új `RealtimeClient`
 * példányt hozna létre — duplikált WebSocket kapcsolatokat okozva.
 * Ezért az aktív példányt a `window.__maestroRealtimeInstance`-ban tároljuk,
 * és újratöltéskor az előzőt lekapcsoljuk (`disconnect()`), mielőtt az újat
 * létrehoznánk.
 */
if (typeof window !== 'undefined') {
    if (window.__maestroRealtimeInstance) {
        logDebug('[Realtime] [RELOAD] Cleaning up previous RealtimeClient instance before reload...');
        try {
            window.__maestroRealtimeInstance.disconnect();
        } catch (e) {
            logError('[Realtime] Failed to disconnect previous instance:', e);
        }
    }
}

export const realtime = new RealtimeClient();

// Referencia tárolása a következő újratöltéshez
if (typeof window !== 'undefined') {
    window.__maestroRealtimeInstance = realtime;
}
