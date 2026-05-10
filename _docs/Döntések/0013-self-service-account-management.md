---
adr: 13
status: Accepted
date: 2026-05-10
tags: [adr, döntés, server, frontend, gdpr, self-service, account, cascade]
related: [[0003-tenant-team-acl]] [[0008-permission-system-and-workflow-driven-groups]] [[0012-org-member-removal-cascade]]
---

# ADR 0013 — Self-service profile-screen: szervezet elhagyása + fiók törlése

## Kontextus

Az [[0012-org-member-removal-cascade|admin-kick flow]] párja: a felhasználó a saját felületéről (profile-screen) intézheti a szervezet-elhagyási és fiók-törlési műveleteket. A felhasználói intent két különböző, eltérő blast-radius-ú akció:

1. **Szervezet elhagyása (1 org)** — `leave_organization` action **MÁR LÉTEZIK** (`actions/offices.js:50`), AuthContext `leaveOrganization()` MÁR wired-up. Csak UI hiányzik.
2. **Teljes fiók törlése (összes org + Appwrite user account)** — új CF action + frontend integration. **Irreverzibilis**: a user soha többé nem tud belépni, audit-rekordjai orphan-né válnak.

A meglévő infrastruktúra:
- `leave_organization` action 1-org cascade cleanup-pal (last-owner block, last-member block, STRICT team cleanup).
- `user-cascade-delete` event-driven CF (trigger: `users.*.delete`) — automatikusan takarítja a memberships + teams rekordokat post-event. **DE**: csak `org_${orgId}` és `office_${officeId}` team-eket bont — az `org_${orgId}_admins`-t **nem** (Codex BLOCKER B3).
- A Codex pre-implementation review **3 BLOCKER**-t talált pont ehhez a flow-hoz; mind beépítve.

A `delete_my_account` flow legnagyobb kockázata a **race-window** a cross-org last-owner check és a `users.delete` között: a `user-cascade-delete` post-event CF csak akkor detektál orphan-okat, amikor a user már törölve van. Ez audit-szempontból "túl későn" — admin attention nélkül árva orgokat hagyhat.

## Döntés

### 1. Új profile-screen route: `/settings/account`

Két szekció:
- **Saját szervezetek** — listázza az `organizations`-ot, ahol a user tag. Per-org "Elhagyás" gomb. A `leaveOrganization()` AuthContext methodot hívja (idempotens, last-owner / last-member block).
- **Veszélyes zóna — Fiók törlése** — piros "Fiók törlése" gomb. `useConfirm({ verificationExpected: user.email })` email-typed verification. Magyarázó copy: "Eltűnsz minden szervezetből", "A fiókod nem állítható vissza".

A `ProtectedRoute.jsx` frozen-org gate-en (`isFrozen` orphaned/archived) a `/settings/account` aux-route-ként **átengedett** (M3 fix) — különben az árva-org user-ek nem érnék el a recovery-screen-t.

### 2. Új CF action `delete_my_account`

A B1 (race) + B2 (sole-member) + B3 (admin-team cleanup) BLOCKER-eket fail-closed kezeli:

**Lépések**:
1. **Caller user kötelező** (`x-appwrite-user-id` header).
2. **Cross-org membership lookup** — `organizationMemberships` paginált listing `userId === callerId` alapján.
3. **Cross-org last-owner / last-member check** (B1+B2 fix) — ITERÁLD a `role === 'owner'` orgokat:
   - Ha másik owner van → OK, mehet a 4-es lépésre.
   - Ha NINCS másik owner ÉS van más tag → `lastOwnerOrgs.push(orgId)`.
   - Ha NINCS másik owner ÉS NINCS más tag (sole owner = sole member) → `soleOwnerOrgs.push(orgId)`.
   - Ha mindkét lista nem üres → 409 `last_owner_in_orgs` `{ orgIds, soleOwnerOrgs, hint: 'transfer_or_delete' }`.
4. **Per-org sequential cleanup** (B1 race fix) — minden orgra, ahol a user tag, hívjuk a `leaveOrganization`-szerű cleanup logikát (a `leaveOrganization` action belsejének reuse-olása vagy közvetlen kihívása). Ez **STRICT team cleanup** + `editorialOfficeMemberships` + `groupMemberships` + `organizationMemberships` cascade. Hiba esetén abort + return 500 `partial_cleanup`. A user account még él, retry biztonságos.
5. **`users.delete(callerId)` Appwrite Admin SDK** — egy ZÉRÓ-membership user-en. A race-window lényegesen kisebb, mert a TOCTOU csak az utolsó cleanup-step és a `users.delete` között szűkül; a `user-cascade-delete` post-event CF már nem talál mit takarítani (cleanup már megtörtént).
6. **Response** — `{ success: true, action: 'account_deleted', leftOrgs: [orgIds] }`.

**Frontend (post-call)**:
- `account.deleteSession({ sessionId: 'current' })` try/catch wrap (M5 fix) — 401/404 acceptable, mert a backend session-t a `users.delete` érvényteleníti.
- Redirect `/login` + `localStorage` cleanup (mint a `logout()`-ban).

### 3. `user-cascade-delete` CF javítás (B3 fix)

A meglévő `packages/maestro-server/functions/user-cascade-delete/src/main.js` `Pass 3` (Team membership cleanup) **kibővítve**: az `org_${orgId}` és `office_${officeId}` mellett az `org_${orgId}_admins` team-et is takarítja. Ez self-cleanup-szempontból fontos akkor is, ha az admin a `delete_my_account` Plus a meglévő flow-kat (admin-konzol user-delete) is fedi.

