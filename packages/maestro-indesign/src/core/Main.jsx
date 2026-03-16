/**
 * @file Main.jsx
 * @description Main application component handling higher-level application state,
 * connectivity, and user session management.
 * 
 * Responsibilities:
 * - User authentication checks (Login vs Workspace)
 * - Network connectivity monitoring (Online/Offline)
 * - Realtime service connection handling
 * - InDesign idle/sleep detection and recovery
 * - Application-wide UI overlays (Loading/Connection status)
 */

import React, { useEffect, useRef, useState } from "react";

import { useUser } from "./contexts/UserContext.jsx";
import { useConnection } from "./contexts/ConnectionContext.jsx";
import { CONNECTION_STATES, CONNECTION_CONFIG, RECOVERY_TRIGGERS, TOAST_TYPES } from "./utils/constants.js";
import { MaestroEvent } from "./config/maestroEvents.js";
import { realtime } from "./config/realtimeClient.js";
import { recoveryManager } from "./config/recoveryManager.js";
import { log, logError, logWarn } from "./utils/logger.js";

import { getIndesignModule, getIndesignApp } from "./utils/indesign/indesignUtils.js";

import { Login } from "../ui/features/user/Login/Login.jsx";
import { Register } from "../ui/features/user/Register/Register.jsx";
import { Loading } from "../ui/common/Loading/Loading.jsx";
import { Workspace } from "../ui/features/workspace/Workspace.jsx";
import { ToastProvider, useToast } from "../ui/common/Toast/ToastContext.jsx";
import { ToastContainer } from "../ui/common/Toast/ToastContainer.jsx";
import { DataProvider } from "./contexts/DataContext.jsx";
import { ValidationProvider } from "./contexts/ValidationContext.jsx";

/**
 * Endpoint váltás toast értesítő.
 * A ToastProvider-en belül kell renderelni, hogy hozzáférjen a useToast hook-hoz.
 */
const EndpointSwitchNotifier = () => {
    const { showToast } = useToast();

    useEffect(() => {
        const handleSwitch = (event) => {
            const { isPrimary } = event.detail;
            if (isPrimary) {
                showToast('Fő szerverre visszakapcsolva', TOAST_TYPES.INFO);
            } else {
                showToast('Tartalék szerverre váltva', TOAST_TYPES.WARNING, 'A fő szerver nem elérhető, a tartalék szerver aktív.');
            }
        };

        window.addEventListener(MaestroEvent.endpointSwitched, handleSwitch);
        return () => window.removeEventListener(MaestroEvent.endpointSwitched, handleSwitch);
    }, [showToast]);

    return null;
};

/**
 * Main application component.
 * Serves as the root for the authenticated/unauthenticated UI and manages global
 * connection lifecycles.
 */
