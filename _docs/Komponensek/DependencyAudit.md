---
tags: [komponens, dependency, supply-chain, audit]
related:
  - "[[Komponensek/SecurityBaseline]]"
  - "[[Komponensek/SecurityRiskRegister]]"
---

# DependencyAudit — `yarn audit` snapshot + monitoring policy

## 2026-05-15 audit (S.9 close)

### Snapshot

```bash
yarn audit
# Packages audited: 470
# 0 vulnerabilities found  ✅
```

### Pre-fix állapot

| Severity | Count | Package | Path |
|---|---|---|---|
| High | 1 | `path-to-regexp <0.1.13` | `maestro-cors-proxy > express > path-to-regexp` |
| High | 1 | `picomatch <2.3.2` (ReDoS extglob) | `maestro-cors-proxy > http-proxy-middleware > micromatch > picomatch` |
| Moderate | 1 | `picomatch <2.3.2` (POSIX method injection) | (same path) |
| Moderate | 1 | `follow-redirects <=1.15.11` (custom auth header leak) | `maestro-cors-proxy > http-proxy-middleware > http-proxy > follow-redirects` |

Mind a 4 a **maestro-cors-proxy transitive** deps-en. Saját kód NEM-érintett.

### Fix — `resolutions` mező (yarn 1.x force-bump)

`package.json` workspace-root:
```json
"resolutions": {
    "path-to-regexp": "0.1.13",
    "picomatch": "^2.3.2",
    "follow-redirects": "^1.16.0"
}
```

**Verzió-pin minta** (Codex BLOCKER fix 2026-05-16):
- **`path-to-regexp: "0.1.13"` exact** — a `>=0.1.13` minta silent major-bump-ot okozott (`path-to-regexp@8.4.2`-re), Express 4 NEM-kompatibilis (`TypeError: pathRegexp is not a function`)
- **`picomatch: "^2.3.2"` major-bounded** — csak 2.x szériák auto-bump (3.0+ blokkolt)
- **`follow-redirects: "^1.16.0"` major-bounded** — csak 1.x szériák

`yarn install` regenerálja a lockfile-t → `yarn audit` 0 vuln.

**Tanulság**: a yarn 1.x `resolutions` mezőben a `>=X.Y.Z` minta NEM-major-blokkoló — caret `^X.Y.Z` vagy exact-pin kell ahhoz, hogy a major-jump elkerülhető legyen.

## Monitoring policy

### Dependabot (S.9.3 close)

`.github/dependabot.yml` — heti scan (hétfő 06:00 Europe/Budapest):
- Yarn root: minor+patch group, max 10 PR
- Per-package (Dashboard / Plugin / Proxy): külön config, max 5 PR
- GitHub Actions: workflow-deps audit

Major-version manual review.

### Engine constraint (S.9.4 partial)

`"engines": { "node": ">=20.0.0" }` — Node 18 EOL **2025-04-30**.

### Appwrite CF runtime upgrade (S.9.4 USER-TASK)

A 14 production-CF jelenleg `runtime: "node-18.0"`. USER-TASK Console-on: `node-20.0` vagy `node-22.0` verify + update + redeploy + smoke teszt.

## Lock-file integrity CI (S.9.5 Phase 3)

Halasztva: `.github/workflows/lockfile-integrity.yml` `yarn install --frozen-lockfile` PR-on. USER-TASK deploy-permissions.

## Re-audit cadence

- **Heti**: Dependabot auto-scan
- **Major-release**: manual `yarn audit` + snapshot update
- **Incident**: kritikus CVE-re manual `yarn audit --level critical`

## Kapcsolódó

- [[Feladatok#S.9]]
- [[Komponensek/SecurityRiskRegister]] R.S.9.1+R.S.9.4
- [[Tervek/user-task-runbook]] S.9.4 Appwrite CF runtime upgrade
