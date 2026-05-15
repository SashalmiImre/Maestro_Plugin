---
tags: [komponens, logging, monitoring, security, pii-redaction]
related:
  - "[[Komponensek/SecurityBaseline]]"
  - "[[Komponensek/SecurityRiskRegister]]"
  - "[[Feladatok]]"
---

# LoggingMonitoring — PII-redaction + centralized log + error response

## Kontextus

A Maestro Plugin centralized-log felülete fél-publikus:
- **Appwrite CF execution logs**: a Console-on a project-member-ek elérhetik (CF function detail oldal "Executions" tab). Időtartam-retention Appwrite-default (~30 nap), forensics-szintű hozzáférés.
- **Railway proxy logs**: Railway dashboard hosztolt-tárolt, projekt-szintű hozzáférés.

Threat: ha a `log()` / `error()` raw email-t, JWT-t, Appwrite session-tokent, bearer-credentials-t, password-mezőt, cookie-t ír, ezek a fél-publikus log-okban tárolódnak. ASVS V7 + CIS Controls 8 + GDPR Art. 32 megköveteli a PII-redaction-t at-rest.

## S.13.2 — `piiRedaction` helper (Phase 1 partial close 2026-05-15)

**Kanonikus modul**: [packages/maestro-shared/piiRedaction.js](../../packages/maestro-shared/piiRedaction.js)

### Exported API

| Függvény | Cél |
|---|---|
| `redactEmail(str)` | Email-maszkolás: `john@example.com` → `j***@example.com` (first letter + 3 asterisk + @domain) |
| `redactTokenLast4(str)` | Token-elhúzás: `abc...8d5f` (csak utolsó 4 char). <8 char → full-redact (`***REDACTED***`) |
| `redactString(str)` | Smart string-redact: JWT (eyJ-prefix) + Bearer + email + long-token regex |
| `redactValue(value, depth, seen)` | Rekurzív value-redact: max-depth=3, WeakSet cycle-tracker, max 100 key/level. Error special-case (name/message/stack/cause/response). |
| `redactArgs(args)` | Logger argumentum-lista redact-pass. **Spread-pattern kötelező**: `fn(...redactArgs(args))` |
| `isRedactionDisabled()` | Dev opt-out: `LOG_REDACT_DISABLE=true` env var, `NODE_ENV !== 'production'` guard alatt |

### Pattern coverage

- **Email regex** (RFC 5321-szerű egyszerűsített)
- **JWT regex** (eyJ-prefix + 3 base64-blokk pont-szeparátorral)
- **Bearer regex** (`Bearer <token>` auth-header)
- **Long token regex** (Appwrite session-token + custom 32+ hex / 40+ alfanum) — **Phase 2 false-positive finomítás**: md5/sha hash, content-hash, deterministic doc-hash false-positive-ot okoz incidens-korreláció-veszteséggel; key-aware mode (csak `token`/`secret` kulcs alatt aktív) tervezett.

### Key-policy

| Pattern | Hatás |
|---|---|
| `password`, `secret`, `apikey`, `api_key`, `api-key`, `authorization`, `cookie`, `set-cookie`, `x-appwrite-key`, `x-appwrite-session`, `refresh` (substring match) | **Full-redact** (`***REDACTED***`) |
| `token`, `jwt`, `sessionid`, `session_id`, `invitetoken` (key === pattern vagy endsWith) | **Last-4** (`...8d5f`) — incident-triage-jelölő |
| Egyéb | Smart-detect (redactString a string-en) |

### Wire-points (Phase 1)

| Helyszín | Minta |
|---|---|
| `packages/maestro-indesign/src/core/utils/logger.js` | ESM import `maestro-shared/piiRedaction.js`. `log` / `logError` / `logWarn` / `logDebug` minden args-on `redactArgs`. Lazy `callConsole(method, args)` try/catch fallback (UXP bind-failure defensive). |
| `packages/maestro-server/functions/invite-to-organization/src/main.js` | CommonJS require `./helpers/piiRedaction.js`. Function signature `({ req, res, log: rawLog, error: rawError })` + body első 2 során wrap: `const log = (...args) => isRedactionDisabled() ? rawLog(...args) : rawLog(...redactArgs(args));` |

### Phase 1 PARTIAL ROLLOUT (FONTOS frame)

