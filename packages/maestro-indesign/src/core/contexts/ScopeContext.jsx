/**
 * @file ScopeContext.jsx
 * @description Plugin multi-tenant scope (aktív organization + editorialOffice)
 * állapota localStorage perzisztálással. A validáló effect gondoskodik a stale
 * ID cseréről és az auto-pickről; az `isScopeValidated` flag gate-eli a
 * DataContext initial fetch-ét, hogy ne olvassunk egy másik user ott maradt
 * office ID-jével (cross-tenant védelem).
 *
 * A WorkspaceHeader feltételes dropdown-okon keresztül (org >1, office >1) engedi
 * a felhasználónak a scope váltást — az auto-pick kezeli a cascading logikát.
 */

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useUser } from './UserContext.jsx';
import { log } from '../utils/logger.js';
import { MaestroEvent, dispatchMaestroEvent } from '../config/maestroEvents.js';
import { STORAGE_ORG_KEY, STORAGE_OFFICE_KEY } from '../utils/constants.js';

const ScopeContext = createContext(null);

export function useScope() {
    const context = useContext(ScopeContext);
    if (!context) throw new Error('useScope must be used within a ScopeProvider');
    return context;
}

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

/**
 * Tiszta scope-feloldó: input state → { resolved, apply, reason }.
 *
 * A cascading logikát (org → office) egyetlen függvénybe tömöríti. A React
 * side effect csak az `apply` callback-et hívja — a függvény maga nem hív
 * settert, nem dispatchel eventet, tehát unit-tesztelhető.
 *
 * @returns {{ resolved: boolean, apply: null | ((setOrg, setOffice) => void), reason?: string }}
 *   - resolved=true + apply=null: nincs teendő, `isScopeValidated`-et beállíthatjuk
 *   - apply !== null: futtatjuk, utána az effect a setter miatt újrafut; addig
 *     NEM állítjuk a `isScopeValidated`-et
 */
function resolveScope({
    loading, membershipsError,
    organizations, editorialOffices,
    currentOrgId, currentOfficeId
}) {
    if (loading) {
        return { resolved: false, apply: null };
    }

    // Membership fetch hiba: nem trust-oljuk a persistált ID-kat, amíg nem
    // láttuk a hozzájuk tartozó membership listát (cross-tenant védelem).
    if (membershipsError) {
        if (currentOrgId) return { resolved: false, apply: (setOrg) => setOrg(null), reason: 'membership error — clearing stale org' };
        if (currentOfficeId) return { resolved: false, apply: (_, setOffice) => setOffice(null), reason: 'membership error — clearing stale office' };
        return { resolved: true, apply: null };
    }

    const orgs = organizations || [];
    const offices = editorialOffices || [];
    const orgIds = new Set(orgs.map((o) => o.$id));

    // Stale / missing org.
    if (currentOrgId && !orgIds.has(currentOrgId)) {
        const replacement = pickPreferredOrganization(orgs, offices);
        return {
            resolved: false,
            apply: (setOrg) => setOrg(replacement ? replacement.$id : null),
            reason: replacement
                ? `stale organizationId (${currentOrgId}) → ${replacement.$id}`
                : 'no available organization — clearing'
        };
    }
    if (!currentOrgId && orgs.length > 0) {
        const preferred = pickPreferredOrganization(orgs, offices);
        return { resolved: false, apply: (setOrg) => setOrg(preferred.$id), reason: `auto-pick organization: ${preferred.$id}` };
    }
    if (!currentOrgId) {
        return { resolved: true, apply: null };
    }

    // Org stabil → office cascading feloldás.
    const scopedOffices = offices.filter((o) => o.organizationId === currentOrgId);
    const officeIds = new Set(scopedOffices.map((o) => o.$id));

    if (currentOfficeId && !officeIds.has(currentOfficeId)) {
        const firstOffice = scopedOffices[0];
        return {
            resolved: false,
            apply: (_, setOffice) => setOffice(firstOffice ? firstOffice.$id : null),
            reason: firstOffice
                ? `stale editorialOfficeId (${currentOfficeId}) → ${firstOffice.$id}`
                : 'no available office in active org — clearing'
        };
    }
    if (!currentOfficeId && scopedOffices.length > 0) {
        const firstOffice = scopedOffices[0];
        return { resolved: false, apply: (_, setOffice) => setOffice(firstOffice.$id), reason: `auto-pick editorialOffice: ${firstOffice.$id}` };
    }

    return { resolved: true, apply: null };
}

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
        dispatchMaestroEvent(MaestroEvent.scopeChanged, { editorialOfficeId: id });
    }, []);

    // Tiszta feloldás → egyetlen side-effect pont. A resolveScope adja
    // vissza, hogy van-e teendő (action) vagy a scope stabil (resolved=true).
    useEffect(() => {
        const outcome = resolveScope({
            loading,
            membershipsError,
            organizations,
            editorialOffices,
            currentOrgId: activeOrganizationId,
            currentOfficeId: activeEditorialOfficeId
        });

        if (outcome.apply) {
            if (outcome.reason) log(`[ScopeContext] ${outcome.reason}`);
            outcome.apply(setActiveOrganization, setActiveOffice);
            return;
        }

        if (outcome.resolved) setIsScopeValidated(true);
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
