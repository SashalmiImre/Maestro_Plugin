/**
 * Scope-szűrt Realtime refresh hook a csoport / meghívó listák két-tab
 * szinkronjához. Fázis 2 fogyasztók (`OrganizationSettingsModal`,
 * `EditorialOfficeSettingsModal`, `GroupsRoute`) így csak a SAJÁT scope-jukba
 * tartozó event-ekre triggerelik a `reload()` callback-et (300 ms debounce).
 *
 * Miért nem egy közös AuthContext tick: a közös tick bármely tenant groups /
 * meghívó event-jénél bump-olt volna, ami (a) minden nyitott modal felesleges
 * reload-ját (isLoading flash-t), és (b) cross-tenant realtime-forgalmat
 * okozott minden loginolt usernél. Ez a hook fogyasztó-szinten (officeId /
 * organizationId) szűr — más tenant event-je a handlerbe se jut el
 * reload-trigger-ként.
 *
 * MEGJEGYZÉS — ACL:
 * A `groups` / `groupMemberships` / `organizationInvites` collection `read("users")`
 * ACL-lel olvashatók (Appwrite Realtime a payload-ot ezért minden authenticated
 * kliensnek push-olja). Ez a hook csak a JS-oldali scope szűrést teszi meg — a
 * raw WS delivery confidentiality-ja egy szerver-oldali (per-tenant ACL)
 * kérdés, ami a Fázis 2 scope-on kívül esik.
 */

import { useEffect } from 'react';
import { subscribeRealtime, collectionChannel } from '../contexts/realtimeBus.js';
import { COLLECTIONS } from '../config.js';

const CHANNELS = [
    collectionChannel(COLLECTIONS.GROUPS),
    collectionChannel(COLLECTIONS.GROUP_MEMBERSHIPS),
    collectionChannel(COLLECTIONS.ORGANIZATION_INVITES)
];

const DEBOUNCE_MS = 300;

/**
 * @param {Object} params
 * @param {string} params.scopeField — a payload mező, amit a fogyasztó scope-jához hasonlítunk
 *                                     (pl. `'editorialOfficeId'` vagy `'organizationId'`).
 * @param {string|null} params.scopeId — az aktuális scope értéke; ha üres, a subscribe nem aktiválódik.
 * @param {Function} params.reload — stabil callback (`useCallback`), amit scope-találatra hívunk.
 */
export function useTenantRealtimeRefresh({ scopeField, scopeId, reload }) {
    useEffect(() => {
        if (!scopeField || !scopeId) return undefined;

        let debounceId = null;

        const handler = (response) => {
            const payload = response?.payload;
            if (!payload || payload[scopeField] !== scopeId) return;
            if (debounceId) clearTimeout(debounceId);
            debounceId = setTimeout(() => {
                debounceId = null;
                reload();
            }, DEBOUNCE_MS);
        };

        const unsubscribe = subscribeRealtime(CHANNELS, handler);

        return () => {
            if (debounceId) clearTimeout(debounceId);
            unsubscribe();
        };
    }, [scopeField, scopeId, reload]);
}
