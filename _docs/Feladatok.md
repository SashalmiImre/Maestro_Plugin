---
aliases: [TODO, Tasks, Teendők]
tags: [feladatok]
---

# Feladatok

> Aktív TODO-k. A megvalósult tervek a vault-ba migrálva (lásd [[#Kész — vault hivatkozások]] alul). A korábbi részletes blokk-tervek (A.0-A.5, B.0-B.5, C, D.2-D.7, E, F, G, H) **mind kész** — történeti tartalom az ADR-ekben és napló-bejegyzésekben.

## Aktív

### A.6 Smoke teszt

- [ ] **A.6.1** — Permission rendszer 2-tab smoke: workflow létrehozás új slug-okkal → kiadvány hozzárendelés → autoseed verifikálás → tag-hozzáadás → aktiválás → plugin Realtime.
- [ ] **A.6.2** — Aktivált pub közbeni tag-eltávolítás: a snapshot védi a runtime-ot; UI warning + notification verifikálás.
- [ ] **A.6.3** — Adversarial: backend-bypass (kliens nem tud átírni állapotot ha hiányzik a jogosultság), `rowSecurity: true` cross-tenant izoláció. `slug` immutable enforcement (DevTools-ból se módosítható).

### A.7 Phase 2 — single-source build-step-ek + design follow-upok

- [ ] **A.7.2** — Plugin `useUserPermission` "deny on loading" API revizit. A jelenlegi `{ allowed: boolean, loading: boolean }`-nél a `clientHasPermission(null, slug) === false` miatt a hidratálatlan állapot effektíve "denied"-ként jelenik meg. Átállítás `{ status: 'loading' | 'allowed' | 'denied' }` enum-ra. Triggerelje az első valódi UI consumer (jelenleg 0). → [packages/maestro-indesign/src/data/hooks/useElementPermission.js](packages/maestro-indesign/src/data/hooks/useElementPermission.js).
- [ ] **A.7.3** — `permissions.js` shared/CF inline duplikáció single-source build-step. A.7.1 + H.2 (orphan-guard) mintára. Új `scripts/build-cf-permissions.mjs` ESM → CJS, a CF `permissions.js` egy `_generated_permissionsCatalog.js`-t require-ol. Yarn `build:cf-permissions` + `check:cf-permissions`. Triggerelje, mielőtt új slug-ot adunk a shared modulhoz.
- [ ] **A.7.4** — Schema bootstrap drift-detection. A 5 `bootstrap_*_schema` action a 409/already-exists ágon NEM ellenőrzi az attribute / index shape-jét. Részleges bukás vagy manuális Console-edit silent drift-et okozhat. Megoldás: 409 ágban `getAttribute` / `getIndexes` lookup → shape-ekvivalencia → eltérésre `schema_drift_detected` 500. Helper: `assertAttributeMatches`, `assertIndexMatches`. Production-szintű deploy hardening előtt érdemes.
- [ ] **A.7.5** — `extensionContract.js` shared/CF inline duplikáció single-source build-step. A.7.1/A.7.3 minta. Új `scripts/build-cf-extension-contract.mjs`, a CF `helpers/_generated_extensionContract.js`-t require-olja. **Triggerelje** mielőtt a B.3 új slug-ot vagy enum-bővítést kap.

### B.6 Smoke teszt

- [ ] **B.6.1** — Workflow extension end-to-end: extension létrehozás → workflow hivatkozás → publikáció aktiválás → plugin futtatás → eredmény. Protokoll: [[B6-smoke-test]]. (Manuális, InDesign + Dashboard.)

### D.1 DevOps / MCP setup

- [ ] **D.1.2** — Dashboard auto-deploy webhook (cPanel). A `deploy.sh` SSH/SCP — GitHub Actions workflow-val automatizálható (push-on-main → SSH-deploy). Bemenet: `secrets.SSH_PRIVATE_KEY` + `secrets.REMOTE_HOST` (alternative: deploy-key-only user a cPanel-en, restricted-shell). **Why**: a session-szintű forget-to-deploy cost megszűnik.

### D.3 Audit-trail follow-up

- [ ] **D.3.4** — `organizationInviteHistory` retention policy (default forever, admin-kérésre törölhető Console-ról). Phase 2: cron-alapú TTL.
- [ ] **D.3.5** ([[Döntések/0012-org-member-removal-cascade]] DESIGN-Q D1) — admin-kick audit-trail. A `remove_organization_member` jelenleg csak Appwrite execution log-ot ír. Ha tenant-visible forensic history kell (különösen owner-on-owner kick-ekre), bővítsük az `organizationInviteHistory`-t `removed_by_admin` finalStatus-szal, vagy új `organizationMemberRemovalHistory` collection. Trigger: első panaszos incident vagy explicit compliance-igény.
- [ ] **D.3.6** ([[Döntések/0013-self-service-account-management]] M2 follow-up) — `delete_my_account` `MAX_ORGS_PER_DELETE_CALL = 10` cap. Ha 10+ org-tag user gyakori, vagy a CF timeout 60s-en sokba kerül, implement chunkolás `continueFrom` payload-mezővel + frontend retry-pattern. Jelenleg 409 `too_many_orgs` hint a usernek (manuális leave-ek előtt).

### D.5 Hardening backlog (deferred)

- [ ] **D.5.1** — Atomic TOCTOU lock invite-küldésen (`(inviteId, secondsBucket)` unique-index `inviteSendLocks`). **Trigger**: első botspam incident; jelenlegi pre-claim ~30ms race-window alacsony kockázat.
- [ ] **D.5.3** — Race-test integration suite (k6 / custom Node-script). Eseti futtatás (NEM CI minden PR-on, költséges).

### D.6 Test-account user decision

- [ ] **D.6.2** — Test-account `69fe79e00022f3f9b2f6` (Sasi/`sashalmi.imre@gmail.com`) felhasználói döntés (maradhat vagy törölhető). Ha törlik, az új `user-cascade-delete` v4 cleanup-ol.

### H.6 Post-deploy E2E smoke (manuális)

- [ ] **H.6 admin-team ACL** — test-org 2 admin + 1 member: invite küldés admin-tól → `organizationInvites` ACL `team:org_X_admins`. Member belépés → NEM látja a pending invite-okat. Admin → látja. Invite accept → `organizationInviteHistory` ACL `team:org_X_admins`. Member NEM látja a history-t. Admin igen.
- [ ] **H.6 orphan-guard** — test-org `status='orphaned'` → próbálj UI-ból: rootPath-set, article-update, publication-update. Várt: 403 `org_orphaned_write_blocked` mind a 3 esetben. Reset `active`-ra → minden írás OK.
- [ ] **H.6 race-test** — k6/custom Node-script: 2-2 párhuzamos `acceptInvite` + opportunista `auto_expire_on_list` ugyanarra a token-re. Várt: pontosan 1 history rekord per invite, vagy `accepted` vagy `expired`, NEM mindkettő.
- [ ] **H.6 demote-test** — admin → member role-change → admin-team-ből kikerül. Új invite → ex-admin NEM látja.
- [ ] **Backfill admin-team ACL** — minden orgon `dryRun: true` ELŐSZÖR, aztán éles. Az action user-context-et igényel (org owner) — Appwrite Console (Functions → Execute) vagy egy admin-flow a dashboard-ról. Részletek: [[Döntések/0011-cas-gate-and-orphan-guard-invariants]] és [[Naplók/2026-05-09]] Session-6.

### Phase 3 deferred (ADR 0011 Harden Ph2 findingek + halasztott design)

- [ ] **CI generator drift hook** (Codex SHOULD): pre-commit hook (husky/lefthook) + GitHub Actions PR-validator a `check:cf-orphan-guard` + `check:cf-validator` (+ A.7.3, A.7.5 generálók) script-ekre. Trigger: ha generator-out-of-sync deploy bug történik.
- [ ] **Audit completeness** (Codex DESIGN, ADR 0011): a G.5 race-loser audit-loss formálisan pótolható egy "race-attempt-log" collection-nel (mind a két ágat append-only logolja). Trigger: külső compliance-regulátor explicit event-log követelménye.
- [ ] **Cursor invalidation** (Codex DESIGN, ADR 0011): a `paginateByQuery(fromCursor)` opaque cursor-t használ — ha a cursor-doc törlődik a futások között, undefined behavior. Trigger: élesben checkpoint-resume bukik. Mitigation: monotonic sort key + explicit `>` filter — Phase 2.x checkpoint-pattern impl-kor.
- [ ] **CAS-gate config-check vs auth precedence** (Codex DESIGN, ADR 0011): az `_assertCasGateConfigured()` az auth ELŐTT fut → unauthorized hívók info-disclosure-t kaphatnak a config-misconfig state-ről. A jelenlegi sorrend a fail-closed elv miatt elfogadható. Trigger: ha info-disclosure security audit ezt explicit ki-jelzi.
- [ ] **F.8 strict ACL invariáns** (ADR 0011): collection-szintű write-tilt `status='orphaned'` orgokra. A jelenlegi best-effort guard + F.9 deny-cache + Konstrukció C invite-CAS-gate elegendő. **Trigger**: élesben race-corrupcio incident.
- [ ] **E.6 hívó action-integráció** — `backfill_admin_team_acl` `payload.fromInviteCursor` + `nextCursor` return + a hívó iteratív retry-pattern. A `paginateByQuery` ready (`maxRunMs` + `fromCursor` + `incomplete`).

## Kész — vault hivatkozások

A korábbi tervek érett tartalma a vault kanonikus formáira költözött:

### Architektúra döntések (ADR-ek)
- **A blokk Permission rendszer + workflow-driven groups** (2026-05-01–02): [[Döntések/0008-permission-system-and-workflow-driven-groups]]
- **B blokk Workflow Extensions** (2026-05-04–05): [[Döntések/0007-workflow-extensions]]
- **Workflow lifecycle & scope**: [[Döntések/0006-workflow-lifecycle-scope]]
- **Membership user-identity denormalizáció**: [[Döntések/0009-membership-user-identity-denormalization]]
- **D blokk Meghívási flow redesign** (2026-05-08–09 Session-2): [[Döntések/0010-meghivasi-flow-redesign]]
- **E+F+G + Phase 2 + Harden — CAS-gate + orphan-guard invariánsok** (2026-05-09 Session-3–5): [[Döntések/0011-cas-gate-and-orphan-guard-invariants]]
- **Tenant Team ACL** (Fázis 2): [[Döntések/0003-tenant-team-acl]]
- **Dynamic groups** (Fázis 2): [[Döntések/0002-fazis2-dynamic-groups]]

### Komponensek / atomic notes
- **Permission taxonomy** (A blokk slug-katalógus): [[Komponensek/PermissionTaxonomy]]
- **Permission helpers** (server-oldal): [[Komponensek/PermissionHelpers]]
- **Workflow extensions** (Phase 0 implementáció): [[Komponensek/WorkflowExtension]] + [[Komponensek/ExtensionRegistry]]
- **Session preflight rule** (D.1.1, D.1.3): [[Komponensek/SessionPreflight]]
- **CF template** (új CF létrehozásához endpoint-default fix): [[Komponensek/CFTemplate]]
- **User identity map**: [[Komponensek/UserIdentityMap]]

### Csomagok
- **maestro-server akció-modul-térkép** (B.0.3 inkrementális split, single-source build-step-ek, CAS-gate referenciák): [[Csomagok/maestro-server]]
- **dashboard-workflow-designer**: [[Csomagok/dashboard-workflow-designer]]
- **meghívási flow**: [[Csomagok/meghivasi-flow]]

### Dashboard design
- **C blokk Editorial OS dark v2 + light theme** (2026-05-05–06): [[packages/maestro-dashboard/design-system|design-system.md]] + [tokens.css](packages/maestro-dashboard/css/tokens.css)
- **Copy-hygiene szabály** (C.0.3, file-local `LABELS` objektum): a [[packages/maestro-dashboard/design-system|design-system.md]]-ben dokumentált

### Munkafolyamat
- **Codex co-reflection alapelv** (D.0): [[Munkafolyamat#Codex co-reflection alapelv]]
- **Manuális smoke teszt checklist**: [[Munkafolyamat#Manuális smoke teszt checklist]]
- **Session preflight**: [[Munkafolyamat#Session preflight]]

### Naplók (Karpathy-tudástár 2026-04-28 óta)
- [[Naplók/2026-05-01]] — A blokk Tervek lebontása + B blokk indító döntések
- [[Naplók/2026-05-02]] — A.2 szerver-implementáció harden-irányított session
- [[Naplók/2026-05-03]] — A.7.1 single-source build-step refactor
- [[Naplók/2026-05-04]] — B.0.3 modul-split + B.1+B.2+B.3 implementáció
- [[Naplók/2026-05-05]] — B.4 Plugin runtime + B.5 Dashboard UI + C.1 Stitch screen-iteráció
- [[Naplók/2026-05-07]] — Membership user-identity denormalizáció (ADR 0009)
- [[Naplók/2026-05-09]] — D.2–D.7 + E+F+G + Phase 2 + Harden + Deploy (Session-2 → 6)
