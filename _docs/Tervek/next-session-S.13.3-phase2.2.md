---
tags: [terv, session-prompt, S-blokk, logging, info-disclosure, phase2]
target: S.13.3 Phase 2.2
created: 2026-05-15
---

# Új session — S.13.3 Phase 2.2 maradék CF wrap (R.S.13.3 → Closed)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

Phase 2.1 build-generator + `wrapLogger` shared helper kész. Phase 2.2: a maradék 9+ CF wrap-elése (R.S.13.3 → Closed prerekvizit).

## Scope (Phase 2.2)

A `scripts/build-cf-response-helpers.mjs` `TARGET_CFS` array-be hozzáadandó:
- `set-publication-root-path`
- `resend-webhook`
- `orphan-sweeper`
- `cleanup-orphaned-locks`
- `cleanup-rate-limits`
- `cleanup-archived-workflows`
- `migrate-legacy-paths`
- `cascade-delete`
- `validate-article-creation`

Plus: az invite-to-organization CF MÁR rendelkezik `helpers/util.js` `fail()` + `helpers/piiRedaction.js` inline-portolt másolatokkal. Phase 2.2-ben **NEM** porteljük át a build-generator-re (Phase 2.0a precedens-szerint: out-of-scope, későbbi refactor). De érdemes a maradék 9+ CF-en a Phase 2.0a/b/c minta-replikálás (1-soros wrapLogger + main.js wrap + minimal leak fix).

### Implementációs lépések / CF

1. **CF nevet hozzáadás `TARGET_CFS` array-be** (scripts/build-cf-response-helpers.mjs)
2. **`yarn build:cf-response-helpers`** → 2 új `_generated_*.js` a CF-ben
3. **main.js wrap (1-soros)**:
   ```javascript
   const { wrapLogger } = require('./_generated_piiRedaction.js');
   const { fail } = require('./_generated_responseHelpers.js');
   
   module.exports = async ({ req, res, log: rawLog, error: rawError }) => {
       const { log, error } = wrapLogger(rawLog, rawError);
       // ... existing logic ...
   };
   ```
4. **Audit leak-eket** (Phase 2.0a/b/c minta-szerint: `err.message` / `err.stack` / `stats.errors.push` etc.):
   - `res.json({...error: err.message})` → `fail(res, code, reason, { executionId })`
   - `stats.X.push({...error: err.message})` → drop `.error`
5. **Codex stop-time / drift-check**: `yarn check:cf-response-helpers` (drift-guard) + Codex review per-CF vagy batch.

### CI integration (Phase 2.1 Codex follow-up)

- `.github/workflows/cf-response-helpers-drift.yml` (vagy hasonló): `yarn check:cf-response-helpers` minden PR-en
- Pre-commit hook (husky): `yarn check:cf-response-helpers` minden commit előtt
- Auto-discovery TARGET_CFS (manifest-driven vagy glob `packages/maestro-server/functions/*/src/main.js`)

Default a Phase 2.2-ben: **CI integration GitHub Actions-szel** (1 új workflow-fájl), pre-commit hook user-decision.

## Codex pre-review Q-k

**Q1**: Batch (9 CF egyszerre) vs egy-CF-per-iter?
Default: **batch** — a wrap-minta egyszerű, a build-generator + minimal leak audit ~10 perc/CF.

**Q2**: Coverage-check script (`scripts/check-cf-log-wrap.mjs`)?
- Grep minden CF main.js: tilos `module.exports = async ({ ..., log, error })` (NEM destructure-elt log/error)
- Fail-el a CI-ben
Default: **igen Phase 2.2-ben** (3 CF demo bizonyítja, hogy a minta egyértelmű).

**Q3**: `invite-to-organization` CF refactor (Phase 1.0+1.5 inline `helpers/util.js fail()` → shared importtal)?
Default: **NEM Phase 2.2-ben** — túl nagy scope, későbbi külön iter. A `invite-to-organization` jelenleg `fail()`-szintű strip-pel működik, NEM regression-risk.

## STOP feltételek

- Phase 2.2 audit > 90 perc → split (3-CF batch-ekre).
- CI workflow YAML user-decision (deploy permissions).

## Becsült időtartam

~60-90 perc (9 CF × ~10 perc + CI workflow + coverage-check script + Codex pipeline + /harden + docs + commit).

## Phase 2.2 utáni state — R.S.13.3 Closed

A Phase 2.2 zárása után az **R.S.13.2 + R.S.13.3 → Closed** (10+ CF + Plugin teljesen wrap-elve). STOP-condition (a) **teljesül** a Feladatok.md S szekció HIGH-prio Open al-pontjaira.

Maradék MEDIUM/LOW (NEM STOP-blocker):
- S.6 UXP plugin sandbox, S.8 Webhook trust, S.9 dependency audit, S.10 admin audit-view, S.11 DNS CAA, S.12.3/12.5/12.6 audit-szerű al-pontok, S.13.4 monitoring alerts, S.13.5 retention verify

## Kapcsolódó

- [[Feladatok#S.13]]
- [[Komponensek/SecurityRiskRegister]] R.S.13.3 Phase 1.0+1.5+2.0a/b/c+2.1
- [[Komponensek/LoggingMonitoring]]
- [[Tervek/autonomous-session-loop]]
- S.7.7b precedens: `scripts/build-cf-validator.mjs`
