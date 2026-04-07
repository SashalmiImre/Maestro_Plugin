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
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Client, Account, Teams, Databases, Query, ID } from 'appwrite';
import {
    APPWRITE_ENDPOINT,
    APPWRITE_PROJECT_ID,
    DATABASE_ID,
    COLLECTIONS,
    DASHBOARD_URL
} from '../config.js';

const AuthContext = createContext(null);

export function useAuth() {
    return useContext(AuthContext);
}

/** Appwrite kliens — singleton, a DataContext is használja. */
const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID);

const account = new Account(client);
const teams = new Teams(client);
const databases = new Databases(client);

export function getClient() { return client; }
export function getAccount() { return account; }

/**
 * Lekéri a bejelentkezett felhasználó csapattagságait.
 * @returns {Promise<string[]>}
 */
async function fetchTeamIds() {
    try {
        const result = await teams.list();
        return result.teams.map(t => t.$id);
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

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [organizations, setOrganizations] = useState([]);
    const [editorialOffices, setEditorialOffices] = useState([]);
    /**
     * Membership fetch hibaállapot. `null` ha nincs hiba (vagy még nem
     * próbáltuk), `Error` ha a fetchMemberships elszállt. A ProtectedRoute
     * ezt használja a tényleges üres `organizations` tömb (→ onboarding)
     * és az átmeneti backend hiba (→ retry képernyő) megkülönböztetésére.
     */
    const [membershipsError, setMembershipsError] = useState(null);
    const checkedRef = useRef(false);

    /**
     * Memberships betöltése + state frissítése egyetlen helyen.
     * - Sikeres fetch → state set + membershipsError null.
     * - Hiba → state üres marad, membershipsError beállítva, hibát újradobja.
     *
     * A hívók eldönthetik, hogy a hibát propagálják-e (login/register flow)
     * vagy csak a state-re hagyatkoznak (mount effect / ProtectedRoute).
     */
    const loadAndSetMemberships = useCallback(async (userId) => {
        try {
            const memberships = await fetchMemberships(userId);
            setOrganizations(memberships.organizations);
            setEditorialOffices(memberships.editorialOffices);
            setMembershipsError(null);
            return memberships;
        } catch (err) {
            console.warn('[AuthContext] fetchMemberships sikertelen:', err?.message);
            setOrganizations([]);
            setEditorialOffices([]);
            setMembershipsError(err instanceof Error ? err : new Error(err?.message || 'memberships_load_failed'));
            throw err;
        }
    }, []);

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
                // teamIds és memberships paralel — a memberships hibája NEM
                // dobja meg a user setet (a user érvényes, csak a tagság-lookup
                // hibázott; a ProtectedRoute az error state-ből tudja).
                const [teamIds] = await Promise.all([
                    fetchTeamIds(),
                    loadAndSetMemberships(userData.$id).catch(() => null)
                ]);
                setUser({ ...userData, teamIds });
            } catch {
                setUser(null);
                setOrganizations([]);
                setEditorialOffices([]);
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
        // teamIds és memberships paralel. A memberships hiba a state-ben él
        // tovább (membershipsError) — a login művelet sikeres marad, mert a
        // user be van jelentkezve; a ProtectedRoute fogja az error UI-t mutatni.
        const [teamIds] = await Promise.all([
            fetchTeamIds(),
            loadAndSetMemberships(userData.$id).catch(() => null)
        ]);
        const fullUser = { ...userData, teamIds };
        setUser(fullUser);
        return fullUser;
    }, [loadAndSetMemberships]);

    const logout = useCallback(async () => {
        try {
            await account.deleteSession({ sessionId: 'current' });
        } catch {
            // Ha a session már nem létezik, nem baj
        }
        setUser(null);
        setOrganizations([]);
        setEditorialOffices([]);
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
    const register = useCallback(async (name, email, password) => {
        // 1. Fiók — ha ez elszáll, nincs mit visszaforgatni
        await account.create({ userId: ID.unique(), email, password, name });

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
     * A `loadAndSetMemberships` kezeli a state-et és az error flag-et — itt
     * csak swallow-oljuk a thrown error-t, mert a hívó UI a state-ből olvas.
     */
    const reloadMemberships = useCallback(async () => {
        if (!user?.$id) return;
        try {
            await loadAndSetMemberships(user.$id);
        } catch {
            // A loadAndSetMemberships már beállította a membershipsError-t,
            // a hívó UI a state-ből fogja látni az új hibaállapotot.
        }
    }, [user?.$id, loadAndSetMemberships]);

    const value = {
        user,
        loading,
        organizations,
        editorialOffices,
        membershipsError,
        login,
        logout,
        register,
        resendVerification,
        verifyEmail,
        requestRecovery,
        confirmRecovery,
        updatePassword,
        reloadMemberships
    };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}
