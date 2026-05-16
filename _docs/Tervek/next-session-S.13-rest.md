---
tags: [terv, session-prompt, S-blokk, logging, monitoring]
target: S.13.1 + S.13.4 + S.13.5 + S.13.7
created: 2026-05-15
---

# Új session — S.13 maradék: monitoring + retention + Codex záró

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

Az S.13 maradék 4 al-pontja — mind **design-szintű** vagy **doku-szintű**, NEM-kód-implement.

## Scope

### S.13.1 — Central log aggregation tervezés

Sentry / Better Stack / Grafana Loki — döntés. **Trigger**: első incident vagy compliance-kérés.

**Doku**: `_docs/Komponensek/LoggingMonitoring.md` bővítés:
- Tool-comparison (Sentry vs Better Stack vs Loki)
- Integration cost-estimate
- Decision-criteria (cost, retention, alerting features)

### S.13.4 — Monitoring alertek tervezése

Alert-typesek:
- CF failure rate (>5% / 5 perc → PagerDuty / Slack)
- WebSocket disconnect rate (Appwrite Realtime drop > threshold)
- Rate-limit trigger spike (`ipRateLimitBlocks` write-rate)
- Login-fail spike (Appwrite Console > Auth audit log)

**Doku**: `_docs/Komponensek/MonitoringAlerts.md` (új jegyzet) — alert-spec táblázat (trigger, threshold, action, channel).

**Implementation**: csak akkor, ha S.13.1 már döntés-szintű (Sentry / Better Stack natívan támogatja az alert-rule-okat).

### S.13.5 — Audit-log retention CIS 8.3

CIS Controls 8.3: minimum 90 nap (ASVS L2 elegendő). Verify:
- **Appwrite Cloud** retention: free tier vs paid tier — Console docs alapján
- **Railway proxy** logs: Railway dashboard > Logs > retention setting

**Doku**: `_docs/Komponensek/LoggingMonitoring.md` "Retention" szekció.

### S.13.7 — Stop-time Codex review

Az S.13 teljes blokk lezárása (S.13.2, 13.3 már Closed). Stop-time + final docs.

## Codex pre-review Q-k

**Q1**: S.13.1 tool-decision: Sentry vs Better Stack vs Grafana Loki. Maestro use-case (~10-50 user, ~1000-5000 req/day): költségérzékenység domináns? Default **Better Stack** (free tier elég, EU-data-residency).

**Q2**: S.13.4 alert-threshold-ok: hány false-positive elfogadható havi szinten? Default: max 2 (különben alert-fatigue).

**Q3**: S.13.5 Appwrite Cloud retention: a free tier 30 nap default. Paid tier custom. CIS 8.3 minimum 90 nap — szükséges-e paid-upgrade?

## STOP feltételek

- S.13.1 tool-decision DESIGN-Q user-bevonás → flag.
- S.13.5 Appwrite paid-upgrade DESIGN-Q → flag.

## Becsült időtartam

~30 perc (doku-szintű, csak 2 új jegyzet + LoggingMonitoring bővítés).

## Kapcsolódó

- [[Feladatok#S.13]]
- [[Komponensek/LoggingMonitoring]] S.13.2+13.3 már Closed
- [[Tervek/autonomous-session-loop]]
