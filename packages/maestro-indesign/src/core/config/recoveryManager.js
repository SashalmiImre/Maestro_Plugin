/**
 * @file recoveryManager.js
 * @description Központi helyreállítás-kezelő (Recovery Manager).
 * 
 * Ez az egyetlen belépési pont az összes recovery trigger számára:
 * - Online/Offline állapotváltás
 * - InDesign IdleTask alvás-detektálás
 * - InDesign afterActivate fókusz-visszatérés
 * - Realtime WebSocket szétkapcsolódás
 * 
 * A RecoveryManager biztosítja, hogy:
 * - Egyszerre csak EGY recovery folyamat fusson (lock)
 * - Gyors egymás utáni triggerek ne indítsanak párhuzamos recovery-ket (debounce)
 * - A sorrend mindig: health check → realtime reconnect → adat frissítés
 * 
 * @module config/recoveryManager
 */

import { realtime } from "./realtimeClient.js";
import { endpointManager } from "./appwriteConfig.js";
import { MaestroEvent, dispatchMaestroEvent } from "./maestroEvents.js";
import { RECOVERY_CONFIG } from "../utils/constants.js";
import { log, logError, logWarn } from "../utils/logger.js";

class RecoveryManager {
    constructor() {
        /** @type {boolean} Folyamatban van-e recovery */
        this.isRecovering = false;

        /** @type {number} Utolsó recovery időbélyega (debounce-hoz) */
        this.lastRecoveryAt = 0;

        /** @type {number|null} Pending requestRecovery timeout ID */
        this._pendingTimeout = null;

        /** @type {boolean} Plugin leállítás alatt van-e (in-flight recovery megszakítás) */
        this._isCancelled = false;

        /** @type {Set<AbortController>} Aktív fetch kérések abort controller-ei */
        this._activeControllers = new Set();

        /** @type {Function|null} Aktív retry delay reject függvénye (megszakításhoz) */
        this._retryReject = null;
    }

    /**
     * Recovery kérése egy adott trigger-ből.
     * 
     * Debounce-ol: ha az utolsó recovery óta nem telt el elég idő,
     * ütemezi a következőt a hátralévő időre.
     * Ha már van ütemezett recovery, nem ütemez újat.
     * 
     * @param {string} trigger - A trigger neve (logoláshoz), pl. 'online', 'sleep', 'focus'
     */
    requestRecovery(trigger) {
        const now = Date.now();
        const elapsed = now - this.lastRecoveryAt;
        const debounceMs = RECOVERY_CONFIG.DEBOUNCE_MS;

        // Ha épp fut egy recovery, nem kell újat indítani
        if (this.isRecovering) {
            log(`[Recovery] ⏳ Recovery épp fut, "${trigger}" trigger kihagyva`);
            return;
        }

        // Debounce: ha nemrég volt recovery, ütemezzük a hátralévő időre
        if (elapsed < debounceMs) {
            if (this._pendingTimeout) {
                log(`[Recovery] ⏳ Már van ütemezett recovery, "${trigger}" trigger kihagyva`);
                return;
            }

            const remaining = debounceMs - elapsed;
            log(`[Recovery] ⏰ "${trigger}" trigger ütemezve ${Math.ceil(remaining / 1000)}s múlva (debounce)`);
            this._pendingTimeout = setTimeout(() => {
                this._pendingTimeout = null;
                this._executeRecovery(trigger);
            }, remaining);
            return;
        }

        // Azonnal indíthatjuk
        this._executeRecovery(trigger);
    }

    /**
     * Recovery végrehajtása.
     * 
     * Sorrend:
     * 1. Health check — van-e hálózat/szerver?
     * 2. Realtime reconnect — WebSocket újraépítés
     * 3. Adat frissítés — dataRefreshRequested event (DataContext kezeli)
     * 
     * Exponenciális backoff-fal újrapróbálkozik, ha a health check nem sikerül.
     * 
     * @param {string} trigger - A trigger neve (logoláshoz)
     * @private
     */
    async _executeRecovery(trigger) {
        if (this._isCancelled) return;
        if (this.isRecovering) return;

        this._isCancelled = false;
        this.isRecovering = true;
        this.lastRecoveryAt = Date.now();
        log(`[Recovery] 🔄 Recovery indítása (trigger: "${trigger}")`);

        try {
            // 1. Health check — van-e hálózat?
            const serverReachable = await this._healthCheckWithRetry();

            // Plugin leállítás közben megszakított recovery
            if (this._isCancelled) {
                log('[Recovery] 🛑 Recovery megszakítva (plugin leállítás)');
                return;
            }

            if (!serverReachable) {
                logWarn('[Recovery] ❌ Szerver nem elérhető a retry-ok után sem');
                return;
            }

            log('[Recovery] ✅ Szerver elérhető');

            // 2. Realtime reconnect
            // A realtime.reconnect() teljes destroy+rebuild-et csinál,
            // és a végén dispatch-eli a dataRefreshRequested event-et is.
            const isConnected = realtime.getConnectionStatus();
            if (!isConnected && !realtime.isReconnecting) {
                log('[Recovery] 🔌 Realtime újraépítés...');
                realtime.reconnect();
            } else {
                // Ha a WebSocket él, csak adat frissítést kérünk
                log('[Recovery] 📡 Realtime él, csak adat frissítés');
                dispatchMaestroEvent(MaestroEvent.dataRefreshRequested);
            }

            log('[Recovery] ✅ Recovery befejezve');
        } catch (error) {
            logError('[Recovery] ❌ Recovery hiba:', error);
        } finally {
            // Debounce frissítése a recovery VÉGÉN is (nem csak az elején).
            // Ha a recovery sokáig tartott (health check retry-ok), az elejei
            // lastRecoveryAt már lejárt volna, és a következő focus esemény
            // azonnal új recovery-t indított volna → végtelen ciklus.
            this.lastRecoveryAt = Date.now();
            this.isRecovering = false;
        }
    }

