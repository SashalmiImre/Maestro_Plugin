---
aliases: [CF Rate Limiting, Rate Limit, S.2]
tags: [biztonság, rate-limit, S2]
status: Implemented
created: 2026-05-11
related: [SecurityBaseline, SecurityRiskRegister, ProxyHardening]
---

# CF Rate Limiting (S.2)

> Az `invite-to-organization` CF rate-limit infrastruktúrája — multi-scope (IP / user / org), weighted increment, per-endpoint config. ProxyHardening (S.1) layer-2 párja, az S blokk S.2.2/S.2.3/S.2.6 al-pontjai. Codex-egyeztetett (`evaluateRateLimit` + `consumeRateLimit` separáció, lockout-amplifikáció elkerülése). Implementáció 2026-05-11.

## Mit változtattunk

| ID | Változás | Korábbi állapot | Új állapot |
|---|---|---|---|
| **S.2.1** | `acceptInvite` IP-rate-limit | helpers/rateLimit.js SKELETON | bekötve `actions/invites.js:914` (5/15min/IP, 1h block) |
| **S.2.2 (IP)** | `invite_send_ip` rate-limit `createInvite` + `createBatchInvites`-ben | nincs | per-IP 30/15min, 1h block |
| **S.2.2 (user)** | `invite_send_user` rate-limit | nincs | per-callerId 50/24h, 1h soft-throttle |
| **S.2.3** | `delete_my_account` attempt-throttle | nincs | per-callerId 3/5min, 5min block (Codex MAJOR 3: NEM 24h hard, hogy self-heal retry megengedhető legyen) |
| **S.2.6** | Resend cost-control per-org-per-day | nincs | `invite_send_org_day` 200 email/24h, 1h soft-throttle (weight=validEmailCount) |
| **API refactor** | `helpers/rateLimit.js` — per-endpoint config + subject paraméter + dry-run/consume separáció | `checkRateLimit(ctx, endpoint)` IP-only | `evaluateRateLimit` + `consumeRateLimit` + `checkRateLimit` (legacy shim) — multi-scope kompatibilis, weighted increment, hash-prefix logolás |

## Új helperek

`helpers/rateLimit.js`:

- **`RATE_LIMIT_CONFIG`** — `Object.freeze`, per-endpoint `{ windowMs, max, blockMs }`. 5 endpoint:
  - `'accept_invite'` (15min/5/1h block) — S.2.1
  - `'invite_send_ip'` (15min/30/1h block) — S.2.2 IP-scope
  - `'invite_send_user'` (24h/50/1h block) — S.2.2 user-day soft-throttle
  - `'invite_send_org_day'` (24h/200/1h block) — S.2.6 Resend cost-cap soft-throttle
  - `'delete_my_account'` (5min/3/5min block) — S.2.3 attempt-throttle
- **`evaluateRateLimit(ctx, endpoint, options)`** — counter-szintű evaluation, NEM ír counter-doc-ot, DE would-exceed ágon perzisztens block-doc-ot ír (a normál szekvenciális overflow így is blokkká válik). Returns `{ blocked, retryAfter }`.
- **`consumeRateLimit(ctx, endpoint, options)`** — counter +weight (`appendCounter`), race miatti overflow esetén block-doc.
- **`checkRateLimit(ctx, endpoint, options)`** — backward-compat shim (`acceptInvite` legacy hívása).
- **`extractClientIp(req)`** — XFF first-IP (Appwrite CF trusted header).
- **`hashSubject(s)`** — SHA-256 first 12 hex chars, logoláshoz (S.13.2 PII-redaction future-proof).
- **`blockDocId(subject, endpoint)`** — determinisztikus Appwrite-safe block docId: `rlb_${sha256(subject + '\0' + endpoint).slice(0, 32)}` (NUL-separator collision-mentes).
- **`alignedWindowStart(windowMs)`** — paraméterezett window-aligned ISO timestamp.
- **`readCounter(...)`** — lapozott (limit=100) counter-aggregate, `total += doc.count` (weighted).

`actions/invites.js` privát helperek:

- **`_checkInviteRateLimits(ctx, callerId, orgId, emailCount)`** — 3-scope evaluation: IP/user weight=1, org-day weight=emailCount.
- **`_consumeInviteRateLimits(ctx, callerId, orgId, emailCount)`** — 3-scope consume, csak ha az evaluation mind clean.

## Új response code-ok

