---
tags: [adr, workflow, dashboard, lifecycle, acl]
status: Accepted
date: 2026-04-20
---

# 0006 — Workflow életciklus & scope refactor

## Kontextus

A Maestro Workflow Designer első iterációja után a workflow-ka a `EditorialOfficeSettingsModal` egyik tabján keresztül érte el a felhasználó. Több UX-súrlódás:

- **Settings-be temetve**: a workflow önálló entitás, mégis a szerkesztőség beállítások mélyén élt — a kiadvány-hozzárendelésnél is külön `<select>` dropdown duplikálta a listát.
- **Csak `editorial_office` scope**: minden workflow egy adott szerkesztőséghez kötött — szervezet-szinten újrafelhasználni nem lehetett, publikus megosztásra nem volt mód.
- **Nincs soft-delete**: a törlés azonnal elveszett (futó publikációk a snapshot mezőjük miatt védve, de a UI törlés irreverzibilis volt).
- **Idegen workflow nyitása nem definiált**: a felhasználó vagy láthatta, vagy nem — nem volt szabályozva, hogy mit lát írhatatlan módban.
- **Cross-tenant Realtime leak**: a `workflows` collection `read("users")` ACL-je miatt minden authenticated user megkapta minden workflow Realtime payload-ját (mint a Fázis 2 érintett collection-öknél, ld. [[0003-tenant-team-acl]]).

A felhasználói felvetés (2026-04-20) a workflow-tervező és -kezelés szétválasztását kérte: a workflow önálló életet él, breadcrumb melletti chip nyitja meg a könyvtár modal-t (ComfyUI template-panel mintára), ugyanaz a panel jelenik meg a kiadvány-hozzárendelésnél.

## Döntés

**A workflow self-contained entitás 3-state visibility-vel, doc-szintű ACL-lel, soft-delete-tel és snapshot-védett aktiválással.**

### `visibility` enum bővítés (2 → 3 érték)

| Érték | Ki látja? | Doc-szintű ACL |
|---|---|---|
| `editorial_office` | csak az adott office tagjai | `read("team:office_${officeId}")` |
| `organization` | a szervezet ÖSSZES tagja (cross-office is) | `read("team:org_${orgId}")` |
| `public` | minden authenticated user (potenciálisan minden tenant) | `read("users")` |

Helper: `buildWorkflowAclPerms(visibility, orgId, officeId)` a `teamHelpers.js`-ben — owner/`createdBy` mindig kap explicit `Permission.update`/`Permission.delete`-et.

### Soft-delete + cron hard-delete

- `archivedAt: datetime | null` mező a `workflows` collection-ben.
- `archive_workflow` / `restore_workflow` CF action közös handler `isArchive` flag-gel. Auth: `createdBy === callerId` VAGY org owner/admin fallback (kilépett tag workflow-jának takarítására). Idempotens (`already_archived` / `already_active`).
- **`cleanup-archived-workflows`** új Appwrite scheduled CF (cron `0 5 * * *`, retention `ARCHIVED_RETENTION_DAYS=7` env var). Per-workflow blocking scan: ha **legalább egy snapshot-nélküli publikáció** hivatkozik, skip — a snapshot-tal védett aktív pub-ok NEM blokkolnak.
- Stats response: `{ eligibleCount, deletedCount, skippedCount, skippedDetails }`.

### Doc-szintű ACL + `rowSecurity: true`

A Fázis 2 minta ([[0003-tenant-team-acl]]) kiterjesztése a `workflows` collection-re:

- `rowSecurity: true` (Appwrite Console — manuális cutover).
- Globális `read("users")` ACL eltávolítva, doc-szinten `buildWorkflowAclPerms()` állítja a perm-listát.
- Minden CF write path (`createWorkflowDoc` helper + 4 hívó: `bootstrap_organization`, `create_workflow`, `create_editorial_office` seed, `duplicate_workflow`) doc-szintű permission-listával ír.
- Scope-váltáskor (`update_workflow_metadata`) ACL újraszámolva a frissített `visibility` alapján.

