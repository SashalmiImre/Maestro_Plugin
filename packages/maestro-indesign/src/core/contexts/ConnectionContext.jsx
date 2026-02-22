/**
 * @file ConnectionContext.jsx
 * @description Kapcsolat állapot kezelése - egyszerűsített verzió.
 * 
 * Az overlay megjelenik ha:
 * - isConnecting: true (kapcsolódás folyamatban)
 * - isOffline: true (nincs kapcsolat)
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from "react";
import { CONNECTION_STATES } from "../utils/constants.js";
import { log } from "../utils/logger.js";
import { isNetworkError as checkNetworkError, isServerError as checkServerError } from "../utils/errorUtils.js";

const ConnectionContext = createContext(null);

export const useConnection = () => {
    const context = useContext(ConnectionContext);
    if (!context) throw new Error("useConnection must be used within a ConnectionProvider");
    return context;
};

export const ConnectionProvider = ({ children }) => {
    const [connectionStatus, setConnectionStatus] = useState({
        isConnecting: false,
        isOffline: false,
        attempts: 0,
        message: null,
        details: null,
        showSpinner: true,
        realtimeStatus: CONNECTION_STATES.UNKNOWN
    });

    const timeoutRef = useRef(null);
    const attemptsRef = useRef(0);

    // Takarítás leválasztáskor (unmount)
    useEffect(() => {
        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, []);

    // Átmeneti üzenet tisztítása
    useEffect(() => {
        if (connectionStatus.message === "Kapcsolat helyreállt") {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);

            timeoutRef.current = setTimeout(() => {
                setConnectionStatus(s => ({
                    ...s,
                    message: null,
                    details: null
                }));
            }, 2000);

            return () => {
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
            };
        }
    }, [connectionStatus.message]);

    /**
     * Kapcsolódás folyamatban
     */
    const startConnecting = useCallback((message = "Kapcsolódás...") => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setConnectionStatus(prev => ({
            ...prev,
            isConnecting: true,
            isOffline: false,
            message,
            showSpinner: true
        }));
    }, []);

    /**
     * Attempts növelése és az új érték visszaadása
     * Ref-et használunk a szinkron számláláshoz
     */
    const incrementAttempts = useCallback(() => {
        attemptsRef.current += 1;
        setConnectionStatus(prev => ({
            ...prev,
            attempts: attemptsRef.current
        }));
        return attemptsRef.current;
    }, []);

    /**
     * Offline állapot (hiba)
     */
    const setOffline = useCallback((error = null, attempts = 0) => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        attemptsRef.current = attempts;

        // Szerver oldali hiba detektálása
        const isServerError = checkServerError(error);

        const isNetworkError = !navigator.onLine || checkNetworkError(error);

        let messageVal = "Kapcsolódási hiba";
        let detailsVal = `${attemptsRef.current}. próbálkozás...`;

        if (isServerError) {
            messageVal = "Szerver hiba (502)";
            detailsVal = "A szerver átmenetileg nem elérhető. Újracsatlakozás...";
        } else if (isNetworkError) {
            messageVal = "Nincs hálózati kapcsolat";
            detailsVal = "Ellenőrizd az internetkapcsolatot";
        }

        setConnectionStatus({
            isConnecting: false,
            isOffline: true,
            attempts: attemptsRef.current,
            message: messageVal,
            details: detailsVal,
            showSpinner: !isNetworkError || isServerError, // Szerver hibánál is pörögjön, mert próbálkozunk
            realtimeStatus: CONNECTION_STATES.DISCONNECTED
        });
    }, []);

    /**
     * Sikeres kapcsolat
     */
    const setConnected = useCallback(() => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        attemptsRef.current = 0;

        setConnectionStatus(prev => {
            if (prev.attempts > 0) {
                // Ha újrapróbálkozás történt, rövid sikerüzenetet mutatunk
                // A fenti useEffect kezeli a törlését
                return {
                    isConnecting: false,
                    isOffline: false,
                    attempts: 0,
                    message: "Kapcsolat helyreállt",
                    details: null,
                    showSpinner: false,
                    realtimeStatus: CONNECTION_STATES.CONNECTED
                };
            }

            // Normál kapcsolat
            return {
                isConnecting: false,
                isOffline: false,
                attempts: 0,
                message: null,
                details: null,
                showSpinner: true,
                realtimeStatus: CONNECTION_STATES.CONNECTED
            };
        });
    }, []);

    /**
     * Online/offline esemény
     */
    const setOnlineStatus = useCallback((isOnline) => {
        if (isOnline) {
            setConnectionStatus(prev => ({
                ...prev,
                isOffline: false,
                message: null,
                details: null
            }));
        } else {
            setConnectionStatus(prev => ({
                ...prev,
                isOffline: true,
                message: "Nincs hálózati kapcsolat",
                details: "Ellenőrizd az internetkapcsolatot",
                showSpinner: false,
                realtimeStatus: CONNECTION_STATES.DISCONNECTED
            }));
        }
    }, []);

    /**
     * Realtime státusz frissítés
     */
    const setRealtimeStatus = useCallback((status) => {
        setConnectionStatus(prev => ({ ...prev, realtimeStatus: status }));
    }, []);

    const showConnectionOverlay = connectionStatus.isConnecting || connectionStatus.isOffline;

    const value = useMemo(() => ({
        connectionStatus,
        showConnectionOverlay,
        startConnecting,
        setOffline,
        setConnected,
        setOnlineStatus,
        setConnectionStatus,
        setRealtimeStatus,
        incrementAttempts
    }), [connectionStatus, showConnectionOverlay, startConnecting, setOffline, setConnected, setOnlineStatus, setRealtimeStatus, incrementAttempts]);

    return (
        <ConnectionContext.Provider value={value}>
            {children}
        </ConnectionContext.Provider>
    );
};
