import { Client, Realtime } from "appwrite";
import { log, logError, logWarn } from "../utils/logger.js";
import { MaestroEvent, dispatchMaestroEvent } from "./maestroEvents.js";
import { 
    APPWRITE_ENDPOINT, 
    APPWRITE_PROJECT_ID, 
    APPWRITE_LOCALE,
    HEALTH_ENDPOINT 
} from "./appwriteConfig.js";

import { ID } from "appwrite";

class RealtimeClient {
    constructor() {
        this.subscriptions = new Map();
        this.callbacks = new Map();
        this.connectionListeners = new Set();
        this.errorListeners = new Set();
        
        this.isConnected = false;
        this.lastError = null;
        this.lastActivity = Date.now();
        this.isReconnecting = false; // Párhuzamos reconnect() hívások elleni védelem
        this.lastDisconnectTime = null; // Debug: időmérés szakadások közt

        // Szerver hiba kezelés: exponenciális backoff és cooldown
        this.consecutiveServerErrors = 0;
        this.serverErrorCooldownUntil = 0;
        this.MAX_CONSECUTIVE_SERVER_ERRORS = 5;
        this.SERVER_ERROR_BACKOFF_BASE_MS = 5000; // 5s, 10s, 20s, 40s...

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
        
        if (process.env.NODE_ENV !== 'production') {
            log(`[Realtime] 🆔 Client ID: ${this.clientId}`);
        }

        // Isolated Appwrite instance
        this.client = null;
        this.realtime = null;

        // Initialize immediately
        this.shouldReconnect = true;
        this._initClient();
    }