A jelenlegi state **NEM production-szintű teljes PII-redaction** (Codex adversarial #1 finding). A maradék CF-ek (`user-cascade-delete`, `validate-publication-update`, `update-article`, `resend-webhook`, `orphan-sweeper`, `cleanup-orphaned-locks`, `cleanup-rate-limits`, `cleanup-archived-workflows`, `migrate-legacy-paths`, `cascade-delete`, `validate-article-creation`, `set-publication-root-path`) **RAW log-olnak** — Phase 2 zárja le.

### Phase 2 scope (külön iteráció, R.S.13.2 → Closed prerekvizit)

1. **Maradék CF-ek wrap** (~10-15 függvény, mind ugyanazon a mintán)
2. **Build-generator** (S.7.7b `compiledValidator` precedens): kanonikus shared ESM → automatikusan generált CommonJS inline-másolat minden CF-be + drift-guard `--check` mód
3. **Coverage-check script** (`scripts/check-cf-log-wrap.mjs`): fail-el, ha bármely CF main.js `({ req, res, log, error })`-t használ wrapping nélkül
4. **`LONG_TOKEN_REGEX` false-positive finomítás**: key-aware mode (csak `token`/`secret`/stb. kulcs alatt aktív long-token regex), vagy allowlist (`hash`, `checksum`, `docId`)

### Pre-review hidden risks (mind addressed Phase 1-ben)

1. **Wrapper bug** (spread): `redactArgs` array-t ad vissza, `fn(...redactArgs(args))` minta minden wire-on (Plugin + CF). Verifikálva Codex stop-time spread-pattern checkkel.
2. **Error serialization gap**: `redactValue` Error special-case `name/message/stack/cause/response` mezőkkel (Codex stop-time M1 fix: Appwrite SDK `err.response` is bejárt).
3. **Coverage drift**: Phase 2-re halasztva.

### Adversarial finding-ok (mind addressed Phase 1-ben)

1. **Frame oversell** (MUST): "production PII-redaction" → "Phase 1 partial rollout" minden komment + docs.
2. **Plugin bind UXP module-load failure** (MUST): `console.log.bind(console)` → lazy `callConsole(method, args)` try/catch fallback.
3. **LONG_TOKEN_REGEX false-positive** (SHOULD): tradeoff dokumentálás komment-ben, kódbeli fix Phase 2-re.

## S.13.3 — Error message info-disclosure (Open, HIGH)

A CF response továbbra is raw `err.message`-et ad vissza kliensnek:

```javascript
// packages/maestro-server/functions/invite-to-organization/src/main.js
} catch (err) {
    error(`Function hiba: ${err.message}`);
    error(`Stack: ${err.stack}`);
    return res.json({ success: false, error: err.message }, 500);
}
```

Audit szükséges: minden CF action-handler `try/catch`-jében mi kerül a `res.json` body-jába. Defense-in-depth: csak code-os error (`reason: 'misconfigured'` / `'forbidden'` / `'not_found'`), NEM raw `err.message`. Iter: külön S.13.3 al-pont.

## Codex pipeline (Phase 1, 5 review iteráció)

| Fázis | Agent ID | Verdict | Findings |
|---|---|---|---|
| Pre-review | `a2ddb6f393a0bbc4a` | GO | 8 Q-ra válasz: dashboard skip GO, build-generator Phase 2, key-policy erősebb (api-key, set-cookie, etc.), 3 hidden risk (spread, Error.response, coverage) |
| Stop-time | `af62fdd4a6dc6b8ff` | MINOR / GO | 3 MINOR: Error.response gap (Appwrite SDK), Plugin bind UXP risk (defensive), CF helper komment "1:1 másolat" → "logikai port" |
| Adversarial | `a360e3299c174ab0d` | (3 finding) | Frame oversell + Plugin bind module-load failure + LONG_TOKEN_REGEX false-positive |
| Verifying | `a8589eb09cd99cdf9` | MINOR | 2 lemaradt wording fix (logger.js + helper file frame) |
| Verifying #2 | (implicit) | **CLEAN** | wording fix-ek alkalmazva |

## Kapcsolódó

- [[Komponensek/SecurityRiskRegister]] R.S.13.2 Phase 1 partial close
- [[Komponensek/SecurityBaseline]] ASVS V7 + CIS Controls 8
- [[Naplók/2026-05-15]] S.13.2 szekció
- ADR: NINCS Phase 1-ben (Phase 2 build-generator + drift-guard formalizációja megfontolható)
