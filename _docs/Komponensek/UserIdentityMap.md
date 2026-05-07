---
tags: [komponens]
aliases: ["userIdentity", "buildUserIdentityMap"]
---

# UserIdentityMap

## Cél

Frontend név-cache helper a Dashboard membership-listáihoz: egy `Map<userId, {name, email}>`-et épít a denormalizált membership rekordokból (`organizationMemberships`, `editorialOfficeMemberships`, `groupMemberships`). Több forrást fogad el priority-merge-szel, és self-fallback-et ad a `useAuth().user`-ből legacy rekordokra.

## Helye
- **Forrás**: `packages/maestro-dashboard/src/utils/userIdentity.js`
- **Hívók**:
  - `OrganizationSettingsModal.jsx` — primary source: `members`
  - `EditorialOfficeGroupsTab.jsx` — primary source: `officeMembers`

## Felület (API)

```js
import { buildUserIdentityMap } from '../../utils/userIdentity.js';

const userNameMap = useMemo(
    () => buildUserIdentityMap([members, officeMembers, groupMemberships], user),
    [members, officeMembers, groupMemberships,
     user?.$id, user?.name, user?.email]
);
```

| Paraméter | Típus | Cél |
|---|---|---|
| `sources` | `Array<Array<Object>>` vagy `Array<Object>` | Egy vagy több membership-doc tömb. Backward-kompat: egyetlen tömb is elfogadott. Az első nem-null `userName`/`userEmail` egy `userId`-ra "nyer" — gyakorlatilag a hívó által átadott sorrend prioritást ad. |
| `currentUser` | `Object|null` | `useAuth().user` — self-fallback ha a saját userId nincs cache-ben. |

**Returns:** `Map<string, { name: string\|null, email: string\|null }>`

## Source priority

1. **A hívó által átadott sources sorrendben**: az első nem-null mező nyer. Idempotens merge: ha az első forrás csak `name`-et adott, a második forrás `email`-jét még felveszi.
2. **Self-fallback** (`currentUser`): ha a saját bejelentkezett user `$id` nincs cache-ben, a `useAuth().user.name`/`email`-jéből pótol.

## Kapcsolatok

- **Felhasználói**:
  - [[Komponensek/AuthContext]] (`useAuth().user`)
  - `OrganizationSettingsModal.jsx`, `EditorialOfficeGroupsTab.jsx`, `UsersTab.jsx` (renderben fogyasztva)
- **Függőségei**: nincs — pure utility függvény, React import sincs benne.

## Gotchas / döntések

- **Mezőszintű `useMemo` dependency** — a teljes `user` referenciát NE add át dependency-nek (Codex 2026-05-07 review): minden `setUser(...)` hívás új referenciát ad, ami felesleges memo-újraszámítás. A `user?.$id`, `user?.name`, `user?.email` mezőszintű deps explicit és olcsóbb.
- **Backward-kompat** a régi `buildUserIdentityMap(groupMemberships, user)` hívásformára: egyetlen tömb is elfogadott — ha az `Array.isArray(sources[0])` `false`, becsomagoljuk `[sources]`-be.
- **Self-fallback safety-net**: az [[0009-membership-user-identity-denormalization|ADR 0009]] óta a `organizationMemberships` és `editorialOfficeMemberships` is denormalizált — viszont a `backfill_membership_user_names` action még nem futott le minden meglévő rekordra. A self-fallback addig fedi a UI-t, amíg a backfill rendezi.
- **Idempotens merge**: a `Map.set` csak akkor fut, ha a `existing` mező null (felesleges re-render ellen).

## Kapcsolódó

- ADR: [[Döntések/0009-membership-user-identity-denormalization]]
- Komponens: [[Komponensek/AuthContext]] (a `user` Account doc forrása)
- Schema: `organizationMemberships` / `editorialOfficeMemberships` / `groupMemberships` `userName` + `userEmail` mezők