    /**
     * Initializes a fresh Appwrite Client and Realtime instance.
     * This creates a new WebSocket connection pool.
     * @private
     */
    _initClient() {
        if (process.env.NODE_ENV !== 'production') {
            log('[Realtime] 🆕 Initializing isolated Client instance...');
        }
        
        this.client = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
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
                if (process.env.NODE_ENV !== 'production') {
                    log(`[Realtime] Project ID: ${APPWRITE_PROJECT_ID}`);
                    log(`[Realtime] Raw cookieFallback: ${cookieFallback ? 'FOUND' : 'MISSING'}`);
                }

                if (cookieFallback) {
                    this.client.headers['X-Fallback-Cookies'] = cookieFallback;
                    
                    // Verify key match for SDK internal logic
                    const cookies = JSON.parse(cookieFallback);
                    const expectedKey = `a_session_${APPWRITE_PROJECT_ID}`;
                    if (cookies[expectedKey]) {
                        log(`[Realtime] ✅ Found valid session key: ${expectedKey}`);
                    } else {
                        logWarn(`[Realtime] ⚠️ Session key missing! Expected: ${expectedKey}, Keys found: ${Object.keys(cookies).join(', ')}`);
                    }

                    if (process.env.NODE_ENV !== 'production') {
                        log('[Realtime] 🍪 Session cookies injected');
                    }
                } else {
                    logWarn('[Realtime] ⚠️ No session cookies found in localStorage');
                }
            } catch (e) {
                logError('[Realtime] Failed to inject cookies:', e);
            }
        }
            
        this.realtime = new Realtime(this.client);

        // --- CUSTOM WEBSOCKET IMPLEMENTATION FOR UXP ---
        // UXP környezetben a WebSocket nem küldi a cookie-kat és a custom header-öket.
        // Ezért kézzel kell létrehoznunk a socketet és injektálnunk az autentikációt.
        this.realtime.createSocket = () => {
            const channelArray = Array.from(this.realtime.activeChannels);
            const query = new URLSearchParams();
            query.append('project', this.client.config.project);
            channelArray.forEach(ch => query.append('channels[]', ch));
            
            // 1. Auth Query Params (ha a proxy/szerver támogatja)
            query.append('x-appwrite-package-name', "com.sashalmiimre.maestro");
            
            // Cookie fallback olvasása
            let session = null;
            try {
                if (typeof window !== 'undefined') {
                    const cookieFallback = window.localStorage.getItem('cookieFallback');
                    if (cookieFallback) {
                        query.append('x-fallback-cookies', cookieFallback); // Proxy-hoz
                        const cookies = JSON.parse(cookieFallback);
                        session = cookies[`a_session_${this.client.config.project}`];
                    }
                }
            } catch (e) {
                console.error('[Realtime] Cookie read error:', e);
            }

            const url = this.client.config.endpointRealtime + '/realtime?' + query.toString();

            return new Promise((resolve, reject) => {
                // Socket generáció növelése — a close handler ezzel ellenőrzi,
                // hogy az aktuális socket-hez tartozik-e az esemény
                this._socketGeneration = (this._socketGeneration || 0) + 1;
                const myGeneration = this._socketGeneration;

                // Prevent duplicate connections
                if (this.realtime.socket && (this.realtime.socket.readyState === WebSocket.CONNECTING || this.realtime.socket.readyState === WebSocket.OPEN)) {
                    log('[Realtime] ⚠️ Socket already active, skipping creation');
                    resolve();
                    return;
                }

                // Socket létrehozása
                this.realtime.socket = new WebSocket(url);
                
                this.realtime.socket.addEventListener('open', () => {
                    const socket = this.realtime.socket; // Capture local reference
                    if (process.env.NODE_ENV !== 'production') {
                        console.log('[Realtime] 🟢 Socket Open');
                    }
                    
                    // Azonnali autentikációs üzenet (Appwrite natív támogatás)
                    if (session) {
                        const authData = JSON.stringify({
                            type: 'authentication',
                            data: { session }
                        });

                        if (process.env.NODE_ENV !== 'production') {
                            console.log('[Realtime] 🔑 Sending auth frame...');
                        }

                        // UXP WebSocket timing guard: readyState may not be OPEN yet
                        if (socket.readyState === WebSocket.OPEN) {
                            try {
                                socket.send(authData);
                            } catch (err) {
                                console.error('[Realtime] ❌ Auth frame send failed (immediate):', err);
                            }
                        } else {
                            console.warn(`[Realtime] ⏳ Socket not ready (state=${socket.readyState}), retrying in 200ms...`);
                            setTimeout(() => {
                                if (socket.readyState === WebSocket.OPEN) {
                                    try {
                                        socket.send(authData);
                                        console.log('[Realtime] 🔑 Auth frame sent after retry');
                                    } catch (err) {
                                        console.error('[Realtime] ❌ Auth frame send failed (retry):', err);
                                    }
                                } else {
                                    console.error('[Realtime] ❌ Socket still not ready after retry, skipping auth frame');
                                }
                            }, 200);
                        }
                    }

                    this.realtime.reconnectAttempts = 0;
                    this.realtime.onOpenCallbacks.forEach(callback => callback());
                    this.realtime.startHeartbeat();
                    resolve();
                });

                this.realtime.socket.addEventListener('message', (event) => {
                    try {
                        const message = JSON.parse(event.data);

                        if (message.type === 'error') {
                            const errorCode = message.data?.code;
                            this.consecutiveServerErrors++;
                            console.error(
                                `[Realtime] ❌ Server Error (${this.consecutiveServerErrors}/${this.MAX_CONSECUTIVE_SERVER_ERRORS}):`,
                                message.data
                            );

                            // Cooldown aktiválása ha túl sok egymás utáni hiba
                            if (this.consecutiveServerErrors >= this.MAX_CONSECUTIVE_SERVER_ERRORS) {
                                const cooldownMs = 60000; // 1 perc cooldown
                                this.serverErrorCooldownUntil = Date.now() + cooldownMs;
                                logWarn(
                                    `[Realtime] ⏸️ Szerver hiba cooldown aktiválva (${cooldownMs / 1000}s). ` +
                                    `${this.consecutiveServerErrors} egymás utáni hiba.`
                                );
                                this._notifyError({
                                    message: `Appwrite szerver ismétlődő hiba (code: ${errorCode}). Újrapróbálkozás ${cooldownMs / 1000} másodperc múlva.`,
                                    code: errorCode,
                                    cooldownUntil: this.serverErrorCooldownUntil
                                });
                            }
                        } else if (message.type === 'event') {
                            // Sikeres adat esemény → server error számláló nullázása
                            if (this.consecutiveServerErrors > 0) {
                                log(`[Realtime] ✅ Szerver hiba számláló nullázva (volt: ${this.consecutiveServerErrors})`);
                                this.consecutiveServerErrors = 0;
                                this.serverErrorCooldownUntil = 0;
                            }
                        }

                        this.realtime.handleMessage(message);
                    } catch (error) {
                        // ignore parse errors
                    }
                });

                this.realtime.socket.addEventListener('close', async (event) => {
                    // Ghost socket védelem: ha ez a close event egy régi socket-ről jön
                    // (mert közben reconnect() újat hozott létre), ignoráljuk.
                    if (myGeneration !== this._socketGeneration) {
                        console.log(`[Realtime] 👻 Régi socket close (gen ${myGeneration} vs ${this._socketGeneration}), ignorálva`);
                        return;
                    }

                    console.log(`[Realtime] 🔒 Closed: Code=${event.code} Reason=${event.reason}`);
                    this.realtime?.stopHeartbeat();
                    this.realtime.onCloseCallbacks.forEach(callback => callback());

                    // Debug: Időmérés szakadások között
                    const now = Date.now();
                    if (this.lastDisconnectTime) {
                        const diffSec = ((now - this.lastDisconnectTime) / 1000).toFixed(1);
                        console.log(`[Realtime] ⏱️ Idő az előző szakadás óta: ${diffSec} másodperc`);
                    } else {
                        console.log(`[Realtime] ⏱️ Első szakadás mérése indítva`);
                    }
                    this.lastDisconnectTime = now;

                    // Szándékos lecsatlakozás → ne reconnectelj
                    if (!this.shouldReconnect) {
                        if (process.env.NODE_ENV !== 'production') {
                            console.log('[Realtime] 🛑 Szándékos lecsatlakozás. Reconnect loop leállítva.');
                        }
                        return;
                    }

                    // 1000 (Normal Closure) → szándékos lezárás, nem kell reconnect
                    if (event.code === 1000) {
                        this.realtime.reconnect = true;
                        return;
                    }

                    // Disconnected jelzés (UI frissítéshez)
                    this._notifyConnectionChange(false);

                    // 1005 (No Status) → halott TCP (alvás után tipikus)
                    // A RecoveryManager központilag kezeli, NEM indítunk
                    // saját reconnect loop-ot, mert az végtelen ciklust okozna.
                    if (event.code === 1005 || event.code === 1006) {
                        log(`[Realtime] 💤 Halott kapcsolat (${event.code}) — RecoveryManager-re bízva`);
                        // Importálás elkerülése a cirkuláris dependency ellen:
                        // A RecoveryManager figyeli a connectionChange-et,
                        // vagy a Main.jsx IdleTask / afterActivate trigger kezeli.
                        return;
                    }

                    // 1008 (Policy Violation) → auth probléma, backoff-fal kezeljük
                    if (event.code === 1008) {
                        this.consecutiveServerErrors++;
                        logWarn(
                            `[Realtime] ⚠️ Policy Violation (1008) - lehetséges auth hiba ` +
                            `(${this.consecutiveServerErrors}/${this.MAX_CONSECUTIVE_SERVER_ERRORS})`
                        );
                        this.realtime.reconnect = true;
                    }

                    // Ha reconnect nem szükséges, kilépünk
                    if (!this.realtime.reconnect) {
                        this.realtime.reconnect = true;
                        return;
                    }

                    // Cooldown ellenőrzése szerver hibák után
                    if (this.serverErrorCooldownUntil > Date.now()) {
                        const remainingMs = this.serverErrorCooldownUntil - Date.now();
                        console.log(`[Realtime] ⏸️ Cooldown aktív, várakozás ${Math.ceil(remainingMs / 1000)}s...`);
                        await this.realtime.sleep(remainingMs);
                        // Cooldown után nullázzuk a számlálót és újrapróbálkozunk
                        this.consecutiveServerErrors = 0;
                        this.serverErrorCooldownUntil = 0;
                    }

                    // Exponenciális backoff szerver hibák alapján
                    let timeout;
                    if (this.consecutiveServerErrors > 0) {
                        timeout = this._getServerErrorBackoff();
                        console.log(
                            `[Realtime] ⏳ Server error backoff: ${timeout / 1000}s ` +
                            `(${this.consecutiveServerErrors} egymás utáni hiba)`
                        );
                    } else {
                        timeout = this.realtime.getTimeout();
                    }

                    console.log(`[Realtime] Reconnecting in ${timeout / 1000}s...`);
                    await this.realtime.sleep(timeout);
                    this.realtime.reconnectAttempts++;
                    try {
                        await this.realtime.createSocket();
                    } catch (error) {
                        console.error('[Realtime] Reconnect failed:', error);
                    }
                });

                this.realtime.socket.addEventListener('error', (event) => {
                    // console.error('[Realtime] Socket error:', event);
                    // Az 'error' után általában jön 'close' is, ott kezeljük az újrakapcsolódást.
                });
            });
        };
    }

    onConnectionChange(callback) {
        this.connectionListeners.add(callback);
        callback(this.isConnected);
        return () => this.connectionListeners.delete(callback);
    }

    onError(callback) {
        this.errorListeners.add(callback);
        return () => this.errorListeners.delete(callback);
    }

    _notifyConnectionChange(connected) {
        if (this.isConnected !== connected) {
            this.isConnected = connected;
            if (process.env.NODE_ENV !== 'production') {
                log(`[Realtime] ${connected ? '✅ Connected' : '❌ Disconnected'}`);
            }
            this.connectionListeners.forEach(cb => {
                try { cb(connected); } catch (e) { logError(e); }
            });
        }
    }

    _notifyError(error) {
        this.lastError = error;
        logError("[Realtime] Error:", error);
        this.errorListeners.forEach(cb => {
            try { cb(error); } catch (e) { logError(e); }
        });
    }

    _attemptSdkSubscription(channel) {
        if (this.subscriptions.has(channel)) return;

        // Ensure we have a valid instance
        if (!this.realtime) this._initClient();

        if (process.env.NODE_ENV !== 'production') {
            log(`[Realtime] 🔄 Subscribing: ${channel}`);
        }

        try {
            const unsubscribe = this.realtime.subscribe(channel, (response) => {
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

            this.subscriptions.set(channel, unsubscribe);
            this._notifyConnectionChange(true);

        } catch (err) {
            logError(`[Realtime] Subscription failed: ${channel}`, err);
            this._notifyError(err);
            this._notifyConnectionChange(false);
        }
    }

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

    unsubscribe(channel, callback) {
        if (this.callbacks.has(channel)) {
            this.callbacks.get(channel).delete(callback);

            if (this.callbacks.get(channel).size === 0) {
                this.callbacks.delete(channel);
                if (this.subscriptions.has(channel)) {
                    const unsub = this.subscriptions.get(channel);
                    if (typeof unsub === "function") unsub();
                    this.subscriptions.delete(channel);
                }
            }
        }
    }

    /**
     * Teljesen megsemmisíti a kapcsolatot és újat épít.
     * Ez kritikus az alvás utáni helyreállításhoz, ahol az OS
     * "nyitva" tartja a halott socketet.
     * 
     * Védelem: ha már fut egy reconnect, a második hívást kihagyjuk.
     */
    reconnect() {
        // Párhuzamos reconnect védelem
        if (this.isReconnecting) {
            log('[Realtime] ⏳ Reconnect már folyamatban, kihagyva');
            return;
        }

        this.isReconnecting = true;

        if (process.env.NODE_ENV !== 'production') {
            log('[Realtime] 🔄 FORCE RECONNECT (Destroy & Rebuild)');
        }

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
            this.subscriptions.forEach((unsub) => {
                try { if (typeof unsub === "function") unsub(); } catch (e) {}
            });
            this.subscriptions.clear();

            // 4. INSTANCE MEGSEMMISÍTÉSE
            this.realtime = null;
            this.client = null;
            this.shouldReconnect = true;
            
            // Szerver hiba számláló nullázása az újraépítésnél
            this.consecutiveServerErrors = 0;
            this.serverErrorCooldownUntil = 0;

            // 4. Újrainicializálás
            this._initClient();

            // 5. Feliratkozások szinkron újraépítése
            //    (A korábbi setTimeout(50ms) race window-t okozott: az isConnected
            //    flag false maradt a 50ms alatt, és az InDesign afterActivate újabb
            //    recovery-t indított, végtelen ciklusba kerülve.)
            const channels = [...this.callbacks.keys()];
            if (channels.length > 0) {
                if (process.env.NODE_ENV !== 'production') {
                    log(`[Realtime] 📡 Rebuilding ${channels.length} subscriptions...`);
                }
                channels.forEach(ch => this._attemptSdkSubscription(ch));

                // Adat frissítés jelzése az újrafeliratkozás UTÁN
                if (typeof window !== 'undefined') {
                    if (process.env.NODE_ENV !== 'production') {
                        log('[Realtime] 🔄 Dispatching data refresh after reconnect');
                    }
                    dispatchMaestroEvent(MaestroEvent.dataRefreshRequested);
                }
            }

            this.isReconnecting = false;
        } catch (error) {
            logError('[Realtime] Reconnect hiba:', error);
            this.isReconnecting = false;
        }
    }

    disconnect() {
        this.shouldReconnect = false;

        this.subscriptions.forEach((unsub) => {
            try { if (typeof unsub === "function") unsub(); } catch (e) {}
        });
        this.subscriptions.clear();
        this.callbacks.clear();
        this._notifyConnectionChange(false);
        this.lastActivity = null;
        // Cleanup
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
        return Math.min(backoff, 60000);
    }

    getConnectionStatus() { return this.isConnected; }
    getLastError() { return this.lastError; }
    getLastActivity() { return this.lastActivity; }

    // Az auto-reconnect loop és a window 'online' listener eltávolítva.
    // A RecoveryManager (recoveryManager.js) központilag kezeli az összes
    // recovery trigger-t (online, sleep, focus, realtime disconnect).
}

// Global Singleton Pattern for UXP/Hot-Reload Environment
// Ha a modul újraértékelődik (pl. reload), a régi instance-t meg kell ölni.
if (typeof window !== 'undefined') {
    if (window.__maestroRealtimeInstance) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn('[Realtime] ♻️ Cleaning up previous RealtimeClient instance before reload...');
        }
        try {
            window.__maestroRealtimeInstance.disconnect();
        } catch (e) {
            console.error('[Realtime] Failed to disconnect previous instance:', e);
        }
    }
}

export const realtime = new RealtimeClient();

// Store reference for next reload
if (typeof window !== 'undefined') {
    window.__maestroRealtimeInstance = realtime;
}
