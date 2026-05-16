---
tags: [terv, session-prompt, S-blokk, logging, pii]
target: S.13.2
created: 2026-05-15
---

# Új session — S.13.2 PII-redaction `log()` helper bővítés (R.S.13.2 close)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

A `log()` / `logError()` / `logWarn()` / `logDebug()` helper-ek PII-redaction-ja: email-maszkolás (`f**@example.com`), token-elhúzás (`...8d5f`), session-id-cut (csak első 8 char). Cél: ne kerüljön production-logba (Appwrite CF execution logs, Railway proxy logs) raw email, raw bearer token, raw session-id.

Risk register: **R.S.13.2 (HIGH)** — `log()` helper nincs PII-redaction. ASVS V7 + CIS Controls 8.

## Scope (S.13.2)

3 csomag érintett:
- `packages/maestro-server/functions/*/src/utils.js` (CF-szintű `log` definíciók — több function-ben másolt)
- `packages/maestro-dashboard/src/utils/logger.js` vagy `console.*` policy-elfogadott CLAUDE.md alapján — dashboard tényleges `log()` használata megtekintés
- `packages/maestro-indesign/src/utils/logger.js` — Plugin-oldali

### Implementációs minta

1. **Új helper modul**: `packages/maestro-shared/src/piiRedaction.js` (vagy egy adott csomagban, ha shared-import komplex):
   - `redactEmail(str)`: email-maszkolás (`f**@example.com`)
   - `redactToken(str)`: token-elhúzás (csak utolsó 4 char)
   - `redactSessionId(str)`: csak első 8 char
   - `redactObject(obj)`: rekurzív redaction-pass egy log-object-en (smart-detect: email-pattern, JWT-pattern stb.)

2. **Bővítés a 3 `log()` helper-en**: minden message + extra-object átfut a `redactObject`-en mielőtt console.log/console.error-re kerül.

3. **Opt-out flag**: `LOG_REDACT_DISABLE=true` env var dev-flow-hoz (full visibility a fejlesztő számára).

### CF deploy considerations

A CF helper-ek minden function-ben másolt (`utils.js`). Build-time generator pattern (S.7.7b `compiledValidator` precedens) használható, vagy direkt másolás 6-7 function `utils.js`-be (DRY-violation, de pragmatic).

Default: **építsünk shared-szintű piiRedaction.js-t** (maestro-shared/src) + a build-cf-validator.mjs mintán **CommonJS compile + post-transform a CF-be**. Vagy egyszerűbb: per-function `utils.js` patch (másolás).

## Codex pre-review Q-k

**Q1**: Build-time generator (S.7.7b precedens) vagy per-function másolás a piiRedaction-höz?
Default: **build-time generator** (DRY + jövőbeli changes egy helyen), de a most ezt overkill, mert csak ~20 sor kód. Megfontolandó.

**Q2**: A `redactObject` rekurzív depth-limit?
Default: **3-szintű depth + lazy bail-out** (circular reference detection, max 100 key per level).

**Q3**: Email-maszkolás minta?
- `local_first_letter + '***' + '@' + domain` — `f***@example.com`
Default: **igen, ez konzisztens RFC 5321-szel + a maintainer könnyen felismeri**.

**Q4**: Token-elhúzás: full-redact vs last-4?
- last-4 (debug-friendly, last 4 char felismerhető a Console-on)
Default: **last-4** (a 7474619 incident utolsó-4 jelölte fel a leaked key-t — a kompromisszum-azonosítás minimum-érték).

**Q5**: Test stratégia?
- Egy `piiRedaction.test.js` (vitest/jest) — vagy csak inline assert-ek + manual review?
Default: **inline assert-ek** (a projekt-nek nincs frontend test framework, build-CF-validator pattern szintén skip-eli).

**Q6**: `LOG_REDACT_DISABLE` env var dev-flow?
- Veszélyes: prod-flow-ban ha véletlenül true-ra állítódik, a redaction kikapcsol.
Default: **igen, de explicit `process.env.NODE_ENV !== 'production'` guard a CF + dashboard-on**. Plugin-on UXP-environment-flag (`__DEV__`).

## STOP feltételek

- R.S.13.2 + R.S.13.3 HIGH együtt egy iterációban → ha S.13.2 már >60 perc, S.13.3 külön iterációba.
- Plugin (UXP) `process.env.NODE_ENV` NEM elérhető → környezet-flag más mintán (webpack DefinePlugin-szerű).

## Becsült időtartam

~45-60 perc (shared helper + 3 csomag-szintű wire + opt-out flag + Codex pipeline + /harden).

## Kapcsolódó

- [[Feladatok#S.13]]
- [[Komponensek/SecurityRiskRegister]] R.S.13.2 HIGH
- [[Tervek/autonomous-session-loop]]
- [[Komponensek/LoggingMonitoring]] (placeholder, S.13 zárókor töltjük)
