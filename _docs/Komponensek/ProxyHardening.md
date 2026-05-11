---
aliases: [Proxy Hardening, Proxy biztonság, S.1]
tags: [biztonság, proxy, S1]
status: Implemented
created: 2026-05-11
related: [SecurityBaseline, SecurityRiskRegister]
---

# Proxy Hardening (S.1)

> `packages/maestro-proxy/server.js` biztonsági szigorítása az S blokk S.1 al-pontjai szerint. Codex-egyeztetett design (`task-mp1jzea7-hzs4nn`). Implementáció 2026-05-11.

## Mit változtattunk

| ID | Változás | Korábbi állapot | Új állapot |
|---|---|---|---|
| **S.1.1** | CORS origin allowlist | `origin: true` (mindenki) | `Set` allowlist: `https://maestro.emago.hu` + `http://localhost:5173` + `null` (UXP, secondary guard alá) |
| **S.1.2** | `null` origin secondary guard | nincs | csak `/v1/realtime`-en + `X-Maestro-Client: indesign-plugin` header kötelező |
| **S.1.3** | Rate-limit auth-érintő path-eken | nincs | `express-rate-limit` memory-store, 7 path-szintű limiter |
| **S.1.4** | PII-redacted request log | `console.log(req.url)` | `redactUrl()` maszkolja a `x-fallback-cookies/token/email/...` query-paramokat |
| **S.1.5** | Per-route timeout | uniform 30s `/v1/*` | maradt 30s (Codex nem indokolta a változtatást) |
| **S.1.6** | `injectAuthenticationFromQueryParams()` szűkítés | minden path, raw-string fallback | csak `/v1/realtime`, 4KB cap, JSON-only, plain object, Appwrite session-key whitelist regex, **NO raw fallback** |

## Új helperek

`packages/maestro-proxy/server.js` tetején (`// --- S.1 Security helpers ---`):

- **`ALLOWED_ORIGINS`** — `Set` HTTPS/HTTP origin-ekkel
- **`NULL_ORIGIN_ALLOWED_PATHS`** — `null` origin csak ezeken
- **`FALLBACK_COOKIES_ALLOWED_PATHS`** — `x-fallback-cookies` csak Realtime upgrade-en
- **`REDACT_QUERY_KEYS`** — `Set` PII-érzékeny query-paramokkal
- **`FALLBACK_COOKIE_KEY_PATTERN`** — `/^a_session(_[a-z0-9]+)?(_legacy)?$/i` Appwrite session-cookie regex
- **`FALLBACK_COOKIES_MAX_BYTES`** — `4096` (4 KB)
- **`redactUrl(rawUrl)`** — `URL` parse + `searchParams.set('[REDACTED]')`, regex fallback
- **`validateAndBuildCookieHeader(rawValue)`** — méret-cap + JSON parse + plain-object + key-regex + value-charset

## Új rate-limit konfig

| Path | Window | Max | Indok |
|---|---|---|---|
| `/v1/account/sessions/email` | 15 min | 5 | Brute-force login védelem |
| `/v1/account/sessions` | 15 min | 20 | Session create / list / logout |
| `/v1/account/recovery` | 1 óra | 5 | Password reset abuse védelem |
| `/v1/account/verification` | 1 óra | 10 | Email verify spam védelem |
| `/v1/account` | 1 óra | 20 | Általános account-művelet |
| `/v1/realtime` | 1 min | 60 | WS upgrade limit (idle reconnect-OK) |
| `/v1/*` default | 15 min | 300 | Általános API throttle |

Sorrend: specifikus path-ek a default előtt mountolva (Express middleware sorrend).

## Új response code-ok

- **403 `cors_origin_denied`** — origin nem szerepel az allowlist-ben
- **403 `null_origin_path_denied`** — `null` origin nem-realtime path-en
- **403 `null_origin_client_required`** — `null` origin de hiányzik `X-Maestro-Client`
- **429 `rate_limit_exceeded`** — `Too many requests`

