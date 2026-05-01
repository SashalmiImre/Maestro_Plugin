---
tags: [moc, komponens]
---

# Komponensek (atomic notes)

Egy fájl = egy domain fogalom. Mély, lefelé linkel a kódra (`fájl:sor`), oldalra a kapcsolódó komponensekre.

## Adat & Esemény
- [[DataContext]] — Plugin + Dashboard
- [[MaestroEvent]]
- [[ValidationContext]]
- [[UserContext]] — Plugin
- [[AuthContext]] — Dashboard
- [[ConnectionContext]] — Plugin

## Hálózat
- [[EndpointManager]]
- [[RecoveryManager]]
- [[RealtimeClient]] — Plugin (InDesign)
- [[RealtimeBus]] — Dashboard

## Workflow
- [[WorkflowEngine]]
- [[StateComplianceValidator]]
- [[LockManager]]
- [[DocumentMonitor]]
- [[WorkflowLibrary]] — Dashboard
- [[WorkflowExtension]] — Proposed
- [[WorkflowStateColors]]

## Hookok
- [[useOrgRole]] — Dashboard

## Útvonal
- [[CanonicalPath]]

> A felület-szintű képért lásd a témakör-MOC-okat: [[Architektúra]], [[Hálózat]], [[Munkafolyamat]].
