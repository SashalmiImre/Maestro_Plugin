---
tags: [terv, session-prompt, S-blokk, security-headers]
target: S.3
created: 2026-05-15
---

# Új session — S.3 Security headers + CSP (R.S.3.1+R.S.3.3+R.S.3.4+R.S.3.6 close)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`
- **Branch**: `claude/zealous-euler-00c483`
- **PR**: https://github.com/SashalmiImre/Maestro_Plugin/pull/3

## Cél

Dashboard (és plugin webview) **security headers** hiányának pótlása. 4 R-id zárás:

- **R.S.3.1 Open**: Dashboard nincs CSP (HIGH)
- **R.S.3.3 Open**: X-Frame-Options hiány (HIGH, clickjacking)
- **R.S.3.4 Open**: Referrer-Policy hiány (MEDIUM)
- **R.S.3.6 Open**: HSTS header hiány (MEDIUM)

## Scope

### Dashboard (Next.js, Vercel/Netlify deploy)

A `next.config.js` (vagy `next.config.mjs`) `headers()` config:

```js
async headers() {
    return [
        {
            source: '/(.*)',
            headers: [
                { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
                { key: 'X-Frame-Options', value: 'DENY' },
                { key: 'X-Content-Type-Options', value: 'nosniff' },
                { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
                { key: 'Content-Security-Policy', value: '<full policy>' },
                // Plus: Permissions-Policy ha kell
            ]
        }
    ];
}
```

### CSP policy (legfontosabb)

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval';  // React 18 prod NEM kell unsafe-eval; lássuk Stripe / Sentry SDK-t
style-src 'self' 'unsafe-inline';
img-src 'self' data: https://*.appwrite.io https://*.maestro.emago.hu;
connect-src 'self' https://api.maestro.emago.hu https://*.appwrite.io wss://*.appwrite.io wss://*.maestro.emago.hu;
font-src 'self';
frame-ancestors 'none';
```

A CSP a **legkomplexebb** rész — sok cross-origin connect (Appwrite, Realtime WSS, esetleg Stripe, Sentry). 1. iteráció `report-only` mode-ban deploy + browser DevTools-on hibajegyzék gyűjtés + finomítás 2. iterációban.

### Plugin (UXP)

A plugin a **UXP environment**-en fut, NEM browser-on. CSP NEM applicable a UXP-n. DE: a Plugin-webview (`packages/maestro-indesign/manifest.json`) felsorolja a `network.domains: "all"`-t (R.S.6.1 Open). Külön al-pont.

A **plugin webview** futtatott React (`packages/maestro-indesign/src/`) NEM kap HTTP headers-et — a UXP environment NEM tud-e CSP-t kötelezni? Ellenőrizendő. Phase 1: csak a dashboard.

## Codex pre-review Q-k

**Q1**: CSP enforce mode vs report-only?
Default: **report-only** az 1. deploy-on (browser DevTools-on gyűjtjük a hibák listáját). Második iterációban szigorítva enforce mode.

**Q2**: `unsafe-eval` szükséges-e?
Default: **NEM** — React 18 prod NEM eval-t. Lássuk a Sentry / Stripe / egyéb SDK-kat (ha vannak).

**Q3**: Strict-Transport-Security `preload`-mintán?
Default: **GO** (max-age=31536000 + includeSubDomains + preload), DE a `chrome://net-internals/#hsts` preload-list-be bejegyezni külön user-task.

**Q4**: `frame-ancestors 'none'` (X-Frame-Options DENY ekvivalens) — kompatibilis-e a meglévő plugin-webview-tel?
Default: **GO** — a plugin webview Mac-OS UXP environment-ben fut, NEM iframe-en. Browser-iframe-zés NEM támogatott.

**Q5**: Permissions-Policy bekapcs?
Default: **opcionális**, csak ha tudjuk milyen feature-eket akarunk tiltani (clipboard, geolocation, camera, etc.). 1. deploy NEM kell.

## Becsült időtartam

~60-90 perc (Phase 1 csak dashboard + 1 next.config.js fájl + 4 doku frissítés).

## Implementáció lépésekben

1. `next.config.js` headers() bővítés (vagy `next.config.mjs`)
2. CSP report-only mode + report-uri (vagy report-to)
3. Lokális dev-server smoke (`preview_start` + `preview_console_logs` a violation-ok listájához)
4. CSP finomítás a console-violation-okból
5. Doku: TenantIsolation? VAGY új komponens-jegyzet `_docs/Komponensek/SecurityHeaders.md`

## Codex pipeline minta

Mint S.7.8: pre-review → impl → stop-time → verifying → /harden + commit + push.

## STOP feltételek

- **CSP enforce-violation** a meglévő funkciókon → DESIGN-Q (csak report-only akarjuk?)
- **Next.js verzió** kompatibilitás (headers() Next 9.5+)
- **Plugin webview** CSP applicability — kérdés, halasztott

## Kapcsolódó

- [[Tervek/autonomous-session-loop]]
- [[Feladatok#S.3]]
- [[Komponensek/SecurityRiskRegister]] R.S.3.1+R.S.3.3+R.S.3.4+R.S.3.6
- [[Naplók/2026-05-15]] 5 iteráció lezárás
