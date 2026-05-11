/**
 * Maestro Dashboard — Auth Context
 *
 * Felhasználó állapot, bejelentkezés, kijelentkezés, session ellenőrzés.
 * Az Appwrite Web SDK böngészőben natívan kezeli a cookie-kat.
 *
 * Fázis 1 / B.4 — bővítés:
 * - Új metódusok: register, resendVerification, verifyEmail, requestRecovery,
 *   confirmRecovery, updatePassword, reloadMemberships.
 * - Új state: organizations, editorialOffices (a saját org/office tagságok
 *   alapján betöltött scope rekordok), membershipsError (külön rögzíti a
 *   memberships fetch hibáit, hogy a ProtectedRoute meg tudja különböztetni
 *   a tényleges üres tagság-listát egy átmeneti backend hibától).
 *
 * Adversarial review fix-ek (2026-04-07):
 * - #1: A fetchMemberships hibája NEM lesz csendes „üres szervezet" — külön
 *   `membershipsError` state-ben él, és a ProtectedRoute az alapján dönt.
 * - #2: A register() partícionált try/catch-ekkel működik. Ha a verifikációs
 *   e-mail küldése elhasal, egy `verification_send_failed` kódú hibát dob,
 *   amit a RegisterRoute „partial success" UI-jal kezel + resendVerification
 *   gombbal. Így a user nem reked az „account already exists" zsákutcában.
 *
 * B.5 review fix-ek (2026-04-07):
 * - callInviteFunction(): közös helper az `invite-to-organization` CF
 *   hívásához. A három korábbi másolat (createOrganization, acceptInvite,
 *   createInvite) ugyanazt a boilerplate-et használta (execution + JSON.parse
 *   + success + wrapped error), így egy helyen javítható / bővíthető.
 * - A createOrganization / acceptInvite utáni memberships reload már nem
 *   `.catch(() => null)` — explicit warn a konzolra, a ProtectedRoute a
 *   `membershipsError` state-ből fogja látni a hibát.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Client, Account, Databases, Functions, Query, ID } from 'appwrite';
import {
    APPWRITE_ENDPOINT,
    APPWRITE_PROJECT_ID,
    DATABASE_ID,
    COLLECTIONS,
    FUNCTIONS,
    DASHBOARD_URL
} from '../config.js';
import { resolveGroupSlugs } from '@shared/groups.js';
import { subscribeRealtime, collectionChannel } from './realtimeBus.js';

const AuthContext = createContext(null);

export function useAuth() {
    return useContext(AuthContext);
}

/** Appwrite kliens — singleton, a DataContext is használja. */
const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID);

const account = new Account(client);
const databases = new Databases(client);
const functions = new Functions(client);

export function getClient() { return client; }
export function getAccount() { return account; }

// Modul-szintű singleton belépési pont a DataProvider-en kívüli hívóknak. A
// DataProvider szándékosan saját `servicesRef`-et tart (scope-reset lifecycle).
// A Dashboardon az endpoint immutábilis (custom domain, nincs failover, ld.
// CLAUDE.md), ezért a `client` soha nem cserélődik — session state a böngésző
// cookie-ban él, nem a JS instance-ban, így logout/login sem érinti a singleton-t.
export function getDatabases() { return databases; }
export function getFunctions() { return functions; }

/**
 * Lekéri a bejelentkezett felhasználó csoporttagságait a groupMemberships +
 * groups collection-ökből. Az editorialOfficeId-t localStorage-ból olvassa
 * (ScopeContext még nem elérhető ezen a ponton a provider hierarchiában).
 *
 * @param {string} userId - Az Appwrite user $id.
 * @returns {Promise<string[]>} Csoport slug-ok tömbje.
 */
async function fetchGroupSlugs(userId) {
    try {
        const editorialOfficeId = localStorage.getItem('maestro.activeEditorialOfficeId');
        if (!editorialOfficeId) return [];

        const membershipsResult = await databases.listDocuments({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
            queries: [
                Query.equal('userId', userId),
                Query.equal('editorialOfficeId', editorialOfficeId),
                Query.limit(100)
            ]
        });
        if (membershipsResult.documents.length === 0) return [];

        const groupIds = [...new Set(membershipsResult.documents.map(m => m.groupId))];
        const groupsResult = await databases.listDocuments({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.GROUPS,
            queries: [Query.equal('$id', groupIds), Query.limit(100)]
        });

        const { slugs, missingGroupIds } = resolveGroupSlugs(membershipsResult.documents, groupsResult.documents);
        if (missingGroupIds.length > 0) {
            console.warn(`[AuthContext] Inkonzisztens csoporttagság — ${missingGroupIds.length} groupId nem oldódott fel (törölt / race): ${missingGroupIds.join(', ')}`);
        }
        return slugs;
    } catch {
        return [];
    }
}

/**
 * Lekéri a bejelentkezett felhasználó organization és editorialOffice tagságait,
 * valamint a hozzájuk tartozó scope rekordokat.
 *
 * Hibákat NEM nyel le — ha az Appwrite/database hívás elszáll, a hívó
 * `loadAndSetMemberships()` kapja meg, és külön `membershipsError` state-be
 * teszi. Így egy átmeneti backend hiba nem mosódik össze egy valódi
 * „nincs még szervezetem" állapottal (lásd adversarial review #1).
 *
 * @param {string} userId - Az aktuális Appwrite user $id-ja.
 * @returns {Promise<{organizations: Array, editorialOffices: Array, orgMemberships: Array, officeMemberships: Array}>}
 */
async function fetchMemberships(userId) {
    // 1. Saját org és office tagságok lekérése
    const [orgMembershipsResult, officeMembershipsResult] = await Promise.all([
        databases.listDocuments({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.ORGANIZATION_MEMBERSHIPS,
            queries: [Query.equal('userId', userId), Query.limit(100)]
        }),
        databases.listDocuments({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.EDITORIAL_OFFICE_MEMBERSHIPS,
            queries: [Query.equal('userId', userId), Query.limit(100)]
        })
    ]);

    const orgIds = [...new Set(orgMembershipsResult.documents.map(m => m.organizationId))];
    const officeIds = [...new Set(officeMembershipsResult.documents.map(m => m.editorialOfficeId))];

    // 2. A scope rekordok lekérése (csak ha van mit kérni)
    const [orgsResult, officesResult] = await Promise.all([
        orgIds.length > 0
            ? databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.ORGANIZATIONS,
                queries: [Query.equal('$id', orgIds), Query.limit(100)]
            })
            : Promise.resolve({ documents: [] }),
        officeIds.length > 0
            ? databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.EDITORIAL_OFFICES,
                queries: [Query.equal('$id', officeIds), Query.limit(100)]
            })
            : Promise.resolve({ documents: [] })
    ]);

    return {
        organizations: orgsResult.documents,
        editorialOffices: officesResult.documents,
        orgMemberships: orgMembershipsResult.documents,
        officeMemberships: officeMembershipsResult.documents
    };
}

/**
 * Közös helper az `invite-to-organization` Cloud Function hívásához.
 *
 * A CF három action-t szolgál ki (`bootstrap_organization`, `accept`,
 * `create`), amelyek mind ugyanazt a kliens oldali boilerplate-et
 * igényelték korábban (execution + JSON parse + success ellenőrzés +
 * wrapped error). Ez egyetlen helyen kezeli a dolgot, így:
 * - egy helyen javítható a JSON parse / error wrapping logika,
 * - új action-höz elég a hívó helyen a payload-ot összerakni,
 * - a tesztelés könnyebb (egy common code path).
 *
 * A dobott hiba `code` propertyt hordoz a CF `reason` mezőjéből,
 * vagy a megadott `defaultReason` értéket, ha a CF nem adott vissza
 * explicit okot. Az `errorMessage()` segéd (route-okban) ezt olvassa.
 *
 * @param {string} action - A CF action név (pl. 'bootstrap_organization').
 * @param {object} payload - A action-specifikus mezők (a CF body-jához fűzve).
 * @param {string} defaultReason - Fallback hibakód, ha a CF nem ad vissza reason-t.
 * @returns {Promise<object>} A CF teljes success response-ja.
 */
