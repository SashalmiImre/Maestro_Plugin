---
tags: [terv, session-prompt, S-blokk]
target: S.7.7c
created: 2026-05-15
---

# Új session — S.7.7c `backfill_acl_phase3` legacy ACL backfill action

## Munkakörnyezet

- **Worktree** (abszolút, kötelező CWD): `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`
- **Branch**: `claude/zealous-euler-00c483`
- **PR**: https://github.com/SashalmiImre/Maestro_Plugin/pull/3 (OPEN, frissítve `8d05959`-ig)
- **Status preflight** (kötelező első Bash): `cd <WT> && git status && git log --oneline -5`

Várt baseline: HEAD `8d05959`, 17 commit `origin/main` előtt, clean working tree (kivéve `_docs/Komponensek/LoggingMonitoring.md` placeholder untracked).

## Cél

**R.S.7.7 close kódoldal** — legacy doc-ok (S.7.7 fix-csomag ELŐTT létrejött `articles`/`publications`/`layouts`/`deadlines`/`userValidations`/`systemValidations`) ACL backfill-je. Új CF action `backfill_acl_phase3` (vagy `backfill_acl_phase2` `collections` paraméteres bővítése) az `invite-to-organization` CF-ben. **DEPLOY-BLOCKER** a S.7.7 production close előtt.

## Scope

### File-ok (várhatóan érintett)
- **Új vagy bővített action** `packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js` (`backfillAclPhase3` function vagy `backfillAclPhase2` `collections` paraméterezése)
- **Új helper** (esetleg) `packages/maestro-server/functions/invite-to-organization/src/helpers/aclBackfillUserData.js` ha külön action, vagy a `backfillAclPhase2`-ben kibővített logika
- **`helpers/util.js`** VALID_ACTIONS bővítés (ha új action)
- **`main.js`** ACTION_HANDLERS bejegyzés (ha új action) + esetleg új env-var-ok ha még nincsenek (a S.7.7b óta `LAYOUTS_COLLECTION_ID`, `DEADLINES_COLLECTION_ID`, `USER_VALIDATIONS_COLLECTION_ID`, `SYSTEM_VALIDATIONS_COLLECTION_ID` opcionálisan már fel van véve)

### Új fájl-méret becslés
- Új action ~300-400 sor (similar to `backfillAclPhase2` ~430 sor)
- Vagy `backfillAclPhase2` bővítés ~+100 sor

### Auth-modell
`requireOrgOwner(ctx, organizationId)` (mint `backfillAclPhase2` és `verifyCollectionDocumentSecurity`).

### Új env-var
Nincs új — a 4 új env-var már S.7.7b-vel bevezetve (opcionálisan).

## Fallback policy (KÖTELEZŐ pontosság — Codex verifying C5 2026-05-14)

A 6 user-data collection minden meglévő doc-jára:

| Fokozat | Feltétel | Apply ACL |
|---|---|---|
| 1 | `doc.createdBy` érvényes user-$id (non-empty string + Auth user `usersApi.get(createdBy)` SIKERES) | `withCreator(buildOfficeAclPerms(office.$id), doc.createdBy)` |
| 2 | `createdBy` hiányzik / invalid / Auth user 404 | CSAK `buildOfficeAclPerms(office.$id)` — **NINCS** user-read fallback (NE inferáljunk `modifiedBy`-ból vagy más mezőből arbitrary usert — ASVS V4.1.3 least privilege + ownership enforcement) |

**user-read preserve** mint S.7.2: a meglévő `read("user:*")` perm-eket regex-szel átemeljük (`/^read\("user:/`).

**Audit log mandatory**: minden kategória-2 doc per-collection + per-$id `fallbackUsedDocs: [{collectionId, docId, alias}]` arrayba az action response-ba + CF stdout log. Az admin tudja, mely doc-ok kaptak office-only perm-et (no creator user-read).

## Scope-param (CF 60s timeout-bypass nagy orgon)

