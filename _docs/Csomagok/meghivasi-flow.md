---
tags: [moc, csomag, deploy]
status: Accepted
date: 2026-05-08
---

# Meghívási flow (ADR 0010 W2/W3)

Discord-szerű felugró ablakos meghívási rendszer Resend EU e-mail-küldéssel és IP-alapú brute-force védelemmel. Az ADR 0010 implementációja.

## Felépítés

| Réteg | Komponens | Forrás |
|---|---|---|
| **UI** | [[Komponensek/InviteModal\|InviteModal]] (multi-invite max 20, lejárat 1/3/7) | `packages/maestro-dashboard/src/components/organization/InviteModal.jsx` |
| **UI** | [[Komponensek/UsersTab\|UsersTab]] modal-launcher gomb + delivery status badge + Újraküldés | `packages/maestro-dashboard/src/components/organization/UsersTab.jsx` |
| **API** | `useAuth().createBatchInvites` + `resendInviteEmail` | `packages/maestro-dashboard/src/contexts/AuthContext.jsx` |
| **CF** | `create` / `create_batch_invites` / `accept` / `send_invite_email` action-ök | `packages/maestro-server/functions/invite-to-organization/src/actions/invites.js` + `sendEmail.js` |
| **CF** | IP-rate-limit middleware | `packages/maestro-server/functions/invite-to-organization/src/helpers/rateLimit.js` |
| **CF** | Resend bounce/delivery webhook (külön function) | `packages/maestro-server/functions/resend-webhook/src/main.js` |
| **DNS** | DKIM + SPF + DMARC az `maestro.emago.hu`-n | cpanel `emago.hu` zóna |
| **Vendor** | Resend EU (eu-west-1 / Dublin) | `noreply@maestro.emago.hu` feladócím |

## Deploy útmutató (W2 + W3 élesítés)

### 1) Appwrite Cloud — séma-bővítés (CF action-ön át)

Az `invite-to-organization` CF függvényt **az új kóddal deploy-old** (Appwrite CLI vagy Console). Utána egy bejelentkezett owner egy admin POST hívással hívja:

```bash
# bootstrap_invites_schema_v2 — 4+1 új mező az organizationInvites collectionön
curl -X POST 'https://api.maestro.emago.hu/v1/functions/invite-to-organization/executions' \
  -H 'Cookie: a_session_<projectId>=<sessionToken>' \
  -d '{"action":"bootstrap_invites_schema_v2"}'

# bootstrap_rate_limit_schema — 2 új collection (counters + blocks)
curl -X POST 'https://api.maestro.emago.hu/v1/functions/invite-to-organization/executions' \
  -H 'Cookie: a_session_<projectId>=<sessionToken>' \
  -d '{"action":"bootstrap_rate_limit_schema"}'
```

Vagy Appwrite Console UI-ról: **Functions → invite-to-organization → Executions → New** payloaddal.

Mind idempotens — már létező mezők/collectionek esetén `skipped`-re állítja.

### 2) Új env varok az `invite-to-organization` CF-en

Appwrite Console → Functions → invite-to-organization → Settings → Variables:

| Név | Érték | Forrás |
|---|---|---|
| `DASHBOARD_URL` | `https://maestro.emago.hu` | A Resend e-mail link `${url}/invite?token=...` épít |
| `RESEND_API_KEY` | `re_...` (Resend Dashboard → API Keys) | Resend SDK auth — ld. ADR 0010 |
| `IP_RATE_LIMIT_COUNTERS_COLLECTION_ID` | `ipRateLimitCounters` (a 1-es lépésben kapott ID) | rateLimit.js |
| `IP_RATE_LIMIT_BLOCKS_COLLECTION_ID` | `ipRateLimitBlocks` (a 1-es lépésben kapott ID) | rateLimit.js |

A `RESEND_API_KEY` hiányában a sendOneInviteEmail skeleton-fallback-en megy (invite létrejön, e-mail nem küldődik).

### 3) Új CF function deploy: `resend-webhook`

```bash
appwrite functions create \
  --functionId resend-webhook \
  --name 'Resend Bounce/Delivery Webhook' \
  --runtime node-20.0 \
  --execute any \
  --logging true \
  --timeout 30
```

