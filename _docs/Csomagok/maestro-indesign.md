---
tags: [csomag, indesign]
aliases: [InDesign Plugin]
---

# maestro-indesign

## Cél
Adobe InDesign UXP plugin React 18 + Appwrite SDK alapon. Szerkesztőségi munkafolyamatba köti a tervezett dokumentumot: állapotátmenetek, lock, thumbnail, validáció, archív.

## Részletek
[[packages/maestro-indesign/CLAUDE]] — teljes architektúra (~557 sor).

## Főbb modulok
- **DataContext** — központi React Context (publications, articles, validations) — [[Komponensek/DataContext]]
- **MaestroEvent** — window-alapú eseménybusz a komponensek közt — [[Komponensek/MaestroEvent]]
- **WorkflowEngine** — állapotátmenet végrehajtó — [[Komponensek/WorkflowEngine]]
- **LockManager** — DB szintű dokumentum-lock — [[Komponensek/LockManager]]
- **DocumentMonitor** — UXP afterSave/afterClose eventek figyelése — [[Komponensek/DocumentMonitor]]
- **EndpointManager** — dual-proxy failover singleton — [[Komponensek/EndpointManager]]

## Kapcsolódás a többihez
- **Backend**: minden Appwrite hívás a `EndpointManager.getEndpoint()` URL-en át (Railway primary / emago.hu fallback). Ld. [[Hálózat]], [[Döntések/0001-dual-proxy-failover]].
- **Dashboard**: nem kommunikál közvetlenül; közös Appwrite collection-ek és Realtime push-ok.
- **Cloud Functions**: a plugin akció-trigger CF-eket hív (`bootstrap_organization`, `add_group_member`, stb.).

## Gotchas (kiemelt)
- A WebSocket nem küld custom headert UXP-ben → kötelezően a proxy injektálja. Ld. [[Hibaelhárítás#InDesign UXP nem küld custom headert WebSocketnek]].
- Programozott save → DocumentMonitor visszacsatolás. Flag: `maestroSkipMonitor`. Ld. [[Hibaelhárítás#Programozott save → DocumentMonitor visszacsatolás]].

## Build / futtatás
- `yarn install` (workspace gyökérről)
- Részletek a package CLAUDE.md-ben.
