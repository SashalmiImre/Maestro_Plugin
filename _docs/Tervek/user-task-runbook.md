---
tags: [terv, user-task, runbook, security, console, rotation]
status: Active
created: 2026-05-15
---

# USER-TASK runbook — S blokk biztonsági audit user-akciói

> Az autonóm /loop NEM tudja végrehajtani ezeket — Console-akciók, secret-rotation, manual test, legal review. Te a háttérben végzed őket.

## ⚠️ KRITIKUS PRE-REQUIREMENT — Deploy

A teljes S blokk audit-munka (2026-05-15, 17 /loop iter) **KÓDOLDALON KÉSZ**, **NEM-DEPLOYOLVA MÉG**. A USER-TASK-ok többsége (különösen az adversarial-test) HAMIS eredményt adna a production deploy nélkül.

### Deploy sorrend (kötelező USER-TASK-ok ELŐTT)

#### A) 15 Appwrite CF deploy

A `claude/zealous-euler-00c483` branch összes CF-változtatása **NEM-deployolt**:
- **S.7.x ACL fixes**: `invite-to-organization` (Phase 1.0+1.5 fail() strip + 14 leak fix), `backfill_acl_phase3`, `verify_collection_document_security`, `anonymize_user_acl`
- **S.7.8 phantom-org window**: `bootstrap_organization` flow + `status: 'provisioning'` enum
- **S.13.2 PII-redaction wrap**: 14 CF (`invite-to-organization` inline + 13 CF `_generated_piiRedaction.js` + `wrapLogger`)
- **S.13.3 info-disclosure fix**: 14 CF `fail()` strip + executionId

**Deploy módszer**:

**B-opció: Appwrite Console manuális** (egyszerű, lassú):
1. Console > Functions > `<function-name>` > Deployments > Create deployment
2. **Source**: Git repository — minden CF saját Deployment
3. Beállítások:
   - Source code: `packages/maestro-server/functions/<function-name>` (path-on belül `src/main.js`)
   - Branch: `claude/zealous-euler-00c483` (vagy merged `main` ha mar mergeled)
   - Entry point: `src/main.js`
4. Wait ~30-60 sec per CF
5. Ismételd mind 15 CF-en (invite-to-organization, update-article, validate-publication-update, user-cascade-delete, validate-article-creation, article-update-guard, cascade-delete, cleanup-archived-workflows, cleanup-orphaned-locks, cleanup-orphaned-thumbnails, cleanup-rate-limits, migrate-legacy-paths, orphan-sweeper, resend-webhook, set-publication-root-path)

**A-opció: Appwrite CLI** (gyorsabb, ha be van konfigurálva):
```bash
cd packages/maestro-server
for fn in functions/*/; do
    fnName=$(basename "$fn")
    echo "Deploying $fnName..."
    appwrite deploy function --functionId "$fnName" --code "./functions/$fnName" --activate
done
```

**Verify**:
- Console > Functions > minden CF > "Latest deployment" → `<friss-timestamp>` és "Active"
- Smoke test: login, invite-create, publication-create
- Console > Functions > `invite-to-organization` > Executions: új request → success: true

**Time**: 15-30 perc (Console manuális) vagy ~5 perc (CLI batch).

---

#### B) Dashboard deploy

`packages/maestro-dashboard` változások (NEM-deployolt):
- **S.3 security headers** (`.htaccess`): HSTS, X-Frame-Options, CSP report-only, Permissions-Policy
- **S.4 ImportDialog validation**: file size + MIME pre-check
- **S.12.4 localStorage cleanup**: `clearMaestroLocalStorage` helper + 3 wire-pont (`logout`, `login`, JWT auto-login)
- **S.13.2 PII-redaction**: dashboard CSAK skip-elve (CLAUDE.md `console.*` policy-elfogadott), DE a `.htaccess`-en új headers vannak.

**Deploy módszer** (LiteSpeed/Apache shared hosting — NEM Next.js):

```bash
cd packages/maestro-dashboard
yarn build
# A dist/ mappa tartalmát fel kell tölteni a shared hosting-ra
# (LiteSpeed/Apache, NEM Vercel/Netlify)
```

