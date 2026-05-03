---
tags: [komponens, dashboard, auth]
aliases: [AuthContext, Dashboard AuthContext]
---

# AuthContext (Dashboard)

## Cél
**Dashboard auth + tenant szinkron**: bejelentkezés / regisztráció, organization + editorial office membership kezelése, scope, Realtime feliratkozás 4 tenant collection-re. **NEM tévesztendő össze a Plugin [[UserContext]]-tel**.

## Helye
- **Forrás**: `packages/maestro-dashboard/src/contexts/AuthContext.jsx:1–1363`

## Felület (API)
- **Auth**: `login(email, password)`, `logout()`, `register(name, email, password)`, `acceptInvite(token)`, `declineInvite(token)`, `leaveOrganization(orgId)`
- **Tenant ops**: `createOrganization(name, slug)`, `createEditorialOffice(orgId, name, sourceWorkflowId)` — CF `callInviteFunction`-on át
- **Group ops**: `createGroup(officeId, name)`, `renameGroup(groupId, name)`, `deleteGroup(groupId)`, `updateGroupMetadata(groupId, patch)`, `archiveGroup(groupId)`, `restoreGroup(groupId)` ([[Döntések/0008-permission-system-and-workflow-driven-groups|ADR 0008]] A.2.6 / A.2.7 — soft-delete + metadata: label / description / color / `isContributorGroup` / `isLeaderGroup`)
- **Permission set ops** (ADR 0008 A.3.3): `createPermissionSet(payload)`, `updatePermissionSet(permissionSetId, patch, expectedUpdatedAt?)`, `archivePermissionSet(permissionSetId, expectedUpdatedAt?)`, `restorePermissionSet(permissionSetId, expectedUpdatedAt?)`
- **Permission set assign** (ADR 0008 A.3.4): `assignPermissionSetToGroup(groupId, permissionSetId)`, `unassignPermissionSetFromGroup(groupId, permissionSetId)` — `groupPermissionSets` m:n junction
- **Publication ops** (ADR 0008 A.2.2 / A.2.3): `activatePublication(publicationId, expectedUpdatedAt?)`, `assignWorkflowToPublication(publicationId, workflowId, expectedUpdatedAt?)`. Mindkettő `callInviteFunction`-on át — autoseed + `empty_required_groups` 409 / TOCTOU `concurrent_modification` 409 kezelés. A direkt `databases.updateDocument({isActivated: true})` és `updatePublication({workflowId})` megkerülné a server-side autoseedet, ezért a UI ezeken keresztül megy.
- **Reload**: `reloadMemberships()` → `true`/`false`
- **Read**: `user`, `organizations`, `editorialOffices`, `orgMemberships`, `membershipsError`, `loading`

## CF error wrapper (`callInviteFunction`)
A non-2xx CF response-ból `Error` objektumot dob, az alábbi mezőkkel: `code` / `statusCode` / `response` (teljes payload) + lapított `slugs` / `errors` / `unknownSlugs` (ha a CF visszaadta). A hívók `err?.code` mintával olvassák. Korábban duplázott `wrapped.reason` alias eltávolítva (harden 5. fázis): a kódbázis-konvenció `code` egyedüli forrás.

## Realtime feliratkozás
- 4 collection: `ORGANIZATIONS`, `EDITORIAL_OFFICES`, `ORGANIZATION_MEMBERSHIPS`, `EDITORIAL_OFFICE_MEMBERSHIPS`
- **Subscribe módja**: kötelezően [[RealtimeBus]] `subscribeRealtime()` — NEM közvetlen `client.subscribe()` ([[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]])
- **Filter szabályok**: `*Memberships` event csak ha `payload.userId === user.$id`; org/office update/delete csak ha az ID benne van `organizationIdsRef`/`editorialOfficeIdsRef`-ben; create skip-elve
- **Debounce**: 300ms — cascade műveletek (pl. org törlése × N office) egy fetch-be vonódnak
- **Silent vs. fail-closed**: update/rename → `silent: true` (tranziens hiba ne törölje a scope-ot); delete → `silent: false` (hozzáférés-vesztés)
- **Reconnect-time resync** ([[Döntések/0004-dashboard-realtime-bus]] 2026-05-03 záradék): `subscribeRealtime` `{ onReconnect }` opció — WS újrakapcsolódáskor (NEM az elsőkor) `loadAndSetMemberships(userId, { silent: true })`. A silent mód indoka: tranziens hiba reconnect-en ne ürítse a már érvényes scope-ot — destructive eseteket egy 403 vagy tényleges Realtime delete event jelez.

## Modul-szintű singleton exportok
A `getClient()` / `getAccount()` mintájára a modul publikusan exportálja a `databases` és `functions` Appwrite példányt is:

```js
export function getDatabases() { /* ... */ }
export function getFunctions() { /* ... */ }
```

**Mikor kell?** DataProvider-en KÍVÜL futó komponensek (pl. `routes/settings/GroupsRoute.jsx`, `features/workflowDesigner/WorkflowDesignerRedirect.jsx` legacy URL redirect). A render-on-kívüli vagy modul-szintű kontextusban is használhatóak.

**Mikor NE?** DataProvider-en BELÜL: ott a `useData().databases` / `.storage` a hivatalos belépési pont (egyetlen Provider-példány, hot-config swap-pal kompatibilis).

**Tilos**: `new Databases(getClient())` ad-hoc — silent dual-instance bug-okat okoz. Ld. [[Fejlesztési szabályok]].

## Kapcsolatok
- **Hívják**: Login route, [[ScopeContext]] (TBD) (onboarding), [[DataContext]] (tagságok betöltése előtt)
- **Hívja**: `fetchMemberships()` (paralel org + office query), `callInviteFunction()` (közös CF helper), [[RealtimeBus]] (`subscribeRealtime`)

## Gotchas
- **`membershipsError` state**: megkülönböztet üres tagság-listát (null) vs. átmeneti backend hibát (Error). `ProtectedRoute` ennek alapján dönt: `/onboarding` vs. `/error-retry`.
- **`loadAndSetMemberships` `silent: false`** ágon hiba esetén nullázza az org/office listákat (fail-closed) ÉS beállítja `membershipsError`-t → [[ScopeContext]] auto-pick blokkolva, retry overlay látszik.

## Kapcsolódó
- [[DataContext]] (Dashboard), [[RealtimeBus]], [[ScopeContext]] (TBD), [[UserContext]] (Plugin megfelelő)
- [[Döntések/0003-tenant-team-acl]], [[Döntések/0004-dashboard-realtime-bus]], [[Döntések/0006-workflow-lifecycle-scope]]
- [[useOrgRole]] (a `orgMemberships` központi consumer-e)
