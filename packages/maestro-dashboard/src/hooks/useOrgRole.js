/**
 * Maestro Dashboard — useOrgRole(organizationId)
 *
 * Visszaadja a bejelentkezett user szerepkörét egy ADOTT szervezetben.
 * Nem feltételezi, hogy az `organizationId` az aktív scope — explicit
 * paramétert kér, így biztonsággal használható cross-org környezetben:
 *   - workflow-tulajdonos org-ja (≠ activeOrganizationId)
 *   - publikáció org-ja (≠ activeOrganizationId)
 *   - office org-ja stb.
 *
 * Az `AuthContext.orgMemberships` snapshot-ból dolgozik (nem custom fetch).
 * Ha más szemantikára van szükség (pl. „freshly fetched members of this org"),
 * használj saját state-et (ld. OrganizationSettingsModal mintáját).
 *
 * @param {string|null|undefined} organizationId
 * @returns {{ role: ('owner'|'admin'|'member'|null), isOwner: boolean, isAdmin: boolean, isOrgAdmin: boolean, isMember: boolean }}
 */

import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

const EMPTY_ROLE = Object.freeze({
    role: null,
    isOwner: false,
    isAdmin: false,
    isOrgAdmin: false,
    isMember: false
});

export function useOrgRole(organizationId) {
    const { user, orgMemberships } = useAuth();
    const userId = user?.$id || null;

    return useMemo(() => {
        if (!userId || !organizationId) return EMPTY_ROLE;
        const membership = (orgMemberships || []).find(
            (m) => m.organizationId === organizationId && m.userId === userId
        );
        const role = membership?.role || null;
        const isOwner = role === 'owner';
        const isAdmin = role === 'admin';
        return {
            role,
            isOwner,
            isAdmin,
            isOrgAdmin: isOwner || isAdmin,
            isMember: role === 'member'
        };
    }, [userId, orgMemberships, organizationId]);
}
