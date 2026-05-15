---
tags: [komponens, dr, backup, restore, appwrite]
related:
  - "[[Komponensek/RecoveryRunbook]]"
  - "[[Döntések/0001-dual-proxy-failover]]"
---

# DRPlan — Disaster Recovery + backup policy (S.11.3+11.4)

## Kontextus

CIS Controls 11 (Data Recovery). A Maestro adatállomány:
- **Appwrite Cloud** databases (organizations, memberships, articles, publications, layouts, deadlines, validations, invites stb.)
- **Appwrite Cloud** Auth (user-records, sessions)
- **Appwrite Cloud** Storage (thumbnails, attachments)
- **Railway proxy** (stateless — NEM-DR-érintett)
- **emago.hu proxy** (stateless fallback — NEM-DR-érintett)

## Appwrite Cloud backup policy

### Default (Free tier)

- **Database**: NEM-automatikus backup. Manual snapshot Appwrite Console-ból.
- **Storage**: NEM-automatikus backup.
- **Retention**: Cloud-szintű disaster-recovery Appwrite-belső (multi-region replication), DE customer-restore NEM-elérhető Free tier-en.

### Pro tier (~$15/projekt/hó)

- **Database**: napi auto-backup, 7-napi retention
- **Storage**: ditto
- **Restore**: Console > Database/Storage > Backups > Restore

### Scale tier (custom)

- **Database**: óránkénti auto-backup, 30+ nap retention
- **Restore**: point-in-time recovery

## Recommendation

**Free tier**: manuális napi/heti backup (Appwrite CLI vagy MCP-vel script-elve):
```bash
# Database export (Free tier-on customer-side)
appwrite databases listDocuments --collectionId <id> --queries 'limit(5000)' > backup-<date>-<col>.json
```

**Production**: **Pro tier upgrade** ($15/projekt/hó) — auto-backup + 7-napi retention elég small-team-hoz. USER-TASK plan-decision.

## Failover (S.11.4)

ADR 0001 dual-proxy: Railway primary + emago.hu fallback.

### Verify-test (USER-TASK)

1. Plugin / Dashboard browser-DevTools Network tab
2. Blokkoljuk a Railway-domain-t a host-fájlban: `127.0.0.1 gallant-balance-production-b513.up.railway.app`
3. Reload — a `EndpointManager` automatikusan failover-elt-e az `emago.hu`-ra?
4. Worst-case recovery: ~25 sec (1.5s + 3s + 6s backoff)

**Eredmény-dokumentálás**: napló entry post-test.

## RTO / RPO

| Scenario | RTO (Recovery Time Objective) | RPO (Recovery Point Objective) |
|---|---|---|
| Railway proxy down | ~25 sec (auto-failover emago.hu-ra) | 0 (stateless) |
| Appwrite Cloud region-incident | Appwrite multi-region failover (transparent) | 0 (cluster replication) |
| Appwrite Cloud DB corruption | **Pro tier**: ~30 perc restore (Console > Backups) | 24 óra (napi backup) |
| Last-owner-orphan org | ~5 perc (`transfer_orphaned_org_ownership` CF action) | 0 |
| Secret-leak | ~10 perc (key rotate + redeploy) — lásd RecoveryRunbook | minimal |
| git-history-leaked secret | ~30 perc (filter-repo) + force-push + contributor-notify | N/A |

## Kapcsolódó

- [[Feladatok#S.11]]
- [[Döntések/0001-dual-proxy-failover]] (dual-proxy)
- [[Komponensek/RecoveryRunbook]] (incident-flow-ok)
- [[Tervek/user-task-runbook]] (Appwrite plan-upgrade USER-TASK)