Mintázat: `backfillAclPhase2`. Hat scope key:
- `'all'` (default)
- `'articles'`
- `'publications'`
- `'layouts'`
- `'deadlines'`
- `'userValidations'`
- `'systemValidations'`

Office-listázás egyetlen scan (mint `backfillAclPhase2`). `Query.select(['$id', '$permissions', 'createdBy'])` projection a memory-footprint csökkentésére.

## Codex pre-review Q-k (önállóan eldöntendő, GO/NO-GO/NEEDS-WORK)

**Q1**: Új action `backfill_acl_phase3` VAGY `backfill_acl_phase2` bővítés egy új `collections` paraméterrel?
- **Default**: Új action. Indok: a S.7.2 5 tenant collection (org/org-mem/office/office-mem/pubs) ÉS a 6 user-data collection ELTÉRŐ ACL-pattern (org-team vs office-team) és eltérő office-resolution (a publications-en `editorialOfficeId` mező; az articles-en `publicationId → publication.editorialOfficeId` 2-step). A bővítés overload-olná a `backfillAclPhase2`-t.

**Q2**: A office-resolution legendar — articles a publications JOIN-on át. Hogyan?
- **Default**: pre-load minden publication doc-ot (officeId-vel) target-orgon, build a `publicationId → editorialOfficeId` Map-et, és az articles-en a `Map.get(doc.publicationId)`-vel resolve-eljük az officeId-t. Ha `publicationId` hiányzik → recordError + skip.

**Q3**: A `withCreator` validation Phase-1 (mappers közben Auth-user check):
- **Default**: per-doc `usersApi.get(createdBy)` async lookup, cache-elve egy `userIdentityCache` Map-szel a teljes flow-ban (existing helper a `helpers/util.js`-ben: `fetchUserIdentity(usersApi, userId, cache)`). Ha 404 / network fail → kategória 2 fallback.

**Q4**: Idempotens overwrite vs equality-check?
- **Default**: idempotens overwrite (mint `backfillAclPhase2`). A 2. futtatás `$updatedAt`-ot mozdít, de nem semantikusan változtat. Acceptable tradeoff (low Realtime push storm — 300ms debounce a dashboardon).

**Q5**: Auth — `requireOrgOwner(ctx, orgId)` (mint `backfillAclPhase2`)?
- **Default**: GO.

**Q6**: `errors[]` cap és `errorsTruncated` (mint `backfillAclPhase2`)?
- **Default**: GO, `MAX_ERRORS = 100`.

**Q7**: Tesztelési stratégia?
- **Default**: NO test infra (manual review + S.7.5 2-tab adversarial elég, mint S.7.7b). Codex stop-time + verifying CLEAN garantálja a fail-osztály-coverage-t.

## Context (olvasandó minimum)

1. `_docs/Naplók/2026-05-15.md` (S.7.7b zárás — minta a hasonló action implementációjára)
2. `_docs/Feladatok.md` S.7.7c bejegyzés (53. sor)
3. `_docs/Komponensek/TenantIsolation.md` — különösen "S.7.7b verify_collection_document_security action" szakasz (Codex pipeline minta)
4. `_docs/Komponensek/SecurityRiskRegister.md` R.S.7.7 sor
5. `_docs/Döntések/0014-tenant-doc-acl-with-creator.md` (Layer 1+2+3 invariáns)
6. Memory: `MEMORY.md` "## A.7.1" + "## D blokk deploy roadmap" + "## Phase 2 follow-upok + Harden Ph3" (a backfill-action minták)
7. **Kód-minta**: `packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js` `backfillAclPhase2` function (sorok 1394-1783) — ezt másold a strukturához
8. **Helper-minta**: `helpers/collectionMetadata.js` (S.7.7b-ben létrehozott whitelist + parallel lookup minta — reusable a phase3-ban is, mert ott is a 6 user-data collection enum kell)

## Indító lépések (sorban)

