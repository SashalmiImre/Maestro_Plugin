---
tags: [terv, session-prompt, S-blokk, dependency, supply-chain]
target: S.9
created: 2026-05-15
---

# Új session — S.9 Dependency + supply chain audit (MEDIUM, 1 session)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

CIS Controls 7 + 16. `yarn npm audit` futtatása minden workspace-en + critical/high vulnerability fix + Node EOL upgrade.

## Scope (5 al-pont)

### S.9.1 — `yarn npm audit --recursive` snapshot

```bash
cd /Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483
yarn npm audit --recursive --json > /tmp/maestro-audit-$(date +%Y%m%d).json
# Vagy human-readable:
yarn npm audit --recursive
```

Output → új jegyzet `_docs/Komponensek/DependencyAudit.md` snapshot (severity × count).

### S.9.2 — Critical/High vulnerability fix

- `yarn up <pkg>` minden critical/high-szintű vuln-re
- Lockfile review (`yarn.lock` diff)
- Test: `yarn build` minden package-en

### S.9.3 — Dependabot setup

- `.github/dependabot.yml` config
- Vagy `npm-audit-resolver` lokális tool

### S.9.4 — Node EOL upgrade

**Kritikus**: a Appwrite CF runtime jelenleg `node-18.0` (CF `functions_list` output). Node 18 EOL: **2025-04-30** — már 1 év óta unsupported.

Lépések:
1. Verify Appwrite Console > Functions > runtime-választó: `node-20` / `node-22` elérhető-e?
2. MCP `functions_update` `runtime: 'node-22.0'` minden 14 CF-en (batch)
3. Smoke teszt: a Plugin / Dashboard hívja a CF-et, working-e?

Plus a `package.json` `engines.node`: `>=20`.

### S.9.5 — Lock-file integrity CI

- GitHub Actions: `yarn install --frozen-lockfile` PR-on
- `yarn.lock` checksum check

## Codex pre-review Q-k

**Q1**: `node-18.0` → `node-22.0` upgrade — breaking change kockázat? A 14 CF mind dependency-libraryt (`node-appwrite`, `resend`, stb.) használ; minden lib Node 22-compatible?

**Q2**: A `yarn npm audit` futása ~1-2 perc (workspace-egész). A critical/high fix `yarn up` — lockfile-diff jelentős lehet.

**Q3**: Dependabot vs `npm-audit-resolver` vs manual: default Dependabot (free GitHub feature, PR-create automatic).

**Q4**: Lock-file integrity CI — új GitHub Action workflow (`yarn.lock` check) USER-TASK-ot is jelent (deploy permissions). Vagy halaszt Phase 3-ba?

## STOP feltételek

- `yarn npm audit` > 50 critical/high vuln → split: csak Top-10 fix az iterben.
- `node-18 → node-22` Appwrite-runtime NEM-elérhető → skip + flag.

## Becsült időtartam

~30-45 perc (audit + top-fix + node runtime upgrade + Dependabot config + Codex pipeline).

## Kapcsolódó

- [[Feladatok#S.9]]
- [[Komponensek/SecurityRiskRegister]] R.S.9.1+9.4
- [[Tervek/autonomous-session-loop]]