### Scope-shrinkage warning

Tágítás (pl. `editorial_office` → `organization`) szabadon: csak info-tooltip ("Mostantól szélesebb kör is látja és használhatja").

Szűkítés (pl. `public` → `organization`) → `update_workflow_metadata` 409 `visibility_shrinkage_warning`. A klienst kétszeri retry-jal hívja: az első `force: false` → warning, dialog kérdez a felhasználótól → `force: true` override → ACL újraszámolva.

**Futó publikáció védelme**: az aktivált publikáció `compiledWorkflowSnapshot`-ot tartalmaz, ezért scope-szűkítés a snapshot-tal védett pub-okra hatástalan — csak az új aktiválások szigorodnak.

### Idegen workflow read-only + Duplikál & Szerkeszt CTA

A `WorkflowDesignerPage` `isReadOnly = isForeignOffice || isInsufficientRole` állapotot vezet (office-boundary + role-gate). Read-only módban a canvas view-only, a toolbar mentés gomb helyén "Duplikál & szerkeszt" CTA. Ha read-only-ban mentést kísérel a user (Ctrl+S), dialog vált "Más néven mentés" flow-ra → új workflow `editorial_office` scope-on, `createdBy = caller`.

`duplicate_workflow` CF cross-tenant: a forrás bárhol lehet (saját office / org / public — ACL alapján validálva), a cél MINDIG az aktív office (`editorialOfficeId` payload = TARGET, nem source), a duplikátum MINDIG `editorial_office` scope-on indul. Név-ütközés esetén auto-suffix (`(másolat)`, `(másolat 2)`, …, cap 20).

### `WorkflowLibraryPanel` modal

Két context (`'breadcrumb'` és `'publication-assignment'`), közös komponens. Scope chip-szűrés multi-select (office/org/public), fulltext kereső (`name` + `description`), aktív/archivált tab, Realtime via [[Komponensek/RealtimeBus]] `subscribeRealtime`.

`EditorialOfficeWorkflowTab` törölve — a Settings → Workflow tab megszűnt. A breadcrumb melletti chip nyitja a könyvtárat, a publikáció `GeneralTab` `<select>`-jét is ez a panel váltja le.

### Új route-ok + legacy redirect

- `/workflows/:id` (designer)
- `/workflows/new` (üres designer / modal-alapú belépési pont)
- Legacy `/admin/office/:officeId/workflow/:workflowId` → redirect `/workflows/:id`-re. A `WorkflowDesignerRedirect` DataProvider-en KÍVÜL fut, [[Komponensek/AuthContext]] modul-szintű `getDatabases()` singleton-jával.

## Alternatívák

| Opció | Mellette | Ellene |
|---|---|---|
| **Status quo (Settings tab)** | 0 munka | Nem skálázik organization-szintre, idegen workflow nyitás nem definiált, soft-delete hiánya |
| **Csak organization scope (2-state)** | Egyszerűbb ACL | Publikus megosztás (marketplace előkép) blokkolva, cross-office sharing erőltetett |
| **Hard-delete (azonnali)** | Egyszerű, cron-mentes | Kreatív munka elveszhet, undo nem támogatott — futó pub a snapshot-tal védve, de a UI workflow visszaállítása lehetetlen |
| **3-state visibility + soft-delete + cron** (választott) | Minden user-igény lefedve, ACL Fázis 2 mintát követi, futó pub snapshot védi | Új konvenciók (`buildWorkflowAclPerms`, scheduled CF), `rowSecurity: true` cutover manuális Appwrite Console művelet |

## Következmények