Aztán deploy a `packages/maestro-server/functions/resend-webhook/` tartalmából (Appwrite CLI: `appwrite functions create-deployment --functionId resend-webhook --code packages/maestro-server/functions/resend-webhook --activate true`).

**Env varok az új CF-en**:

| Név | Érték |
|---|---|
| `APPWRITE_API_KEY` | dynamic API key (project Settings) |
| `APPWRITE_FUNCTION_API_ENDPOINT` | `https://api.maestro.emago.hu/v1` |
| `APPWRITE_FUNCTION_PROJECT_ID` | (project ID) |
| `APPWRITE_DATABASE_ID` | (database ID) |
| `INVITES_COLLECTION_ID` | `organizationInvites` |
| `RESEND_WEBHOOK_SECRET` | `whsec_...` (a 4-es lépésben generált) |

**Permission: Execute Access = Any** (a webhook public — Svix HMAC verify a payload szignatúráján védi).

### 4) Resend Dashboard → Webhooks setup

1. Resend Dashboard → **Webhooks** → **Add Endpoint**
2. URL: `https://api.maestro.emago.hu/v1/functions/resend-webhook/executions`
3. Events: `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`
4. **Signing Secret** — a Resend generál egy `whsec_...` secret-et. Másold a 3-as lépésben az új CF env varjába (`RESEND_WEBHOOK_SECRET`).

### 5) End-to-end teszt

1. Dashboardon új admin meghívást küldesz a saját másik email-címedre (pl. személyes Gmail).
2. Az e-mail néhány másodpercen belül megérkezik az Inbox-ba (NEM Spam).
3. Kattints a "Meghívó elfogadása" gombra → `accept_invite` flow.
4. UsersTab listán a függő meghívó eltűnik (status `accepted`-re ugrik).
5. **Bounce-szimuláció** (Resend test): küldj meghívót `bounce@simulator.amazonses.com`-ra. A delivery-status `bounced`-re vált a UI-on.

### 6) IP-rate-limit teszt

Egy másik IP-ről (pl. mobil hotspot) próbálj egymás után 6× érvénytelen tokennel `accept_invite`-ot hívni. A 6. hívás 429 `rate_limited` választ kell, hogy adjon.

## Architektúra-jegyzetek

### Auto-send flow (`createInvite` + `createBatchInvites`)

A frontend egy CF round-trippel kap mindent:
1. CF létrehozza az invite rekordot (`lastDeliveryStatus='pending'`, `sendCount=0`)
2. CF azonnal hívja a `sendOneInviteEmail`-t (best-effort, nem blokkoló)
3. A `sendOneInviteEmail` frissíti a `lastDeliveryStatus`-t (`sent`/`failed`)
4. A CF response a frontend felé tartalmazza a `deliveryStatus`-t

### Bounce-tracking flow

1. Resend egy konkrét e-mail-eseményt szimulál (delivered / bounced)
2. Resend POST-ol a webhook URL-re a Svix-szignált payloaddal
3. Az új `resend-webhook` CF Svix HMAC verify-t fut
4. Verify után a CF a `data.tags`-ban lévő `invite_id`-vel updateolja a `organizationInvites.lastDeliveryStatus`-t
5. A Dashboard Realtime cross-tab szinkron a UI-t

### IP-rate-limit flow (`accept_invite`)

1. Frontend `accept_invite` CF hívás
2. CF `checkRateLimit(ctx, 'accept_invite')` middleware:
   - X-Forwarded-For header → IP
   - 1) `ipRateLimitBlocks`-ban aktív blokk? → 429 `rate_limited`
   - 2) `ipRateLimitCounters`-ben increment a `${ip}::accept_invite::${windowStart}` doc-on
   - 3) Counter > 5 → `ipRateLimitBlocks`-ba új doc (1 órás block)
3. Ha minden OK, a többi accept-logika (token lookup, expiry, e-mail match, membership create) fut

## Kapcsolódó

- ADR: [[Döntések/0010-meghivasi-flow-redesign]]
- Komponensek: [[Komponensek/InviteCollection]], [[Komponensek/InviteModal]]
- Memory: `meghivasi-flow-redesign.md`
- Resend domain DNS: `maestro.emago.hu` (DKIM TXT `resend._domainkey.maestro`, SPF MX+TXT `send.maestro`, DMARC TXT `_dmarc`)