**FTP/SFTP upload** (ha ez a hosting-flow):
- Source: `packages/maestro-dashboard/dist/*` (build output)
- Destination: shared hosting `/var/www/maestro.emago.hu/htdocs/` (vagy hasonló path)
- **KÖTELEZŐ**: `.htaccess` fájl is upload-eljen (a `public/.htaccess`-ből bekerül a `dist/`-be)

**Verify**:
1. `curl -I https://maestro.emago.hu/` — response headers:
   - `Strict-Transport-Security: max-age=31536000`
   - `X-Frame-Options: DENY`
   - `Content-Security-Policy-Report-Only: ...`
   - `Permissions-Policy: ...`
2. Login flow: `localStorage.maestro.activeEditorialOfficeId` NEM-szivárog logout után (DevTools Application > Local Storage)

**Time**: ~10-15 perc.

---

#### C) Plugin rebuild + UXP deploy

`packages/maestro-indesign` változások (NEM-deployolt):
- **S.13.2 logger wrap**: `core/utils/logger.js` redactArgs + lazy callConsole

**Build**:
```bash
cd packages/maestro-indesign
yarn build
# Plugin distribution: dist/ vagy a UXP-konfig szerint
```

**UXP deploy módszer**:

**1. Fejlesztői env (UXP Developer Tool)**:
- UDT > "Load Plugin..." → `packages/maestro-indesign/dist/`
- InDesign restart vagy plugin reload
- Test login + Realtime + article-edit

**2. Adobe Exchange (production distribution)**:
- ExMan package (`.ccx` fájl) csomagolás
- Adobe Exchange > Submit New Version
- Review + approval ~24-48 óra
- User-side update: Adobe ExMan auto-update

**3. Belső team distribution** (ha ExMan-en kívüli):
- `.ccx` fájl megosztása (`mediaserver` vagy Slack)
- Manual install minden client-en

**Time**: ~10 perc build + variable distribution.

---

#### D) Proxy redeploy (Railway)

`packages/maestro-proxy` változások (ha vannak — most NEM kritikus, csak audit):
- **S.5 audit**: secret keys frissítése (NEM kódváltozás, csak env-update — Railway dashboard)

**Deploy módszer**:
- Railway dashboard > Maestro proxy > Deployments > Trigger deploy (vagy auto-deploy-on-push)
- Env-update: Variables tab > frissítés > Redeploy

**Time**: ~5 perc.

---

### Deploy CHECKLIST

- [ ] **A**: 15 Appwrite CF deploy (Console vagy CLI) — minden új feature production-on
- [ ] **B**: Dashboard deploy (build + upload, `.htaccess` mellékelve)
- [ ] **C**: Plugin rebuild + UXP Developer Tool reload (fejlesztői env) vagy ExMan package (production)
- [ ] **D**: Proxy redeploy (csak env-update most, NEM kódváltozás)
- [ ] **Smoke test**: login, invite-create, publication-create (mind 3 platform)
- [ ] **Codex stop-time deploy review** (külön iter, opcionális — minta: 2026-05-09 commit `5ce596e` után)

**Deploy után**: a USER-TASK-ok (különösen S.7.5 adversarial-test) **valid eredményeket** ad. Anélkül a régi-ACL marad production-on és a test HIBÁS.

---

## Sorrend

Egyszerű → komplex. A first-3 (Console settings) ~30 perc, secret-rotation ~1-2 óra, history-rewrite ~30 perc + verify.

---

## ⚡ Quick wins (15-30 perc)

### USER-TASK 1 — S.12.1 Appwrite Console password policy

**URL**: `https://cloud.appwrite.io/console/project-<PROJECT_ID>/auth/security`

**Beállítások**:
- ☑ **Password history**: minimum 5 — megakadályozza a legutóbbi 5 jelszó újra-használatát
- ☑ **Password dictionary**: enabled — közismert jelszavak (top-10k) tiltása
- ☑ **Personal data check**: enabled — email/név alapú jelszavak tiltása
- ☑ **Minimum length**: 12 char (vagy 14)
- ☐ **Maximum length**: NEM állítja (default OK)
- ☑ **Mock numbers blocked**: enabled (ha létezik)

**Verifikáció**:
1. Test-account-tal próbálj `password123`-at beállítani → blokkolva
2. Próbálj saját email-helyett változatot (`saját@email.hu`-ból `sajat123`) → blokkolva
3. Password history: állíts 6× egymás után különböző jelszavakat, a 7.-ben ismételd az 1.-t → blokkolva

