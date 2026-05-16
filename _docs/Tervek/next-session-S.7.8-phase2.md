---
tags: [terv, session-prompt, S-blokk, frontend]
target: S.7.8 Phase 2
created: 2026-05-15
---

# Új session — S.7.8 Phase 2 frontend filter (R.S.7.4 close)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`
- **Branch**: `claude/zealous-euler-00c483`

## Cél

A S.7.8 Phase 1 backend (kódoldal kész 2026-05-15) `'provisioning'` status-szal jelöli a frissen bootstrap-elt org-doc-okat a `withCreator` window-ban, de a frontend MÉG NEM szűri őket. Phase 2: minden org-list query + Realtime callback szűr `status === 'active'`-ra, és a `user-cascade-delete` CF NEM törli a `provisioning`-okat.

## Scope (cross-cutting frontend, ~30-50 perc)

### Plugin (maestro-indesign)

- `core/contexts/OrganizationsContext.jsx` (vagy hasonló) — org-list `databases.listDocuments` query: `Query.equal('status', 'active')`
- Realtime feliratkozás callback: `if (payload.status !== 'active') return;` szűrés
- Lokális cache state: `provisioning` org-okat NEM rakja a state-be

### Dashboard (maestro-dashboard)

- Hasonló — org-list query + Realtime filter

### user-cascade-delete CF

- Org-delete event-handler: `provisioning` status-on NEM cascade-eli a child-collection törléseket. Egy `provisioning`-ot törölve csak a doc maga, NEM az articles/publications stb.

## Codex pre-review Q-k

**Q1**: Frontend filter csak query-szinten (`Query.equal('status', 'active')`) VAGY callback-en is?
Default: **mindkettő** (defense-in-depth — query a REST + Realtime payload-okra; callback a kliens-cache-state-re).

**Q2**: Backwards compatibility — a legacy doc-ok `status` mezője `null` lehet (a `bootstrap_organization_status_schema` előtt). Hogyan kezeljük?
Default: a `backfill_organization_status` action már létezik a D.2 ADR-on át; legacy doc-ok `null` → `'active'`. Frontend filter `Query.equal('status', 'active')` szigorú — a backfill-en futott doc-okat látja, NEM-backfill-elteket NEM. A backfill ELŐSZÖR mehet, AZTÁN frontend deploy.

**Q3**: Test infra — manuális verify (1 új org bootstrap) elég, vagy adversarial 2-tab teszt (Phase 2 acceptance)?
Default: **manuális verify** (2-tab adversarial cross-org-on a S.7.5).

## STOP feltételek

- **Backfill előbb** — a frontend filter deploy a backfill UTÁN (különben legacy null-status doc-ok eltűnnek a UI-ból). User-task pre-requisite.
- **Codex 2 iteráció után BLOCKER** → STOP.

## Becsült időtartam

~30-50 perc (kis frontend refactor, ~50 sor / csomag).

## Kapcsolódó

- [[Naplók/2026-05-15]] 4. iteráció (Phase 1 backend zárás)
- [[Komponensek/TenantIsolation#S.7.8 Phase 1 phantom-org window]]
- [[Feladatok#S.7.8]]
- [[Tervek/autonomous-session-loop]]
