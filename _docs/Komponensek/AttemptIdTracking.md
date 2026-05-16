---
tags: [komponens, attempt-id, idempotency, audit, adr-0011]
related:
  - "[[Döntések/0011-cas-gate-and-orphan-guard-invariants]]"
  - "[[Komponensek/AuditTrail]]"
---

# AttemptIdTracking — `attemptId` per-call UUID (ADR 0011 follow-up)

## Kontextus

ADR 0011 (CAS-gate + orphan-guard invariánsok, 2026-05-09) bevezette az `attemptId` per-call UUID-t: a `_archiveInvite()` flow recovery-probe-jának korrelálható azonosítója.

**Schema-bővítés**: `organizationInviteHistory.attemptId` (string 36) — 2026-05-09 deploy-elt.

## Cél

A `_archiveInvite()` minden hívása generál egy random UUID v4-et (`crypto.randomUUID()`), és ezt:
1. Mind a CAS-gate `updateDocument` `expectedUpdatedAt` mellett a `data.attemptId`-be tárolja
2. Mind a recovery-probe (sikertelen CAS után) `getDocument` log-jában rögzíti

A két oldal **korreláltatható** post-incident: a Better Stack / Appwrite log-keresőjén `attemptId: <uuid>` filter MIND a CAS-attempt MIND a recovery-probe sorát mutatja.

## Use case

### Incident-investigation

User report: "az invite eltűnt status-overwrite után".

1. Log-search `inviteId: abc123` → 3 sor:
   - `[ArchiveInvite] attemptId=xxx CAS write ok`
   - `[ArchiveInvite] attemptId=yyy CAS conflict`
   - `[ArchiveInvite] attemptId=yyy recovery-probe ok (existingFinalStatus=expired)`
2. A 2. attemptId conflict-elt — másik writer overwrite-elte. A `yyy` recovery-probe mutatja, hogy a final-state `expired`.

**Eredmény**: nincs adat-vesztés, csak race-condition log-trace.

### Audit-trail integráció (Phase 4 S.10.5)

A jövőbeli `actionAuditLog` collection minden mutating action-höz **attemptId-mezőt** rögzít:
```
{
  userId, action, orgId, targetId,
  payload: {...},
  attemptId: "uuid-v4",
  timestamp, ip
}
```

A 2 collection (`actionAuditLog` + `organizationInviteHistory`) `attemptId` mezővel cross-joinable.

## Implementáció

### Current (2026-05-09 deploy)

```javascript
// invite-to-organization _archiveInvite():
const attemptId = crypto.randomUUID();
ctx.log(`[ArchiveInvite] attemptId=${attemptId} starting CAS for invite=${inviteId}`);

try {
    await ctx.databases.updateDocument(..., {
        status: 'archived',
        archivedAt: now,
        attemptId  // <-- written to invite-history
    });
} catch (err) {
    if (err.code === 409) {
        // CAS conflict — recovery probe
        const current = await ctx.databases.getDocument(...);
        ctx.log(`[ArchiveInvite] attemptId=${attemptId} CAS conflict, recovery probe: existing=${current.status}`);
        return { status: 'lost_to_race', existingFinalStatus: current.status };
    }
}
```

### Future (S.10.5 Phase 4)

Minden mutating CF action `attemptId`-t generál a body-első-soron + `actionAuditLog` write a sikeres mutation után.

## Hidden risks

- **UUID-uniqueness**: `crypto.randomUUID()` v4 collision-probability negligible (2^-122)
- **Performance**: 1 UUID-generation per-call + 1 audit-write — ~5-10% perf-impact (S.10.5 design-decision)
- **Storage**: `actionAuditLog` collection 1 év retention → ~1M doc/év × 200 byte = ~200 MB/év (acceptable)

## Kapcsolódó

- [[Döntések/0011-cas-gate-and-orphan-guard-invariants]] (CAS-gate + orphan-guard, attemptId introduce)
- [[Komponensek/AuditTrail]] (S.10.5 actionAuditLog Phase 4)
- [[Komponensek/LoggingMonitoring]] (Better Stack ingest a attemptId log-correlation-höz)
