import { Client, Account, Databases, TablesDB, Storage, ID, Query, Realtime, Functions } from "appwrite";
import { log, logWarn } from "../utils/logger.js";
import { MaestroEvent, dispatchMaestroEvent } from "./maestroEvents.js";
import {
    APPWRITE_PROJECT_ID,
    DATABASE_ID,
    COLLECTIONS,
    BUCKETS
} from "maestro-shared/appwriteIds.js";

export { APPWRITE_PROJECT_ID, DATABASE_ID, BUCKETS };

export const APPWRITE_LOCALE = "hu-HU";

/** A Maestro Dashboard webes felület URL-je — DASHBOARD_URL env változóból, vagy production fallback. */
export const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://maestro.emago.hu';

/** Email verificációs callback URL — a Dashboard /verify route-ra mutat. */
export const VERIFICATION_URL = `${DASHBOARD_URL}/verify`;

/** Jelszó-visszaállítási callback URL — a Dashboard /reset-password route-ra mutat. */
export const RECOVERY_URL = `${DASHBOARD_URL}/reset-password`;


// =============================================================================
// Dual-Proxy Failover — Endpoint konfiguráció
// =============================================================================

/**
 * Proxy endpoint-ok.
 * PRIMARY: Railway EU West (Amsterdam) — mindig meleg, ~0.5s TTFB, nincs cold start.
 * FALLBACK: emago.hu — Apache/Passenger, cold start 8-10s, de független infrastruktúra.
 */
const ENDPOINTS = {
    PRIMARY: 'https://gallant-balance-production-b513.up.railway.app/v1',
    FALLBACK: 'https://emago.hu/maestro-proxy/v1'
};

/**
 * EndpointManager — Kezeli az aktív/fallback proxy endpoint váltást.
 *
 * A RecoveryManager cascading health check-je hívja a switch metódusokat.
 * Az Appwrite Client endpoint-ját automatikusan frissíti váltáskor.
 */
class EndpointManager {
    constructor() {
        this.activeEndpoint = ENDPOINTS.PRIMARY;
        this.isPrimary = true;
    }

    /** Az aktuálisan aktív endpoint URL. */
    getEndpoint() { return this.activeEndpoint; }

    /** Az aktív endpoint health check URL-je. */
    getHealthEndpoint() { return `${this.activeEndpoint}/health`; }

    /** 
     * Az aktív endpoint proxy base URL-je (/v1 suffix nélkül).
     * Használható AI, verification és egyéb proxy-n keresztüli helperendpointokhoz.
     */
    getProxyBase() { 
        return this.activeEndpoint.replace(/\/v1$/, ''); 
    }

    /** Igaz, ha a primary (Railway) az aktív endpoint. */
    getIsPrimary() { return this.isPrimary; }

    /** Átkapcsol a fallback-re és frissíti a fő klienst. */
    switchToFallback() {
        if (!this.isPrimary) return;
        this.activeEndpoint = ENDPOINTS.FALLBACK;
        this.isPrimary = false;
        client.setEndpoint(this.activeEndpoint);
        log('[EndpointManager] Átkapcsolás fallback-re: ' + this.activeEndpoint);
        dispatchMaestroEvent(MaestroEvent.endpointSwitched, { isPrimary: false, endpoint: this.activeEndpoint });
    }

    /** Visszakapcsol a primary-re és frissíti a fő klienst. */
    switchToPrimary() {
        if (this.isPrimary) return;
        this.activeEndpoint = ENDPOINTS.PRIMARY;
        this.isPrimary = true;
        client.setEndpoint(this.activeEndpoint);
        log('[EndpointManager] Visszakapcsolás primary-re: ' + this.activeEndpoint);
        dispatchMaestroEvent(MaestroEvent.endpointSwitched, { isPrimary: true, endpoint: this.activeEndpoint });
    }

    /** A másik (nem aktív) endpoint health URL-je. */
    getOtherHealthEndpoint() {
        return this.isPrimary
            ? `${ENDPOINTS.FALLBACK}/health`
            : `${ENDPOINTS.PRIMARY}/health`;
    }

    /** Átkapcsol a jelenleg nem aktív endpoint-ra. */
    switchToOther() {
        if (this.isPrimary) this.switchToFallback();
        else this.switchToPrimary();
    }
}

export const endpointManager = new EndpointManager();

// Appwrite kliens inicializálása
const client = new Client()
    .setEndpoint(endpointManager.getEndpoint())
    .setProject(APPWRITE_PROJECT_ID)
    .setLocale(APPWRITE_LOCALE);

// UXP környezetben a platform beállítása nem működik a setPlatform() metódussal,
// ezért kézzel állítjuk be a fejlécet, hogy a szerver azonosítani tudja az alkalmazást.
client.headers['X-Appwrite-Package-Name'] = "com.sashalmiimre.maestro";

