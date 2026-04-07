/**
 * Maestro Dashboard — Scope Context
 *
 * Aktív szervezet és szerkesztőség ID-k. localStorage perzisztált.
 * A DataContext ezt fogja használni a scope-szűrt fetch-hez (Fázis 1 / B.7-ben).
 */

import React, { createContext, useContext, useState, useCallback } from 'react';

const ScopeContext = createContext(null);

export function useScope() {
    return useContext(ScopeContext);
}

const STORAGE_ORG_KEY = 'maestro.activeOrganizationId';
const STORAGE_OFFICE_KEY = 'maestro.activeEditorialOfficeId';

export function ScopeProvider({ children }) {
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
