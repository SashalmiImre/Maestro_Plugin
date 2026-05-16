---
tags: [terv, session-prompt, S-blokk, logging, info-disclosure, phase2]
target: S.13.3 Phase 2.0b
created: 2026-05-15
---

# Új session — S.13.3 Phase 2.0b validate-publication-update CF wrap

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

Phase 2.0a-ban a shared `maestro-shared/responseHelpers.js` ESM canonical + `update-article` CF wrap CLEAN. Phase 2.0b: a **`validate-publication-update`** CF ugyanazon a mintán wrap-elése.

A Phase 2 maradék 11+ CF közül a leak-jelentős sorrend (a Codex hivatkozott példák alapján):
1. ✅ `update-article` (Phase 2.0a, 2026-05-15)
2. **→ `validate-publication-update`** (Phase 2.0b — most)
3. `user-cascade-delete` (Phase 2.0c)
4. Maradék 9 CF (Phase 2.1 + 2.2)

## Scope (Phase 2.0b)

3 ismert leak `validate-publication-update/src/main.js`-ben:
- Line 370: `return res.json({ success: false, reason: 'membership_lookup_failed', error: e.message }, 500)`
- Line 697-709: catch ág raw `err.message` + `err.stack`

### Implementációs minta (Phase 2.0a precedens)

1. **CommonJS port a CF-be** (`_generated_` prefix):
   - `validate-publication-update/src/_generated_piiRedaction.js` (CommonJS port a kanonikus `maestro-shared/piiRedaction.js`-ből)
   - `validate-publication-update/src/_generated_responseHelpers.js` (CommonJS port a kanonikus `maestro-shared/responseHelpers.js`-ből)

2. **main.js wrap**:
   - require `./_generated_piiRedaction.js` (`redactArgs`, `isRedactionDisabled`)
   - require `./_generated_responseHelpers.js` (`fail`)
   - module.exports signature destructure `log: rawLog, error: rawError`
   - Body első 2 során PII-redaction wrap (spread minta)
   - Inline `fail()` cseréje a shared `fail()`-re (HA van inline)
   - Line 370 `error: e.message` → strip-elve a shared `fail()`-szinten
   - Line 697-709 catch ág `res.json({...message: err.message})` → `fail(res, 500, 'internal_error', { executionId })`

## Codex pre-review Q-k

**Q1**: A `validate-publication-update` CF inline `fail()` helper-rel rendelkezik-e? (Audit `function fail`-mintára.) Ha igen, cserélni a shared importtal.

**Q2**: A line 370 `membership_lookup_failed`-flow — backward-compat: a frontend specifikus `error: e.message`-et használ-e? Default: NEM (csak `reason`-t), tehát a strip biztonságos.

**Q3**: Phase 2.0c (`user-cascade-delete`) érdemes-e ugyanezzel az iter-rel kombinálni?
Default: **NEM** — context-window-takarékos, Phase 2.0c külön iter.

## STOP feltételek

- Codex 2 iter BLOCKER → split.
- Per-CF wrap > 30 perc → halaszt.

## Becsült időtartam

~30-45 perc (CommonJS port + main.js wrap + Codex pipeline + /harden + docs + commit).

## Kapcsolódó

- [[Feladatok#S.13]]
- [[Komponensek/SecurityRiskRegister]] R.S.13.3 Phase 1.0+1.5+2.0a partial close
- [[Komponensek/LoggingMonitoring]] Phase 2.0a + 2.0b/c + 2.1 + 2.2 spec
- [[Tervek/autonomous-session-loop]]
