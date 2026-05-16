---
tags: [terv, session-prompt, S-blokk, logging, info-disclosure, phase2]
target: S.13.3 Phase 2
created: 2026-05-15
---

# Új session — S.13.3 Phase 2 maradék CF-ek info-disclosure (R.S.13.3 → Closed)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

A Phase 1.0+1.5 az `invite-to-organization` CF-et teljesen strip-elve (fail() + success body). Phase 2 a maradék 10-15 CF-et zárja le — előfeltétel az R.S.13.3 → Closed.

Risk register: **R.S.13.3** Phase 1.0+1.5 partial close (2026-05-15), Phase 2 zárja R.S.13.3-at.

## Scope (Phase 2)

10-15 maradék CF a Codex stop-time által explicit hivatkozott példákkal:
- `update-article/src/main.js:560-563`
- `validate-publication-update/src/main.js:706-709`
- `user-cascade-delete/src/main.js:211-227, 371-373`
- `set-publication-root-path/src/main.js`
- `resend-webhook/src/main.js`
- `orphan-sweeper/src/main.js`
- `cleanup-orphaned-locks/src/main.js`
- `cleanup-rate-limits/src/main.js`
- `cleanup-archived-workflows/src/main.js`
- `migrate-legacy-paths/src/main.js`
- `cascade-delete/src/main.js`
- `validate-article-creation/src/main.js`

### Implementációs stratégia

**Centralized helper-szintű minta** (preferált):

A `invite-to-organization`-ban már bizonyított `fail()` + `recordError` strip-minta KIEMELHETŐ shared modulba:

```
packages/maestro-shared/responseHelpers.js (ESM canonical):
- SENSITIVE_RESPONSE_FIELDS = new Set(['error', 'message', 'details', 'stack', 'cause'])
- stripSensitive(value, seen) — cycle-safe WeakSet, top + nested
- normalizeReason(reason) — REASON_REGEX = /^[A-Za-z0-9_]+$/
- fail(res, statusCode, reason, extra) — strip + redact + normalize
- okJson(res, body) — body-szintű strip (Phase 1.5 minta)
- recordErrorFactory(stats, maxErrors) — destructure-pattern + push
```

**Build-generator** (S.7.7b `compiledValidator` precedens):
- `scripts/build-cf-response-helpers.mjs` — kanonikus ESM → CommonJS inline-másolat minden CF-be
- Yarn script: `build:cf-response-helpers` + `check:cf-response-helpers` (drift-guard)

**Per-CF wrap** (~10-15 CF):
- Mind require-eli a `helpers/responseHelpers.js`-t
- A `fail()` callsite-okat helyettesíti a strip-elt verzióval
- A `res.json({ success: true, ... })` callsite-okat `okJson(res, ...)`-ra (vagy manuális strip)
- A `module.exports = async ({ req, res, log, error })` log/error S.13.2 Phase 2 wrap-elve (külön iter, vagy mostani Phase 2-ben kombinálva)

### Coverage-check script

Codex pre-review hivatkozott `scripts/check-cf-response-helpers.mjs`:
- Grep minden CF `main.js`-en: tilos `res.json({...error:`, `res.json({...message:`, raw `err.message`, `err.stack`
- Fail-el a CI-ben ha sérti
- Phase 2-ben kötelező

## Codex pre-review Q-k

**Q1**: Build-generator vs per-CF másolás?
Default: **build-generator** (12+ CF-re skalable, drift-guard automatikus).

**Q2**: Phase 2 kombinálás S.13.2 Phase 2 (PII-redaction log wrap) maradék CF-ekkel?
Default: **igen, mert ugyanazok a CF-ek és ugyanazon a `module.exports` signature-szintű wrap-on megy**. Egyetlen iterben mindkét aspect-et zárjuk.

**Q3**: `okJson(res, body)` helper minta — globális blacklist (jelenlegi recordError strip-pattern) vs per-action response contract (Codex adversarial #A2/A6)?
Default: **globális blacklist** Phase 2-ben (egyezik a recordError mintával), és **per-action contract** a Phase 3-ban (ha valaha is). A jelenlegi `customMessage` user-intent mező egyetlen action-ben — egyedi exception-keezhető.

**Q4**: Backward-compat: a Phase 2-ben a 12+ CF response-shape változatlan-e? A frontend `_handleCFError` továbbra is `response.reason`-t használ?
Default: **igen, response-shape változatlan** (csak a sensitive mezők strip-elve).

**Q5**: A `_finalizeOrgIfProvisioning`-szerű 2-distinctive-domain-code minta (`finalize_precheck_failed` vs `finalize_status_update_failed`) — a más CF-ekben is hasonló logika kell-e? Default: igen, ha az ops-team tényleg meg tudja különböztetni a recovery-flow-t.

## STOP feltételek

- Phase 2 audit > 90 perc → split CF-csoportokra (3-5 CF / iter).
- Backward-compat törő change → user-task flag.
- Build-generator drift-guard CI integration → user-decision needed.

## Becsült időtartam

~60-90 perc (shared responseHelpers.js + build-generator + 12+ CF wrap + coverage-check + Codex pipeline + /harden).

## Kapcsolódó

- [[Feladatok#S.13]]
- [[Komponensek/SecurityRiskRegister]] R.S.13.3 Phase 1.0+1.5 partial close → Phase 2 closed
- [[Komponensek/LoggingMonitoring]] S.13.3 Phase 1.0 + 1.5 + 2 spec
- [[Tervek/autonomous-session-loop]]
- S.13.2 Phase 2 (PII-redaction maradék CF wrap) — érdemes kombinálni
