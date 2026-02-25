/**
 * Sürgősség-számítás segédfüggvények.
 *
 * Kiszámítja, hogy egy cikk mennyire sürgős a jelenlegi státusza,
 * a hátralévő státuszok becsült időtartama és a lapzárta alapján.
 * Figyelembe veszi a munkaidőt (9–17), hétvégéket és ünnepnapokat.
 */

import { WORKFLOW_STATES, STATE_DURATIONS, MARKERS } from "./workflow/workflowConstants.js";
import { logWarn } from "./logger.js";

// ─── Konstansok ─────────────────────────────────────────────────────────────

/** Munkanap kezdete (óra) */
const WORK_START_HOUR = 9;

/** Munkanap vége (óra) */
const WORK_END_HOUR = 17;

/** Egy teljes munkanap percben */
const MINUTES_PER_WORKDAY = (WORK_END_HOUR - WORK_START_HOUR) * 60; // 480

/** Nager.at API alap URL */
const HOLIDAYS_API_BASE = "https://date.nager.at/api/v3/publicholidays";

// ─── Ünnepnap cache ─────────────────────────────────────────────────────────

/**
 * Évenkénti ünnepnap cache.
 * Kulcs: év (number), érték: Set<string> (YYYY-MM-DD formátumú dátumok).
 * @type {Map<number, Set<string>>}
 */
const holidayCache = new Map();

/**
 * Folyamatban lévő lekérések cache-e (deduplikáció).
 * @type {Map<number, Promise<Set<string>>>}
 */
const pendingFetches = new Map();

// ─── Ünnepnap-kezelés ──────────────────────────────────────────────────────

/**
 * Lekéri a magyar munkaszüneti napokat a nager.at API-ról.
 * Az eredményt memóriában cache-eli évenként.
 * Párhuzamos hívásokat deduplikálja (ugyanarra az évre csak egy fetch fut).
 *
 * @param {number} year - Az év (pl. 2026)
 * @returns {Promise<Set<string>>} Set YYYY-MM-DD formátumú dátumokkal
 */
export const fetchHolidays = async (year) => {
    // Cache hit
    if (holidayCache.has(year)) {
        return holidayCache.get(year);
    }

    // Deduplikáció — ha már fut lekérés erre az évre, megvárjuk
    if (pendingFetches.has(year)) {
        return pendingFetches.get(year);
    }

    const fetchPromise = (async () => {
        try {
            const response = await fetch(`${HOLIDAYS_API_BASE}/${year}/HU`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            const holidays = new Set(data.map(h => h.date));
            holidayCache.set(year, holidays);
            return holidays;
        } catch (error) {
            logWarn(`[urgencyUtils] Ünnepnapok lekérése sikertelen (${year}):`, error.message);
            // Fallback: üres set — csak hétvégéket hagyja ki
            const emptySet = new Set();
            holidayCache.set(year, emptySet);
            return emptySet;
        } finally {
            pendingFetches.delete(year);
        }
    })();

    pendingFetches.set(year, fetchPromise);
    return fetchPromise;
};

/**
 * Ellenőrzi, hogy egy adott dátum ünnepnap-e.
 *
 * @param {Date} date - Az ellenőrizendő dátum
 * @param {Set<string>} holidays - Ünnepnapok set-je (YYYY-MM-DD)
 * @returns {boolean}
 */
const isHoliday = (date, holidays) => {
    if (!holidays || holidays.size === 0) return false;
    const key = formatDateKey(date);
    return holidays.has(key);
};

/**
 * Date objektumot YYYY-MM-DD stringgé alakít.
 *
 * @param {Date} date
 * @returns {string}
 */
const formatDateKey = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
};

// ─── Munkaidő-számítás ─────────────────────────────────────────────────────

/**
 * Meghatározza, hogy egy nap munkanap-e (nem hétvége, nem ünnepnap).
 *
 * @param {Date} date - Az ellenőrizendő dátum
 * @param {Object} options
 * @param {Set<string>} options.holidays - Ünnepnapok set-je
 * @param {boolean} options.excludeWeekends - Hétvégéket kihagyja-e
 * @returns {boolean}
 */
const isWorkday = (date, { holidays, excludeWeekends }) => {
    const day = date.getDay();
    if (excludeWeekends && (day === 0 || day === 6)) return false;
    if (isHoliday(date, holidays)) return false;
    return true;
};

