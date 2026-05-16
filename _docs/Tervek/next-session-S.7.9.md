---
tags: [terv, session-prompt, S-blokk]
target: S.7.9
created: 2026-05-15
---

# Új session — S.7.9 `anonymize_user_acl` CF action

## Munkakörnyezet

- **Worktree** (abszolút, kötelező CWD): `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`
- **Branch**: `claude/zealous-euler-00c483`
- **PR**: https://github.com/SashalmiImre/Maestro_Plugin/pull/3 (OPEN, frissítve `1d5e200`-ig)
- **Status preflight** (kötelező első Bash): `git -C <WT> status && git -C <WT> log --oneline -5`

Várt baseline: HEAD `1d5e200`, 19 commit `origin/main` előtt, clean working tree (kivéve `_docs/Komponensek/LoggingMonitoring.md` placeholder untracked).

## Cél

**R.S.7.5 close kódoldal** — GDPR Art. 17 stale `withCreator` user-read cleanup. Egy új CF action `anonymize_user_acl` ami egy adott user-$id `Permission.read(user:X)` perm-jeit eltávolítja a meglévő tenant doc-okról, amikor a user kilép a tenant-ből vagy törli a fiókját. Q1 user-decision B (2026-05-13 Harden Phase 7): külön action a `backfill_acl_phase2`/phase3-tól.

## Scope

### File-ok (várhatóan érintett)

- **Új action** `packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js` (`anonymizeUserAcl` function ~250-300 sor)
- **`helpers/util.js`** VALID_ACTIONS bővítés
- **`main.js`** ACTION_HANDLERS bejegyzés

### Auth-modell (FONTOS — eltér a backfill action-öktől)

**Self-anonymize** (a user maga, kilépés / fiók-törlés flow-on át):
- Caller = `callerId`, targetUserId = `callerId` → engedett. A `leave_organization` és `delete_my_account` action-ök automatikusan hívják.

**Admin-anonymize** (admin másik user-re):
- Caller = org owner, targetUserId = másik user → engedett az ORG-on belül.
- `requireOrgOwner(ctx, organizationId)` auth.

### Új env-var

Nincs új — az `articles`/`publications`/`layouts`/`deadlines`/`userValidations`/`systemValidations` + `organizationMemberships`/`editorialOfficeMemberships`/`organizations`/`editorialOffices`/`publications` env-varok már fel vannak véve.

## Affected collection lista (target-org-on belül scan)

A target-user-id-jét tartalmazó `Permission.read(user:X)` perm-eket NULLÁZZUK (regex-szel filter-eljük ki) a következő collection-ökön:

| # | Collection alias | Mit várunk a perm-on |
|---|---|---|
| 1 | `organizations` | `read("user:X")` legacy ACL (S.7.1 `withCreator`-tól) |
| 2 | `organizationMemberships` | mint #1 |
| 3 | `editorialOffices` | mint #1 |
| 4 | `editorialOfficeMemberships` | mint #1 |
| 5 | `publications` | mint #1 (S.7.1 fix-csomagból + S.7.7 frontend fix-ből) |
| 6 | `articles` | S.7.7 frontend fix-csomagból |
| 7 | `layouts` | mint #6 |
| 8 | `deadlines` | mint #6 |
| 9 | `userValidations` | mint #6 |
| 10 | `systemValidations` | mint #6 |
| 11 | `organizationInvites` | meghívási flow legacy perm-ek (W3 admin-team scoped) |
| 12 | `organizationInviteHistory` | mint #11 |

## Codex pre-review Q-k (önállóan eldöntendő)

**Q1**: Az anonymize SET PERMS-szel hogyan? 
- A) `updateDocument(..., $permissions, [filtered])` — `read("user:X")` ki van filterelve, a többi perm marad
- B) `updateDocument(..., $permissions, [perms with the user-read removed])` — egy regex-szűréssel: `currentPerms.filter(p => !p.includes(`user:${userId}`))`
- **Default: B** (single-source filter szerint a meglévő perm-eket NEM bántjuk, csak a target user-id specifikus perm-eket).

**Q2**: Scope-paraméter (mint phase3)?
- **Default**: NEM — a 12 collection EGY-EGY query (Query.contains a `$permissions` mezőn EGYELŐRE NEM támogatott Appwrite-on, tehát mind a 12 collection full scan-elése a target-orgra szűkítve). A scope-paraméter csak akkor kell, ha a 12 collection külön-külön kell futtatni timeout-veszély miatt.