- **429 `rate_limited`** — `{ scope: 'ip' | 'user' | 'org', retryAfter: ISOString }` payload.
- **400 `no_valid_emails`** — `createBatchInvites`-ben, ha a dedup után egyetlen érvényes email sincs (Codex M2 batch placement fix: malformed email NE égesse az org-day quota-t).

## Schema kompatibilitás

Az `ipRateLimitCounters` + `ipRateLimitBlocks` collection-ök változatlanok S.2.1 óta:
- `ip` (string, 64) — funkcionálisan "subject" (IP / userId / orgId)
- `endpoint` (string, 32) — pl. `'invite_send_org_day'` (19 char, befér)
- `windowStart` / `blockedAt` / `blockedUntil` — paraméterezett window-aligned

A `count` field (`integer, min: 0`) most ténylegesen használva: a `appendCounter` `weight` értékkel ír (1 vagy batch email-count). A `readCounter` `total += doc.count` (fallback 1 régi doc-okra). **Nincs schema migration** — backward-compat.

## Codex pre-review (`task-mp2*`)

A pre-review az alábbi 10 design-Q-ra felelt, az alábbi főbb verdiktekkel:

| Q | Verdict |
|---|---|
| Q1 Batch weight | **+N per email `invite_send_org_day`, +1 per CF call IP/user** — cost-cap email-volume, throttle CF-frequency |
| Q2 XFF skip-on-null | best-effort acceptable IP-scope-on (user/org subject jelen marad) |
| Q3 Batch=20 vs cap=200 | sufficient baseline, recovery path TBD |
| Q4 Counter race | acceptable best-effort (S.2.1 parity), gyengébb cost-control esetén |
| Q5 Block/window alignment | acceptable (`blockedUntil` source-of-truth) |
| Q6 Cleanup defer (S.2.5) | acceptable rövid-távon, 15k docs/hét tolerable |
| Q7 Cooldown UX | **AFTER pre-checks, BEFORE cleanup** (felülírva stop-time MAJOR 3-ra: NEM 24h hard, attempt-throttle) |
| Q8 endpoint 32 char | fits |
| Q9 subject 64 char | fits, hash future-composite |
| Q10 PII redaction | **hash-prefix now** (S.13.2 future-proof) |

**1 BLOCKER + 4 MAJOR + 4 MINOR + 2 NIT** finding, mind beépítve:

- **BLOCKER weight propagation** → `options.weight`, `count: weight` field, `readCounter` aggregate.
- **MAJOR M1 lockout-amplifikáció** → `evaluateRateLimit` + `consumeRateLimit` separáció (multi-scope: dry-eval all → consume after all-pass).
- **MAJOR M2 placement** → permission + email-validation + dedup UTÁN, expensive work (createCore / Resend-send / org-lookup) ELŐTT.
- **MAJOR M3 24h block** → `invite_send_user` / `invite_send_org_day` blockMs=1h soft-throttle (a 24h window megmarad).
- **MAJOR M4 subject + endpoint together** → minden query MINDIG `equal('ip', subject) + equal('endpoint', endpoint)`, soha NEM subject-only.
- MINOR subject naming → helper internals `subject`, schema column marad `ip`.
- MINOR XFF skip log → silent skip.
- MINOR retryAfter units → ISO timestamp (konzisztens `acceptInvite`-tel).
- NIT `Object.freeze(RATE_LIMIT_CONFIG)` → done.
- NIT `Unknown endpoint` → server-side `throw` (500, NEM user-facing policy).

## Codex stop-time review (`task-mp2*`) + fix-ek

