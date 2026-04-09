/**
 * @file UserContext.jsx
 * @description Felhasználói hitelesítés és munkamenet-kezelés.
 * 
 * Biztosítja a bejelentkezett felhasználó adatait és a hitelesítési műveleteket
 * az alkalmazás számára. Kezeli a munkamenet-kéréseket és a kijelentkezést.
 */

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Query } from "appwrite";
import { useConnection } from "../contexts/ConnectionContext.jsx";
import { account, databases, executeLogin, handleSignOut, clearLocalSession, ID, VERIFICATION_URL } from "../config/appwriteConfig.js";
import { DATABASE_ID, COLLECTIONS } from "maestro-shared/appwriteIds.js";
import { resolveGroupSlugs } from "maestro-shared/groups.js";
import { realtime } from "../config/realtimeClient.js";
import { MaestroEvent, dispatchMaestroEvent } from "../config/maestroEvents.js";
import { log, logWarn, logError } from "../utils/logger.js";
import { withRetry, withTimeout } from "../utils/promiseUtils.js";
import { FETCH_TIMEOUT_CONFIG } from "../utils/constants.js";
import { STORAGE_ORG_KEY, STORAGE_OFFICE_KEY } from "./ScopeContext.jsx";

/**
 * Retry + timeout wrapper az Appwrite list lekérdezésekhez. A `fetchMemberships`
 * a ScopedWorkspace gate mögött fut, ezért ugyanolyan resilience szint kell
 * neki, mint a DataContext kritikus fetch-einek — különben egy 502 a login
 * közben azonnal error placeholderbe dobja a usert.
 */
const listWithResilience = (params, opName) =>
    withRetry(
        () => withTimeout(
            databases.listDocuments(params),
            FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
            opName
        ),
        { operationName: opName }
    );

/**
 * A bejelentkezett felhasználó org/office tagságait és a hozzájuk tartozó
 * scope rekordokat tölti le. Hibákat NEM nyel le — a hívó eldönti, hogy
 * a `membershipsError` state-en keresztül jelzi-e a usernek.
 */
async function fetchMemberships(userId) {
    const [orgMembershipsResult, officeMembershipsResult] = await Promise.all([
        listWithResilience({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.ORGANIZATION_MEMBERSHIPS,
            queries: [Query.equal('userId', userId), Query.limit(100)]
        }, 'fetchOrgMemberships'),
        listWithResilience({
            databaseId: DATABASE_ID,
            collectionId: COLLECTIONS.EDITORIAL_OFFICE_MEMBERSHIPS,
            queries: [Query.equal('userId', userId), Query.limit(100)]
        }, 'fetchOfficeMemberships')
    ]);

    const orgIds = [...new Set(orgMembershipsResult.documents.map(m => m.organizationId))];
    const officeIds = [...new Set(officeMembershipsResult.documents.map(m => m.editorialOfficeId))];

    const [orgsResult, officesResult] = await Promise.all([
        orgIds.length > 0
            ? listWithResilience({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.ORGANIZATIONS,
                queries: [Query.equal('$id', orgIds), Query.limit(100)]
            }, 'fetchOrganizations')
            : Promise.resolve({ documents: [] }),
        officeIds.length > 0
            ? listWithResilience({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.EDITORIAL_OFFICES,
                queries: [Query.equal('$id', officeIds), Query.limit(100)]
            }, 'fetchEditorialOffices')
            : Promise.resolve({ documents: [] })
    ]);

    return {
        organizations: orgsResult.documents,
        editorialOffices: officesResult.documents
    };
}

/**
 * A felhasználó csoporttagságait feloldja slug-okra a megadott szerkesztőségben.
 * Két DB query: (1) groupMemberships where userId + editorialOfficeId,
 * (2) groups where $id IN [groupIds] → resolveGroupSlugs.
 *
 * @param {string} userId - Appwrite user ID
 * @param {string} editorialOfficeId - Az aktív szerkesztőség ID-ja
 * @returns {Promise<string[]>} Csoport slug tömb (pl. ['designers', 'editors'])
 */