- **Pozitív**: Workflow első osztályú entitás. Publikus megosztás (marketplace előkép) lehetővé válik. Cross-tenant Realtime leak megszűnik. Soft-delete + cron retention biztosítja a véletlen törlés visszafordíthatóságát.
- **Negatív / trade-off**: Új cron CF (`cleanup-archived-workflows`) ops-szempontból új deploy. `rowSecurity: true` cutover az Appwrite Console-on manuális — a régi `read("users")` ACL eltávolítása és a flag bekapcsolása egy lépés (egy elfelejtett config → silent leak).
- **Új kötelezettségek**:
  - Minden új `workflows` create/update CF action **kötelezően** `buildWorkflowAclPerms()` perm-listával hív `databases.createDocument` / `updateDocument`.
  - Új workflow CF action vagy hívóhelyen a tulajdonos-ellenőrzés (`createdBy === callerId` vagy org owner/admin fallback) explicit.
  - Klasztermérnöki: a `cleanup-archived-workflows` env var-ok (`DATABASE_ID`, `WORKFLOWS_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, `ARCHIVED_RETENTION_DAYS`) a deploy konfigjában.

## Implementáció (kulcsfájlok)

| Modul | Felelősség |
|---|---|
| `packages/maestro-server/.../teamHelpers.js` | `buildWorkflowAclPerms(visibility, orgId, officeId, createdBy?, force?)` |
| `packages/maestro-server/invite-to-organization/.../main.js` | `archive_workflow`, `restore_workflow`, `update_workflow_metadata` (warning + force flow), `duplicate_workflow` (cross-tenant) |
| `packages/maestro-server/cleanup-archived-workflows/` | Új scheduled CF, napi cron, snapshot-blocking scan |
| `packages/maestro-dashboard/src/components/workflows/WorkflowLibraryPanel.jsx` | Két context, scope chip-szűrés, fulltext kereső |
| `packages/maestro-dashboard/src/components/workflows/CreateWorkflowModal.jsx` | "Új workflow" létrehozás `WorkflowLibraryPanel` fejlécéből |
| `packages/maestro-dashboard/src/features/workflowDesigner/WorkflowDesignerPage.jsx` | `isReadOnly` state, "Duplikál & szerkeszt" CTA, scope-shrinkage warning dialog |
| `packages/maestro-dashboard/src/features/workflowDesigner/WorkflowNewRoute.jsx` | Modal-alapú belépési pont `/workflows/new`-hez |
| `packages/maestro-dashboard/src/App.jsx` | Új route-ok + legacy redirect-ek |

## Megnyitva tartott kérdések

- **#87 Smoke teszt + adversarial**: 2-tab Realtime scope-váltás (`rowSecurity: true` + doc-ACL → csak jogosult kliens kap WS payload-ot), cross-tenant izoláció (B org user nem látja A `editorial_office`/`organization` workflow-it), CF guard adversarial (state-patch a böngésző DevTools-ból megkerülheti-e a read-only UI-t — szerveroldal véd). 7 napos hard-delete cron élesben nem tesztelhető — manuális trigger vagy admin-only CF action.
- **#88 `duplicate_workflow` member policy**: a CF jelenleg org `owner`/`admin` szerepkörhöz köti a duplikálást (`insufficient_role` 403 member-eknek). A design intent szerint a `public`/`organization` scope-ú workflow-kat read-only módban minden tag megnyithatja, és a "Duplikál & Szerkeszt" CTA az egyetlen útja annak, hogy egy non-admin szerkesztő saját scope-ba forkolja. **Eldöntendő**: (a) CF policy lazítás — bármely org member duplikálhat saját office-ába (UI gate visszavonva); VAGY (b) CTA owner/admin-only jelölés + "kérd owner-től" üzenet member-eknek. Az (a) konzisztens a read-only UX intent-jével, a (b) szigorúbb kontrollt tart.

## Kapcsolódó

- ADR-ek: [[0002-fazis2-dynamic-groups]] (alapozó), [[0003-tenant-team-acl]] (ACL minta), [[0007-workflow-extensions]] (kapcsolódó terv)
- Komponensek: [[Komponensek/WorkflowLibrary]], [[Komponensek/DataContext]], [[Komponensek/AuthContext]], [[Komponensek/useOrgRole]], [[Komponensek/WorkflowStateColors]]
- Csomagok: [[Csomagok/dashboard-workflow-designer]]
