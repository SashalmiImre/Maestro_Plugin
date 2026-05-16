---
tags: [komponens, webhook, resend, svix, anti-replay]
related:
  - "[[Komponensek/SecurityBaseline]]"
  - "[[Komponensek/SecurityRiskRegister]]"
  - "[[Döntések/0010-meghivasi-flow-redesign]]"
---

# ResendWebhook — Resend bounce/delivery webhook + S.8 audit

## Kontextus

ADR 0010 W3 (2026-05-08) — Resend `email.sent` / `email.delivered` / `email.bounced` / `email.complained` event-eket fogad a `resend-webhook` CF. A `invite-to-organization` CF a `RESEND_API_KEY`-vel hív Resend-et, a webhook a delivery-state-et az `organizationInvites.lastDeliveryStatus`-be írja.

## S.8 audit (2026-05-15)

### S.8.1 — RESEND_WEBHOOK_SECRET deploy verify ✅

- Env-var: `RESEND_WEBHOOK_SECRET` `secret: true` 2026-05-08 12:01 (MCP-verified)
- HMAC verify svix-szintű (`svix-id`, `svix-timestamp`, `svix-signature`) main.js:142
- Production deployment `6a07828f` (2026-05-15 22:31, latest)

Rotation policy: **manual, 1× per év vagy incident-esetén**. Az új secret beállítása:
1. Resend dashboard > Webhooks > Edit > Generate new secret
2. Appwrite Console > Functions > resend-webhook > Variables > `RESEND_WEBHOOK_SECRET` update
3. Resend dashboard > Webhooks > Test event → CF execution log: HMAC PASS

### S.8.2 — Webhook IP-allowlist 🔓 (best-effort, doku-only)

A Resend NEM-ad fix IP-tartományt — a HMAC az autoritatív. A `webhook.maestro.emago.hu` custom domain Cloudflare/LiteSpeed-szintű IP-restriction **lehetséges**, de:
- A Resend IP-pool dinamikus (cloud-based)
- A HMAC verify már megakadályoz minden non-Resend POST-ot

**Decision**: NEM-implement IP-allowlist. A HMAC + idempotency-key elég.

### S.8.3 — Bounce / spam-complaint UI audit 🔓 (manual review)

A `organizationInviteHistory.lastDeliveryStatus` mező a Resend event-ekből származik. A Dashboard `InviteHistory` view (`InviteHistoryTab.jsx`) megjeleníti — manual review user-feladata, hogy a `bounced` + `complained` státusz UI-ban jelenjen meg.

**TODO USER-TASK**: Dashboard `InviteHistory` view ellenőrzése — bounced badge + filter.

### S.8.4 — Anti-replay (idempotency-key) ✅

**Threat**: a Resend webhook delivery újrapróbálkozhat ugyanazzal a `svix-id` header-rel (network-glitch, 5xx response). Az `updateDocument(invites)` idempotens (ugyanazt a `lastDeliveryStatus`-t írja), de log-zaj + perf-cost.

**Fix**: `webhookEventIds` collection idempotency-key store. A `svix-id` header mint `documentId` — első alkalom első-create, ismétlés `409` skip.

**Két-fázisú flow** (Codex stop-time BLOCKER fix 2026-05-15):

1. **LOOKUP** a `updateDocument(invites)` ELŐTT:
   ```javascript
   await databases.getDocument(env.databaseId, env.webhookEventIdsCollectionId, svixId);
   // Doc létezik → skipped: 'duplicate_event'
   // 404 Document → antiReplayAvailable = true (folytatás)
   // 404 Collection → log + continue (graceful-fallback)
   ```

2. **`updateDocument(invites, inviteId, updates)`** fő művelet — idempotens, többször-fut OK

3. **POST-WRITE marker** CSAK a sikeres `updateDocument` UTÁN:
   ```javascript
   if (svixId && antiReplayAvailable) {
       await databases.createDocument(env.databaseId, env.webhookEventIdsCollectionId, svixId, {
           eventType: type,
           processedAt: new Date().toISOString()
       });
       // 409 race → log, swallow
       // egyéb error → log, swallow (NEM-blocking)
   }
   ```

**Race-condition kezelés**:
- 2 concurrent webhook ugyanazzal svixId-vel → mindkettő `404 → antiReplayAvailable=true` → mindkettő idempotens `updateDocument(invites)` → első marker-write `200`, második `409` (swallow)
- Ha az `updateDocument` tranziens 500-zal elszáll → marker NEM-írt → Resend retry újra-feldolgozza (anti-replay NEM-blocking a retry-correctness ellen)

**Codex pipeline**:
- Stop-time + adversarial `addb4018281f2633a` BLOCKER (`createDocument` ELŐTT `updateDocument` → tranziens-fail-loss)
- Verifying `ae29b75757b86fe95` CLEAN (post-update marker minta)

### S.8.5 — Stop-time Codex review ✅

Új jegyzet (ez a fájl).

## Collection-create (USER-TASK / Phase 3)

A `webhookEventIds` collection **NEM-létezik** Appwrite Console-on jelenleg. A `resend-webhook` CF graceful-fallback: ha 404 Collection → anti-replay disabled, log-only.

**Schema (manual Console-create vagy `bootstrap_webhook_event_ids_schema` CF action)**:

```
Collection: webhookEventIds
  $id: <svix-id> (string, max 36, unique)
  eventType: string(64) (pl. "email.sent", "email.bounced")
  processedAt: datetime
  
Permissions: NONE (csak server SDK API key-jel ír)
Indexes: 
  - $createdAt (system) — retention cleanup-cron-hoz
```

**Retention**: 30 nap (Resend NEM-replay 30+ nap után). Phase 3: `cleanup-webhook-event-ids` CF (CRON, daily) — törli a `$createdAt < now - 30 napja` rekordokat.

## Hidden risks

- **A1 anti-replay nice-to-have, NEM-must**: idempotens `updateDocument` miatt a state-correctness OK retry-loop-ban is. Az anti-replay log-zaj + perf-csökkentés, NEM critical-path.
- **A2 retention policy**: jelenleg NEM-implement. Phase 3 `cleanup-webhook-event-ids` CF.
- **A3 svix-id injection**: HMAC verify a svix-id használat ELŐTT → Resend-verified. Plus Appwrite document-id-szabály `[a-zA-Z0-9._-]{1,36}` block-ja a special-char injekciókat.

## Kapcsolódó

- [[Döntések/0010-meghivasi-flow-redesign]] W3 (Resend integration + svix HMAC)
- [[Komponensek/SecurityRiskRegister]] R.S.8.1-4
- [[Tervek/user-task-runbook]] — `RESEND_WEBHOOK_SECRET` rotation (USER-TASK secret-rotation szekció)
- [[Tervek/autonomous-session-loop]]
