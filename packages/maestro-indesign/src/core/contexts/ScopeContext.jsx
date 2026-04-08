/**
 * @file ScopeContext.jsx
 * @description Plugin multi-tenant scope (aktív organization + editorialOffice)
 * állapota localStorage perzisztálással. A validáló effect gondoskodik a stale
 * ID cseréről és az auto-pickről; az `isScopeValidated` flag gate-eli a
 * DataContext initial fetch-ét, hogy ne olvassunk egy másik user ott maradt
 * office ID-jével (cross-tenant védelem).
 *
 * Fázis 6-ban kap WorkspaceHeader dropdown UI-t a multi-org/office switch-hez.
 */

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useUser } from './UserContext.jsx';
import { log } from '../utils/logger.js';

const ScopeContext = createContext(null);

export function useScope() {
    const context = useContext(ScopeContext);
    if (!context) throw new Error('useScope must be used within a ScopeProvider');
    return context;
}

export const STORAGE_ORG_KEY = 'maestro.activeOrganizationId';
export const STORAGE_OFFICE_KEY = 'maestro.activeEditorialOfficeId';

/**
 * Olyan orgot választ, amelyhez van legalább egy office membership — enélkül
 * a Plugin `organizations[0]`-t választana, és egy multi-org user a
 * `no-office-in-org` placeholderbe ragadhatna, miközben másik orgjában lenne
 * használható office. Org-switch UI csak Fázis 6-ban érkezik, addig ez
 * védi a happy patht. Fallback: az első org (a `no-office-in-org`
 * placeholder az egyetlen helyes empty state).
 */
const pickPreferredOrganization = (orgs, offices) => {
    if (!Array.isArray(orgs) || orgs.length === 0) return null;
    const orgWithOffice = orgs.find((o) =>
        Array.isArray(offices) && offices.some((off) => off.organizationId === o.$id)
    );
    return orgWithOffice || orgs[0];
};

export function ScopeProvider({ children }) {
    const { organizations, editorialOffices, loading, membershipsError } = useUser();

    const [activeOrganizationId, _setActiveOrganizationId] = useState(() => {
        try {
            return window.localStorage.getItem(STORAGE_ORG_KEY) || null;
        } catch (e) {
            return null;
        }
    });
    const [activeEditorialOfficeId, _setActiveEditorialOfficeId] = useState(() => {
        try {
            return window.localStorage.getItem(STORAGE_OFFICE_KEY) || null;
        } catch (e) {
            return null;
        }
    });

    // Egyszer billen true-ra, amikor a validáló effect először lefutott. A
    // DataContext initial fetch-je ezen gate-el — későbbi stale-detekció már
    // az office-váltó effect láncon át propagálódik, nem billenti vissza.
    const [isScopeValidated, setIsScopeValidated] = useState(false);

    const setActiveOrganization = useCallback((id) => {
        _setActiveOrganizationId(id);
        try {
            if (id) window.localStorage.setItem(STORAGE_ORG_KEY, id);
            else window.localStorage.removeItem(STORAGE_ORG_KEY);
        } catch (e) { /* UXP localStorage edge case — nem kritikus */ }
    }, []);

    const setActiveOffice = useCallback((id) => {
        _setActiveEditorialOfficeId(id);
        try {
            if (id) window.localStorage.setItem(STORAGE_OFFICE_KEY, id);
            else window.localStorage.removeItem(STORAGE_OFFICE_KEY);
        } catch (e) { /* UXP localStorage edge case — nem kritikus */ }
    }, []);

    // Stale ID validáció + auto-pick. A futás sorrendje kritikus: előbb org,
    // utána office — az office validáció az aktív orghoz szűri a listát, tehát
    // egy stale org először frissülnie kell. Minden terminal ág
    // `setIsScopeValidated(true)`-val zár (kivéve, amikor setter-rel triggereljük
    // a következő futást).
    useEffect(() => {
        if (loading) return;

        // Membership fetch hiba: nem trust-oljuk a persistált ID-kat, amíg nem
        // láttuk a hozzájuk tartozó membership listát (cross-tenant védelem).
        if (membershipsError) {
            if (activeOrganizationId || activeEditorialOfficeId) {
                log('[ScopeContext] Membership fetch hibás — stale scope törlése');
                if (activeOrganizationId) setActiveOrganization(null);
                if (activeEditorialOfficeId) setActiveOffice(null);
                return;
            }
            setIsScopeValidated(true);
            return;
        }

        const orgIds = new Set((organizations || []).map((o) => o.$id));
        if (activeOrganizationId && !orgIds.has(activeOrganizationId)) {
            const replacement = pickPreferredOrganization(organizations, editorialOffices);
            if (replacement) {
                log(`[ScopeContext] Stale organizationId (${activeOrganizationId}), váltás: ${replacement.$id}`);
                setActiveOrganization(replacement.$id);
            } else {
                log('[ScopeContext] Nincs elérhető szervezet, activeOrganizationId törlése');
                setActiveOrganization(null);
            }
            return;
        }
        if (!activeOrganizationId && (organizations || []).length > 0) {
            const preferred = pickPreferredOrganization(organizations, editorialOffices);
            log(`[ScopeContext] Auto-pick organization: ${preferred.$id}`);
            setActiveOrganization(preferred.$id);
            return;
        }

        if (!activeOrganizationId) {
            setIsScopeValidated(true);
            return;
        }

        const scopedOffices = (editorialOffices || []).filter(
            (o) => o.organizationId === activeOrganizationId
        );
        const officeIds = new Set(scopedOffices.map((o) => o.$id));
        if (activeEditorialOfficeId && !officeIds.has(activeEditorialOfficeId)) {
            const firstOffice = scopedOffices[0];
            if (firstOffice) {
                log(`[ScopeContext] Stale editorialOfficeId (${activeEditorialOfficeId}), váltás: ${firstOffice.$id}`);
                setActiveOffice(firstOffice.$id);
            } else {
                log('[ScopeContext] Nincs elérhető szerkesztőség az aktív orgban, activeEditorialOfficeId törlése');
                setActiveOffice(null);
            }
            return;
        }
        if (!activeEditorialOfficeId && scopedOffices.length > 0) {
            const firstOffice = scopedOffices[0];
            log(`[ScopeContext] Auto-pick editorialOffice: ${firstOffice.$id}`);
            setActiveOffice(firstOffice.$id);
            return;
        }

        setIsScopeValidated(true);
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
        isScopeValidated,
        setActiveOrganization,
        setActiveOffice
    };

    return (
        <ScopeContext.Provider value={value}>
            {children}
        </ScopeContext.Provider>
    );
}