```js
// existing: orgIds.forEach(orgId => removeUserFromTeam(teams, `org_${orgId}`, userId, ...))
// existing: officeIds.forEach(officeId => removeUserFromTeam(teams, `office_${officeId}`, userId, ...))
// NEW: orgIds.forEach(orgId => removeUserFromTeam(teams, `org_${orgId}_admins`, userId, ...))
```

A stats objektumban új ág: `orgAdminTeams: { processed, deleted, failed }`.

## Alternatívák

### Race-window (B1) megoldás

| Opció | Mellette | Ellene |
|---|---|---|
| **A — Bizalom a `user-cascade-delete` post-event CF-ben** | Egyszerű, nincs új lock. | A post-event CF csak admin attention-t ad orphan-status-on; nem real-time fail-closed. |
| **B — Per-org sequential cleanup `users.delete` ELŐTT** ← **választott** | Race-window lényegesen kisebb. ZÉRÓ-membership user-en a `users.delete` triviális. | Több DB call, lassabb action; a `leaveOrganization` mintát kvázi N-szer reuse-olja. |
| **C — Distributed lock** (`organizationMemberships`-szel `expectedUpdatedAt` TOCTOU) | Erős correctness garancia. | Komplex; minden org-on per-membership lock kell. |

A **B** választott — Codex BLOCKER explicit ezt javasolja, és a meglévő `leaveOrganization` mintát reuse-olja.

### Profile-screen lokáció

| Opció | Mellette | Ellene |
|---|---|---|
| **A — Modal a Dashboard layout-ban** | Gyors, nincs új route. | Az árva-org gate alatt nehéz aktiválni; a "Fiók törlése" lépés UX szempontból külön screen kíván. |
| **B — Új `/settings/account` route** ← **választott** | Konzisztens a `/settings/password` mintával. Frozen-org gate-en aux-route-ként engedhető át. | Új route-deklaráció + ProtectedRoute aux-list módosítás. |

### Audit-trail Phase 2-re

A `delete_my_account` flow-ban az audit-trail (orphan-marker) megőrzése a `user-cascade-delete` CF feladata:
- `lastOwnerOrgs` listára az `organizations.status = 'orphaned'` write már része a CF-nek.
- A `delete_my_account` action — ha minden cleanup sikeres — soha nem hagy `lastOwnerOrgs`-ot, mert a 3-as lépés blokkol. Tehát a post-event orphan-marker most már csak admin-konzol user-delete-re fog futni (legacy path).

## Következmények

### Pozitív
- A user maga teljes kontrollt kap a fiókja és szervezet-tagságai felett.
- GDPR-konformitás: "right to erasure" self-service (a user kérésére, nem admin-pretekstuális).
- A race-window a B1 fix-szel lényegesen kisebb — a Codex BLOCKER erre fókuszált.

### Negatív / Kockázat
- A `delete_my_account` action több DB call-t generál (per-org cleanup), de ez egy ritka művelet (felhasználónként egyszer), tehát a CF timeout (15s) nem kritikus. Ha egy user 20+ orgban tag, kell egy `MAX_ORGS_PER_DELETE_CALL=10` cap és batch-folytatás (`continueFrom: lastOrgId`). **Nem implementáljuk Phase 2-ben** — soft-cap warning + retry user-action.
- Audit-rekordok orphan-okká válnak (`organizationInviteHistory.userId` foreign-key). A meglévő rendszer ezt elfogadja (legacy session-ekben már megtörtént).

### Migration / Rollback
- **Schema**: nincs új mező — csak új CF action + 1-2 sor a `user-cascade-delete` CF-ben.
- **Rollback**: a frontend "Fiók törlése" gomb hide flag-elhető (`/settings/account` route megmaradhat, csak a leave-flow látszik). A `delete_my_account` CF action 410 `feature_disabled` early-return-nel kapcsolható ki.

## Codex review fix-ek

A pre-implementation review (2026-05-10) ehhez az ADR-hez 3 BLOCKER + 2 MAJOR-t adott:

| Codex jelzés | Súly | Beépítés |
|---|---|---|
| B1 race-window: `delete_my_account` claim/lock | BLOCKER | Per-org sequential cleanup `users.delete` ELŐTT (lépés 4) |
| B2 sole-owner/sole-member block | BLOCKER | `lastOwnerOrgs` ÉS `soleOwnerOrgs` external check (lépés 3) |
| B3 `org_${orgId}_admins` cleanup a `user-cascade-delete`-ben | BLOCKER | A meglévő CF Pass 3 bővítése |
| M3 ProtectedRoute frozen-org aux-route engedélyezés | MAJOR | `isAuxRoute` lista bővítése `/settings/account` prefix-szel |
| M5 best-effort post-delete logout | MAJOR | `account.deleteSession` try/catch wrap, redirect mindenképp |

## Kapcsolódó

- ADR: [[0012-org-member-removal-cascade]] (admin-kick párhuzamos flow)
- ADR: [[0008-permission-system-and-workflow-driven-groups]] (slug taxonómia)
- ADR: [[0003-tenant-team-acl]] (per-tenant Team ACL — admin-team cleanup)
- Komponens: [[Komponensek/SessionPreflight]] (Codex co-reflection kötelező)
- Sablon-action: `leaveOrganization` (offices.js:50)
- Existing CF: `user-cascade-delete/src/main.js`
