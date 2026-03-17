/**
 * Maestro Shared — Sürgősség-számítás
 *
 * Platform-független tiszta függvények a cikkek sürgősségének kiszámításához.
 * Figyelembe veszi a munkaidőt (9–17), hétvégéket és ünnepnapokat.
 */

import { WORKFLOW_STATES, STATE_DURATIONS, MARKERS } from './workflowConfig.js';

// ─── Konstansok ─────────────────────────────────────────────────────────────

/** Munkanap kezdete (óra) */
const WORK_START_HOUR = 9;

/** Munkanap vége (óra) */
const WORK_END_HOUR = 17;

/** Nager.at API alap URL */
const HOLIDAYS_API_BASE = 'https://date.nager.at/api/v3/publicholidays';

// ─── Ünnepnap cache ─────────────────────────────────────────────────────────

/** @type {Map<number, Set<string>>} */
const holidayCache = new Map();

/** @type {Map<number, Promise<Set<string>>>} */
const pendingFetches = new Map();

// ─── Ünnepnap-kezelés ──────────────────────────────────────────────────────

/**
 * Lekéri a magyar munkaszüneti napokat a nager.at API-ról.
 * Az eredményt memóriában cache-eli évenként.
 *
 * @param {number} year
 * @returns {Promise<Set<string>|null>}
 */
