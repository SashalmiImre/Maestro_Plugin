/**
 * @file UserContext.jsx
 * @description Felhasználói hitelesítés és munkamenet-kezelés.
 * 
 * Biztosítja a bejelentkezett felhasználó adatait és a hitelesítési műveleteket
 * az alkalmazás számára. Kezeli a munkamenet-kéréseket és a kijelentkezést.
 */

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useConnection } from "../contexts/ConnectionContext.jsx";
import { account, teams, executeLogin, handleSignOut, clearLocalSession, ID, VERIFICATION_URL } from "../config/appwriteConfig.js";
import { realtime } from "../config/realtimeClient.js";
import { MaestroEvent, dispatchMaestroEvent } from "../config/maestroEvents.js";
import { log } from "../utils/logger.js";

/**
 * Context objektum a felhasználói adatok megosztásához.
 * @type {React.Context}
 */
const UserContext = createContext();

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
     * User objektum gazdagítása csapattagsági adatokkal.
     * A teams.list() visszaadja azokat a csapatokat, amelyeknek a felhasználó tagja.
     * A teamIds mezőt a jogosultsági rendszer (canUserMoveArticle) használja.
     *
     * @param {Object} userData - Appwrite user objektum
     * @returns {Promise<Object>} Gazdagított user objektum teamIds mezővel
     */
    const enrichUserWithTeams = async (userData) => {
        try {
            const result = await teams.list();
            return { ...userData, teamIds: result.teams.map(t => t.$id) };
        } catch (error) {
            log('[UserContext] Csapattagság lekérése sikertelen', 'warn');
            return { ...userData, teamIds: userData.teamIds || [] };
        }
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
                // Ha a munkamenet (session) már létezik, folytathatjuk a felhasználó lekérését
                if (error.message && error.message.includes("session is active")) {
                    // Ellenőrizzük, hogy az érvényes munkamenet a kérő felhasználóhoz tartozik-e
                    try {
                        const activeUser = await account.get();
                        if (activeUser.email !== email) {
                            console.warn(`[UserContext] Aktív munkamenet (ID: ${activeUser.$id}) nem egyezik a kért felhasználóval (${maskEmail(email)}). Kijelentkezés...`);
                            await handleSignOut();
                            retried = true;
                            await executeLogin(email, password);
                        } else {
                            console.log(`[UserContext] Aktív munkamenet újrafelhasználása: ${maskEmail(email)}`);
                        }
                    } catch (sessionCheckError) {
                        // A session cookie létezik, de a szerveren érvénytelen (pl. admin törölte)
                        if (retried) throw sessionCheckError;
                        console.warn('[UserContext] Érvénytelen munkamenet, helyi session törlése és újrapróbálkozás...');
                        clearLocalSession();
                        retried = true;
                        await executeLogin(email, password);
                    }
                } else {
                    // Nem "session is active" hiba — lehet stale cookie okozza
                    // (pl. "missing scopes" ha az SDK az érvénytelen tokent küldi).
                    // Töröljük a helyi session-t és újrapróbáljuk egyszer.
                    if (retried) throw error;
                    console.warn('[UserContext] Bejelentkezés sikertelen, helyi session törlése és újrapróbálkozás...', error.message);
                    clearLocalSession();
                    retried = true;
                    await executeLogin(email, password);
                }
            }
            const currentUser = await account.get();
            const enrichedUser = await enrichUserWithTeams(currentUser);
            setUser(enrichedUser);
            return enrichedUser;
        } catch (error) {
            console.error("Bejelentkezés sikertelen:", error);
            throw error;
        }
    };

    /**
     * Kijelentkezés végrehajtása.
     * Törli a helyi felhasználói állapotot és a szerver oldali munkamenetet.
     */
    const logout = async () => {
        try {
            await handleSignOut();
        } catch (error) {
            console.error("Kijelentkezés sikertelen:", error);
        } finally {
            setUser(null);
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
            await account.create(ID.unique(), email, password, name);

            // 2. Ideiglenes bejelentkezés (a createVerification session-t igényel)
            await executeLogin(email, password);

            // 3. Verificációs email küldése
            await account.createVerification(VERIFICATION_URL);

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

        const unsubscribe = realtime.subscribe('account', (response) => {
            const { payload } = response;
            if (!payload || !payload.$id) return;

            // Csak akkor frissítünk, ha az adat tényleg változott.
            // A payload-ban nincs teamIds (az Appwrite nem küldi), ezért megőrizzük a meglévőt.
            setUser(prev => {
                if (prev && prev.$updatedAt === payload.$updatedAt) return prev;
                log('[UserContext] Felhasználói adat frissítve (Realtime)');
                return { ...payload, teamIds: prev?.teamIds || [] };
            });
        });

        return () => {
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, [user?.$id]);

    // Felhasználói adatok frissítése recovery-nél (labels, prefs, teamIds stb.)
    useEffect(() => {
        if (!user) return;

        const handleRefresh = async () => {
            try {
                const updatedUser = await account.get();
                const enrichedUser = await enrichUserWithTeams(updatedUser);
                // Csak akkor frissítünk, ha az adat tényleg változott.
                // Enélkül az account.get() mindig új referenciát ad, ami felesleges
                // re-rendereket okoz a teljes fában (LockManager useEffect[user] stb.)
                setUser(prev => {
                    if (prev && prev.$updatedAt === enrichedUser.$updatedAt
                        && JSON.stringify(prev.teamIds) === JSON.stringify(enrichedUser.teamIds)) {
                        return prev;
                    }
                    log('[UserContext] Felhasználói adatok frissítve (recovery)');
                    return enrichedUser;
                });
            } catch (error) {
                // 401 → sessionExpired event kezeli, egyéb hiba nem kritikus
                log('[UserContext] Felhasználói adatok frissítése sikertelen', 'warn');
            }
        };

        window.addEventListener(MaestroEvent.dataRefreshRequested, handleRefresh);
        return () => window.removeEventListener(MaestroEvent.dataRefreshRequested, handleRefresh);
    }, [user?.$id]);

    // Csapattagság Realtime szinkronizálása
    // A DataContext a `teams` csatornán figyeli a tagság-változásokat és dispatch-eli
    // a teamMembershipChanged MaestroEvent-et. Itt frissítjük a user.teamIds-t.
    useEffect(() => {
        if (!user) return;

        const handleTeamChange = async () => {
            try {
                const result = await teams.list();
                const teamIds = result.teams.map(t => t.$id);
                setUser(prev => {
                    if (!prev) return prev;
                    if (JSON.stringify(prev.teamIds) === JSON.stringify(teamIds)) return prev;
                    log('[UserContext] Csapattagság frissítve (Realtime)');
                    return { ...prev, teamIds };
                });
            } catch (error) {
                log('[UserContext] Csapattagság frissítése sikertelen', 'warn');
            }
        };

        window.addEventListener(MaestroEvent.teamMembershipChanged, handleTeamChange);
        return () => window.removeEventListener(MaestroEvent.teamMembershipChanged, handleTeamChange);
    }, [user?.$id]);

    // Kezdeti állapot ellenőrzése (pl. oldal újratöltés után)
    useEffect(() => {
        const checkUserStatus = async () => {
            try {
                startConnecting("Felhasználó betöltése...");
                const accountDetails = await account.get();
                const enrichedUser = await enrichUserWithTeams(accountDetails);
                setUser(enrichedUser);
                setConnected();
            } catch (error) {
                // Nincs bejelentkezve vagy hálózati hiba, de vendég/kijelentkezettként kezeljük a kontextus szempontjából
                setUser(null);
                setConnected();
            } finally {
                setLoading(false);
            }
        };

        checkUserStatus();
    }, [startConnecting, setConnected]);

    return (
        <UserContext.Provider value={{ user, login, logout, register, loading }}>
            {children}
        </UserContext.Provider>
    );
}

// Alias a visszafelé kompatibilitás érdekében, ha szükséges, bár az AuthorizationProvider-t kellene használnunk
export { AuthorizationProvider as UserProvider };

/**
 * Hook a UserContext használatához.
 * @returns {{ user: Object|null, login: Function, logout: Function, register: Function, loading: boolean }} A UserContext értékei.
 */
export function useUser() {
    return useContext(UserContext);
}
