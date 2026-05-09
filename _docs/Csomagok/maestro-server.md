---
tags: [csomag, server, cloud-functions]
aliases: [Server, Cloud Functions]
---

# maestro-server

## Cél
Appwrite Cloud Functions backend: minden szerver-oldali művelet (tenant bootstrap, ACL kezelés, meghívó-elfogadás, csoporttagság-mutáció).

## Részletek
[[packages/maestro-server/CLAUDE]] — teljes architektúra.

## Főbb action-ök
- **bootstrap_organization** — új org létrehozásakor a 3 default permission set seedelése (`owner_base`, `admin_base`, `member_base`); a workflow-csoportok autoseed-elnek aktiváláskor (NEM bootstrap-ban) — [[Döntések/0002-fazis2-dynamic-groups]] + [[Döntések/0008-permission-system-and-workflow-driven-groups]]
- **invite-to-organization** — meghívó küldése, per-tenant Team létrehozása + doc-szintű ACL + admin-team `org_${orgId}_admins` (Q1 ACL refactor 2026-05-09) — [[Döntések/0003-tenant-team-acl]] + [[Döntések/0010-meghivasi-flow-redesign]] + [[Döntések/0011-cas-gate-and-orphan-guard-invariants]]
- **activate_publication** + **assign_workflow_to_publication** — workflow hozzárendelés + `requiredGroupSlugs` autoseed + `compiledExtensionSnapshot`
- **backfill_tenant_acl / backfill_admin_team_acl** — meglévő doc-okra ACL utólagos kitöltése (idempotens, dryRun, reconcile)
- **orphan-sweeper** (külön CF) — 1h grace window-os user-cleanup cron, `0 3 * * *`, `MAX_USER_CHECKS_PER_RUN=500`

## Modul-térkép (`invite-to-organization`)

A 2026-05-04 B.0.3 inkrementális split nyomán a `main.js` 6964 → 560 sorra szűkült. 8 `actions/*.js` modul + dispatch table:

| Modul | Action-ök |
|---|---|
| `actions/orgs.js` | bootstrap_organization, create/update/delete_organization, transfer_orphaned_org_ownership, change_organization_member_role |
| `actions/invites.js` | createInvite, createBatchInvites, acceptInvite, declineInvite, listMyInvites, sendInviteEmail |
| `actions/groups.js` | add/remove_group_member, create/update_group_metadata, archive/restore/delete_group |
| `actions/permissionSets.js` | create/update/archive/restore_permission_set, assign/unassign_permission_set_to_group |
| `actions/workflows.js` | create/update/update_metadata/archive/restore/delete/duplicate_workflow |
| `actions/offices.js` | create/update/delete_editorial_office, leave_organization |
| `actions/publications.js` | create_publication_with_workflow, assign_workflow_to_publication, activate_publication |
| `actions/schemas.js` | bootstrap_*_schema (5+) + backfill_tenant_acl + backfill_admin_team_acl + backfill_organization_status + backfill_membership_user_names |
| `actions/extensions.js` | create/update/archive_workflow_extension |

**Tilos import-irány**: `main.js` → `actions/*` → `helpers/*` → `permissions.js` / `teamHelpers.js`. Visszafelé NEM (CommonJS ciklikus require fél-inicializált exportot ad).

**Single-source build-step-ek** (drift-ellenes, ESM → CJS post-transform token-guarddal):
- `scripts/build-cf-validator.mjs` → `_generated_compiledValidator.js`
- `scripts/build-cf-orphan-guard.mjs` → `_generated_orphanGuard.js` (2 CF-en)

**CAS-gate + orphan-guard invariánsok**: [[Döntések/0011-cas-gate-and-orphan-guard-invariants]] — a `_archiveInvite()` `attemptId` correlation, `_assertCasGateConfigured()` action-eleji guard, deny-state-only orphan cache.

## Új CF létrehozása

Sablon: [[Komponensek/CFTemplate]] (endpoint-default `cloud.appwrite.io`, NEM `fra.cloud.appwrite.io`).

## Kapcsolódás a többihez
- **Plugin (InDesign)**: csak action-trigger.
- **Dashboard**: action-trigger UI-ról (settings → groups → meghívó / tag mutáció).
- **Adatbázis**: Appwrite Database collection-ök (organizations, editorialOffices, groups, groupMemberships, invites, stb.) — Tenant Team ACL [[Döntések/0003-tenant-team-acl]].

## Build / futtatás
- A funkciók `appwrite.json`-ban deklarálva, deploy az `appwrite functions deploy` paranccsal.
- Részletek a package CLAUDE.md-ben.
