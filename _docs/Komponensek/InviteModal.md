---
tags: [komponens, dashboard, modal]
aliases: [InviteModal]
---

# InviteModal (Dashboard)

## Cél
**Meghívási flow UI** ([[Döntések/0010-meghivasi-flow-redesign|ADR 0010]] W2). Discord-szerű felugró ablak, amelyen az admin egyszerre több e-mail címre küldhet meghívót, kiválasztható lejárattal és role-lal. Lecseréli a [[UsersTab]] inline űrlapját.

## Helye
- **Forrás**: `packages/maestro-dashboard/src/components/organization/InviteModal.jsx`
- **Hívó**: `UsersTab.jsx` "Új meghívó +" gomb → `useModal().openModal(InviteModal, { organizationId, onInviteSent })`

## Felület (props)
- `organizationId` (string, required) — a meghívást fogadó szervezet `$id`-ja
- `onInviteSent` (Function, optional) — sikeres kiküldés utáni callback (UsersTab pending invites lista refresh-éhez)

## Mezők
| Mező | Típus | Validáció |
|---|---|---|
| **E-mail címek** | chip-input | min 1, max 20, EMAIL_REGEX, lower-case duplikáció szűrés |
| **Szerepkör** | select | `member` (default) \| `admin` |
| **Lejárat** | radio | 1 / 3 / 7 nap (default 7) |
| **Üzenet** | textarea | opcionális, max 500 karakter |

## State machine
1. **Form állapot**: user tölti ki, validáció valós időben (`useMemo`-ban `errors` objektum)
2. **Submitting**: `Promise.all` 10-es csomagokban a `createInvite` hívás (skeleton — W2 élesítéskor `createBatchInvites` egyetlen CF action-re cserélődik)
3. **Results állapot**: per-cím status lista (sikeres / hibás), "Bezárás" gomb
4. **Error eset**: form-szintű hibaüzenet (network / permission), submit re-tryolható

## Chip-input részletek
- **Új chip commit**: Enter / Tab / vessző / blur
- **Chip eltávolítás**: × gomb a chip-en, vagy Backspace üres input-on
- **Duplikáció szűrés**: lower-case match, csendes ignore
- **Max chip**: 20 — felette az input disabled

## Kapcsolódó
- ADR: [[Döntések/0010-meghivasi-flow-redesign]]
- Komponens: [[InviteCollection]] (séma), [[UsersTab]] (hívó), [[Modal]] (general modal infrastruktúra)
- AuthContext API: `createInvite(organizationId, email, role, message?, expiryDays?)` (W2 élesítéskor `expiryDays` paraméterrel bővül)
