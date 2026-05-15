---
tags: [terv, session-prompt, S-blokk, admin-audit, audit-trail]
target: S.10
created: 2026-05-16
---

# Új session — S.10 admin audit-view (LOW, 1 session)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

ASVS V7 + CIS Controls 8. Admin-oldali audit-view + retention policy + AttemptID tracking doku.

## Scope (6 al-pont)

### S.10.1 — Admin audit-view UI

**Frontend**: új `/settings/organization/audit` route a Dashboard-on. Tartalmazza:
- Meghívási history (`organizationInviteHistory` collection)
- Member-removal events (audit-trail D.3 ADR 0011)
- Role-change events (`change_organization_member_role` CF)

**Doku**: design-szintű, implementation Phase 3.

### S.10.2 — `organizationInviteHistory` retention policy

D.3.4 hivatkozott: default forever, admin-kérésre törölhető. Doku-szintű.

### S.10.3 — `delete_my_account` GDPR-export

**Legal-Q**: GDPR Art. 20 (data portability) — kell-e prokvasen vagy on-request elég?
**Dev-ready-Q**: implement-now vs első request-re?

**Default**: USER-TASK design-decision (legal review szükséges).

### S.10.4 — `attemptId` tracking dokumentáció

ADR 0011 follow-up — új jegyzet `_docs/Komponensek/AttemptIdTracking.md`.

### S.10.5 — Központi `actionAuditLog` collection

Phase 4 defer (ADR 0011 deferred "Audit completeness").

### S.10.6 — Stop-time Codex review + új jegyzet `AuditTrail.md`

## Codex pre-review Q-k

**Q1**: S.10.1 admin audit-view CSAK design-szintű, vagy MVP implementation?
Default: **design-only** (LOW prio, NEM-business-blocker).

**Q2**: S.10.3 GDPR-export legal review USER-TASK?
Default: **igen**, legal-Q user-bevonás.

**Q3**: S.10.5 actionAuditLog Phase 4 defer indok: jelenleg az audit elszórva (organizationInviteHistory, role-change-log) — centralizáció jelentős kód-add.

## STOP feltételek

- S.10.3 legal-Q DESIGN-Q → flag.
- S.10.5 actionAuditLog Phase 4 defer.

## Becsült időtartam

~30 perc (doku-szintű, 2 új jegyzet).

## Kapcsolódó

- [[Feladatok#S.10]]
- [[Döntések/0011-cas-gate-and-orphan-guard-invariants]] (audit-completeness deferred)
- [[Tervek/autonomous-session-loop]]