| Severity | Finding | Fix |
|---|---|---|
| **BLOCKER** | Block doc ID `${subject}::${endpoint}` invalid Appwrite ID (`:` tiltott + lehet >36 char) → silent write-fail, mégis `blockedUntil`-t ad vissza | Új `blockDocId(subject, endpoint)`: `rlb_${sha256(subject + '\0' + endpoint).slice(0, 32)}` (36 char, `[A-Za-z0-9._-]` only). `createBlock` retval `null` write-bukáskor (hívó tudja, hogy NEM perzisztens). |
| **MAJOR 1** | `evaluateRateLimit` would-exceed → 429, de `consumeRateLimit` NEM fut → block-doc NEM perzisztens normál crossing-on | `evaluateRateLimit` would-exceed ágon `createBlock` ITT (multi-scope: első buktató scope blokkol, többi consume kihagyva — lockout-amplifikáció kerül). Race-safe idempotens block-doc. **Rename**: `checkRateLimitDry` → `evaluateRateLimit` (a `dry` szó konfúz, perzisztens block szándékos). |
| **MAJOR 2** | `createBatchInvites` org/inviter lookup rate-limit ELŐTT fut → 429 ág drága | Sorrend-csere: dedup + email-regex pre-filter + rate-limit ELŐSZÖR (in-memory + DB rate-counter), aztán `databases.getDocument(org)` + `usersApi.get(inviter)`. 429 ág NEM fizet érte. |
| **MAJOR 3** | `delete_my_account` 24h hard cooldown blokkolja a self-heal retry-t partial cleanup után | `RATE_LIMIT_CONFIG.delete_my_account`: 24h/1/24h → **5min/3/5min attempt-throttle**. Kézi retry megengedhető, paralel/loop spam NEM. |
| MINOR | XFF first-hop trust feltétel külön igazolás | Acknowledged: Appwrite CF trusted-XFF (platform-set, kliens NEM override-olható). Phase 2: `accept_invite`-ra opcionális token/email subject scope. |
| NIT | `schemas.js:1591-99` + `rateLimit.js:35-46` schema kommentek elavult counter ID minta | Frissítve: counter `sdk.ID.unique()` append-only, block `rlb_${sha256(...)}` determinisztikus. |

## Codex adversarial + simplify + verifying (harden Phase 4+5, 2026-05-11)

A user kérésére a teljes worktree-re (`zealous-euler-00c483` 3 commit) lefuttatott `/harden` pipeline: adversarial review (NEM baseline — exploit-keresés perspektívával) + simplify pass + verifying CLEAN.

### Adversarial findings (3 HIGH + 3 MEDIUM + 1 LOW + 8 CLEAN)

| Severity | Finding | Kategória + akció |
|---|---|---|
| **HIGH-1** | `invite_send_org_day` paralel batch overshoot (10 paralel batch × 20 email = 200 email-en túllőhet a 200-as 24h cap-en) | **Mitigated 2026-05-11** — DESIGN-Q user-döntés A: best-effort soft-throttle + Resend account-szintű hard-cap + S.13 monitoring alert (`org-day counter > 250`). Lásd a `## Accepted Risks` szekciót lent. B opció (atomikus slot-foglalás) vázlat is ott, re-evaluation trigger-rel. |
| **HIGH-2** | Rate-limit storage fail-open (Appwrite outage / hiányzó env / collection-permission hiba → minden rate-limit OFF, Resend cost-cap kikerülhető) | **MUST FIX** — `evaluateRateLimit` + `consumeRateLimit` top-level try/catch + `storageDown: true` retval. Cost-érzékeny scope-okon (`invite_send_*`, `delete_my_account`) 503 `rate_limit_storage_unavailable` fail-closed. `accept_invite` legacy `checkRateLimit` shim fail-open marad (token bruteforce mat. kizárt). |
| **HIGH-3** | `bootstrapRateLimitSchema` NEM hoz létre index-eket → productionban a counter/block query-k full-scan-re, doc-szám növekedésével CF timeout / DoS-vektor | **MUST FIX** — `createIndex` hívások: `subject_endpoint_window` (counters, `['ip', 'endpoint', 'windowStart']`) + `subject_endpoint_until` (blocks, `['ip', 'endpoint', 'blockedUntil']`). Type=`key` (composite szűrő). `indexesPending` aszinkron Appwrite attr-processing-re. |
| MED-1 | `sendInviteEmail` (manuális resend) NEM használ rate-limit-et — csak per-invite 60s `lastSentAt` cooldown, abuse-vektor sok pending invite + script | **SHOULD FIX** — multi-scope rate-limit hookoltunk a `sendInviteEmail` action-be (60s cooldown felett, weight=1). Két throttle ortogonális (per-recipient mailbox-flood vs per-actor cost-cap). |
| MED-2 | `TRUST_PROXY=1` Cloudflare+Railway esetén törékeny | **NOISE** — már doc-olt a [[ProxyHardening]] TODO szekciójában. Élesedés előtti env-config-kérdés. |
| MED-3 | `accept_invite` IP-only scope rotáló proxy farm DoS | **NOISE** — sikeres token-guess matematikailag kizárt (256-bit), CF futás cost throttle Appwrite-szintű opció. Phase 2 follow-up token/email scope-pal. |
| **LOW-1** | `wsUpgradeRateLimit` Map nincs hard cap (memory growth spoofed-XFF-fel) | **SHOULD FIX** — `WS_UPGRADE_MAX_KEYS=10_000`, LRU eviction `Map.keys().next().value` insertion-order alapján. Periodikus 60s cleanup mellett. |
| 8× CLEAN | WS gate / pathMatchesAny / cookie regex / redactUrl / denyUpgrade / createBlock race / tenant-isolation / hashSubject collision / delete-retry self-heal | — |

