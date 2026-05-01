---
tags: [komponens, dashboard, workflow]
aliases: [WorkflowLibraryPanel, Workflow könyvtár]
---

# WorkflowLibrary

## Cél
Közös modal a workflow-könyvtár megnyitásához két különböző kontextusból: breadcrumb chip (általános böngészés) és publikáció-hozzárendelés (a kiadvány-beállítások `GeneralTab`-jából). Egyetlen helyen él a scope-szűrés, fulltext kereső, aktív/archivált tab és a Realtime feliratkozás — a megnyitó komponens csak a `context` propot adja.

## Helye
- **Forrás**: `packages/maestro-dashboard/src/components/workflows/WorkflowLibraryPanel.jsx`
- **Társa**: `packages/maestro-dashboard/src/components/workflows/CreateWorkflowModal.jsx` (panel fejlécében: "+ Új workflow")
- **CSS**: `packages/maestro-dashboard/src/css/features/workflow-library.css`

## Felület (API)

| Prop | Típus | Mit csinál |
|---|---|---|
| `context` | `'breadcrumb' \| 'publication-assignment'` | Megjelenítés-kontextus |
| `onSelect(workflowId)` | function | Workflow kiválasztása (publikáció-hozzárendelés esetén) |
| `onClose()` | function | Modal zárás |

## Belső szerkezet

- **Scope chip-szűrés** (multi-select toggle gombok): `editorial_office` / `organization` / `public`
- **Aktív / Archivált tab**: az archivált lista központosítva a [[DataContext]]-be (`archivedWorkflows`)
- **Fulltext kereső**: `name` + `description` (a fulltext index-et a `bootstrap_workflow_schema` CF teríti)
- **Rendezés**: név / `$updatedAt` (Utoljára mentve)
- **Card akciók**: "Megnyit" (saját → edit route; idegen → read-only preview), "Duplikál" (mindenkinek elérhető — ld. ADR 0006 Megnyitva tartott kérdések, #88), "Archivál" (csak saját)

## Realtime
- A `workflows` collection változásait a [[RealtimeBus]] `subscribeRealtime()`-on keresztül kapja — közvetlen `client.subscribe()` TILOS ([[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]])
- A panel csak konzument: az archivált lista a [[DataContext]]-ben él, scope-eager fetch + dual-list Realtime handler

## Kapcsolatok
- **Felhasználói**: `BreadcrumbHeader.jsx` (chip), `publications/GeneralTab.jsx` (workflow-picker gomb)
- **Függőségei**: [[DataContext]] (archivált lista, scope-szűrt aktív lista, `archivedWorkflowsLoading` / `workflowsLoading`), [[useOrgRole]] (role-gate a "Duplikál" / "+ Új workflow" akciókhoz), `usePrompt` / `useCopyDialog` (átnevezés / leírás-szerkesztés Modal-alapú dialog)
- **Eseményei**: dispatch nincs (közvetlen state-write a `DataContext`-en át)

## Gotchas / döntések
- **`disabled` chip + tooltip**: ha a user új szervezetnél van, ahol nincs office, vagy "legacy default office" + 0 publikáció → a breadcrumb chip `disabled`, magyarázó tooltip. Részletek: [[Hibaelhárítás#Office nélküli szervezetre váltás után stale publikáció / workflow state]].
- **`canCreateWorkflow` role-gate**: csak owner/admin az aktív office org-jában láthatja a "+ Új workflow" / "Duplikál & szerkeszt" CTA-kat. Member-user kérje az ownertől (ld. ADR 0006 #88).
- **Idegen workflow**: a "Megnyit" akció read-only módba navigál; mentés-kísérlet "Más néven mentés" flow-ra vált.
- A scope chip-csoport mintájára a Dashboard egyéb felületein is használható **újrafelhasználható UI elem** lehet a jövőben (Feladatok #N-01).

## Kapcsolódó
- ADR: [[Döntések/0006-workflow-lifecycle-scope]]
- Komponensek: [[DataContext]], [[useOrgRole]], [[RealtimeBus]], [[WorkflowStateColors]]
- Csomag: [[Csomagok/dashboard-workflow-designer]]
