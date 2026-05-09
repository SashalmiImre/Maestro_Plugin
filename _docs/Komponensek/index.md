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
- [[WorkflowExtension]] — Partially Implemented (Phase 0: B.1–B.5 kész, B.6.1 manuális smoke hátra)
- [[ExtensionRegistry]] — Plugin runtime registry (B.4)
- [[WorkflowStateColors]]

## Hookok
- [[useOrgRole]] — Dashboard

## Utility-helperek
- [[UserIdentityMap]] — Dashboard név-cache (org/office/group memberships → `Map<userId, {name, email}>`)

## Jogosultság
- [[PermissionTaxonomy]] — permission slug-lista logikai csoportokba (Proposed)
- [[PermissionHelpers]] — `permissions.js` modul (shared + server-only async lookup) — Implemented (A.3.5)
- [[CompiledValidator]] — workflow `compiled` JSON hard contract validátor (shared)

## Útvonal
- [[CanonicalPath]]

## DevOps / Workflow
- [[SessionPreflight]] — kötelező infra-check minden új session elején (deploy-mechanizmus, Codex stop-time gate)
- [[CFTemplate]] — Appwrite CF boilerplate (`setEndpoint` + env var-ok + fail-closed) — drift-megelőzés

> A felület-szintű képért lásd a témakör-MOC-okat: [[Architektúra]], [[Hálózat]], [[Munkafolyamat]].