/**
 * Kiszámítja a rendelkezésre álló munkaidő perceket két időpont között.
 *
 * Szabályok:
 * - Munkaidő: 9:00–17:00 (480 perc/munkanap)
 * - Ha excludeWeekends true: szombat/vasárnap kihagyva
 * - Ünnepnapok kihagyva
 * - Résznapoknál pontos percszámítás
 *
 * @param {Date} fromDate - Kezdő időpont
 * @param {Date} toDate - Végső időpont (deadline)
 * @param {Object} options
 * @param {Set<string>} options.holidays - Ünnepnapok set-je
 * @param {boolean} options.excludeWeekends - Hétvégéket kihagyja-e
 * @returns {number} Rendelkezésre álló munkaidő percben (0 ha lejárt)
 */
export const calculateWorkingMinutes = (fromDate, toDate, { holidays, excludeWeekends }) => {
    if (fromDate >= toDate) return 0;

    let totalMinutes = 0;

    // Iterálás naponként
    const current = new Date(fromDate);
    current.setHours(0, 0, 0, 0);

    const endDay = new Date(toDate);
    endDay.setHours(0, 0, 0, 0);

    while (current <= endDay) {
        if (isWorkday(current, { holidays, excludeWeekends })) {
            const isSameAsFrom = formatDateKey(current) === formatDateKey(fromDate);
            const isSameAsTo = formatDateKey(current) === formatDateKey(toDate);

            // Munkanap kezdete és vége percben (az adott napra)
            let dayStart = WORK_START_HOUR * 60; // 540
            let dayEnd = WORK_END_HOUR * 60;     // 1020

            // Ha ez a kezdőnap, a tényleges kezdési időpontot vesszük
            if (isSameAsFrom) {
                const fromMinutes = fromDate.getHours() * 60 + fromDate.getMinutes();
                dayStart = Math.max(dayStart, fromMinutes);
            }

            // Ha ez a végső nap, a tényleges végső időpontot vesszük
            if (isSameAsTo) {
                const toMinutes = toDate.getHours() * 60 + toDate.getMinutes();
                dayEnd = Math.min(dayEnd, toMinutes);
            }

            // Csak pozitív tartomány számít
            if (dayEnd > dayStart) {
                totalMinutes += dayEnd - dayStart;
            }
        }

        // Következő nap
        current.setDate(current.getDate() + 1);
    }

    return totalMinutes;
};

// ─── Sürgősség-számítás ─────────────────────────────────────────────────────

/**
 * Kiszámítja a jelenlegi státusztól a PRINTABLE-ig hátralévő összes
 * szükséges munkaidőt percben (a jelenlegi státusz idejét is beleértve).
 *
 * Formula: állapot idő = perPage × oldalszám + fixed
 *
 * @param {number} currentState - A cikk jelenlegi workflow állapota
 * @param {number} pageCount - A cikk oldalainak száma (minimum 1)
 * @returns {number} Összes hátralévő munkaidő percben
 */
export const calculateRemainingWorkMinutes = (currentState, pageCount) => {
    const pages = Math.max(1, pageCount || 1);
    let total = 0;
    for (let state = currentState; state <= WORKFLOW_STATES.PRINTABLE; state++) {
        const duration = STATE_DURATIONS[state];
        if (duration) {
            total += duration.perPage * pages + duration.fixed;
        }
    }
    return total;
};

/**
 * Megkeresi a cikkhez tartozó legkorábbi deadline-t az oldalszám-tartomány alapján.
 * A cikk startPage-jét illeszti a deadline tartományokra.
 * Ha több deadline is lefedi a cikk oldalait, a legkorábbi datetime-ot választja.
 *
 * @param {Object} article - A cikk objektum (startPage szükséges)
 * @param {Array} deadlines - A kiadvány deadline-jainak tömbje
 * @returns {Object|null} A legkorábbi matching deadline objektum, vagy null
 */
export const getArticleDeadline = (article, deadlines) => {
    if (!article?.startPage || !deadlines?.length) return null;

    const matching = deadlines.filter(d =>
        d.startPage != null &&
        d.endPage != null &&
        article.startPage >= d.startPage &&
        article.startPage <= d.endPage
    );

    if (matching.length === 0) return null;
    if (matching.length === 1) return matching[0];

    // Több találat esetén a legkorábbi datetime-ot választjuk
    return matching.reduce((earliest, d) => {
        if (!earliest?.datetime) return d;
        if (!d?.datetime) return earliest;
        return new Date(d.datetime) < new Date(earliest.datetime) ? d : earliest;
    }, null);
};

/**
 * Kiszámítja egy cikk sürgősségi arányát.
 *
 * @param {Object} article - A cikk objektum
 * @param {Array} deadlines - A kiadvány deadline-jai
 * @param {Object} options
 * @param {Set<string>} options.holidays - Ünnepnapok set-je
 * @param {boolean} options.excludeWeekends - Hétvégéket kihagyja-e
 * @returns {{ ratio: number, color: string|null }|null} Sürgősségi adatok, vagy null
 */
