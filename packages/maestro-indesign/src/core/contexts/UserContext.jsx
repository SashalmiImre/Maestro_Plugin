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
import { OFFICE_SCOPE_PERMISSION_SLUGS } from "maestro-shared/permissions.js";
import { realtime } from "../config/realtimeClient.js";
import { MaestroEvent, dispatchMaestroEvent } from "../config/maestroEvents.js";
import { log, logWarn, logError } from "../utils/logger.js";
import { withRetry, withTimeout, paginateAll } from "../utils/promiseUtils.js";
import { FETCH_TIMEOUT_CONFIG, STORAGE_ORG_KEY, STORAGE_OFFICE_KEY } from "../utils/constants.js";

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

    const { slugs, missingGroupIds } = resolveGroupSlugs(membershipsResult.documents, groupsResult.documents);
    if (missingGroupIds.length > 0) {
        logWarn(`[UserContext] Inkonzisztens csoporttagság — ${missingGroupIds.length} groupId nem oldódott fel (törölt / race): ${missingGroupIds.join(', ')}`);
    }
    return slugs;
}

// ── Permission-set snapshot (A.5.1, ADR 0008) ──────────────────────────────
//
// A `user.permissions` mező a kliens-oldali office-scope cache (33 slug max).
// A server `buildPermissionSnapshot` (CF `permissions.js`) replikája — DB
// query-szinten azonos lépéssorozat, hogy a dashboard guardok és a CF authority
// egyező döntést hozzon ugyanazon `(userId, officeId)` párra.
//
// **Drift-rizikó (A.7.1, Phase 2)**: a snapshot logika 3 helyen él (server CF,
// shared sync helpers, plugin lookup itt). Single-source bundle vagy AST-equality
// CI test rendezné — addig manuális szinkron a `permissions.js`-szel.
//
// **Tri-state**: a hívók a `user.permissions === null` értéken (még hydratáláson)
// fail-closed-ot kapnak (`clientHasPermission(null, slug) === false`), vagyis
// loading közben semmi UI elem nem engedi az új réteg ellen — ez konzervatív,
// de a `groupSlugs` (workflow-runtime) független és jellemzően a UI-elemek
// guardja, ezért a Plugin happy path nem észlel funkcionális regressziót.

/**
 * `editorialOfficeMemberships` cross-check egyetlen `(userId, officeId)` párra.
 * Defense-in-depth a member-pathon: ha a user nincs az office tagjai közt,
 * a permission set lookup eredménye fail-closed üres set (ld. server
 * `isStillOfficeMember`).
 *
 * **DB-hiba dob** — a hívó (`fetchUserPermissionSlugs`) propagálja, hogy az
 * `enrichUserWithPermissions` / `refreshPermissions` "őrizd meg a régit"
 * mintába kerüljön. A "0 dokumentum" eredmény legitim `false` (= nem tag).
 */
async function isUserOfficeMember(userId, editorialOfficeId) {
    if (!userId || !editorialOfficeId) return false;
    const result = await listWithResilience({
        databaseId: DATABASE_ID,
        collectionId: COLLECTIONS.EDITORIAL_OFFICE_MEMBERSHIPS,
        queries: [
            Query.equal('userId', userId),
            Query.equal('editorialOfficeId', editorialOfficeId),
            Query.limit(1)
        ]
    }, 'fetchOfficeMembershipForPermission');
    return result.documents.length > 0;
}

/**
 * Egy `(userId, organizationId)` pár org-role-jét keresi.
 * Visszaad `'owner' | 'admin' | 'member' | null`. A "0 dokumentum" eredmény
 * legitim `null` (= nem tag az orgban). DB-hiba **dob** — a hívó propagálja.
 */
async function fetchOrgRoleForUser(userId, organizationId) {
    if (!userId || !organizationId) return null;
    const result = await listWithResilience({
        databaseId: DATABASE_ID,
        collectionId: COLLECTIONS.ORGANIZATION_MEMBERSHIPS,
        queries: [
            Query.equal('userId', userId),
            Query.equal('organizationId', organizationId),
            Query.limit(1)
        ]
    }, 'fetchOrgRoleForPermission');
    const doc = result.documents[0];
    return doc?.role || null;
}

