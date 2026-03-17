/**
 * Sürgősség-számítás segédfüggvények.
 *
 * A tényleges logika a maestro-shared/urgency.js-ben van.
 * Ez a fájl re-exportálja a shared függvényeket, hogy a plugin
 * fogyasztók importjai ne változzanak.
 */

export {
    fetchHolidays,
    calculateWorkingMinutes,
    calculateRemainingWorkMinutes,
    getArticleDeadline,
    calculateUrgencyRatio,
    getUrgencyBackground,
    URGENCY_COLORS
} from "maestro-shared/urgency.js";
