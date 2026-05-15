---
tags: [terv, session-prompt, S-blokk, logging, info-disclosure]
target: S.13.3
created: 2026-05-15
---

# Új session — S.13.3 Error message info-disclosure audit (R.S.13.3 close)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

Audit + fix minden CF action-handler `try/catch`-jében: mi kerül a `res.json` body-jába kliens felé. Defense-in-depth: csak code-os error (`reason: 'misconfigured'` / `'forbidden'` / `'not_found'`), NEM raw `err.message` (ami a stack-trace, internal path, SDK debug-info, és potenciálisan PII-t is tartalmazhat).

Risk register: **R.S.13.3 (HIGH)** — CF error → kliens info-disclosure. ASVS V7 + V13.

## Scope (S.13.3)

A jelenlegi minta legalább 1 helyen visszaad raw `err.message`-et:

```javascript
// packages/maestro-server/functions/invite-to-organization/src/main.js
} catch (err) {
    error(`Function hiba: ${err.message}`);
    error(`Stack: ${err.stack}`);
    return res.json({ success: false, error: err.message }, 500);
}
```

A teljes audit:
1. **Audit minden CF main.js + action-handler try/catch-ek**:
   - `packages/maestro-server/functions/*/src/main.js` top-level catch
   - `packages/maestro-server/functions/invite-to-organization/src/actions/*.js` per-action try/catch
2. **Kategorizálás**:
   - **CODE-OS**: `{ success: false, reason: 'misconfigured' }` — generic 500, semmi belső info
   - **REASON+CONTEXT**: `{ success: false, reason: 'invite_expired', expiresAt }` — domain-specifikus, NEM internal stack
   - **RAW MESSAGE**: `{ success: false, error: err.message }` — VESZÉLYES, audit-fix kell
3. **Fix-pattern**: minden RAW MESSAGE-t cseréljünk CODE-OS vagy REASON+CONTEXT mintára. A `fail(res, code, reason, extras)` helper (helpers/util.js) már létezik — ezt kell konzisztensen használni.

### Phase szakaszolás

- **Phase 1**: csak az `invite-to-organization` CF (a leggyakrabban hívott + legtöbb action-handler-rel)
- **Phase 2** (külön iteráció): maradék 10-15 CF + automated check-script

## Codex pre-review Q-k

**Q1**: A jelenlegi `fail(res, code, reason, extras)` helper minta minden action-ben konzisztensen használt? Ha NEM, hol van raw `res.json`?
Default: **audit minden `res.json` use-case-t** + cserélni a `fail()`-re.

**Q2**: Az `err.message`-ből mennyi PII / belső info derülhet ki realisztikusan?
- Appwrite SDK error: `AppwriteException: Document with the requested ID could not be found` — content-disclosure (létezik-e doc), de NEM PII.
- Custom Error: `[Bootstrap] User ${callerId} already in org` — userId-leak (önmagában OK, mert a caller saját userId-je).
- Stack trace: file-path-disclosure (`/var/task/src/actions/orgs.js`) — internal path, low-risk de informational.
Default: **legkisebb-hozzáférési minta** — code-os reason mindig, raw message csak DEBUG-ban.

**Q3**: Backward-compat: a frontend kódot (Plugin + Dashboard) érdekli-e az `error: err.message` vagy csak a `reason: <code>`?
- Plugin `_handleCFError` (UserContext.jsx) — `reason`-t használ
- Dashboard `errorMessage()` (callInviteFunction) — `reason`-t használ
Default: **break minimal** — `error` mező opcionálisan megmarad (vagy redacted-summary), de a frontend csak a `reason`-t olvassa.

**Q4**: A top-level catch (line 705-707) `error(\`Stack: ${err.stack}\`)` — a stack-trace logolása CF execution log-ba helyes? A piiRedaction.js Phase 1 wrap-elt — JWT/email kiszedi, de a stack file-path-t megőrzi. Acceptable?
Default: **igen, debug-érték nagyobb** mint info-disclosure-risk (a CF execution log fél-publikus, NEM publikus).

**Q5**: 500-as response body schema standardizálás?
- `{ success: false, reason: 'misconfigured', requestId?: <appwrite-execution-id> }` — a requestId support-jelzéshez kell.
Default: **igen, requestId opcionális mező** a 500-as response-okban.

**Q6**: Test-stratégia?
Default: **manual code-review** (Codex pipeline) — a projektnek nincs frontend / CF integration test framework.

## STOP feltételek

- Audit > 60 perc context-fogyás → Phase 2-re halaszt + jelez.
- Backward-compat törő change (Plugin / Dashboard expect-er `error` mezőt) → user-task flag.

## Becsült időtartam

~30-45 perc (audit + `invite-to-organization` 5-10 try/catch-fix + Codex pipeline + /harden).

## Kapcsolódó

- [[Feladatok#S.13]]
- [[Komponensek/SecurityRiskRegister]] R.S.13.3 HIGH
- [[Komponensek/LoggingMonitoring]] S.13.3 szakasz (placeholder)
- [[Tervek/autonomous-session-loop]]
