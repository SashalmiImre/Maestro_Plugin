---
tags: [komponens, audit-trail, admin-ui, gdpr]
related:
  - "[[Komponensek/LoggingMonitoring]]"
  - "[[Komponensek/SecurityRiskRegister]]"
  - "[[Döntések/0011-cas-gate-and-orphan-guard-invariants]]"
---

# AuditTrail — Admin audit-view + audit-completeness (S.10 záró)

## Kontextus

ASVS V7 + CIS Controls 8. Az audit-trail jelenleg **szétszórva**: 3 collection + log-szintű event-ek. Admin-oldali aggregált audit-view hiányzik (`/settings/organization/audit` route NEM-létezik).

## Jelenlegi audit-források

| Source | Collection / Log | Retention | UI elérhetőség |
|---|---|---|---|
| Meghívási events | `organizationInviteHistory` (D.3 ADR 0011) | forever (admin-deletable) | Dashboard `InviteHistoryTab` ✅ |
| Member-removal | log-only (`[RemoveOrgMember]` ctx.log) | Appwrite CF logs 30/90 nap | ❌ NEM-UI |
| Role-change | log-only (`[ChangeOrgMemberRole]` ctx.log) | ditto | ❌ NEM-UI |
| ACL-backfill | log-only | ditto | ❌ NEM-UI |
| GDPR-export | NEM-implement | N/A | ❌ S.10.3 USER-TASK |

## S.10.1 — Admin audit-view UI (design, Phase 3)

**Új route**: `/settings/organization/audit` (Dashboard, admin-only).

**Tartalom**:
- **Tab 1: Meghívási history** — `organizationInviteHistory` query, filter by status/date/email
- **Tab 2: Member-events** — central `actionAuditLog` collection-ből (S.10.5 Phase 4 prerekvizit)
- **Tab 3: ACL-backfill audit** — backfill_acl_phase2/3 run-history (CF execution log Better Stack-ből)

**Implementation**: Phase 3 (`actionAuditLog` collection-create UTÁN — S.10.5 dependency).

## S.10.2 — `organizationInviteHistory` retention

D.3 ADR 0011: default **forever**, admin-kérésre törölhető.

GDPR Art. 17 (right to erasure): user-törlés trigger-eli a `user-cascade-delete` CF-et, ami a user `invite-history` rekordjait is letörli (user-userId match alapján).

**Doku**: jelenlegi behavior elég.

## S.10.3 — `delete_my_account` GDPR-export (USER-TASK, legal review)

**Legal-Q**: GDPR Art. 20 (data portability) — kell-e proaktív vagy on-request?
- **Proaktív**: minden user delete-account flow ELŐTT ZIP-export
- **On-request**: csak request-re generálódik

**Dev-Q**: implement-now (~2-3 iter) vagy első request-re?

**Default**: USER-TASK design-decision. Legal review szükséges (`security@emago.hu` + jogi tanácsadó).

## S.10.4 — AttemptId tracking

Részletek: új jegyzet [Komponensek/AttemptIdTracking](AttemptIdTracking.md) — ADR 0011 follow-up.

## S.10.5 — Központi `actionAuditLog` collection (Phase 4 defer)

**Status**: ADR 0011 deferred "Audit completeness".

**Schema** (Phase 4 implementation):
```
Collection: actionAuditLog
  $id: <auto>
  userId: string(36) (caller)
  action: string(64) (pl. "remove_organization_member", "change_role")
  orgId: string(36) (scope)
  targetId: string(36) (érintett resource — user-id, doc-id)
  payload: JSON (sanitized — S.13.2 piiRedaction-szel)
  timestamp: datetime
  ip: string(45) (CF runtime-tól)
```

**Trigger**: minden mutating CF action (post-success). Plus retention policy (1 év minimum, CIS 8.3).

**Cost-impact**: minden CF write +1 audit-log write — perf-impact ~5-10%.

## S.10.6 — Záró

S.10 blokk **design-only Phase 3/4 trigger** — implementation USER-TASK legal review + Phase 4 schema-add.

## Kapcsolódó

- [[Feladatok#S.10]]
- [[Döntések/0011-cas-gate-and-orphan-guard-invariants]] (audit-completeness deferred)
- [[Komponensek/AttemptIdTracking]] (új, S.10.4)
- [[Komponensek/LoggingMonitoring]]