### Simplify pass (Reuse F2 + Efficiency F2 + F7)

- **Reuse F2 — generic `evaluateAndConsume(ctx, scopes)`** a `rateLimit.js`-ben. Mind a 4 hívóhely (createInvite + createBatchInvites + sendInviteEmail + deleteMyAccount) egységesen ezen át megy. 5-soros `if-storageDown / if-blocked / consume / if-storageDown` minta → 2-soros `if (rl) return fail(...)`. **Kombinálva Efficiency F2-vel**: a consume-fázis `Promise.all`-os (~100ms hot-path saving createInvite-en). Sequential evaluate megmarad (short-circuit + first-fail scope-tag attribution load-bearing). Codex M1 invariáns megőrizve (evaluate ALL → consume ALL ha mind clean).
- **`inviteRateLimits.js` lerövidül** egyetlen `inviteSendScopes(callerId, organizationId, emailCount)` factory-ra (a 3-scope endpoint-konfig DRY).
- **Efficiency F7 — `createBatchInvites` single-pass email-filter**: dedup → `for`-loop valid/invalid split (`validEmails` + `earlyResults`). Promise.all CSAK `validEmails`-en (NEM duplikált EMAIL_REGEX teszt a per-email Promise-on belül). Invalid email-ek azonnal `{ status: 'error', reason: 'invalid_email' }`-vel kerülnek a `results` listába.

### Verifying review

Első kör: 1 új NIT — árva `_checkInviteRateLimits` docblock a törölt helper helyén. Második kör (törlés után): **CLEAN**, 0 új BLOCKER / MAJOR / MINOR / NIT. Verify pontok:
- HIGH-2 fail-closed mind a 4 cost-érzékeny hívóhelyen ✓
- HIGH-3 indexek lefedik a counter + block query-mintákat ✓
- HIGH-1 továbbra is DESIGN-Q a verify-időpontban (NEM regresszió, ismert) ✓ — döntés azóta: Mitigated 2026-05-11, lásd `## Accepted Risks`
- MED-1 ortogonális 60s + multi-scope ✓
- LOW-1 bounded memory 10k + LRU ✓
- Simplify F2/F7 Codex M1 invariáns megmaradt ✓

## Codex verifying review (`task-mp2*`) — második fix

Első verifying review: **Fix 2 ❌ "nem javítva"** — a Codex a `checkRateLimitDry` névből szigorúbb "no-writes" semantikát várt, a would-exceed perzisztens block side-effect-nek jelölve.

**Fix**: **rename + docstring tisztázás** (NEM viselkedés-változtatás — a perzisztens block szándékos a MAJOR 1-hez):
- `checkRateLimitDry` → `evaluateRateLimit` (mindenhol cserélve: 1 helper + 2 hívó fájl)
- Docstring: "**NEM ír** counter-doc-ot (nincs `appendCounter`), DE a would-exceed ágon PERZISZTENS block-doc-ot ír — különben a normál szekvenciális overflow soha nem hozna létre block-doc-ot. Idempotens block (composite docId, updateDocument fallback) — race-safe két paralel hívóra."

Második verifying review: **CLEAN** (`grep checkRateLimitDry` 0 match, exports/imports konzisztens, docstring explicit a write-szándékot illetően).

## Accepted Risks

### R.S.2.15 — `invite_send_org_day` paralel batch overshoot (Mitigated 2026-05-11)

**Kockázat:** Az `evaluateRateLimit` → `consume` szekvencia NEM atomikus Appwrite-on. Ha 10+ paralel `createBatchInvites` hívás fut ugyanazon orgra ugyanazon CF-másodpercben, mindegyik `current=0`-t lát az evaluate-ben, mind átengedi, és a consume-fázis +20 +20 +20… email-kreditet ír → worst-case **+200 email overshoot** (összesen ~400 email/nap/org a 200-as soft-cap helyett).

**Likelihood:** Low (10+ paralel batch ugyanazon orgra ugyanazon másodpercben — extrém ritka Resend onboarding-flow-ban).
**Severity:** HIGH (Resend cost-cap soft-throttle, de bounded).

