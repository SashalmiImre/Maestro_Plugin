---
tags: [terv, session-prompt, S-blokk, dns, dr, recovery]
target: S.11
created: 2026-05-16
---

# Új session — S.11 DNS CAA + DR + Recovery-runbook (LOW)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

CIS Controls 11 — Disaster Recovery + DNS hardening. **Mind doku-szintű** vagy **USER-TASK** (registrar-akció).

## Scope (6 al-pont)

### S.11.1 — DNS CAA record (USER-TASK)

**Registrar action**: `emago.hu` DNS panel → CAA record add:
```
emago.hu. CAA 0 issue "letsencrypt.org"
```

Megakadályozza, hogy bármely más CA (pl. attacker-controlled) SSL cert-et issue-eljen az `emago.hu`-ra.

### S.11.2 — DNSSEC enable (USER-TASK)

`emago.hu` registrar-függő (Magyar Telekom / NIC.hu) DNSSEC support — kell-e/lehet-e enable-elni?

### S.11.3 — Appwrite Cloud backup policy

**Doku**: új jegyzet `_docs/Komponensek/DRPlan.md` — Appwrite Cloud auto-backup policy (Free vs Pro), restore-procedure.

### S.11.4 — Failover dokumentáció

ADR 0001 listáz: Railway primary → emago.hu fallback. **Verify**: a fallback ténylegesen működik-e? Manual test: Railway block-olva → plugin emago.hu-on át hív-e?

### S.11.5 — Recovery-runbook

Új jegyzet `_docs/Komponensek/RecoveryRunbook.md`:
- **Key-rotation incident** (S.5 precedens — leaked key)
- **Secret-leak incident** (git filter-repo)
- **DB restore** (Appwrite Cloud snapshot → restore)
- **Last-owner-orphan recovery** (`transfer_orphaned_org_ownership` CF action)

### S.11.6 — Stop-time Codex review

## Codex pre-review Q-k

**Q1**: S.11.1 CAA record — USER-TASK explicit, registrar-szintű. Flag.

**Q2**: S.11.3 Appwrite Cloud backup — Free tier backup-policy mit ad? Pro tier custom?

**Q3**: S.11.4 failover-test design-szintű vagy manual-test runbook?

## STOP feltételek

- S.11.1+11.2 USER-TASK (registrar) → flag.
- S.11.3+11.4+11.5 doku-szintű — implementation kockázat-mentes.

## Becsült időtartam

~30 perc (3 új jegyzet: DRPlan.md + RecoveryRunbook.md, plus S.11.1+11.2 USER-TASK flag).

## Kapcsolódó

- [[Feladatok#S.11]]
- [[Döntések/0001-dual-proxy-failover]]
- [[Tervek/user-task-runbook]] (S.11.1+11.2 hozzáadás)