**Commit a vault-ba** (utánam): `_docs/Komponensek/AuthSessionAccess.md` "S.12.1 Password Policy Closed (2026-05-XX, screenshot link)".

---

### USER-TASK 2 — S.12.2 Appwrite Console admin MFA enforcement

**URL**: `https://cloud.appwrite.io/console/project-<PROJECT_ID>/auth/security` (MFA szekció)

**Beállítások**:
- ☑ **MFA**: enabled
- ☑ **TOTP**: enabled (Google Authenticator-szerű)
- ☐ Email MFA: opcionális (csak ha admin user-ek vannak emailen szervezve)

**Admin-specific enforcement**:
- Az `org.admin` permission slug-os user-eknek MFA-t **kötelezővé tenni** a UI-flow-n: egy új feature flag a Dashboard `AuthContext.jsx`-ben, ha `user.labels.includes('org_admin_<orgId>')` és `!user.mfaEnabled` → redirect `/settings/mfa-setup`.
- **DESIGN-Q**: ez code-change, NEM csak Console — később külön iter-ben? (Default: igen, S.12.2b külön iter, csak a Console MFA-enabled most kell.)

**Verifikáció**:
1. Admin-user belép → MFA challenge (egyetlen userrel a Console-on tesztelhető)
2. Member-user belép → MFA challenge HA setup, NEM kötelező

**Commit a vault-ba**: `AuthSessionAccess.md` "S.12.2 MFA enabled at Console (2026-05-XX), admin-enforcement code: S.12.2b külön iter".

---

### USER-TASK 3 — S.7.5 Adversarial 2-tab teszt (dev env)

**Cél**: empirikusan verifikálni hogy a tenant-isolation (ADR 0003 + 0014) WORK.

**Setup**:
1. 2 különböző Maestro account (`alice@example.com` + `bob@example.com`)
2. Alice 2 org-ban tag: `OrgA` (member) + `OrgB` (member). Bob csak `OrgC` (member).
3. 2 browser-tab (vagy 2 incognito window)

**Teszt 1: localStorage swap**:
1. Tab A: Alice login, navigál OrgA-ba. `localStorage.maestro.activeEditorialOfficeId = "<OrgA office id>"`.
2. Tab B: Bob login egy másik incognito-ban. `localStorage.maestro.activeEditorialOfficeId = "<OrgA office id>"` — **Bob NEM tagja OrgA-nak**.
3. Bob refresh. DevTools Network tab: `listDocuments` requests.
4. **VÁRT**: 403 Forbidden minden tenant-collection requestre (`articles`, `publications`, `layouts`, `deadlines`, `userValidations`, `systemValidations`). UI: error state vagy redirect.
5. **HIBÁS**: Bob OrgA adatait látja → BLOCKER, ADR 0003/0014 ACL elszállt.

**Teszt 2: Realtime push**:
1. Tab A: Alice OrgA-ban marad. DevTools Network → WS tab.
2. Tab B (másik browser): admin OrgA-ban új article-t hoz létre.
3. Tab A WS frame: új article kerül a Realtime push-ba — ez OK (Alice tagja).
4. Tab B: Bob (NEM tagja OrgA-nak) WS frame-jén → **NEM kerül** az új article. **VÁRT**.

**Teszt 3: REST listDocuments cross-tenant**:
1. Bob session-token-jével (`localStorage.cookieFallback` vagy Authorization header).
2. curl/Postman: `GET /databases/<dbId>/collections/articles/documents?queries[]=equal("organizationId","<OrgA_id>")` Bob token-jével.
3. **VÁRT**: 403 Forbidden vagy üres dokumentum-lista.

**Eredmény**: ha 3/3 PASS, S.7.5 + S.7.6 closing → commit `_docs/Komponensek/TenantIsolation.md` "S.7.5 verified 2026-05-XX (3-tab adversarial test PASS)".

**Hibás**: dokumentáld a hibát + nyiss issue-t `R.S.7.5-failure` címkével a risk-register-ben.

---

## 🔐 Secret rotation (S.5.2-5.5 + 5.7, ~1-2 óra)

### USER-TASK 4 — Appwrite API key rotation