**DESIGN-Q döntés 2026-05-11 (user):** **A opció — best-effort soft-throttle megtartása** atomikus slot-foglalás helyett.

**Indoklás:**
1. **Bounded overshoot** — worst-case +200 email/nap/org, Resend pro plan-en ~$0.04 többletköltség/incidens.
2. **Resend account-szintű hard-cap** — Resend dashboard daily quota az ABSZOLÚT védvonal account-szinten (egyetlen org sem tudja kimeríteni a CF-rate-limit nélkül sem).
3. **Monitoring alert** — `org-day counter > 250` (25% overshoot threshold) az S.13 (logging/monitoring) blokk része lesz amúgy is.
4. **Komplexitás aránytalan** — atomikus slot-foglalás `inviteSendSlots` collection + retry-loop + cleanup-bővítés + per-email +30–50ms Appwrite latency (batch=20 → +600–1000ms hot-path) Low likelihood + alacsony cost-vonzatú kockázathoz.
5. **Iparági mainstream** — token-bucket / leaky-bucket throttling (Stripe, AWS API Gateway, Mailgun) best-effort; hard-cap csak account-szinten van.

**Re-evaluation trigger** — a döntés újratárgyalandó ha:
- Élesedés után incidens-volumen >1/hó (Slack alert),
- Resend költségvonzat észrevehetővé válik (>$5/hó org-overshoot kapcsán), vagy
- Jogi/compliance ok megköveteli a hard-cap-et per-org-szinten.

**B opció vázlat (atomikus slot-foglalás) — ha re-evaluation pozitív:**
- Új `inviteSendSlots` collection: `(orgId, dayBucket, slotNumber 0..199)` composite unique key.
- `consume` fázis helyett retry-loop: `createDocument` 411-conflict-ra re-read + retry, ha `slotNumber > 199` → 429.
- Cleanup CF (S.2.5 része) napi rotáció `dayBucket` szerint.
- Becsült munka: ~1 session implementáció + Codex pre+stop-time review + 1 új migration.

## Tervezett kockázat-tudomás

- **Counter accumulating** (S.2.5 done 2026-05-11): kb. 500 doc/CF/nap × 30 nap = ~15k counter-doc/hó. A `readCounter` lapozott (`limit=100` + cursor), egy 200-max scope-ban max 2 lap. **Cleanup CF napi futás** `$updatedAt < 48h` cutoff-fal — R.S.2.5 closed.
- **`evaluateRateLimit` would-exceed double-block** (két paralel `createBlock`): idempotens — composite docId, updateDocument fallback.
- **Hash collision** `hashSubject` 12-hex (48 bit): csak log-prefix, NEM security döntés. Acceptable.
- **`delete_my_account` partial cleanup + retry**: 3 attempt / 5 perc → 5 perc várakozás → újabb 3 attempt. Kézi self-heal retry: OK. Loop-spam: blokkolva.

## Cleanup CF (S.2.5, Done 2026-05-11)

Új scheduled CF: **`cleanup-rate-limits`** ([packages/maestro-server/functions/cleanup-rate-limits/src/main.js](../../packages/maestro-server/functions/cleanup-rate-limits/src/main.js)). Lejárt counter + block doc-ok periodikus törlése a két collection-ből.

- **Cron**: `0 2 * * *` UTC napi (a `cleanup-orphaned-locks` 3:00 előtt)
- **Timeout**: 300s (worst-case 2 × 2_000 delete × 30ms = 120s)
- **Specification**: `s-0.5vcpu-512mb` (mint a többi cleanup CF)
- **Scopes**: `databases.read`, `databases.write`

**Cleanup target — `$updatedAt` szűrés (Codex stop-time BLOCKER fix)**:
- `ipRateLimitCounters`: `$updatedAt < now - 48h` (24h max runtime-window + 24h grace). Append-only model (`appendCounter` minden hit-en új doc `sdk.ID.unique()`-vel), így `$createdAt ≈ $updatedAt` per-doc — `$updatedAt`-választás **jövőbiztos** (ha valaha update-elnénk a model-t).
- `ipRateLimitBlocks`: `$updatedAt < now - 6h` (1h max blockMs + 6× grace). `setBlock` `document_already_exists` ágon `updateDocument`-tel HOSSZABBÍTJA a meglévő determinisztikus-ID block-ot — ezért `$createdAt` stale (akár hetes), **kötelezően** `$updatedAt`-en szűrünk.