// Monkey-patch: fetch elfogása a cross-domain cookie probléma megkerüléséhez.
// Az UXP biztonsági házirendje eldobja a Set-Cookie fejlécet, ha a cookie domainje
// (cloud.appwrite.io) nem egyezik a kérés domainjével (emago.hu). Ezért kézzel
// olvassuk ki a session tokent és mentjük a localStorage-ba (cookieFallback),
// amit az Appwrite SDK automatikusan használ a hitelesítéshez.
const originalFetch = window.fetch;
const sessionCookiePattern = new RegExp(`a_session_${APPWRITE_PROJECT_ID}=([^;]+)`);
window.fetch = async (...args) => {
    const [resource, config] = args;
    const response = await originalFetch(resource, config);

    // Mindkét proxy endpoint-ot ellenőrizzük (Railway + emago.hu)
    const isProxyRequest = typeof resource === 'string' && (
        resource.includes('gallant-balance-production-b513.up.railway.app') ||
        resource.includes('maestro-proxy')
    );
    if (isProxyRequest) {
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) {
            try {
                const sessionMatch = setCookie.match(sessionCookiePattern);

                // Csak valódi session tokent mentünk el — a szerver "deleted" értékkel
                // jelzi a kijelentkezést, azt nem szabad a cookieFallback-be írni.
                if (sessionMatch && sessionMatch[1] && sessionMatch[1] !== 'deleted') {
                    // Merge a meglévő cookieFallback értékekkel, hogy ne veszítsünk el más cookie-kat
                    let cookieFallback = {};
                    try {
                        const existing = window.localStorage.getItem('cookieFallback');
                        if (existing) cookieFallback = JSON.parse(existing);
                    } catch (e) { /* ignore */ }
                    cookieFallback[`a_session_${APPWRITE_PROJECT_ID}`] = sessionMatch[1];

                    window.localStorage.setItem('cookieFallback', JSON.stringify(cookieFallback));
                    client.headers['X-Fallback-Cookies'] = JSON.stringify(cookieFallback);
                }
            } catch (e) {
                logWarn('[Maestro] Cookie mentés sikertelen:', e);
            }
        }
    }
    return response;
};

// Szolgáltatások példányosítása
export const account = new Account(client);
export const tables = new TablesDB(client);
export const databases = new Databases(client);
export const storage = new Storage(client);
export const appwriteRealtime = new Realtime(client);
export const functions = new Functions(client);

// Bejelentkezés végrehajtása
export async function executeLogin(email, password) {
    await account.createEmailPasswordSession({ email, password });
}

// Kijelentkezés kezelése
export async function handleSignOut() {
    try {
        await account.deleteSession({ sessionId: "current" });
    } finally {
        // Mindig töröljük a helyi session tokent, akár sikerült a szerver oldali törlés, akár nem.
        // Ha sikeres volt, a token amúgy is érvénytelen. Ha sikertelen (pl. hálózati hiba),
        // a stale token 401-et okozna minden további kérésnél.
        clearLocalSession();
    }
}

/**
 * Helyi session adatok törlése szerver hívás nélkül.
 *
 * Az Appwrite SDK a session tokent a localStorage `cookieFallback` kulcsában tárolja
 * (`a_session_${projectId}` bejegyzésként). Ha a szerver oldali session törlés sikertelen
 * (pl. a session már nem létezik), az SDK NEM törli a helyi tokent — ezért a stale token
 * minden további kérésben megy, ami 401-et okoz.
 *
 * Ez a függvény kézzel törli a helyi session-t, hogy a kliens tiszta állapotból induljon.
 */
export function clearLocalSession() {
    try {
        const raw = window.localStorage.getItem('cookieFallback');
        if (raw) {
            const cookies = JSON.parse(raw);
            delete cookies[`a_session_${APPWRITE_PROJECT_ID}`];
            window.localStorage.setItem('cookieFallback', JSON.stringify(cookies));
        }
    } catch (e) {
        // Ha a localStorage nem elérhető, nem baj
    }
}

// Gyűjtemény ID-k — shared-ből, visszafelé kompatibilis egyedi exportokkal
export const PUBLICATIONS_COLLECTION_ID = COLLECTIONS.PUBLICATIONS;
export const ARTICLES_COLLECTION_ID = COLLECTIONS.ARTICLES;
export const USER_VALIDATIONS_COLLECTION_ID = COLLECTIONS.USER_VALIDATIONS;
export const VALIDATIONS_COLLECTION_ID = "validations"; // Plugin-only gyűjtemény (rendszer validációk)
export const LAYOUTS_COLLECTION_ID = COLLECTIONS.LAYOUTS;
export const DEADLINES_COLLECTION_ID = COLLECTIONS.DEADLINES;
export const GROUPS_COLLECTION_ID = COLLECTIONS.GROUPS;
export const GROUP_MEMBERSHIPS_COLLECTION_ID = COLLECTIONS.GROUP_MEMBERSHIPS;
export const WORKFLOWS_COLLECTION_ID = COLLECTIONS.WORKFLOWS;

// =============================================================================
// cookieFallback Diagnosztika — Session token eltűnés nyomkövetés
// =============================================================================

/**
 * localStorage.setItem monkey-patch a cookieFallback kulcsra.
 *
 * Ha egy írás elveszítené a session tokent (korábbi tokennel rendelkező állapotból
 * üresre vagy token nélkülire váltana), a stack trace-t logoljuk. Így a következő
 * előfordulásnál pontosan látjuk, melyik kódútvonal törli a tokent.
 *
 * Nem blokkolja az írást — csak diagnosztikai célú.
 */
try {
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = function(key, value) {
        if (key === 'cookieFallback') {
            const sessionKey = `a_session_${APPWRITE_PROJECT_ID}`;
            const previous = window.localStorage.getItem('cookieFallback');
            let hadSession = false;
            let hasSession = false;
            try {
                hadSession = previous && JSON.parse(previous)[sessionKey];
                hasSession = value && JSON.parse(value)[sessionKey];
            } catch (e) { /* ignore parse errors */ }

            if (hadSession && !hasSession) {
                logWarn('[Maestro] [GUARD] cookieFallback session token elveszne!',
                    new Error().stack);
            }
        }
        return originalSetItem(key, value);
    };
} catch (e) {
    // Ha a monkey-patch regisztráció sikertelen (pl. Object.freeze, strict mode),
    // az alkalmazás indulása nem törhet meg — a diagnosztika opcionális.
    logWarn('[Maestro] cookieFallback diagnosztika regisztráció sikertelen:', e);
}

export { client, ID, Query };