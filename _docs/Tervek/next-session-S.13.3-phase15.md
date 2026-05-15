---
tags: [terv, session-prompt, S-blokk, logging, info-disclosure, phase15]
target: S.13.3 Phase 1.5
created: 2026-05-15
---

# Új session — S.13.3 Phase 1.5 success-response audit (R.S.13.3 Phase 1.5 close)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

A Codex verifying #1 (`a3cb2d11eb9b38d4c`) hivatkozott további `success: true` body-on belüli leak-eket. Phase 1.5 ezt zárja le az `invite-to-organization` CF-ben — előfeltétel az R.S.13.3 → Closed (Phase 1+1.5) zárás-hoz, majd Phase 2 (maradék 10-15 CF) a teljes lefedettséghez.

Risk register: **R.S.13.3** Phase 1.0 partial close (2026-05-15), Phase 1.5 következik.

## Scope (Phase 1.5)

3 leak-pattern, ~9 hely az `invite-to-organization` CF-ben:

### Leak 1: `_finalizeOrgIfProvisioning` raw `e.message`

[orgs.js:95-111](../packages/maestro-server/functions/invite-to-organization/src/actions/orgs.js):

```javascript
catch (e) {
    ctx.error(`[Bootstrap] finalize pre-check hiba (org=${organizationId}): ${e.message}`);
    return { finalized: false, error: e.message };  // ← raw leak
}
// ...
catch (e) {
    ctx.error(`[Bootstrap] status finalize hiba ...: ${e.message}`);
    return { finalized: false, error: e.message };  // ← raw leak
}
```

A return propagálódik `orgs.js:395, 570` callsite-okra `provisioningStuckReason: finalizeResult.error` mezőbe. FIX: `error: e.message` → `errorCode: 'finalize_failed'` és a callsite-okon `provisioningStuckReason: finalizeResult.errorCode`.

### Leak 2: `delete_organization` orgCleanup.error

[orgs.js:850, 862](../packages/maestro-server/functions/invite-to-organization/src/actions/orgs.js):

```javascript
catch (cleanupErr) {
    error(`[DeleteOrg] memberships cleanup az org doc törlése után elbukott: ${cleanupErr.message}`);
    membershipsCleanup = { found: null, deleted: null, error: cleanupErr.message };  // ← leak
}
// ...
return res.json({
    success: true,
    ...
    orgCleanup  // membershipsCleanup.error még raw
});
```

FIX: drop `.error` field a `membershipsCleanup`-ból — csak `{ found: null, deleted: null }`.

### Leak 3: `schemas.js` backfill `stats.errors[].message`

~6+ hely a `schemas.js`-ben (különböző bootstrap/backfill action-ökön):
- [schemas.js:919](../packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js)
- [schemas.js:1085](../packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js)
- [schemas.js:1192](../packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js)
- [schemas.js:1329](../packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js)
- [schemas.js:2950](../packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js)
- [schemas.js:2971](../packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js)
- + esetleg további mintát az audit során

Minta: `stats.errors.push({ kind: '...', orgId: ..., message: err.message })`. FIX: drop `.message` field — domain-kód + ID-k elegek support-triage-hez.

### Alternatív minta — `okJson(res, body)` helper

Megfontolandó egy centralized helper:

```javascript
function okJson(res, body) {
    const cleaned = stripSensitive(body);
    const redacted = redactValue(cleaned, 0);
    return res.json(redacted, 200);
}
```

A `success: true` callsite-okat `okJson`-ra cserélve (~9 hely a CF-ben), MINDEN body-on belüli leak AUTOMATIKUSAN javul. **Trade-off**: a `res.json` direkt használat dispersed (50+ hely a teljes CF-ben) — alternatív minta: csak a 4-5 érintett action-okban a `success: true` callsite-ot cseréljük.

## Codex pre-review Q-k

**Q1**: Manual fix (drop fields a leak-helyeken) vs `okJson` helper (centralized minta)?
Default: **okJson helper** — konzisztens a `fail()`-szintű mintával, scalable a Phase 2-höz.

**Q2**: Az `_finalizeOrgIfProvisioning` `errorCode: 'finalize_failed'` propagálódik a `provisioningStuckReason` mezőbe — a kliens-frontend `provisioningStuckReason` mit kezd? Tudja-e diagnosztikailag használni a `'finalize_failed'` domain-kódot? Default: **igen**, mert a frontend `provisioningStuckReason` jelenleg generic UI-warning + retry-gomb logic-ot triggerel, NEM message-display.

**Q3**: Backward-compat: a Dashboard/Plugin `_handleCFError` / `callInviteFunction` a `response.reason`-t használja, NEM a `success: true` body internals-jét. A drop `.error` / `.message` NEM tör semmit. Audit?

**Q4**: Phase 2 előkészítés: érdemes-e a `okJson` + `fail()` helpereket egy shared `maestro-shared/responseHelpers.js`-be tenni, hogy a maradék CF-ek (update-article, validate-publication-update, stb.) ugyanazt használhassák? Vagy hagyjuk per-CF helpers/util.js-ben?
Default: **shared maestro-shared/responseHelpers.js** Phase 2-re — build-generator (S.7.7b precedens) automatikusan generálja a CF-eknek.

## STOP feltételek

- Phase 1.5 + Phase 2 audit > 60 perc → split.
- Frontend `_handleCFError` backward-compat tör → user-task flag.

## Becsült időtartam

~30-45 perc (3 leak-pattern fix + Codex pipeline + /harden + okJson helper).

## Kapcsolódó

- [[Feladatok#S.13]]
- [[Komponensek/SecurityRiskRegister]] R.S.13.3 Phase 1.0 partial close
- [[Komponensek/LoggingMonitoring]] S.13.3 Phase 1.0 + 1.5 + 2 spec
- [[Tervek/autonomous-session-loop]]
