/**
 * Maestro Dashboard — localStorage cross-tenant cleanup helper
 *
 * S.12.4 (2026-05-15) — UX-grade defense-in-depth a server-side tenant ACL
 * (ADR 0003: per-tenant Team perm + ADR 0014: withCreator) MELLETT. Egy
 * shared böngészőn (kávézó / public PC, vagy a user bezárta a tab-ot logout
 * nélkül) a kilépő A user `maestro.activeOrganizationId` /
 * `activeEditorialOfficeId` (ScopeContext által írt) localStorage kulcsai
 * korábban túlélték a flow-t — egy B user `fetchGroupSlugs`
 * (AuthContext.jsx:82) a régi `activeEditorialOfficeId`-t olvasta, és A
 * scope-ban próbált query-t futtatni.
 *
 * Threat model: helyes server-side ACL esetén B kap 403-at és üres slug-lista
 * származik a query-ből — adat NEM szivárog. A jelenség UI-szintű artifact:
 * forgalmi tévedés, megzavart redirect (organizationOrphanedView), zavaros
 * onboarding flow. A cleanup ezt szünteti meg — NEM önmagában a tenant-isolation
 * primary garanciája, hanem a defense-in-depth-rész.
 *
 * Három meghívási pont (AuthContext.jsx):
 * 1) `logout()` flow VÉGÉN — state-cleanup után, hogy a localStorage
 *    SecurityError / quota error ne akadályozza az állapot ürítését.
 * 2) `login()` flow elején — `deleteSession` UTÁN, `createEmailPasswordSession`
 *    ELŐTT. KRITIKUS, mert a logout-bypass scenario (user bezárta a tab-ot)
 *    csak itt fogható.
 * 3) JWT auto-login flow elején — `deleteSession` UTÁN, `client.setJWT`
 *    ELŐTT. Hygiene, NEM külön security boundary (ha az attacker az A user
 *    JWT-jét birtokolja, a token-leak a parent-incident).
 *
 * Whitelist (MEGMARAD logout után):
 * - `maestro.pendingInviteToken` — szándékos persistence. Codex review #2 +
 *   E2E smoke teszt (2026-05-08 21:17) eldöntötte: a `handleLogoutForReregister`
 *   flow (email-mismatch invite recovery) működéséhez a tokent túl kell élnie
 *   a logout-nak — a következő login OnboardingRoute auto-trigger kezeli.
 *   Részletek: AuthContext.jsx logout() komment.
 *
 * Whitelist XSS-amplifier risk: same-origin script (XSS) `setItem`-elhet
 * hamis `maestro.pendingInviteToken` kulcsot → a következő login
 * OnboardingRoute auto-trigger feldolgozza, és ha érvényes invite-tokenre
 * mutat, az áldozat invitált szerepe módosul. A CF (`accept_invite`)
 * tulajdonosság- + email-mismatch ellenőrzést végez, de XSS-ben az
 * attacker saját invite-jét ráerőltetheti a betelepedő user-re. Mitigáció:
 * S.3 Phase 2 (CSP enforce — jelenleg report-only) lezárja az XSS-vektort.
 */

const MAESTRO_KEY_PREFIX = 'maestro.';

const MAESTRO_LOCAL_STORAGE_WHITELIST = new Set([
    'maestro.pendingInviteToken'
]);

// S.12.4 finomítás (2026-05-16) — non-`maestro.` prefixű kulcsok, amelyeket
// MÉG TÖRLÜNK logout/login flow-on. Az Appwrite SDK a `cookieFallback`-en
// tárolja a session-secret-et plain-text-ben, ÉS NEM törli a `deleteSession`
// hívás után — Chrome MCP teszt (Iter 31) verify-elte, hogy a stale token
// megmarad logout után. Nem-exploitable (server revoked), de XSS / shared-PC
// info-disclosure-szempontból törlendő (ASVS V3.4.2 session-cleanup).
const APPWRITE_SESSION_KEYS = new Set([
    'cookieFallback'
]);

/**
 * Töröl minden `maestro.` prefixű localStorage kulcsot, kivéve a
 * `MAESTRO_LOCAL_STORAGE_WHITELIST`-en szereplőket.
 *
 * Race-safety: két fázisban dolgozik (collect + remove) — a `removeItem`
 * hívások az iteráció közben shift-elnék a `key(i)` indexeket, így a
 * gyűjtő ciklusban csak olvasunk.
 *
 * Hibakezelés: per-művelet try/catch. Egy kulcs sikertelen olvasása /
 * törlése (UXP edge / corrupted entry) NEM állítja le a többi cleanup-ot
 * és NEM dob fel exception-t a hívóra — a logout / login alap-folyamatát
 * (Appwrite session) nem szabad blokkolni storage-hiba miatt.
 */
export function clearMaestroLocalStorage() {
    let storage;
    try {
        storage = window.localStorage;
    } catch {
        // localStorage SecurityError (pl. iframe sandbox / Safari private mode)
        return;
    }
    if (!storage) return;

    const keysToRemove = [];
    let length = 0;
    try {
        length = storage.length;
    } catch {
        return;
    }

    for (let i = 0; i < length; i++) {
        let key;
        try {
            key = storage.key(i);
        } catch {
            continue;
        }
        if (!key) continue;
        const isMaestro = key.startsWith(MAESTRO_KEY_PREFIX);
        const isAppwriteSession = APPWRITE_SESSION_KEYS.has(key);
        if (!isMaestro && !isAppwriteSession) continue;
        if (isMaestro && MAESTRO_LOCAL_STORAGE_WHITELIST.has(key)) continue;
        keysToRemove.push(key);
    }

    for (const key of keysToRemove) {
        try {
            storage.removeItem(key);
        } catch {
            // Egyetlen kulcs törlési hibája NEM állítja le a többit.
        }
    }
}
