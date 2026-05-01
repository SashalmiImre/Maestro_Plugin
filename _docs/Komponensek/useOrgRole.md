---
tags: [komponens, dashboard, hook, jogosultság]
aliases: [useOrgRole]
---

# useOrgRole

## Cél
Központi hook a `callerOrgRole` pattern-hez. A Dashboard tucatnyi komponens előbb manuálisan keresett az `orgMemberships` listában a `(organizationId, userId)` páros alapján — ezt egyetlen hívás váltja le. Explicit `organizationId` paraméter (3 szemantikai variáns: active-org, workflow-owner-org, publication-org).

## Helye
- **Forrás**: `packages/maestro-dashboard/src/hooks/useOrgRole.js`

## Felület (API)

```js
const { role, isOwner, isAdmin, isOrgAdmin, isMember } = useOrgRole(organizationId);
```

| Mező | Típus | Mit jelent |
|---|---|---|
| `role` | `'owner' \| 'admin' \| 'member' \| null` | Nyers role; `null` ha nincs membership |
| `isOwner` | bool | `role === 'owner'` |
| `isAdmin` | bool | `role === 'admin'` |
| `isOrgAdmin` | bool | `isOwner \|\| isAdmin` (a leggyakoribb gate) |
| `isMember` | bool | `role === 'member'` |

`organizationId === null` esetén `EMPTY_ROLE` frozen objektum (mind `false` / `null`).

## Miért nincs default `activeOrganizationId`
3 szemantikai variáns él párhuzamosan: az aktív szervezet (DashboardLayout), a workflow tulajdonos szervezete (WorkflowDesignerPage — idegen office is lehet), és a publikáció szervezete (publications/GeneralTab). Implicit default elrejtené a választást.

## Fogyasztók (példák)
- `DashboardLayout.jsx` (active-org gate-ek)
- `WorkflowLibraryPanel.jsx` (active-org)
- `WorkflowDesignerPage.jsx` (kettős hívás: workflow-owner-org + active-office-org — mindkettő read-only / CTA gate-hez kell)
- `WorkflowNewRoute.jsx` (active-office-org)
- `EditorialOfficeSettingsModal.jsx` (office-org)
- `publications/GeneralTab.jsx` (publication-org)

**Szándékosan nem használja**: `OrganizationSettingsModal` (közvetlen collection fetch, nem `orgMemberships` snapshot) és `MaestroSettingsModal` (multi-org aggregáció) — eltérő szemantika.

## Kapcsolódó
- Komponensek: [[AuthContext]] (forrás: `orgMemberships`), [[DataContext]]
- Csomag: [[Csomagok/dashboard-workflow-designer]] és általános dashboard
