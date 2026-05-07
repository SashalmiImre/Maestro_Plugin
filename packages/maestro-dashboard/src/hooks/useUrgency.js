/**
 * Maestro Dashboard — Sürgősség hook
 *
 * Batch sürgősség-számítás 5 perces újraszámítással.
 *
 * 2026-05-07 fix (#1): a `calculateUrgencyRatio` szignatúrája 4 paraméteres
 * (`article, deadlines, workflow, options`). A korábbi hívás csak 3 argot
 * adott át — emiatt az options helyére `undefined` került, és a függvény
 * belsejében a `{ holidays, excludeWeekends }` destructure egy folyamatosan
 * dobódó `Cannot destructure property 'holidays' of 'undefined'` errort
 * produkált minden cikkre, minden 5 perces tickre.
 *
 * 2026-05-07 fix (#2, Codex stop-time review): az `excludeWeekends` nem
 * hardcode-olható `true`-ra. A publikáció `excludeWeekends` mezője a
 * sürgősség-számítás bemenete (a felhasználó a CreatePublicationModal /
 * GeneralTab-on állítja). A hardcode azt eredményezné, hogy a hétvégét
 * mindenképp kihagynánk — még akkor is, ha a kiadvány explicit kapcsolja.
 * A Plugin (`maestro-indesign/.../useUrgency.js`) már a publikáció mezőjéből
 * olvas (`publication?.excludeWeekends ?? true`); a Dashboard is ezt teszi.
 */

import { useState, useEffect, useRef } from 'react';
import { fetchHolidays, calculateUrgencyRatio } from '@shared/urgency.js';
import { URGENCY_REFRESH_INTERVAL_MS } from '../config.js';

/**
 * Kiszámítja az összes cikk sürgősségi adatát.
 * @param {Array} articles
 * @param {Array} deadlines
 * @param {Object|null} workflow - Compiled workflow JSON (DataContext.workflow).
 *   Ha null, az `urgencyMap` üres marad — a `calculateUrgencyRatio` szigorú
 *   `if (!workflow) return null` guard-ja minden cikkre null-t adna.
 * @param {Object|null} publication - Az aktív kiadvány doc (excludeWeekends).
 *   Ha null vagy a mező hiányzik → default `true` (hétvégét kihagyjuk a
 *   sürgősségből), egyezés a Plugin szemantikával + a publications schema
 *   default-jával.
 * @returns {{ urgencyMap: Map, isCalculating: boolean }}
 */
export function useUrgency(articles, deadlines, workflow, publication) {
    const [urgencyMap, setUrgencyMap] = useState(() => new Map());
    const [isCalculating, setIsCalculating] = useState(false);
    const generationRef = useRef(0);

    const excludeWeekends = publication?.excludeWeekends ?? true;

    useEffect(() => {
        let cancelled = false;
        const generation = ++generationRef.current;

        async function calculate() {
            // Early-return guard: workflow nélkül a `calculateUrgencyRatio`
            // null-t adna minden cikkre, így felesleges a holiday-fetch.
            if (!workflow ||
                !Array.isArray(articles) || !Array.isArray(deadlines) ||
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
                    const result = calculateUrgencyRatio(article, deadlines, workflow, {
                        holidays, excludeWeekends
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
    }, [articles, deadlines, workflow, excludeWeekends]);

    return { urgencyMap, isCalculating };
}