**Trigger**: S.5 audit (2026-05-15) felfedezte hogy a `7474619` init-commit-ban leaked production API key (`...8d5f` last-4). User manuálisan revoked Console-on. **Phase 2 history-rewrite halasztott**.

**Lépések**:

1. **Új API key kreálás** (Appwrite Console > API keys > Create):
   - Név: `production-2026-05-15`
   - Scopes: ugyanazok mint a régi (databases.read, databases.write, users.read, users.write, teams.*, functions.read, functions.write)
   - Expire: NEM (vagy 1 év, ha policy)
   - **Másold a key-t — egyszer látható!**

2. **Frissítés a CF env-ben**:
   - Appwrite Console > Function: minden CF-en `APPWRITE_API_KEY` env var új értékre.
   - 15 CF: `invite-to-organization`, `update-article`, `validate-publication-update`, `user-cascade-delete`, `validate-article-creation`, `article-update-guard`, `cascade-delete`, `cleanup-archived-workflows`, `cleanup-orphaned-locks`, `cleanup-orphaned-thumbnails`, `cleanup-rate-limits`, `migrate-legacy-paths`, `orphan-sweeper`, `resend-webhook`, `set-publication-root-path`
   - **VAGY**: a CF runtime auto-inject-eli a `x-appwrite-key` header-t — akkor csak az `APPWRITE_API_KEY` env-fallback marad backward-compat, NEM kritikus update.

3. **Frissítés a proxy env-ben** (Railway):
   - Railway dashboard > Maestro proxy > Variables
   - `APPWRITE_API_KEY` új értékre

4. **Revoke a régi key-t** (csak akkor, ha biztos vagy hogy minden frissült):
   - Appwrite Console > API keys > régi key (utolsó-4 `8d5f`) > Delete
   - **5 perc várakozás** + smoke teszt (login, invite-create, publication-create)

5. **Commit a vault-ba**:
   - `_docs/Komponensek/SecretsRotation.md` új entry: "2026-05-XX — Appwrite API key rotation: old `...8d5f` revoked, new `...XXXX` deployed to 15 CF + Railway proxy"

**Time**: ~30 perc + 5 perc smoke = 35 perc.

---

### USER-TASK 5 — Resend rotation (S.5.4)

**Lépések**:

1. **Új Resend API key** (Resend dashboard > API keys):
   - Név: `production-2026-05-15`
   - Full-access (or limited if policy)
   - Másold

2. **Új Resend Webhook secret** (Resend dashboard > Webhooks > Edit):
   - Generate new secret
   - Másold

3. **Frissítés Appwrite CF env-ben**:
   - `invite-to-organization` CF: `RESEND_API_KEY` új értékre
   - `resend-webhook` CF: `RESEND_WEBHOOK_SECRET` új értékre

4. **Verify**:
   - Send test invite — kapsz emailt
   - Resend dashboard > Webhooks > Test event → CF execution log: HMAC PASS

5. **Revoke régi key + secret** Resend dashboard-on.

6. **Commit**: `SecretsRotation.md` entry.

**Time**: ~20 perc.

---

### USER-TASK 6 — GROQ + Anthropic key audit (S.5.5)

**Cél**: ellenőrizni hogy a `maestro-proxy` package használ-e production-adatot a Groq/Anthropic SDK-kon. Ha NEM → S.14 conditional defer marad. Ha IGEN → S.14 reaktiválódik.

**Lépések**:

1. **Audit minden Groq/Anthropic API call-t**:
   - `grep -rn "groq\|anthropic" packages/maestro-proxy/src/`
   - Mit kérdezel le? Production user-data? Vagy csak fejlesztői segéd?

2. **Ha production-data**: S.14 reaktiváció:
   - Data flow doc: `_docs/Komponensek/AIDataFlow.md`
   - Prompt injection mitigációk
   - Retention policy (Groq/Anthropic Terms — 30 nap default)
   - Provider key isolation: külön env-key, NEM ugyanaz mint az Appwrite key

3. **Ha NEM production-data**: confirm S.14 marad-condition-defer. Commit Note.

**Time**: ~30 perc audit + variable.

---

### USER-TASK 7 — `.env.production` audit (S.5.2)

**Cél**: verify hogy CSAK `VITE_*` prefix-es (frontend public) változók vannak benne.