export const Main = () => {
    const { user, loading: userLoading } = useUser();
    const [authView, setAuthView] = useState('login');
    const {
        connectionStatus,
        showConnectionOverlay,
        setOnlineStatus,
        setConnected,
        setConnectionStatus,
        setRealtimeStatus
    } = useConnection();

    // -------------------------------------------------------------------------
    // Browser Online/Offline Events
    // -------------------------------------------------------------------------

    /**
     * @effect Figyeli a böngésző online/offline állapotát.
     * Online-ra váltáskor a RecoveryManager-en keresztül indítja a helyreállítást.
     */
    useEffect(() => {
        /**
         * Online esemény kezelője.
         */
        const onOnline = () => {
            log('[Main] [ONLINE] Online');
            setOnlineStatus(true);
            // Központi recovery — health check + reconnect + adat frissítés
            recoveryManager.requestRecovery(RECOVERY_TRIGGERS.ONLINE);
        };

        /**
         * Offline esemény kezelője.
         */
        const onOffline = () => {
            log('[Main] [OFFLINE] Offline');
            setOnlineStatus(false);
        };

        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);

        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, [setOnlineStatus]);

    // -------------------------------------------------------------------------
    // Realtime Service Connection
    // -------------------------------------------------------------------------

    /**
     * @effect Feliratkozás a Realtime kapcsolat állapotváltozásaira.
     * Ha a WebSocket szétkapcsolódik (pl. 1005 halott TCP), a RecoveryManager
     * kezeli a helyreállítást (auto-reconnect logika).
     */
    useEffect(() => {
        const unsubscribe = realtime.onConnectionChange((isConnected) => {
            log('[Main] Realtime:', isConnected ? 'connected' : 'disconnected');
            // setRealtimeStatus(isConnected ? CONNECTION_STATES.CONNECTED : CONNECTION_STATES.DISCONNECTED);

            if (isConnected) {
                // Realtime helyreállt → alkalmazás is "connected"
                setConnected();
            } else {
                // Realtime szétkapcsolódott → recovery indítása
                recoveryManager.requestRecovery(RECOVERY_TRIGGERS.REALTIME);
            }
        });

        // Cleanup function - kritikus a duplikált listenerek elkerülése miatt!
        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        };
    }, [setConnected]);

    /**
     * @effect Subscribes to Appwrite Realtime errors (e.g., connection failures).
     */
    useEffect(() => {
        const unsubscribe = realtime.onError((error) => {
            logWarn('[Main] Realtime error:', error.message);
        });

        return unsubscribe;
    }, []);

    // -------------------------------------------------------------------------
    // InDesign Idle/Sleep Detection
    // -------------------------------------------------------------------------

    /**
     * Ref to track the timestamp of the last detected idle check.
     * Used to calculate the time gap between idle tics to detect system sleep.
     * @type {React.MutableRefObject<number>}
     */
    const lastIdleTimeRef = useRef(Date.now());

    /**
     * Ref to track the current offline status without causing effect re-registrations.
     * Synced from connectionStatus.isOffline via a dedicated effect below.
     * @type {React.MutableRefObject<boolean>}
     */
    const offlineRef = useRef(connectionStatus.isOffline);

    /**
     * @effect InDesign IdleTask az alvás/ébredés ciklusok észleléséhez.
     * Ha jelentős időeltolódást (> küszöbérték) észlel az idle tick-ek között,
     * feltételezi, hogy a számítógép aludt, és a RecoveryManager-en keresztül
     * indítja a helyreállítást.
     */
    useEffect(() => {
        const { app, IdleEvent } = getIndesignModule();
        if (!app || !IdleEvent) return;
        let idleTask = null;

        /**
         * Idle esemény callback.
         * Ellenőrzi az időeltolódást az alvás észleléséhez.
         */
        const onIdleTick = () => {
            const now = Date.now();
            const timeSinceLastIdle = now - lastIdleTimeRef.current;
            lastIdleTimeRef.current = now;

            // Alvás észlelése, ha a gap > konfigurált küszöbérték
            if (timeSinceLastIdle > CONNECTION_CONFIG.SLEEP_THRESHOLD_MS) {
                log(`[Main] [SLEEP] Alvás észlelve (${Math.round(timeSinceLastIdle / 1000)}s gap)`);

                // Vizuális visszajelzés
                setConnectionStatus(prev => ({
                    ...prev,
                    isConnecting: true,
                    message: 'Kapcsolat helyreállítása...',
                    showSpinner: true
                }));

                // Központi recovery
                recoveryManager.requestRecovery(RECOVERY_TRIGGERS.SLEEP);
            }
        };

        try {
            idleTask = app.idleTasks.add({
                name: "MaestroSleepDetector",
                sleep: CONNECTION_CONFIG.IDLE_CHECK_INTERVAL_MS
            });
            idleTask.addEventListener(IdleEvent.ON_IDLE, onIdleTick);
            log('[Main] [TIMER] Sleep detector started');
        } catch (error) {
            logError('[Main] IdleTask error:', error);
        }

        return () => {
            try {
                if (idleTask?.isValid) idleTask.remove();
            } catch (e) { /* leálláskor ne crasheljen */ }
        };
    }, [setConnectionStatus]);

    // -------------------------------------------------------------------------
    // Sync offlineRef with connectionStatus.isOffline
    // -------------------------------------------------------------------------

    /**
     * @effect Keeps offlineRef in sync with the latest connectionStatus.isOffline value
     * so that event handlers can read the current offline state without being
     * listed as effect dependencies.
     */
    useEffect(() => {
        offlineRef.current = connectionStatus.isOffline;
    }, [connectionStatus.isOffline]);

    // -------------------------------------------------------------------------
    // InDesign App Focus Detection
    // -------------------------------------------------------------------------

    /**
     * @effect InDesign afterActivate esemény figyelése.
     * Amikor az alkalmazás fókuszba kerül (ébredés, Alt-Tab),
     * a RecoveryManager-en keresztül indul a helyreállítás.
     */
    useEffect(() => {
        const app = getIndesignApp();
        if (!app) return;

        /**
         * InDesign aktiválás/fókusz kezelője.
         */
        const onAppActivate = () => {
            const now = Date.now();
            const timeSinceLastIdle = now - lastIdleTimeRef.current;

            log(`[Main] [FOCUS] InDesign Activated (Gap: ${Math.round(timeSinceLastIdle / 1000)}s)`);

            // Háromszintű ellenőrzés: disconnect / elavult WS / friss kapcsolat
            const isConnected = realtime.getConnectionStatus();
            const lastActivity = realtime.getLastActivity();
            const activityAge = lastActivity ? (now - lastActivity) : Infinity;
            const isStale = activityAge > CONNECTION_CONFIG.REALTIME_STALENESS_MS;

            if (!isConnected || timeSinceLastIdle >= CONNECTION_CONFIG.SLEEP_THRESHOLD_MS) {
                log('[Main] [SYNC] Hosszú gap vagy disconnected — Recovery indítása...');
                recoveryManager.requestRecovery(RECOVERY_TRIGGERS.FOCUS);
            } else if (isStale) {
                log(`[Main] [SYNC] Kapcsolat elavult (${Math.round(activityAge / 1000)}s óta nincs WS üzenet) — Recovery indítása...`);
                recoveryManager.requestRecovery(RECOVERY_TRIGGERS.FOCUS);
            } else {
                log(`[Main] [SKIP] Kapcsolat él & friss (${Math.round(activityAge / 1000)}s) — Kihagyva.`);
            }

            // Ha offline állapotban vagyunk, azonnali vizuális visszajelzés
            if (offlineRef.current) {
                setConnectionStatus(prev => ({
                    ...prev,
                    isConnecting: true,
                    message: 'Kapcsolat ellenőrzése...',
                    showSpinner: true
                }));
            }
        };

        try {
            app.addEventListener("afterActivate", onAppActivate);
            log('[Main] [WATCH] Focus detector registered');
        } catch (error) {
            logError('[Main] Failed to register focus detector:', error);
        }

        return () => {
            try {
                app.removeEventListener("afterActivate", onAppActivate);
            } catch (e) { /* leálláskor ne crasheljen */ }
        };
    }, [setConnectionStatus]);

    // A korábbi Auto-Retry mechanizmus (health check retry loop) eltávolítva.
    // A RecoveryManager (recoveryManager.js) központilag kezeli az összes
    // recovery trigger-t, exponenciális backoff-fal.

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    return (
        <>
            <div style={{
                position: "fixed",
                top: 0, left: 0, right: 0, bottom: 0,
                display: showConnectionOverlay ? "flex" : "none",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000, // Ensure it sits on top when visible
            }}>
                <Loading
                    message={connectionStatus.message || "Kapcsolódás..."}
                    details={connectionStatus.details}
                    showSpinner={connectionStatus.showSpinner}
                />
            </div>

            <ToastProvider>
                <EndpointSwitchNotifier />
                <div style={{
                    padding: "16px",
                    display: showConnectionOverlay ? "none" : "flex", // Completely hide content layer to prevent layout trashing
                    flex: "1",
                    flexDirection: "column",
                    overflow: "hidden",
                    height: "100%"
                }}>
                    {!userLoading && (
                        user ? (
                            <DataProvider>
                                <ValidationProvider>
                                    <Workspace />
                                </ValidationProvider>
                            </DataProvider>
                        ) : (
                            authView === 'login'
                                ? <Login onSwitchToRegister={() => setAuthView('register')} />
                                : <Register onSwitchToLogin={() => setAuthView('login')} />
                        )
                    )}
                </div>
                {/* Toast konténer — overlay alatt rejtve, hogy ne zavarjon */}
                <div style={{ display: showConnectionOverlay ? "none" : "block" }}>
                    <ToastContainer />
                </div>
            </ToastProvider>
        </>
    );
};