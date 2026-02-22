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
    SECTION_GENERAL_COLLAPSED: "maestro.section.general.collapsed",         // Általános szekció állapota
    SECTION_MESSAGES_COLLAPSED: "maestro.section.messages.collapsed",       // Üzenetek szekció állapota
    SECTION_CONTRIBUTORS_COLLAPSED: "maestro.section.contributors.collapsed", // Közreműködők szekció állapota
    SECTION_VALIDATION_COLLAPSED: "maestro.section.validation.collapsed",     // Validáció szekció állapota
    SECTION_PUB_GENERAL_COLLAPSED: "maestro.section.pub.general.collapsed",         // Kiadvány általános szekció
    SECTION_PUB_LAYOUTS_COLLAPSED: "maestro.section.pub.layouts.collapsed",         // Kiadvány elrendezések szekció
    SECTION_PUB_DEADLINES_COLLAPSED: "maestro.section.pub.deadlines.collapsed"      // Kiadvány határidők szekció
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
 * Kapcsolat típusok enum.
 */
export const CONNECTION_TYPES = {
    EMAGO: 'emago',       // Emago Proxy (korábban render)
    APPWRITE: 'appwrite', // Appwrite Backend
    REALTIME: 'realtime'  // Realtime websocket kapcsolat
};

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

    // Újracsatlakozás és Időtúllépések
    RETRY_DELAY_MS: 3000,          // Várakozás újracsatlakozás előtt
    FETCH_TIMEOUT_MS: 8000,        // API kérés timeout
    ABORT_TIMEOUT_MS: 10000,       // Megszakítási timeout

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
// Központi Recovery Konfiguráció
// =============================================================================

/**
 * A RecoveryManager konfigurációja.
 * Ez a központi helyreállítás-kezelő koordinálja az összes recovery trigger-t
 * (online, sleep, focus, realtime disconnect).
 */
export const RECOVERY_CONFIG = {
    DEBOUNCE_MS: 5000,          // Két recovery között minimum várakozás (5s)
    HEALTH_TIMEOUT_MS: 5000,    // Health check kérés timeout (5s)
    MAX_RETRIES: 5,             // Maximum health check próbálkozás
    RETRY_BASE_MS: 3000         // Backoff alap (3s → 6s → 12s → 24s → 48s)
};
