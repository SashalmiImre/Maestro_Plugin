---
tags: [terv, session-prompt, S-blokk, webhook, resend]
target: S.8
created: 2026-05-15
---

# Új session — S.8 Webhook + 3rd party trust audit (MEDIUM, 1 session)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

A Resend webhook + 3rd party (Resend SDK) integráció audit-ja. ADR 0010 W3 + 2026-05-08 deploy óta éles. A `resend-webhook` CF kezeli a `email.sent` + `email.delivered` event-eket; a `invite-to-organization` CF a `RESEND_API_KEY`-vel hív Resend-et.

## Scope (5 al-pont)

### S.8.1 — `RESEND_WEBHOOK_SECRET` deploy verify

**Cél**: ellenőrizni hogy a `RESEND_WEBHOOK_SECRET` env var élesen kötve van-e a `resend-webhook` CF-en, és rotáció policy definiálva van-e.

**Lépések**:
1. `mcp__appwrite-api__appwrite_call_tool functions_get function_id=resend-webhook` — `vars` listáz `RESEND_WEBHOOK_SECRET` van-e
2. Rotáció policy: 1× per év? Per-incident?
3. Update `[[Komponensek/SecretsRotation]]` (új jegyzet vagy bővítés)

### S.8.2 — Webhook custom domain IP-allowlist

**Cél**: a `webhook.maestro.emago.hu` custom domain elérhető-e CSAK Resend IP-tartományról? **Best-effort**: a Resend NEM-ad fix IP-listát (HMAC az autoritatív). Doku-szintű.

**Lépések**:
1. Resend IP-tartomány doku: https://resend.com/docs/dashboard/webhooks/introduction
2. Cloudflare/LiteSpeed-szintű IP-block ha lehetséges (NEM kritikus, mert HMAC védi)
3. Dokumentálás `[[Komponensek/ResendWebhook]]` (új jegyzet)

### S.8.3 — Bounce / spam-complaint kezelés audit

**Cél**: a UI mutatja-e a `bounced` státuszt? A Resend API rebound-idempotency rendben van-e?

**Lépések**:
1. Dashboard `InviteHistory` view audit — `bounced` / `complained` státusz látható?
2. `organizationInviteHistory.lastDeliveryStatus` mező használat
3. `resend-webhook` CF `event.type` switch case-ek mind kezelve?

### S.8.4 — Idempotency-key tárolás (anti-replay)

**Cél**: a Resend webhook event-eknek `id` payload-mezője van. Új `webhookEventIds` collection — anti-replay: ha ugyanaz az event-id második feldolgozás-kor jön, skip.

**Lépések**:
1. Új collection `webhookEventIds` (key: `eventId` string, indexed)
2. `resend-webhook` CF: első action `getDocument('webhookEventIds', eventId)`; ha létezik, return `{ success: true, skipped: 'duplicate_event' }`
3. Event-id retention: 30 nap (rolling cleanup-cron — `cleanup-webhook-event-ids` CF)
4. Dokumentálás `[[Komponensek/ResendWebhook]]`

### S.8.5 — Stop-time Codex review

Új/bővített jegyzet: `_docs/Komponensek/ResendWebhook.md`.

## Codex pre-review Q-k

**Q1**: A `RESEND_WEBHOOK_SECRET` rotáció policy — manual vs auto-rotate? Default: **manual** (1× per év, vagy incident esetén; manual a runbook-on).

**Q2**: A `webhookEventIds` collection scope — globális (NEM-tenant-scoped, mert Resend event-id-k unikálisak across all tenants). Default: igen, globális collection.

**Q3**: 30-nap retention elég? A Resend NEM-replay 30+ nap után. Default: igen, plus Phase-2-ben anomaly-detection (S.13.6) integration.

**Q4**: A `cleanup-webhook-event-ids` CF NEW — kell-e, vagy a `cleanup-rate-limits` mintán bővíthető? Default: új CF, mert eltérő schema + lifecycle.

## STOP feltételek

- S.8.4 collection-create USER-TASK (Appwrite Console-on schema-create vagy `bootstrap_webhook_event_ids_schema` CF action) → flag.
- S.8.2 Cloudflare IP-block USER-TASK → flag.

## Becsült időtartam

~30-45 perc (S.8.1-5 mind audit + minimal code, plus ResendWebhook.md jegyzet).

## Kapcsolódó

- [[Feladatok#S.8]]
- [[Döntések/0010-meghivasi-flow-redesign]] W3 (Resend integration)
- [[Komponensek/SecurityRiskRegister]] R.S.8.x
- [[Tervek/autonomous-session-loop]]
