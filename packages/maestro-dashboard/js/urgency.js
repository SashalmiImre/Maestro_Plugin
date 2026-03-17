/**
 * Maestro Dashboard — Sürgősség-számítás
 *
 * A tényleges logika a maestro-shared/urgency.js-ben van.
 * Ez a fájl re-exportálja a shared függvényeket és hozzáadja
 * a dashboard-specifikus calculateUrgencyMap batch számítást.
 */

export {
    fetchHolidays,
    calculateWorkingMinutes,
    calculateRemainingWorkMinutes,
    getArticleDeadline,
    calculateUrgencyRatio,
    getUrgencyBackground,
    URGENCY_COLORS
} from '../shared/urgency.js';

import { fetchHolidays, calculateUrgencyRatio } from '../shared/urgency.js';

/**
 * Kiszámítja az összes cikk sürgősségi adatát.
 *
 * @param {Array} articles
 * @param {Array} deadlines
 * @returns {Promise<Map<string, { ratio: number, background: string|null }>>}
 */
export async function calculateUrgencyMap(articles, deadlines) {
    const map = new Map();
    if (!articles.length || !deadlines.length) return map;

    // Ünnepnapok lekérése (aktuális + következő év)
    const now = new Date();
    const years = new Set([now.getFullYear(), now.getFullYear() + 1]);
    const holidaySets = await Promise.all([...years].map(y => fetchHolidays(y)));

    // Egyesített ünnepnap Set
    const holidays = new Set();
    for (const set of holidaySets) {
        if (set) for (const h of set) holidays.add(h);
    }

    for (const article of articles) {
        const result = calculateUrgencyRatio(article, deadlines, { holidays, excludeWeekends: true });
        if (result) {
            map.set(article.$id, result);
        }
    }

    return map;
}
