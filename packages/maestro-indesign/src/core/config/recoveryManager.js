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
import { HEALTH_ENDPOINT } from "./appwriteConfig.js";
import { MaestroEvent, dispatchMaestroEvent } from "./maestroEvents.js";
import { RECOVERY_CONFIG } from "../utils/constants.js";
import { log, logError, logWarn } from "../utils/logger.js";

class RecoveryManager {
    constructor() {
        /** @type {boolean} Folyamatban van-e recovery */
        this.isRecovering = false;

        /** @type {number} Utolsó recovery időbélyege (debounce-hoz) */
        this.lastRecoveryAt = 0;

        /** @type {number|null} Pending requestRecovery timeout ID */
        this._pendingTimeout = null;
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
        if (this.isRecovering) return;

        this.isRecovering = true;
        this.lastRecoveryAt = Date.now();
        log(`[Recovery] 🔄 Recovery indítása (trigger: "${trigger}")`);

        try {
            // 1. Health check — van-e hálózat?
            const serverReachable = await this._healthCheckWithRetry();

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
     * Health check újrapróbálkozással (exponenciális backoff).
     * 
     * @returns {Promise<boolean>} Igaz, ha a szerver elérhető.
     * @private
     */
    async _healthCheckWithRetry() {
        const { MAX_RETRIES, RETRY_BASE_MS, HEALTH_TIMEOUT_MS } = RECOVERY_CONFIG;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

                const response = await fetch(HEALTH_ENDPOINT, {
                    method: 'GET',
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (response.ok) {
                    return true;
                }

                if (response.status === 401) {
                    // Hálózat rendben, de session lejárt
                    log('[Recovery] ⚠️ Session lejárt (401)');
                    dispatchMaestroEvent(MaestroEvent.sessionExpired);
                    return true; // Hálózat OK, a session kezelés külön fut
                }

                logWarn(`[Recovery] Health check HTTP ${response.status} (${attempt}/${MAX_RETRIES})`);
            } catch (error) {
                if (error.name === 'AbortError') {
                    logWarn(`[Recovery] Health check timeout (${attempt}/${MAX_RETRIES})`);
                } else {
                    logWarn(`[Recovery] Health check hiba (${attempt}/${MAX_RETRIES}):`, error.message);
                }
            }

            // Ha nem az utolsó próbálkozás, várunk backoff-fal
            if (attempt < MAX_RETRIES) {
                const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
                log(`[Recovery] ⏳ Újrapróbálás ${delayMs / 1000}s múlva...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        return false;
    }

    /**
     * Leállítja az esetleg ütemezett recovery-t.
     * Használat: komponens unmount-kor.
     */
    cancel() {
        if (this._pendingTimeout) {
            clearTimeout(this._pendingTimeout);
            this._pendingTimeout = null;
        }
        this.isRecovering = false;
    }
}

/**
 * Singleton RecoveryManager példány.
 * Az egész alkalmazásban ezt az egyetlen példányt használjuk.
 */
export const recoveryManager = new RecoveryManager();
