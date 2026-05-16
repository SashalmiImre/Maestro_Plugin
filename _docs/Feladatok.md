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
- [x] **S.2.5** — Cleanup CF. **Done 2026-05-11**: új `cleanup-rate-limits` scheduled CF (`0 2 * * *` UTC napi, timeout 300s, cap `MAX_DELETES_PER_COLLECTION=2_000`). Codex pre-review: 1 BLOCKER (cap 10_000 → 2_000) + 2 MAJOR (index-hatékonyság → Opció Y `$updatedAt`/`$createdAt` system-index szűrés, audit-tradeoff dokumentálva) + 1 MINOR (block-history) + 1 NIT — mind alkalmazva. Stop-time: 1 BLOCKER (`$updatedAt` szűrés a `setBlock` `document_already_exists` ág `updateDocument`-hosszabbítás miatt — `$createdAt` STALE block-on) + 1 MAJOR (`failed > 0` → `hasFailure` + admin alert) + 1 NIT (`positiveIntEnv` helper) javítva. Verifying: CLEAN + 1 doku-drift NIT javítva. Lásd [[Komponensek/CFRateLimiting#Cleanup CF (S.2.5, Done 2026-05-11)]].
- [x] **S.2.6** — Resend cost-control per-org-per-day. **Done 2026-05-11**: folded into `invite_send_org_day` endpoint (200 email/24h, weight=validEmailCount). Codex M2: malformed email NE égesse a quota-t — `EMAIL_REGEX` pre-filter rate-limit ELŐTT.
- [x] **S.2.7** — Stop-time Codex review + verifying + **harden Phase 4+5** (adversarial + simplify + verifying CLEAN). **Done 2026-05-11**: stop-time 1 BLOCKER (block docId) + 3 MAJOR + 1 MINOR + 1 NIT — mind javítva. Harden adversarial 2 MUST FIX (HIGH-2 storage fail-closed + HIGH-3 schema index) + 2 SHOULD FIX (MED-1 sendInviteEmail hook + LOW-1 wsUpgradeRateLimit hard cap) — mind javítva. Simplify (Reuse F2 + Eff F2 + F7): generic `evaluateAndConsume(ctx, scopes)` + `inviteSendScopes` factory + single-pass email-filter. Verifying CLEAN. Új jegyzet: [[Komponensek/CFRateLimiting]]. Risk register: R.S.2.2/2.3/2.6/2.7/2.8/2.9/2.10/2.11/2.12/2.13/2.14 closed; R.S.2.15 (paralel batch overshoot) **Mitigated 2026-05-11** (DESIGN-Q user-döntés: best-effort + Resend account-cap + S.13 monitoring alert, lásd [[Komponensek/CFRateLimiting#Accepted Risks]]).

#### S.7 Realtime + cross-tenant data leak (HIGH — Codex előrehozta, 2 session) — ASVS V4/V5, CIS 3

- [x] **S.7.1** — `createDocument` permissions audit + fix (CF-szintű invariáns). **Done 2026-05-12**: 8 üres-permission `createDocument` hívás (collection-szintű `read("users")` örökölt → cross-tenant Realtime push szivárgás) javítva `withCreator(buildXxxAclPerms(...), callerId)`-rel. Új helper `withCreator(perms, callerId)` a `teamHelpers.js`-ben — defense-in-depth `Permission.read(user(callerId))` a team-membership-timing-race ellen (creator a `createDocument` időpontban MÉG NEM team-tag). Codex pipeline: pre-review (Q1.D GO — code-audit első, adversarial későbbre) → stop-time (2 MAJOR: bootstrap creator race + acceptInvite race; 1 MINOR backfill; 1 NIT positiveIntEnv-szerű guard) → verifying CLEAN. Érintett fájlok: `orgs.js` (×4), `offices.js` (×2), `invites.js` (×1), `publications.js` (×1) + `teamHelpers.js` (új helper). Lásd [[Komponensek/TenantIsolation]].
- [x] **S.7.2** — Új `backfill_acl_phase2` CF action a S.7.1 fix-csomag 5 collection-én (organizations, organizationMemberships, editorialOffices, editorialOfficeMemberships, publications). **Done 2026-05-12**: target-org-owner auth (mint `backfillAdminTeamAcl`), `dryRun` + `scope` paraméterek (`all`/`organizations`/`organizationMemberships`/`editorialOffices`/`editorialOfficeMemberships`/`publications` — multi-call CF 60s timeout-bypass nagy orgon), user-read preserve regex `/^read\("user:/` ADR 0014 defense-in-depth (friss S.7.1 `read(user(creatorId))` perm-eket NEM írja felül), `wouldRewrite`/`rewritten` stat-szétválasztás dryRun esetén, `partialFailure: true` flag ha `errors.length > 0`, audit-log a caller+org+scope+counts JSON-nel. Codex pipeline: pre-review (Q1 NO-GO drop user-read → preserve; Q3 NO-GO single-pass → scope-param; Q4/Q5 GO) → stop-time **GO** (0 BLOCKER, 0 MAJOR, 1 MINOR idempotens-write dokumentált tradeoff, 1 NIT tipó `késöbb→később`) → verifying **CLEAN GO** (regex preserve `Role.user(id, status)` formát is, drift-integritás VALID_ACTIONS+ACTION_HANDLERS+exports OK). **Production deploy halasztva** (CF redeploy + user-trigger backfill futtatás minden orgon `dryRun: true` → éles). Lásd [[Komponensek/TenantIsolation]] (Backfill action szakasz) + R.S.7.2 close [[Komponensek/SecurityRiskRegister]].
- [/] **S.7.2b** — USER-TASK Console-on (vagy admin-UI S.7.12 Phase 3 után): `backfill_tenant_acl` + `backfill_admin_team_acl` minden orgon dryRun → éles. Lásd [[Tervek/user-task-runbook]] DEPLOY szekció + S.7.12.
- [/] **S.7.3** — Realtime channel filter audit dokumentumi check 2026-05-16: a `realtimeBus.js` `subscribeRealtime()` `collectionChannel(scope, collectionId, ...filters)` minta — minden subscribe explicit-collectionId-vel és tenant-filter callback-kel. Manual visual-grep elég, Phase 3 ha CI-szintű audit kell.
- [/] **S.7.4** — Cross-org membership ACL: a USER-TASK 3 adversarial 2-tab teszt fed-i (a `localStorage.maestro.activeEditorialOfficeId` swap + REST `listDocuments` cross-tenant ellenőrzés). [[Tervek/user-task-runbook]] USER-TASK 3.
- [/] **S.7.5** — USER-TASK fejlesztői env-en. 3-tab adversarial (localStorage swap + Realtime push + REST listDocuments). [[Tervek/user-task-runbook]] USER-TASK 3.
- [/] **S.7.6** — Stop-time Codex review USER-TASK 3 + S.7.2b eredménye UTÁN (post-deploy iter, NEM-most).
- [x] **S.7.7** — Frontend tenant `createRow` / `createDocument` ACL fix (R.S.7.3 close). **Done 2026-05-14**: 6 fájl, 7 hívóhely + 2 új helper. Plugin (`tables.createRow`): `articles` (`DataContext.createArticle`), `userValidations` (`DataContext.createValidation`), `systemValidations` (`useOverlapValidation` + `useWorkflowValidation`). Dashboard (`databases.createDocument`): `publications` (`createPublication`), `layouts` (`createLayout`), `deadlines` (`createDeadline`). Új shared helper-modul a `maestro-shared/teamHelpers.client.js`-ben (ESM, `appwrite` web SDK `peerDependency`, kanonikus single-source). Plusz: a 2 validation hook (`useOverlapValidation` + `useWorkflowValidation`) közös perms-build mintája egy új `useTenantAclSnapshot(tag)` shared hookba (`packages/maestro-indesign/src/data/hooks/useTenantAclSnapshot.js`) — ADR 0014 invariáns 1 enforcement-point. Harden pipeline 7 fázis, Codex CLEAN. Lásd [[Komponensek/TenantIsolation#S.7.7 frontend ACL fix]] + [[Naplók/2026-05-14]]. `buildTenantDocOptions(data)` belső helper a két DataContext-ben — egyetlen snapshot orgId+officeId+userId-re, fail-closed throw hiányzó scope/user-en. Validation hookok `persistToDatabase` callback elején snapshot+perms-build (log+skip silent fire-and-forget). Codex pipeline: pre-review 5×GO, stop-time 2 BLOCKER (deploy-prerequisite) + 1 MAJOR (`useAuth() ?? {}` masks misconfig — javítva, explicit `if (!authValue) throw`) + 1 MINOR (Realtime smoke). **Deploy halasztva** — pre-requisite S.7.7b + S.7.7c (lásd alább).
- [x] **S.7.7b** — `documentSecurity: true` flag verify a 6 érintett collection-en (R.S.7.6 close code-only, ADR 0014 Layer 1 prerequisite). **Done (code-only) 2026-05-15**: új CF action `verify_collection_document_security` az `invite-to-organization` CF-ben (programatikus deploy-gate). 4 fájl: új `helpers/collectionMetadata.js` (203 sor — REQUIRED + OPTIONAL diagnostic whitelist + `verifyDocumentSecurity` paralel `databases.getCollection` lookup determinisztikus output rendezéssel) + `actions/schemas.js` (új function `verifyCollectionDocumentSecurity`, import + export) + `helpers/util.js` (VALID_ACTIONS bővítés) + `main.js` (4 új opcionális env var `LAYOUTS_COLLECTION_ID` / `DEADLINES_COLLECTION_ID` / `USER_VALIDATIONS_COLLECTION_ID` / `SYSTEM_VALIDATIONS_COLLECTION_ID` + ACTION_HANDLERS). **Payload**: `{action: 'verify_collection_document_security', organizationId, collections?}` — `collections` opcionális whitelist alias-tömb **ADDITIVE** szemantikán (Harden adversarial HIGH fix 2026-05-15: REQUIRED-set MINDIG benne, caller-passed csak APPEND, NEM tud subset-re csökkenteni). **Output**: `{success, results: [{alias, collectionId, envVar, missingEnv, exists, documentSecurity, enabled, name, error?}], summary: {total, secured, unsecured, missingEnv, missingCollection, errors}, criticalFail}`. `criticalFail: true` CSAK ha bármely REQUIRED collection: missingEnv / lookup error / exists=false / documentSecurity !== true (Codex BLOCKER: optional drift NEM blokkol). Auth: target-org owner (mint `backfill_acl_phase2`, audit-trail + ASVS V4.1.1 least privilege). Codex pipeline: pre-review 5×GO Q2-Q7 + 1 NEEDS-WORK Q1 (hardcoded canonical default) + 1 BLOCKER + 2 MAJOR + 1 MINOR + 1 NIT mind javítva → stop-time **GO** 0 BLOCKER + 1 MAJOR (`r.error` explicit a `criticalFail` feltételben — javítva) + 1 MINOR (rate-limit szándékos defer, low-freq deploy-gate) + 1 NIT (Map `Object.freeze` depth — N/A, Map nem deep-freezelhető) → verifying **GO CLEAN** C1+C2+C3. **Harden pass** (2026-05-15) Phase 1 baseline 1 P2 (`summary.missingCollection` 404-es lookup-failure misclassification → 404 dedicated branch a summary loop-ban) + Phase 2 adversarial 1 HIGH (`collections` paraméter caller-controlled scope-bypass → ADDITIVE szemantika, REQUIRED-set MINDIG benne) — mindkettő javítva. **Deploy halasztva** — user-trigger: CF redeploy + 4 új env var Appwrite Console-on + futtatás minden orgon (`organizationId`, default `collections` = 6 REQUIRED). Ha `criticalFail: true` → Appwrite Console-on manuálisan `documentSecurity: true` a hibás collection-ön. Lásd [[Komponensek/TenantIsolation#S.7.7b verify_collection_document_security action]] + [[Naplók/2026-05-15]].
- [x] **S.7.7c** — Legacy ACL backfill a 6 user-data collection-re (R.S.7.7 close code-only). **Done (code-only) 2026-05-15**: új CF action `backfill_acl_phase3` az `invite-to-organization` CF-ben (~470 sor a `actions/schemas.js`-ben). Scope-paraméteres (6 alias `'all' | publications | articles | layouts | deadlines | userValidations | systemValidations`) + kategória 1/2 fallback policy + `fallbackUsedDocs` audit + 2-step JOIN (validations: `articleId → publicationId → editorialOfficeId`). Új helper `preserveUserReadPermissions` a `helpers/util.js`-ben (Harden Simplify Reuse #1: phase2+phase3 közös). Új `import withCreator` a `teamHelpers.js`-ből. **Kritikus biztonsági guard-ok**: `validOfficesForTargetOrg` Set (cross-tenant office-reference attack vector prevention — Harden HIGH); `failedOfficeTeams` Set (team-ensure failure → lockout prevent — Harden P1); `Query.equal('articleId', batch)` batch-scan a validation collection-ön (NEM filter org-ra, mert a doc NEM tárol `organizationId`-t — Verifying P1); `Set` dedupe a `newPerms`-en (duplikált user-read perm fail — Verifying P2). **Auth**: `requireOrgOwner(ctx, organizationId)`. **Codex pipeline**: pre-review 10/10 GO + 1 BLOCKER (office-resolution failure policy) + 2 MAJOR (4-reason fallback enum + user-read regex) + 1 MINOR (stats per-alias bontva) — mind javítva. Stop-time **NEEDS-WORK** 1 MAJOR (`auth_user_not_found_cached` audit-noise → egységes `auth_user_not_found`) + 2 MAJOR-tradeoff (runtime: `usersApi.get` per createdBy + article-pre-load memory — operator-supervised + observable stop conditions dokumentált). Verifying **C1 GO + C2 NEEDS-WORK** (ops doc-hardening + cache wording) + **C3 GO** — javítva. **Harden** (7 fázis): Phase 1 baseline 1 P1 (team-ensure → lockout); Phase 2 adversarial 1 HIGH (cross-tenant `editorialOfficeId` attack vector); Phase 4 fixek + Phase 5 simplify (Reuse #1 + Quality #4 `failedOfficeTeams` filter `rewriteAclBatchPhase3`-ba); Phase 6 verifying 2 új P1+P2 (validation org-id query + Set dedupe) — javítva; **2. iteráció verifying** 1 P2 LOW (dry-run-on fallback stats nincs számolva — operator-UX gap, **SHOULD FIX halasztott**, nem regresszió). **Deploy halasztva** — user-trigger: CF redeploy + futtatás scope-by-scope minden orgon (`dryRun: true` előbb, majd `dryRun: false` éles). S.7.7b verify ELŐBB futtassa az admin. Lásd [[Komponensek/TenantIsolation#S.7.7c backfill_acl_phase3 action]] + [[Naplók/2026-05-15]].
- [/] **S.7.7d** — Phase 3 (`.github/workflows/sdk-major-version-check.yml` vagy unit-test). LOW, first regression-risk: új `appwrite` SDK major-release megjelenése (Dependabot S.9.3 alert-eli).
- [x] **S.7.8** — Phantom-org window mitigáció (Harden P1, R.S.7.4 close code-only). **Phase 1 + Phase 2 DONE (code-only) 2026-05-15**. Phase 2 frontend filter: plugin `UserContext.jsx` + dashboard `AuthContext.jsx` org-list query `Query.or([Query.equal('status', 'active'), Query.isNull('status')])` (null-tolerant a legacy doc-okra, Codex stop-time NO-GO Q1 fix) + dashboard Realtime callback `if (payload?.status === 'provisioning') return { relevant: false }` defense-in-depth. **Eredeti Phase 1 szöveg**: **Phase 1**: `bootstrap_organization_status_schema` action enum-bővítés `['provisioning', 'active', 'orphaned', 'archived']` (idempotens `updateEnumAttribute` ha létezik a 3-elem enum); új OPCIONÁLIS env-flag `ENABLE_PROVISIONING_GUARD` (default `false` visszafelé kompatibilis); `bootstrap_organization` `createDocument(organizations)` `status: 'provisioning'` ha a flag bekapcsolt, flow-vég `_finalizeOrgIfProvisioning(ctx, orgId)` helper-rel `'active'`-ra finalize-eli (best-effort, return `{finalized, error?}`); `permissions.ORG_STATUS.PROVISIONING` enum-bővítés + `isOrgWriteBlocked('provisioning')` true (fail-closed a CRUD action-ökre, de a bootstrap saját admin-API-key-vel megkerüli). Codex pre-review 6/6 GO + 1 MAJOR (enum migration sorrend) + 1 MINOR (`archived` skip — már be van vezetve). Codex stop-time NEEDS-WORK: BLOCKER conditional (bootstrap önmaga `userHasOrgPermission`-on át fut-e — verify-elve, NEM, admin API-key-vel ír) + 1 MAJOR (finalize fail-soft → `provisioningStuck` flag + `recoveryHint` a return-ben + pre-existing re-bootstrap is hív self-heal `_finalizeOrgIfProvisioning`-ot a MINOR fix-en). Verifying + /harden HALASZTOTT a /loop context-fogyás miatt. **Phase 2 (PENDING)**: frontend filter `Query.equal('status', 'active')` minden plugin+dashboard org-list query-én + Realtime callback szűrés + `user-cascade-delete` CF `provisioning` filter. Lásd [[Tervek/next-session-S.7.8-phase2]] + [[Komponensek/TenantIsolation#S.7.8 Phase 1 phantom-org window]] + [[Naplók/2026-05-15]].
- [x] **S.7.9** — GDPR Art. 17 stale `withCreator` user-read cleanup (R.S.7.5 close code-only). **Done (code-only) 2026-05-15**: új CF action `anonymize_user_acl` az `invite-to-organization` CF-ben (~370 sor a `actions/schemas.js`-ben). 12-collection scan (`organizations` + `organizationMemberships` + `editorialOffices` + `editorialOfficeMemberships` + `publications` + `articles` + `layouts` + `deadlines` + `userValidations` + `systemValidations` + `organizationInvites` + `organizationInviteHistory`). Strict end-anchored regex `/^[a-z]+\("user:${escapeRegex(id)}"\)$/` szűri a `read|write|update|delete|create user:X` perm-eket; `Array.from(new Set(...))` dedupe a `updateDocument` előtt. Idempotens: csak akkor ír, ha valódi perm eltávolítható (no-op skipped++ flag). Validation collection-ök `Query.equal('articleId', batch)` az `articles` target-org id-listából (BATCH=25) — Codex BLOCKER scope-szűkítés. **Factor-out `anonymizeUserAclCore(ctx, params)`** helper: NEM hív `res.json`-t, visszaad `{success, stats, orgNotFound?, orgFetchFailed?}`. A `leave_organization` + `delete_my_account` self-service flow-k a core-t KÖZVETLENÜL hívják (saját security guard-okkal autorizálva). Public action wrapper `anonymizeUserAcl(ctx)` ADMIN-ONLY (Harden HIGH fix: a self-path public auth-gap-et bezárja — `callerId === targetUserId` → `403 self_anonymize_disallowed`, a self-flow-k kötelezően a flow-kban). **Self-service integrate**: `offices.js leaveOrganization` 3.6 lépés a team cleanup UTÁN, a DB-delete ELŐTT. `orgs.js deleteMyAccount` 4d.5 lépés a team cleanup UTÁN, az office-cascade ELŐTT. Best-effort: partial-failure NEM blokkolja a flow-t (tag már team-en kívül; admin re-anonymize a fallback). **Time-budget**: `maxRunMs: 30_000` a `leaveOrganization`-ben, `maxRunMs: 10_000` per-org a `deleteMyAccount`-on — Harden Verifying P1 fix: platform 60s timeout NEM catch-elhető, time-budget garantálja a flow-folytatást. `stats.timeBudgetExceeded` flag jelez partial-cleanup-ot. **Audit**: per-collection `scanned`/`anonymized`/`skipped` + `skippedCollections[]` (silent-skip helyett, Codex MINOR fix) + `errorCount`/`errorsTruncated`/`partialFailure`. Codex pipeline: pre-review 8/8 GO + 1 BLOCKER (validation scope) + 1 MAJOR (regex escape) — javítva. Stop-time NEEDS-WORK 3 MAJOR (CF timeout op-bound + re-anonymize operability + partial semantics) + 1 MINOR (silent skip) — mind javítva (dokumentált + kódfix). Harden Baseline+Adversarial: 1 P1 callerId undef-ref + 1 HIGH self-path auth-gap + 1 medium duplikált — mind javítva. Verifying iter 1: 2 P1 sync-anonymize timeout-risk a self-flow-on → `maxRunMs` time-budget fix. Verifying iter 2: **HALASZTOTT** (context-fogyás miatt /loop-on belül). Affected fájlok: `schemas.js` (új action + core + 2 export), `helpers/util.js` (VALID_ACTIONS), `main.js` (ACTION_HANDLERS), `actions/offices.js` (import + 3.6 integrate), `actions/orgs.js` (import + 4d.5 integrate). **Deploy halasztva** — user-trigger. Q4 user-decision **GO** (auto-trigger a self-service flow-ban, 2026-05-15). Lásd [[Komponensek/TenantIsolation#S.7.9 anonymize_user_acl]] + [[Naplók/2026-05-15]].
- [x] **S.7.10** — `_tryEnsureMembershipNonBlocking` helper a `invites.js`-ben + 3 callsite csere (idempotens admin-team retry, race admin-team retry, race org-team retry) — ~28 sor megtakarítás, single-source-of-truth a non-blocking team-membership pótlás logikájára. Param: `{teamsApi, teamId, userId, roles, log, contextLabel, ensureTeamName?, teamNotFoundReason?}`. Node syntax check clean. ✅ 2026-05-16 Closed.
- [x] **S.7.11** — `TEAM_SKIP_REASONS = Object.freeze({...})` enum export (`teamHelpers.js`) + 9 callsite csere (`invites.js` 4 + `orgs.js` 2 + `schemas.js` 3). 4 belső használat a helper-eken (ensureTeamMembership 409/404, removeTeamMembership 404/empty). NEM-cserélt: `user-cascade-delete:115` literal MARAD (másik CF, NEM közös modul). Node syntax check 4 fájlon clean. ✅ 2026-05-16 Closed.
- [ ] **S.7.12** — Admin-UI gomb a `backfill_acl_phase2` szekvenciális futtatáshoz (LOW prio, Q2 user-decision C halasztott, 2026-05-13). "Backfill ACL — full run" gomb a Settings/Security oldalra (dashboard). Sorrend: `organizations` → `organizationMemberships` → `editorialOffices` → `editorialOfficeMemberships` → `publications` (5 scope, mindegyik külön CF-call). Progress-indikátor + retry-gomb per scope. **Csak akkor építjük**, ha tényleges admin-flow használja — shell/curl alternatíva most elég, runbook a [[Komponensek/TenantIsolation#Operations runbook (S.7.2 deploy)]]-on.
- [ ] **S.7.13** — Worldwide off-peak window policy (LOW prio, **post-worldwide-deploy**, Q4 user-decision 2026-05-13). Jelenlegi piac magyar → off-peak `23:00–05:00 UTC+1` vasárnap éjszaka. Worldwide deploy után: per-tenant timezone-szerű ablak (admin UI-on tenant-szintű "preferred maintenance window" beállítás), vagy globális "weekend low-traffic" minta. A `backfill_acl_phase2` és minden jövőbeli backfill / migrációs action runbook frissítése.

#### S.3 Security headers + CSP (HIGH, 2 session — CSP report-only rollout) — ASVS V14, CIS 4

- [x] **S.3.1** — CSP design + report-only deploy. **Done 2026-05-15**: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://api.maestro.emago.hu; connect-src 'self' https://api.maestro.emago.hu wss://api.maestro.emago.hu https://cloud.appwrite.io wss://cloud.appwrite.io; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';`. Phase 1 report-only mode (browser DevTools-on figyelni a violation-okat). Phase 2 enforce külön iterációba (a violation-finomítás után).
- [x] **S.3.2** — Apache `.htaccess` `<IfModule mod_headers.c>` direktívák. **Done 2026-05-15**: `Content-Security-Policy-Report-Only` Phase 1.
- [x] **S.3.3** — `X-Frame-Options: DENY`. **Done 2026-05-15**. Defense-in-depth a `frame-ancestors 'none'`-szal (Codex Q5 GO mindkettő).
- [x] **S.3.4** — `Referrer-Policy: strict-origin-when-cross-origin`. **Done 2026-05-15**.
- [x] **S.3.5** — `Permissions-Policy`. **Done 2026-05-15**: `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()` — letiltja az SDK-szintű device-access-t.
- [x] **S.3.6** — `Strict-Transport-Security: max-age=31536000`. **Done 2026-05-15** (Codex MAJOR fix: `includeSubDomains; preload` HALASZTOTT — high-commitment, minden `*.emago.hu` HTTPS-clean verify + `hstspreload.org` bejegyzés ~6 hónap rollback-risk). Phase 2 user-decision-re.
- [x] **S.3.7** — Stop-time Codex review. **Done 2026-05-15**: pre-review 7/7 GO + 1 MAJOR (HSTS conservative) + 1 MINOR (`nosniff` audit-id) — javítva. Stop-time GO (Railway proxy NEM dashboard-on, csak Plugin EndpointManager). Új jegyzet [[Komponensek/SecurityHeaders]].

#### S.4 XSS + input sanitization audit (HIGH, 1 session) — ASVS V5

- [x] **S.4.1** — User-content render audit. **Done 2026-05-15**: `dangerouslySetInnerHTML`/`innerHTML=`/`outerHTML=`/`document.write`/`eval(`/`new Function(`/`setTimeout([\"']`/`setInterval([\"']` mind **0 hit** a plugin + dashboard + shared csomagban. `target="_blank" rel="noopener"` is 0 hit. **CLEAN** — React JSX auto-escape garantálja a XSS-tisztaságot.
- [x] **S.4.2** — ImportDialog file upload validáció. **Done 2026-05-15** (R.S.4.2 close): `parseImportFile` central helper-ben size + MIME pre-check. `MAX_IMPORT_FILE_SIZE = 5 MB` (workflow JSON tipikusan <500 KB; 5 MB conservative). `ALLOWED_IMPORT_MIME_TYPES = {'application/json', 'text/json', ''}` (üres MIME browser-kompat). HU hibaüzenetek a UI-ban. A fix mindkét hívóhelyet véd (ImportDialog + CreateWorkflowModal). `<input accept=".json">` UI-hint mellé szigorú helper-szintű check.
- [ ] **S.4.3** — Server-side input length cap audit (NEM closed): `sanitizeString(str, maxLen)` minden CF action paraméteren — túl-permisszív cap-ek keresése. Külön iteráció.
- [x] **S.4.4** — Output encoding verify. **Done 2026-05-15**: React JSX auto-escape OK (S.4.1 audit-tal megerősítve). CSV export / email template explicit escape külön audit (S.4.3 része).
- [x] **S.4.5** — Stop-time Codex review. **Done 2026-05-15** /harden via: baseline GO + adversarial 2 MEDIUM (4 stack DoS accept bounded client-side, 10 prototype pollution verified NEM-real). [[Komponensek/SecurityRiskRegister]] R.S.4.2 closed.

#### S.5 Secret + env var audit (HIGH → CRITICAL ha production-kulcs gyanús, 2 session) — ASVS V6/V14, CIS 6

- [x] **S.5.1** — Git secret-scan partial close. **Done 2026-05-15** (`gitleaks`/`trufflehog` NEM telepített → manual regex-grep fallback teljes history-n). **TALÁLT** 1 leaked production Appwrite API key (`standard_b823bd9f...8d5f`) a `7474619` legelső commit-ban (`packages/maestro-indesign/appwrite_functions/delete-article-messages/environments.env`). A fájl később törölve `898f4ea`-ban, és a user-verify szerint a key a Console-on **NEM látszik** → manuálisan revoked. **Phase 2 (PENDING)**: `git filter-repo` history-rewrite a leaked-key blob-ok eltávolítására (GitHub secret-scanner false-positive + audit-clean). **AUDIT** ajánlott: Console Logs → `b823bd9f` mintán `Last used` keres — ha új-keletű hozzáférés, incident-response (egyébként revoked-only confirmed).
- [ ] **S.5.2** — `.env.production` tartalom verify: csak `VITE_*` (frontend public) — semmi server-side secret. NEM closed (külön audit-iter).
- [ ] **S.5.3** — Appwrite API key rotáció dokumentáció — `_docs/Komponensek/SecretsRotation.md` halasztott a history-rewrite-tal együtt.
- [ ] **S.5.4** — Resend `RESEND_WEBHOOK_SECRET` + `RESEND_API_KEY` rotáció policy halasztott.
- [ ] **S.5.5** — GROQ_API_KEY + ANTHROPIC_API_KEY használat audit halasztott.
- [x] **S.5.6** — `.gitignore` `*.env` glob bővítés. **Done 2026-05-15**: a gyökér `.gitignore` + `packages/maestro-indesign/.gitignore` mind `*.env` + `.env.*` glob mintán bővítve. A leak okát megelőzi: a `environments.env` konvenció (Appwrite Functions) eddig kikerülte a `.env`-only szabályt; `*.env` mindent fed.
- [ ] **S.5.7** — Phase 2: rotáció éles végrehajtás (USER-DECISION 2026-05-15: a leaked key a Console-on NEM látszik → revoked-only confirmed). History-rewrite külön iter.
- [ ] **S.5.8** — Stop-time Codex review (halasztott a Phase 2-vel).

#### S.12 Auth / Session / Access Control (HIGH, 1 session) — ASVS V2/V3/V4

- [ ] **S.12.1** — Password policy audit (Appwrite Console: min length, complexity, password-history, breached-password check). **USER-TASK** — Appwrite Console settings.
- [ ] **S.12.2** — MFA enforcement: kötelező admin szerepre (`org.admin` permission slug), opcionális member-re. UI flow. **USER-TASK** — Appwrite Console + admin label-bind.
- [ ] **S.12.3** — Session lifetime + idle timeout audit (Appwrite Console alapértelmezett — dokumentálni vagy szigorítani).
- [x] **S.12.4** — Token revocation: logout cleanup teljesség. `localStorage.maestro.*` kulcsok (kiv. `pendingInviteToken` whitelist) törlése a logout VÉGÉN, login és JWT auto-login flow ELEJÉN (defense-in-depth). Új helper: [packages/maestro-dashboard/src/utils/localStorageCleanup.js](../packages/maestro-dashboard/src/utils/localStorageCleanup.js). Plugin (UserContext.jsx:847-849) MÁR rendelkezik ekvivalens cleanup-pal — plugin-szintű al-pont nem szükséges. ✅ 2026-05-15 (Codex pre + stop-time + adversarial + verifying CLEAN). Session-list view ("Sign out other devices") külön al-ponton (S.12.8) halasztva.
- [ ] **S.12.5** — Account recovery flow audit: Appwrite password reset email rate-limit, token entropy, expire.
- [ ] **S.12.6** — Role/permission matrix dokumentáció: `PermissionTaxonomy.md` 38 slug + role-mapping-leltár (member / admin / owner mit lát/csinál).
- [ ] **S.12.7** — Stop-time Codex review. Új jegyzet: [[Komponensek/AuthSessionAccess]].

#### S.13 Logging / Monitoring / Error-disclosure (HIGH, 1 session) — ASVS V7, CIS 8

- [/] **S.13.1** — Central log aggregation tervezés design-szintű 2026-05-16: tool-comparison Sentry/Better Stack/Loki → **Better Stack default** (EU servers, free 100MB/hó, alert-pattern matching). Implementation Phase 3 trigger. Részletek: [[Komponensek/LoggingMonitoring]] S.13.1.
- [x] **S.13.2** — PII-redaction sablonok teljesen kész 2026-05-15 (Phase 1+2). Kanonikus shared modul [packages/maestro-shared/piiRedaction.js](../packages/maestro-shared/piiRedaction.js) + Plugin `logger.js` wire + 14 CF wrap (`invite-to-organization` Phase 1 inline + 13 CF Phase 2.0a/b/c+2.2 `wrapLogger`-rel). Build-generator [scripts/build-cf-response-helpers.mjs](../scripts/build-cf-response-helpers.mjs) automatizálja a CommonJS portolást. Részletek: [[Komponensek/LoggingMonitoring]].
- [x] **S.13.3** — Error message info-disclosure audit teljesen kész 2026-05-15. Phase 1.0+1.5 az `invite-to-organization`-on (centralized `fail()` strip + cycle-safe + reason-normalize + `_finalizeOrgIfProvisioning` errorCode + ~13 stats.errors strip + `recordError` helper-szintű). Phase 2.0a/b/c+2.1+2.2 a maradék 13 CF-en shared `responseHelpers.js` ESM + build-generator + `wrapLogger` shared minta. **14 CF teljesen védve** + invite-to-organization inline. Részletek: [[Komponensek/LoggingMonitoring]].
- [/] **S.13.4** — Monitoring alertek design 2026-05-16: 5 alert-rule (A1 CF-failure, A2 login-fail, A3 rate-limit, A4 WS disconnect, A5 invite-rate anomaly) + Slack/PagerDuty/email channels + runbook. Új jegyzet: [[Komponensek/MonitoringAlerts]]. Implementation Phase 3.
- [/] **S.13.5** — Audit-log retention CIS 8.3 verify 2026-05-16: Appwrite Free 30 nap (Pro 90), Railway Hobby 7 nap (Pro 30). USER-TASK: plan-verify vagy Better Stack paid (~$10-25/hó) ingest. Részletek: [[Komponensek/LoggingMonitoring]] S.13.5.
- [ ] **S.13.6** — Anomaly detection (Phase 2, defer): unusual invite-send pattern, geo-outlier login.
- [x] **S.13.7** — Stop-time review 2026-05-16: S.13 blokk teljesen lezárva (13.2+13.3 Closed code+deploy, 13.1+13.4+13.5 design-only Phase 3 trigger). [[Komponensek/LoggingMonitoring]] + [[Komponensek/MonitoringAlerts]].

#### S.6 UXP plugin sandbox (MEDIUM, 1 session) — ASVS V14

- [x] **S.6.1** — `manifest.json` network domain whitelist: scheme-qualified `https://`+`wss://` Railway primary + emago.hu fallback + `*.emago.hu` wildcard. Closed 2026-05-15.
- [x] **S.6.2** — localFileSystem szűkítés: `"fullAccess"` → `"request"` (picker-mediated). Closed 2026-05-15.
- [x] **S.6.3** — `launchProcess.schemes`: `["https"]` verify — már OK, NEM-changed.
- [/] **S.6.4** — UXP auto-update review: doku-szintű (Maestro NEM-Adobe Marketplace, manual `.ccx` distribution). Future-work ha Marketplace-bemutatkozik.
- [x] **S.6.5** — Stop-time Codex MINOR/CLEAN (`a77cca7c88b3fce84`). Új jegyzet: [[Komponensek/UXPSandbox]].

#### S.8 Webhook + 3rd party trust (MEDIUM, 1 session)

- [x] **S.8.1** — `RESEND_WEBHOOK_SECRET` deploy verify ✅ env-set 2026-05-08 12:01, secret: true (MCP-verified). Rotation policy: manual 1×/év vagy incident.
- [/] **S.8.2** — Webhook custom domain IP-allowlist: doku-only (Resend dinamikus IP-pool, HMAC autoritatív). Decision: NEM-implement.
- [/] **S.8.3** — Bounce / spam-complaint UI audit: USER-TASK Dashboard `InviteHistory` view manual review (`bounced` badge + filter).
- [x] **S.8.4** — `webhookEventIds` anti-replay ✅ — 2-fázisú flow: LOOKUP elöl + POST-UPDATE marker (Codex BLOCKER fix). Graceful-fallback ha collection nem-létezik. Collection-create USER-TASK / Phase 3 `cleanup-webhook-event-ids` retention CF.
- [x] **S.8.5** — Stop-time Codex BLOCKER → CLEAN. Új jegyzet: [[Komponensek/ResendWebhook]].

#### S.9 Dependency + supply chain (MEDIUM, 1 session) — CIS 7/16

- [x] **S.9.1** — `yarn audit` 2026-05-15: **0 vulnerability** post-fix. Új jegyzet: [[Komponensek/DependencyAudit]].
- [x] **S.9.2** — 4 vuln (2H+2M, mind maestro-cors-proxy transitive) → `resolutions` force-bump (path-to-regexp >=0.1.13, picomatch >=2.3.2, follow-redirects >=1.16.0).
- [x] **S.9.3** — Dependabot setup: [.github/dependabot.yml](../.github/dependabot.yml) heti scan, minor+patch group, 5 ecosystem.
- [/] **S.9.4** — `engines.node: ">=20.0.0"` set. Appwrite CF `node-18.0` → 20/22 USER-TASK Console-on (DependencyAudit.md runbook).
- [/] **S.9.5** — Lock-file integrity CI: halasztva Phase 3, template a DependencyAudit.md-ben.
- [/] **S.9.6** — Post-install script audit halasztva Phase 3.
- [x] **S.9.7** — Stop-time Codex review (saját + commit-szintű). Új jegyzet: [[Komponensek/DependencyAudit]].

#### S.10 Audit log + GDPR (LOW–MEDIUM, 1 session) — GDPR Art. 30, CIS 8.3

- [/] **S.10.1** — Admin audit-view UI design 2026-05-16: 3-tab spec (Meghívási history + Member-events + ACL-backfill audit). Implementation Phase 3 (S.10.5 actionAuditLog prerekvizit). [[Komponensek/AuditTrail]].
- [x] **S.10.2** — `organizationInviteHistory` retention 2026-05-16: default forever, admin-deletable, `user-cascade-delete` GDPR Art. 17 cascade. Dokumentum elég. [[Komponensek/AuditTrail]].
- [/] **S.10.3** — GDPR-export USER-TASK: legal review szükséges (Art. 20 proaktív vs on-request) + dev-Q (implement-now vs első-request). [[Komponensek/AuditTrail]] S.10.3.
- [x] **S.10.4** — AttemptIdTracking dokumentáció 2026-05-16: új jegyzet [[Komponensek/AttemptIdTracking]] (ADR 0011 follow-up, use-cases + future Phase 4 audit-log integráció).
- [/] **S.10.5** — Központi `actionAuditLog` collection Phase 4 defer: schema-spec dokumentálva (`AuditTrail.md`), perf-impact ~5-10%/CF-write, storage ~200MB/év.
- [x] **S.10.6** — Stop-time Codex záró 2026-05-16. Új jegyzet: [[Komponensek/AuditTrail]] + [[Komponensek/AttemptIdTracking]].

#### S.11 DNS / SSL / DR baseline (LOW, 1 session) — CIS 11

- [/] **S.11.1** — DNS CAA record USER-TASK (`emago.hu CAA 0 issue "letsencrypt.org"`). Registrar action — runbook bővítve.
- [/] **S.11.2** — DNSSEC USER-TASK (registrar-függő, Magyar Telekom / NIC.hu).
- [x] **S.11.3** — Appwrite Cloud backup policy 2026-05-16: új jegyzet [[Komponensek/DRPlan]] (Free vs Pro/Scale tier összehasonlítás, recommendation: Pro tier upgrade ~$15/projekt/hó).
- [x] **S.11.4** — Failover dokumentáció: ADR 0001 verify-test runbook a [[Komponensek/DRPlan]]-ban (~25 sec recovery worst-case).
- [x] **S.11.5** — Recovery-runbook 2026-05-16: új jegyzet [[Komponensek/RecoveryRunbook]] — 5 incident-flow (key-rotation, secret-leak, DB restore, last-owner-orphan, UXP runtime-failure).
- [x] **S.11.6** — Stop-time záró 2026-05-16. S.11 design-only Phase 3 USER-TASK trigger (DNS registrar + Pro tier).

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
