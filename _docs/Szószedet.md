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

## Útvonalkezelés

| Fogalom | Leírás |
|---------|--------|
| **Kanonikus útvonal** | Platform-független formátum: `/ShareName/relative/path` |
| **MOUNT_PREFIX** | `/Volumes` (macOS) vagy `C:/Volumes` (Windows) |
| **`toCanonicalPath()`** | Natív → DB formátum konverzió |
| **`toNativePath()`** | DB → natív formátum konverzió |
