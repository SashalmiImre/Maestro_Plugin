---
adr: 11
status: Accepted
date: 2026-05-09
tags: [adr, döntés, server, cas, audit, race, orphan]
related: [[0010-meghivasi-flow-redesign]]
---

# ADR 0011 — CAS-gate, audit-trail és orphan-guard invariánsok

## Háttér

A 2026-05-09 session-3 (F+E+G blokk + Harden) lezárta a kódoldali Phase 1.5/1.6 orphan-guardot, a Q1 admin-team ACL-t és a D.3 invite-history CAS-gate-et. A 8 Codex iteráció 1 BLOCKER + 7 MAJOR + ~10 MINOR-t talált; mind javítva. Maradtak Phase 2 follow-upok a `_docs/Feladatok.md`-ben — ebből 3 (F.8, G.4, G.5) DESIGN-szintű döntést igényelt, amit Codex pre-review álláspont alapján itt rögzítünk a Phase 2 implementáció ELŐTT.

A Codex pre-review (2026-05-09 D.0 alapelv) álláspontja:

> **G.4**: hard-fail on CAS-gate, not best-effort, because invite/history correctness is a state-integrity boundary and silent degradation will create irreconcilable ambiguity later.
>
> **G.5**: state-of-record authoritative; race-loser audit-loss elfogadható, ha a final state korrektül jelenik meg. A correctness of final state matters more than pretending the event log is complete when it cannot be made reliable under contention.

Ez az ADR ezt az álláspontot fogadja el és kontextualizálja az F.8 TOCTOU strict invariáns kérdéssel együtt.

## Döntés

### G.4 — CAS-gate: HARD-FAIL `env_missing` esetén

A `_archiveInvite()` `env_missing` ágat (a `ORGANIZATION_INVITE_HISTORY_COLLECTION_ID` env hiánya) a 4 critical-path action (`acceptInvite`, `declineInvite`, `createInvite`, `createBatchInvites`) az ELSŐ DB-mutáció ELŐTT 500 `service_misconfigured`-vel hard-fail-eli. Implementáció: `_assertCasGateConfigured(ctx)` action-eleji guard.

A `error` ág (transient hiba: timeout, hálózat) NEM hard-fail-el — a G.2 recovery probe `created` (idempotent) vagy `already_exists` (race-loser) jelzésre konvertálja, ha az írás backend-oldalon mégis lefutott. Tartós hibára (a probe is bukik) `status: 'error'` marad → a hívó best-effort folytat (a final state — membership létrejön — fontosabb mint a transient audit-rés).

Az opportunista expire (`_archiveAndUpdateExpiredInvite`) NEM hard-fail-el — a fő flow-t nem blokkolja, és az `env_missing` az action-eleji guarddal már lefulladt volna.

### G.5 — Race-loser audit-veszteség: STATE-OF-RECORD AUTHORITATIVE

Az `accepted` vs `expired` race-on a winner `expired` lehet, miközben a user TAG (a membership már létrejött a `acceptInvite` 5. lépésében). A history rekord ilyenkor `expired` finalStatus-szal van, ami **NEM jelenti, hogy a user nem tag** — ez egy **race-loser audit-loss**, NEM state-corruption.

**Konvenció (compliance-szempont)**:
- A **state-of-record** az `organizationMemberships` collection (a user IS tag).
- Az `organizationInviteHistory` egy **secondary audit-index** — a final-status-on belül a race-loser ágon stale lehet a "ki nyert" perspektíva.
- A "missing accepted event" panaszt a compliance-team a membership rekord `$createdAt` alapján rekonstruálhatja (a `acceptedByUserId` mező az `acceptInvite` race-winner ágán már stamp-elve, race-loser ágon hiányzik — ezt jelezzük a docstring-ben).

A **külön `event-log` collection** (mind a 2 ágat naplózó append-only log) NEM kerül implementálásra — a state-of-record + membership-rekord-alapú audit elegendő. Phase 3 (compliance audit-bővítés): ha jövőbeli regulátor explicit event-log-ot kér, az a CAS-gate ELŐTT egy "race-attempt-log" collection-be írná mind a két ágat — de ez NEM blokkoló a jelenlegi flow-ban.

