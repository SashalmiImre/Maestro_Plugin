---
tags: [komponens, recovery, runbook, incident-response]
related:
  - "[[Komponensek/DRPlan]]"
  - "[[Tervek/user-task-runbook]]"
---

# RecoveryRunbook — Incident-response runbookok (S.11.5)

## 1. Key-rotation incident

**Scenario**: leaked Appwrite API key (Console-on revoked, history-ban NEM).

### Steps

1. **Detektálás**: GitHub Secret Scanning alert vagy manual git-history audit
2. **Revoke**: Appwrite Console > API Keys > Delete the leaked key (5 perc kritikus)
3. **Generate new key**: Console > Create > same scopes + 1 év expire
4. **Update env-vars** (14 CF + Railway proxy):
   - MCP `functions_update_variable` minden CF-en (vagy Console manual)
   - Railway dashboard > Variables tab → save → redeploy
5. **Smoke test**: 1× CF execution, 1× proxy ping
6. **History-rewrite** (S.5 Phase 2): `git filter-repo --replace-text` a leaked key → push --force + contributor-notify

**Total**: ~30 perc + 5 perc smoke = 35 perc.

**Precedent**: 2026-05-15 `8d5f`-key leaked init-commit-ban, revoked + history-rewrite halasztott.

## 2. Secret-leak incident

**Scenario**: `.env.production` vagy `RESEND_API_KEY` git-commit-ba kerül.

### Steps

1. **Backup**: `git clone --mirror <repo> /tmp/backup-$(date +%Y%m%d).git`
2. **Identify**: `git log --all --full-history -- <leaked-file-path>`
3. **Revoke** a leaked secret (Console / Resend / etc.)
4. **Filter**: `git filter-repo --replace-text /tmp/replacements.txt --force` (vagy `--path-glob` ha file-szintű törlés)
5. **Force-push**: `git push --force --all && git push --force --tags`
6. **Notify**: minden contributor `git fetch + reset --hard origin/main` vagy újra-klónozás
7. **GitHub fork-cleanup**: ha publikus fork van, kontakt GitHub Support az index-purge-höz

**Total**: ~30 perc + variable contributor-notify.

## 3. DB restore (Appwrite Cloud)

**Scenario**: production DB corruption / accidental mass-delete.

### Prerequisite

- Appwrite **Pro tier** (auto-backup) vagy
- Manual backup script (Free tier)

### Steps (Pro tier)

1. Appwrite Console > Database > Backups → identify last-good snapshot (24 órás granularitás)
2. **Restore confirmation**: a current state-et felülírja
3. Smoke test: 1× listDocuments minden critical collection-en
4. **Lock** Plugin / Dashboard a restore alatt (maintenance-mode banner)

**Total**: ~30-60 perc.

### Steps (Free tier — manual)

1. Locate last-known-good JSON-backup (`backup-<date>-*.json`)
2. **Replay**: script-tel `createDocument` per-row, idempotens (`$id`-szel)
3. Veszteség: az utolsó backup óta elveszett írás (RPO = backup-cycle)

**Total**: 2-6 óra (datasize-függő).

## 4. Last-owner-orphan recovery

**Scenario**: az utolsó-owner user törlődik (user-cascade-delete CF), és az org `orphaned` state-be kerül (S.7.x phantom-org window).

### Steps

1. Admin (vagy Appwrite Console-on a project-admin) hívja a `transfer_orphaned_org_ownership` CF action-t
2. Payload: `{ orgId, newOwnerId }` (kiválasztott user, aki tagja az orgnak)
3. CF: status `'orphaned'` → `'active'`, role update `admin` → `owner`
4. Smoke test: az új-owner Dashboard-on logged-in állapotban admin-szintű flow-t lát

**Total**: ~5 perc.

### Hidden risk

A `'orphaned'` status-on `bootstrap_organization` re-create blokkolt (S.7.8 `_finalizeOrgIfProvisioning` guard). Ha az új-owner másik orgot akar bootstrappolni, az NEM-érinti.

## 5. UXP plugin runtime-failure

**Scenario**: a Plugin (`maestro-indesign`) az UXP runtime-on `localFileSystem` permission-error miatt nem-load-el (S.6.2 fix után).

### Steps

1. UXP Developer Tool > Errors tab — error-message?
2. Manifest-revert (`localFileSystem: "fullAccess"`) test — load-e?
3. Ha load: a `request` minta a UXP-version-incompatibility. Manual fix: revert + `S.6.2-incompat` flag a SecurityRiskRegister-be.
4. Ha NEM-load: másik error, deeper investigation.

**Total**: ~10 perc.

## Post-incident

Minden incident-flow után **napló entry** `_docs/Naplók/YYYY-MM-DD.md`:
- Mit történt (root cause)
- Mit csináltam (steps)
- Mit tanultam (lessons-learned)
- Risk register update (`R.S.X.Y` Closed/Mitigated/Open)

## Kapcsolódó

- [[Feladatok#S.11]]
- [[Komponensek/DRPlan]] (RTO/RPO)
- [[Tervek/user-task-runbook]] (key-rotation USER-TASK 7+11+12 precedens)
- [[Tervek/user-task-runbook]] (USER-TASK-ok)
