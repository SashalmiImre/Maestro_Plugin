/**
 * @file useTenantAclSnapshot.js
 * @description Tenant doc-szintű ACL snapshot fire-and-forget background flow-knak
 * (validation hookok `persistToDatabase` callback). Az aktív office-id-t + user.$id-t
 * ref-szinkronizálva tartja, és a visszaadott callback minden hívásnál snapshot-eli
 * őket → nincs interleaving race a perms-build és a request között.
 *
 * Fail-mode: hiányzó scope/user vagy invalid input esetén `null`-t ad vissza és
 * `logError`-zik. A hívó callback ezt `if (!permissions) return Promise.resolve();`
 * mintán kezeli — fire-and-forget UX-mentes (NEM throw, mert a `pageRangesChanged` /
 * `documentSaved` event-handlerek nem kezelnének throw-t).
 *
 * Lásd [[Döntések/0014-tenant-doc-acl-with-creator]] (`withCreator` defense-in-depth,
 * 3-réteges ACL: collection `documentSecurity:true` + doc-szintű `team:office_X` +
 * doc-szintű `user:creatorId`).
 */

import { useEffect, useRef, useCallback } from "react";
import { useScope } from "../../core/contexts/ScopeContext.jsx";
import { useUser } from "../../core/contexts/UserContext.jsx";
import { logError } from "../../core/utils/logger.js";
import { buildOfficeAclPerms, withCreator } from "maestro-shared/teamHelpers.client.js";

/**
 * @param {string} tag — logger-prefix (a hook-nevet a hívó adja, pl. "useOverlapValidation").
 * @returns {() => (string[]|null)} — snapshot+perms-build callback. `null` ha skip kell.
 */
export function useTenantAclSnapshot(tag) {
    const { activeEditorialOfficeId } = useScope();
    const { user } = useUser();
    const officeIdRef = useRef(activeEditorialOfficeId);
    const userRef = useRef(user);
    useEffect(() => { officeIdRef.current = activeEditorialOfficeId; }, [activeEditorialOfficeId]);
    useEffect(() => { userRef.current = user; }, [user]);

    return useCallback(() => {
        const officeId = officeIdRef.current;
        const userId = userRef.current?.$id;
        if (!officeId || !userId) {
            logError(`[${tag}] Hiányzó scope vagy user — mentés kihagyva.`);
            return null;
        }
        try {
            return withCreator(buildOfficeAclPerms(officeId), userId);
        } catch (error) {
            logError(`[${tag}] Érvénytelen scope/user — mentés kihagyva:`, error);
            return null;
        }
    }, [tag]);
}
