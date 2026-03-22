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
import { log, logWarn, logError } from "../utils/logger.js";

/**
 * Context objektum a felhasználói adatok megosztásához.
 * @type {React.Context}
 */
const UserContext = createContext();

/**
 * Sorrend-független string[] egyenlőség ellenőrzés (teamIds összehasonlításához).
 * Compares unique elements using Sets to handle duplicates correctly.
 * @param {string[]|undefined} a
 * @param {string[]|undefined} b
 * @returns {boolean}
 */
const sameTeamIds = (a, b) => {
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
     * Csapattagságot frissít teams.list() alapján és setUser-rel alkalmazza.
     * Ha az adat nem változott, nem okoz re-rendert.
     *
     * @param {string} logLabel - Naplózásban megjelenő kontextus-azonosító.
     */
    const refreshTeamIds = async (logLabel) => {
        try {
            const result = await teams.list();
            const teamIds = result.teams.map(t => t.$id);
            setUser(prev => {
                if (!prev) return prev;
                if (sameTeamIds(prev.teamIds, teamIds)) return prev;
                log(`[UserContext] Csapattagság frissítve (${logLabel})`);
                return { ...prev, teamIds };
            });
        } catch (error) {
            logWarn(`[UserContext] Csapattagság frissítése sikertelen (${logLabel})`);
        }
    };

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
            logWarn('[UserContext] Csapattagság lekérése sikertelen');
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
            const enrichedUser = await enrichUserWithTeams(currentUser);
            setUser(enrichedUser);
            return enrichedUser;
        } catch (error) {
            logError(`[UserContext] Bejelentkezés sikertelen (code: ${error.code}, type: ${error.type}): ${error.message}`);
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
            logError("[UserContext] Kijelentkezés sikertelen:", error);
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

        const unsubscribe = realtime.subscribe('account', async (response) => {
            const { events, payload } = response;

            // Tagság-változás: az account payload nem tartalmaz teamIds-t,
            // de az events tömbben megjelenik a memberships esemény
            // (pl. users.ID.memberships.ID.create / .delete)
            const hasMembershipEvent = events?.some(e => e.includes('.memberships.'));
            if (hasMembershipEvent) {
                await refreshTeamIds('Realtime / account csatorna');
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
            // A payload-ban nincs teamIds (az Appwrite nem küldi), ezért megőrizzük a meglévőt.
            setUser(prev => {
                if (prev && prev.$updatedAt === payload.$updatedAt) return prev;
                log('[UserContext] Felhasználói adat frissítve (Realtime)');
                return {
                    ...payload,
                    name: payload.name || prev?.name,
                    email: payload.email || prev?.email,
                    teamIds: prev?.teamIds || []
                };
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
                        && sameTeamIds(prev.teamIds, enrichedUser.teamIds)) {
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

    // Csapattagság Realtime szinkronizálása
    // A DataContext a `teams` csatornán figyeli a tagság-változásokat és dispatch-eli
    // a teamMembershipChanged MaestroEvent-et. Itt frissítjük a user.teamIds-t.
    useEffect(() => {
        if (!user) return;

        const handleTeamChange = () => refreshTeamIds('Realtime');

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
