---
tags: [terv, session-prompt, S-blokk, cross-tenant, design-only]
target: S.7.2b + 7.3 + 7.4 + 7.7d + 7.10 + 7.11 + 7.12 + 7.13
created: 2026-05-16
---

# Új session — S.7.x maradék (LOW, design-only)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

A MEDIUM/LOW blokk **utolsó iter**. S.7.x cross-tenant ACL maradék al-pontjai — **mind doku-szintű** vagy **USER-TASK**.

## Scope

### S.7.2b — `backfill_tenant_acl` éles run (USER-TASK)

`backfill_tenant_acl` + `backfill_admin_team_acl` minden orgon (dryRun → éles). USER-TASK Console-on vagy dashboard admin-UI-on (S.7.12 — most NEM-implementált).

### S.7.3 — Realtime channel filter audit

`realtimeBus.js` `subscribeRealtime()` audit — tenant-prefix-szűrés van-e? Doku-szintű.

### S.7.4 — Cross-org membership ACL

User több org-ban → Realtime payload-szűrés audit. **USER-TASK adversarial 2-tab** (S.7.5-höz hasonló).

### S.7.6 — Stop-time Codex review S.7.2-7.5 eredményeken

Záró Codex-pass, ha S.7.5 USER-TASK eredménye megvan.

### S.7.7d — Appwrite SDK major-version CI

Harden adversarial A5 follow-up. Phase 3 `.github/workflows/sdk-major-version-check.yml` vagy ACL-string regression unit-test. LOW prio.

### S.7.10 — `tryEnsureMembershipNonBlocking` DRY (Harden Simplify)

3 hívóhely (`invites.js:968, 1060, 1079`) közös helper. Code-only refactor, Phase 3.

### S.7.11 — `team_not_found` stringly-typed enum (Harden Simplify)

18+ literal hely a repo-ban. `TEAM_SKIP_REASONS` const export `teamHelpers.js`-ből. Code-only Phase 3.

### S.7.12 — Admin-UI `backfill_acl_phase2` szekvenciális run gomb (LOW prio)

Csak akkor build-eljük, ha admin-flow ténylegesen használja. Shell/curl alternatíva elég most.

### S.7.13 — Worldwide off-peak window policy (LOW, post-worldwide-deploy)

Per-tenant timezone-szerű maintenance-window. Phase 4+ (worldwide deploy után).

## Codex pre-review Q-k

**Q1**: S.7.5 USER-TASK adversarial 2-tab teszt — már a user-task-runbook-ban van (USER-TASK 3). Egyezik a S.7.4-gyel? Default: igen, kombinálni.

**Q2**: S.7.10 + S.7.11 code-only refactor — Phase 3 vagy most? Default: Phase 3, mert NEM-blocker.

**Q3**: S.7.13 worldwide off-peak: Maestro jelenlegi piac magyar-only (UTC+1). Decision: post-worldwide-deploy trigger.

## STOP feltételek

- S.7.x mind design-only — implementation Phase 3 + USER-TASK.

## Becsült időtartam

~20-30 perc (záró doku-update + S.7 status-flag minden al-pontra).

## MEDIUM/LOW blokk záró

A S.7.x iter UTÁN a Feladatok.md S szekció minden **autonóm-lefutható** al-pontja kész. STOP-condition (a) **teljesül a MEDIUM/LOW-ra**.

USER-TASK runbook + Phase 3+4 roadmap dokumentálva.

## Kapcsolódó

- [[Feladatok#S.7]]
- [[Komponensek/TenantIsolation]]
- [[Tervek/user-task-runbook]] (USER-TASK 3: adversarial 2-tab)
- [[Tervek/autonomous-session-loop]]
