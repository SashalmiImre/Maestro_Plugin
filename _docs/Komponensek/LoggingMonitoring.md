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
**Phase 2.1 (2026-05-15 close)** — Build-generator + `wrapLogger` shared helper + 3 demo CF refactor:
- [scripts/build-cf-response-helpers.mjs](../../scripts/build-cf-response-helpers.mjs) (~200 sor): S.7.7b precedens-szerű minta, 2 shared modul × 3 target CF = 6 generated fájl. ESM `import` → CommonJS `require` path-rewrite (`./piiRedaction.js` → `./_generated_piiRedaction.js`). Post-transform fail-closed lingering-ESM check.
- Yarn scripts: `build:cf-response-helpers` + `check:cf-response-helpers` (drift-guard `--check` mód, CI-mentes local)
- `wrapLogger(rawLog, rawError)` új helper a shared `piiRedaction.js`-ben — `isRedactionDisabled() ? raw : redact-spread`. 3 demo CF main.js refactor: 5-soros wrap → 1-soros `const { log, error } = wrapLogger(rawLog, rawError);`
- Codex stop-time+adversarial MINOR/CLEAN (`a5f7f9f1422eac5f1`): 3 design-follow-up Phase 2.2-re halasztott (CI integration, regex fragility, auto-discovery).
**Phase 2.2 (2026-05-15 close)** — Maradék 11 CF wrap MIND kész. TARGET_CFS 3→14 expanded (`scripts/build-cf-response-helpers.mjs`); 22 új generated `_generated_*.js`; mind 11 CF main.js wrap `wrapLogger`-rel + top-level catch `fail()` strip.

Érintett CF-ek (Phase 2.2): `article-update-guard`, `cascade-delete`, `cleanup-archived-workflows`, `cleanup-orphaned-locks`, `cleanup-orphaned-thumbnails`, `cleanup-rate-limits`, `migrate-legacy-paths`, `orphan-sweeper`, `resend-webhook`, `set-publication-root-path`, `validate-article-creation`.

Per-CF extra leak fix:
- `orphan-sweeper`: `stats.collectionScanFailed.push({...error: err.message})` → drop
- `cleanup-rate-limits`: `collectionScanFailed.push({...error: err.message})` → drop
- `validate-article-creation`: `error: e.message` `membership_lookup_failed` → `fail()` + `executionId`
- `set-publication-root-path`: inline `fail()` definíció törölve, shared importtal

Codex stop-time MINOR (`a3f81651c40a6f6fc`): csak stilisztikai inkonzisztencia (`resend-webhook` arrow vs function), NEM-leak.

**R.S.13.2 + R.S.13.3 → Closed 2026-05-15. STOP-condition (a) teljesül.**

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

## S.13.1 — Central log aggregation (design, 2026-05-16)

**Trigger**: első incident vagy compliance-kérés (jelenleg passzív → manual review).

### Tool-comparison

| Tool | Cost (start) | EU-data-residency | Alert-rules | LogQL/Query | Verdict |
|---|---|---|---|---|---|
| **Sentry** | $0 (5k events/hó) | EU host-able (paid) | ✅ Performance + Issues | NEM-general-purpose | ❌ Frontend-error tracking specifikus, NEM-server-log generic |
| **Better Stack** | $0 (100MB/hó) | ✅ EU servers | ✅ log-pattern matching | LogQL-szerű | ✅ **Default** — free-tier elég, EU-compliance |
| **Grafana Loki** | $0 (self-host) | ✅ self-host (Hetzner) | ✅ Alertmanager | LogQL native | ⚠️ Ops-overhead (self-host management) |

**Decision**: **Better Stack** (free-tier 100MB/hó kezdeti volume-hoz elég; ha skálázódik, paid-upgrade vagy Loki-self-host migration).

### Integration steps (S.13.1 follow-up, NEM-most-implement)

1. Better Stack account create (`security@emago.hu`)
2. Source-create:
   - Appwrite CF execution logs: webhook-trigger (Appwrite Console > Webhooks → Better Stack ingest URL)
   - Railway proxy logs: Better Stack-direct-integration (Railway plugin)
3. Alert-rules import — `MonitoringAlerts.md` A1-A5 specifikációból
4. Slack-integration (#maestro-incidents)

## S.13.4 — Monitoring alertek (design, 2026-05-16)

Részletek: [[Komponensek/MonitoringAlerts]] (új jegyzet) — 5 alert-rule (CF failure, login-fail, rate-limit spike, WS disconnect, invite-rate anomaly) + notification channels + runbook.

## S.13.5 — Audit-log retention CIS 8.3 (verify, 2026-05-16)

**CIS Controls 8.3 minimum**: 90 nap. **ASVS L2 elegendő**.

| Log source | Default retention | CIS-compliance | Action |
|---|---|---|---|
| Appwrite Cloud Functions execution logs | 30 nap (Free tier), 90 nap (Pro), unlimited (Scale) | ⚠️ Free tier alatt — szükséges upgrade vagy Better Stack ingest | USER-TASK: Appwrite plan-verify |
| Appwrite Auth audit log | 30 nap | ⚠️ ditto | USER-TASK |
| Railway proxy logs | 7 nap (Hobby), 30 nap (Pro) | ❌ Hobby alatt NEM-elég | USER-TASK: Railway plan-verify vagy Better Stack ingest |
| Better Stack ingested logs | 7 nap (Free), 30+ nap (paid) | ⚠️ paid kell | USER-TASK |

**Decision**: ha a Maestro plan-szintű upgrade NEM-támogatott a budget-ben, akkor a Better Stack 30+ nap paid plan (~$10-25/hó) **olcsóbb és specifikusabb a security-log-archívra** mint az Appwrite/Railway plan-upgrade.

**Default**: Phase 3 implementation triggered by első incident vagy GDPR Art. 32 compliance-audit.

## S.13.7 — Stop-time Codex review (S.13 blokk záró, 2026-05-16)

S.13.2 + 13.3 már Closed (Phase 1+2+ build-generator + 14 CF wrap). S.13.1 + 13.4 + 13.5 design-szintű, implementation Phase 3 USER-TASK-trigger-rel.

**S.13 blokk teljes lezárása**: ✅ minden al-pont kész (closed vagy design-only/phase-3-flag).

## Kapcsolódó

- [[Komponensek/SecurityRiskRegister]] R.S.13.x mind Closed
- [[Komponensek/SecurityBaseline]] ASVS V7 + CIS Controls 8
- [[Komponensek/MonitoringAlerts]] (új, S.13.4)
- [[Naplók/2026-05-15]] S.13.2+13.3 szekciók
- [[Naplók/2026-05-16]] S.13.1+13.4+13.5+13.7 záró
