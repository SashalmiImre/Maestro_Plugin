---
tags: [komponens, biztonság, security-headers, csp]
status: stable
date: 2026-05-15
related:
  - "[[SecurityBaseline]]"
  - "[[SecurityRiskRegister]]"
  - "[[Feladatok#S.3]]"
---

# Security Headers (Dashboard)

S.3 al-pont code-only zárása 2026-05-15. Dashboard (Vite SPA + LiteSpeed/Apache shared hosting `maestro.emago.hu`-n) HTTP response header-ek. A `packages/maestro-dashboard/public/.htaccess` `<IfModule mod_headers.c>` szakasza biztosítja.

## Header lista

| Header | Érték | R-id | Cél |
|---|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000` | R.S.3.6 | HSTS — kliens minden subsequent request-et HTTPS-en küld. **NEM** `includeSubDomains; preload` (Codex MAJOR fix conservative). |
| `X-Frame-Options` | `DENY` | R.S.3.3 | Clickjacking-prevent (legacy Safari < 14, IE 11). Modern browser `frame-ancestors 'none'`-t használ. |
| `X-Content-Type-Options` | `nosniff` | (audit-id later) | MIME-sniffing-prevent — opportunistic hardening. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | R.S.3.4 | Cross-origin downgrade (HTTP) → nincs Referer header. Same-origin → full URL. Cross-origin HTTPS → csak origin. |
| `Permissions-Policy` | `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()` | (audit-id later) | Letiltja a felesleges SDK-szintű device-access-eket — fingerprint-surface csökkentés. |
| `Content-Security-Policy-Report-Only` | `<policy>` (lentebb) | R.S.3.1 | XSS + data-injection-prevent. **REPORT-ONLY** Phase 1 — Phase 2 enforce. |

## CSP policy (Phase 1 report-only)

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https://api.maestro.emago.hu;
connect-src 'self' https://api.maestro.emago.hu wss://api.maestro.emago.hu
           https://cloud.appwrite.io wss://cloud.appwrite.io;
font-src 'self';
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
```

**Directive rationale**:

- `default-src 'self'`: fall-back minden resource-ra csak self-origin.
- `script-src 'self'`: Vite production build minden script-et külön `dist/assets/*.js`-be tesz, NINCS inline. NEM kell `'unsafe-inline'`/`'unsafe-eval'`.
- `style-src 'self' 'unsafe-inline'`: CSS-in-JS lib-ek (styled-components, emotion stb.) inline style-okat generálnak — `'unsafe-inline'` pragmatikus tolerance. XSS-impact a style-on alacsony. 2. iteráció: nonce/hash-mintára szigorítható.
- `img-src 'self' data: https://api.maestro.emago.hu`: Appwrite Storage képek + base64 data URI-k.
- `connect-src`: dashboard kapcsolódik az Appwrite custom domain-jéhez (ADR 0005) ÉS a `cloud.appwrite.io` fallback-hoz (Appwrite SDK belső retry-on). **Railway proxy NEM kell** — az `EndpointManager` plugin-only (UXP), a dashboard NEM használja.
- `frame-ancestors 'none'`: modern clickjacking-prevent. Defense-in-depth a legacy `X-Frame-Options: DENY`-szel.
- `base-uri 'self'`: DOM-clobbering-prevent (egy XSS NEM tudja átírni a `<base>` tag-et).
- `form-action 'self'`: form-hijack-prevent (egy XSS NEM tudja átirányítani a `<form>` submit-jét cross-origin URL-re).

**NEM** szerepel:
- `'unsafe-eval'` — React 18 prod NEM eval.
- `'unsafe-inline'` script-on — Vite prod-build NEM inline.
- `report-uri` / `report-to` — Phase 1 manuálisan a DevTools console-on figyeljük a violation-okat. Phase 2 enforce-mode + esetleg endpoint.

## Codex pipeline (2026-05-15)

| Iteráció | Eredmény |
|---|---|
| Pre-review | 7/7 GO + 1 MAJOR (HSTS conservative — `includeSubDomains; preload` halasztott) + 1 MINOR (`nosniff` audit-id later) — javítva |
| Stop-time | GO conditional (Railway proxy verify: dashboard NEM-érintett, csak plugin EndpointManager) → GO |

## Deploy

`./deploy.sh` a meglévő flow-n:
1. `npm run build` — Vite `dist/`-be építi a `public/.htaccess`-et is.
2. `scp dist/.htaccess ...:~/maestro.emago.hu/` — feltöltés.
3. LiteSpeed/Apache automatikusan reload-ja a `.htaccess`-et (NEM kell server-restart).
4. Browser DevTools-on a Console-on a CSP violation-ok jelennek meg → Phase 2 finomítás.

## Phase 2 (PENDING)

- CSP enforce-mode (`Content-Security-Policy` NEM `-Report-Only`)
- HSTS `includeSubDomains; preload` + `hstspreload.org` submit (user-decision)
- CSP nonce/hash a style-on (`'unsafe-inline'` szigorítás)
- Esetleges `report-to` endpoint (Appwrite custom CF)

## Kapcsolódó

- [[SecurityBaseline]] — STRIDE per komponens (V14 communication-security, CIS 4)
- [[SecurityRiskRegister]] — R.S.3.1 + R.S.3.3 + R.S.3.4 + R.S.3.6 closed (code-only 2026-05-15)
- [[Feladatok#S.3]] — al-pontok S.3.1 - S.3.7
- `packages/maestro-dashboard/public/.htaccess` — deploy-kritikus header source
- [[Döntések/0005-dashboard-custom-domain]] — `api.maestro.emago.hu` first-party cookie miatt
- [[Döntések/0001-dual-proxy-failover]] — Railway proxy plugin-only, NEM dashboard
