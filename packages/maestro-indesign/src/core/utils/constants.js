/**
 * @fileoverview Alkalmazás szintű konstansok.
 * Tartalmazza a konfigurációs értékeket, tároló kulcsokat és hálózati beállításokat.
 * 
 * @module utils/constants
 */

// InDesign Scripting API Konstans
// Ez a konstans jelöli a JavaScript nyelvet az InDesign `doScript` metódusában.
export const SCRIPT_LANGUAGE_JAVASCRIPT = 1246973031;

// LocalStorage Kulcsok
// Az alkalmazás állapotának mentéséhez használt kulcsok.
export const STORAGE_KEYS = {
    EXPANDED_PUBLICATION_ID: "maestro.expandedPublicationId", // Kinyitott kiadvány ID-ja
    HIDE_RESOLVED_MESSAGES: "maestro.hideResolvedMessages",   // Megoldott üzenetek elrejtése
    SECTION_ARTICLE_GENERAL_COLLAPSED: "maestro.section.article.general.collapsed",             // Cikk általános szekció
    SECTION_ARTICLE_MESSAGES_COLLAPSED: "maestro.section.article.messages.collapsed",           // Cikk üzenetek szekció
    SECTION_ARTICLE_CONTRIBUTORS_COLLAPSED: "maestro.section.article.contributors.collapsed",   // Cikk közreműködők szekció
    SECTION_ARTICLE_VALIDATION_COLLAPSED: "maestro.section.article.validation.collapsed",       // Cikk validáció szekció
    SECTION_PUBLICATION_GENERAL_COLLAPSED: "maestro.section.publication.general.collapsed",           // Kiadvány általános szekció
    SECTION_PUBLICATION_LAYOUTS_COLLAPSED: "maestro.section.publication.layouts.collapsed",           // Kiadvány elrendezések szekció
    SECTION_PUBLICATION_CONTRIBUTORS_COLLAPSED: "maestro.section.publication.contributors.collapsed", // Kiadvány munkatársak szekció
    SECTION_PUBLICATION_DEADLINES_COLLAPSED: "maestro.section.publication.deadlines.collapsed"        // Kiadvány határidők szekció
};

// Útvonal Konfiguráció
export const PC_DRIVE_LETTER = "Z:"; // A hálózati meghajtó betűjele Windowson

// =============================================================================
// Dokumentum Zárolás (Lock) Típusok
// =============================================================================

/**
 * Zárolás típusok enum.
 * USER: Felhasználó által szerkesztett dokumentum
 * SYSTEM: Maestro háttérművelet (validálás, export)
 */
export const LOCK_TYPE = {
    USER: "user",
    SYSTEM: "system"
};



// =============================================================================
// Kapcsolat és Hálózat Konfiguráció
// =============================================================================

/**
 * Kapcsolat állapotok enum.
 */
export const CONNECTION_STATES = {
    UNKNOWN: 'unknown',           // Ismeretlen állapot
    CONNECTED: 'connected',       // Csatlakozva
    CONNECTING: 'connecting',     // Csatlakozás folyamatban
    DISCONNECTED: 'disconnected', // Szétkapcsolva
    RECONNECTING: 'reconnecting'  // Újracsatlakozás
};

/**
 * Kapcsolat időzítések és konfigurációs értékek.
 */
export const CONNECTION_CONFIG = {
    // Alvó/Ébrenlét detektálás (IdleTask)
    IDLE_CHECK_INTERVAL_MS: 15000,  // Ellenőrzés gyakorisága
    SLEEP_THRESHOLD_MS: 60000,      // Küszöbérték, ami felett alvásnak tekintjük a szünetet (1 perc)

    // Realtime kapcsolat elavultsági küszöb
    // Az Appwrite heartbeat ~30s → ha 45s-nél régebbi az utolsó WS üzenet, a TCP valószínűleg halott
    REALTIME_STALENESS_MS: 45000,

    // Realtime kapcsolat ellenőrzése
    RECONNECT_CHECK_MS: 30000      // 30mp fallback - az alvás detektálás kezeli az azonnali helyreállítást
};

// =============================================================================
// DocumentMonitor Lock Wait Konfiguráció
// =============================================================================

/**
 * Fájl zárolás várakozási beállításai.
 * A háttér validálás során az InDesign fájl zárolásának feloldására várakozunk.
 */
export const LOCK_WAIT_CONFIG = {
    TIMEOUT_MS: 5000,        // Maximum várakozási idő (5 másodperc)
    POLL_INTERVAL_MS: 500    // Ellenőrzés gyakorisága (500ms)
};

// =============================================================================
// Újrapróbálkozás (Retry) Konfiguráció
// =============================================================================

/**
 * Átmeneti szerverhiba (502, 503, 504) és hálózati hiba esetén használt
 * exponenciális backoff beállítások.
 */
export const RETRY_CONFIG = {
    MAX_ATTEMPTS: 3,        // Maximum próbálkozások száma (eredeti + 2 újrapróbálás)
    BASE_DELAY_MS: 1000     // Alap késleltetés milliszekundumban (1s → 2s → 4s)
};

// =============================================================================
// Meghajtó-elérhetőség Ellenőrzés
// =============================================================================