**Lépések**:

1. `cat packages/maestro-dashboard/.env.production` (helyileg, NEM commit-ban — `.gitignore` jegyzi)
2. Audit minden env-var-t:
   - ✅ `VITE_APPWRITE_ENDPOINT`
   - ✅ `VITE_APPWRITE_PROJECT_ID`
   - ✅ `VITE_DASHBOARD_URL`
   - ❌ Bármi NEM `VITE_` prefix-szel → server-side secret leaked → SECURITY INCIDENT
3. Commit `SecretsRotation.md` "S.5.2 .env.production audit PASS 2026-05-XX, csak VITE_* prefix".

**Time**: ~10 perc.

---

## 🧹 Git history rewrite (S.5 Phase 2, ~30 perc)

### USER-TASK 8 — Git filter-repo history-rewrite (LEAKED KEY ELTÁVOLÍTÁSA)

**Kritikus**: a `7474619` init-commit (2026-02-22) tartalmazza a leaked Appwrite API key-t a `packages/maestro-indesign/appwrite_functions/delete-article-messages/environments.env`-ben (last-4 `8d5f`). A key Console-on revoked (S.5 audit confirmed), **DE a git history-ban még benne van**. Bárki, aki klónozza a repót, megkapja a (revoked) key-t.

**Lépések**:

1. **Backup**: `git clone --mirror <repo-url> /tmp/maestro-backup-$(date +%Y%m%d).git`

2. **`git filter-repo` install** (ha nincs):
   ```bash
   brew install git-filter-repo
   # vagy: pip install git-filter-repo
   ```

3. **Identify path-to-redact**:
   ```bash
   git log --all --full-history -- packages/maestro-indesign/appwrite_functions/delete-article-messages/environments.env
   ```

4. **Filter**: a SECRET tartalmat redacted-szel cseréljük (NEM teljes path delete, mert a fájl nincs jelen, csak history-ban):
   ```bash
   # Option A: replace the API key string mindenhol
   echo 'standard_b823bd9fea2e7c3abef6ec240afc9e83d2e3c5ca2da949b0484c0779f9826327bfc2ba2de17efa34d962777215bcdbe11cd6ad77308e3ac188bbf82f12e9d5b7b887a53fddf15e5348a762972087c194f770a32d30385b7294ce73228fe32a873b8d026dcbc83232bb505a03293eca79caeb39a0a20f1b618ab77e62a26a8d5f==>***REDACTED_KEY_8d5f***' > /tmp/replacements.txt
   
   git filter-repo --replace-text /tmp/replacements.txt --force
   ```

5. **Verify**:
   ```bash
   git log --all -p | grep -c "8d5f" # 0 lehet csak (a placeholder kommentekben)
   git log --all --oneline | wc -l # commit count változatlan
   ```

6. **Force-push**:
   ```bash
   git push --force --all origin
   git push --force --tags origin
   ```

7. **Notify**: minden contributor klónozza újra:
   ```bash
   cd /old/clone
   git fetch origin
   git reset --hard origin/main
   # vagy újra-klónozás
   ```

8. **Commit a vault-ba**: `SecretsRotation.md` "S.5 Phase 2 history-rewrite kész 2026-05-XX, force-pushed, contributor-notify done".

**FIGYELEM**:
- A force-push **TÖRI** minden meglévő clone-t. Csak akkor csináld, ha bizonyos vagy hogy minden contributor frissíthető.
- A GitHub cache-eli a régi blob-okat ~14 napig. Ha sürgős törlés kell: GitHub Support contact.
- Forks: ha publikus a repo és van fork, a fork-okban megmarad. Egy GitHub admin manuálisan kérheti a fork-tulajdonosokat.

**Time**: ~30 perc + verify.

---

## 🌐 DNS hardening (S.11.1+11.2, ~10 perc registrar-on)

### USER-TASK 10 — DNS CAA record (S.11.1)

**Cél**: megakadályozni, hogy bármely más CA (pl. attacker-controlled) SSL cert-et issue-eljen az `emago.hu`-ra.

**Lépések**:
1. Registrar DNS panel (Magyar Telekom Domain / NIC.hu)
2. CAA record add:
   ```
   emago.hu. 86400 CAA 0 issue "letsencrypt.org"
   ```
