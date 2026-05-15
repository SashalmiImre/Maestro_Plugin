---
tags: [terv, session-prompt, S-blokk, logging, info-disclosure, phase2]
target: S.13.3 Phase 2.0c
created: 2026-05-15
---

# Új session — S.13.3 Phase 2.0c user-cascade-delete CF wrap

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

Phase 2.0a (update-article) + Phase 2.0b (validate-publication-update) CLEAN. Phase 2.0c: a 3. demo CF — **`user-cascade-delete`**. ~6 leak.

## Scope (Phase 2.0c)

Ismert leak-ek `user-cascade-delete/src/main.js`-ben:
- Line 113: `return { found: 0, deleted: 0, failed: 1, error: err.message }` — belső helper return
- Line 215, 221, 227: `stats.listFailures.push({...error: err.message})` — `success: true` response stats array

### Implementációs minta (Phase 2.0a/b precedens)

1. **CommonJS port a CF-be** (`_generated_` prefix, 1:1 másolható update-article-ből):
   - `user-cascade-delete/src/_generated_piiRedaction.js`
   - `user-cascade-delete/src/_generated_responseHelpers.js`

2. **`main.js` wrap**:
   - require `_generated_piiRedaction.js` + `_generated_responseHelpers.js`
   - module.exports signature destructure `log: rawLog, error: rawError`
   - Body első 2 során PII-redaction wrap (spread minta)
   - 3 `stats.listFailures.push({...error: err.message})` → drop `.error` (mintát az `_generated_responseHelpers.js` `createRecordError` vagy manuálisan)
   - A line 113 belső helper return: domain-code `'team_membership_list_failed'`-szerű — backward-compat ellenőrzés a hívó-szempontjából

### Codex pre-review Q-k

**Q1**: A `stats.listFailures.push({...error: err.message})` 3 helyen — manuálisan drop, vagy `createRecordError` factory használat? Default: **manuálisan drop** (egyszerűbb, NEM kell stats refactor).

**Q2**: Line 113 belső helper return `{ found, deleted, failed, error: err.message }` — hol consume-olódik a hívó-oldalon? Audit kell-e?

**Q3**: A `module.exports = async ({ req, res, log, error }) =>` (arrow vs function) — a Phase 2.0a/b `async function`-t használ. Default: cseréljük arrow-ra, mert a CF kód ezt használja most. Megőriz egyszerűségben.

## STOP feltételek

- Codex 2 iter BLOCKER → split.

## Becsült időtartam

~20-30 perc.

## Phase 2.0c után — Phase 2.1 / 2.2

Phase 2.1: build-generator (S.7.7b precedens) + drift-guard + `wrapLogger(rawLog, rawError)` shared helper.
Phase 2.2: maradék 8+ CF (set-publication-root-path, resend-webhook, orphan-sweeper, cleanup-orphaned-locks, cleanup-rate-limits, cleanup-archived-workflows, migrate-legacy-paths, cascade-delete, validate-article-creation).

## Kapcsolódó

- [[Feladatok#S.13]]
- [[Komponensek/SecurityRiskRegister]] R.S.13.3 Phase 1.0+1.5+2.0a+2.0b
- [[Komponensek/LoggingMonitoring]]
- [[Tervek/autonomous-session-loop]]