export async function fetchHolidays(year) {
    if (holidayCache.has(year)) return holidayCache.get(year);
    if (pendingFetches.has(year)) return pendingFetches.get(year);

    const promise = (async () => {
        try {
            const response = await fetch(`${HOLIDAYS_API_BASE}/${year}/HU`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const holidays = new Set(data.map(h => h.date));
            holidayCache.set(year, holidays);
            return holidays;
        } catch (error) {
            console.error(`fetchHolidays(${year}) failed: ${HOLIDAYS_API_BASE}/${year}/HU`, {
                error: error?.message || error
            });
            return null;
        } finally {
            pendingFetches.delete(year);
        }
    })();

    pendingFetches.set(year, promise);
    return promise;
}

/**
 * Date objektumot YYYY-MM-DD stringgé alakít.
 * @param {Date} date
 * @returns {string}
 */
function formatDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * @param {Date} date
 * @param {Set<string>} holidays
 * @returns {boolean}
 */
function isHoliday(date, holidays) {
    if (!holidays || holidays.size === 0) return false;
    return holidays.has(formatDateKey(date));
}

/**
 * Meghatározza, hogy egy nap munkanap-e.
 * @param {Date} date
 * @param {Object} options
 * @param {Set<string>} options.holidays
 * @param {boolean} options.excludeWeekends
 * @returns {boolean}
 */
function isWorkday(date, { holidays, excludeWeekends }) {
    const day = date.getDay();
    if (excludeWeekends && (day === 0 || day === 6)) return false;
    if (isHoliday(date, holidays)) return false;
    return true;
}

// ─── Munkaidő-számítás ─────────────────────────────────────────────────────

/**
 * Kiszámítja a rendelkezésre álló munkaidő perceket két időpont között.
 *
 * @param {Date} fromDate
 * @param {Date} toDate
 * @param {Object} options
 * @param {Set<string>} options.holidays
 * @param {boolean} options.excludeWeekends
 * @returns {number}
 */
export function calculateWorkingMinutes(fromDate, toDate, { holidays, excludeWeekends }) {
    if (fromDate >= toDate) return 0;

    let totalMinutes = 0;
    const current = new Date(fromDate);
    current.setHours(0, 0, 0, 0);

    const endDay = new Date(toDate);
    endDay.setHours(0, 0, 0, 0);

    while (current <= endDay) {
        if (isWorkday(current, { holidays, excludeWeekends })) {
            const isSameAsFrom = formatDateKey(current) === formatDateKey(fromDate);
            const isSameAsTo = formatDateKey(current) === formatDateKey(toDate);

            let dayStart = WORK_START_HOUR * 60;
            let dayEnd = WORK_END_HOUR * 60;

            if (isSameAsFrom) {
                const fromMinutes = fromDate.getHours() * 60 + fromDate.getMinutes();
                dayStart = Math.max(dayStart, fromMinutes);
            }

            if (isSameAsTo) {
                const toMinutes = toDate.getHours() * 60 + toDate.getMinutes();
                dayEnd = Math.min(dayEnd, toMinutes);
            }

            if (dayEnd > dayStart) {
                totalMinutes += dayEnd - dayStart;
            }
        }
        current.setDate(current.getDate() + 1);
    }

    return totalMinutes;
}

// ─── Sürgősség-számítás ─────────────────────────────────────────────────────

/**
 * Kiszámítja a jelenlegi státusztól a PRINTABLE-ig hátralévő munkaidőt.
 *
 * @param {number} currentState
 * @param {number} pageCount
 * @returns {number} Percben
 */
export function calculateRemainingWorkMinutes(currentState, pageCount) {
    const pages = Math.max(1, pageCount || 1);
    let total = 0;
    for (let state = currentState; state <= WORKFLOW_STATES.PRINTABLE; state++) {
        const duration = STATE_DURATIONS[state];
        if (duration) {
            total += duration.perPage * pages + duration.fixed;
        }
    }
    return total;
}

/**
 * Megkeresi a cikkhez tartozó legkorábbi deadline-t.
 *
 * @param {Object} article
 * @param {Array} deadlines
 * @returns {Object|null}
 */
export function getArticleDeadline(article, deadlines) {
    if (!article?.startPage || !deadlines?.length) return null;

    const matching = deadlines.filter(d =>
        d.startPage != null && d.endPage != null &&
        article.startPage >= d.startPage && article.startPage <= d.endPage
    );

    if (matching.length === 0) return null;
    if (matching.length === 1) return matching[0];

    return matching.reduce((earliest, d) => {
        if (!earliest?.datetime) return d;
        if (!d?.datetime) return earliest;
        return new Date(d.datetime) < new Date(earliest.datetime) ? d : earliest;
    }, null);
}

// ─── 20 lépcsős színskála ───────────────────────────────────────────────────

/**
 * 20 lépcsős szín tábla — citromsárgától tűzvörösig.
 * @type {string[]}
 */
export const URGENCY_COLORS = [
    'rgba(255, 255, 0, 0.01)',
    'rgba(255, 240, 0, 0.02)',
    'rgba(255, 225, 0, 0.03)',
    'rgba(255, 210, 0, 0.04)',
    'rgba(255, 195, 0, 0.05)',
    'rgba(255, 180, 0, 0.06)',
    'rgba(255, 165, 0, 0.07)',
    'rgba(255, 150, 0, 0.08)',
    'rgba(255, 135, 0, 0.09)',
    'rgba(255, 120, 0, 0.10)',
    'rgba(255, 105, 0, 0.11)',
    'rgba(255, 90, 0, 0.12)',
    'rgba(255, 75, 0, 0.13)',
    'rgba(255, 60, 0, 0.14)',
    'rgba(255, 45, 0, 0.15)',
    'rgba(255, 30, 0, 0.16)',
    'rgba(255, 15, 0, 0.17)',
    'rgba(255, 5, 0, 0.18)',
    'rgba(255, 0, 0, 0.19)',
    'rgba(255, 0, 0, 0.20)'
];

/**
 * Sürgősségi arány → CSS háttér gradient.
 *
 * @param {number} ratio
 * @returns {string|null}
 */
export function getUrgencyBackground(ratio) {
    if (ratio < 0.05) return null;

    const clamped = Math.min(ratio, 1.0);
    const colorIndex = Math.min(
        Math.floor(clamped * URGENCY_COLORS.length),
        URGENCY_COLORS.length - 1
    );
    const color = URGENCY_COLORS[colorIndex];
    const widthPercent = Math.round(clamped * 100);

    return `linear-gradient(to right, ${color} 0%, ${color} ${widthPercent}%, transparent ${widthPercent}%)`;
}

/**
 * Kiszámítja egy cikk sürgősségi arányát.
 *
 * @param {Object} article
 * @param {Array} deadlines
 * @param {Object} options
 * @param {Set<string>} options.holidays
 * @param {boolean} options.excludeWeekends
 * @returns {{ ratio: number, background: string|null }|null}
 */
export function calculateUrgencyRatio(article, deadlines, { holidays, excludeWeekends }) {
    if (article.state === WORKFLOW_STATES.ARCHIVABLE) return null;
    if ((article.markers & MARKERS.IGNORE) !== 0) return null;

    const deadline = getArticleDeadline(article, deadlines);
    if (!deadline?.datetime) return null;

    const pageCount = (article.startPage && article.endPage)
        ? article.endPage - article.startPage + 1
        : 1;

    const remainingMinutes = calculateRemainingWorkMinutes(article.state ?? 0, pageCount);
    if (remainingMinutes === 0) return null;

    const now = new Date();
    const deadlineDate = new Date(deadline.datetime);
    const availableMinutes = calculateWorkingMinutes(now, deadlineDate, { holidays, excludeWeekends });

    const ratio = availableMinutes > 0
        ? remainingMinutes / availableMinutes
        : Infinity;

    return { ratio, background: getUrgencyBackground(ratio) };
}
