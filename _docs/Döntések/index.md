---
tags: [moc, adr]
---

# Architektúra döntések (ADR-ek)

Sorrend = időbeli (`NNNN` szekvencia).

| # | Cím | Dátum | Státusz |
|---|---|---|---|
| 0001 | [[0001-dual-proxy-failover]] | 2026-02-26 | Accepted |
| 0002 | [[0002-fazis2-dynamic-groups]] | 2026-04-09 | Accepted |
| 0003 | [[0003-tenant-team-acl]] | 2026-04-19 | Accepted |
| 0004 | [[0004-dashboard-realtime-bus]] | 2026-04-19 | Accepted |
| 0005 | [[0005-dashboard-custom-domain]] | 2026-04-19 | Accepted |
| 0006 | [[0006-workflow-lifecycle-scope]] | 2026-04-20 | Accepted |
| 0007 | [[0007-workflow-extensions]] | 2026-05-01 | Proposed |
| 0008 | [[0008-permission-system-and-workflow-driven-groups]] | 2026-05-01 | Proposed |
| 0009 | [[0009-membership-user-identity-denormalization]] | 2026-05-07 | Accepted |

## Új ADR
1. Másold a [[Templates/decision-template]] tartalmát.
2. Új fájl: `NNNN-rovid-cim.md`, ahol `NNNN` a következő szám.
3. Frontmatter: `status: Proposed | Accepted | Deprecated | Superseded`.
4. Adj sort ehhez az indexhez.

> **Mikor készíts ADR-t?**
> Új architektúra-szintű döntés (új technológia, új minta, breaking change) — ne csak fejtörés, hanem amit egy új csapattag is meg fog kérdezni: "miért így van ez?".
