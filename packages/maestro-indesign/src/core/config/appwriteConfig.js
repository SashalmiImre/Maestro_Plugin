import { Client, Account, Databases, TablesDB, Storage, ID, Query, Realtime, Teams, Functions } from "appwrite";
import { log } from "../utils/logger.js";
import { MaestroEvent, dispatchMaestroEvent } from "./maestroEvents.js";

export const APPWRITE_PROJECT_ID = "68808427001c20418996";
export const APPWRITE_LOCALE = "hu-HU";

const RAILWAY_BASE = 'https://gallant-balance-production-b513.up.railway.app';

/** Email verificációs callback URL — VERIFICATION_URL env változóból, vagy Railway fallback. */
export const VERIFICATION_URL = process.env.VERIFICATION_URL || `${RAILWAY_BASE}/verify`;

/** Jelszó-visszaállítási callback URL — RECOVERY_URL env változóból, vagy Railway fallback. */
export const RECOVERY_URL = process.env.RECOVERY_URL || `${RAILWAY_BASE}/reset-password`;



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
                console.warn('[Maestro] Cookie mentés sikertelen:', e);
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
export const teams = new Teams(client);
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

// Konstansok az adatbázis és gyűjtemények azonosítóihoz
export const DATABASE_ID = "6880850e000da87a3d55";
export const PUBLICATIONS_COLLECTION_ID = "publications";
export const ARTICLES_COLLECTION_ID = "articles";
export const USER_VALIDATIONS_COLLECTION_ID = "uservalidations";
export const VALIDATIONS_COLLECTION_ID = "validations";
export const LAYOUTS_COLLECTION_ID = "layouts";
export const DEADLINES_COLLECTION_ID = "deadlines";

export const TEAMS = {
    EDITORS: "editors",
    DESIGNERS: "designers",
    WRITERS: "writers",
    IMAGE_EDITORS: "image_editors",
    ART_DIRECTORS: "art_directors",
    MANAGING_EDITORS: "managing_editors",
    PROOFWRITERS: "proofwriters"
};

export const GET_TEAM_MEMBERS_FUNCTION_ID = "69599cf9000a865db98a";

export { client, ID, Query };