/**
 * Maestro Dashboard — Scope Context
 *
 * Aktív szervezet és szerkesztőség ID-k. localStorage perzisztált.
 * A DataContext ezt fogja használni a scope-szűrt fetch-hez (Fázis 1 / B.7-ben).
 *
 * Stale ID védelem (B.5 review javítás):
 * A localStorage-ből visszatöltött ID-k idejétmúltak lehetnek — pl. a usert
 * eltávolították egy orgból, vagy egy másik fiókkal léptek be ugyanebben a
 * böngészőben. Ilyenkor egy `useEffect` az AuthContext `organizations` /
 * `editorialOffices` listáival validálja az aktív ID-kat, és ha nincs köztük,
 * vagy nullázza (→ Onboarding redirect), vagy az első elérhető tagra esik
 * vissza.
 *
 * Fontos: a validációt csak akkor futtatjuk, ha `auth.loading === false` ÉS
 * nincs `membershipsError` — egy átmeneti memberships fetch hiba nem szabad,
 * hogy törölje a scope-ot (különben a következő sikeres reload után a user
 * az Onboarding-ra kerülne egy létező tenantból). A ProtectedRoute ugyanezt
 * a védelmet alkalmazza a #1 javítása óta.
 */

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useAuth } from './AuthContext.jsx';

const ScopeContext = createContext(null);

export function useScope() {
    return useContext(ScopeContext);
}

const STORAGE_ORG_KEY = 'maestro.activeOrganizationId';
const STORAGE_OFFICE_KEY = 'maestro.activeEditorialOfficeId';

export function ScopeProvider({ children }) {
    const { organizations, editorialOffices, loading, membershipsError } = useAuth();

    const [activeOrganizationId, _setActiveOrganizationId] = useState(
        () => localStorage.getItem(STORAGE_ORG_KEY) || null
    );
    const [activeEditorialOfficeId, _setActiveEditorialOfficeId] = useState(
        () => localStorage.getItem(STORAGE_OFFICE_KEY) || null
    );

    const setActiveOrganization = useCallback((id) => {
        _setActiveOrganizationId(id);
        if (id) localStorage.setItem(STORAGE_ORG_KEY, id);
        else localStorage.removeItem(STORAGE_ORG_KEY);
    }, []);

    const setActiveOffice = useCallback((id) => {
        _setActiveEditorialOfficeId(id);
        if (id) localStorage.setItem(STORAGE_OFFICE_KEY, id);
        else localStorage.removeItem(STORAGE_OFFICE_KEY);
    }, []);

    // ── Stale ID validáció ──
    // Az AuthContext memberships betöltése után megnézzük, hogy az aktuális
    // activeOrganizationId még szerepel-e az `organizations` listában. Ha nem,
    // az első elérhetőre váltunk (ha van), vagy nullázzuk (ha a user kiesett
    // az összes orgból → Onboarding).
    useEffect(() => {
        if (loading || membershipsError) return;

        // Org validáció
        const orgIds = new Set((organizations || []).map((o) => o.$id));
        if (activeOrganizationId && !orgIds.has(activeOrganizationId)) {
            const firstOrg = (organizations || [])[0];
            if (firstOrg) {
                setActiveOrganization(firstOrg.$id);
            } else {
                setActiveOrganization(null);
            }
            // Az office-t is újra validáljuk a következő effect futásban,
            // miután az org ID frissült.
            return;
        }

        // Auto-pick: nincs aktív org, de van elérhető → az elsőt választjuk
        if (!activeOrganizationId && (organizations || []).length > 0) {
            setActiveOrganization(organizations[0].$id);
            return;
        }

        // Office validáció — csak az AKTÍV orghoz tartozó office-okat vesszük
        // figyelembe, különben egy idegen org office-át nem vennénk észre.
        const scopedOffices = (editorialOffices || []).filter(
            (o) => o.organizationId === activeOrganizationId
        );
        const officeIds = new Set(scopedOffices.map((o) => o.$id));
        if (activeEditorialOfficeId && !officeIds.has(activeEditorialOfficeId)) {
            const firstOffice = scopedOffices[0];
            if (firstOffice) {
                setActiveOffice(firstOffice.$id);
            } else {
                setActiveOffice(null);
            }
            return;
        }

        // Auto-pick: nincs aktív office, de van elérhető → az elsőt választjuk
        if (!activeEditorialOfficeId && scopedOffices.length > 0) {
            setActiveOffice(scopedOffices[0].$id);
            return;
        }
    }, [
        loading,
        membershipsError,
        organizations,
        editorialOffices,
        activeOrganizationId,
        activeEditorialOfficeId,
        setActiveOrganization,
        setActiveOffice
    ]);

    const value = {
        activeOrganizationId,
        activeEditorialOfficeId,
        setActiveOrganization,
        setActiveOffice
    };

    return (
        <ScopeContext.Provider value={value}>
            {children}
        </ScopeContext.Provider>
    );
}
