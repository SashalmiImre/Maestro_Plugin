---
tags: [adr]
status: Accepted
date: 2026-05-07
---

# 0009 — Membership user-identity denormalizáció + org-tag role változtatás

## Kontextus

Két egymással összefüggő probléma jelentkezett a Dashboard `Felhasználók` és `Csoportok` UI-on:

1. **„userId helyett név megjelenik" bug** — a `EditorialOfficeGroupsTab.jsx` és `OrganizationSettingsModal.jsx` a `userNameMap`-et a `groupMemberships` collection-ből építette, amelyben denormalizálva van a `userName` (string, 128) és `userEmail` (string, 320). Az `editorialOfficeMemberships` és `organizationMemberships` collection-ön viszont ezek a mezők **nem léteztek**. Ha egy office-tag még egyetlen csoportban sincs (pl. új szervezet bootstrap után), nincs `groupMemberships` rekord rá, és emiatt a UI a nyers Appwrite `userId`-t mutatja név helyett.
2. **Hiányzó `change_org_role` művelet** — a `Felhasználók` fülön a tagok role-ja read-only volt; nem volt sem CF action, sem UI dropdown a `member ↔ admin ↔ owner` váltáshoz. Az `org.member.role.change` slug az [[0008-permission-system-and-workflow-driven-groups|ADR 0008]]-ban már szerepel az org-scope taxonómiában (csak owner+admin kapja meg a `userHasOrgPermission` szerint), de a frontend nem használta.

A két probléma együtt kezelhető, mert mindkettő `organizationMemberships` collection ergonómiát érint, és mindkettő tipikusan ugyanabban a UI-fülben látszik.

## Döntés

**Két párhuzamos rendezés:**

1. **Server-side denormalizáció**: az `organizationMemberships` és `editorialOfficeMemberships` collection-ökre is felvettük a `userName` (string, 128, nullable) és `userEmail` (string, 320, nullable) mezőket. A CF write-flow-k (`bootstrap_organization`, `accept_invite`, `create_editorial_office`) **snapshot-at-join** elven írják a beállási adatokat. Egy új `backfill_membership_user_names` action az addigi rekordokat owner-anywhere auth-tal idempotensen feltölti.
2. **Új CF action `change_organization_member_role`**: a `org.member.role.change` slug-on alapuló dual-guard helyett egyszerű, explicit `change_organization_member_role` endpoint, amely **8 védelmi rétegen** keresztül érvényesíti a privilégium-eszkaláció elleni szabályokat (self-edit guard, owner-touch guard, last-owner guard, idempotens no-op).

Az UI-ban a `UsersTab` minden tag mellé role-dropdown kerül owner-callerek számára; a Realtime cross-tab szinkron a `useTenantRealtimeRefresh` hook `ORG_CHANNELS` lista bővítésével (`ORGANIZATION_MEMBERSHIPS` csatorna).

**Drift-stratégia (denormalizáció):** *snapshot-at-join + manuális/scheduled backfill*. A user későbbi név/email változása NEM frissíti automatikusan a meglévő membership rekordokat — a `backfill_membership_user_names` action manuálisan szinkronba hoz mindent, ha kell. Ez egyszerűbb, mint event-handler-szinkron, és a `groupMemberships` collection meglévő mintáját követi.

## Alternatívák

### Denormalizáció

| Opció | Mellette | Ellene |
|---|---|---|
| **A — Önállóan kódoldali self-fallback (csak `useAuth().user`)** | Lokális, alacsony kockázatú; egyetlen JS-fájl módosítás. | Csak a saját bejelentkezett user-t fedi; idegen user-ek továbbra is `userId`-vel jelennek meg. |
| **B — Server-side denormalizáció (snapshot-at-join)** ← **választott** | A `groupMemberships`-mintát követi; konzisztens; minden user nevét mutatja, a backfill action-nel a meglévő rekordok is rendezhetők. | PII propagation (a `userEmail` érzékeny), drift kockázata, write amplification (3-4 CF action írja). |
| **C — Best-effort current profile mirror (event-handler vagy scheduled CF)** | Mindig friss név/email; nincs stale rekord. | Bonyolult: extra CF + Appwrite Account event hookok kellenek; egy elhalasztott CF a UX-szempontból nem ad sokat a snapshot+backfillhez képest. |

### Role-változtatás auth-modell

| Opció | Mellette | Ellene |
|---|---|---|
| **A — Csak owner caller változtathat role-t** (`ADMIN_EXCLUDED_ORG_SLUGS`-ba felvenni `org.member.role.change`-et) | Egyszerű; admin nem juthat self-promote-hoz. | Az ADR 0008 taxonómia szerint admin is kapja az `org.member.role.change`-et — kontradikció. |
| **B — Az `org.member.role.change` slug + extra owner-touch guard** ← **választott** | Konzisztens az ADR 0008 taxonómiával; admin promote-olhat member↔admin között, de owner-érintettségű cseréhez explicit owner-caller kell. | Egy CF action belsejében több réteg ellenőrzés. |