/**
 * Office → organizationId resolver. Az office doc-ot vagy a már letöltött
 * `editorialOffices` state-ből kapja (gyors path), vagy DB-ből (fallback).
 *
 * 404 → `null` (legitim "nincs ilyen office"); egyéb hibára **dob**, hogy a
 * hívó "őrizd meg a régit" mintába kerüljön.
 */
async function resolveOrgIdForOffice(editorialOfficeId, offices) {
    if (!editorialOfficeId) return null;
    const cached = Array.isArray(offices)
        ? offices.find(o => o.$id === editorialOfficeId)
        : null;
    if (cached?.organizationId) return cached.organizationId;
    try {
        const office = await withRetry(
            () => withTimeout(
                databases.getDocument({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.EDITORIAL_OFFICES,
                    documentId: editorialOfficeId
                }),
                FETCH_TIMEOUT_CONFIG.CRITICAL_DATA_MS,
                'fetchOfficeForPermission'
            ),
            { operationName: 'fetchOfficeForPermission' }
        );
        return office?.organizationId || null;
    } catch (err) {
        if (err?.code === 404) return null;
        throw err;
    }
}

/**
 * Member-path permission-slug lookup. 3 paginált DB hívás:
 *   1. `groupMemberships` az office-ban → `groupId`-list
 *   2. `groupPermissionSets` (m:n junction) chunkolt `Query.equal('groupId', chunk)`
 *      → `permissionSetId`-list
 *   3. `permissionSets` (`archivedAt === null` szűrt) → `permissions[]`
 *
 * Defense-in-depth: csak `OFFICE_SCOPE_PERMISSION_SLUGS`-ban szereplő slug-okat
 * fogadunk el (mintha valaki kézzel `org.*`-ot tett volna a doc-ba).
 *
 * **DB-hiba dob** — a hívó (`fetchUserPermissionSlugs`) propagálja, hogy az
 * `enrichUserWithPermissions` / `refreshPermissions` "őrizd meg a régit"
 * mintába kerüljön. A "0 dokumentum" lépcsőkön legitim `[]` (= nincs csoport,
 * nincs assignment, nincs aktív permission set).
 *
 * @param {string} userId
 * @param {string} editorialOfficeId
 * @returns {Promise<string[]>} permission slug array (deduplikált, csak office-scope)
 */
async function fetchMemberPermissionSlugs(userId, editorialOfficeId) {
    const APPWRITE_QUERY_EQUAL_LIMIT = 100;
    const officeSlugSet = new Set(OFFICE_SCOPE_PERMISSION_SLUGS);

    const paginatedListResilient = (collectionId, baseQueries, opName) => paginateAll(
        (queries) => listWithResilience({ databaseId: DATABASE_ID, collectionId, queries }, opName),
        { baseQueries, cursorAfterFn: Query.cursorAfter, limitFn: Query.limit, operationName: opName }
    );

    // 1) groupMemberships → groupId-list
    const memberships = await paginatedListResilient(
        COLLECTIONS.GROUP_MEMBERSHIPS,
        [Query.equal('userId', userId), Query.equal('editorialOfficeId', editorialOfficeId)],
        'fetchGroupMembershipsForPermission'
    );
    const groupIds = memberships.map(d => d.groupId).filter(Boolean);
    if (groupIds.length === 0) return [];

    // 2) groupPermissionSets — chunkolva (Appwrite Query.equal-array hard limit 100)
    const permissionSetIds = new Set();
    for (let chunkStart = 0; chunkStart < groupIds.length; chunkStart += APPWRITE_QUERY_EQUAL_LIMIT) {
        const chunk = groupIds.slice(chunkStart, chunkStart + APPWRITE_QUERY_EQUAL_LIMIT);
        const junctions = await paginatedListResilient(
            COLLECTIONS.GROUP_PERMISSION_SETS,
            [Query.equal('groupId', chunk)],
            'fetchGroupPermissionSets'
        );
        for (const doc of junctions) {
            if (doc.permissionSetId) permissionSetIds.add(doc.permissionSetId);
        }
    }
    if (permissionSetIds.size === 0) return [];

    // 3) permissionSets — chunkolva, archivedAt=null szűrt; defense-in-depth
    //    csak az `OFFICE_SCOPE_PERMISSION_SLUGS`-ban szereplő slug-okat fogadunk el.
    const slugs = new Set();
    const ids = [...permissionSetIds];
    for (let chunkStart = 0; chunkStart < ids.length; chunkStart += APPWRITE_QUERY_EQUAL_LIMIT) {
        const chunk = ids.slice(chunkStart, chunkStart + APPWRITE_QUERY_EQUAL_LIMIT);
        const sets = await paginatedListResilient(
            COLLECTIONS.PERMISSION_SETS,
            [Query.equal('$id', chunk), Query.isNull('archivedAt')],
            'fetchPermissionSets'
        );
        for (const doc of sets) {
            const arr = Array.isArray(doc.permissions) ? doc.permissions : [];
            for (const slug of arr) {
                if (officeSlugSet.has(slug)) slugs.add(slug);
            }
        }
    }

    return [...slugs];
}