3. Verify: `dig CAA emago.hu @8.8.8.8` (5-10 perc propagáció)

**Plus**: subdomain-szintű CAA-k (pl. `maestro.emago.hu`, `api.maestro.emago.hu`) — opcionális, inheritance default.

**Time**: ~10 perc + propagáció.

### USER-TASK 11 — DNSSEC enable (S.11.2)

**Registrar-függő**: Magyar Telekom Domain (vagy NIC.hu) DNSSEC support — verify.

**Ha support**:
1. Domain Tools > DNSSEC > Enable
2. Registrar publishes DS record a parent zone-ban
3. Verify: `dig +dnssec emago.hu @8.8.8.8` — `AD` flag a response-ban

**Ha NEM-support**: skip + flag (low-priority, NEM-blocker).

**Time**: ~15 perc.

## 💾 Plan upgrade (S.11.3 + S.13.5, USER-DECISION)

### USER-TASK 12 — Appwrite Cloud Pro tier (~$15/projekt/hó)

**Indok**:
- S.11.3: auto-backup + 7-napi retention (Free tier: manual backup only)
- S.13.5: CIS 8.3 minimum 90 nap retention (Free tier: 30 nap)

**Decision**: production-readiness vs cost. ~$15/hó Maestro production-projektre acceptable.

### USER-TASK 13 — Better Stack paid plan (S.13.1+13.5, ~$10-25/hó)

**Indok**: central log aggregation + alert-pattern matching + 30+ nap retention.

**Decision**: production-deploy után, első incident-trigger-rel.

## ⚖️ Legal review (S.10.3, ~variable)

### USER-TASK 9 — GDPR-export pre-delete

**Cél**: `delete_my_account` flow előtt a user kapjon egy ZIP-et a saját adataival.

**Lépések**:

1. **Legal-Q**: GDPR Art. 20 (right to data portability) — kell-e prokvasen, vagy on-request elég?
2. **Dev-ready-Q**: implementáljuk azonnal vagy várjunk első request-re?
3. **Ha YES build-now**:
   - Új CF action `export_my_data` az `invite-to-organization`-ban
   - Endpoint: `GET /v1/functions/<id>/executions?action=export_my_data`
   - Response: ZIP-stream URL (Appwrite Storage temporary bucket)
   - Tartalmaz: user-doc, memberships, articles (csak `createdBy: user.$id`-jű), publications (ekv.), invite-history
4. **Frontend**: `/settings/account` page-en új "Adataim letöltése" gomb a delete-account előtt.
5. **Dokumentáció**: új jegyzet `_docs/Komponensek/GDPRExport.md`.

**Time**: variable, ha implement: ~2-3 iter.

---

### USER-TASK 14 — Phase 3 CF Console-create (`cleanup-rate-limits` + `cleanup-orphaned-thumbnails`)

**Cél**: 2 cron-only CF létrehozása Appwrite Console-on (a kódbázis kész, csak a Console-on nincs még a function).

**Indok**: MCP-vel auto-deploy a `Production Deploy / Blind Apply` classifier-en blokkolódik (2026-05-16 PM /loop iter). User-explicit deploy szükséges.

**Lépések (mindkét CF-re)**:

1. **Console UI** → Functions → Create function → "Manual" mode.
2. **`cleanup-rate-limits`** (config a `packages/maestro-server/appwrite.json#180-200` szerint):
   - Function ID: `cleanup-rate-limits`
   - Name: `Cleanup Rate Limits`
   - Runtime: `Node.js 18.0` (vagy 20.0 az S.9.4 USER-TASK migrate után)
   - Entrypoint: `src/main.js`
   - Commands: `npm install`
   - Timeout: 300s
   - Schedule: `0 2 * * *` (daily 02:00 UTC)
   - Scopes: `databases.read`, `databases.write`
   - Spec: `s-0.5vcpu-512mb`
3. **`cleanup-orphaned-thumbnails`** (config `appwrite.json#135-156`):
   - Function ID: `cleanup-orphaned-thumbnails`
   - Name: `Cleanup Orphaned Thumbnails`
   - Runtime: `Node.js 18.0`
   - Entrypoint: `src/main.js`
   - Commands: `npm install`
   - Timeout: 120s
   - Schedule: `0 4 * * 0` (weekly Sunday 04:00 UTC)
   - Scopes: `databases.read`, `files.read`, `files.write`
   - Spec: `s-0.5vcpu-512mb`
