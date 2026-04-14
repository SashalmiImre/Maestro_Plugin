/**
 * @file useDriveAccessibility.js
 * @description Központi mappa-elérhetőség figyelő hook.
 *
 * Periodikusan ellenőrzi az összes kiadvány rootPath mappájának elérhetőségét,
 * függetlenül attól, hogy melyik kiadvány van lenyitva. A visszaadott Map
 * alapján minden Publication komponens megjelenítheti a piros/kék fejlécet.
 *
 * Egyetlen batched ExtendScript hívást használ ciklusonként (N mappa → 1 doScript),
 * minimalizálva az InDesign blokkolást.
 */

// React
import { useState, useEffect, useRef, useCallback } from "react";

// Konfiguráció & Konstansok
import { DRIVE_CHECK_INTERVAL_MS } from "../../core/utils/constants.js";
import { MaestroEvent } from "../../core/config/maestroEvents.js";

// Utils
import { checkPathsAccessibleBatch, toNativePath } from "../../core/utils/pathUtils.js";
import { logDebug, logWarn } from "../../core/utils/logger.js";

/**
 * Összehasonlít két Map-et (pubId → boolean) — true, ha eltérnek.
 * @param {Map<string, boolean>} prev
 * @param {Map<string, boolean>} next
 * @returns {boolean}
 */
const mapsAreDifferent = (prev, next) => {
    if (prev.size !== next.size) return true;
    for (const [key, value] of next) {
        if (prev.get(key) !== value) return true;
    }
    return false;
};

/**
 * Központi mappa-elérhetőség hook.
 *
 * @param {Array} publications - A kiadványok tömbje (a DataContext-ből).
 * @returns {Map<string, boolean>} accessibilityMap — pubId → elérhetőség.
 */
export const useDriveAccessibility = (publications) => {
    const [accessibilityMap, setAccessibilityMap] = useState(() => new Map());
    const publicationsRef = useRef(publications);
    const isCheckingRef = useRef(false);

    // Ref frissítés minden renderben (stabil callback-ekhez)
    useEffect(() => {
        publicationsRef.current = publications;
    }, [publications]);

    /** Összes kiadvány rootPath ellenőrzése egyetlen batched ExtendScript hívásban. */
    const checkAll = useCallback(async () => {
        if (isCheckingRef.current) return;
        isCheckingRef.current = true;
        try {
            const pubs = publicationsRef.current;
            if (!pubs || pubs.length === 0) return;

            const nativePaths = pubs.map(pub => toNativePath(pub.rootPath));
            let results;
            try {
                results = await checkPathsAccessibleBatch(nativePaths);
            } catch (err) {
                // ExtendScript hiba vagy InDesign elérhetetlen — a poller tovább fut, az előző
                // state megmarad. Így egy átmeneti doScript-hiccup nem dobja minden mappát pirosra.
                logWarn('[useDriveAccessibility] checkPathsAccessibleBatch sikertelen:', err?.message || err);
                return;
            }

            const nextMap = new Map();
            pubs.forEach((pub, i) => {
                nextMap.set(pub.$id, results[i] ?? false);
            });

            setAccessibilityMap(prev => {
                if (mapsAreDifferent(prev, nextMap)) {
                    logDebug('[useDriveAccessibility] Accessibility changed:', Object.fromEntries(nextMap));
                    return nextMap;
                }
                return prev;
            });
        } finally {
            isCheckingRef.current = false;
        }
    }, []);

    // Polling + event listenerek
    useEffect(() => {
        // Azonnali ellenőrzés mount-kor
        checkAll();

        const pollIntervalId = setInterval(checkAll, DRIVE_CHECK_INTERVAL_MS);

        const handleEvent = () => checkAll();
        window.addEventListener('focus', handleEvent);
        window.addEventListener(MaestroEvent.panelShown, handleEvent);
        window.addEventListener(MaestroEvent.dataRefreshRequested, handleEvent);

        return () => {
            clearInterval(pollIntervalId);
            window.removeEventListener('focus', handleEvent);
            window.removeEventListener(MaestroEvent.panelShown, handleEvent);
            window.removeEventListener(MaestroEvent.dataRefreshRequested, handleEvent);
        };
    }, [checkAll]);

    // Ha a kiadványok listája változik (hozzáadás/törlés/csere), azonnali újraellenőrzés
    useEffect(() => {
        checkAll();
    }, [publications, checkAll]);

    return accessibilityMap;
};
