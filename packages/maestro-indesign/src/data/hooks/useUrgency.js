/**
 * React Hook a cikkek sürgősségének kiszámításához.
 *
 * Percenként újraszámolja az egyes cikkek sürgősségi arányát és háttérszínét
 * a deadline, a munkaidő és a hátralévő státuszok becsült időtartama alapján.
 *
 * @module useUrgency
 */

// React
import { useState, useEffect, useRef, useMemo } from "react";

// Utils
import { fetchHolidays, calculateUrgencyRatio } from "../../core/utils/urgencyUtils.js";
import { logWarn } from "../../core/utils/logger.js";

/** Frissítési intervallum (ms) — 1 perc */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Kiszámítja minden cikkhez a sürgősségi adatokat.
 *
 * @param {Array} articles - A kiadvány cikkeinek tömbje
 * @param {Array} deadlines - A kiadvány deadline-jainak tömbje
 * @param {Object} publication - A kiadvány objektum (excludeWeekends mező)
 * @returns {Map<string, { ratio: number, color: string|null }>} Cikk ID → sürgősségi adatok
 */
export const useUrgency = (articles, deadlines, publication) => {
    const [urgencyMap, setUrgencyMap] = useState(() => new Map());
    const [holidays, setHolidays] = useState(() => new Set());
    const intervalRef = useRef(null);

    const excludeWeekends = publication?.excludeWeekends ?? true;

    // Ünnepnapok lekérése (induláskor + évváltáskor)
    useEffect(() => {
        let cancelled = false;
        const currentYear = new Date().getFullYear();

        const loadHolidays = async () => {
            try {
                // Az aktuális és a következő évet is lekérjük (éves határ közelében)
                const [currentYearHolidays, nextYearHolidays] = await Promise.all([
                    fetchHolidays(currentYear),
                    fetchHolidays(currentYear + 1)
                ]);

                if (!cancelled) {
                    // Összefésüljük a két évet egyetlen Set-be
                    const merged = new Set([...currentYearHolidays, ...nextYearHolidays]);
                    setHolidays(merged);
                }
            } catch (error) {
                logWarn("[useUrgency] Ünnepnapok betöltése sikertelen:", error.message);
            }
        };

        loadHolidays();
        return () => { cancelled = true; };
    }, []);

    // Sürgősség kiszámítása + percenkénti frissítés
    useEffect(() => {
        const recalculate = () => {
            if (!articles?.length || !deadlines?.length) {
                setUrgencyMap(new Map());
                return;
            }

            const newMap = new Map();
            for (const article of articles) {
                const result = calculateUrgencyRatio(article, deadlines, {
                    holidays,
                    excludeWeekends
                });
                if (result) {
                    newMap.set(article.$id, result);
                }
            }
            setUrgencyMap(newMap);
        };

        // Azonnali számítás
        recalculate();

        // Percenkénti frissítés
        intervalRef.current = setInterval(recalculate, REFRESH_INTERVAL_MS);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [articles, deadlines, holidays, excludeWeekends]);

    return urgencyMap;
};
