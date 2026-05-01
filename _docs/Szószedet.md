---
tags: [referencia]
---

# Szószedet

## Platform & Keretrendszer

| Fogalom | Leírás |
|---------|--------|
| **UXP** | Unified Extensibility Platform — Adobe plugin rendszer |
| **ExtendScript** | InDesign scripting nyelv (CEP bridge-en keresztül futtatva) |
| **Spectrum Web Components** | Adobe design system — `@swc-uxp-wrappers/*` |
| **Appwrite** | Open-source Backend-as-a-Service (Database, Realtime, Storage, Teams) |

## Architektúra fogalmak

| Fogalom | Leírás |
|---------|--------|
| **DataContext** | Központi React Context — kiadványok, cikkek, validációk kezelése |
| **MaestroEvent** | Window-alapú `CustomEvent` eseménybusz (laza csatolás) |
| **RecoveryManager** | Kapcsolat-helyreállítás orchestrator (health check → reconnect → refresh) |
| **EndpointManager** | Dual-proxy failover kezelő singleton |
| **LockManager** | Dokumentumzárolás kezelő (DB szintű, informatív — a valódi zár az `.idlk`) |
| **DocumentMonitor** | InDesign dokumentum életciklus figyelő (`afterSave`, `afterOpen`, `afterClose`) |
| **WorkflowEngine** | Cikk állapotátmenet végrehajtó (`executeTransition`, `lockDocument`, `unlockDocument`) |
| **StateComplianceValidator** | Állapotátmenet-validáció koordinátor |

## Minták & Technikák

| Fogalom | Leírás |
|---------|--------|
| **Write-through API** | Komponens → DB írás → optimista helyi frissítés szerver válasszal |
| **`applyArticleUpdate()`** | Külső írók számára — szerver választ alkalmaz helyi állapotra DB hívás nélkül |
| **`$updatedAt` elavulás-védelem** | Frissebb helyi adat nem felülíródik régebbi szerveradattal |
| **registerTask** | Aszinkron koordinációs minta — `documentClosed` előtti feladatok bevárása |
| **`maestroSkipMonitor`** | Flag — programozott mentés ne triggerelj DocumentMonitor visszacsatolást |
| **cookieFallback** | `localStorage`-ban tárolt session (UXP cookie limitáció miatt) |
| **Fetch generáció-számláló** | Elavult fetch eredmények eldobása párhuzamos hívások esetén |
| **Ghost Socket védelem** | Socket generáció-számláló — régi socket close event-jei ignorálva |
| **`useOrgRole(orgId)`** | Központi callerOrgRole hook (active-org / owner-org / pub-org variánsok) — [[Komponensek/useOrgRole]] |
| **`getDatabases()` / `getFunctions()`** | [[Komponensek/AuthContext]] modul-szintű singleton — DataProvider-en KÍVÜLI használathoz |
| **`workflowLatestUpdatedAtRef`** | Globális `$updatedAt` Map a workflow Realtime out-of-order védelemhez ([[Komponensek/DataContext]]) |

## Útvonalkezelés

| Fogalom | Leírás |
|---------|--------|
| **Kanonikus útvonal** | Platform-független formátum: `/ShareName/relative/path` |
| **MOUNT_PREFIX** | `/Volumes` (macOS) vagy `C:/Volumes` (Windows) |
| **`toCanonicalPath()`** | Natív → DB formátum konverzió |
| **`toNativePath()`** | DB → natív formátum konverzió |

## Workflow & Bővítmények

| Fogalom | Leírás |
|---------|--------|
| **WorkflowLibraryPanel** | Közös workflow-könyvtár modal (breadcrumb chip + publikáció-hozzárendelés) — [[Komponensek/WorkflowLibrary]] |
| **WorkflowExtension** | DB-tárolt ExtendScript validátor / parancs (Proposed) — [[Komponensek/WorkflowExtension]] |
| **`WORKFLOW_STATE_COLORS`** | Közös szín-paletta + `nextAvailableColor()` helper — [[Komponensek/WorkflowStateColors]] |
| **`visibility` enum (3-state)** | `editorial_office` / `organization` / `public` — workflow scope ([[Döntések/0006-workflow-lifecycle-scope]]) |
| **`compiledWorkflowSnapshot`** | Aktivált publikáció snapshot mező — futó workflow immutable védelem |
| **`archivedAt`** | Soft-delete mező — 7 napos retention, `cleanup-archived-workflows` napi cron |
| **`buildWorkflowAclPerms()`** | Doc-szintű ACL helper a `workflows` collection-höz (Fázis 2 minta kiterjesztése) |
| **`ext.<slug>` prefix** | Workflow JSON `validations` / `commands` listájában custom extension hivatkozás |