## Codex pre-review összegzés (`task-mp1jzea7-hzs4nn`)

- **CORS allowlist**: javasolta a `Set`-mintát, a `null` origin engedését secondary guard alá tolva. Indoklás: ASVS V13 + jelenlegi nincs-éles pre-prod állapot.
- **`x-fallback-cookies`**: kifejezetten kérte hogy CSAK `/v1/realtime`-on legyen, mert URL-ben cookie-átadás "URL log, reverse proxy access log, browser history, hibajelentés"-be szivároghat. A raw-string fallback (`catch { setHeader('Cookie', rawValue) }`) "túl engedékeny" — eltávolítva.
- **Rate-limit**: memory-store S.1-re elég (egyetlen Railway instance), de **dokumentált Redis upgrade path** ha multi-instance. Konkrét limit-értékek átvéve.
- **PII-redaction**: saját `URL`-based redactor a regex helyett. Pino refactor NEM blocker — egy későbbi session.

## Codex stop-time review (`task-mp1k8f73-rdtj2x`) + fix-ek

| Severity | Finding | Fix |
|---|---|---|
| **BLOCKER** | WS upgrade event NEM megy át az Express middleware láncon → CORS/null-guard/rate-limit WS-re bypassolható | `server.on('upgrade', ...)` explicit gate: path/origin/`X-Maestro-Client`/rate-limit ellenőrzés után `wsProxy.upgrade()`. Új helper: `extractClientIp()`, `checkWsUpgradeRateLimit()`, `denyUpgrade()`. `app.use('/v1/realtime', wsProxy)` mount eltávolítva (az auto-subscribe forrása volt). |
| **MAJOR** | `trust proxy` hiány → Railway/Cloudflare mögött `req.ip` self-DoS-szal egyenlő | `app.set('trust proxy', TRUST_PROXY)` (default `1`, env-overrideelt). |
| **MAJOR** | Globális `express.urlencoded()` body parser a rate-limit ELŐTT fut → DoS-cost parse-on | Globális body parser **eltávolítva** — `/reset-password` POST 410-zel válaszol body nélkül, más POST-ok route-szintű parserrel. |
| **MAJOR** | `X-Maestro-Client` + null origin spoofolható → nem-böngészős kliens hamisíthatja | **Tudomásul véve és dokumentálva** (jelenlegi best-effort kliens-azonosító). Phase 2 follow-up: per-deployment shared-secret HMAC + timestamp. Kommentben jelölve. |
| **MAJOR** | Cookie value regex `^[A-Za-z0-9\-._~]*$` túl szűk → legitim base64 session érték elesik | RFC 6265 cookie-octet `COOKIE_VALUE_OCTET = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/` — engedett: `+`, `/`, `=`, `%`, kivéve CTL/space/`"`/`,`/`;`/`\`. |
| **MINOR** | `startsWith('/v1/realtime')` → `/v1/realtimeevil` átment | `pathMatchesAny()` helper: `path === p || path.startsWith(p + '/')` segment-boundary. Mind a 3 használati helyen alkalmazva. |
| **MINOR** | `redactUrl()` regex fallback nem fedi a teljes `REDACT_QUERY_KEYS` Set-et | `REDACT_QUERY_REGEX` Set-ből dinamikusan generálva (`new RegExp(...)`), így mindig szinkronban. |
| **NIT** | `new URL()` per-request micro-cost | `if (!url.search) return rawUrl;` early return. |
| **NIT** | Memory-store multi-instance limit | Dokumentált Phase 2 Redis upgrade (lent). |

**Új helpers** (a stop-time fix után):
- `COOKIE_VALUE_OCTET` — RFC 6265 strict cookie-value
- `REDACT_QUERY_REGEX` — Set-ből generált fallback regex
- `pathMatchesAny()` — segment-boundary path matcher
- `WS_UPGRADE_WINDOW_MS` / `WS_UPGRADE_MAX` / `wsUpgradeRateLimit` Map + `checkWsUpgradeRateLimit()` — WS upgrade rate-limiter
- `extractClientIp()` — `trust proxy`-tudatos IP-extrakció
- `denyUpgrade()` — WS upgrade close response helper
- Periodikus takarítás (`setInterval(...).unref()`) — `wsUpgradeRateLimit` Map memory-leak ellen

**WS upgrade gate logika** (server.js `server.on('upgrade', ...)`):
1. Path segment-boundary check (`NULL_ORIGIN_ALLOWED_PATHS`)
2. Origin allowlist (`ALLOWED_ORIGINS` + `null` engedett secondary guard alá)
3. `null` origin → `X-Maestro-Client: indesign-plugin` header kötelező
4. Per-IP rate-limit 60/perc
5. Mindenki zöld → `wsProxy.upgrade(req, socket, head)`

## Codex verifying review (`task-mp1kn806-x09za4`) — második fix

A stop-time fix-ek verifying check-jén az `extractClientIp()` MAJOR-ként előjött: az egyszerű XFF-first parsing spoofolható nem-böngészős klienssel (mert nem azonos az Express `req.ip` resolution-vel hop-szám alapján). Plusz egy NIT a `denyUpgrade`-ben (flush-garancia hiányzott).

**Fix-ek**:
- **`extractClientIp()` proxy-addr alapra**: `app.get('trust proxy fn')` — az Express belső resolved trust-function (`(ip, distance) => boolean`), átadva a `proxyAddr(req, trustFn)`-nek. Ugyanazon hop-szemantika mint a HTTP `req.ip` resolution. Új require: `const proxyAddr = require('proxy-addr')` (Express tranzitív dep, már elérhető).
- **`denyUpgrade()` graceful flush**: `socket.end()` (FIN packet, response flush) + `setTimeout(() => socket.destroy(), 50).unref()` (50ms after force-cleanup ha még nem closed).

**Verify-state**: a verifying Codex review szerint a többi (cookie regex, body parser, segment-boundary, redactUrl Set-sync, WS gate) **CLEAN**. Egyetlen maradt MAJOR az extractClientIp volt — most javítva.

## TODO (S blokk follow-up)

- **S.1 Phase 2** (Redis upgrade): ha Railway + emago.hu fallback egyszerre élesedik (multi-instance), `rate-limit-redis` store HTTP `express-rate-limit`-re + külön Redis-store a `wsUpgradeRateLimit` Map-re (vagy egységes shared store). Trigger: első multi-instance deploy.
- **S.13.2 PII-redaction továbbfejlesztés**: `pino` strukturált logger redactor-okkal, az AI klaszterezés + layout AI route szintén PII-redacted formatot.
- **`X-Maestro-Client` HMAC-upgrade**: a jelenlegi guard nem-böngészős klienst nem akadályoz meg (UXP-spec). Per-deployment shared-secret HMAC + timestamp Codex-javasolt — defer Phase 2. Új header pl. `X-Maestro-Signature: <hmac-sha256(secret, ts+path+ip)>` + `X-Maestro-Timestamp: <unix-sec>` (5min skew). Tárolt secret az UXP plugin build-time-ban (manifest-ben tilos, embedded constants-ben kötelező obfuszkálva). Plugin oldali implementáció: `crypto-js` HMAC. Trigger: amikor production-szintű deploy + adatos user érkezik.
- **`TRUST_PROXY` hop-szám audit** — Railway egyetlen hop, de Cloudflare + Railway esetén 2. Verify a tényleges deploy environment-ben (élesedés előtt).

## Kapcsolódó

- [[SecurityBaseline]] STRIDE Proxy sor
- [[SecurityRiskRegister]] R.S.1.1–R.S.1.4, R.S.1.6 zárása
- [[Feladatok#S.1 CORS + proxy szigorítás (CRITICAL, 2 session) — ASVS V5/V13, CIS 4/8/12|S.1 Feladatok]]
- [[Hálózat]] — proxy architektúra MOC
- [[Döntések/0001-dual-proxy-failover]] — Railway + emago.hu fallback