### F.8 — TOCTOU strict invariáns: ACL-SZINTŰ NEM IMPLEMENTÁLT, app-szintű marad

A Phase 1.6 orphan-guard (`getOrgStatus()` → `isOrgWriteBlocked()`) `update-article`, `set-publication-root-path` CF-ekben TOCTOU race-window-ot hagy:

1. T0: CF olvasja az `org.status === 'active'`
2. T0+ε: másik action (pl. `transfer_orphaned_org_ownership`) `'orphaned'`-re írja
3. T0+2ε: CF folytatja az írást (best-effort `active`-feltételezéssel)

**Mérlegelés**:
- ACL-szintű write-tilt collection-en (`status='orphaned'` orgon a collection ACL-jét update-elni `[]`-ra) megoldaná a race-t **strict invariánssal** — de minden orphan→active recovery flow kétszeres ACL-rewrite-ot igényelne, és a backfill (`backfill_admin_team_acl`) ACL-rewrite-jával összeütközne.
- A jelenlegi best-effort guard a praktikus esetben elegendő: az árvulás → recovery flow admin-felügyelt, a race-window 30s-on belüli (F.9 cache TTL).

**Döntés**: a F.8 strict ACL-szintű invariáns NEM implementálódik a Phase 2-ben. Az app-szintű best-effort guard + F.9 hot-path cache + Codex Konstrukció C invite-szintű CAS-gate (D.3) együtt megfelelő védelmet ad.

**Phase 3 trigger**: ha élesben race-corrupcio incident keletkezik (org-szintű write a `transfer_orphaned_org_ownership` futás közben), revisit ezt az ADR-t és tervezzünk strict ACL-write-tilt invariáns-t.

## Következmények

- **Pozitív**: a CAS-gate konfiguráció hibakonfigurációra explicit 500 `service_misconfigured` hibakódot ad, NEM csendben elvesző audit-rést. Egy újonnan deployolt környezetben a hiányzó env-var azonnal észrevehető a deploy-smoke-on.
- **Pozitív**: a recovery probe (G.2) elimináli a 504 timeout után az audit-duplikációt és ad-hoc retry-state-corruption esélyt.
- **Pozitív**: az F.9 hot-path cache 30s TTL-szel a 2 CF DB-load-ját 50-100x csökkenti hot-szakaszon.
- **Negatív**: a state-of-record vs audit-trail divergence egy edge-case-ben race-loser audit-veszteséget enged. Ez kommunikálandó a compliance-team felé (snapshot a membership $createdAt + a denormalizált `acceptedByUserId` alapján).
- **Negatív**: a F.8 strict invariáns hiányában a 30s-os F.9 cache TTL-t nem szabad megnövelni — különben a recovery flow → orphan-guard késleltetés idiopath race-corrupcio-t engedne.

## Tesztelhető invariánsok (smoke-teszt)

1. **G.4 hard-fail**: az `acceptInvite` env nélkül futtatva → 500 `service_misconfigured`. A membership NEM jön létre.
2. **G.2 recovery probe**: `_archiveInvite` mock 504 → a következő call ugyanazon `invite.$id`-vel → `status: 'created', recovered: true` (NEM `error`).
3. **G.5 race-loser audit**: párhuzamos `acceptInvite` + opportunista `auto_expire_on_list` → 1 history rekord, a winner `accepted` VAGY `expired`. Ha `expired` nyer, a user TAG (a membership creat ELŐTT futott).
4. **F.9 cache**: `update-article` 100 hívás 1s alatt → 1 (cold) + ≤ ceil(elapsed/30s) `getDocument(organizations)` lookup, NEM 100.

## Kapcsolódó

- ADR [[0010-meghivasi-flow-redesign]] — a CAS-gate D.3 origin-je
- Feladatok F.7-9, G.2-5, E.6-7, H.1-2 — Phase 2 follow-up scope
- Naplók [[Naplók/2026-05-09]] — Session-3 + Phase 2 implementation