async function fetchGroupSlugsForUser(userId, editorialOfficeId) {
    const membershipsResult = await listWithResilience({
        databaseId: DATABASE_ID,
        collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
        queries: [
            Query.equal('userId', userId),
            Query.equal('editorialOfficeId', editorialOfficeId),
            Query.limit(100)
        ]
    }, 'fetchGroupMemberships');

    if (membershipsResult.documents.length === 0) return [];

    const groupIds = [...new Set(membershipsResult.documents.map(m => m.groupId))];

    const groupsResult = await listWithResilience({
        databaseId: DATABASE_ID,
        collectionId: COLLECTIONS.GROUPS,
        queries: [Query.equal('$id', groupIds), Query.limit(100)]
    }, 'fetchGroups');

    return resolveGroupSlugs(membershipsResult.documents, groupsResult.documents);
}

/**
 * Context objektum a felhasználói adatok megosztásához.
 * @type {React.Context}
 */
const UserContext = createContext();

/**
 * Sorrend-független string[] egyenlőség ellenőrzés (groupSlugs összehasonlításához).
 * @param {string[]|undefined} a
 * @param {string[]|undefined} b
 * @returns {boolean}
 */
const sameGroupSlugs = (a, b) => {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;

    const setA = new Set(a);
    const setB = new Set(b);

    if (setA.size !== setB.size) return false;
    return Array.from(setA).every(id => setB.has(id));
};

/**
 * Maszkolja az email címet biztonsági okokból (pl. naplózáshoz).
 * @param {string} email - A maszkolandó email cím.
 * @returns {string} A maszkolt email (pl. t***@domain.com).
 */
const maskEmail = (email) => {
    if (typeof email !== 'string' || !email.includes('@')) return '***';
    const [local, domain] = email.split('@');
    return `${local.charAt(0)}***@${domain}`;
};

/**
 * Szolgáltató komponens, amely kezeli a felhasználói hitelesítést.
 * 
 * @component
 * @param {Object} props
 * @param {React.ReactNode} props.children - A gyermek komponensek.
 */
