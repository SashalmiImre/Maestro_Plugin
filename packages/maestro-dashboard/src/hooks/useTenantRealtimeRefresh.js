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

// Office-szintű fogyasztók (`scopeField: 'editorialOfficeId'`) a 7 collection-re
// iratkoznak:
//   - permissionSets / groupPermissionSets (A.4.7) — Permission set tabhoz.
//   - workflowExtensions (B.5.1) — új Bővítmények tabhoz.
//   - workflows (B.5.1 follow-up, Codex stop-time M1 fix) — a Bővítmények
//     tab "X workflow hivatkozik rá" badge-ei + archive confirm-warning
//     szövegei a `workflows` listából derived-elnek; ha másik tab/session
//     egy workflow-ban hivatkozik / elveszi az `ext.<slug>` ref-et, a
//     reload nélkül stale számláló jelenne meg (potenciálisan félrevezető
//     archive-döntés UX-e).
const OFFICE_CHANNELS = [
    collectionChannel(COLLECTIONS.GROUPS),
    collectionChannel(COLLECTIONS.GROUP_MEMBERSHIPS),
    collectionChannel(COLLECTIONS.ORGANIZATION_INVITES),
    collectionChannel(COLLECTIONS.PERMISSION_SETS),
    collectionChannel(COLLECTIONS.GROUP_PERMISSION_SETS),
    collectionChannel(COLLECTIONS.WORKFLOW_EXTENSIONS),
    collectionChannel(COLLECTIONS.WORKFLOWS)
];

// Org-szintű fogyasztók (`scopeField: 'organizationId'`) csatornái.
// A `permissionSets` / `groupPermissionSets` payload-jában ugyan szerepel
// `organizationId` (denormalizált index-mező), de az org-szintű `OrganizationSettingsModal`
// nem mutat permission set adatot — feleslegesen reagáltatná a child office
// permission-set változásokra (`loadData()` = members + offices fetch).
//
// 2026-05-07: `ORGANIZATION_MEMBERSHIPS` hozzáadva a `change_organization_member_role`
// (UsersTab role-dropdown) miatt. A modal `members` és `callerRole` state-je
// erre épül; e nélkül a sikeres role-update Realtime push-a nem érte el a
// modal-t, és a tagok listája stale maradt. Codex stop-time review (2026-05-07)
// szerinti correctness fix; a 300ms debounce + silent-reload tompítja a többlet
// fetch-zajt org-membership churn esetén.
const ORG_CHANNELS = [
    collectionChannel(COLLECTIONS.GROUPS),
    collectionChannel(COLLECTIONS.GROUP_MEMBERSHIPS),
    collectionChannel(COLLECTIONS.ORGANIZATION_INVITES),
    collectionChannel(COLLECTIONS.ORGANIZATION_MEMBERSHIPS)
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

        const channels = scopeField === 'organizationId' ? ORG_CHANNELS : OFFICE_CHANNELS;

        let debounceId = null;

        const handler = (response) => {
            const payload = response?.payload;
            if (!payload) return;

            // Delete payload szűkített mezőkészlettel jöhet (csak `$id`),
            // így scope-filter false-ozhatna egy valós tenant-mutáción —
            // delete-en bypass-oljuk. A reload úgyis a saját scope-ját
            // kérdezi le; cross-tenant delete max egy felesleges fetch.
            const isDelete = (response.events || []).some(e => e.includes('.delete'));
            if (!isDelete && payload[scopeField] !== scopeId) return;

            if (debounceId) clearTimeout(debounceId);
            debounceId = setTimeout(() => {
                debounceId = null;
                reload();
            }, DEBOUNCE_MS);
        };

        // WS reconnect után reload — a disconnect-ablakban érkezett
        // groups / membership / invite változások nem jönnének push-ként,
        // így a fogyasztó modal listája (pl. Csoportok tab, Felhasználók tab)
        // stale-ben ragadna a következő mount-ig vagy scope-váltásig.
        // Itt nem szűrünk scope-ra, mert a `reload()` fogyasztó-szinten kérdezi
        // le a saját scope-ját (a stale ablak alatt akár új scope is lehet).
        const onReconnect = () => {
            if (debounceId) clearTimeout(debounceId);
            debounceId = null;
            reload();
        };

        const unsubscribe = subscribeRealtime(channels, handler, { onReconnect });

        return () => {
            if (debounceId) clearTimeout(debounceId);
            unsubscribe();
        };
    }, [scopeField, scopeId, reload]);
}
