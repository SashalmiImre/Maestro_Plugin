/**
 * @file UserContext.jsx
 * @description Felhasználói hitelesítés és munkamenet-kezelés.
 * 
 * Biztosítja a bejelentkezett felhasználó adatait és a hitelesítési műveleteket
 * az alkalmazás számára. Kezeli a munkamenet-kéréseket és a kijelentkezést.
 */

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useConnection } from "../contexts/ConnectionContext.jsx";
import { account, executeLogin, handleSignOut, clearLocalSession } from "../config/appwriteConfig.js";
import { realtime } from "../config/realtimeClient.js";
import { MaestroEvent } from "../config/maestroEvents.js";
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

    const { startConnecting, setConnected } = useConnection();

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
            setUser(currentUser);
            return currentUser;
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

            log('[UserContext] Felhasználói adat frissítve (Realtime)');
            setUser(payload);
        });

        return () => {
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, [user?.$id]);

    // Kezdeti állapot ellenőrzése (pl. oldal újratöltés után)
    useEffect(() => {
        const checkUserStatus = async () => {
            try {
                startConnecting("Felhasználó betöltése...");
                const accountDetails = await account.get();
                setUser(accountDetails);
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
        <UserContext.Provider value={{ user, login, logout, loading }}>
            {children}
        </UserContext.Provider>
    );
}

// Alias a visszafelé kompatibilitás érdekében, ha szükséges, bár az AuthorizationProvider-t kellene használnunk
export { AuthorizationProvider as UserProvider };

/**
 * Hook a UserContext használatához.
 * @returns {{ user: Object|null, login: Function, logout: Function, loading: boolean }} A UserContext értékei.
 */
export function useUser() {
    return useContext(UserContext);
}