async function callInviteFunction(action, payload, defaultReason) {
    const execution = await functions.createExecution({
        functionId: FUNCTIONS.INVITE_TO_ORGANIZATION,
        body: JSON.stringify({ action, ...payload }),
        async: false,
        method: 'POST',
        headers: { 'content-type': 'application/json' }
    });

    let response;
    try {
        response = JSON.parse(execution.responseBody || '{}');
    } catch {
        const wrapped = new Error('invalid_response');
        wrapped.code = 'invalid_response';
        throw wrapped;
    }

    if (!response.success) {
        const reason = response.reason || defaultReason;
        // A CF HTTP status code-ja (200/400/403/404/409/410/500) a CF execution
        // objektumon áll — konzolra írjuk, hogy a felhasználó console-ból
        // könnyebben tudjon hibát jelenteni és fejlesztői tudják gyorsan
        // azonosítani, hogy pl. a CF 500 `misconfigured`-ot ad vagy 403
        // `insufficient_role`-t. A wrapped error csak a reason stringet kapja.
        console.warn(
            `[invite-to-organization CF] action=${action} reason=${reason}`,
            {
                statusCode: execution.responseStatusCode,
                executionId: execution.$id,
                body: response
            }
        );
        const wrapped = new Error(reason);
        wrapped.code = reason;
        wrapped.statusCode = execution.responseStatusCode;
        // A teljes response-t propagáljuk az érrajra, hogy a hívó hozzáférjen
        // az extra mezőkhöz (`slugs`, `errors`, `affectedPublications`,
        // `unknownSlugs`, stb. — pl. `activate_publication` 409 / 422 ágak).
        wrapped.response = response;
        // Gyakran használt mezőket lapított attribútumként is megadjuk a
        // hívónak — a régi kód `err.slugs` formában olvashatja, anélkül,
        // hogy `err.response.slugs`-t kéne írni mindenhol.
        if (response.slugs) wrapped.slugs = response.slugs;
        if (response.errors) wrapped.errors = response.errors;
        if (response.unknownSlugs) wrapped.unknownSlugs = response.unknownSlugs;
        throw wrapped;
    }

    return response;
}

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [organizations, setOrganizations] = useState([]);
    const [editorialOffices, setEditorialOffices] = useState([]);
    /**
     * A caller nyers `organizationMemberships` rekordjai. A GeneralTab
     * „Kiadvány törlése" gomb (és más admin-only UI) ebből olvassa ki,
     * hogy a user `owner`/`admin`-e a publikáció szervezetében. A
     * fetchMemberships amúgy is lekéri ezeket — csak nem volt kitéve.
     */
    const [orgMemberships, setOrgMemberships] = useState([]);
    /**
     * Membership fetch hibaállapot. `null` ha nincs hiba (vagy még nem
     * próbáltuk), `Error` ha a fetchMemberships elszállt. A ProtectedRoute
     * ezt használja a tényleges üres `organizations` tömb (→ onboarding)
     * és az átmeneti backend hiba (→ retry képernyő) megkülönböztetésére.
     */
    const [membershipsError, setMembershipsError] = useState(null);
    const checkedRef = useRef(false);
    /**
     * A Realtime filter-hez kell tudnunk, hogy az aktuális user mely
     * organization / editorialOffice doc-ok érintettje. Set-be tartjuk
     * és minden sikeres `loadAndSetMemberships` után frissítjük — így a
     * subscription handler O(1)-ben tud dönteni anélkül, hogy a state
     * tömböket dependency-ként a useEffect-be húzná (ami minden tagság-
     * változásra újra-subscribe-olna).
     */
    const organizationIdsRef = useRef(new Set());
    const editorialOfficeIdsRef = useRef(new Set());
    /**
     * Monoton reload token. Minden `loadAndSetMemberships` hívás kap egy
     * sorozatszámot, és csak akkor írhat state-et, ha a sajátja a legfrissebb.
     * Így egy ko-rábban induló, de később befejeződő reload (pl. lassú
     * hálózat) nem ülteti vissza a régi snapshot-ot egy frissebb fölé —
     * Codex adversarial review [medium] guard.
     */
    const reloadTokenRef = useRef(0);

    /**
     * Memberships betöltése + state frissítése egyetlen helyen.
     * - Sikeres fetch → state set + membershipsError null.
     * - Hiba (default) → state üres, membershipsError beállítva, hibát dob.
     * - Hiba (silent: true) → state érintetlen, csak warn — a Realtime
     *   rename/update path használja, hogy egy tranziens reload hiba ne
     *   tüntesse el a user már érvényes scope-jait.
     *
     * Out-of-order guard: minden hívás kap egy `reloadTokenRef`-ből
     * növekvő tokent, és csak akkor ír state-et (sikeresen vagy üres
     * fail-closed-ben), ha még az utolsóként kiadott token. Egy régebbi
     * in-flight reload eredménye eldobódik. A hiba propagálódik a hívóhoz
     * (login/register flow), de UI állapotot nem ír felül.
     */
    const loadAndSetMemberships = useCallback(async (userId, { silent = false } = {}) => {
        const token = ++reloadTokenRef.current;
        try {
            const memberships = await fetchMemberships(userId);
            if (token !== reloadTokenRef.current) return memberships;
            setOrganizations(memberships.organizations);
            setEditorialOffices(memberships.editorialOffices);
            setOrgMemberships(memberships.orgMemberships);
            setMembershipsError(null);
            organizationIdsRef.current = new Set(memberships.organizations.map(o => o.$id));
            editorialOfficeIdsRef.current = new Set(memberships.editorialOffices.map(o => o.$id));
            return memberships;
        } catch (err) {
            if (token !== reloadTokenRef.current) throw err;

            // 2026-05-09 (Codex stop-time #4 — defense-in-depth):
            // ha a memberships fetch auth-loss-szal tér vissza (401 /
            // user_not_found), a runtime user-deletion-t ezzel a réteggel is
            // elkapjuk, függetlenül attól, hogy a `scheduleReload` előzetes
            // `account.get()` validációja kihagyott-e. Force logout, ne
            // membershipsError retry-screent mutassunk (azt csak átmeneti
            // backend-hibára szánjuk).
            const code = err?.code;
            const type = err?.type;
            if (code === 401 || type === 'user_not_found' || type === 'general_unauthorized_scope') {
                console.warn('[AuthContext] memberships fetch auth-loss — force logout (kód=%s, type=%s)', code, type);
                setUser(null);
                setOrganizations([]);
                setEditorialOffices([]);
                setOrgMemberships([]);
                setMembershipsError(null);
                organizationIdsRef.current = new Set();
                editorialOfficeIdsRef.current = new Set();
                return; // NEM dobjuk tovább — auth-loss kezelve
            }

            console.warn('[AuthContext] fetchMemberships sikertelen:', err?.message);
            if (!silent) {
                setOrganizations([]);
                setEditorialOffices([]);
                setOrgMemberships([]);
                setMembershipsError(err instanceof Error ? err : new Error(err?.message || 'memberships_load_failed'));
                organizationIdsRef.current = new Set();
                editorialOfficeIdsRef.current = new Set();
            }
            throw err;
        }
    }, []);

    /**
     * Realtime sync a tenant collection-ökre (organizations, editorialOffices,
     * organizationMemberships, editorialOfficeMemberships). A handler a
     * payload alapján szűr: csak a saját scope-ot érintő event-re reagál,
     * majd debounce-olva (silent) újratölti a memberships-et — két tab /
     * két user között szinkronban tartva pl. office rename-et.
     *
     * Filter szabályok (Codex review fix):
     * - `*Memberships` event → csak ha `payload.userId === user.$id`.
     *   Idegen tagság-változás nem érdekel.
     * - `organizations` / `editorialOffices` update/delete → csak ha a doc
     *   `$id` benne van a saját scope ref-ekben (`organizationIdsRef`,
     *   `editorialOfficeIdsRef`). Idegen tenant módosítása nem trigger-el
     *   felesleges Appwrite read-et.
     * - `organizations` / `editorialOffices` create → skip. Ha az új rekord
     *   a saját user-é, a kapcsolódó membership create külön event-tel jön,
     *   és a reload után a doc úgyis bekerül a state-be.
     *
     * Silent vs fail-closed (Codex adversarial review [high] fix):
     * - Update/rename event-ek (pl. office névmódosítás) → `silent: true`.
     *   Tranziens reload-hiba NEM tünteti el a már érvényes scope-ot.
     * - DELETE event a saját tagságra (membership.delete a saját userId-vel,
     *   vagy org/office.delete a saját scope-on belül) → `silent: false`.
     *   Ezek hozzáférés-vesztést jelölnek; ha a reload elszáll, fail-closed:
     *   ürítjük a state-et és `membershipsError`-t állítunk, így a
     *   ProtectedRoute blokkol/újrapróbál — nem fogad el cached scope-ot.
     *
     * Debounce: tipikusan 4-12 event érkezik egy cascade műveletnél
     * (pl. szervezet törlése × N office × M membership). 300ms ablak
     * egy fetch-be összevonja a saját scope-ot érintő burst-öt; ha a
     * burst-ben van akár egyetlen destructive event is, az egész reload
     * fail-closed lesz (sticky `pendingDestructive` flag).
     *
     * Csak akkor fut, ha van bejelentkezett user — logout-nál a
     * subscription automatikusan lebomlik.
     */
    useEffect(() => {
        if (!user?.$id) return;
        const userId = user.$id;

        const channels = [
            collectionChannel(COLLECTIONS.ORGANIZATIONS),
            collectionChannel(COLLECTIONS.EDITORIAL_OFFICES),
            collectionChannel(COLLECTIONS.ORGANIZATION_MEMBERSHIPS),
            collectionChannel(COLLECTIONS.EDITORIAL_OFFICE_MEMBERSHIPS)
        ];

        const classify = (response) => {
            const payload = response.payload;
            const eventChannels = response.channels || [];
            const events = response.events || [];
            const isCreate = events.some(e => e.includes('.create'));
            const isDelete = events.some(e => e.includes('.delete'));

            const inMembershipChannel = eventChannels.some(ch =>
                ch.includes(COLLECTIONS.ORGANIZATION_MEMBERSHIPS) ||
                ch.includes(COLLECTIONS.EDITORIAL_OFFICE_MEMBERSHIPS)
            );
            if (inMembershipChannel) {
                if (payload?.userId !== userId) return { relevant: false, destructive: false };
                return { relevant: true, destructive: isDelete };
            }

            if (isCreate) return { relevant: false, destructive: false };

            if (eventChannels.some(ch => ch.includes(COLLECTIONS.ORGANIZATIONS))) {
                if (!organizationIdsRef.current.has(payload?.$id)) {
                    return { relevant: false, destructive: false };
                }
                return { relevant: true, destructive: isDelete };
            }
            if (eventChannels.some(ch => ch.includes(COLLECTIONS.EDITORIAL_OFFICES))) {
                if (!editorialOfficeIdsRef.current.has(payload?.$id)) {
                    return { relevant: false, destructive: false };
                }
                return { relevant: true, destructive: isDelete };
            }
            return { relevant: false, destructive: false };
        };

        let timer = null;
        let pendingDestructive = false;
        const scheduleReload = (response) => {
            const { relevant, destructive } = classify(response);
            if (!relevant) return;
            if (destructive) pendingDestructive = true;
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
                timer = null;
                const silent = !pendingDestructive;
                const wasDestructive = pendingDestructive;
                pendingDestructive = false;

                // 2026-05-09 (Codex stop-time #4 — runtime user-deletion UX):
                // ha a destructive realtime event a `user-cascade-delete`
                // CF-ből jön (admin Appwrite-konzolon törölt), a user-rekord
                // már nincs, de a frontend cached `user` state érvényes maradna.
                // A `loadAndSetMemberships` 200-zal jönne vissza üres orgs-szal,
                // és a ProtectedRoute /onboarding-ra redirektelne (user létezik
                // + 0 org). A javítás: destructive event-nél előbb `account.get()`
                // validáljuk a user-t, és ha auth-loss → force logout /login-ra.
                if (wasDestructive) {
                    try {
                        await account.get();
                    } catch (err) {
                        const code = err?.code;
                        const type = err?.type;
                        if (code === 401 || code === 404 || type === 'user_not_found' || type === 'general_unauthorized_scope') {
                            console.warn('[AuthContext] User runtime-deleted — force logout to /login (kód=%s, type=%s)', code, type);
                            setUser(null);
                            setOrganizations([]);
                            setEditorialOffices([]);
                            setOrgMemberships([]);
                            setMembershipsError(null);
                            return;
                        }
                        // Non-auth error: continue with memberships reload, hagyjuk
                        // hogy a `loadAndSetMemberships` saját catch-je kezelje.
                        console.warn('[AuthContext] account.get failure during destructive reload (non-auth):', err?.message);
                    }
                }

                try {
                    await loadAndSetMemberships(userId, { silent });
                } catch (err) {
                    console.warn('[AuthContext] Realtime memberships reload sikertelen:', err?.message);
                }
            }, 300);
        };

        // WS reconnect után silent resync — a disconnect-ablakban érkező
        // tenant rename / membership add változások nem érkeznének push-ként.
        // Silent: tranziens hiba ne ürítse a már érvényes scope state-et
        // (a hálózat reconnect után eleve flaky lehet, pl. WiFi switch).
        // Destructive eseteket (saját kizárás) a következő CRUD 403-as válasza
        // vagy egy tényleges Realtime delete event fogja jelezni — fail-closed
        // viselkedést ott alkalmazunk, nem feltételezzük itt vakon.
        const onReconnect = () => {
            loadAndSetMemberships(userId, { silent: true }).catch(err =>
                console.warn('[AuthContext] Reconnect-time memberships resync sikertelen:', err?.message)
            );
        };

        const unsubscribe = subscribeRealtime(channels, scheduleReload, { onReconnect });

        return () => {
            if (timer) clearTimeout(timer);
            try { unsubscribe(); } catch { /* nem baj */ }
        };
    }, [user?.$id, loadAndSetMemberships]);

    // Session ellenőrzés mount-kor
    useEffect(() => {
        if (checkedRef.current) return;
        checkedRef.current = true;

        (async () => {
            try {
                // JWT auto-login: plugin-ből kapott token detektálása
                // A JWT fragment-ből (#jwt=...) érkezik, hogy ne kerüljön szerver logba
                const hash = new URLSearchParams(window.location.hash.slice(1));
                const jwt = hash.get('jwt');

                if (jwt) {
                    // Meglévő session törlése, hogy a JWT auth ne ütközzön
                    try {
                        await account.deleteSession({ sessionId: 'current' });
                    } catch {
                        // Nincs aktív session, nem baj
                    }
                    client.setJWT(jwt);
                    // URL takarítás — fragment eltávolítása a címsorból
                    window.history.replaceState({}, '', window.location.pathname + window.location.search);
                }

                const userData = await account.get();
                // groupSlugs és memberships paralel — a memberships hibája NEM
                // dobja meg a user setet (a user érvényes, csak a tagság-lookup
                // hibázott; a ProtectedRoute az error state-ből tudja).
                const [groupSlugs] = await Promise.all([
                    fetchGroupSlugs(userData.$id),
                    loadAndSetMemberships(userData.$id).catch(() => null)
                ]);
                setUser({ ...userData, groupSlugs });
            } catch {
                setUser(null);
                setOrganizations([]);
                setEditorialOffices([]);
                setOrgMemberships([]);
                setMembershipsError(null);
            } finally {
                setLoading(false);
            }
        })();
    }, [loadAndSetMemberships]);

    const login = useCallback(async (email, password) => {
        // Meglévő session törlése, hogy ne ütközzön az új bejelentkezéssel
        try {
            await account.deleteSession({ sessionId: 'current' });
        } catch {
            // Nincs aktív session, nem baj
        }
        await account.createEmailPasswordSession({ email, password });
        const userData = await account.get();
        // groupSlugs és memberships paralel. A memberships hiba a state-ben él
        // tovább (membershipsError) — a login művelet sikeres marad, mert a
        // user be van jelentkezve; a ProtectedRoute fogja az error UI-t mutatni.
        const [groupSlugs] = await Promise.all([
            fetchGroupSlugs(userData.$id),
            loadAndSetMemberships(userData.$id).catch(() => null)
        ]);
        const fullUser = { ...userData, groupSlugs };
        setUser(fullUser);
        return fullUser;
    }, [loadAndSetMemberships]);

    const logout = useCallback(async () => {
        try {
            await account.deleteSession({ sessionId: 'current' });
        } catch {
            // Ha a session már nem létezik, nem baj
        }
        // 2026-05-08 (E2E smoke teszt feedback + Codex review #2): a korábbi
        // localStorage.removeItem('maestro.pendingInviteToken') REVERT-elve
        // van. Race-condition forrása volt a `handleLogoutForReregister`
        // flow-val: a token a /register első mount-ja előtt eltűnt
        // localStorage-ből → PendingInviteBanner üres state-ben renderelt,
        // és a re-save (logout után) már nem triggerelt re-rendert. A
        // tokent SZÁNDÉKOSAN hagyjuk a localStorage-ban logout után —
        // a következő login OnboardingRoute auto-triggere helyesen kezeli
        // (success / already_member / invite_not_found / email_mismatch).
        setUser(null);
        setOrganizations([]);
        setEditorialOffices([]);
        setOrgMemberships([]);
        setMembershipsError(null);
    }, []);

    /**
     * Új fiók létrehozása + verifikációs e-mail küldése.
     *
     * Lépések:
     * 1. account.create — fiók (ha sikertelen → throw, fiók nem létezik)
     * 2. createEmailPasswordSession — ideiglenes session (a createVerification igényli)
     * 3. createVerification — verifikációs link küldése (callback: DASHBOARD_URL/verify)
     * 4. deleteSession — kijelentkezés (a user csak verifikáció után tud belépni)
     *
     * Adversarial review #2 fix: a 2. és 3. lépés külön try blokkban fut.
     * Ha bármelyik elszáll a fiók létrehozása UTÁN, az ideiglenes session-t
     * megpróbáljuk lezárni, és egy speciális `verification_send_failed` kódú
     * hibát dobunk. Így a hívó UI (RegisterRoute) tudja, hogy a fiók már
     * létezik, és felajánlhatja a verifikáció újraküldését — a user nem
     * reked az „account already exists" zsákutcában.
     */
    // 2026-05-09 (Codex stop-time #5/#6/#7 — proper session handling):
    //
    // Iteráció-történet:
    // - `5bfba4b`: unconditionally `deleteSession` a register elején →
    //   Codex #6: valid logged-in user pre-emptíven kilépett, ha az
    //   `account.create` bukott, feleslegesen logged-out állapot.
    // - `9cc92cf`: conditional clear (account.get probe alapján) →
    //   Codex #7: tévesen feltételezte, hogy a `createEmailPasswordSession`
    //   active session-t felülír. NEM. Az Appwrite ezt nem támogatja —
    //   a `login` flow épp ezért hívja először a `deleteSession`-t.
    //
    // Ez (`9cc92cf` után): helyes sorrend.
    //   1. `account.create` ELŐSZÖR (guest endpoint, sikertelen create
    //      esetén megőrzi a session-t — Codex #6 concern).
    //   2. `deleteSession` UTÁNA (csak ha sikerült a create — most már
    //      indokolt: createEmailPasswordSession active session-be ütközik).
    //   3. `createEmailPasswordSession` (clean slate, biztonsággal megy).
    //
    // Stale-cookie edge case (Codex #5/#7): ha a stale cookie blokkolja
    // az `account.create`-et 401-gyel, `deleteSession + retry` oldja meg.
    const register = useCallback(async (name, email, password) => {
        // 1. Fiók — ha ez elszáll (nem 401), nincs mit visszaforgatni.
        //    Stale-cookie eset: 401 → clear + retry.
        try {
            await account.create({ userId: ID.unique(), email, password, name });
        } catch (createErr) {
            const code = createErr?.code;
            if (code === 401) {
                console.warn('[AuthContext] register: stale session-cookie blokkolta a create-et, takarítok és újra');
                try {
                    await account.deleteSession({ sessionId: 'current' });
                } catch {
                    // Nem baj
                }
                await account.create({ userId: ID.unique(), email, password, name });
            } else {
                throw createErr;
            }
        }

        // 2. Most már létrejött a fiók. A `createEmailPasswordSession`
        //    NEM visel el active session-t (Appwrite docs / login flow
        //    referencia) — explicit clear minden previous session-re.
        //    Try/catch — ha nincs active session, no-op.
        try {
            await account.deleteSession({ sessionId: 'current' });
        } catch {
            // Nincs active session — no-op
        }

        // 2-3. Ideiglenes session + verifikációs e-mail. Ha bármi elszáll
        //      itt, a fiók már létrejött → speciális hiba a hívónak.
        let sessionCreated = false;
        try {
            await account.createEmailPasswordSession({ email, password });
            sessionCreated = true;
            await account.createVerification({ url: `${DASHBOARD_URL}/verify` });
        } catch (err) {
            if (sessionCreated) {
                try { await account.deleteSession({ sessionId: 'current' }); } catch { /* nem baj */ }
            }
            const wrapped = new Error(err?.message || 'verification_send_failed');
            wrapped.code = 'verification_send_failed';
            wrapped.cause = err;
            throw wrapped;
        }

        // 4. Sikeres verifikáció-küldés → ideiglenes session zárása.
        //    Ha ez elszáll (ritka), a user élő temp session-nel marad
        //    egészen az e-mail verifikációig — nem destruktív, de
        //    érdemes ops oldalon észlelni, ha tartósan jelentkezik.
        try {
            await account.deleteSession({ sessionId: 'current' });
        } catch (err) {
            console.warn('[AuthContext] register temp session zárás sikertelen:', err?.message);
        }
    }, []);

    /**
     * Verifikációs e-mail újraküldése — pl. ha a register() második fázisa
     * elszállt (verification_send_failed), vagy a user nem kapta meg az
     * eredeti levelet. Az e-mail/jelszó páros kell hozzá, mert a
     * createVerification ideiglenes session-t igényel.
     *
     * Sikeres lefutás után az ideiglenes session lezárul — a user csak
     * akkor tud belépni, ha rákattint a verifikációs linkre.
     */
    const resendVerification = useCallback(async (email, password) => {
        let sessionCreated = false;
        try {
            await account.createEmailPasswordSession({ email, password });
            sessionCreated = true;
            await account.createVerification({ url: `${DASHBOARD_URL}/verify` });
        } finally {
            if (sessionCreated) {
                try { await account.deleteSession({ sessionId: 'current' }); } catch { /* nem baj */ }
            }
        }
    }, []);

    const verifyEmail = useCallback(async (userId, secret) => {
        await account.updateVerification({ userId, secret });
    }, []);

    const requestRecovery = useCallback(async (email) => {
        await account.createRecovery({ email, url: `${DASHBOARD_URL}/reset-password` });
    }, []);

    const confirmRecovery = useCallback(async (userId, secret, password) => {
        await account.updateRecovery({ userId, secret, password });
    }, []);

    const updatePassword = useCallback(async (oldPassword, newPassword) => {
        await account.updatePassword({ password: newPassword, oldPassword });
    }, []);

    /**
     * Memberships újratöltése. Két fő használat:
     * 1. B.5: onboarding/invite acceptance után, hogy a frissen létrejött
     *    org/office azonnal megjelenjen a state-ben.
     * 2. ProtectedRoute „Újra" gomb: ha a memberships fetch korábban
     *    hibára futott (`membershipsError`), a user manuálisan újrapróbálhatja.
     *
     * `true`-t ad vissza, ha a reload sikeres — `false`-t, ha elbukott.
     * A `loadAndSetMemberships` már beállította a `membershipsError`-t és a
     * `organizations`/`editorialOffices` listák érintetlenek maradnak.
     * A hívó dönthet: továbblépjen-e a happy path-on (pl. scope váltás új
     * office-ra, success toast), vagy jelezze a user felé, hogy a létrehozás
     * sikeres volt, de a lista szinkron nem (oldalfrissítés javasolt).
     */
    const reloadMemberships = useCallback(async () => {
        if (!user?.$id) return false;
        try {
            await loadAndSetMemberships(user.$id);
            return true;
        } catch {
            return false;
        }
    }, [user?.$id, loadAndSetMemberships]);

    /**
     * B.5 — Új organization létrehozása az OnboardingRoute-ról.
     *
     * Az `invite-to-organization` Cloud Function `bootstrap_organization`
     * action-jét hívja. A CF API key-jel hozza létre az org + owner membership
     * + org team rekordokat, hibakezelés + rollback a szerveren.
     *
     * 2026-04-20 óta NEM hoz létre auto-kreált „Általános" szerkesztőséget —
     * a user 0 office-szal landol, a Dashboard onboarding splash felajánlja a
     * `create_editorial_office`-t. Így `editorialOfficeId` a response-ban `null`.
     *
     * Miért CF és nem közvetlen kliens-írás? A tenant collection-ök ACL-je
     * `read("users")`-re van szűkítve — csak a szerver írhat. Így nincs
     * módja egy malicious kliensnek arbitrárisan membership-et létrehozni.
     *
     * @returns {Promise<{organizationId: string, editorialOfficeId: string|null}>}
     */
    const createOrganization = useCallback(async (orgName, orgSlug) => {
        if (!user?.$id) {
            throw new Error('not_authenticated');
        }

        const response = await callInviteFunction(
            'bootstrap_organization',
            { orgName, orgSlug },
            'bootstrap_failed'
        );

        // Memberships frissítése a state-ben — az új org/office azonnal megjelenjen.
        // A loadAndSetMemberships már kezeli a membershipsError state-et, ha elszáll;
        // itt csak loggoljuk a figyelmeztetést, és a CF sikerét visszaadjuk a hívónak.
        try {
            await loadAndSetMemberships(user.$id);
        } catch (refreshErr) {
            console.warn('[AuthContext] createOrganization: memberships reload sikertelen (a CF sikeres volt):', refreshErr?.message);
        }

        return {
            organizationId: response.organizationId,
            editorialOfficeId: response.editorialOfficeId || null
        };
    }, [user?.$id, loadAndSetMemberships]);

    /**
     * #40 — Új szervezet létrehozása az avatar dropdown „Új szervezet…"
     * menüpontjából.
     *
     * Eltérés a `createOrganization`-tól: a `create_organization` CF action
     * NEM idempotens (nincs „caller már tagja egy orgnak → existing return"
     * ág). A user explicit új szervezetet kér miközben már van egy meglévő
     * tagsága. Duplaklikk-védelem a hívó modal `isSubmitting` guardja.
     *
     * Memberships reload sikertelen → `membershipsReloaded: false`, a hívó
     * dönthet (retry UI).
     *
     * A CF 2026-04-20 óta nem hoz létre auto-kreált „Általános" office-t —
     * csak az orgot. Az első szerkesztőséget a user külön hozza létre a
     * Dashboard onboarding splash-ből (`create_editorial_office` action).
     * Ezért az `editorialOfficeId` a response-ban mindig `null`, és a default
     * workflow seed sem fut le itt (a `create_editorial_office` hozza létre
     * az office-szal együtt). A modal sikerfeltétele tehát csak
     * `membershipsReloaded` — workflow seed flag-et nem adunk vissza, mert
     * az új kontraktusban mindig hamis lenne (fals partial-success).
     *
     * @returns {Promise<{organizationId: string, editorialOfficeId: string|null, membershipsReloaded: boolean}>}
     */
    const createNewOrganization = useCallback(async (orgName, orgSlug) => {
        if (!user?.$id) {
            throw new Error('not_authenticated');
        }

        const response = await callInviteFunction(
            'create_organization',
            { orgName, orgSlug },
            'create_organization_failed'
        );

        let membershipsReloaded = false;
        try {
            await loadAndSetMemberships(user.$id);
            membershipsReloaded = true;
        } catch (refreshErr) {
            console.warn('[AuthContext] createNewOrganization: memberships reload sikertelen (a CF sikeres volt):', refreshErr?.message);
        }

        return {
            organizationId: response.organizationId,
            editorialOfficeId: response.editorialOfficeId || null,
            membershipsReloaded
        };
    }, [user?.$id, loadAndSetMemberships]);

    /**
     * B.5 — Meghívó (invite) elfogadása.
     *
     * Az `invite-to-organization` Cloud Function `accept` action-jét hívja.
     * A CF validálja a tokent (lookup, status, expiry, e-mail egyezés), majd
     * API key-jel létrehozza az `organizationMemberships` rekordot. A tenant
     * collection-ök ACL-je `read("users")` only — közvetlen kliens írás
     * nem lehetséges, így a membership csak a CF-en keresztül jöhet létre.
     *
     * @param {string} token - Az invite token a localStorage-ból.
     * @returns {Promise<{organizationId: string, role: string}>}
     */
    const acceptInvite = useCallback(async (token) => {
        if (!user?.$id) {
            throw new Error('not_authenticated');
        }
        if (!token) {
            throw new Error('missing_token');
        }

        const response = await callInviteFunction(
            'accept',
            { token },
            'accept_failed'
        );

        // A token már elfogyott, töröljük a localStorage-ből
        try { localStorage.removeItem('maestro.pendingInviteToken'); } catch { /* nem baj */ }

        // Frissítsük a memberships state-et, hogy az új org megjelenjen.
        // Ha a reload elszáll, a membershipsError state beállítódik és a
        // ProtectedRoute mutat retry UI-t — itt csak warn-t loggolunk.
        try {
            await loadAndSetMemberships(user.$id);
        } catch (refreshErr) {
            console.warn('[AuthContext] acceptInvite: memberships reload sikertelen (a CF sikeres volt):', refreshErr?.message);
        }

        return {
            organizationId: response.organizationId,
            membershipId: response.membershipId,
            role: response.role
        };
    }, [user?.$id, loadAndSetMemberships]);

    /**
     * #41 — A caller saját e-mail címére kiállított pending invite-ok listája.
     *
     * A meghívott user nem tudja közvetlenül lekérdezni a saját invite-jait
     * (organizationInvites ACL `read("team:org_<orgId>")`-re szűkítve, és ő
     * még nincs benne a team-ben). Ezért a CF `list_my_invites` action-je
     * API key-jel keresi a caller email-jére regisztrált pending sorokat,
     * és visszaadja denormalizált org-név + meghívó név mezőkkel.
     *
     * @returns {Promise<Array<{$id, token, email, role, organizationId, organizationName, invitedByUserId, invitedByName, expiresAt, createdAt}>>}
     */
    const listMyInvites = useCallback(async () => {
        if (!user?.$id) throw new Error('not_authenticated');
        const response = await callInviteFunction(
            'list_my_invites',
            {},
            'invites_list_failed'
        );
        return response.invites || [];
    }, [user?.$id]);

    /**
     * #41 — Pending invite elutasítása (a meghívott user oldalán).
     *
     * Token + e-mail match védelem a CF-ben (mint az `accept`-nél),
     * majd `status='declined'` set. Idempotens: ha már nem-pending,
     * a CF megfelelő hibát ad vissza.
     *
     * @param {string} token
     * @returns {Promise<{inviteId, organizationId}>}
     */
    const declineInvite = useCallback(async (token) => {
        if (!user?.$id) throw new Error('not_authenticated');
        if (!token) throw new Error('missing_token');
        const response = await callInviteFunction(
            'decline_invite',
            { token },
            'invite_decline_failed'
        );
        return {
            inviteId: response.inviteId,
            organizationId: response.organizationId
        };
    }, [user?.$id]);

    /**
     * #41 — Saját kilépés egy szervezetből.
     *
     * A CF törli a caller `organizationMembership`-ét, az org alá tartozó
     * minden `editorialOfficeMembership`-jét és `groupMembership`-jét, és
     * eltávolítja az `org_${orgId}` + per-office `office_${officeId}`
     * Appwrite Team-ekből. Last-owner blokk: ha a caller az utolsó owner és
     * van más tag → `last_owner_block`; ha egyedüli tag → `last_member_block`
     * (a UI ekkor `delete_organization`-t kínáljon fel).
     *
     * Sikeres válasz után a hívó futtassa a `reloadMemberships()`-t, hogy
     * a ScopeContext auto-pick effekt a következő org-ra ugorjon (vagy
     * /onboarding-ra, ha nincs több).
     *
     * @param {string} organizationId
     * @returns {Promise<{organizationId, removed, teamCleanup}>}
     */
    const leaveOrganization = useCallback(async (organizationId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        if (!organizationId) throw new Error('missing_organization_id');
        return callInviteFunction(
            'leave_organization',
            { organizationId },
            'leave_organization_failed'
        );
    }, [user?.$id]);

    /**
     * B.5 — Meghívó létrehozása (admin → e-mail).
     *
     * Az `invite-to-organization` Cloud Function `create` action-jét hívja.
     * B.5-ben még nincs admin UI, ami ezt használná — de B.10 manual happy
     * path teszthez szükség lehet rá. A Fázis 6 admin UI is ezt fogja hívni.
     *
     * Az e-mail küldés Fázis 6-ra halasztva — a CF most csak a tokent és a
     * link felépítéséhez szükséges adatokat adja vissza.
     *
     * @returns {Promise<{inviteId: string, token: string, expiresAt: string}>}
     */
    const createInvite = useCallback(async (organizationId, email, role = 'member', message, expiryDays) => {
        if (!user?.$id) {
            throw new Error('not_authenticated');
        }

        const response = await callInviteFunction(
            'create',
            {
                organizationId,
                email,
                role,
                ...(message ? { message } : {}),
                ...(expiryDays !== undefined && expiryDays !== null ? { expiryDays } : {})
            },
            'create_failed'
        );

        return {
            inviteId: response.inviteId,
            token: response.token,
            expiresAt: response.expiresAt,
            role: response.role,
            email: response.email,
            organizationId: response.organizationId,
            // ADR 0010 W3 — auto-send kimenete (`'sent'` | `'failed'` | undefined ha existing/skeleton)
            deliveryStatus: response.deliveryStatus
        };
    }, [user?.$id]);

    /**
     * ADR 0010 W2 — Batch invite createolás (multi-invite).
     *
     * A frontend egyetlen modalból több e-mailt küldhet (max 20). A CF
     * iterál 10-es Promise.all batchekben, és visszaad egy per-email
     * status listát (`results: [{email, status: 'ok'|'error', ...}]`).
     *
     * Az auto-send minden sikeres invite-on automatikusan megtörténik
     * (best-effort) — a `deliveryStatus` a per-email result-ban jön vissza.
     *
     * @param {string} organizationId
     * @param {string[]} emails — max 20, lower-case dedupolva, EMAIL_REGEX
     * @param {'member'|'admin'} role
     * @param {string} [message]
     * @param {number} [expiryDays] — 1 / 3 / 7 (default 7)
     * @returns {Promise<{total, successCount, failCount, results: Array}>}
     */
    const createBatchInvites = useCallback(async (organizationId, emails, role = 'member', message, expiryDays) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'create_batch_invites',
            {
                organizationId,
                emails,
                role,
                ...(message ? { message } : {}),
                ...(expiryDays !== undefined && expiryDays !== null ? { expiryDays } : {})
            },
            'create_batch_failed'
        );
    }, [user?.$id]);

    /**
     * ADR 0010 W3 — Pending invite e-mail újraküldés (admin gomb a UsersTab
     * függő meghívók listán). Ha a kézbesítés sikertelen volt vagy a
     * meghívott elveszítette a linket, az admin re-trigger-elheti.
     *
     * @param {string} inviteId
     * @returns {Promise<{success: boolean, action: 'sent', skeleton?: boolean}>}
     */
    const resendInviteEmail = useCallback(async (inviteId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'send_invite_email',
            { inviteId },
            'invite_resend_failed'
        );
    }, [user?.$id]);

    /**
     * A.2.2 (ADR 0008) — Publikáció aktiválása szerver-CF action-en át.
     *
     * Korábban a Dashboard direkt `databases.updateDocument(publications, ...,
     * { isActivated: true })` hívást csinált, amitől a `validate-publication-update`
     * post-event guard reaktívan validált. Az A.2.2 viszont szinkron
     * `empty_required_groups` 409 választ követel az autoseed után — ezt a
     * `activate_publication` HTTP CF action adja.
     *
     * `expectedUpdatedAt` opcionális TOCTOU guard: a kliens a betöltött pub
     * `$updatedAt`-jét visszaadja; ha azóta változott, a CF 409
     * `concurrent_modification`-t ad.
     *
     * @param {string} publicationId
     * @param {string} [expectedUpdatedAt]
     * @returns {Promise<{ publicationId, workflowId, activatedAt, autoseed, warnings? }>}
     */
    const activatePublication = useCallback(async (publicationId, expectedUpdatedAt) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'activate_publication',
            expectedUpdatedAt
                ? { publicationId, expectedUpdatedAt }
                : { publicationId },
            'activation_failed'
        );
    }, [user?.$id]);

    /**
     * A.2.3 (ADR 0008) — Workflow hozzárendelése publikációhoz CF-en át.
     * A `assign_workflow_to_publication` autoseed-eli a hiányzó
     * `requiredGroupSlugs[]`-t (idempotens, nem követeli meg a min. 1 tagot).
     *
     * `expectedUpdatedAt` opcionális TOCTOU guard — két paralel tab cseréje
     * ellen. A kliens a betöltött pub `$updatedAt`-jét adja át; ha azóta
     * változott, a CF 409 `concurrent_modification`.
     */
    const assignWorkflowToPublication = useCallback(async (publicationId, workflowId, expectedUpdatedAt) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'assign_workflow_to_publication',
            expectedUpdatedAt
                ? { publicationId, workflowId, expectedUpdatedAt }
                : { publicationId, workflowId },
            'workflow_assign_failed'
        );
    }, [user?.$id]);

    /**
     * A.2.10 (ADR 0008) — Atomic publikáció-létrehozás workflow-hozzárendeléssel.
     * Egyetlen CF call (`create_publication_with_workflow`) — kliens-oldali
     * tranziens "workflowId nélkül" ablak nélkül. Codex stop-time review
     * (4. iter) — a két lépéses create+assign Realtime-szempontból más
     * tab/derivált state-ekben is csendben null-workflow-t mutatott.
     *
     * @param {Object} payload — `{ organizationId, editorialOfficeId, workflowId,
     *   name, coverageStart, coverageEnd, excludeWeekends?, rootPath? }`
     * @returns {Promise<{ publication, autoseed }>}
     */
    const createPublicationWithWorkflow = useCallback(async (payload) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'create_publication_with_workflow',
            payload,
            'publication_create_failed'
        );
    }, [user?.$id]);

    /**
     * Fázis 8 — Szervezet kaszkád törlés.
     *
     * A CF `delete_organization` action-jét hívja (owner-only). A CF
     * atomikusan töröl minden alárendelt rekordot: az összes szerkesztőség
     * és azok publikációi/workflow-i/csoportjai, valamint az org-szintű
     * invites/memberships. A publikáció-szintű kaszkádot a meglévő
     * `cascade-delete` CF veszi át (articles/layouts/deadlines/thumbnails).
     *
     * A sikeres törlés után a hívó maga hívja a `reloadMemberships`-t,
     * hogy a ScopeContext auto-pick effekt a következő org-ra ugorjon
     * (vagy /onboarding-ra, ha nincs több).
     */
    const deleteOrganization = useCallback(async (organizationId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction('delete_organization', { organizationId }, 'delete_organization_failed');
    }, [user?.$id]);

    /**
     * Fázis 8 — Szerkesztőség kaszkád törlés.
     *
     * A CF `delete_editorial_office` action-jét hívja (owner/admin).
     * A CF atomikusan töröl minden szerkesztőség-szintű rekordot
     * (publications, workflows, groups, groupMemberships, officeMemberships);
     * a publikáció-szintű kaszkádot a meglévő `cascade-delete` CF veszi át.
     */
    const deleteEditorialOffice = useCallback(async (editorialOfficeId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction('delete_editorial_office', { editorialOfficeId }, 'delete_office_failed');
    }, [user?.$id]);

    /**
     * Új szerkesztőség létrehozása egy meglévő szervezetben (owner/admin).
     *
     * A CF `create_editorial_office` action-jét hívja. Létrehozza az office-t,
     * hozzáadja a caller-t admin officeMembership-ként, lelement 7 default
     * csoportot a caller groupMembership-jeivel, és opcionálisan klónoz egy
     * meglévő (org-scope) workflow-t az új office alá.
     *
     * @param {string} organizationId
     * @param {string} name — az új szerkesztőség megjelenítendő neve
     * @param {string} [sourceWorkflowId] — opcionális workflow doc ID klónozáshoz
     * @returns {Promise<{editorialOfficeId, organizationId, name, slug, workflowId: string|null, groupsSeeded: number, workflowSeeded: boolean}>}
     */
    const createEditorialOffice = useCallback(async (organizationId, name, sourceWorkflowId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        const payload = { organizationId, name };
        if (sourceWorkflowId) payload.sourceWorkflowId = sourceWorkflowId;
        return callInviteFunction('create_editorial_office', payload, 'office_create_failed');
    }, [user?.$id]);

    /**
     * Szervezet átnevezése (owner/admin). A CF `update_organization` action-jét
     * hívja. Sikeres válasz után a `reloadMemberships()`-t a hívó maga futtassa,
     * hogy az AuthContext `organizations` listája a Realtime előtt is frissüljön.
     *
     * @param {string} organizationId
     * @param {string} name
     */
    const renameOrganization = useCallback(async (organizationId, name) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'update_organization',
            { organizationId, name },
            'organization_update_failed'
        );
    }, [user?.$id]);

    /**
     * Org-tag role változtatása (`owner` ↔ `admin` ↔ `member`) — 2026-05-07.
     *
     * A CF `change_organization_member_role` action-jét hívja. Az action
     * `org.member.role.change` slug-ot követel (owner / admin), de owner-
     * érintettségű cseréhez (új role 'owner' VAGY régi role 'owner') a
     * caller-nek owner-nek kell lennie — admin nem promote-olhat owner-ré
     * és nem demote-olhat egy meglévő owner-t.
     *
     * Védelem:
     *   - self-edit → 403 `cannot_change_own_role`
     *   - last-owner demote → 409 `cannot_demote_last_owner`
     *   - admin owner-touch → 403 `requires_owner_for_owner_role_change`
     *
     * Idempotens: ha a target már a kívánt role-lal rendelkezik → success no-op.
     *
     * UI refresh: a hívó a sikeres válasz után **explicit-en** frissítse a
     * tagi listát (`UsersTab.handleRoleChange` az `onMembersRefresh()`
     * callbackot hívja). Cross-tab szinkron a `useTenantRealtimeRefresh`
     * hook `ORG_CHANNELS` listájában lévő `ORGANIZATION_MEMBERSHIPS`
     * csatornán át megy (2026-05-07 retrofit, Codex stop-time fix).
     *
     * @param {string} organizationId
     * @param {string} targetUserId
     * @param {'owner'|'admin'|'member'} role
     */
    const changeOrganizationMemberRole = useCallback(async (organizationId, targetUserId, role) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'change_organization_member_role',
            { organizationId, targetUserId, role },
            'role_change_failed'
        );
    }, [user?.$id]);

    /**
     * 2026-05-10 ([[Döntések/0012-org-member-removal-cascade]]) — admin-kick
     * a UsersTab "Felhasználók" tabról. A CF `remove_organization_member`
     * action-t hívja, amely cascade-cleanup-pal eltávolítja a target tagot
     * a szervezetből (per-office team + org team + admin-team STRICT cleanup,
     * majd `editorialOfficeMemberships` + `groupMemberships` + `organizationMemberships`).
     *
     * Védelmi rétegek backend-en: self-block, owner-touch (admin nem érint owner-t),
     * last-owner guard, `org.member.remove` permission slug. Frontend csak az
     * UX-szintű azonnali eseteket szűri (pl. self-row gomb hide).
     */
    const removeOrganizationMember = useCallback(async (organizationId, targetUserId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'remove_organization_member',
            { organizationId, targetUserId },
            'member_removal_failed'
        );
    }, [user?.$id]);

    /**
     * 2026-05-10 ([[Döntések/0013-self-service-account-management]]) — self-service
     * fiók-törlés a /settings/account profile-screen "Veszélyes zóna" gombjáról.
     *
     * Cross-org sequential cleanup MINDEN orgból + `users.delete(callerId)`.
     * Backend BLOCKER-fix-ek: per-org cleanup `users.delete` ELŐTT (race-window),
     * sole-owner / sole-member ágat is blokkolja (mint a `leaveOrganization`).
     *
     * Sikeres response után a hívó: `account.deleteSession({ sessionId: 'current' })`
     * try/catch + redirect `/login` (a session a backend-en már érvénytelen).
     *
     * @returns {Promise<{ leftOrgs: string[], cleanupStats: Array }>}
     */
    const deleteMyAccount = useCallback(async () => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'delete_my_account',
            { confirm: true },
            'account_delete_failed'
        );
    }, [user?.$id]);

    /**
     * Szerkesztőség átnevezése (org owner/admin). A CF `update_editorial_office`
     * action-jét hívja. Slug NEM változik (stabilitás — cikkek / publikációk az
     * office $id-re hivatkoznak). A hívó maga futtassa a `reloadMemberships()`-t
     * a sikeres válasz után, hogy az `editorialOffices` lista a Realtime előtt
     * is frissüljön.
     *
     * @param {string} editorialOfficeId
     * @param {string} name
     */
    const renameEditorialOffice = useCallback(async (editorialOfficeId, name) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'update_editorial_office',
            { editorialOfficeId, name },
            'office_update_failed'
        );
    }, [user?.$id]);

    /**
     * Csoporttagság hozzáadása (org owner/admin). Idempotens — ha a user már
     * tagja a csoportnak, a CF `already_member` választ ad.
     *
     * @param {string} groupId
     * @param {string} userId
     */
    const addGroupMember = useCallback(async (groupId, userId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'add_group_member',
            { groupId, userId },
            'group_member_add_failed'
        );
    }, [user?.$id]);

    /**
     * Csoporttagság eltávolítása (org owner/admin). Idempotens — ha nincs ilyen
     * membership, a CF `already_removed` választ ad.
     *
     * @param {string} groupId
     * @param {string} userId
     */
    const removeGroupMember = useCallback(async (groupId, userId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'remove_group_member',
            { groupId, userId },
            'group_member_remove_failed'
        );
    }, [user?.$id]);

    /**
     * Új csoport létrehozása egy szerkesztőségben (org owner/admin). A CF
     * `create_group` action-jét hívja. A válasz tartalmazza a teljes group
     * dokumentumot — a hívó azonnal hozzáfűzheti a helyi state-hez a Realtime
     * push előtt. A caller seed-membership-et kap automatikusan.
     *
     * @param {string} editorialOfficeId
     * @param {string} name
     */
    const createGroup = useCallback(async (editorialOfficeId, name) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'create_group',
            { editorialOfficeId, name },
            'group_create_failed'
        );
    }, [user?.$id]);

    /**
     * Csoport átnevezése (org owner/admin). Csak a display name változik,
     * a slug stabil marad — a workflow `compiled` JSON slug-okra hivatkozik.
     *
     * @param {string} groupId
     * @param {string} name
     */
    const renameGroup = useCallback(async (groupId, name) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'rename_group',
            { groupId, name },
            'group_update_failed'
        );
    }, [user?.$id]);

    /**
     * Csoport végleges törlése (org owner/admin). A.2.8 óta nincs kliens-oldali
     * DEFAULT_GROUPS védelem — a CF `delete_group` blocker-set ugyanazt veti
     * össze, mint az `archive_group`: nem-archivált workflow `requiredGroupSlugs`-ban,
     * aktív pub `compiledWorkflowSnapshot`-ban, vagy `articles.contributors` /
     * `publications.defaultContributors` JSON kulcsában szerepel-e a slug.
     * Ha igen, `group_in_use` 409 + a hivatkozó rekordok listája.
     *
     * @param {string} groupId
     */
    const deleteGroup = useCallback(async (groupId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'delete_group',
            { groupId },
            'group_delete_failed'
        );
    }, [user?.$id]);

    /**
     * Csoport metadata frissítése (A.2.6, ADR 0008). A `slug` immutable —
     * csak `label`, `description`, `color`, `isContributorGroup`,
     * `isLeaderGroup` szerkeszthető. A CF a payload-ban hiányzó mezőket
     * érintetlenül hagyja (selective update).
     *
     * @param {string} groupId
     * @param {{ label?: string, description?: string|null, color?: string|null, isContributorGroup?: boolean, isLeaderGroup?: boolean }} patch
     */
    const updateGroupMetadata = useCallback(async (groupId, patch) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'update_group_metadata',
            { groupId, ...patch },
            'group_update_failed'
        );
    }, [user?.$id]);

    /**
     * Csoport archiválása (A.2.7, ADR 0008). Soft-delete `archivedAt`-tel.
     * A `delete_group`-mal azonos blocker-set-et használja (workflow
     * `requiredGroupSlugs` / aktív pub `compiledWorkflowSnapshot` /
     * `articles.contributors` / `publications.defaultContributors`); ha
     * használatban van → 409 `group_in_use`.
     *
     * @param {string} groupId
     */
    const archiveGroup = useCallback(async (groupId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'archive_group',
            { groupId },
            'group_archive_failed'
        );
    }, [user?.$id]);

    /**
     * Archivált csoport visszaállítása (A.2.7). Reverzibilis művelet,
     * blocker-scan nem fut.
     *
     * @param {string} groupId
     */
    const restoreGroup = useCallback(async (groupId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'restore_group',
            { groupId },
            'group_restore_failed'
        );
    }, [user?.$id]);

    /**
     * Új permission set létrehozása (A.3.3, ADR 0008). A `permissions[]`
     * mezőben minden slug office-scope kell legyen — `org.*` slug-ot a
     * CF 400 `org_scope_slug_not_allowed` errorral utasít vissza. A slug
     * regex: `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`.
     *
     * @param {{ editorialOfficeId: string, name: string, slug: string, description?: string|null, permissions: string[] }} payload
     */
    const createPermissionSet = useCallback(async (payload) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'create_permission_set',
            payload,
            'permission_set_create_failed'
        );
    }, [user?.$id]);

    /**
     * Permission set szerkesztése (A.3.3). A `slug` immutable — csak
     * `name`, `description`, `permissions` szerkeszthető. Opcionális
     * `expectedUpdatedAt` TOCTOU guard (concurrent_modification 409).
     *
     * @param {string} permissionSetId
     * @param {{ name?: string, description?: string|null, permissions?: string[] }} patch
     * @param {string} [expectedUpdatedAt] - opcionális TOCTOU guard
     */
    const updatePermissionSet = useCallback(async (permissionSetId, patch, expectedUpdatedAt) => {
        if (!user?.$id) throw new Error('not_authenticated');
        const payload = { permissionSetId, ...patch };
        if (expectedUpdatedAt) payload.expectedUpdatedAt = expectedUpdatedAt;
        return callInviteFunction(
            'update_permission_set',
            payload,
            'permission_set_update_failed'
        );
    }, [user?.$id]);

    /**
     * Permission set archiválása (A.3.3). Soft-delete `archivedAt`-tel;
     * a junction `groupPermissionSets` rekordok intaktan maradnak, az
     * `userHasPermission()` az archivált set-eket skip-eli.
     *
     * @param {string} permissionSetId
     * @param {string} [expectedUpdatedAt] - opcionális TOCTOU guard
     */
    const archivePermissionSet = useCallback(async (permissionSetId, expectedUpdatedAt) => {
        if (!user?.$id) throw new Error('not_authenticated');
        const payload = { permissionSetId };
        if (expectedUpdatedAt) payload.expectedUpdatedAt = expectedUpdatedAt;
        return callInviteFunction(
            'archive_permission_set',
            payload,
            'permission_set_archive_failed'
        );
    }, [user?.$id]);

    /**
     * Archivált permission set visszaállítása (A.3.3).
     *
     * @param {string} permissionSetId
     * @param {string} [expectedUpdatedAt] - opcionális TOCTOU guard
     */
    const restorePermissionSet = useCallback(async (permissionSetId, expectedUpdatedAt) => {
        if (!user?.$id) throw new Error('not_authenticated');
        const payload = { permissionSetId };
        if (expectedUpdatedAt) payload.expectedUpdatedAt = expectedUpdatedAt;
        return callInviteFunction(
            'restore_permission_set',
            payload,
            'permission_set_restore_failed'
        );
    }, [user?.$id]);

    /**
     * Permission set hozzárendelése csoporthoz (A.3.4). Cross-office check
     * (400 `office_mismatch`); idempotens (`already_assigned`).
     *
     * @param {string} groupId
     * @param {string} permissionSetId
     */
    const assignPermissionSetToGroup = useCallback(async (groupId, permissionSetId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'assign_permission_set_to_group',
            { groupId, permissionSetId },
            'permission_set_assign_failed'
        );
    }, [user?.$id]);

    /**
     * Permission set hozzárendelés visszavonása (A.3.4). Idempotens
     * (`already_unassigned`).
     *
     * @param {string} groupId
     * @param {string} permissionSetId
     */
    const unassignPermissionSetFromGroup = useCallback(async (groupId, permissionSetId) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'unassign_permission_set_from_group',
            { groupId, permissionSetId },
            'permission_set_unassign_failed'
        );
    }, [user?.$id]);

    /**
     * Új workflow extension létrehozása (B.3.1, ADR 0007 Phase 0). A `code`
     * mező acorn ECMA3 pre-parse-ön és AST top-level `function maestroExtension`
     * deklaráció-ellenőrzésen átmegy a CF-ben — kontraktus-szegő kód 400
     * `invalid_extension_code` errorral elbukik. A slug regex:
     * `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`. Phase 0 hatókör: csak `editorial_office`
     * visibility ÉS csak `article` scope, a többi 400-as.
     *
     * @param {{ editorialOfficeId: string, name: string, slug: string, kind: 'validator'|'command', scope?: 'article', code: string }} payload
     */
    const createWorkflowExtension = useCallback(async (payload) => {
        if (!user?.$id) throw new Error('not_authenticated');
        return callInviteFunction(
            'create_workflow_extension',
            payload,
            'extension_create_failed'
        );
    }, [user?.$id]);

    /**
     * Extension szerkesztése (B.3.1). A `slug` immutable. Frissíthető:
     * `name`, `kind`, `scope`, `code`, `visibility`, `archivedAt` (`null`
     * implicit restore — a CF dupla auth-ot kér: `extension.edit` ÉS
     * `extension.archive`). Opcionális `expectedUpdatedAt` TOCTOU guard
     * (`version_conflict` 409).
     *
     * @param {string} extensionId
     * @param {{ name?: string, kind?: string, scope?: string, code?: string, visibility?: string, archivedAt?: string|null }} patch
     * @param {string} [expectedUpdatedAt] - opcionális TOCTOU guard
     */
    const updateWorkflowExtension = useCallback(async (extensionId, patch, expectedUpdatedAt) => {
        if (!user?.$id) throw new Error('not_authenticated');
        const payload = { extensionId, ...patch };
        if (expectedUpdatedAt) payload.expectedUpdatedAt = expectedUpdatedAt;
        return callInviteFunction(
            'update_workflow_extension',
            payload,
            'extension_update_failed'
        );
    }, [user?.$id]);

    /**
     * Extension archiválása (B.3.1). Soft-delete `archivedAt`-tel; a Plugin
     * runtime az archivált extension-eket a registry build-ben nem oldja fel
     * (snapshot-os pubok érintetlenek). Idempotens: már archivált → success
     * `already_archived` (a CF dönt).
     *
     * @param {string} extensionId
     * @param {string} [expectedUpdatedAt] - opcionális TOCTOU guard
     */
    const archiveWorkflowExtension = useCallback(async (extensionId, expectedUpdatedAt) => {
        if (!user?.$id) throw new Error('not_authenticated');
        const payload = { extensionId };
        if (expectedUpdatedAt) payload.expectedUpdatedAt = expectedUpdatedAt;
        return callInviteFunction(
            'archive_workflow_extension',
            payload,
            'extension_archive_failed'
        );
    }, [user?.$id]);

    /**
     * Archivált extension visszaállítása (B.3.1, implicit). Phase 0-ban a
     * server NEM ad külön `restore_workflow_extension` action-t, ehelyett az
     * `update_workflow_extension` payload `archivedAt: null`-lal triggereli a
     * visszaállítást — DUPLA AUTH: `extension.edit` ÉS `extension.archive`
     * slug is kell (különben az `extension.edit`-jogú user megkerülné a
     * permission split-et). A UI ezt explicit "Visszaállítás" gombbal
     * mutatja (Codex tervi review fix).
     *
     * @param {string} extensionId
     * @param {string} [expectedUpdatedAt] - opcionális TOCTOU guard
     */
    const restoreWorkflowExtension = useCallback(async (extensionId, expectedUpdatedAt) => {
        if (!user?.$id) throw new Error('not_authenticated');
        const payload = { extensionId, archivedAt: null };
        if (expectedUpdatedAt) payload.expectedUpdatedAt = expectedUpdatedAt;
        return callInviteFunction(
            'update_workflow_extension',
            payload,
            'extension_restore_failed'
        );
    }, [user?.$id]);

    const value = useMemo(() => ({
        user,
        loading,
        organizations,
        editorialOffices,
        orgMemberships,
        membershipsError,
        login,
        logout,
        register,
        resendVerification,
        verifyEmail,
        requestRecovery,
        confirmRecovery,
        updatePassword,
        reloadMemberships,
        createOrganization,
        createNewOrganization,
        acceptInvite,
        listMyInvites,
        declineInvite,
        leaveOrganization,
        createInvite,
        createBatchInvites,
        resendInviteEmail,
        deleteOrganization,
        deleteEditorialOffice,
        createEditorialOffice,
        renameOrganization,
        renameEditorialOffice,
        changeOrganizationMemberRole,
        removeOrganizationMember,
        deleteMyAccount,
        addGroupMember,
        removeGroupMember,
        createGroup,
        renameGroup,
        deleteGroup,
        updateGroupMetadata,
        archiveGroup,
        restoreGroup,
        createPermissionSet,
        updatePermissionSet,
        archivePermissionSet,
        restorePermissionSet,
        assignPermissionSetToGroup,
        unassignPermissionSetFromGroup,
        createWorkflowExtension,
        updateWorkflowExtension,
        archiveWorkflowExtension,
        restoreWorkflowExtension,
        activatePublication,
        assignWorkflowToPublication,
        createPublicationWithWorkflow
    }), [
        user,
        loading,
        organizations,
        editorialOffices,
        orgMemberships,
        membershipsError,
        login,
        logout,
        register,
        resendVerification,
        verifyEmail,
        requestRecovery,
        confirmRecovery,
        updatePassword,
        reloadMemberships,
        createOrganization,
        createNewOrganization,
        acceptInvite,
        listMyInvites,
        declineInvite,
        leaveOrganization,
        createInvite,
        createBatchInvites,
        resendInviteEmail,
        deleteOrganization,
        deleteEditorialOffice,
        createEditorialOffice,
        renameOrganization,
        renameEditorialOffice,
        changeOrganizationMemberRole,
        removeOrganizationMember,
        deleteMyAccount,
        addGroupMember,
        removeGroupMember,
        createGroup,
        renameGroup,
        deleteGroup,
        updateGroupMetadata,
        archiveGroup,
        restoreGroup,
        createPermissionSet,
        updatePermissionSet,
        archivePermissionSet,
        restorePermissionSet,
        assignPermissionSetToGroup,
        unassignPermissionSetFromGroup,
        createWorkflowExtension,
        updateWorkflowExtension,
        archiveWorkflowExtension,
        restoreWorkflowExtension,
        activatePublication,
        assignWorkflowToPublication,
        createPublicationWithWorkflow
    ]);

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}
