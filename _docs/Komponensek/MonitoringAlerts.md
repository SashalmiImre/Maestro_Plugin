---
tags: [komponens, monitoring, alerts, observability]
related:
  - "[[Komponensek/LoggingMonitoring]]"
  - "[[Komponensek/SecurityRiskRegister]]"
---

# MonitoringAlerts — Alert-rule spec (S.13.4)

> **Status**: design-only — implementation S.13.1 (central log aggregator) tool-decision UTÁN.

## Kontextus

ASVS V7 + CIS Controls 8. A jelenlegi log-flow (Appwrite CF executions + Railway proxy) **passzív** — manuális monitoring. **Aktív alerting** szükséges a kritikus security-érzékeny event-ekhez: rate-limit spike, login-fail spike, CF failure rate, WebSocket disconnect rate.

## Alert-rule spec

### A1 — CF failure rate spike

**Trigger**: Appwrite Functions execution `failed` status rate > 5% / 5 perces ablak.
- Source: Appwrite Console > Functions > Executions (vagy webhook ha integrált)
- Logic: `count(status=failed) / count(*) > 0.05`
- Threshold tuning: 50+ executions / 5 perc minimum (kevés trafic → no-alert)

**Action**: Slack (#maestro-incidents) + PagerDuty L2.

**False-positive risk**: low — CF failure rate jellemzően <0.5%-on.

### A2 — Login-fail spike

**Trigger**: Appwrite Auth `createSession` failure rate > 10 / perc.
- Source: Appwrite Console > Auth > Sessions (audit log) — failed login `code: 401`
- Logic: rolling 5-perces window-on count > 50 fail

**Action**: Slack (#maestro-incidents) — **NEM PagerDuty** (false-positive: legitim user-elfelejtett-jelszó).

**False-positive risk**: medium — brute-force vs. user-error megkülönböztetés challenge. Plus a Console default-on login-throttle aktív.

### A3 — Rate-limit trigger spike

**Trigger**: `ipRateLimitBlocks` collection write-rate > 5 / perc.
- Source: Appwrite Realtime channel (`databases.<id>.collections.ipRateLimitBlocks.documents`)
- Logic: új-block-doc create-rate > 5 / perc 3 egymás utáni window-ban

**Action**: Slack + log-tag `R.S.2.x rate-limit-incident`.

**False-positive risk**: low — legitim user nem hit-eli a rate-limit-et.

### A4 — WebSocket disconnect rate

**Trigger**: Appwrite Realtime `connection.close` rate > 30% / 10 perc.
- Source: Realtime client `onReconnect` handler instrument
- Logic: 1000 active WS / 300 disconnect-in-10-min → alert

**Action**: Slack + Railway proxy log scan (CDN / network issue?).

**False-positive risk**: medium — mobile-user network-switch (WiFi / 4G) természetes disconnect.

### A5 — Invite-send rate anomaly (S.13.6 előzmény)

**Trigger**: `organizationInvites` create-rate > 50 / org / nap.
- Source: Realtime channel + per-org aggregate
- Logic: 7-napi átlag + standard-deviation outlier

**Action**: Slack — admin manual review.

**False-positive risk**: high — onboard-burst legitim (új-szervezet, 30 user-meghívása egyszerre). Phase 2 ML-based anomaly detection (S.13.6 defer).

## Implementation map (S.13.1 tool-decision UTÁN)

| Alert | Sentry | Better Stack | Grafana Loki + Promtail |
|---|---|---|---|
| A1 CF failure | webhook-based (Appwrite → Sentry custom-integration) | Log-tail + alert-rule UI | Loki + Alertmanager |
| A2 Login-fail | ❌ NEM-out-of-box | ✅ log-pattern matching | ✅ regex-rule |
| A3 Rate-limit | ❌ NEM-out-of-box | ✅ log-tail | ✅ |
| A4 WS disconnect | ✅ Sentry Performance | ❌ NEM-out-of-box | ✅ Prometheus-pull |
| A5 Invite-rate | ❌ NEM-out-of-box | ✅ aggregated metric | ✅ Loki LogQL |

**Decision-pending** (S.13.1): Better Stack vs Grafana Loki. Sentry NEM-jó (specifikus Frontend-error tracking, NEM-general-purpose log alert).

## Notification channels

- **Slack** (#maestro-incidents): minden alert real-time, low-friction
- **PagerDuty L2**: csak A1 CF-failure (production-down-szintű)
- **Email** (`security@emago.hu`): daily digest a Slack-feed-ről + weekly summary

## Runbook (alert-fired)

1. **Slack alert érkezik** → 5 perces window — verify a Console-on (false-positive check)
2. **True positive**: incident-channel-be eskalálódik, on-call developer reagál
3. **Post-incident**: `_docs/Naplók/YYYY-MM-DD.md` incident-entry + lessons-learned

## Implementation pseudocode (S.13.4 Phase 3 trigger)

> **Platform-agnostic JSON-DSL** — adaptálható Better Stack alert-rule YAML-ra, Grafana Loki LogQL + Alertmanager YAML-ra, vagy custom webhook-listener Node.js handler-re. A `query.fields` Appwrite CF execution + Realtime payload + proxy log struktúrákat tükrözi.

### Common source-config

```jsonc
{
    "sources": [
        {
            "id": "appwrite-cf-executions",
            "type": "appwrite-webhook",
            "url": "https://webhook.maestro.emago.hu/cf-exec",
            "fields": ["functionId", "status", "duration", "trigger", "$createdAt"]
        },
        {
            "id": "appwrite-auth-events",
            "type": "appwrite-realtime",
            "channel": "users",
            "fields": ["userId", "event", "ipAddress", "$createdAt"]
        },
        {
            "id": "appwrite-realtime-blocks",
            "type": "appwrite-realtime",
            "channel": "databases.<id>.collections.ipRateLimitBlocks.documents",
            "fields": ["ip", "scope", "blockedAt", "$createdAt"]
        },
        {
            "id": "railway-proxy-logs",
            "type": "log-tail",
            "url": "https://gallant-balance-production-b513.up.railway.app/logs",
            "fields": ["timestamp", "level", "event", "wsClientId"]
        },
        {
            "id": "appwrite-invite-events",
            "type": "appwrite-realtime",
            "channel": "databases.<id>.collections.organizationInvites.documents",
            "fields": ["organizationId", "email", "$createdAt"]
        }
    ]
}
```

### A1 — CF failure rate

```jsonc
{
    "id": "alert-a1-cf-failure-rate",
    "name": "A1: CF failure rate >5% / 5min",
    "source_id": "appwrite-cf-executions",
    "window": "5m",
    "min_sample_size": 50,
    "threshold": {
        "type": "ratio",
        "numerator_filter": "status == 'failed'",
        "denominator_filter": "*",
        "operator": ">",
        "value": 0.05
    },
    "actions": [
        { "type": "slack", "channel": "#maestro-incidents" },
        { "type": "pagerduty", "service_key": "${PD_L2_KEY}" }
    ]
}
```

### A2 — Login-fail spike

```jsonc
{
    "id": "alert-a2-login-fail",
    "name": "A2: Login fail >50 / 5min",
    "source_id": "appwrite-auth-events",
    "window": "5m",
    "filter": "event == 'session.create.failed' OR event == 'session.create' AND status == 401",
    "threshold": {
        "type": "count",
        "operator": ">",
        "value": 50
    },
    "actions": [
        { "type": "slack", "channel": "#maestro-incidents" }
    ],
    "notes": "NEM PagerDuty — user-elfelejtett-jelszó false-positive risk."
}
```

### A3 — Rate-limit block spike

```jsonc
{
    "id": "alert-a3-rate-limit-block",
    "name": "A3: ipRateLimitBlocks create >5 / perc 3 window",
    "source_id": "appwrite-realtime-blocks",
    "filter": "event == 'document.create'",
    "window": "1m",
    "threshold": {
        "type": "count",
        "operator": ">",
        "value": 5
    },
    "persistence": "3-of-3",
    "actions": [
        { "type": "slack", "channel": "#maestro-incidents", "tags": ["R.S.2.x"] }
    ]
}
```

### A4 — WS disconnect rate

```jsonc
{
    "id": "alert-a4-ws-disconnect",
    "name": "A4: WS disconnect rate >30% / 10min",
    "source_id": "railway-proxy-logs",
    "window": "10m",
    "min_sample_size": 100,
    "threshold": {
        "type": "ratio",
        "numerator_filter": "event == 'ws.close' AND code != 1000",
        "denominator_filter": "event == 'ws.close' OR event == 'ws.open'",
        "operator": ">",
        "value": 0.30
    },
    "actions": [
        { "type": "slack", "channel": "#maestro-incidents" },
        { "type": "webhook", "url": "https://internal.maestro.emago.hu/cdn-log-scan" }
    ]
}
```

### A5 — Invite-send anomaly

```jsonc
{
    "id": "alert-a5-invite-anomaly",
    "name": "A5: Invite create >50 / org / nap (7d baseline outlier)",
    "source_id": "appwrite-invite-events",
    "filter": "event == 'document.create'",
    "window": "1d",
    "group_by": "organizationId",
    "threshold": {
        "type": "anomaly",
        "baseline_window": "7d",
        "operator": ">",
        "value": 50,
        "stddev_multiplier": 2.0
    },
    "actions": [
        { "type": "slack", "channel": "#maestro-incidents", "manual_review": true }
    ],
    "notes": "Phase 2 ML-based anomaly detection (S.13.6 defer)."
}
```

### Webhook-receiver implementation skeleton (Node.js, ha custom)

```js
// packages/maestro-server/functions/monitoring-alert-receiver/src/main.js (NEM-implementált)
// Trigger: HTTP POST {alertId, threshold, samples, firedAt}
// Verify HMAC: req.headers['x-bs-signature'] vs HMAC_SECRET (S.8 minta)
// Dispatch: Slack webhook + (opt) PagerDuty Events API
// Audit: createDocument(monitoringAlertHistory) — actionAuditLog (S.10.5) integrate
```

**Phase 3 trigger**: első incident vagy Better Stack paid plan upgrade (USER-TASK 13).

## Kapcsolódó

- [[Feladatok#S.13]]
- [[Komponensek/LoggingMonitoring]] S.13.2+13.3 already-Closed (PII-redaction + info-disclosure)
- [[Komponensek/SecurityRiskRegister]] R.S.13.4