**Index-stratégia (Codex pre-review Opció Y)**: a `[ip, endpoint, ...]` composite indexek leftmost-prefix szabály miatt NEM hatékonyak `lessThan(time, ...)` lookupra. A `$updatedAt` system-mezőn system-index van — schema-bővítés NEM szükséges.

**Cap**: `MAX_DELETES_PER_COLLECTION=2_000`/futás. Codex pre-review BLOCKER (10_000 → ~10 perc, NEM fér 5 perc timeout-ba) csökkentve. Worst-case 2 × 2_000 × 30ms = 120s.

**dryRun**: `CLEANUP_DRY_RUN=1` env — első batch loggolása, NEM iterál tovább (infinite-loop guard, `listDocuments` ugyanazt adná).

**Admin email triggers** (`RESEND_API_KEY` + `ADMIN_NOTIFICATION_EMAIL` env): `failedAny` (permission-misconfig) **VAGY** `cappedAtAny` (folytatható következő futásban) **VAGY** `totalDeleted >= 1_000` (anomáliás volumen). Codex stop-time MAJOR fix: `failedAny` is trigger, hogy permission-incidens NE menjen csendben.

**Hibakezelés (ops-policy egységes `orphan-sweeper`-rel)**:
- `listDocuments` fail → `success: false` 500 + `stats.collectionScanFailed`
- per-doc `deleteDocument` 404 → idempotens (másik futás vagy konkurens cleanup), continue
- per-doc `deleteDocument` egyéb hiba → `stats.failed++` + log + continue, **futás végén** `hasFailure = collectionScanFailed.length > 0 || counters.failed > 0 || blocks.failed > 0` → 500 választ
- **no-progress guard**: ha egy iter 0 successful delete-tel zárul (mind 404/permission-failed), break — infinite-loop védelem

**Best-effort tolerable** (Codex stop-time MINOR, accepted): konkurens cleanup pont az egész első page-et 404-re zárhatja → no-progress guard break → későbbi eligible doc-ok a következő cronra maradnak. NEM correctness bug.

**Codex pipeline**: pre-review (1 BLOCKER cap + 2 MAJOR index/audit + 1 MINOR + 1 NIT) → implement → stop-time (1 BLOCKER `$updatedAt` + 1 MAJOR `failed`-handling + 1 MINOR tolerable + 1 NIT validation) → fixes → verifying (CLEAN + 1 doku NIT) → fixed.

## TODO (S blokk follow-up)

- **S.2.4** Appwrite-built-in login throttle audit (Console "Sessions Limit" beállítások) + alkalmazás-szintű login-fail counter.
- **`accept_invite` Phase 2 token/email scope** — a jelenlegi 5/15min/IP védelem az IP-scope-ra szűkül. Codex MINOR (S.2.7): ha az `X-Forwarded-For` valamilyen reason override-olható, token-szintű kiegészítő scope javasolt.
- **Recovery path `invite_send_org_day` 1h block** (Codex M3 alt): admin-only `clear_rate_limit_block` action — ha első incident jön onboarding-flow-ról, megfontolható.
- **`MAX_BATCH_INVITES=20` × `invite_send_org_day=200`** → 10 batch-call/org/day. Ha élesedéskor sok org tipikusan ennél több onboarding-emailt küld egy napon, a cap-et vagy a batch-méretet emelni kell.
- **`MAX_ORGS_PER_DELETE_CALL=10` + `delete_my_account` 3 attempt** → max 30 org per 5 perc fiók-törléskor. Ha élesedéskor sok user 10+ orgban tag, az UX-flow megfontolható (chunkolás).

## Kapcsolódó

- [[SecurityBaseline]] STRIDE CF sor — ASVS V11 (Communication), V13 (API), CIS 13
- [[SecurityRiskRegister]] R.S.2.2 / R.S.2.3 / R.S.2.5 / R.S.2.6 / R.S.2.7–2.14 closed; R.S.2.15 Mitigated (DESIGN-Q user-döntés, lásd fent)
- [[ProxyHardening]] — S.1 layer 1 (proxy), ez a layer 2 (CF)
- [[Feladatok#S.2 Rate-limit kiterjesztés CF-szinten (CRITICAL, 2 session) — ASVS V11/V13, CIS 13|S.2 Feladatok]]
- [[Döntések/0010-meghivasi-flow-redesign]] — ADR 0010 W2 IP-rate-limit alapja (S.2.1 forrás)
- [[Komponensek/PermissionHelpers]] — server-side permission guards (S.2 sorrendileg utáni)