/**
 * A felhasználó office-scope permission slug array-jét (33 slug max) számolja
 * a server `buildPermissionSnapshot` lépéseit követve:
 *   1. `user.labels?.includes('admin')` (Appwrite global admin label) → 33 slug
 *   2. `organizationMemberships.role === 'owner' | 'admin'` → 33 slug
 *   3. Member-path: defense-in-depth office-tagság cross-check + permission set lookup.
 *
 * @param {Object} user - Appwrite account.get() válasz (`$id`, `labels`)
 * @param {string} editorialOfficeId
 * @param {Array} [offices] - opcionális, az `editorialOffices` state — gyorsít
 *     az office → orgId resolve-on (egy DB hívás megspórolva).
 * @returns {Promise<string[]>} permission slug array (deduplikált, csak office-scope)
 */
async function fetchUserPermissionSlugs(user, editorialOfficeId, offices) {
    if (!user?.$id || !editorialOfficeId) return [];

    if (Array.isArray(user.labels) && user.labels.includes('admin')) {
        return [...OFFICE_SCOPE_PERMISSION_SLUGS];
    }

    const organizationId = await resolveOrgIdForOffice(editorialOfficeId, offices);
    const orgRole = organizationId
        ? await fetchOrgRoleForUser(user.$id, organizationId)
        : null;

    if (orgRole === 'owner' || orgRole === 'admin') {
        return [...OFFICE_SCOPE_PERMISSION_SLUGS];
    }

    // Member-path — defense-in-depth: ha nincs office-tagság, üres set
    // (mint a server `isStillOfficeMember` cross-check).
    const stillMember = await isUserOfficeMember(user.$id, editorialOfficeId);
    if (!stillMember) return [];

    return await fetchMemberPermissionSlugs(user.$id, editorialOfficeId);
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
 * Sorrend-független string[] egyenlőség ellenőrzés általános célra
 * (permissions snapshot diffing). `null`/`undefined` és `Array` keverhető:
 * két `null` egyenlő; `null` és üres array NEM egyenlő (ez direkt — a
 * `null` = "loading", a `[]` = "hydrated, üres jog").
 */
const sameStringSet = (a, b) => {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;

    if (a.length !== b.length) return false;
    const setA = new Set(a);
    if (setA.size !== b.length) {
        // Duplikátumok mindkét oldalon — ritka, de a Set-cmp védi
        const setB = new Set(b);
        if (setA.size !== setB.size) return false;
        return Array.from(setA).every(s => setB.has(s));
    }
    for (const s of b) {
        if (!setA.has(s)) return false;
    }
    return true;
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
     * Auth generáció-számláló. Minden `setUser(...)` előtti aszinkron
     * hydrate (login / checkUserStatus / recovery refresh) bumpolja belépéskor,
     * a logout / sessionExpired event is bumpolja — így egy in-flight
     * hydrate válasza nem tud egy közben kijelentkeztetett usert
     * resurrectelni. A záró setUser ellenőrzi, hogy a saját generációja
     * még aktuális-e; ha nem, a választ eldobjuk.
     */
    const authGenRef = useRef(0);

    /**
     * GroupSlugs fetch generáció-számláló. A `refreshGroupSlugs` minden hívása
     * bumpolja, és csak az utoljára indított hívás commit-ol. Így gyors
     * egymás utáni triggerek (scopeChanged + groupMembershipChanged) közül
     * nem írhat felül egy korábbi, más office-ra indult válasz egy későbbi
     * setUser-t — védi a per-office groupSlugs konzisztenciát.
     */
    const groupSlugsGenRef = useRef(0);

    /**
     * Permission-snapshot fetch generáció-számláló (A.5.1). A `refreshPermissions`
     * minden hívása bumpolja; csak a legutolsó hívás commit-ol. Védi a
     * cross-office leakage-et (gyors scopeChanged + permissionSetsChanged race).
     */
    const permissionsGenRef = useRef(0);

    /**
     * `editorialOffices` ref — a `enrichUserWithPermissions` az office → orgId
     * resolve-hoz használja. Az állapot-frissítés és a perm-fetch között
     * az állapot lehet még a régi (mert a memberships paralel fut), ezért
     * fallback-elünk DB getDocument-ra, ha nincs cache hit.
     */
    const editorialOfficesRef = useRef([]);
    useEffect(() => { editorialOfficesRef.current = editorialOffices; }, [editorialOffices]);

    /**
     * Mind a 4 auth-generation counter bumpolása. Auth-boundary átmenetnél
     * (login start, logout, sessionExpired) hívandó: egy in-flight
     * `enrichUserWithGroups` / `enrichUserWithPermissions` / `loadAndSetMemberships`
     * válasza ne tudja a következő munkamenetet az előző user adataival
     * megfertőzni. A `++` operator a `authGenRef`-en kívül rendben van —
     * a többi gen-ref-et nem kell visszakapni a hívónak.
     */
    const bumpAllAuthGens = () => {
        authGenRef.current += 1;
        groupSlugsGenRef.current += 1;
        permissionsGenRef.current += 1;
        membershipsGenRef.current += 1;
    };

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
     * Aktív editorialOfficeId kiolvasása localStorage-ból. A ScopeContext
     * bootstrap-eli és minden scope váltáskor szinkron írja ide (még a
     * `scopeChanged` dispatch ELŐTT), így azok a hívók, akiknek nincs a
     * payload-jukban az officeId (pl. groupMembershipChanged, Realtime account
     * memberships), innen kaphatják meg. A helper kizárólag a hívó oldalt
     * szolgálja — az `enrichUserWithGroups` / `refreshGroupSlugs` már
     * paraméterként kapja, hogy ne függjön rejtve a perzisztenciától.
     */
    const getPersistedOfficeId = () => {
        try {
            return window.localStorage.getItem(STORAGE_OFFICE_KEY);
        } catch (e) {
            return null;
        }
    };

    /**
     * Csoporttagságot frissít groupMemberships + groups query alapján és
     * setUser-rel alkalmazza. Ha az adat nem változott, nem okoz re-rendert.
     *
     * Generáció-guard: minden hívás bumpolja a `groupSlugsGenRef`-et, és a
     * fetch UTÁN csak akkor commit-ol, ha még ő a legutolsó hívás. Enélkül
     * egy lassú office-A fetch felülírhatná egy gyorsabb office-B választ
     * (pl. scopeChanged + groupMembershipChanged gyors egymás utáni trigger).
     *
     * @param {string} logLabel - Naplózásban megjelenő kontextus-azonosító.
     * @param {string|null} officeId - Az aktív szerkesztőség ID-ja (a hívó
     *     paraméterként adja át — vagy event payload-ból, vagy localStorage-ból).
     */
    const refreshGroupSlugs = async (logLabel, officeId) => {
        // userRef-ből olvassuk a $id-t, hogy a handler (pl. groupMembershipChanged)
        // soha ne a bezárt closure stale user-ére lőjön. Logout közben
        // userRef.current === null → korai kilépés (guard alább).
        const currentUserId = userRef.current?.$id;
        if (!currentUserId) return;
        const gen = ++groupSlugsGenRef.current;
        try {
            if (!officeId) {
                setUser(prev => {
                    if (!prev) return prev;
                    if (prev.$id !== currentUserId) return prev;
                    if (sameGroupSlugs(prev.groupSlugs, [])) return prev;
                    return { ...prev, groupSlugs: [] };
                });
                return;
            }
            const groupSlugs = await fetchGroupSlugsForUser(currentUserId, officeId);
            if (gen !== groupSlugsGenRef.current) {
                log(`[UserContext] Stale groupSlugs válasz eldobva (${logLabel})`);
                return;
            }
            setUser(prev => {
                if (!prev) return prev;
                // Cross-user leakage védelem (Codex baseline review): a fetch
                // indulása óta auth-boundary-csere (logout + másik user login)
                // történhetett. Ha a prev.$id már nem egyezik azzal, akire a
                // lookup ment, NE írjuk át — a gen-ref bump már védett, ez
                // belt-and-suspenders defense.
                if (prev.$id !== currentUserId) {
                    log(`[UserContext] groupSlugs válasz user-mismatch eldobva (${logLabel})`);
                    return prev;
                }
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
     * @param {string|null} officeId - Az aktív szerkesztőség ID-ja
     * @returns {Promise<Object>} Gazdagított user objektum groupSlugs mezővel
     */
    const enrichUserWithGroups = async (userData, officeId) => {
        try {
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
     * User objektum gazdagítása permission-set snapshot-tal (A.5.1, ADR 0008).
     * A `permissions` mező 3 értéket vehet fel:
     *   - `null` — még nem hydratált (loading); a `clientHasPermission(null, slug)`
     *     `false`-t ad, így a guardok konzervatívak.
     *   - `[]` — sikeresen lekérdezett, de nincs jog (member-path 0 set).
     *   - `string[]` — 33 office-scope slug subset-je.
     *
     * Hibakezelés: ha a lookup elszáll, **megőrizzük az előzőt** (`previousPermissions`
     * paraméter) — a Codex roast szerinti "őrizd meg a régit" mintát követve,
     * hogy egy tranziens hálózati hiba ne okozzon tartós false-negative UX-et.
     * A belső lookup helperek (DB-hiba esetén) propagálják a hibát ide; a
     * "0 dokumentum" lépcsőkön (nincs csoport / nincs assignment / nincs aktív
     * permission set) legitim `[]` jön vissza, NEM hiba.
     *
     * @param {Object} userData - Appwrite user objektum (`$id`, `labels`)
     * @param {string|null} officeId - Az aktív szerkesztőség ID-ja
     * @param {string[]|null|undefined} previousPermissions - Az előző snapshot
     *   a setUser commit-hoz (`userRef.current?.permissions`). `null` / `undefined`
     *   = még nem hydratált, a hibaág is `null`-ra esik (a tri-state szemantika
     *   tiszta).
     * @returns {Promise<Object>} Gazdagított user objektum `permissions` mezővel
     */
    const enrichUserWithPermissions = async (userData, officeId, previousPermissions) => {
        try {
            if (!officeId) {
                return { ...userData, permissions: [] };
            }
            const permissions = await fetchUserPermissionSlugs(userData, officeId, editorialOfficesRef.current);
            return { ...userData, permissions };
        } catch (error) {
            logWarn(`[UserContext] Permission-snapshot lekérése sikertelen (${error?.message}) — előző érték megtartva`);
            // `??` (nem `||`): üres array (`[]`) megőrzendő — egy korábbi
            // sikeres "0 jog" eredményt ne nyomjuk vissza `null`-ra.
            return { ...userData, permissions: previousPermissions ?? null };
        }
    };

    /**
     * Paralel lefuttatja a `groupSlugs` és `permissions` enrichment-et,
     * valamint az org/office memberships betöltését. A memberships hibáját
     * **nem** propagálja — a `membershipsError` state-en keresztül jelenik
     * meg a `ScopedWorkspace`-nek.
     *
     * Sorrend: a memberships fetch párhuzamos, hogy az `editorialOfficesRef`
     * mihamarabb feltöltődjön a `enrichUserWithPermissions` office → orgId
     * resolve-jához (cache hit, egy DB hívás megspórolva). Ha az office még
     * nincs a state-ben, a `resolveOrgIdForOffice` DB getDocument-tel pótol.
     *
     * @param {Object} userData - Appwrite user objektum
     * @param {string|null} officeId - Az aktív szerkesztőség ID-ja
     * @param {string[]|null|undefined} previousPermissions - Opcionális, az
     *   előző `permissions` érték (recovery / re-hydrate hívókra). Login-on
     *   `null` (először hidratál); recovery-n `userRef.current?.permissions`.
     */
    const hydrateUserWithMemberships = async (userData, officeId, previousPermissions = null) => {
        const [enrichedWithGroups, enrichedWithPerms] = await Promise.all([
            enrichUserWithGroups(userData, officeId),
            enrichUserWithPermissions(userData, officeId, previousPermissions),
            loadAndSetMemberships(userData.$id).catch(() => null)
        ]);
        // A két enrich párhuzamosan futott — egyesítsük a friss user-en
        return {
            ...enrichedWithGroups,
            permissions: enrichedWithPerms.permissions
        };
    };

    /**
     * `user.permissions` snapshot újraszámolása + setUser. Generáció-guard
     * (`permissionsGenRef`) védi a cross-office race-t. A loadása nem
     * blokkoló — a hibákat lenyeli.
     *
     * @param {string} logLabel - naplózási kontextus (Realtime / scopeChanged / dataRefreshRequested)
     * @param {string|null} officeId - aktív szerkesztőség (event payload vagy localStorage)
     */
    const refreshPermissions = async (logLabel, officeId) => {
        const currentUser = userRef.current;
        const currentUserId = currentUser?.$id;
        if (!currentUserId) return;
        const gen = ++permissionsGenRef.current;
        try {
            const permissions = officeId
                ? await fetchUserPermissionSlugs(currentUser, officeId, editorialOfficesRef.current)
                : [];
            if (gen !== permissionsGenRef.current) {
                log(`[UserContext] Stale permissions válasz eldobva (${logLabel})`);
                return;
            }
            setUser(prev => {
                if (!prev) return prev;
                // Cross-user guard, ld. refreshGroupSlugs.
                if (prev.$id !== currentUserId) {
                    log(`[UserContext] permissions válasz user-mismatch eldobva (${logLabel})`);
                    return prev;
                }
                if (sameStringSet(prev.permissions, permissions)) return prev;
                log(`[UserContext] Permission-snapshot frissítve (${logLabel})`);
                return { ...prev, permissions };
            });
        } catch (error) {
            logWarn(`[UserContext] Permission-snapshot frissítése sikertelen (${logLabel})`);
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

        // Staleness guard: közben érkező logout / sessionExpired ezt bumpolja,
        // így a hydrate válasza nem tud egy nullázott usert resurrectelni.
        // Cross-user leakage védelem (Codex baseline review): mind4 gen-ref-et
        // bumpoljuk, hogy egy előző munkamenetből in-flight refresh válasza
        // ne tudja az új user.permissions / user.groupSlugs mezőit megfertőzni.
        bumpAllAuthGens();
        const gen = authGenRef.current;

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
            const enrichedUser = await hydrateUserWithMemberships(currentUser, getPersistedOfficeId());
            if (gen !== authGenRef.current) {
                log('[UserContext] Stale login válasz eldobva — közben logout/sessionExpired történt');
                throw new Error('stale_login');
            }
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
            // Mind a 4 auth-gen bump: egy in-flight hydrate / refresh válasza
            // ne tudjon a logout UTÁN setUser-rel resurrect-elni egy már
            // nullázott usert, és ne tudja az új munkamenetbe szivárogtatni
            // az előző user adatait (Codex baseline review cross-user fix).
            bumpAllAuthGens();
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
            // Mind a 4 auth-gen bump (ld. logout finally) — in-flight hydrate
            // / refresh nem hozhatja vissza a törölt session userét, és nem
            // szivároghat a következő munkamenetbe.
            bumpAllAuthGens();
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
                // Az `account` Realtime payload nem tartalmazza az aktív office-t,
                // ezért a perzisztált értékből olvassuk — ez a ScopeContext által
                // szinkron írt aktuális officeId. A refreshGroupSlugs gen guard-ja
                // megvédi, ha közben scope-váltás történik.
                await refreshGroupSlugs('Realtime / account csatorna', getPersistedOfficeId());
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
                    groupSlugs: prev?.groupSlugs || [],
                    // A permissions Realtime account payload-ban nincs (különálló
                    // collection-ek). Megőrizzük az előzőt, hogy a tri-state
                    // jelentése nem cserélődjön váratlanul `null`-ra.
                    permissions: prev?.permissions ?? null
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
            // Staleness guard: recovery alatt érkező sessionExpired / logout /
            // új login a bumpolással invalidálja a még futó hydrate-et, így
            // az in-flight válasz nem tud egy közben nullázott usert resurrectelni.
            const gen = ++authGenRef.current;
            try {
                const updatedUser = await account.get();
                // Recovery-n megőrizzük az előző permission-snapshot-ot, hogy
                // egy tranziens DB hiba ne tüntesse el (a Realtime push később
                // úgyis konvergálja).
                const previousPermissions = userRef.current?.permissions ?? null;
                const enrichedUser = await hydrateUserWithMemberships(updatedUser, getPersistedOfficeId(), previousPermissions);
                if (gen !== authGenRef.current) {
                    log('[UserContext] Stale recovery hydrate válasz eldobva');
                    return;
                }
                // Csak akkor frissítünk, ha az adat tényleg változott.
                // Enélkül az account.get() mindig új referenciát ad, ami felesleges
                // re-rendereket okoz a teljes fában (LockManager useEffect[user] stb.)
                setUser(prev => {
                    if (prev && prev.$updatedAt === enrichedUser.$updatedAt
                        && sameGroupSlugs(prev.groupSlugs, enrichedUser.groupSlugs)
                        && sameStringSet(prev.permissions, enrichedUser.permissions)) {
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
    // user.groupSlugs-t. A.5.3 — a `groupMemberships` változás a permission-set
    // snapshotot is érinti (new memberships → new groups → new permission set
    // assignments), ezért a `refreshPermissions` is fut.
    useEffect(() => {
        if (!user) return;

        // groupMembershipChanged: a payload-ban nincs office (collection-szintű
        // event), ezért a perzisztált officeId-t használjuk.
        const handleGroupChange = () => {
            const officeId = getPersistedOfficeId();
            refreshGroupSlugs('Realtime', officeId);
            refreshPermissions('Realtime / groupMemberships', officeId);
        };
        // scopeChanged: a ScopeContext a payload-ban explicit küldi az új
        // editorialOfficeId-t (ld. ScopeContext.setActiveOffice). Ezt
        // preferáljuk a localStorage olvasás helyett — közvetlen forrás,
        // és nincs feltevés a perzisztencia sorrendjéről.
        //
        // Scope-átmenet eager-clear (Codex stop-time review): a `groupSlugs`
        // és `permissions` az előző office-ra értelmezett — ha a refresh
        // hibázik, a "őrizd meg a régit" minta cross-office stale state-et
        // hagyna. Ehelyett azonnal nullázunk, és a refresh sikere írja felül;
        // hibakor a null/üres marad (konzervatív loading semantics).
        const handleScopeChange = (event) => {
            const officeId = event?.detail?.editorialOfficeId ?? getPersistedOfficeId();
            setUser(prev => {
                if (!prev) return prev;
                if (prev.groupSlugs?.length === 0 && prev.permissions === null) return prev;
                return { ...prev, groupSlugs: [], permissions: null };
            });
            refreshGroupSlugs('scopeChanged', officeId);
            refreshPermissions('scopeChanged', officeId);
        };
        // permissionSetsChanged (A.5.3): a UserContext saját Realtime listenere
        // (lent) dispatcheli — debounce-olt, scope-szűrt.
        const handlePermissionsChange = () => {
            refreshPermissions('Realtime / permissionSets', getPersistedOfficeId());
        };

        window.addEventListener(MaestroEvent.groupMembershipChanged, handleGroupChange);
        window.addEventListener(MaestroEvent.scopeChanged, handleScopeChange);
        window.addEventListener(MaestroEvent.permissionSetsChanged, handlePermissionsChange);
        return () => {
            window.removeEventListener(MaestroEvent.groupMembershipChanged, handleGroupChange);
            window.removeEventListener(MaestroEvent.scopeChanged, handleScopeChange);
            window.removeEventListener(MaestroEvent.permissionSetsChanged, handlePermissionsChange);
        };
    }, [user?.$id]);

    // Tenant memberships Realtime szinkronizálása (A.5 harden, Codex baseline P1)
    // Az `organizationMemberships` és `editorialOfficeMemberships` collection-ök
    // változását is figyeljük — különben egy Dashboard-on végzett org-role
    // promotion / office removal nem invalidálná a `permissions` snapshot-ot,
    // és a UI tetszőlegesen sokáig stale jogokat mutatna. 300ms debounce +
    // userId szűrés (csak a saját userId-t érintő event-ek). A trigger:
    // `loadAndSetMemberships` (org/office listák) + `refreshPermissions`
    // (snapshot rebuild).
    useEffect(() => {
        if (!user) return;

        const channels = [
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.ORGANIZATION_MEMBERSHIPS}.documents`,
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.EDITORIAL_OFFICE_MEMBERSHIPS}.documents`
        ];

        let debounceId = null;
        const DEBOUNCE_MS = 300;

        const unsubscribe = realtime.subscribe(channels, (response) => {
            const { events, payload } = response;
            const isDelete = events?.some(e => e.includes('.delete'));
            if (!isDelete) {
                // Csak a saját userId-jét érintő event-eket vesszük figyelembe;
                // más userek tagság-változása nem érdekli a saját snapshot-ot.
                if (payload?.userId !== userRef.current?.$id) return;
            }
            if (debounceId) clearTimeout(debounceId);
            debounceId = setTimeout(() => {
                debounceId = null;
                const userId = userRef.current?.$id;
                if (!userId) return;
                loadAndSetMemberships(userId).catch(() => null);
                refreshPermissions('Realtime / tenant memberships', getPersistedOfficeId());
            }, DEBOUNCE_MS);
        });

        return () => {
            if (debounceId) clearTimeout(debounceId);
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, [user?.$id]);

    // Permission-set Realtime szinkronizálása (A.5.3, ADR 0008)
    // A `permissionSets` és `groupPermissionSets` collection-ök változását
    // a UserContext közvetlenül figyeli — a DataContext NEM dispatcheli (nem
    // tartozik annak hatáskörébe). 200ms debounce + scope-szűrés a payload
    // `editorialOfficeId`-jén. A tényleges snapshot rebuildet a `refreshPermissions`
    // végzi a `permissionSetsChanged` MaestroEvent-en keresztül — így a többi
    // fogyasztó (jövőbeli `useUserPermission`) is hallgathat ugyanerre.
    useEffect(() => {
        if (!user) return;

        const channels = [
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.PERMISSION_SETS}.documents`,
            `databases.${DATABASE_ID}.collections.${COLLECTIONS.GROUP_PERMISSION_SETS}.documents`
        ];

        let debounceId = null;
        const DEBOUNCE_MS = 200;

        const unsubscribe = realtime.subscribe(channels, (response) => {
            const { events, payload } = response;
            // .delete eseményekre a payload csak `$id`-t tartalmazhat — ne szűrjünk
            // scope-ra (a következő rebuild úgyis konvergálja a snapshotot).
            const isDelete = events?.some(e => e.includes('.delete'));
            if (!isDelete) {
                const currentOfficeId = getPersistedOfficeId();
                if (!currentOfficeId || payload?.editorialOfficeId !== currentOfficeId) return;
            }
            if (debounceId) clearTimeout(debounceId);
            debounceId = setTimeout(() => {
                debounceId = null;
                dispatchMaestroEvent(MaestroEvent.permissionSetsChanged, { source: 'realtime' });
            }, DEBOUNCE_MS);
        });

        return () => {
            if (debounceId) clearTimeout(debounceId);
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, [user?.$id]);

    // Kezdeti állapot ellenőrzése (pl. oldal újratöltés után)
    useEffect(() => {
        const checkUserStatus = async () => {
            // Staleness guard: a mount alatt érkező logout / sessionExpired
            // (pl. már lejárt cookie) ne tudjon egy stale account.get választ
            // setUser-rel resurrect-elni. A login() is bumpol — ha a user közben
            // explicit bejelentkezik, a régebbi anonymous próbálkozás eldobódik.
            const gen = ++authGenRef.current;
            try {
                startConnecting("Felhasználó betöltése...");
                const accountDetails = await account.get();
                const enrichedUser = await hydrateUserWithMemberships(accountDetails, getPersistedOfficeId());
                if (gen !== authGenRef.current) {
                    log('[UserContext] Stale checkUserStatus válasz eldobva');
                    return;
                }
                setUser(enrichedUser);
            } catch (error) {
                // Nincs bejelentkezve vagy hálózati hiba, de vendég/kijelentkezettként kezeljük a kontextus szempontjából
                if (gen !== authGenRef.current) return;
                membershipsGenRef.current += 1;
                setUser(null);
                setOrganizations([]);
                setEditorialOffices([]);
                setMembershipsError(null);
            } finally {
                // setConnected() finally-ben fut, hogy a stale `return` (gen mismatch
                // logout/sessionExpired miatt) is feloldja a "Felhasználó betöltése..."
                // overlay-t — különben az isConnecting=true beragadna a Login képernyő
                // mögött, mert sem a logout sem a sessionExpired handler nem nyúl
                // a ConnectionContext-hez.
                setConnected();
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