4. **Deploy** (egyenként):
   - Tarball: `packages/maestro-server/functions/<cf>` → `tar -czf cf.tar.gz src/ package.json`
   - Console → Function → Deployments → Create deployment → activate
5. **Smoke test**: Console → Function → Run → success status

**Time**: 15-20 perc együtt.

**Verifikálás**: Console execution-log nem mutat `function_not_found` 404-et a cron-trigger-en.

---

### USER-TASK 15 — `actionAuditLog` collection schema MCP-create (S.10.5)

**Cél**: Phase 4 admin audit-view backing collection létrehozása (az `_docs/Komponensek/AuditTrail.md` Phase 4 schema-spec szerint).

**Indok**: MCP-vel auto-create a `Production Deploy / Blind Apply` classifier-en blokkolódik (collection-create = production resource).

**Lépések**:

1. **Console UI** → Databases → `maestro` (vagy actual database) → Create collection.
2. **Collection ID**: `actionAuditLog`
3. **Document security**: `enabled: true` (S.7.7b ADR 0014 invariáns)
4. **Attributes** (AuditTrail.md schema-spec szerint):
   - `actionType` (string, 64) — pl. `accept_invite`, `remove_organization_member`, stb.
   - `userId` (string, 36) — `who`
   - `organizationId` (string, 36) — `where`
   - `targetUserId` (string, 36, optional) — `whom` (admin-kick / role-change esetén)
   - `payload` (string, 2000) — JSON-serialized arguments (PII-redacted)
   - `outcome` (enum: `success`/`fail`/`partial`) — `result`
   - `errorReason` (string, 200, optional) — fail esetén normalized reason
   - `correlationId` (string, 36, optional) — Plugin-CF call traceability
   - `attemptId` (string, 36, optional) — ADR 0011 idempotency
   - `ipAddress` (string, 45, optional) — IPv4 + IPv6
   - `userAgent` (string, 500, optional)
   - `$createdAt` (auto)
5. **Indexes**:
   - `idx_org_time` (`organizationId` ASC, `$createdAt` DESC) — admin audit-view per-org timeline
   - `idx_user_time` (`userId` ASC, `$createdAt` DESC) — user-history view
   - `idx_action_time` (`actionType` ASC, `$createdAt` DESC) — action-frequency stats
6. **Permissions** (collection-level): `read("team:org_*")` — Phase 4 a per-doc ACL pontosítja
7. **Env var** Console → Function variables (a 14 CF-en): `ACTION_AUDIT_LOG_COLLECTION_ID=actionAuditLog`

**Time**: ~30 perc.

**Verifikálás**: Console → Database → Collections lista mutatja az `actionAuditLog`-ot 11 attribute-tal, document_security ON, 3 index.

**Phase 4 trigger**: az admin audit-view UI build (S.10.1) — `_docs/Komponensek/AuditTrail.md` szekció.

---

### USER-TASK 16 — `SDK Compatibility Check` GitHub Actions required check (S.7.7d)

**Cél**: a 2026-05-16-án commitelt `.github/workflows/sdk-compatibility-check.yml` workflow-t required-check-ké tenni a `main` branch-en.

**Lépések**:

1. GitHub repo → Settings → Branches → main → Branch protection rule
2. Required status checks before merging → Add → `SDK Compatibility Check / cf-syntax-check`
3. Save

**Indok**: a workflow most CSAK PR-en fut, de NEM blokkolja a merge-et, ha fail-el. A required-check beállításával a Dependabot major-bump PR-ek csak akkor mergelődnek, ha a kódbázis kompatibilis.

**Time**: 2 perc.

---

## 📋 Kapcsolódó

- [[Feladatok#S.12]], [[Feladatok#S.5]], [[Feladatok#S.7]], [[Feladatok#S.10]]
- [[Komponensek/SecurityRiskRegister]] R.S.12.1, R.S.12.2, R.S.7.5, R.S.5.x
- [[Komponensek/TenantIsolation]] (S.7.5 adversarial-eredmény dokumentálás)
- [[Komponensek/AuditTrail]] (S.10.5 actionAuditLog schema-spec)
