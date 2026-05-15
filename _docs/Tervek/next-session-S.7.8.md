---
tags: [terv, session-prompt, S-blokk]
target: S.7.8
created: 2026-05-15
---

# Új session — S.7.8 Phantom-org window mitigáció (R.S.7.4 close)

## Munkakörnyezet

- **Worktree** (abszolút): `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`
- **Branch**: `claude/zealous-euler-00c483`
- **PR**: https://github.com/SashalmiImre/Maestro_Plugin/pull/3 (frissítve `c7e41c9`-ig)

## Cél

**R.S.7.4 close kódoldal** — `bootstrap_organization` phantom-org window mitigáció. A `createDocument(organizations)` SIKER UTÁN + `runRollback` ELŐTT ~10-100ms-ig a creator látja a doc-ot (`Permission.read(user(callerId))` azonnal hat). Ha a frontend ebben az ablakban lekér a doc-ról, fantom-org megjelenik a UI-ban.

## Fix (Harden P1 user-decision javasolt minta)

1. `organizations.status` mező schema-bővítés: új enum `provisioning|active|orphaned|archived` (jelenleg `active|orphaned`).
2. A `bootstrap_organization` action a `createDocument`-et `status: 'provisioning'`-nal hívja; a sikeres init flow VÉGÉN (membership + office + workflow etc.) `updateDocument(status: 'active')`. Rollback ágon a `status` `provisioning` marad — admin külön törölheti / recovery-zheti.
3. **Frontend filter** (cross-cutting): minden org-list query `Query.equal('status', 'active')`-szel megy. A `provisioning` doc NEM látható.
4. `user-cascade-delete` CF szintén filter-eli a `provisioning` org-okat (NEM törli ARTICLE-eket egy phantom-on át).

## Scope (cross-cutting)

- **Backend** (`invite-to-organization` CF):
  - `actions/schemas.js bootstrap_organization_status_schema` action bővítés (új enum)
  - `actions/orgs.js bootstrapOrCreateOrganization` flow (createDocument-en `status: 'provisioning'` + flow VÉGÉN updateDocument)
  - `actions/schemas.js backfill_organization_status` action (legacy org-okat 'active'-ra állít)
- **Frontend** (plugin + dashboard):
  - Minden org-list query `Query.equal('status', 'active')`
  - `subscribeRealtime` callback szűr `provisioning`-ra
  - Lokális cache state `provisioning`-org-ok kihagyása
- **user-cascade-delete CF**: phantom-org filter

Lassú scope (~500+ sor + multi-fájl, multi-csomag). Várhatóan ~120-180 perc / iteráció.

## Codex pre-review Q-k (önállóan eldöntendő)

**Q1**: Schema-bővítés vs új mező — `status` enum bővítés (`provisioning|active|orphaned|archived`) vs külön `bootstrapState: 'inProgress'|'complete'` mező?
- Default: **enum bővítés** (a meglévő `status` mező a frontend filter-mintán már be van vezetve, minimal cross-cutting impact).

**Q2**: Frontend filter — `Query.equal('status', 'active')` minden org-list query-én, VAGY a Realtime feliratkozás callback-en szűrünk?
- Default: **mindkettő** (defense-in-depth + REST + Realtime).

**Q3**: Backfill `backfill_organization_status` action: meglévő legacy org-okat `'active'`-ra állítja?
- Default: **GO** (lásd D.2 ADR, már létezik infrastruktúra).

**Q4**: Rollback flow — ha a `bootstrap_organization` valahol elbukik a flow közepén (pl. office-creation fail), a `status: 'provisioning'` marad a doc-on. Ki törli később?
- Default: új `orphan_provisioning_org` cleanup action VAGY admin manuális törlés a recovery flow-ban.

**Q5**: `transfer_orphaned_org_ownership` recovery flow — kezeli-e a `provisioning` állapotot? Vagy csak `orphaned`-t lát?
- Default: bővítés — `provisioning` is recovery-target legyen (admin "elakadt" bootstrap-eket is helyreállíthat).

## Codex pipeline + Harden minta

Mint S.7.7c / S.7.9: pre-review (effort=low) → impl → stop-time → verifying → /harden (baseline + adversarial + simplify + verifying).

## STOP feltételek

- **Q1 enum vs új mező** DESIGN-Q → user-decision needed (cross-cutting impact eltér)
- **Frontend integrate** breaking change (minden org-list query módosul) → 5-10 fájl
- **Codex 2 iteráció után** still BLOCKER → STOP

## Becsült időtartam

~120-180 perc (a többi al-pontnál hosszabb a cross-cutting impact miatt).

## Context (olvasandó minimum)

1. `_docs/Naplók/2026-05-15.md` (3 iteráció zárása)
2. `_docs/Feladatok.md` S.7.8 bejegyzés (55. sor)
3. `_docs/Komponensek/SecurityRiskRegister.md` R.S.7.4 sor
4. `_docs/Döntések/0014-tenant-doc-acl-with-creator.md` (phantom-org P1)
5. **Kód-minta**: `actions/orgs.js bootstrapOrCreateOrganization` (~1300 sor) + `bootstrapOrganizationStatusSchema` (D.2.1) + `backfillOrganizationStatus` (D.2.5)

## Alternatív next-target (ha S.7.8 cross-cutting túl-nagy)

- **S.7.10** (MEDIUM): `tryEnsureMembershipNonBlocking` DRY (3 hívóhely) — kis refactor, ~30-60 perc
- **S.7.11** (MEDIUM): `team_not_found` enum (18+ literal) — kis refactor, ~30-60 perc
- **S.3** (HIGH): security headers + CSP — ~60-120 perc

A /loop self-pace mode auto-mode-ban a S.7.8-at választja (HIGH prio). Ha cross-cutting refactor túl-nagy / DESIGN-Q → STOP + user-decision.

## Kapcsolódó

- [[Tervek/autonomous-session-loop]] — meta-routine master
- [[Feladatok#S.7.8]] — al-pont status
- [[Komponensek/SecurityRiskRegister]] R.S.7.4
- [[Naplók/2026-05-15]] — 3 iteráció záró napló
