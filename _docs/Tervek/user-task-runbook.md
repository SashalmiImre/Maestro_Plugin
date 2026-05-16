---
tags: [terv, user-task, runbook, security, console, rotation]
status: Active
created: 2026-05-15
updated: 2026-05-16
---

# USER-TASK runbook — S blokk audit jelen-elvégzendő feladatok

> Az S blokk security audit kódoldali része + automatizálható deploy ✅ **ÉLŐ** (Iter 34, PR #3 merged `7585d871` 2026-05-16). Ez a runbook a **maradék manuális USER-TASK-okat** tartalmazza, amiket a Claude /loop NEM tudott végrehajtani (Console UI, secret-rotation, registrar action, legal review, InDesign UXP).
>
> A már lezárt deploy + schema-create taszkokat lásd: [[Naplók/2026-05-16]] (Iter 25-34).

## 📍 Production state (2026-05-16 PM lezárva)

| Komponens | State |
|---|---|
| Dashboard `maestro.emago.hu` | ✅ ÉLŐ (PR #3 merge `7585d871`, S.3 headers + S.4 + S.12.4 + S.3.1 önhost Inter) |
| 15 Appwrite CF | ✅ DEPLOYED (12 MCP 05-15 + invite-to-org redeploy 05-16 + 2 új Phase 3 CF) |
| `actionAuditLog` collection | ✅ CREATED (11 column + 3 index, Phase 4 admin audit-view ready) |
| `main` branch protection | ✅ AKTÍV (`CF main.js syntax-check` required + strict + no force-push + no deletion) |

---

## 🔥 Most-elvégzendő (~40 perc)

### USER-TASK 18 — Plugin UXP rebuild + reload InDesign-on

**Cél**: a már built `packages/maestro-indesign/dist/` betöltése Adobe InDesign-be.

**Lépések**:

1. Build (re-run, ha kell):
   ```bash
   cd packages/maestro-indesign && yarn build
   ```
2. Adobe Creative Cloud → UXP Developer Tool (UDT) → indít → **Load Plugin...** → `packages/maestro-indesign/dist/`
3. **InDesign teljes restart** (S.6 manifest network whitelist + scheme-qualified `https://`+`wss://` + localFileSystem `"request"` változott)
4. InDesign relaunch → File → Open... → tetszőleges dokumentum → Plugins menu → Maestro → Open
5. **Verify**:
   - Login form megjelenik
   - Sikeres login → szerkesztőség-list + cikk-list
   - Realtime channel subscribe (Plugin DevTools console-on figyelhető)

**Time**: ~10 perc.

**Adobe Exchange (production distribution, OPTIONAL post-internal-test)**: ExMan package (`.ccx`) → Exchange Portal submit (review + approval ~24-48 óra).

---

### USER-TASK 3 — S.7.5 Adversarial 2-tab cross-tenant teszt

**Cél**: empirikusan verifikálni hogy a tenant-isolation (ADR 0003 + 0014) WORKS — a 3 új finding fix (S.12.4 cookieFallback + S.3.1 önhost) UTÁN.

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

**Time**: ~30 perc.

---

## ⚡ Console settings (~30 perc)

### USER-TASK 1 — S.12.1 Appwrite Console password policy

**URL**: `https://cloud.appwrite.io/console/project-<PROJECT_ID>/auth/security`

**Beállítások**:
- ☑ **Password history**: minimum 5 — megakadályozza a legutóbbi 5 jelszó újra-használatát
- ☑ **Password dictionary**: enabled — közismert jelszavak (top-10k) tiltása
- ☑ **Personal data check**: enabled — email/név alapú jelszavak tiltása
- ☑ **Minimum length**: 12 char (vagy 14)
- ☑ **Mock numbers blocked**: enabled (ha létezik)

**Verifikáció**:

1. Test-account-tal próbálj `password123`-at beállítani → blokkolva
2. Próbálj saját email-helyett változatot (`saját@email.hu`-ból `sajat123`) → blokkolva
3. Password history: állíts 6× egymás után különböző jelszavakat, a 7.-ben ismételd az 1.-t → blokkolva

**Commit a vault-ba**: `_docs/Komponensek/AuthSessionAccess.md` "S.12.1 Password Policy Closed (2026-05-XX, screenshot link)".

**Time**: ~10 perc.

---

### USER-TASK 2 — S.12.2 Appwrite Console admin MFA enforcement

**URL**: `https://cloud.appwrite.io/console/project-<PROJECT_ID>/auth/security` (MFA szekció)

**Beállítások**:
- ☑ **MFA**: enabled
- ☑ **TOTP**: enabled (Google Authenticator-szerű)
- ☐ Email MFA: opcionális

**Admin-specific enforcement** (DESIGN-Q):

Az `org.admin` permission slug-os user-eknek MFA-t **kötelezővé tenni** a UI-flow-n: egy új feature flag a Dashboard `AuthContext.jsx`-ben, ha `user.labels.includes('org_admin_<orgId>')` és `!user.mfaEnabled` → redirect `/settings/mfa-setup`.

→ **S.12.2b külön iter** (code-change, NEM csak Console-állítás). Most CSAK a Console MFA-enabled most kell.

**Verifikáció**:

1. Admin-user belép → MFA challenge
2. Member-user belép → MFA challenge HA setup, NEM kötelező (Phase 2-ben kötelező)

**Commit a vault-ba**: `AuthSessionAccess.md` "S.12.2 MFA enabled at Console (2026-05-XX), admin-enforcement code: S.12.2b külön iter".

**Time**: ~10 perc.

---

## 🔐 Secret hygiene (~1-2 óra)

### USER-TASK 7 — `.env.production` audit (elsőként — feltárhat leaked key-t)

**Cél**: verify hogy CSAK `VITE_*` prefix-es (frontend public) változók vannak benne.

**Lépések**:

1. `cat packages/maestro-dashboard/.env.production` (helyileg, NEM commit-ban — `.gitignore` jegyzi)
2. Audit minden env-var-t:
   - ✅ `VITE_APPWRITE_ENDPOINT`
   - ✅ `VITE_APPWRITE_PROJECT_ID`
   - ✅ `VITE_DASHBOARD_URL`
   - ❌ **Bármi NEM `VITE_` prefix-szel → server-side secret leaked → SECURITY INCIDENT → USER-TASK 8 trigger**
3. Commit `SecretsRotation.md` "S.5.2 .env.production audit PASS 2026-05-XX, csak VITE_* prefix".

**Time**: ~10 perc.

---

### USER-TASK 4 — Appwrite API key rotation

**Trigger**: S.5 audit (2026-05-15) felfedezte hogy a `7474619` init-commit-ban leaked production API key (`...8d5f` last-4). User manuálisan revoked Console-on. **Phase 2 history-rewrite halasztott (USER-TASK 8)**.

**Lépések**:

1. **Új API key kreálás** (Appwrite Console > API keys > Create):
   - Név: `production-2026-05-XX`
   - Scopes: ugyanazok mint a régi (databases.read, databases.write, users.read, users.write, teams.*, functions.read, functions.write)
   - Expire: NEM (vagy 1 év, ha policy)
   - **Másold a key-t — egyszer látható!**

2. **Frissítés a CF env-ben** (15 CF-en `APPWRITE_API_KEY`):
   - `invite-to-organization`, `update-article`, `validate-publication-update`, `user-cascade-delete`, `validate-article-creation`, `article-update-guard`, `cascade-delete`, `cleanup-archived-workflows`, `cleanup-orphaned-locks`, `cleanup-orphaned-thumbnails`, `cleanup-rate-limits`, `migrate-legacy-paths`, `orphan-sweeper`, `resend-webhook`, `set-publication-root-path`
   - **VAGY**: a CF runtime auto-inject-eli a `x-appwrite-key` header-t → env-fallback backward-compat, NEM kritikus update.

3. **Frissítés a proxy env-ben** (Railway dashboard > Maestro proxy > Variables → `APPWRITE_API_KEY`).

4. **Revoke a régi key-t** (csak ha biztos vagy minden frissült):
   - Appwrite Console > API keys > régi key (utolsó-4 `8d5f`) > Delete
   - **5 perc várakozás** + smoke teszt (login, invite-create, publication-create)

5. **Commit a vault-ba**: `SecretsRotation.md` új entry.

**Time**: ~30 perc + 5 perc smoke.

---

### USER-TASK 5 — Resend rotation (S.5.4)

**Lépések**:

1. **Új Resend API key** (Resend dashboard > API keys → name `production-2026-05-XX`, másold)
2. **Új Resend Webhook secret** (Resend dashboard > Webhooks > Edit > Generate new secret)
3. **Frissítés Appwrite CF env-ben**:
   - `invite-to-organization` CF: `RESEND_API_KEY` új értékre
   - `resend-webhook` CF: `RESEND_WEBHOOK_SECRET` új értékre
4. **Verify**: Send test invite → kapsz emailt. Resend dashboard > Webhooks > Test event → CF execution log: HMAC PASS.
5. **Revoke régi key + secret** Resend dashboard-on.
6. **Commit**: `SecretsRotation.md` entry.

**Time**: ~20 perc.

---

### USER-TASK 6 — GROQ + Anthropic key audit (S.5.5)

**Cél**: ellenőrizni hogy a `maestro-proxy` package használ-e production-adatot a Groq/Anthropic SDK-kon. Ha NEM → S.14 conditional defer marad. Ha IGEN → S.14 reaktiválódik.

**Lépések**:

1. `grep -rn "groq\|anthropic" packages/maestro-proxy/src/`
2. Mit kérdezel le? Production user-data? Vagy csak fejlesztői segéd?
3. **Ha production-data**: S.14 reaktiváció (data flow doc + prompt injection mitigációk + retention policy + provider key isolation).
4. **Ha NEM production-data**: confirm S.14 marad-condition-defer. Commit Note.

**Time**: ~30 perc audit + variable.

---

### USER-TASK 8 — Git filter-repo history-rewrite (CSAK ha leaked-key found a USER-TASK 7-ben)

**Kritikus**: a `7474619` init-commit (2026-02-22) tartalmazza a leaked Appwrite API key-t a `packages/maestro-indesign/appwrite_functions/delete-article-messages/environments.env`-ben (last-4 `8d5f`). A key Console-on revoked, **DE a git history-ban még benne van**. Bárki, aki klónozza a repót, megkapja a (revoked) key-t.

**Lépések**:

1. **Backup**: `git clone --mirror <repo-url> /tmp/maestro-backup-$(date +%Y%m%d).git`

2. **`git filter-repo` install** (ha nincs):
   ```bash
   brew install git-filter-repo
   ```

3. **Filter** — replace the API key string mindenhol:
   ```bash
   echo 'standard_b823bd9fea2e7c3abef6ec240afc9e83d2e3c5ca2da949b0484c0779f9826327bfc2ba2de17efa34d962777215bcdbe11cd6ad77308e3ac188bbf82f12e9d5b7b887a53fddf15e5348a762972087c194f770a32d30385b7294ce73228fe32a873b8d026dcbc83232bb505a03293eca79caeb39a0a20f1b618ab77e62a26a8d5f==>***REDACTED_KEY_8d5f***' > /tmp/replacements.txt
   git filter-repo --replace-text /tmp/replacements.txt --force
   ```

4. **Verify**:
   ```bash
   git log --all -p | grep -c "8d5f"  # 0 lehet csak
   git log --all --oneline | wc -l    # commit count változatlan
   ```

5. **Force-push** (figyelem: branch protection `allow_force_pushes: false` — temporary disable + re-enable kell):
   ```bash
   gh api repos/SashalmiImre/Maestro_Plugin/branches/main/protection -X PUT --input - <<EOF
   {"required_status_checks":null,"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":true,"allow_deletions":false}
   EOF
   git push --force --all origin
   git push --force --tags origin
   # re-enable a rule-t:
   # ... (eredeti PUT body)
   ```

6. **Notify**: minden contributor klónozza újra (`git fetch + reset --hard`).

7. **Commit a vault-ba**: `SecretsRotation.md` "S.5 Phase 2 history-rewrite kész 2026-05-XX, force-pushed, contributor-notify done".

**FIGYELEM**:
- A force-push **TÖRI** minden meglévő clone-t
- A GitHub cache-eli a régi blob-okat ~14 napig
- Fork-okban megmarad → GitHub admin manuálisan kérheti

**Time**: ~30 perc + verify.

---

## 🌐 DNS hardening (~10 perc registrar-on)

### USER-TASK 10 — DNS CAA record (S.11.1)

**Cél**: megakadályozni, hogy bármely más CA SSL cert-et issue-eljen az `emago.hu`-ra.

**Lépések**:

1. Registrar DNS panel (Magyar Telekom Domain / NIC.hu)
2. CAA record add:
   ```
   emago.hu. 86400 CAA 0 issue "letsencrypt.org"
   ```
3. Verify: `dig CAA emago.hu @8.8.8.8` (5-10 perc propagáció)

**Plus**: subdomain-szintű CAA-k (pl. `maestro.emago.hu`, `api.maestro.emago.hu`) — opcionális, inheritance default.

**Time**: ~10 perc + propagáció.

---

### USER-TASK 11 — DNSSEC enable (S.11.2)

**Registrar-függő**: Magyar Telekom Domain (vagy NIC.hu) DNSSEC support — verify.

**Ha support**:

1. Domain Tools > DNSSEC > Enable
2. Registrar publishes DS record a parent zone-ban
3. Verify: `dig +dnssec emago.hu @8.8.8.8` — `AD` flag a response-ban

**Ha NEM-support**: skip + flag (low-priority, NEM-blocker).

**Time**: ~15 perc.

---

## 💾 Plan upgrade (USER-DECISION, üzleti)

### USER-TASK 12 — Appwrite Cloud Pro tier (~$15/projekt/hó)

**Indok**:
- S.11.3: auto-backup + 7-napi retention (Free tier: manual backup only)
- S.13.5: CIS 8.3 minimum 90 nap audit-log retention (Free tier: 30 nap)

**Decision**: production-readiness vs cost. ~$15/hó Maestro production-projektre acceptable.

---

### USER-TASK 13 — Better Stack paid plan (S.13.1+13.5, ~$10-25/hó)

**Indok**: central log aggregation + alert-pattern matching + 30+ nap retention. Phase 3 trigger: első incident-trigger.

---

## ⚖️ Legal review (variable)

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

## ✅ Sorrend ajánlás

1. **Most-azonnal** (~40p): USER-TASK 18 (Plugin reload) → USER-TASK 3 (adversarial 2-tab)
2. **Console** (~30p): USER-TASK 1 (password policy) → USER-TASK 2 (MFA)
3. **Secret** (~1-2h): USER-TASK 7 (env audit elsőként!) → USER-TASK 4+5+6 (párhuzamos) → USER-TASK 8 (csak ha 7 leaked-keyt talál)
4. **DNS** (~30p): USER-TASK 10 (CAA) → USER-TASK 11 (DNSSEC, ha registrar support)
5. **Plan** (üzleti): USER-TASK 12 + 13 (decision)
6. **Legal** (variable): USER-TASK 9 (GDPR-export)

---

## 📋 Kapcsolódó

- [[Feladatok#S.12]], [[Feladatok#S.5]], [[Feladatok#S.7]], [[Feladatok#S.10]], [[Feladatok#S.11]]
- [[Komponensek/SecurityRiskRegister]] R.S.12.1, R.S.12.2, R.S.7.5, R.S.5.x
- [[Komponensek/TenantIsolation]] (S.7.5 adversarial-eredmény dokumentálás)
- [[Komponensek/AuditTrail]] (S.10.5 actionAuditLog schema)
- [[Naplók/2026-05-16]] — Iter 25-34 history (deploy + MCP + finding-fix)
- [[Naplók/2026-05-15]] — Iter 1-24 history