export function AuthorizationProvider({ children }) {
    /**
     * @typedef {Object} User
     * @property {string} $id - A felhasználó egyedi azonosítója.
     * @property {string} email - A felhasználó email címe.
     * @property {string} name - A felhasználó neve.
     */

    /** @type {[User|null, Function]} A jelenlegi felhasználó állapota */
    const [user, setUser] = useState(null);

    /** @type {[boolean, Function]} Betöltési állapot jelző */
    const [loading, setLoading] = useState(true);

    /** @type {[Array, Function]} A user szervezetei (organizationMemberships-en keresztül) */
    const [organizations, setOrganizations] = useState([]);

    /** @type {[Array, Function]} A user szerkesztőségei (editorialOfficeMemberships-en keresztül) */
    const [editorialOffices, setEditorialOffices] = useState([]);

    /**
     * Membership fetch hibaállapot. `null` ha nincs hiba (vagy még nem
     * próbáltuk), `Error` ha a fetchMemberships elszállt. A ScopedWorkspace
     * ezt használja az átmeneti backend hiba (→ retry képernyő) és a
     * tényleges „nincs tagság" (→ onboarding link) megkülönböztetésére.
     */
    const [membershipsError, setMembershipsError] = useState(null);

    /**
     * Generáció-számláló a memberships hívások cancel-hez. Minden újabb hívás
     * (vagy explicit invalidálás, pl. logout) inkrementálja, és a stale in-flight
     * válaszok commitja ez alapján szűrődik — védi a cross-tenant leakage-et,
     * amikor a user kijelentkezés/session-váltás közben fetch in flight van.
     */
    const membershipsGenRef = useRef(0);

    /**
     * Memberships betöltése + state frissítése egyetlen helyen. Stale guard:
     * minden hívás egyedi generációt kap, és csak akkor commit-ol, ha időközben
     * nem fut újabb hívás. Tranziens hibánál az előző sikeres state-et megtartjuk
     * (csak `membershipsError`-t állítunk), hogy a ScopedWorkspace ne szedje le
     * a `DataProvider`-t egy stale, de használható scope mellől.
     */
    const loadAndSetMemberships = useCallback(async (userId) => {
        const gen = ++membershipsGenRef.current;
        if (!userId) {
            setOrganizations([]);
            setEditorialOffices([]);
            setMembershipsError(null);
            return { organizations: [], editorialOffices: [] };
        }
        try {
            const memberships = await fetchMemberships(userId);
            if (gen !== membershipsGenRef.current) {
                log(`[UserContext] Stale memberships válasz eldobva (userId: ${userId})`);
                return memberships;
            }
            setOrganizations(memberships.organizations);
            setEditorialOffices(memberships.editorialOffices);
            setMembershipsError(null);
            log(`[UserContext] Tagsági adatok betöltve (organizations: ${memberships.organizations.length}, editorialOffices: ${memberships.editorialOffices.length})`);
            return memberships;
        } catch (err) {
            if (gen !== membershipsGenRef.current) {
                log(`[UserContext] Stale memberships hiba eldobva (userId: ${userId})`);
                throw err;
            }
            logWarn(`[UserContext] Tagsági adatok betöltése sikertelen: ${err?.message}`);
            // A korábbi organizations/editorialOffices state-et szándékosan
            // megtartjuk — egy tranziens 502 nem indokolja a workspace teardown-t.
            setMembershipsError(err instanceof Error ? err : new Error(err?.message || 'memberships_load_failed'));
            throw err;
        }
    }, []);

    /**
     * Ref a user aktuális értékéhez, hogy az eseménykezelők (pl. sessionExpired)
     * mindig az aktuális állapotot lássák stale closure nélkül.
     */
    const userRef = useRef(user);
    useEffect(() => { userRef.current = user; }, [user]);

    // Menüpont állapot szinkronizálása (pl. "Kijelentkezés" enabled/disabled)
    useEffect(() => {
        dispatchMaestroEvent(MaestroEvent.authStateChanged, { isLoggedIn: user !== null });
    }, [user]);

    const { startConnecting, setConnected } = useConnection();

    /**
     * Csoporttagságot frissít groupMemberships + groups query alapján és
     * setUser-rel alkalmazza. Ha az adat nem változott, nem okoz re-rendert.
     * Az editorialOfficeId-t localStorage-ből olvassa (a ScopeContext is
     * innen bootstrapel, és a UserProvider fölötte van a hierarchiában).
     *
     * @param {string} logLabel - Naplózásban megjelenő kontextus-azonosító.
     */
    const refreshGroupSlugs = async (logLabel) => {
        try {
            const officeId = window.localStorage.getItem(STORAGE_OFFICE_KEY);
            if (!officeId) {
                setUser(prev => {
                    if (!prev) return prev;
                    if (sameGroupSlugs(prev.groupSlugs, [])) return prev;
                    return { ...prev, groupSlugs: [] };
                });
                return;
            }
            const groupSlugs = await fetchGroupSlugsForUser(user?.$id, officeId);
            setUser(prev => {
                if (!prev) return prev;
                if (sameGroupSlugs(prev.groupSlugs, groupSlugs)) return prev;
                log(`[UserContext] Csoporttagság frissítve (${logLabel})`);
                return { ...prev, groupSlugs };
            });
        } catch (error) {
            logWarn(`[UserContext] Csoporttagság frissítése sikertelen (${logLabel})`);
        }
    };

    /**
     * User objektum gazdagítása csoporttagsági adatokkal.
     * A groupMemberships + groups collection-ökből feloldja a felhasználó
     * csoportjainak slug-jait. A groupSlugs mezőt a jogosultsági rendszer
     * (canUserMoveArticle, elementPermissions) használja.
     *
     * @param {Object} userData - Appwrite user objektum
     * @returns {Promise<Object>} Gazdagított user objektum groupSlugs mezővel
     */
    const enrichUserWithGroups = async (userData) => {
        try {
            const officeId = window.localStorage.getItem(STORAGE_OFFICE_KEY);
            if (!officeId) {
                return { ...userData, groupSlugs: [] };
            }
            const groupSlugs = await fetchGroupSlugsForUser(userData.$id, officeId);
            return { ...userData, groupSlugs };
        } catch (error) {
            logWarn('[UserContext] Csoporttagság lekérése sikertelen');
            return { ...userData, groupSlugs: userData.groupSlugs || [] };
        }
    };

    /**
     * Paralel lefuttatja a `groupSlugs` enrichment-et és az org/office memberships
     * betöltését. A memberships hibáját **nem** propagálja — a `membershipsError`
     * state-en keresztül jelenik meg a `ScopedWorkspace`-nek.
     */
    const hydrateUserWithMemberships = async (userData) => {
        const [enrichedUser] = await Promise.all([
            enrichUserWithGroups(userData),
            loadAndSetMemberships(userData.$id).catch(() => null)
        ]);
        return enrichedUser;
    };

    /**
     * Bejelentkezés végrehajtása email címmel és jelszóval.
     * Kezeli a meglévő munkameneteket és szükség esetén újra hitelesít.
     * 
     * @param {string} email - Felhasználó email címe.
     * @param {string} password - Felhasználó jelszava.
     * @returns {Promise<User>} A bejelentkezett felhasználó adatai.
     * @throws {Error} Ha a bejelentkezés sikertelen.
     */
    const login = async (email, password) => {
        // Egyszeri újrapróbálkozás védelem: a clearLocalSession + executeLogin
        // kombináció legfeljebb egyszer futhat le egy login hívás során.
        let retried = false;

        try {
            try {
                await executeLogin(email, password);
            } catch (error) {
                // "session is active" detektálás: type alapú (stabil) + message alapú (fallback)
                const isSessionActive = error.type === 'user_session_already_exists'
                    || (error.message && error.message.includes("session is active"));

                if (isSessionActive) {
                    // Ellenőrizzük, hogy az érvényes munkamenet a kérő felhasználóhoz tartozik-e
                    try {
                        const activeUser = await account.get();
                        if (activeUser.email !== email) {
                            logWarn(`[UserContext] Aktív munkamenet (ID: ${activeUser.$id}) nem egyezik a kért felhasználóval (${maskEmail(email)}). Kijelentkezés...`);
                            await handleSignOut();
                            retried = true;
                            await executeLogin(email, password);
                        } else {
                            log(`[UserContext] Aktív munkamenet újrafelhasználása: ${maskEmail(email)}`);
                        }
                    } catch (sessionCheckError) {
                        // Szerver szerint van aktív session, de a helyi token hiányzik/érvénytelen.
                        // Deadlock feloldás: szerver session törlési kísérlet (handleSignOut).
                        // Ha a törlés 401-et kap (nincs helyi token), a finally block akkor is
                        // meghívja clearLocalSession()-t. Utána a retry token nélkül megy →
                        // ha a szerver session időközben lejárt, sikeres lesz.
                        if (retried) throw sessionCheckError;
                        logWarn(`[UserContext] Érvénytelen munkamenet (code: ${sessionCheckError.code}, type: ${sessionCheckError.type}), szerver session törlése...`);
                        try {
                            await handleSignOut();
                        } catch (signOutError) {
                            logWarn('[UserContext] Szerver session törlés sikertelen (várható ha nincs helyi token)');
                        }
                        retried = true;
                        await executeLogin(email, password);
                    }
                } else {
                    // Nem "session is active" hiba — lehet stale cookie okozza
                    // (pl. "missing scopes" ha az SDK az érvénytelen tokent küldi).
                    // Töröljük a helyi session-t és újrapróbáljuk egyszer.
                    if (retried) throw error;
                    logWarn(`[UserContext] Bejelentkezés sikertelen (code: ${error.code}, type: ${error.type}): ${error.message} — helyi session törlése és újrapróbálkozás...`);
                    clearLocalSession();
                    retried = true;
                    await executeLogin(email, password);
                }
            }
            const currentUser = await account.get();
            const enrichedUser = await hydrateUserWithMemberships(currentUser);
            setUser(enrichedUser);
            return enrichedUser;
        } catch (error) {
            logError(`[UserContext] Bejelentkezés sikertelen (code: ${error.code}, type: ${error.type}): ${error.message}`);
            throw error;
        }
    };

    /**
     * Kijelentkezés végrehajtása. Törli a helyi user állapotot, a membership
     * state-eket, és a persistált scope localStorage kulcsokat — különben
     * egy másik user belépésekor ott maradhatna egy idegen org/office ID,
     * amit a DataContext tévesen használna (cross-tenant védelem, defense
     * in depth a ScopeContext first-load takarítása mellett).
     */
    const logout = async () => {
        try {
            await handleSignOut();
        } catch (error) {
            logError("[UserContext] Kijelentkezés sikertelen:", error);
        } finally {
            // Inkrementálás: egy még in-flight fetchMemberships(régi user) válasza
            // ne tudja visszaírni a state-et a logout után.
            membershipsGenRef.current += 1;
            setUser(null);
            setOrganizations([]);
            setEditorialOffices([]);
            setMembershipsError(null);
            try {
                window.localStorage.removeItem(STORAGE_ORG_KEY);
                window.localStorage.removeItem(STORAGE_OFFICE_KEY);
            } catch (e) { /* UXP localStorage edge case — nem kritikus */ }
        }
    };

    /**
     * Regisztráció végrehajtása email verificációval.
     *
     * Létrehozza a fiókot, ideiglenesen bejelentkezik a verificációs email
     * küldéséhez (session szükséges), majd kijelentkezik. A felhasználó
     * csak az email megerősítése után tud bejelentkezni.
     *
     * @param {string} name - Felhasználó teljes neve.
     * @param {string} email - Felhasználó email címe.
     * @param {string} password - Felhasználó jelszava (min. 8 karakter).
     * @throws {Error} Ha a regisztráció vagy a verificáció küldése sikertelen.
     */
    const register = async (name, email, password) => {
        try {
            // 1. Fiók létrehozása
            await account.create({ userId: ID.unique(), email, password, name });

            // 2. Ideiglenes bejelentkezés (a createVerification session-t igényel)
            await executeLogin(email, password);

            // 3. Verificációs email küldése
            await account.createVerification({ url: VERIFICATION_URL });

            // 4. Kijelentkezés (blokkoljuk amíg nem verifikál)
            await handleSignOut();
        } catch (error) {
            // Takarítás: ha a session létrejött de a verifikáció sikertelen,
            // biztosítjuk, hogy ne maradjon aktív session
            clearLocalSession();
            throw error;
        }
    };

    // Munkamenet lejárat figyelése (401-es hiba bármely API hívásból)
    useEffect(() => {
        const handleSessionExpired = () => {
            // Ha a user már a Login képernyőn van (null), NEM törlünk.
            // Ez megelőzi a race condition-t: a health check / reconnect
            // 401-es válasza (ami MÉG a bejelentkezés ELŐTT indult) nem
            // törölheti a közben frissen létrehozott session-t.
            if (userRef.current === null) {
                log('[UserContext] Munkamenet lejárt esemény figyelmen kívül hagyva — nincs bejelentkezett felhasználó');
                return;
            }

            log('[UserContext] Munkamenet lejárt esemény — automatikus kijelentkezés');
            // Azonnal töröljük a helyi session tokent a localStorage-ból,
            // hogy a stale cookie ne okozzon 401-et a következő kéréseknél
            // (pl. bejelentkezésnél). A handleSignOut()-ot NEM hívjuk, mert
            // a session már érvénytelen a szerveren és az async hívás
            // race condition-t okozna az újbóli bejelentkezéssel.
            clearLocalSession();
            // Invalidáljuk az esetleg in-flight memberships fetch-et is (a stale
            // válasz nem írhatja felül a state-et).
            membershipsGenRef.current += 1;
            setOrganizations([]);
            setEditorialOffices([]);
            setMembershipsError(null);
            setUser(null);
        };

        window.addEventListener(MaestroEvent.sessionExpired, handleSessionExpired);

        return () => {
            window.removeEventListener(MaestroEvent.sessionExpired, handleSessionExpired);
        };
    }, []);

    // Felhasználói adatok valós idejű szinkronizálása (pl. labels módosítás a szerveren)
    // Az Appwrite Realtime `account` csatorna a bejelentkezett felhasználó változásait figyeli,
    // beleértve a szerver-oldali (Console/Server SDK) label módosításokat is.
    useEffect(() => {
        if (!user) return;

        const unsubscribe = realtime.subscribe('account', async (response) => {
            const { events, payload } = response;

            // Tagság-változás: az account payload nem tartalmaz groupSlugs-t,
            // de az events tömbben megjelenik a memberships esemény
            // (pl. users.ID.memberships.ID.create / .delete)
            const hasMembershipEvent = events?.some(e => e.includes('.memberships.'));
            if (hasMembershipEvent) {
                await refreshGroupSlugs('Realtime / account csatorna');
                return;
            }

            // Egyéb account változás (labels, name, prefs)
            if (!payload || !payload.$id) return;

            // Session/verification/MFA események szűrése: az `account` csatorna session
            // eseményeket is küld (pl. createJWT → session.create), ahol a payload a
            // SESSION dokumentum (eltérő $id, nincs name/email). Ha nem szűrjük, a user
            // objektum felülíródik a session adataival → hibás $id, eltűnő név, ghost lockek.
            const isSessionEvent = events?.some(e => e.includes('.sessions.'));
            if (isSessionEvent) return;

            // Biztonsági ellenőrzés: a payload $id-ja egyezzen a jelenlegi felhasználóéval.
            // Ez véd minden nem user-document típusú Realtime payload ellen.
            const currentUserId = userRef.current?.$id;
            if (currentUserId && payload.$id !== currentUserId) {
                logWarn(`[UserContext] Figyelmen kívül hagyott Realtime payload — eltérő $id (payload: ${payload.$id}, user: ${currentUserId})`);
                return;
            }

            // Csak akkor frissítünk, ha az adat tényleg változott.
            // A payload-ban nincs groupSlugs (az Appwrite nem küldi), ezért megőrizzük a meglévőt.
            setUser(prev => {
                if (prev && prev.$updatedAt === payload.$updatedAt) return prev;
                log('[UserContext] Felhasználói adat frissítve (Realtime)');
                return {
                    ...payload,
                    name: payload.name || prev?.name,
                    email: payload.email || prev?.email,
                    groupSlugs: prev?.groupSlugs || []
                };
            });
        });

        return () => {
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, [user?.$id]);

    // Felhasználói adatok frissítése recovery-nél (labels, prefs, groupSlugs stb.)
    useEffect(() => {
        if (!user) return;

        const handleRefresh = async () => {
            try {
                const updatedUser = await account.get();
                const enrichedUser = await hydrateUserWithMemberships(updatedUser);
                // Csak akkor frissítünk, ha az adat tényleg változott.
                // Enélkül az account.get() mindig új referenciát ad, ami felesleges
                // re-rendereket okoz a teljes fában (LockManager useEffect[user] stb.)
                setUser(prev => {
                    if (prev && prev.$updatedAt === enrichedUser.$updatedAt
                        && sameGroupSlugs(prev.groupSlugs, enrichedUser.groupSlugs)) {
                        return prev;
                    }
                    log('[UserContext] Felhasználói adatok frissítve (recovery)');
                    return enrichedUser;
                });
            } catch (error) {
                // 401 → sessionExpired event kezeli, egyéb hiba nem kritikus
                logWarn('[UserContext] Felhasználói adatok frissítése sikertelen');
            }
        };

        window.addEventListener(MaestroEvent.dataRefreshRequested, handleRefresh);
        return () => window.removeEventListener(MaestroEvent.dataRefreshRequested, handleRefresh);
    }, [user?.$id]);

    // Csoporttagság Realtime szinkronizálása
    // A DataContext a groupMemberships csatornán figyeli a tagság-változásokat és
    // dispatch-eli a groupMembershipChanged MaestroEvent-et. Itt frissítjük a
    // user.groupSlugs-t.
    useEffect(() => {
        if (!user) return;

        const handleGroupChange = () => refreshGroupSlugs('Realtime');
        const handleScopeChange = () => refreshGroupSlugs('scopeChanged');

        window.addEventListener(MaestroEvent.groupMembershipChanged, handleGroupChange);
        window.addEventListener(MaestroEvent.scopeChanged, handleScopeChange);
        return () => {
            window.removeEventListener(MaestroEvent.groupMembershipChanged, handleGroupChange);
            window.removeEventListener(MaestroEvent.scopeChanged, handleScopeChange);
        };
    }, [user?.$id]);

    // Kezdeti állapot ellenőrzése (pl. oldal újratöltés után)
    useEffect(() => {
        const checkUserStatus = async () => {
            try {
                startConnecting("Felhasználó betöltése...");
                const accountDetails = await account.get();
                const enrichedUser = await hydrateUserWithMemberships(accountDetails);
                setUser(enrichedUser);
                setConnected();
            } catch (error) {
                // Nincs bejelentkezve vagy hálózati hiba, de vendég/kijelentkezettként kezeljük a kontextus szempontjából
                membershipsGenRef.current += 1;
                setUser(null);
                setOrganizations([]);
                setEditorialOffices([]);
                setMembershipsError(null);
                setConnected();
            } finally {
                setLoading(false);
            }
        };

        checkUserStatus();
    }, [startConnecting, setConnected, loadAndSetMemberships]);

    /**
     * A hívó saját döntése alapján újratölti a membership state-eket.
     * Leggyakoribb használat: a ScopedWorkspace „Újrapróbálás" gombja
     * egy átmeneti backend hiba után. A rejection-t itt elnyeljük — a hiba
     * már a `membershipsError` state-en keresztül megjelenik, és az onClick
     * handler nem await-eli a promise-t.
     */
    const reloadMemberships = useCallback(() => {
        return loadAndSetMemberships(userRef.current?.$id).catch(() => null);
    }, [loadAndSetMemberships]);

    return (
        <UserContext.Provider value={{
            user,
            login,
            logout,
            register,
            loading,
            organizations,
            editorialOffices,
            membershipsError,
            reloadMemberships
        }}>
            {children}
        </UserContext.Provider>
    );
}

// Alias a visszafelé kompatibilitás érdekében, ha szükséges, bár az AuthorizationProvider-t kellene használnunk
export { AuthorizationProvider as UserProvider };

/**
 * Hook a UserContext használatához.
 * @returns {{
 *   user: Object|null,
 *   login: Function,
 *   logout: Function,
 *   register: Function,
 *   loading: boolean,
 *   organizations: Array,
 *   editorialOffices: Array,
 *   membershipsError: Error|null,
 *   reloadMemberships: Function
 * }} A UserContext értékei.
 */
export function useUser() {
    return useContext(UserContext);
}