**Q3**: Query-szűkítés a target-orgra:
- A) `Query.equal('organizationId', targetOrgId)` minden collection-ön (működik 11/12-en, a `systemValidations`/`userValidations` NEM tárol org-id-t → BATCH `Query.equal('articleId', batch)` mint phase3)
- B) Single-pass listAll filter NEM (Appwrite `$permissions` query-szűrés NEM support-olt)
- **Default: A** (a phase3 minta)

**Q4**: Self-anonymize trigger — a `leave_organization` és `delete_my_account` action-ök automatikusan hívják a `anonymize_user_acl`-t?
- **Default: NEM** — manuális hívás vagy a callerId-ből inferált self-trigger. A `delete_my_account` flow már `users.delete`-t hív, az Appwrite SDK-tól a `Role.user(id)` perm-ek post-delete view-ja undefined behavior (lehet hogy a user már nem listed, de a perm-ek a doc-okon megmaradnak — STALE).
- Vagy: **GO**, és a 2 self-service flow-ban explicit hívás (egy plusz CF-call a flow végén).

**Q5**: `removeTeamMembership` MELLÉ `anonymize_user_acl`?
- A `leave_organization` és `delete_my_account` flow-ban a `removeTeamMembership(org_${orgId}, userId)` után az `anonymize_user_acl(targetUserId=callerId, organizationId=orgId)` is fusson?
- **Default: GO** — különben a tag még látja a régi history-jét a doc-okon (GDPR Art. 17 sérülés).

**Q6**: Auditellátás — `affectedDocsCount` per-collection?
- **Default: GO** — mint phase3 stats.

**Q7**: Idempotens overwrite vs equality-check?
- **Default**: idempotens overwrite (mint phase2+phase3).

## Context (olvasandó minimum)

1. `_docs/Naplók/2026-05-15.md` (S.7.7b + S.7.7c legutóbbi session-zárás)
2. `_docs/Feladatok.md` S.7.9 bejegyzés (56-57 sor)
3. `_docs/Komponensek/SecurityRiskRegister.md` R.S.7.5 sor
4. `_docs/Döntések/0014-tenant-doc-acl-with-creator.md` (`withCreator` stale GDPR-kockázat)
5. **Kód-minta**: `actions/schemas.js` `backfillAclPhase2` (~1400-1750) + `backfillAclPhase3` (~1790-2420) — mintát másold a strukturához
6. **Self-service flow**: `actions/orgs.js` `leaveOrganization` + `deleteMyAccount` (kötelező integrálás Q5-szerint GO esetén)

## Indító lépések (sorban)

1. **Preflight**: `cd <WT> && git status && git log --oneline -5`
2. **Olvasás** (párhuzamos Read + grep)
3. **Codex pre-review** (Agent `codex:codex-rescue`, effort=low, self-contained briefing). Várt: 5-7×GO, esetleg 1 NEEDS-WORK Q4-en (auto-trigger).
4. **Implementáció** Edit-szel (~300 sor új function + 12-collection scan loop).
5. **Codex stop-time review**.
6. **Codex verifying review**.
7. **`/harden` pass** (7 fázis).
8. **Doku-frissítés**: Feladatok.md S.7.9 `[x]`, TenantIsolation.md új szakasz "S.7.9 anonymize_user_acl", SecurityRiskRegister.md R.S.7.5 closed, Naplók/2026-05-XX.md új daily note (vagy 2026-05-15 bővítés).
9. **Commit + push** 2-commit mintán.
10. **Következő session prompt generálás**: `_docs/Tervek/next-session-S.7.8.md` (S.7.8 phantom-org window) VAGY `_docs/Tervek/next-session-S.3.md` (security headers).

## STOP feltételek

- **Q4 auto-trigger** Codex NEEDS-WORK → DESIGN-Q user-szóra
- **Self-service flow integrálás** breaking change (a `leave_organization` és `delete_my_account` 2 action signature-jét érinti, ha Q5 GO) → 2-3 fájl + integrate-teszt risk
- **Codex 2 iteráció után** still BLOCKER → STOP + user-jelentés
- **Branch push konfliktus** → STOP

## Becsült időtartam

- Codex pre + stop + verifying: ~5-10 perc
- Implementáció: ~30-40 perc (~300 sor, hasonló minta phase3-mal)
- /harden: ~10-15 perc
- Doku + commit + push: ~10 perc
- **Összesen**: ~60-80 perc / session

## Kapcsolódó

- [[Tervek/autonomous-session-loop]] — meta-routine master
- [[Feladatok#S.7.9]] — al-pont status
- [[Komponensek/SecurityRiskRegister]] R.S.7.5 — kockázat
- [[Döntések/0014-tenant-doc-acl-with-creator]] — `withCreator` stale GDPR motiváció
- [[Naplók/2026-05-15]] — S.7.7c session-zárás minta
