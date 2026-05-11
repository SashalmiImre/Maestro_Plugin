---
aliases: [Risk Register, Biztonsági kockázat-leltár]
tags: [biztonság, kockázat, register]
status: Draft
created: 2026-05-11
---

# Security Risk Register

> Minden ismert biztonsági gap egy sorban. Severity × Likelihood = Risk. Forrás: 3 párhuzamos Explore agent + Codex review 2026-05-11. Cross-link: [[Komponensek/SecurityBaseline]].

## Severity skála

- **CRITICAL** — adatszivárgás, jogosulatlan hozzáférés, vagy szolgáltatás-leállás bizonyítottan kihasználható módon.
- **HIGH** — magas valószínűségű támadási vektor, de mitigálható közvetlen biztonsági kontrollal.
- **MEDIUM** — közepes kockázat, többlépcsős támadás kell.
- **LOW** — alacsony likelihood vagy alacsony impact.

## Likelihood skála

- **High** — exploit elérhető, hozzáférési akadály alacsony.
- **Med** — szakértői tudás kell, vagy social engineering.
- **Low** — célzott, kifinomult támadás.

## Register

| ID | Title | Severity | Likelihood | ASVS / CIS | Source | Owner | Target | Status |
|---|---|---|---|---|---|---|---|---|
| R.S.1.1 | Proxy CORS `origin: true` + `credentials: true` | CRITICAL | Med | V5/V13, CIS 12 | Infra explorer | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (ALLOWED_ORIGINS allowlist + CORS_ORIGIN_DENIED 403) |
| R.S.1.2 | UXP `null` origin nincs explicit handling | CRITICAL | Med | V13 | Infra explorer | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (`nullOriginGuard` middleware: `/v1/realtime` only + `X-Maestro-Client` header) |
| R.S.1.3 | Proxy nincs rate-limit | CRITICAL | High | CIS 13 | Infra explorer | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (express-rate-limit, 7 path-szintű limiter, memory-store) |
| R.S.1.4 | URL query param logging (PII leak — auth-in-query) | CRITICAL | High | V7 | Infra explorer | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (`redactUrl()` maszkolja `x-fallback-cookies`/`cookie`/`token`/`secret`/`email`/`jwt`/`session` stb.) |
| R.S.1.6 | `injectAuthenticationFromQueryParams()` attack surface | HIGH | Med | V13 | Infra explorer | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (`/v1/realtime` only + 4KB cap + JSON-only + Appwrite session key whitelist + value-charset + raw-fallback eltávolítva) |
| R.S.1.7 | WS upgrade event bypass: CORS/null-guard/rate-limit Express middleware láncon kívül | CRITICAL | High | V13, CIS 12 | Codex stop-time review | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (`server.on('upgrade')` explicit gate: path + origin + `X-Maestro-Client` + per-IP 60/min rate-limit; auto-subscribe forrása `app.use('/v1/realtime', wsProxy)` mount eltávolítva) |
| R.S.1.8 | `trust proxy` hiány → Railway/Cloudflare mögött self-DoS (minden klienst edge IP-re vonja össze) | MAJOR | High | CIS 13 | Codex stop-time review | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (`app.set('trust proxy', TRUST_PROXY)`, default 1 hop, env-overrideelt) |
| R.S.1.9 | Globális `express.urlencoded()` body parser a rate-limit ELŐTT (DoS parse-cost) | MAJOR | Med | V11 | Codex stop-time review | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (globális body parser eltávolítva — `/reset-password` POST 410 body nélkül, más POST-ok route-szintű parserrel) |
| R.S.1.10 | Cookie value regex `^[A-Za-z0-9\-._~]*$` túl szűk — legitim base64 session érték elesik | MAJOR | Med | V13 | Codex stop-time review | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (RFC 6265 cookie-octet `^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$` — engedett `+`/`/`/`=`/`%`, kivéve CTL/space/`"`/`,`/`;`/`\`) |
| R.S.1.11 | `X-Maestro-Client` + null origin spoofolható non-browser klienssel (gyenge boundary) | MAJOR | Low | V13 | Codex stop-time review | Claude+Codex | Phase 2 | **Open — Phase 2** (Per-deployment shared-secret HMAC + timestamp, dokumentálva [[ProxyHardening#TODO]]) |
| R.S.1.12 | Path matching `startsWith('/v1/realtime')` átengedi `/v1/realtimeevil`-t | MINOR | Low | V13 | Codex stop-time review | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (`pathMatchesAny()` segment-boundary helper, 3 használati helyen) |
| R.S.1.13 | `redactUrl()` regex fallback nem fedi a teljes `REDACT_QUERY_KEYS` Set-et | MINOR | Low | V7 | Codex stop-time review | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (`REDACT_QUERY_REGEX` Set-ből dinamikusan generálva, mindig szinkron) |
| R.S.1.14 | `extractClientIp()` XFF-first parsing nem Express `trust proxy`-egyenértékű — spoofolható ha edge nem törli/normalizálja az XFF-et | MAJOR | Med | V13, CIS 13 | Codex verifying review | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (`proxyAddr(req, trustFn)` ahol `trustFn = app.get('trust proxy fn')` — ugyanazon hop-szemantika mint Express `req.ip`) |
| R.S.1.15 | `denyUpgrade()` HTTP response flush-garancia hiányzott (azonnali `socket.destroy()`) | NIT | Low | — | Codex verifying review | Claude+Codex | 2026-05-11 | **Closed 2026-05-11** (`socket.end()` + `setTimeout(destroy, 50ms).unref()` graceful flush) |
| R.S.2.2 | `invite_to_organization` nincs per-user-id rate-limit | CRITICAL | Med | V11, CIS 13 | Backend explorer | TBD | TBD | Open |
| R.S.2.3 | `delete_my_account` nincs cooldown | HIGH | Low | V11 | Backend explorer | TBD | TBD | Open |
| R.S.2.5 | Lejárt rate-limit counter cleanup nincs | MEDIUM | High | CIS 4 | Backend explorer | TBD | TBD | Open |
| R.S.2.6 | Resend cost-cap per-org-per-day hiányzik | HIGH | Med | V11 | Backend explorer | TBD | TBD | Open |
| R.S.3.1 | Dashboard nincs CSP | HIGH | High | V14, CIS 4 | Frontend explorer | TBD | TBD | Open |
| R.S.3.3 | Nincs X-Frame-Options (clickjacking) | HIGH | Med | V14 | Frontend explorer | TBD | TBD | Open |
| R.S.3.4 | Nincs Referrer-Policy | MEDIUM | Med | V14 | Frontend explorer | TBD | TBD | Open |
| R.S.3.6 | Nincs HSTS header | MEDIUM | Med | V9 | Frontend explorer | TBD | TBD | Open |
| R.S.4.2 | ImportDialog nincs file size + MIME check | HIGH | Med | V12 | Frontend explorer | TBD | TBD | Open |
| R.S.5.1 | Git secret-scan nem futott | HIGH | Low | V6, CIS 6 | Infra explorer | TBD | TBD | Open |
| R.S.5.3 | Appwrite API key rotáció policy nincs dokumentálva | HIGH | Low | V6 | Infra explorer | TBD | TBD | Open |
| R.S.6.1 | UXP `network.domains: "all"` (whitelist hiányzik) | MEDIUM | Low | V14 | Infra explorer | TBD | TBD | Open |
| R.S.6.2 | UXP `localFileSystem: "fullAccess"` (least-privilege) | MEDIUM | Low | V14 | Infra explorer | TBD | TBD | Open |
| R.S.7.1 | Egyes collection-ökön `rowSecurity` flag verify hiányzik | HIGH | Med | V4, CIS 3 | Backend explorer | TBD | TBD | Open |
| R.S.7.2 | `backfill_admin_team_acl` még nem futott éles orgokon | HIGH | High | V4, CIS 3 | Backend explorer (D blokk) | TBD | TBD | Open |
| R.S.7.5 | 2-tab cross-org adversarial teszt nincs lefuttatva | HIGH | Med | V4 | Codex review | TBD | TBD | Open |
| R.S.8.1 | `RESEND_WEBHOOK_SECRET` deploy verify hiányzik (W3) | MEDIUM | Low | V9 | Backend explorer | TBD | TBD | Open |
| R.S.9.1 | `yarn npm audit` nincs CI-ben | MEDIUM | Med | CIS 7 | Infra explorer | TBD | TBD | Open |
| R.S.9.4 | Appwrite CF runtime `node-18.0` (EOL 2025-04) | MEDIUM | Low | CIS 7 | Infra explorer | TBD | TBD | Open |
| R.S.10.1 | Admin audit-view UI hiányzik (forensics) | LOW | Low | V7, CIS 8 | Backend explorer | TBD | TBD | Open |
| R.S.11.1 | DNS CAA record nincs | LOW | Low | V9, CIS 11 | Infra explorer | TBD | TBD | Open |
| R.S.11.5 | Recovery-runbook hiányzik | LOW | Low | CIS 11 | Codex review | TBD | TBD | Open |
| R.S.12.1 | Password policy audit (Appwrite Console settings) | HIGH | Low | V2 | Codex review | TBD | TBD | Open |
| R.S.12.2 | MFA admin-szerepre nem kötelező | HIGH | Med | V2 | Codex review | TBD | TBD | Open |
| R.S.12.4 | `localStorage.maestro.activeEditorialOfficeId` logout cleanup gap | MEDIUM | Low | V3 | Frontend explorer | TBD | TBD | Open |
| R.S.13.2 | `log()` helper nincs PII-redaction | HIGH | Med | V7, CIS 8 | Codex review | TBD | TBD | Open |
| R.S.13.3 | CF error → kliens info-disclosure (raw error message) | HIGH | Med | V7 | Codex review | TBD | TBD | Open |
| R.S.13.4 | Monitoring alert nincs (CF failure, rate-limit spike) | MEDIUM | High | CIS 8 | Codex review | TBD | TBD | Open |
| R.S.14.0 | Groq/Anthropic SDK production-adat audit (CONDITIONAL) | TBD | TBD | V5, V8 | Codex review | TBD | defer | Open |

## Status állapotok

- **Open** — nincs még implementálva, S blokk Feladatok listáz.
- **In Progress** — implementáció folyamatban.
- **Closed** — implementálva, Codex stop-time CLEAN.
- **Accepted** — kockázat tudatosan vállalva (pl. UXP `network.domains: "all"` ha az architektúra megköveteli).
- **Mitigated** — részleges megoldás (pl. best-effort), kompenzáló kontrollal.

## Karbantartás

Minden S blokk al-pont teljesítése után frissítendő:
- **Status**: Open → Closed / Accepted / Mitigated
- **Target** → tényleges **closed YYYY-MM-DD**

Új kockázat felvétele: minden új session-fix, Codex review-finding, vagy incident utáni post-mortem-ből.

## Kapcsolódó

- [[Komponensek/SecurityBaseline]]
- [[Feladatok#S — Biztonsági audit (új, 2026-05-11)|S blokk]]
- [[Hibaelhárítás]]
