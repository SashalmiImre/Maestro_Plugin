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
- **Read**: `user` ({ `$id`, `email`, `name`, `groupSlugs[]`, `labels[]` }), `loading`, `organizations[]`, `editorialOffices[]`, `membershipsError`
- **Auth**: `login(email, pass)`, `logout()`, `register(name, email, pass)` — async, memberships paralel fetch
- **Reload**: `reloadMemberships()` — manuális retry membership hiba után
- **Hook**: `useUser()`

## Belső védelmek (3 generáció-számláló)
1. **`authGenRef`** — login / recovery hydration race ellen
2. **`groupSlugsGenRef`** — scope-váltás közben érkező késleltetett `groupSlugs` response ellen
3. **`membershipsGenRef`** — paralel memberships query-k race ellen

`logout` / `sessionExpired` mind3-at bumpolja → cross-tenant leakage megelőzés (in-flight hydrate ne resurrect-elje a már törölt user-t).

## Kapcsolatok
- **Hívják**: Login/Register UI, [[ScopeContext]] (TBD) (membership + auto-pick), `WorkspaceHeader` (scope dropdown), [[LockManager]] (`user.groupSlugs` perm check)
- **Eseményei**: figyel `sessionExpired` (auto logout), `groupMembershipChanged`, `scopeChanged` (mindkettő → `refreshGroupSlugs()`), `dataRefreshRequested` (recovery hydration)

## Gotchas
- **Memberships nem-kritikus**: membership hiba NEM blokkolja az auth-ot (catch + `membershipsError` state) — a user már loggedIn, az `ScopeMissingPlaceholder` mutat retry UI-t
- **`groupSlugs` Realtime megőrzése**: az `account` Realtime payload nem tartalmazza a `groupSlugs`-ot; a handler `{...payload, groupSlugs: prev?.groupSlugs || []}` mintával őrzi (ld. [[Döntések/0002-fazis2-dynamic-groups]])

## Kapcsolódó
- [[DataContext]], [[ScopeContext]] (TBD), [[MaestroEvent]], [[LockManager]], [[AuthContext]] (Dashboard megfelelő)
- [[Döntések/0002-fazis2-dynamic-groups]]
