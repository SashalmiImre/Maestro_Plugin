---
tags: [terv, session-prompt, S-blokk, logging, info-disclosure, phase2, build-generator]
target: S.13.3 Phase 2.1
created: 2026-05-15
---

# Új session — S.13.3 Phase 2.1 build-generator + drift-guard + wrapLogger helper

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

Phase 2.0a/b/c-ben 3 demo CF wrap kész (`update-article`, `validate-publication-update`, `user-cascade-delete`). A 3 CF MIND identikus `_generated_piiRedaction.js` + `_generated_responseHelpers.js` CommonJS portolt másolattal rendelkezik. Phase 2.1: **automatizálni a portolást build-generator-rel** + drift-guard CI integration, hogy a maradék 8+ CF wrap minimum-effort-tal lefedhető.

## Scope (Phase 2.1)

### Build-generator script

`scripts/build-cf-response-helpers.mjs` — S.7.7b `build-cf-validator.mjs` precedens-szerű mintán:
- Source: `packages/maestro-shared/piiRedaction.js` + `packages/maestro-shared/responseHelpers.js` (ESM canonical)
- Transform: ESM → CommonJS (`export function ...` → `function ...; module.exports = {...}`)
- Output: minden CF-be `src/_generated_piiRedaction.js` + `src/_generated_responseHelpers.js`

Yarn scripts:
- `build:cf-response-helpers` — full generation
- `check:cf-response-helpers` — drift-guard (összehasonlítja a generated vs current, fail-el ha különbség van)

### `wrapLogger(rawLog, rawError)` shared helper

A 3 demo CF mind ugyanazt a wrap-pattern-t használja:
```javascript
const log = (...args) => isRedactionDisabled() ? rawLog(...args) : rawLog(...redactArgs(args));
const error = (...args) => isRedactionDisabled() ? rawError(...args) : rawError(...redactArgs(args));
```

Centralized minta:
```javascript
// _generated_piiRedaction.js (kibővítve):
function wrapLogger(rawLog, rawError) {
    if (isRedactionDisabled()) {
        return { log: rawLog, error: rawError };
    }
    return {
        log: (...args) => rawLog(...redactArgs(args)),
        error: (...args) => rawError(...redactArgs(args))
    };
}
```

CF main.js wrap egyszerűbb:
```javascript
const { wrapLogger } = require('./_generated_piiRedaction.js');
module.exports = async ({ req, res, log: rawLog, error: rawError }) => {
    const { log, error } = wrapLogger(rawLog, rawError);
    // ...
};
```

### CI integration (opcionális Phase 2.1-ben)

- `.github/workflows/cf-response-helpers-drift.yml` (vagy hasonló) — fail-el ha drift van
- `scripts/check-cf-log-wrap.mjs` — coverage script: minden CF main.js-en raw `log`/`error` használat (NEM wrap-elt) → fail

## Codex pre-review Q-k

**Q1**: ESM → CommonJS transform automatizálás:
- AST-based (acorn / @babel/parser) — robusztus, complex
- Regex-based (sed-szerű) — egyszerűbb, fragile
Default: **regex-based** (a S.7.7b precedens ezt csinálja a `compiledValidator`-ral).

**Q2**: CF-list source:
- Glob `packages/maestro-server/functions/*/src/main.js` — auto-detect
- Manual list (a target CF-eknek)
Default: **auto-detect**, és az opt-out (NEM-wrap-elt CF-ek) explicit `.maestro-skip-wrap`-style file-jelölővel.

**Q3**: Drift-guard CI vs local-only?
- Local-only: `yarn check:cf-response-helpers` pre-commit hook-ban
- CI integration: GitHub Actions
Default: **local-only Phase 2.1-ben**, CI Phase 2.2-ben.

**Q4**: `wrapLogger` mintával a 3 demo CF már wrap-elve — refaktor érdemes?
Default: **igen**, konzisztencia + DRY.

## STOP feltételek

- Build-generator > 60 perc → split (script + integration külön iter).
- AST/regex transform-bug → user-decision (Phase 2.2 manuálisan).

## Becsült időtartam

~45-60 perc (build-generator script + wrapLogger bevezetés + 3 demo CF refactor + Codex pipeline + /harden).

## Phase 2.2 utáni roadmap

A Phase 2.1 build-generator után a Phase 2.2 trivialisan végezhető: `yarn build:cf-response-helpers` minden CF-en automatikusan generál + main.js manuális 5-soros wrap. ~10 CF × ~5 perc = ~50 perc.

Plus a `permissionDenied()` bypass (Phase 2.0a hidden risk) + `success: true` body audit + dynamic reason normalize a `fail()`-szinten — Phase 2.2 + 2.3 closer.

## Kapcsolódó

- [[Feladatok#S.13]]
- [[Komponensek/SecurityRiskRegister]] R.S.13.3 Phase 1.0+1.5+2.0a+2.0b+2.0c
- [[Komponensek/LoggingMonitoring]]
- [[Tervek/autonomous-session-loop]]
- S.7.7b precedens: `scripts/build-cf-validator.mjs` — ugyanaz a minta