/**
 * Ha a kiadvány rootPath mappája nem elérhető (pl. VPN lekapcsolódott),
 * ennyi időnként ellenőrizzük újra, hogy visszajött-e.
 * A polling automatikusan leáll, ha a meghajtó elérhető.
 */
export const DRIVE_CHECK_INTERVAL_MS = 2000; // 2 másodperc

// =============================================================================
// Központi Recovery Konfiguráció
// =============================================================================

/**
 * A RecoveryManager konfigurációja.
 * Ez a központi helyreállítás-kezelő koordinálja az összes recovery trigger-t
 * (online, sleep, focus, realtime disconnect).
 */
export const RECOVERY_CONFIG = {
    DEBOUNCE_MS: 5000,          // Két recovery között minimum várakozás (5s)
    HEALTH_TIMEOUT_MS: 5000,    // Health check kérés timeout (5s — Railway ~0.5s, emago fallback egyetlen próba)
    MAX_RETRIES: 3,             // Maximum health check próbálkozás az aktív endpoint-on
    RETRY_BASE_MS: 1500         // Backoff alap (1.5s → 3s → 6s)
    // Worst case: aktív 3×5s + 1.5s + 3s = 19.5s, + fallback 1×5s = 24.5s
};

/**
 * Recovery trigger azonosítók enum.
 * A recoveryManager.requestRecovery() hívások trigger paramétere.
 *
 * @enum {string}
 */
export const RECOVERY_TRIGGERS = {
    ONLINE: 'online',     // Browser online esemény
    SLEEP: 'sleep',       // InDesign alvás/ébresztés
    FOCUS: 'focus',       // Ablak fókusz visszatérés
    REALTIME: 'realtime'  // Realtime WebSocket disconnect
};

// =============================================================================
// Toast Értesítés Típusok
// =============================================================================

/**
 * Toast értesítés típusok enum.
 * Meghatározza a toast üzenetek megjelenési stílusát (szín, ikon).
 *
 * @enum {string}
 */
export const TOAST_TYPES = {
    SUCCESS: 'success',   // Sikeres művelet (zöld)
    ERROR: 'error',       // Hiba (piros)
    INFO: 'info',         // Információ (kék)
    WARNING: 'warning',   // Figyelmeztetés (narancs)
    NEGATIVE: 'negative'  // Kritikus figyelmeztetés
};

// =============================================================================
// UI Időzítési Konfiguráció
// =============================================================================

/**
 * UI időzítési értékek (milliszekundum).
 * Animációk, debounce-ok, auto-dismiss timeout-ok.
 */
export const UI_TIMING = {
    AUTH_MESSAGE_DISMISS_MS: 5000,           // Login/Register hibaüzenet eltűnés
    REGISTRATION_REDIRECT_DELAY_MS: 3000,   // Regisztráció siker → Login átváltás
    TOAST_EXIT_ANIMATION_MS: 300,           // Toast kilépési animáció idő
    TOAST_DEFAULT_DURATION_MS: 5000,        // Toast alapértelmezett megjelenítési idő
    TOAST_ERROR_DURATION_MS: 6000,          // Hibás toast (részletekkel) megjelenítési idő
    CONNECTION_RESTORED_MESSAGE_MS: 2000,   // "Kapcsolat helyreállt" üzenet időtartam
    CLICK_DEBOUNCE_MS: 250,                 // Kattintás debounce (dupla kattintás elkerülés)
    VALIDATION_DEBOUNCE_MS: 300             // Validációs mező debounce
};

// =============================================================================
// Adatlekérési Konfiguráció
// =============================================================================

/**
 * Adatlekérés és lekérdezés beállításai.
 */
export const DATA_QUERY_CONFIG = {
    PAGE_SIZE: 1000,                        // Appwrite listRows lapméret
    URGENCY_REFRESH_INTERVAL_MS: 300000,    // Sürgősség újraszámítás (5 perc)
    MAX_PAGE_SORT_FALLBACK: 999999          // Rendezési fallback hiányzó oldalszámhoz
};

/**
 * Adatlekérés timeout értékek (milliszekundum).
 * Kritikus adatok (publications, articles, validations) hosszabb timeout-tal rendelkeznek.
 */
export const FETCH_TIMEOUT_CONFIG = {
    CRITICAL_DATA_MS: 10000,    // Kritikus: publications, articles, validations
    NON_CRITICAL_DATA_MS: 8000  // Nem-kritikus: layouts, deadlines
};

// =============================================================================
// Realtime WebSocket Konfiguráció
// =============================================================================

/**
 * Realtime WebSocket kliens konfigurációja.
 * Exponenciális backoff, cooldown és szerverhiba kezelés beállításai.
 */
export const REALTIME_CONFIG = {
    AUTH_RETRY_DELAY_MS: 200,               // Auth frame újrapróbálás késleltetés
    COOLDOWN_MS: 60000,                     // Cooldown túl sok egymás utáni szerverhiba után
    MAX_BACKOFF_MS: 60000,                  // Maximális exponenciális backoff
    MAX_CONSECUTIVE_SERVER_ERRORS: 5,       // Ennyi szerverhiba után indul a cooldown
    SERVER_ERROR_BACKOFF_BASE_MS: 5000      // Szerverhiba backoff alap (5s → 10s → 20s...)
};