export const calculateUrgencyRatio = (article, deadlines, { holidays, excludeWeekends }) => {
    // ARCHIVABLE vagy IGNORE markeres cikk → nincs sürgősség
    if (article.state === WORKFLOW_STATES.ARCHIVABLE) return null;
    if ((article.markers & MARKERS.IGNORE) !== 0) return null;

    // Deadline keresése
    const deadline = getArticleDeadline(article, deadlines);
    if (!deadline?.datetime) return null;

    // Cikk oldalszáma
    const pageCount = (article.startPage && article.endPage)
        ? article.endPage - article.startPage + 1
        : 1;

    // Hátralévő szükséges munkaidő (oldalszám-alapú)
    const remainingMinutes = calculateRemainingWorkMinutes(article.state ?? 0, pageCount);
    if (remainingMinutes === 0) return null;

    // Elérhető munkaidő a deadline-ig
    const now = new Date();
    const deadlineDate = new Date(deadline.datetime);
    const availableMinutes = calculateWorkingMinutes(now, deadlineDate, { holidays, excludeWeekends });

    // Ratio kiszámítása
    const ratio = availableMinutes > 0
        ? remainingMinutes / availableMinutes
        : Infinity; // Lejárt deadline

    return {
        ratio,
        background: getUrgencyBackground(ratio)
    };
};

// ─── 20 lépcsős színskála ──────────────────────────────────────────────────

/**
 * 20 lépcsős szín tábla — citromsárgától tűzvörösig.
 * Minden lépcső egy RGBA string.
 * @type {string[]}
 */
const URGENCY_COLORS = [
    "rgba(255, 255, 0, 0.03)",   //  1 — Halvány citromsárga
    "rgba(255, 240, 0, 0.06)",   //  2
    "rgba(255, 225, 0, 0.09)",   //  3 — Meleg sárga
    "rgba(255, 210, 0, 0.12)",   //  4
    "rgba(255, 195, 0, 0.15)",   //  5 — Arany
    "rgba(255, 180, 0, 0.18)",   //  6
    "rgba(255, 165, 0, 0.21)",   //  7 — Világos narancs
    "rgba(255, 150, 0, 0.24)",   //  8
    "rgba(255, 135, 0, 0.27)",   //  9 — Narancssárga
    "rgba(255, 120, 0, 0.30)",   // 10 — Félúton
    "rgba(255, 105, 0, 0.33)",   // 11 — Erős narancs
    "rgba(255, 90, 0, 0.36)",    // 12
    "rgba(255, 75, 0, 0.39)",    // 13 — Narancsvörös
    "rgba(255, 60, 0, 0.42)",    // 14
    "rgba(255, 45, 0, 0.45)",    // 15 — Világos vörös
    "rgba(255, 30, 0, 0.48)",    // 16
    "rgba(255, 15, 0, 0.51)",    // 17 — Tűzvörös
    "rgba(255, 5, 0, 0.54)",     // 18
    "rgba(255, 0, 0, 0.57)",     // 19 — Mély vörös
    "rgba(255, 0, 0, 0.60)"      // 20 — Maximum fedés (60%)
];

/**
 * Sürgősségi arány alapján progresszív háttér-gradienst ad vissza.
 *
 * A szín és a sáv szélessége is a ratio-tól függ:
 * - ratio < küszöb (pl. 0.05) → null (nincs vizuális jelzés)
 * - ratio = 0.05 → 1. szín, a sáv a sor 5%-át fedi le (balról)
 * - ratio = 0.5 → 10. szín, a sáv a sor 50%-át fedi le
 * - ratio = 1.0 → 20. szín, a sáv a sor 100%-át fedi le
 * - ratio > 1.0 → 20. szín, teljes fedés (vörös)
 *
 * @param {number} ratio - Sürgősségi arány (remainingWork / availableTime)
 * @returns {string|null} CSS background érték (linear-gradient), vagy null
 */
export const getUrgencyBackground = (ratio) => {
    if (ratio < 0.05) return null;

    // Ratio clampolása 0–1 tartományba (1 felett is teljes fedés)
    const clamped = Math.min(ratio, 1.0);

    // Szín index: 0–19 (20 lépcső)
    const colorIndex = Math.min(
        Math.floor(clamped * URGENCY_COLORS.length),
        URGENCY_COLORS.length - 1
    );
    const color = URGENCY_COLORS[colorIndex];

    // Sáv szélessége: a ratio százalékban (5%–100%)
    const widthPercent = Math.round(clamped * 100);

    // Balról jobbra növekvő sáv: szín → átlátszó
    return `linear-gradient(to right, ${color} 0%, ${color} ${widthPercent}%, transparent ${widthPercent}%)`;
};
