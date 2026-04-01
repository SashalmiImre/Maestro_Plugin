/**
 * Maestro Dashboard — Auth Context
 *
 * Felhasználó állapot, bejelentkezés, kijelentkezés, session ellenőrzés.
 * Az Appwrite Web SDK böngészőben natívan kezeli a cookie-kat.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Client, Account, Teams } from 'appwrite';
import { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID } from '../config.js';

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

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const checkedRef = useRef(false);

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
                        await account.deleteSession('current');
                    } catch {
                        // Nincs aktív session, nem baj
                    }
                    client.setJWT(jwt);
                    // URL takarítás — fragment eltávolítása a címsorból
                    window.history.replaceState({}, '', window.location.pathname + window.location.search);
                }

                const userData = await account.get();
                const teamIds = await fetchTeamIds();
                setUser({ ...userData, teamIds });
            } catch {
                setUser(null);
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const login = useCallback(async (email, password) => {
        // Meglévő session törlése, hogy ne ütközzön az új bejelentkezéssel
        try {
            await account.deleteSession('current');
        } catch {
            // Nincs aktív session, nem baj
        }
        await account.createEmailPasswordSession(email, password);
        const userData = await account.get();
        const teamIds = await fetchTeamIds();
        const fullUser = { ...userData, teamIds };
        setUser(fullUser);
        return fullUser;
    }, []);

    const logout = useCallback(async () => {
        try {
            await account.deleteSession('current');
        } catch {
            // Ha a session már nem létezik, nem baj
        }
        setUser(null);
    }, []);

    const value = { user, loading, login, logout };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}
