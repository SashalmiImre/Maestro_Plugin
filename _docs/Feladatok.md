---
aliases: [TODO, Tasks, Teendők]
tags: [feladatok]
---

# Feladatok

> Aktív TODO-k. A megvalósult tervek a vault-ba migrálva (lásd [[#Kész — vault hivatkozások]] alul). A korábbi részletes blokk-tervek (A.0-A.5, B.0-B.5, C, D.2-D.7, E, F, G, H) **mind kész** — történeti tartalom az ADR-ekben és napló-bejegyzésekben.

## Aktív

### S — Biztonsági audit (új, 2026-05-11)

> Átfogó security audit a teljes monorepóra. Baseline: **OWASP ASVS Level 2 + CIS Controls v8 IG1 hibrid**. Codex-szel egyeztetett priorizálás (2026-05-11). Részletes terv: [[Komponensek/SecurityBaseline]] + [[Komponensek/SecurityRiskRegister]]. Implementációs sorrend Codex szerint: **S.0 → S.1 → S.2 → S.7 → S.3 → S.4 → S.5 → S.12 → S.13 → S.6 → S.8 → S.9 → S.10 → S.11**. S.14 conditional defer.

#### S.0 Inventory + threat model (1 session)

- [ ] **S.0.1** — `_docs/Komponensek/SecurityBaseline.md` létrehozás: STRIDE per komponens (proxy / dashboard / plugin / CF / Appwrite / Resend), trust boundary diagram, ASVS L2 + CIS IG1 mapping.
- [ ] **S.0.2** — `_docs/Komponensek/SecurityRiskRegister.md` létrehozás: S.1–S.13 minden ismert gap egy sorban (severity, likelihood, owner, target-date, closed timestamp).
- [ ] **S.0.3** — Codex pre-review a baseline + risk register felett. Trigger: S.0.1 + S.0.2 után, az S.1 implementáció előtt.

#### S.1 CORS + proxy szigorítás (CRITICAL, 2 session) — ASVS V5/V13, CIS 4/8/12

- [x] **S.1.1** — Origin whitelist a proxy-n. Lista: `https://maestro.emago.hu` (dashboard prod) + lokális dev (`http://localhost:5173`) + UXP `null` origin (Adobe ID egyedi). Default-deny minden más. **Done 2026-05-11**.
- [x] **S.1.2** — UXP `null` / `file://` origin secondary guard: `X-Maestro-Client: indesign-plugin` header check ha origin null, különben deny. Pre-flight engedélyezett. **Done 2026-05-11** (`nullOriginGuard` middleware).
- [x] **S.1.3** — Rate limit a proxyn (`express-rate-limit` per-IP per-route). Prioritás: auth-érintő path-ek (`/v1/account`, `/v1/sessions`, Realtime upgrade). **Done 2026-05-11** — 7 path-szintű limiter (memory-store, dokumentált Redis upgrade path Phase 2).
- [x] **S.1.4** — Request- és response-log PII-scrub: URL query (token, email), body `Authorization` header, `email` kulcs maszkolás. Saját redactor middleware. **Done 2026-05-11** — `redactUrl()` `URL`-based + regex fallback (`x-fallback-cookies`, `cookie`, `token`, `secret`, `key`, `email`, `jwt`, `session`, `authorization` stb. maszkolva).
- [ ] **S.1.5** — Per-route timeout finomhangolás (HTTP 30s default → 8s health, 30s upload). WebSocket keep-alive bound (15s ping). **Deferred** — Codex pre-review nem indokolta változtatást, jelenlegi 30s uniform `/v1/*` proxy timeout elegendő. Trigger: első incident timeouttal kapcsolatban.
- [x] **S.1.6** — `injectAuthenticationFromQueryParams()` támadási felület szűkítése: csak Realtime upgrade path-en, max payload 4KB, JSON-only. **Done 2026-05-11** — `/v1/realtime` only, 4KB cap, Appwrite session-key whitelist regex (`a_session(_xxx)?(_legacy)?`), value-charset validate, **raw-string fallback eltávolítva**.
- [x] **S.1.7** — Stop-time Codex review (`task-mp1k8f73-rdtj2x`): 1 BLOCKER + 4 MAJOR + 3 MINOR + 2 NIT, mind javítva. Verifying review (`task-mp1kn806-x09za4`): 1 új MAJOR (extractClientIp XFF-first spoofolható) + 1 NIT (denyUpgrade flush) — mindkettő javítva (`proxy-addr` lib + `app.get('trust proxy fn')` + `socket.end()` graceful close). Lásd [[Komponensek/ProxyHardening#Codex stop-time review]] + `#Codex verifying review`. Egy MAJOR (`X-Maestro-Client` HMAC) **defer-elt Phase 2-re** — best-effort kliens-azonosító elfogadott jelenlegi pre-prod állapotban. Risk register: R.S.1.7–R.S.1.15.

#### S.2 Rate-limit kiterjesztés CF-szinten (CRITICAL, 2 session) — ASVS V11/V13, CIS 13

- [x] **S.2.1** — `acceptInvite` IP rate-limit verify (5/15min/IP, 1h block). **Done 2026-05-11**: a `checkRateLimit(ctx, 'accept_invite')` ténylegesen hívott az `actions/invites.js:860`-on. A `helpers/rateLimit.js` fájl tetejének "SKELETON" megjegyzése frissítve "STATUS — bekötve"-re. **Halasztva S.2.5 — Cleanup CF**: lejárt counter (24h+) és block (lejárt blockedUntil) doc-ok periodikus törlése (új scheduled CF). Collection schema deploy + env var verify production-előtt (nincs éles, halaszthatjuk).
- [x] **S.2.2** — `invite_to_organization` rate-limit: IP + user-id + per-org-day. **Done 2026-05-11**: multi-scope `evaluateRateLimit` + `consumeRateLimit` (`invite_send_ip` 30/15min, `invite_send_user` 50/24h, `invite_send_org_day` 200 email/24h). Codex pre-review + stop-time + verifying CLEAN. Lásd [[Komponensek/CFRateLimiting]].
- [x] **S.2.3** — `delete_my_account` cooldown. **Done 2026-05-11**: attempt-throttle 3/5min/5min block (Codex stop-time MAJOR 3: NEM 24h hard cooldown — self-heal retry megengedhető partial cleanup után).
- [ ] **S.2.4** — Appwrite-built-in login throttle audit (Console "Sessions Limit" beállítások) + alkalmazás-szintű login-fail counter ha hiányzik.
- [ ] **S.2.5** — Cleanup CF: lejárt `ipRateLimitCounters` (24h+ régebbi) + `ipRateLimitBlocks` (lejárt) periodikus törlése. Új scheduled CF: `cleanup-rate-limits` napi futás. **Élesedés előtt kötelező** (S.2.2/S.2.6 deploy után counter-doc-ok napi ~500/CF tempóval halmozódnak — a `readCounter` lapozott, tolerable, de 30 nap után kötelező takarítás).
- [x] **S.2.6** — Resend cost-control per-org-per-day. **Done 2026-05-11**: folded into `invite_send_org_day` endpoint (200 email/24h, weight=validEmailCount). Codex M2: malformed email NE égesse a quota-t — `EMAIL_REGEX` pre-filter rate-limit ELŐTT.
- [x] **S.2.7** — Stop-time Codex review + verifying. **Done 2026-05-11**: 1 BLOCKER (block docId) + 3 MAJOR (createBlock placement / batch lookups / delete cooldown) + 1 MINOR (XFF trust acknowledged) + 1 NIT (schema komment) — mind javítva. Verifying review CLEAN (rename `checkRateLimitDry` → `evaluateRateLimit` + docstring tisztázás). Új jegyzet: [[Komponensek/CFRateLimiting]]. Risk register: R.S.2.2/R.S.2.3/R.S.2.6/R.S.2.7/R.S.2.8/R.S.2.9/R.S.2.10 closed.

#### S.7 Realtime + cross-tenant data leak (HIGH — Codex előrehozta, 2 session) — ASVS V4/V5, CIS 3

- [ ] **S.7.1** — `appwrite.json` minden collection `rowSecurity` flag audit. Hiányzó → enable (új deployment).
- [ ] **S.7.2** — Per-tenant ACL coverage verify: `backfill_tenant_acl` + `backfill_admin_team_acl` minden orgon lefuttatva (dryRun → éles). Update [[H.6]] smoke-teszt-checklist.
- [ ] **S.7.3** — Realtime channel filter audit: `realtimeBus.js` `subscribeRealtime()` listáz minden csatornát, ellenőrizni hogy tenant-prefix-szűrés (defensive depth) van-e.
- [ ] **S.7.4** — Cross-org membership ACL: ha user több org-ban van, milyen Realtime payload-okat lát. Adversarial verify.
- [ ] **S.7.5** — Adversarial 2-tab teszt: két browser-tab, két különböző org, `localStorage.maestro.activeEditorialOfficeId` csere → más org adata láthatóvá válik-e? (Tilos.)
- [ ] **S.7.6** — Stop-time Codex review. Új jegyzet: [[Komponensek/TenantIsolation]].

#### S.3 Security headers + CSP (HIGH, 2 session — CSP report-only rollout) — ASVS V14, CIS 4

- [ ] **S.3.1** — CSP design: `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://api.maestro.emago.hu wss://api.maestro.emago.hu https://webhook.maestro.emago.hu; img-src 'self' data:; style-src 'self' 'unsafe-inline'`. Réteges: report-only mode → enforce.
- [ ] **S.3.2** — Apache `.htaccess` (`packages/maestro-dashboard/public/.htaccess`) `Header set` direktívák: `Content-Security-Policy-Report-Only` (Phase 1) → `Content-Security-Policy` (Phase 2).
- [ ] **S.3.3** — `X-Frame-Options: DENY`. (UXP plugin nem iframe.)
- [ ] **S.3.4** — `Referrer-Policy: strict-origin-when-cross-origin`.
- [ ] **S.3.5** — `Permissions-Policy: camera=(), microphone=(), geolocation=()`. Letiltja az SDK-szintű hozzáférést.
- [ ] **S.3.6** — `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`. Verify: minden `*.emago.hu` HTTPS-en.
- [ ] **S.3.7** — Stop-time Codex review. Új jegyzet: [[Komponensek/SecurityHeaders]].

#### S.4 XSS + input sanitization audit (HIGH, 1 session) — ASVS V5

- [ ] **S.4.1** — User-content render audit: grep + manuális minden `dangerouslySetInnerHTML` / `innerHTML` / `eval` előfordulásra mindhárom frontend csomagban (várhatóan 0 — Codex korábban megerősítette).
- [ ] **S.4.2** — ImportDialog file upload validáció: méret-cap (max 1MB workflow JSON), MIME-check, struktur-validáció ELŐTT. `packages/maestro-dashboard/src/features/workflowDesigner/ImportDialog.js`.
- [ ] **S.4.3** — Server-side input length cap audit: `sanitizeString(str, maxLen)` minden CF action paraméteren — túl-permisszív cap-ek keresése.
- [ ] **S.4.4** — Output encoding verify: React JSX auto-escape OK; specifikus helyek (CSV export, email template) explicit escape.
- [ ] **S.4.5** — Stop-time Codex review. Update [[Hibaelhárítás]] minden talált issue-val.

#### S.5 Secret + env var audit (HIGH → CRITICAL ha production-kulcs gyanús, 2 session) — ASVS V6/V14, CIS 6

- [ ] **S.5.1** — Git secret-scan: `gitleaks` vagy `detect-secrets` lokálisan a teljes history-n. Eredmény → `_docs/Komponensek/SecretsRotation.md` snapshot.
- [ ] **S.5.2** — `.env.production` tartalom verify: csak `VITE_*` (frontend public) — semmi server-side secret.
- [ ] **S.5.3** — Appwrite API key rotáció dokumentáció: mikor, hogyan, mely CF-eket érint. Új jegyzet [[Komponensek/SecretsRotation]].
- [ ] **S.5.4** — Resend `RESEND_WEBHOOK_SECRET` + `RESEND_API_KEY` rotáció policy.
- [ ] **S.5.5** — GROQ_API_KEY + ANTHROPIC_API_KEY használat audit: csak szerver-oldal? `dangerouslyAllowBrowser` ellenőrzés (Anthropic SDK).
- [ ] **S.5.6** — `.gitignore` completeness: minden `.env*` variáns, `.mcp.json`, lokális dev-secret fájlok.
- [ ] **S.5.7** — Phase 2: rotáció éles végrehajtás (külön session, **user-trigger** mert prod-érintő destruktív lépés).
- [ ] **S.5.8** — Stop-time Codex review.

#### S.12 Auth / Session / Access Control (HIGH, 1 session) — ASVS V2/V3/V4

- [ ] **S.12.1** — Password policy audit (Appwrite Console: min length, complexity, password-history, breached-password check).
- [ ] **S.12.2** — MFA enforcement: kötelező admin szerepre (`org.admin` permission slug), opcionális member-re. UI flow.
- [ ] **S.12.3** — Session lifetime + idle timeout audit (Appwrite Console alapértelmezett — dokumentálni vagy szigorítani).
- [ ] **S.12.4** — Token revocation: logout cleanup teljesség (ADR 0010 fix után), `localStorage.maestro.activeEditorialOfficeId` cleanup, session-list view ("Sign out other devices").
- [ ] **S.12.5** — Account recovery flow audit: Appwrite password reset email rate-limit, token entropy, expire.
- [ ] **S.12.6** — Role/permission matrix dokumentáció: `PermissionTaxonomy.md` 38 slug + role-mapping-leltár (member / admin / owner mit lát/csinál).
- [ ] **S.12.7** — Stop-time Codex review. Új jegyzet: [[Komponensek/AuthSessionAccess]].

#### S.13 Logging / Monitoring / Error-disclosure (HIGH, 1 session) — ASVS V7, CIS 8

- [ ] **S.13.1** — Central log aggregation tervezés (Sentry / Better Stack / Grafana Loki). Trigger: első incident vagy compliance-kérés.
- [ ] **S.13.2** — PII-redaction sablonok: `log()` helper bővítés email-maszkolás, token-elhúzás, session-id-cut funkciókkal.
- [ ] **S.13.3** — Error message info-disclosure audit: CF 500 → kliens, mit lát a frontend (stack trace? internal error code? `partial_cleanup_failed` üzenet?). Defensive: minden user-facing error code-os, NEM szöveges.
- [ ] **S.13.4** — Monitoring alert-ek tervezése: CF failure rate, WebSocket disconnect rate, rate-limit-trigger spike, login-fail spike.
- [ ] **S.13.5** — Audit-log retention CIS 8.3: minimum 90 nap (ASVS L2 elegendő). Appwrite Cloud + Railway logs verify.
- [ ] **S.13.6** — Anomaly detection (Phase 2, defer): unusual invite-send pattern, geo-outlier login.
- [ ] **S.13.7** — Stop-time Codex review. Új jegyzet: [[Komponensek/LoggingMonitoring]].

#### S.6 UXP plugin sandbox (MEDIUM, 1 session) — ASVS V14

- [ ] **S.6.1** — `manifest.json` network domain whitelist: Railway primary + emago.hu fallback + Appwrite + webhook subdomain. `"domains": "all"` → konkrét lista.
- [ ] **S.6.2** — localFileSystem szűkítés: `pluginData` + `documents` write, `userDocuments` csak read ha CF-en keresztül megy a write.
- [ ] **S.6.3** — `launchProcess.schemes`: csak `https` (verify).
- [ ] **S.6.4** — UXP auto-update review (Adobe ExMan-szintű).
- [ ] **S.6.5** — Stop-time Codex review.

#### S.8 Webhook + 3rd party trust (MEDIUM, 1 session)

- [ ] **S.8.1** — `RESEND_WEBHOOK_SECRET` deploy verify: élesen kötve van-e, rotáció policy.
- [ ] **S.8.2** — Webhook custom domain (`webhook.maestro.emago.hu`) IP-allowlist (Resend IP-tartomány) — best-effort, mert Resend nem ad fix IP-t (HMAC az autoritatív).
- [ ] **S.8.3** — Bounce / spam-complaint kezelés audit: UI mutatja-e a `bounced` státuszt, Resend API rebound idempotency.
- [ ] **S.8.4** — Idempotency-key tárolás: Resend `id` payload-mező → `webhookEventIds` collection (anti-replay).
- [ ] **S.8.5** — Stop-time Codex review.

#### S.9 Dependency + supply chain (MEDIUM, 1 session) — CIS 7/16

- [ ] **S.9.1** — `yarn npm audit --recursive` lokális run. Eredmény → `_docs/Komponensek/DependencyAudit.md` snapshot.
- [ ] **S.9.2** — Critical/High vulnerability fix: `yarn up <pkg>`, lockfile review.
- [ ] **S.9.3** — Dependabot setup (GitHub) vagy `npm-audit-resolver`.
- [ ] **S.9.4** — `package.json` `engines.node` pin (`>=20`). Backend EOL védelem: Appwrite CF `node-18.0` runtime → upgrade `node-20` vagy `node-22` (Appwrite Console runtime-választó).
- [ ] **S.9.5** — Lock-file integrity CI: `yarn.lock` checksum check PR-ban.
- [ ] **S.9.6** — Post-install script audit: `yarn explain peer-requirements` + manuális ellenőrzés a 3rd party SDK-knál (Resend, Anthropic, Groq, Appwrite).
- [ ] **S.9.7** — Stop-time Codex review. Új jegyzet: [[Komponensek/DependencyAudit]].

#### S.10 Audit log + GDPR (LOW–MEDIUM, 1 session) — GDPR Art. 30, CIS 8.3

- [ ] **S.10.1** — Admin audit-view UI (`/settings/organization/audit`): meghívási history + member-removal + role-change.
- [ ] **S.10.2** — `organizationInviteHistory` retention policy (D.3.4 már listázott — ide hivatkozni): default forever, admin-kérésre törölhető.
- [ ] **S.10.3** — `delete_my_account` GDPR-export: a törlés ELŐTT a user kapjon egy ZIP-et a saját adataival (legal-Q + dev-ready-Q).
- [ ] **S.10.4** — `attemptId` per-attempt tracking dokumentáció: új jegyzet [[Komponensek/AttemptIdTracking]] (ADR 0011 follow-up).
- [ ] **S.10.5** — Központi `actionAuditLog` collection (defer Phase 4, ADR 0011 deferred listáz "Audit completeness").
- [ ] **S.10.6** — Stop-time Codex review. Új jegyzet: [[Komponensek/AuditTrail]].

#### S.11 DNS / SSL / DR baseline (LOW, 1 session) — CIS 11

- [ ] **S.11.1** — DNS CAA record (`0 issue "letsencrypt.org"`). Registrar action.
- [ ] **S.11.2** — DNSSEC enable emago.hu (registrar-függő).
- [ ] **S.11.3** — Appwrite Cloud backup policy dokumentálás: új jegyzet [[Komponensek/DRPlan]].
- [ ] **S.11.4** — Failover dokumentáció: Railway → emago.hu verify (ADR 0001 listázza, elérhetőség-test).
- [ ] **S.11.5** — Recovery-runbook: key-rotation incident, secret-leak incident, DB restore, last-owner-orphan recovery.
- [ ] **S.11.6** — Stop-time Codex review.

#### S.14 AI/LLM security (CONDITIONAL — defer)

- [ ] **S.14.0** — Trigger-feltétel: ha Groq/Anthropic SDK production-adatot kap (prompt injection, data leakage, retention, provider key isolation), S.14 prioritás re-eval (`maestro-proxy` package használ groq-sdk + anthropic-sdk).

### A.6 Smoke teszt

- [ ] **A.6.1** — Permission rendszer 2-tab smoke: workflow létrehozás új slug-okkal → kiadvány hozzárendelés → autoseed verifikálás → tag-hozzáadás → aktiválás → plugin Realtime.
- [ ] **A.6.2** — Aktivált pub közbeni tag-eltávolítás: a snapshot védi a runtime-ot; UI warning + notification verifikálás.
- [ ] **A.6.3** — Adversarial: backend-bypass (kliens nem tud átírni állapotot ha hiányzik a jogosultság), `rowSecurity: true` cross-tenant izoláció. `slug` immutable enforcement (DevTools-ból se módosítható).

### A.7 Phase 2 — single-source build-step-ek + design follow-upok

- [ ] **A.7.2** — Plugin `useUserPermission` "deny on loading" API revizit. A jelenlegi `{ allowed: boolean, loading: boolean }`-nél a `clientHasPermission(null, slug) === false` miatt a hidratálatlan állapot effektíve "denied"-ként jelenik meg. Átállítás `{ status: 'loading' | 'allowed' | 'denied' }` enum-ra. Triggerelje az első valódi UI consumer (jelenleg 0). → [packages/maestro-indesign/src/data/hooks/useElementPermission.js](packages/maestro-indesign/src/data/hooks/useElementPermission.js).
- [ ] **A.7.3** — `permissions.js` shared/CF inline duplikáció single-source build-step. A.7.1 + H.2 (orphan-guard) mintára. Új `scripts/build-cf-permissions.mjs` ESM → CJS, a CF `permissions.js` egy `_generated_permissionsCatalog.js`-t require-ol. Yarn `build:cf-permissions` + `check:cf-permissions`. Triggerelje, mielőtt új slug-ot adunk a shared modulhoz.
- [ ] **A.7.4** — Schema bootstrap drift-detection. A 5 `bootstrap_*_schema` action a 409/already-exists ágon NEM ellenőrzi az attribute / index shape-jét. Részleges bukás vagy manuális Console-edit silent drift-et okozhat. Megoldás: 409 ágban `getAttribute` / `getIndexes` lookup → shape-ekvivalencia → eltérésre `schema_drift_detected` 500. Helper: `assertAttributeMatches`, `assertIndexMatches`. Production-szintű deploy hardening előtt érdemes.
- [ ] **A.7.5** — `extensionContract.js` shared/CF inline duplikáció single-source build-step. A.7.1/A.7.3 minta. Új `scripts/build-cf-extension-contract.mjs`, a CF `helpers/_generated_extensionContract.js`-t require-olja. **Triggerelje** mielőtt a B.3 új slug-ot vagy enum-bővítést kap.

### B.6 Smoke teszt

- [ ] **B.6.1** — Workflow extension end-to-end: extension létrehozás → workflow hivatkozás → publikáció aktiválás → plugin futtatás → eredmény. Protokoll: [[B6-smoke-test]]. (Manuális, InDesign + Dashboard.)

### D.1 DevOps / MCP setup

- [ ] **D.1.2** — Dashboard auto-deploy webhook (cPanel). A `deploy.sh` SSH/SCP — GitHub Actions workflow-val automatizálható (push-on-main → SSH-deploy). Bemenet: `secrets.SSH_PRIVATE_KEY` + `secrets.REMOTE_HOST` (alternative: deploy-key-only user a cPanel-en, restricted-shell). **Why**: a session-szintű forget-to-deploy cost megszűnik.

### D.3 Audit-trail follow-up

- [ ] **D.3.4** — `organizationInviteHistory` retention policy (default forever, admin-kérésre törölhető Console-ról). Phase 2: cron-alapú TTL.
- [ ] **D.3.5** ([[Döntések/0012-org-member-removal-cascade]] DESIGN-Q D1) — admin-kick audit-trail. A `remove_organization_member` jelenleg csak Appwrite execution log-ot ír. Ha tenant-visible forensic history kell (különösen owner-on-owner kick-ekre), bővítsük az `organizationInviteHistory`-t `removed_by_admin` finalStatus-szal, vagy új `organizationMemberRemovalHistory` collection. Trigger: első panaszos incident vagy explicit compliance-igény.
- [ ] **D.3.6** ([[Döntések/0013-self-service-account-management]] M2 follow-up) — `delete_my_account` `MAX_ORGS_PER_DELETE_CALL = 10` cap. Ha 10+ org-tag user gyakori, vagy a CF timeout 60s-en sokba kerül, implement chunkolás `continueFrom` payload-mezővel + frontend retry-pattern. Jelenleg 409 `too_many_orgs` hint a usernek (manuális leave-ek előtt).
- [ ] **D.3.7** ([[Döntések/0013-self-service-account-management]] post-deploy Codex BLOCKER) — `delete_my_account` scope-precheck. Jelenleg ha a CF-en hiányzik a `users.write` scope, a per-org cleanup végigmegy, és csak az utolsó `usersApi.delete`-en bukik el (`user_delete_failed` 500) → zombi user (élő, zéró-membership). Hot-fix: a 4. lépés ELŐTT egy upfront probe (pl. `usersApi.update(callerId, { name: callerUser.name })` idempotent no-op) — ha 401, return 503 `users_write_scope_missing` ANÉLKÜL cleanup-ot kezdeni. Trigger: ha a scope tévedésből hiányzik egy CF redeploy után, a precheck minden cleanup-ot megelőz.
- [ ] **D.3.8** ([[Döntések/0013-self-service-account-management]] post-deploy Codex MAJOR) — Plugin idle-tab logout push az account-delete eventre. A `packages/maestro-indesign/src/core/contexts/UserContext.jsx` jelenleg `account` Realtime + `dataRefreshRequested` recovery-re támaszkodik; idle plugin-tab nem kap azonnali kijelentkeztetést, csak a következő auth-hibás API-műveletnél (`sessionExpired` event a `useUserValidations.js:80-86`). Hot-fix: explicit `account.deleted` event listener vagy heartbeat-szerű periodic `account.get()` ping. Trigger: ha a self-service account-delete elterjed és a UX-zavar gyakorivá válik.
- [ ] **D.3.9** (harden 2 Codex baseline+adversarial 2026-05-10) — `leave_organization` legacy CAS gap. Ugyanaz a TOCTOU minta, mint a frissen javított `removeOrganizationMember` és `deleteMyAccount`-on: a 2-es lépés last-owner check-je + a 6-os lépés `deleteDocument` között race window van (`actions/offices.js:50-280`). Plus: a STRICT team cleanup ELŐSZÖR fut → ha a 4-5-6 cascade megakad, a caller server-side org-authority-t megőrizheti (a `userHasOrgPermission` az org-membership-en alapszik). Fix sablonja: a `removeOrganizationMember` új sorrendje (CAS recheck + org-membership delete ELSŐKÉNT + team/cascade utána). Trigger: ha első incident jön LeaveOrganization-on, vagy proaktívan a `removeOrganizationMember`/`deleteMyAccount` deploy-stabilizálódása után (a 3 flow között konvergens minta értékes).
- [ ] **D.3.10** (harden 2 Codex verifying P2, 2026-05-10) — `delete_my_account` retry residue. Az új sorrend (4c. org membership delete ELSŐKÉNT) megoldja az auth-cut problémát, de új edge case: ha a 4d/4e/4f cleanup bukik (`partial_cleanup` 500), a retry újra-listázza az `organizationMemberships`-eket — az adott org-membership már törölve, a loop kihagyja, és a maradék office/group/team residue orphan marad. Megoldás (refaktor opció): **`users.delete` ELŐSZÖR**, a meglévő `user-cascade-delete` event-driven CF takarít minden membership + team rekordot. Ez egyszerűsíti a `delete_my_account`-ot ~80 sorral, és a teljes residue-cleanup felelőssége az authoritative event-driven CF-é. Trigger: első incident `partial_cleanup`-pal vagy proaktív refaktor.

### D.5 Hardening backlog (deferred)

- [ ] **D.5.1** — Atomic TOCTOU lock invite-küldésen (`(inviteId, secondsBucket)` unique-index `inviteSendLocks`). **Trigger**: első botspam incident; jelenlegi pre-claim ~30ms race-window alacsony kockázat.
- [ ] **D.5.3** — Race-test integration suite (k6 / custom Node-script). Eseti futtatás (NEM CI minden PR-on, költséges).

### D.6 Test-account user decision

- [ ] **D.6.2** — Test-account `69fe79e00022f3f9b2f6` (Sasi/`sashalmi.imre@gmail.com`) felhasználói döntés (maradhat vagy törölhető). Ha törlik, az új `user-cascade-delete` v4 cleanup-ol.

### H.6 Post-deploy E2E smoke (manuális)

- [ ] **H.6 admin-team ACL** — test-org 2 admin + 1 member: invite küldés admin-tól → `organizationInvites` ACL `team:org_X_admins`. Member belépés → NEM látja a pending invite-okat. Admin → látja. Invite accept → `organizationInviteHistory` ACL `team:org_X_admins`. Member NEM látja a history-t. Admin igen.
- [ ] **H.6 orphan-guard** — test-org `status='orphaned'` → próbálj UI-ból: rootPath-set, article-update, publication-update. Várt: 403 `org_orphaned_write_blocked` mind a 3 esetben. Reset `active`-ra → minden írás OK.
- [ ] **H.6 race-test** — k6/custom Node-script: 2-2 párhuzamos `acceptInvite` + opportunista `auto_expire_on_list` ugyanarra a token-re. Várt: pontosan 1 history rekord per invite, vagy `accepted` vagy `expired`, NEM mindkettő.
- [ ] **H.6 demote-test** — admin → member role-change → admin-team-ből kikerül. Új invite → ex-admin NEM látja.
- [ ] **Backfill admin-team ACL** — minden orgon `dryRun: true` ELŐSZÖR, aztán éles. Az action user-context-et igényel (org owner) — Appwrite Console (Functions → Execute) vagy egy admin-flow a dashboard-ról. Részletek: [[Döntések/0011-cas-gate-and-orphan-guard-invariants]] és [[Naplók/2026-05-09]] Session-6.

### Phase 3 deferred (ADR 0011 Harden Ph2 findingek + halasztott design)

- [ ] **CI generator drift hook** (Codex SHOULD): pre-commit hook (husky/lefthook) + GitHub Actions PR-validator a `check:cf-orphan-guard` + `check:cf-validator` (+ A.7.3, A.7.5 generálók) script-ekre. Trigger: ha generator-out-of-sync deploy bug történik.
- [ ] **Audit completeness** (Codex DESIGN, ADR 0011): a G.5 race-loser audit-loss formálisan pótolható egy "race-attempt-log" collection-nel (mind a két ágat append-only logolja). Trigger: külső compliance-regulátor explicit event-log követelménye.
- [ ] **Cursor invalidation** (Codex DESIGN, ADR 0011): a `paginateByQuery(fromCursor)` opaque cursor-t használ — ha a cursor-doc törlődik a futások között, undefined behavior. Trigger: élesben checkpoint-resume bukik. Mitigation: monotonic sort key + explicit `>` filter — Phase 2.x checkpoint-pattern impl-kor.
- [ ] **CAS-gate config-check vs auth precedence** (Codex DESIGN, ADR 0011): az `_assertCasGateConfigured()` az auth ELŐTT fut → unauthorized hívók info-disclosure-t kaphatnak a config-misconfig state-ről. A jelenlegi sorrend a fail-closed elv miatt elfogadható. Trigger: ha info-disclosure security audit ezt explicit ki-jelzi.
- [ ] **F.8 strict ACL invariáns** (ADR 0011): collection-szintű write-tilt `status='orphaned'` orgokra. A jelenlegi best-effort guard + F.9 deny-cache + Konstrukció C invite-CAS-gate elegendő. **Trigger**: élesben race-corrupcio incident.
- [ ] **E.6 hívó action-integráció** — `backfill_admin_team_acl` `payload.fromInviteCursor` + `nextCursor` return + a hívó iteratív retry-pattern. A `paginateByQuery` ready (`maxRunMs` + `fromCursor` + `incomplete`).

## Kész — vault hivatkozások

A korábbi tervek érett tartalma a vault kanonikus formáira költözött:

### Architektúra döntések (ADR-ek)
- **A blokk Permission rendszer + workflow-driven groups** (2026-05-01–02): [[Döntések/0008-permission-system-and-workflow-driven-groups]]
- **B blokk Workflow Extensions** (2026-05-04–05): [[Döntések/0007-workflow-extensions]]
- **Workflow lifecycle & scope**: [[Döntések/0006-workflow-lifecycle-scope]]
- **Membership user-identity denormalizáció**: [[Döntések/0009-membership-user-identity-denormalization]]
- **D blokk Meghívási flow redesign** (2026-05-08–09 Session-2): [[Döntések/0010-meghivasi-flow-redesign]]
- **E+F+G + Phase 2 + Harden — CAS-gate + orphan-guard invariánsok** (2026-05-09 Session-3–5): [[Döntések/0011-cas-gate-and-orphan-guard-invariants]]
- **Tenant Team ACL** (Fázis 2): [[Döntések/0003-tenant-team-acl]]
- **Dynamic groups** (Fázis 2): [[Döntések/0002-fazis2-dynamic-groups]]

### Komponensek / atomic notes
- **Permission taxonomy** (A blokk slug-katalógus): [[Komponensek/PermissionTaxonomy]]
- **Permission helpers** (server-oldal): [[Komponensek/PermissionHelpers]]
- **Workflow extensions** (Phase 0 implementáció): [[Komponensek/WorkflowExtension]] + [[Komponensek/ExtensionRegistry]]
- **Session preflight rule** (D.1.1, D.1.3): [[Komponensek/SessionPreflight]]
- **CF template** (új CF létrehozásához endpoint-default fix): [[Komponensek/CFTemplate]]
- **User identity map**: [[Komponensek/UserIdentityMap]]

### Csomagok
- **maestro-server akció-modul-térkép** (B.0.3 inkrementális split, single-source build-step-ek, CAS-gate referenciák): [[Csomagok/maestro-server]]
- **dashboard-workflow-designer**: [[Csomagok/dashboard-workflow-designer]]
- **meghívási flow**: [[Csomagok/meghivasi-flow]]

### Dashboard design
- **C blokk Editorial OS dark v2 + light theme** (2026-05-05–06): [[packages/maestro-dashboard/design-system|design-system.md]] + [tokens.css](packages/maestro-dashboard/css/tokens.css)
- **Copy-hygiene szabály** (C.0.3, file-local `LABELS` objektum): a [[packages/maestro-dashboard/design-system|design-system.md]]-ben dokumentált

### Munkafolyamat
- **Codex co-reflection alapelv** (D.0): [[Munkafolyamat#Codex co-reflection alapelv]]
- **Manuális smoke teszt checklist**: [[Munkafolyamat#Manuális smoke teszt checklist]]
- **Session preflight**: [[Munkafolyamat#Session preflight]]

### Naplók (Karpathy-tudástár 2026-04-28 óta)
- [[Naplók/2026-05-01]] — A blokk Tervek lebontása + B blokk indító döntések
- [[Naplók/2026-05-02]] — A.2 szerver-implementáció harden-irányított session
- [[Naplók/2026-05-03]] — A.7.1 single-source build-step refactor
- [[Naplók/2026-05-04]] — B.0.3 modul-split + B.1+B.2+B.3 implementáció
- [[Naplók/2026-05-05]] — B.4 Plugin runtime + B.5 Dashboard UI + C.1 Stitch screen-iteráció
- [[Naplók/2026-05-07]] — Membership user-identity denormalizáció (ADR 0009)
- [[Naplók/2026-05-09]] — D.2–D.7 + E+F+G + Phase 2 + Harden + Deploy (Session-2 → 6)
