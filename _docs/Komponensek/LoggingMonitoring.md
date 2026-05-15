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

## S.13.3 — Error message info-disclosure (Phase 1.0 partial close 2026-05-15)

ASVS V7 + V13. Threat: a CF action-handler-ek `try/catch`-jeiből raw `err.message`, `err.stack`, internal-code-path-string-ek kerülnek a kliens-response body-jába.

### Phase 1.0 fix (centralized minta)

**`fail(res, statusCode, reason, extra)` helper** [helpers/util.js](../../packages/maestro-server/functions/invite-to-organization/src/helpers/util.js):

```javascript
const SENSITIVE_RESPONSE_FIELDS = new Set(['error', 'message', 'details', 'stack', 'cause']);

function stripSensitive(value) {
    if (Array.isArray(value)) return value.map(stripSensitive);
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) {
            if (SENSITIVE_RESPONSE_FIELDS.has(key)) continue;
            out[key] = stripSensitive(value[key]);
        }
        return out;
    }
    return value;
}

function fail(res, statusCode, reason, extra = {}) {
    const cleaned = stripSensitive(extra);
    const redacted = redactValue(cleaned, 0);
    return res.json({ success: false, reason, ...redacted }, statusCode);
}
```

**Hatás**:
- Az összes ~30 `fail(...)` callsite az action-okban (`schemas.js` bootstrap/backfill, `orgs.js` cleanup, `offices.js`, `publications.js`, `permissionSets.js`) AUTOMATIKUSAN javítva — a `extra.error: err.message`, `extra.message: cleanupErr.message`, `extra.failures.push({ docId, message: err.message })` minták mind strip-elve a kliens-response-ban.
- A `error('...')` és `log('...')` logging VÁLTOZATLAN — a S.13.2 piiRedaction.js Phase 1 wrap-elve van, PII-mentes log-ba kerül.

**main.js top-level catch fix**:
```javascript
} catch (err) {
    error(`Function hiba: ${err.message}`);  // S.13.2 wrap-elve
    error(`Stack: ${err.stack}`);           // S.13.2 wrap-elve
    return fail(res, 500, 'internal_error', {
        executionId: req?.headers?.['x-appwrite-execution-id']
    });
}
```

**Ad-hoc success-response fix**:
- `invites.js:837` `create_batch_invites` results[].reason: raw `err.message` → `err.code || 'create_failed'` domain-code
- `schemas.js:3414` `backfill_organization_status` stats.errors[].error: drop the field

### Phase 1.5 — Success-response audit (külön iter, Open)

Maradék `success: true` body leak-ek a Codex verifying #2 alapján:

1. **`_finalizeOrgIfProvisioning`** (orgs.js:95-111): return `{ finalized: false, error: e.message }` → propagálja `provisioningStuckReason: finalizeResult.error` mezőbe (orgs.js:395, 570). Fix: `error: e.message` → `errorCode: 'finalize_failed'`.
2. **`delete_organization`** orgCleanup (orgs.js:850, 862): `membershipsCleanup = { found, deleted, error: cleanupErr.message }` → drop the `.error` field.
3. **`schemas.js`** backfill stats.errors[].message (919, 1085, 1192, 1329, 2950, 2971): drop the `.message` field. ~12 hely.

### Phase 2 — Maradék 10-15 CF (folyamatban, Phase 2.0a kész)

**Phase 2.0a (2026-05-15 close)** — `update-article` CF:
- Új shared ESM canonical: [maestro-shared/responseHelpers.js](../../packages/maestro-shared/responseHelpers.js) (`fail`, `okJson`, `createRecordError`, `stripSensitive`, `normalizeReason`).
- CommonJS portolt másolat a CF-ben: `_generated_piiRedaction.js` + `_generated_responseHelpers.js`.
- `update-article/src/main.js` wrap: S.13.2 PII-redaction log + S.13.3 fail() strip + line 563 raw `err.message` fix.
- Codex pipeline: stop-time+adversarial CLEAN (`a22bb93a3428aa871`).

**Phase 2.0b (2026-05-15 close)** — `validate-publication-update` CF (3 leak fixed):
- Line 383 `res.json({...error: e.message}, 500)` (membership_lookup_failed) → `fail(res, 500, 'membership_lookup_failed', { executionId })`
- Line 726 catch raw `err.message` → `fail(res, 500, 'internal_error', { executionId })`
- S.13.2 PII-redaction log wrap (module.exports signature + body első 2 során)
- Codex stop-time CLEAN (`a797475f388de51e1`)
**Phase 2.0c (2026-05-15 close)** — `user-cascade-delete` CF (5 leak fixed):
- Line 113 helper return `{ ..., error: err.message }` → drop (defense-in-depth, NEM kerül kliens-response-be)
- Line 215/221/227 `stats.listFailures.push({...error: err.message})` → drop `.error` (`organizationMemberships` / `editorialOfficeMemberships` / `groupMemberships`)
- Line 331 `stats.verificationFailures.push({...error: markErr.message})` (orphan_marker_write) → drop
- Line 344 `stats.verificationFailures.push({...error: err.message})` (last_owner) → drop
- S.13.2 PII-redaction log wrap (arrow signature)
- Codex stop-time MAJOR (`a1a797faee8d7e3a3`) → fix → CLEAN
**Phase 2.1** — Build-generator (S.7.7b precedens) automatikusan generálja `_generated_*.js` minden CF-be + drift-guard `--check` mód. Plus `wrapLogger(rawLog, rawError)` shared helper a per-CF DRY-violation csökkentésére (S.13.2 wrap).
**Phase 2.2** — Maradék 8+ CF (`set-publication-root-path`, `resend-webhook`, `orphan-sweeper`, `cleanup-orphaned-locks`, `cleanup-rate-limits`, `cleanup-archived-workflows`, `migrate-legacy-paths`, `cascade-delete`, `validate-article-creation`).

**Phase 2.x hidden risks (Codex Phase 2.0a)**:
- `permissionDenied()` bypassolja a `fail()`-et (future dynamic reason leak)
- `success: true` body unfiltered (out-of-scope, S.13.5/Phase 3 audit-érdemes)
- "AUTO-GENERATED" komment aspirational amíg Phase 2.1 build-generator NEM él

### Codex pipeline (4 review iteráció)

| Fázis | Agent ID | Verdict | Findings |
|---|---|---|---|
| Pre-review | `a1369cfb79cae8786` | BLOCKER → reduced | Q4 push-back: szélesebb audit kell (publications.js + schemas.js + orgs.js further) |
| Stop-time #1 | `a040234890a764ded` | MAJOR | success-response bypass: invites.js batch + schemas.js backfill |
| Verifying #1 | `a3cb2d11eb9b38d4c` | MAJOR | további success-response leak-ek: _finalizeOrgIfProvisioning + orgs.js:850 + schemas.js 6 hely |
| Frame fix | (manual) | Phase 1.0 partial close | scope-redukció: Phase 1.0 fail() + main.js + 2 ad-hoc; Phase 1.5 success-audit külön iter |

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
