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

        return resolveGroupSlugs(membershipsResult.documents, groupsResult.documents);
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
            setOrgMemberships(memberships.orgMemberships);
            setMembershipsError(null);
            return memberships;
        } catch (err) {
            console.warn('[AuthContext] fetchMemberships sikertelen:', err?.message);
            setOrganizations([]);
            setEditorialOffices([]);
            setOrgMemberships([]);
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

    /**
     * B.5 — Új organization + editorial office létrehozása az OnboardingRoute-ról.
     *
     * Az `invite-to-organization` Cloud Function `bootstrap_organization`
     * action-jét hívja. A CF API key-jel, atomikusan hoz létre 4 rekordot
     * (organizations + organizationMemberships[owner] + editorialOffices +
     * editorialOfficeMemberships[admin]), és hibakezelés + rollback is a
     * szerveren történik.
     *
     * Miért CF és nem közvetlen kliens-írás? A 4 tenant collection ACL-je
     * `read("users")`-re van szűkítve — csak a szerver írhat. Így nincs
     * módja egy malicious kliensnek arbitrárisan membership-et létrehozni.
     *
     * @returns {Promise<{organizationId: string, editorialOfficeId: string}>}
     */
    const createOrganization = useCallback(async (orgName, orgSlug, officeName, officeSlug) => {
        if (!user?.$id) {
            throw new Error('not_authenticated');
        }

        const response = await callInviteFunction(
            'bootstrap_organization',
            { orgName, orgSlug, officeName, officeSlug },
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
            editorialOfficeId: response.editorialOfficeId
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
    const createInvite = useCallback(async (organizationId, email, role = 'member', message) => {
        if (!user?.$id) {
            throw new Error('not_authenticated');
        }

        const response = await callInviteFunction(
            'create',
            { organizationId, email, role, ...(message ? { message } : {}) },
            'create_failed'
        );

        return {
            inviteId: response.inviteId,
            token: response.token,
            expiresAt: response.expiresAt,
            role: response.role,
            email: response.email,
            organizationId: response.organizationId
        };
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
        acceptInvite,
        createInvite,
        deleteOrganization,
        deleteEditorialOffice
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
        acceptInvite,
        createInvite,
        deleteOrganization,
        deleteEditorialOffice
    ]);

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}
