/**
 * Maestro Dashboard — Sürgősség hook
 *
 * Batch sürgősség-számítás 5 perces újraszámítással.
 */

import { useState, useEffect, useRef } from 'react';
import { fetchHolidays, calculateUrgencyRatio } from '@shared/urgency.js';
import { URGENCY_REFRESH_INTERVAL_MS } from '../config.js';

/**
 * Kiszámítja az összes cikk sürgősségi adatát.
 * @param {Array} articles
 * @param {Array} deadlines
 * @returns {{ urgencyMap: Map, isCalculating: boolean }}
 */
export function useUrgency(articles, deadlines) {
    const [urgencyMap, setUrgencyMap] = useState(() => new Map());
    const [isCalculating, setIsCalculating] = useState(false);
    const generationRef = useRef(0);

    useEffect(() => {
        let cancelled = false;
        const generation = ++generationRef.current;

        async function calculate() {
            if (!Array.isArray(articles) || !Array.isArray(deadlines) ||
                !articles.length || !deadlines.length) {
                setUrgencyMap(new Map());
                return;
            }

            setIsCalculating(true);

            try {
                const now = new Date();
                const years = new Set([now.getFullYear(), now.getFullYear() + 1]);
                const holidaySets = await Promise.all([...years].map(y => fetchHolidays(y)));

                if (cancelled || generation !== generationRef.current) return;

                const holidays = new Set();
                for (const set of holidaySets) {
                    if (set) for (const h of set) holidays.add(h);
                }

                const map = new Map();
                for (const article of articles) {
                    const result = calculateUrgencyRatio(article, deadlines, {
                        holidays, excludeWeekends: true
                    });
                    if (result) map.set(article.$id, result);
                }

                if (!cancelled && generation === generationRef.current) {
                    setUrgencyMap(map);
                }
            } finally {
                if (!cancelled && generation === generationRef.current) {
                    setIsCalculating(false);
                }
            }
        }

        calculate();

        // 5 perces újraszámítás
        const interval = setInterval(calculate, URGENCY_REFRESH_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [articles, deadlines]);

    return { urgencyMap, isCalculating };
}
