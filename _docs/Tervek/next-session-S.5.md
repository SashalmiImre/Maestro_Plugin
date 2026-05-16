---
tags: [terv, session-prompt, S-blokk, secrets]
target: S.5
created: 2026-05-15
---

# Új session — S.5 Secrets rotation (R.S.5.1 + R.S.5.3, HIGH→CRITICAL conditional)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

**R.S.5.1 close**: git secret-scan futás (gitleaks vagy trufflehog) a teljes history-n. Ha találunk: **CRITICAL escalation** + rotation runbook.

**R.S.5.3 close**: Appwrite API key rotation policy dokumentálva.

## Phase 1 — Git secret-scan (R.S.5.1)

```bash
# Telepítés (ha nincs)
brew install gitleaks  # vagy curl install

# Scan a teljes history-n
gitleaks detect --source . --report-format json --report-path .gitleaks-report.json

# Ha találunk → CRITICAL
# Ha nem → R.S.5.1 close + .gitleaks.toml config rögzítés (CI integráció későbbi al-pont S.9-en)
```

## Phase 2 — Rotation policy (R.S.5.3)

`_docs/Komponensek/SecretsRotation.md` új komponens-jegyzet:
- Appwrite API key: 90 napos rotation, manuális (Appwrite Console)
- Resend API key: 180 napos (Resend Console)
- Railway env vars: 90 napos
- Webhook secret (`RESEND_WEBHOOK_SECRET`): 365 napos
- Calendar reminder: admin per-quarter
- Incident-rotation procedure: ha leak / compromise → azonnali rotation + Appwrite Console + Vercel + Railway secret-update

## Codex pre-review Q-k

**Q1**: gitleaks vagy trufflehog?
Default: **gitleaks** (gyorsabb, kevesebb false-positive).

**Q2**: A scan-eredményt commit-oljuk-e a repó-ba?
Default: **NEM** — gitleaks-report.json a `.gitignore`-on. Csak summary a daily note-ban.

**Q3**: Ha find: incident response runbook követés?
Default: **GO** — `_docs/Komponensek/IncidentResponse.md` új komponens-jegyzet vagy S.0 SecurityBaseline bővítés.

## STOP feltételek

- **CRITICAL secret-leak find**: STOP iter + USER-DECISION + immediate rotation.

## Becsült időtartam

- Secret-scan: ~5-10 perc (gitleaks fast).
- Rotation policy doku: ~30 perc.
- Total: ~35-45 perc.

## Kapcsolódó

- [[Feladatok#S.5]]
- [[Komponensek/SecurityRiskRegister]] R.S.5.1 + R.S.5.3
- [[Tervek/autonomous-session-loop]]
