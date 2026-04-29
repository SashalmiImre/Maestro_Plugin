---
tags: [komponens, dashboard, auth]
aliases: [AuthContext, Dashboard AuthContext]
---

# AuthContext (Dashboard)

## Cél
**Dashboard auth + tenant szinkron**: bejelentkezés / regisztráció, organization + editorial office membership kezelése, scope, Realtime feliratkozás 4 tenant collection-re. **NEM tévesztendő össze a Plugin [[UserContext]]-tel**.

## Helye
- **Forrás**: `packages/maestro-dashboard/src/contexts/AuthContext.jsx:1–1090`

## Felület (API)
- **Auth**: `login(email, password)`, `logout()`, `register(name, email, password)`, `acceptInvite(token)`, `declineInvite(token)`, `leaveOrganization(orgId)`
- **Tenant ops**: `createOrganization(name, slug)`, `createEditorialOffice(orgId, name, sourceWorkflowId)` — CF `callInviteFunction`-on át
- **Group ops**: `createGroup(officeId, name)`, `renameGroup(groupId, name)`, `deleteGroup(groupId)`
- **Reload**: `reloadMemberships()` → `true`/`false`
- **Read**: `user`, `organizations`, `editorialOffices`, `orgMemberships`, `membershipsError`, `loading`

## Realtime feliratkozás
- 4 collection: `ORGANIZATIONS`, `EDITORIAL_OFFICES`, `ORGANIZATION_MEMBERSHIPS`, `EDITORIAL_OFFICE_MEMBERSHIPS`
- **Subscribe módja**: kötelezően [[RealtimeBus]] `subscribeRealtime()` — NEM közvetlen `client.subscribe()` ([[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]])
- **Filter szabályok**: `*Memberships` event csak ha `payload.userId === user.$id`; org/office update/delete csak ha az ID benne van `organizationIdsRef`/`editorialOfficeIdsRef`-ben; create skip-elve
- **Debounce**: 300ms — cascade műveletek (pl. org törlése × N office) egy fetch-be vonódnak
- **Silent vs. fail-closed**: update/rename → `silent: true` (tranziens hiba ne törölje a scope-ot); delete → `silent: false` (hozzáférés-vesztés)

## Kapcsolatok
- **Hívják**: Login route, [[ScopeContext]] (TBD) (onboarding), [[DataContext]] (tagságok betöltése előtt)
- **Hívja**: `fetchMemberships()` (paralel org + office query), `callInviteFunction()` (közös CF helper), [[RealtimeBus]] (`subscribeRealtime`)

## Gotchas
- **`membershipsError` state**: megkülönböztet üres tagság-listát (null) vs. átmeneti backend hibát (Error). `ProtectedRoute` ennek alapján dönt: `/onboarding` vs. `/error-retry`.
- **`loadAndSetMemberships` `silent: false`** ágon hiba esetén nullázza az org/office listákat (fail-closed) ÉS beállítja `membershipsError`-t → [[ScopeContext]] auto-pick blokkolva, retry overlay látszik.

## Kapcsolódó
- [[DataContext]] (Dashboard), [[RealtimeBus]], [[ScopeContext]] (TBD), [[UserContext]] (Plugin megfelelő)
- [[Döntések/0003-tenant-team-acl]], [[Döntések/0004-dashboard-realtime-bus]]