## Következmények

### Pozitív
- Új org / új meghívó / új office létrehozásakor a `userName`+`userEmail` automatikusan beíródik — soha többé nem lesz nyers `userId` a UI-ban.
- A `change_organization_member_role` action a frontend-en role-dropdown-ot ad. A `UsersTab` self-edit / last-owner / privilege-escalation védelme a backend-en kemény, a UI csak az UX-szintű csapdákat szűri.
- A `groupMemberships`-mintát követjük — egyetlen drift-stratégia minden membership collectionre.
- A `useTenantRealtimeRefresh` `ORG_CHANNELS` mostantól tartalmazza az `ORGANIZATION_MEMBERSHIPS` csatornát is — két-tab szinkron a tagság-mutációkra.

### Negatív / trade-off
- **PII propagation**: a `userEmail` mezőt 3 collection-ben tartjuk (`groupMemberships`, `organizationMemberships`, `editorialOfficeMemberships`). Hosszú távon megfontolandó a `userEmail` elhagyása, ha a UI csak `userName`-et használ.
- **Drift**: snapshot-at-join → ha valaki név/email-t vált, a meglévő membership rekord stale lesz. A `backfill_membership_user_names` manuálisan rendez. A `groupMemberships` ugyanezzel a problémával él, ezért nem új típusú regresszió.
- **Write amplification**: 3 CF action írja a denormalizált mezőket. Egy közös `fetchUserIdentity(usersApi, userId, cache, log)` helper csökkenti a copy-paste-et és a pre-request `userIdentityCache` Map-et reuse-olja.

### Új kötelezettségek
- Bármely új membership-create flow esetén a `fetchUserIdentity` hívása kötelező a `userName`/`userEmail` denormalizációhoz.
- Ha a user-profilt szerkeszthetővé tesszük a Dashboardon, a `backfill_membership_user_names` futtatása ajánlott a frissítés után.
- Az `organizationMemberships` `change_organization_member_role` action `expectedUpdatedAt` opt-in concurrency-guarda nincs (egyszerű). Ha egy jövőben két paralel role-change race lenne probléma, ez kibővíthető.

## Implementációs jegyzék (2026-05-07)

### Schema (élő)
| Collection | Új oszlop | Típus |
|---|---|---|
| `organizationMemberships` | `userName` | string(128), nullable |
| `organizationMemberships` | `userEmail` | string(320), nullable |
| `editorialOfficeMemberships` | `userName` | string(128), nullable |
| `editorialOfficeMemberships` | `userEmail` | string(320), nullable |

### CF (`invite-to-organization`)
- Új helper: `helpers/util.js` `fetchUserIdentity(usersApi, userId, cache, log)` — failure-tolerant, per-request cache-szel.
- Új cache: `main.js` `userIdentityCache` Map a `ctx`-ben.
- `bootstrapOrCreateOrganization` (orgs.js) — self-membership + office-membership ír denormalizált mezőket, egyetlen `usersApi.get` hívással.
- `acceptInvite` (invites.js) — a meglévő `callerUserDoc`-ból (e-mail egyezés ellenőrzéshez amúgy is lekért) közvetlenül átveszi a mezőket.
- `createEditorialOffice` (offices.js) — caller office-membership.
- Új action: `backfill_membership_user_names` (schemas.js) — owner-anywhere auth, idempotens (mindkét mező kitöltve → skip), paginated, failure-tolerant (törölt user → `null` marad).
- Új action: `change_organization_member_role` (orgs.js) — 8 védelmi réteg.

### Frontend
- Új helper: `packages/maestro-dashboard/src/utils/userIdentity.js` `buildUserIdentityMap(sources, currentUser)` — több source-támogatás, idempotens merge, self-fallback safety-net.
- `OrganizationSettingsModal` primary source: `members` (organizationMemberships); másodlagos: `groupMembersResult.documents`.
- `EditorialOfficeGroupsTab` primary source: `officeMembers`; másodlagos: `groupMemberships`.
- `UsersTab` role-dropdown owner-callerek számára (member ↔ admin ↔ owner). `handleRoleChange` explicit `onMembersRefresh()` (same-tab UX) + Realtime fallback (cross-tab).
- `useTenantRealtimeRefresh` `ORG_CHANNELS`-be `ORGANIZATION_MEMBERSHIPS` csatorna.
- `AuthContext.changeOrganizationMemberRole` callback.

## Kapcsolódó

- ADR: [[0008-permission-system-and-workflow-driven-groups]] — `org.member.role.change` slug forrása
- Komponens: [[Komponensek/UserIdentityMap]] — frontend helper dokumentáció
- Komponens: [[Komponensek/PermissionTaxonomy]] — slug-katalógus
- Komponens: [[Komponensek/RealtimeBus]] — `ORG_CHANNELS` lista
- Memory: `MEMORY.md` 2026-05-07 entry
