---
tags: [komponens, plugin, auth]
aliases: [UserContext, useUser, AuthorizationProvider]
---

# UserContext

## Cél
Bejelentkezés / kijelentkezés / regisztráció, session kezelés (localStorage cookie fallback), felhasználó adat-szinkron (Realtime + recovery), csoporttagság (`groupSlugs`) + organization/office membership listázás. **Plugin oldal**.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/contexts/UserContext.jsx:160` (`AuthorizationProvider`), `:760` (`useUser` hook)

## Felület (API)
- **Read**: `user` ({ `$id`, `email`, `name`, `groupSlugs[]`, `labels[]`, `permissions: string[]|null` }), `loading`, `organizations[]`, `editorialOffices[]`, `membershipsError`
- **Auth**: `login(email, pass)`, `logout()`, `register(name, email, pass)` — async, memberships paralel fetch
- **Reload**: `reloadMemberships()` — manuális retry membership hiba után
- **Hook**: `useUser()`

## Belső védelmek (4 generáció-számláló)
1. **`authGenRef`** — login / recovery hydration race ellen
2. **`groupSlugsGenRef`** — scope-váltás közben érkező késleltetett `groupSlugs` response ellen
3. **`permissionsGenRef`** — A.5.1 — scope-váltás közben érkező késleltetett `permissions` snapshot response ellen
4. **`membershipsGenRef`** — paralel memberships query-k race ellen

`bumpAllAuthGens()` Provider-szintű helper mind a 4 counter-t bumpolja az auth-boundary átmeneteknél (login start, logout, sessionExpired). A `refreshGroupSlugs` és `refreshPermissions` setUser-callback-jeibe `prev.$id !== currentUserId` belt-and-suspenders guard — cross-user leakage védelem (Codex baseline review harden fix, 2026-05-03).

## Permission-snapshot (A.5.1, ADR 0008)
- **Tri-state `user.permissions`**: `null` = még nem hydratált (loading); `[]` = sikeresen lekérdezett, de nincs jog; `string[]` = 33 office-scope slug subset-je. A `clientHasPermission(null, slug) === false` (konzervatív loading), így a `useUserPermission(slug)` hook `loading: true`-t ad amíg az első hidratálás be nem fejeződik.
- **Server `buildPermissionSnapshot` replikája**: label admin → `organizationMemberships.role === 'owner'/'admin'` → 33 slug shortcut → `editorialOfficeMemberships` cross-check (defense-in-depth) → `groupMemberships × groupPermissionSets × permissionSets` (paginált+chunked, `archivedAt === null` szűrt). A lapozás közös `paginateAll` util-on át megy ([core/utils/promiseUtils.js](packages/maestro-indesign/src/core/utils/promiseUtils.js)).
- **"Őrizd meg a régit" minta**: minden belső lookup helper DB-hiba esetén dob (a "0 doc" lépcsőkön legitim üres set). A `enrichUserWithPermissions(userData, officeId, previousPermissions)` catch-ágon `previousPermissions ?? null` fallback. A recovery (`handleRefresh`) átadja a `userRef.current?.permissions`-t — egy tranziens DB hiba ne tüntesse el a meglévő snapshotot. Az első login-on `null` (nincs előző érték) — konzervatív loading.
- **Scope-váltás eager-clear (Codex stop-time fix)**: a `scopeChanged` handler azonnal nullázza a `groupSlugs`-ot és `permissions`-t a refresh-ek INDÍTÁSA ELŐTT — ha a refresh hibázik, a régi office állapota nem maradhat stale az új office kontextusában.
- **Drift-rizikó**: a snapshot-logika 3 helyen él (server CF `permissions.js`, shared sync helpers, plugin lookup itt). Single-source bundle vagy AST-equality CI test rendezné — Phase 2 / A.7.1 hatáskör. Kommentelve.
- **Hook réteg**: `useUserPermission(slug)` és `useUserPermissions(slugs)` ([useElementPermission.js](packages/maestro-indesign/src/data/hooks/useElementPermission.js)) — `clientHasPermission`-re alapozva, fail-closed throw → catch → `{ allowed: false, loading: false }`. A workflow-runtime hookok (`useElementPermission`, `useContributorPermissions`, `useStateAccessPermission`) változatlanok — a két réteg AND-elve használandó.

## Kapcsolatok
- **Hívják**: Login/Register UI, [[ScopeContext]] (TBD) (membership + auto-pick), `WorkspaceHeader` (scope dropdown), [[LockManager]] (`user.groupSlugs` perm check), `useUserPermission` / `useUserPermissions` hookok
- **Eseményei**: figyel `sessionExpired` (auto logout), `groupMembershipChanged` (`refreshGroupSlugs` + `refreshPermissions`), `scopeChanged` (ugyanaz), `permissionSetsChanged` (`refreshPermissions`, A.5.3 új), `dataRefreshRequested` (recovery hydration paralel mindkét rétegre)
- **Realtime**: új subscribe a `permissionSets` + `groupPermissionSets` csatornákra (200ms debounce, scope-szűrt) → dispatcheli a `permissionSetsChanged` MaestroEvent-et

## Gotchas
- **Memberships nem-kritikus**: membership hiba NEM blokkolja az auth-ot (catch + `membershipsError` state) — a user már loggedIn, az `ScopeMissingPlaceholder` mutat retry UI-t
- **`groupSlugs` Realtime megőrzése**: az `account` Realtime payload nem tartalmazza a `groupSlugs`-ot; a handler `{...payload, groupSlugs: prev?.groupSlugs || []}` mintával őrzi (ld. [[Döntések/0002-fazis2-dynamic-groups]])
- **`permissions` Realtime megőrzése (A.5.1)**: az `account` Realtime payload sem tartalmazza a `permissions`-t (külön collection-ek); `prev?.permissions ?? null` mintával őrzi (a `??` nem `||`, hogy az üres array ne nyomódjon vissza `null`-ra)

## Kapcsolódó
- [[DataContext]], [[ScopeContext]] (TBD), [[MaestroEvent]], [[LockManager]], [[AuthContext]] (Dashboard megfelelő)
- [[Döntések/0002-fazis2-dynamic-groups]], [[Döntések/0008-permission-system-and-workflow-driven-groups]]
- [[Komponensek/PermissionHelpers]], [[Komponensek/PermissionTaxonomy]]
