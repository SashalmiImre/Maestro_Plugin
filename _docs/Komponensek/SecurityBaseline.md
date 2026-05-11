---
aliases: [Security Baseline, Biztonsági alapvetés, STRIDE]
tags: [biztonság, baseline, ASVS, CIS, STRIDE]
status: Draft
created: 2026-05-11
---

# Security Baseline

> A Maestro Plugin biztonsági alapvetése. Bíráló keret: **OWASP ASVS Level 2 + CIS Controls v8 IG1 hibrid**. Defense-in-depth. Defenzív minden trust boundary-n.

## Cél

Központi, kanonikus referencia minden biztonság-érintő implementációhoz. Minden új feature implementációja előtt egyezzen ezzel a baseline-nal. A teljes [[Feladatok#S — Biztonsági audit (új, 2026-05-11)|S blokk]] erre épül.

## Trust boundary diagram (komponens-térkép)

```
┌─────────────────┐   HTTPS+CORS  ┌──────────────────┐  HTTPS+API key  ┌──────────────────┐
│  Dashboard      │ ────────────> │  api.maestro     │ ──────────────> │  Appwrite Cloud  │
│  (browser)      │ <──────────── │  .emago.hu       │ <────────────── │  (Frankfurt)     │
│  React + Vite   │   Realtime    │  (Appwrite       │   Functions     │  - Databases     │
└─────────────────┘     (WSS)     │   proxy CNAME)   │                 │  - Auth          │
                                  └──────────────────┘                 │  - Realtime      │
                                                                       │  - Functions:    │
┌─────────────────┐  HTTPS+API key ┌──────────────────┐  HTTPS+API key │    invite-to-org │
│  InDesign UXP   │ ─────────────> │  Railway proxy   │ ─────────────> │    resend-webhook│
│  plugin (React) │ <───────────── │  Frankfurt + EMG │ <───────────── │    user-cascade  │
│                 │   Realtime     │  fallback        │    Realtime    │    update-article│
└─────────────────┘     (WSS)      └──────────────────┘                │    + 10 more     │
                                                                       └──────────────────┘
                                                                                │
                                                                                │ HMAC (Svix)
                                                                                ▼
                                                              ┌────────────────────────┐
                                                              │  webhook.maestro       │
                                                              │  .emago.hu             │
                                                              │  (Resend webhook       │
                                                              │   email events)        │
                                                              └────────────────────────┘
                                                                       │
                                                                       │ HTTPS+API key
                                                                       ▼
                                                              ┌────────────────────────┐
                                                              │  Resend EU             │
                                                              │  (transactional email) │
                                                              │  noreply@maestro       │
                                                              │  .emago.hu             │
                                                              └────────────────────────┘
```

Trust boundary-k (zarándok-rétegek a kritikus zónáig):
1. **Browser/UXP** (low-trust kliens) — JS + plugin runtime
2. **Proxy** (medium-trust bridge) — Railway + emago.hu
3. **Appwrite Cloud** (high-trust execution) — CF + DB + Auth
4. **Resend / 3rd party** (federated trust) — HMAC-verified callbacks

## STRIDE per komponens

| Komponens | Spoofing (S) | Tampering (T) | Repudiation (R) | Info-disclosure (I) | DoS (D) | Elevation (E) |
|---|---|---|---|---|---|---|
| **Dashboard** (browser) | Appwrite session cookie (first-party, ADR 0005) | CSP (TBD S.3) | server-side audit log (S.10) | XSS-check (S.4), session-cookie httpOnly | CDN/rate-limit (S.1) | ProtectedRoute + permission slug check |
| **InDesign plugin** (UXP) | Appwrite session token | UXP signature (Adobe) | server-side audit log | localStorage cleanup (ADR 0010) | proxy rate-limit (S.1) | UXP sandbox (S.6) |
| **Proxy** (Express) | API key header + origin (S.1.1) | xfwd: false ✓ | request log (S.13) | PII-redaction (S.1.4) | rate-limit (S.1.3) | proxy nem authoritative (csak bridge) |
| **Cloud Functions** | API key + JWT user context | input validation (compiledValidator + permissions.js) | `organizationInviteHistory` + `attemptId` (ADR 0011) | permission guard + tenant ACL (ADR 0003) | IP rate-limit (S.2), pagination budget (ADR 0011) | `userHasPermission()` minden CF action eleján |
| **Appwrite DB** | per-tenant Team ACL (ADR 0003) | `rowSecurity: true` (S.7.1) | Appwrite event log | tenant team-scope read | Appwrite Cloud built-in | ACL on document-level |
| **Resend webhook** | HMAC-SHA256 (Svix) | replay-protection 5min | webhook event log | secret env var | best-effort IP-allowlist (S.8.2) | HMAC az autoritatív |

## OWASP ASVS L2 — Maestro-érintettség

| ASVS Chapter | Maestro-érintett | Implementálva | S blokk teendő |
|---|---|---|---|
| V1 Architecture, Design | Igen | Részben (ADR-ek dokumentálják) | S.0 (threat model) |
| V2 Authentication | Igen | Appwrite-built-in | S.12.1, S.12.2, S.12.5 |
| V3 Session Management | Igen | Appwrite session | S.12.3, S.12.4 |
| V4 Access Control | Igen | `permissions.js` 38 slug, per-tenant Team ACL | S.7.1–S.7.5, S.12.6 |
| V5 Validation, Sanitization | Igen | `compiledValidator`, `sanitizeString` | S.4.1–S.4.4 |
| V6 Cryptography | Igen | Appwrite + HMAC | S.5.3–S.5.5 |
| V7 Error Handling, Logging | Igen | `log()` helper, szétszórt | **S.13** (új blokk) |
| V8 Data Protection | Igen | GDPR `delete_my_account` (ADR 0013) | S.10.2–S.10.3 |
| V9 Communication | Igen | TLS mindenhol, first-party cookie | S.3.6 (HSTS), S.11.1 (CAA) |
| V10 Malicious Code | Részben | dependency scan hiányzik | S.9.1–S.9.6 |
| V11 Business Logic | Igen | CAS-gate, orphan-guard (ADR 0011) | S.2.1–S.2.6 (rate-limit) |
| V12 File and Resources | Részben | ImportDialog file upload | S.4.2 |
| V13 API and Web Service | Igen | CF input/output | S.1.6, S.2.1–S.2.6 |
| V14 Configuration | Részben | `.env*`, deploy scripts | S.3.1–S.3.6, S.5.1–S.5.6, S.6.1–S.6.4 |

## CIS Controls v8 IG1 — Maestro-érintettség

| CIS Control | Cím | Maestro-érintettség | S blokk teendő |
|---|---|---|---|
| CIS 3 | Data Protection | GDPR + tenant isolation | S.7.1–S.7.6, S.10.3 |
| CIS 4 | Secure Configuration | CSP, headers, Appwrite config | S.3.1–S.3.6 |
| CIS 6 | Access Control Management | permissions.js, MFA | S.12.1–S.12.6 |
| CIS 7 | Continuous Vulnerability Management | yarn audit | S.9.1–S.9.4 |
| CIS 8 | Audit Log Management | log() + Appwrite logs | S.13.1–S.13.5 |
| CIS 11 | Data Recovery | Appwrite backup | S.11.3–S.11.5 |
| CIS 12 | Network Infrastructure Management | proxy CORS, TLS | S.1.1–S.1.6 |
| CIS 13 | Network Monitoring | rate-limit triggers | S.2.5, S.13.4 |
| CIS 16 | Application Software Security | input validation, error handling | S.4.1–S.4.4, S.13.3 |

## Implementációs sorrend (Codex 2026-05-11)

**S.0 → S.1 → S.2 → S.7 → S.3 → S.4 → S.5 → S.12 → S.13 → S.6 → S.8 → S.9 → S.10 → S.11**

Indoklás (Codex): S.7 (cross-tenant) előrehozott, mert adatincidens-kockázat magasabb, mint a legtöbb header-hardening. S.5 (secrets) feltételes CRITICAL: ha production-kulcs gyanús (repo-expozíció vagy rotáció-hiány).

## Defense-in-depth réteg-szervezet

1. **DNS/SSL** (S.11) — CAA, DNSSEC, HSTS
2. **Network** (S.1, S.6.1) — CORS allowlist, domain whitelist
3. **Application** (S.3, S.4, S.13.3) — CSP, XSS, error-disclosure
4. **Authentication** (S.12) — MFA, session lifetime, recovery
5. **Authorization** (S.7, ADR 0003/0008) — per-tenant Team ACL, permission slug
6. **Rate-limit / abuse** (S.2) — IP + user + per-org cap
7. **Data integrity** (S.7.1 rowSecurity, ADR 0011 CAS-gate)
8. **Audit / forensics** (S.10, S.13.4–S.13.5) — `organizationInviteHistory`, central log
9. **Recovery** (S.11.3–S.11.5) — backup, runbook

## Kapcsolódó

- [[Feladatok#S — Biztonsági audit (új, 2026-05-11)|S blokk Feladatok]]
- [[Komponensek/SecurityRiskRegister|Risk Register]]
- [[Komponensek/PermissionTaxonomy]], [[Komponensek/PermissionHelpers]]
- [[Komponensek/RealtimeBus]] (cross-tenant adversarial)
- [[Döntések/0003-tenant-team-acl]], [[Döntések/0008-permission-system-and-workflow-driven-groups]], [[Döntések/0011-cas-gate-and-orphan-guard-invariants]]
- OWASP ASVS L2: https://owasp.org/www-project-application-security-verification-standard/
- CIS Controls v8 IG1: https://www.cisecurity.org/controls/cis-controls-list