1. **Preflight** (kötelező):
   ```bash
   cd /Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483
   git status && git log --oneline -5
   ```

2. **Olvasás** (párhuzamos, Read + Bash grep):
   - `_docs/Naplók/2026-05-15.md`
   - `_docs/Feladatok.md` 50-58 sor
   - `_docs/Döntések/0014-tenant-doc-acl-with-creator.md`
   - `packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js` 1394-1783 (a `backfillAclPhase2` minta)
   - `packages/maestro-server/functions/invite-to-organization/src/helpers/collectionMetadata.js` (REQUIRED_SECURED_COLLECTIONS reuse)

3. **Codex pre-review** (Agent codex:codex-rescue, effort=low, no file reads, self-contained):
   - Q1-Q7 fenti listából
   - Várt GO-arány: 5-7×GO, esetleg 1 NEEDS-WORK az office-resolution-on (Q2)

4. **Implementáció** (sorrendben):
   - `helpers/collectionMetadata.js` reuse: `REQUIRED_SECURED_COLLECTIONS` exportálása már megvan. (Ha külön helper kell az alias→envKey resolve-hez, az S.7.7b-ben van.)
   - `actions/schemas.js`: új `backfillAclPhase3` function. Office-pre-load Map → per-collection `listAllByQuery` (Query.select projection) → per-doc rewrite loop → user-read preserve + kategória-1/2 fallback → fallbackUsedDocs audit.
   - `helpers/util.js`: VALID_ACTIONS bővítés `'backfill_acl_phase3'`.
   - `main.js`: ACTION_HANDLERS bejegyzés.

5. **Codex stop-time review** (effort=low, no file reads, self-contained):
   - Fókusz: race-conditions, fallback policy (kategória 2 NEM ad arbitrary user-read), audit-log completeness, scope-param error handling, idempotens overwrite invariáns.

6. **Codex verifying review** a fix-ek után.

7. **`/harden` pass** (7 fázis): baseline + adversarial + simplify + verifying.

8. **Doku-frissítés**:
   - `_docs/Feladatok.md`: S.7.7c `[x]` Done (code-only) + audit-log példa
   - `_docs/Komponensek/TenantIsolation.md`: új "S.7.7c `backfill_acl_phase3` action" szakasz (architektúra + scope-policy + audit-log + deploy steps)
   - `_docs/Komponensek/SecurityRiskRegister.md`: R.S.7.7 Closed (code-only) 2026-05-XX
   - `_docs/Naplók/2026-05-XX.md`: új daily note

9. **Commit + push** 2-commit minta (kód + doku). `git -C <WT>` minden hívás.

10. **Következő session prompt**: `_docs/Tervek/next-session-S.7.5.md` vagy `next-session-S.7.8.md` (a S.7.7c utáni open al-pontoknak).

## STOP feltételek

- **Office-resolution Q2** Codex NO-GO → DESIGN-Q user-szóra, ne implementálj egyedül
- **Codex 2 iteráció után** still BLOCKER → STOP + user-jelentés
- **Branch push konfliktus** → STOP
- **Appwrite SDK error** lokálisan `node --check` syntax-failure → STOP

## Becsült időtartam

- Codex pre + stop + verifying: ~5-10 perc (3×60-90s + Claude reaction)
- Implementáció: ~30-45 perc (~400 sor új kód + minta-átmásolás)
- /harden: ~10-15 perc (4×Codex iteráció)
- Doku + commit + push: ~10 perc
- **Összesen**: ~60-90 perc / session

## Kapcsolódó

- [[Tervek/autonomous-session-loop]] — meta-routine prompt (minden iteráció master)
- [[Feladatok#S.7.7c]] — al-pont státusz
- [[Komponensek/SecurityRiskRegister]] R.S.7.7 — kockázat-leltár
- [[Döntések/0014-tenant-doc-acl-with-creator]] — Layer 1+2+3 ADR
- [[Naplók/2026-05-15]] — S.7.7b zárás minta