    /**
     * Cascading health check: aktív endpoint → másik endpoint.
     *
     * 1. Aktív endpoint-on retry-okkal próbálkozik.
     * 2. Ha az nem elérhető, megpróbálja a másikat (egyetlen próba).
     * 3. Ha a másik működik, átkapcsol rá (endpointManager.switchToOther()).
     * 4. Ha fallback-en vagyunk és a primary visszajött, visszakapcsol.
     *
     * @returns {Promise<boolean>} Igaz, ha valamelyik szerver elérhető.
     * @private
     */
    async _healthCheckWithRetry() {
        const { MAX_RETRIES, RETRY_BASE_MS, HEALTH_TIMEOUT_MS } = RECOVERY_CONFIG;

        // 1. Aktív endpoint próbálkozás (retry-okkal)
        const activeOk = await this._tryEndpointHealth(
            endpointManager.getHealthEndpoint(), MAX_RETRIES, RETRY_BASE_MS, HEALTH_TIMEOUT_MS
        );

        if (activeOk) {
            // Ha fallback-en voltunk és a primary most visszajött, próbáljuk visszakapcsolni
            if (!endpointManager.getIsPrimary()) {
                const primaryOk = await this._singleHealthCheck(
                    endpointManager.getOtherHealthEndpoint(), HEALTH_TIMEOUT_MS
                );
                if (primaryOk) {
                    endpointManager.switchToPrimary();
                    log('[Recovery] Primary proxy visszaállt, átkapcsolva');
                }
            }
            return true;
        }

        // 2. Aktív nem elérhető → próbáljuk a másikat
        log('[Recovery] Aktív endpoint nem elérhető, fallback próba...');
        const otherOk = await this._singleHealthCheck(
            endpointManager.getOtherHealthEndpoint(), HEALTH_TIMEOUT_MS
        );

        if (otherOk) {
            endpointManager.switchToOther();
            return true;
        }

        return false;
    }

    /**
     * Retry-os health check egy adott endpoint-ra.
     *
     * @param {string} url - Health endpoint URL.
     * @param {number} maxRetries - Maximum próbálkozások.
     * @param {number} retryBaseMs - Backoff alap (ms).
     * @param {number} timeoutMs - Kérés timeout (ms).
     * @returns {Promise<boolean>} Igaz, ha elérhető.
     * @private
     */
    async _tryEndpointHealth(url, maxRetries, retryBaseMs, timeoutMs) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            this._activeControllers.add(controller);

            let timeoutId;
            try {
                timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                const response = await fetch(url, {
                    method: 'GET',
                    signal: controller.signal
                });

                if (response.ok) return true;

                if (response.status === 401) {
                    log('[Recovery] Session lejárt (401)');
                    dispatchMaestroEvent(MaestroEvent.sessionExpired);
                    return true;
                }

                logWarn(`[Recovery] Health check HTTP ${response.status} (${attempt}/${maxRetries})`);
            } catch (error) {
                if (error.name === 'AbortError') {
                    if (this._isCancelled) return false;
                    logWarn(`[Recovery] Health check timeout (${attempt}/${maxRetries})`);
                } else {
                    logWarn(`[Recovery] Health check hiba (${attempt}/${maxRetries}):`, error.message);
                }
            } finally {
                clearTimeout(timeoutId);
                this._activeControllers.delete(controller);
            }

            if (this._isCancelled) return false;

            if (attempt < maxRetries) {
                const delayMs = retryBaseMs * Math.pow(2, attempt - 1);
                log(`[Recovery] Újrapróbálás ${delayMs / 1000}s múlva...`);
                await new Promise((resolve, reject) => {
                    this._retryReject = reject;
                    setTimeout(() => {
                        this._retryReject = null;
                        resolve();
                    }, delayMs);
                }).catch(() => {});

                if (this._isCancelled) return false;
            }
        }

        return false;
    }

    /**
     * Egyetlen health check próbálkozás egy adott endpoint-ra.
     *
     * @param {string} url - Health endpoint URL.
     * @param {number} timeoutMs - Kérés timeout (ms).
     * @returns {Promise<boolean>} Igaz, ha elérhető.
     * @private
     */
    async _singleHealthCheck(url, timeoutMs) {
        const controller = new AbortController();
        this._activeControllers.add(controller);

        let timeoutId;
        try {
            timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(url, {
                method: 'GET',
                signal: controller.signal
            });

            return response.ok || response.status === 401;
        } catch (error) {
            if (error.name !== 'AbortError') {
                log(`[Recovery] _singleHealthCheck hiba (url: ${url}, timeout: ${timeoutMs}ms):`, error);
            }
            return false;
        } finally {
            clearTimeout(timeoutId);
            this._activeControllers.delete(controller);
        }
    }

    /**
     * Leállítja az esetleg ütemezett recovery-t.
     * Használat: komponens unmount-kor.
     */
    cancel() {
        this._isCancelled = true;
        if (this._pendingTimeout) {
            clearTimeout(this._pendingTimeout);
            this._pendingTimeout = null;
        }
        if (this._retryReject) {
            this._retryReject();
            this._retryReject = null;
        }
        for (const controller of this._activeControllers) {
            controller.abort();
        }
        this._activeControllers.clear();
        this.isRecovering = false;
    }
}

/**
 * Singleton RecoveryManager példány.
 * Az egész alkalmazásban ezt az egyetlen példányt használjuk.
 */
export const recoveryManager = new RecoveryManager();
