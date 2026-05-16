---
tags: [moc, napló]
---

# Naplók

Daily notes — időrendi munkajegyzetek. Érdemes hosszabb session végén készíteni: mit csináltam, mi volt blokkoló, holnap mit folytatok.

## 2026 április
- [[2026-04-25]]
- [[2026-04-28]] — Karpathy-tudástár 1+2+3. fázis összefoglaló

## 2026 május
- [[2026-05-01]] — vault-konszolidáció (5 ADR, 15 atomic note, 4. fázis kész)
- [[2026-05-02]] — A.1 (ADR 0008 séma-szint): `permissionSets` + `groupPermissionSets` collection, `requiredGroupSlugs[]` a workflow-ban, hard contract validátor
- [[2026-05-03]] — A.3.6 + Fázis 1 helper-extract (29 retrofit hívás + 6 helper-modul kiszervezés)
- [[2026-05-04]] — B.3 Workflow Extensions Phase 0 szerver-oldal (5 commit: CRUD + snapshot pipeline + harden)
- [[2026-05-05]] — B.4 Workflow Extensions Phase 0 Plugin runtime (Codex 4× review CLEAN); C.0 tervi tisztázás (paralel C.1 GO + light theme stratégia + i18n külön blokk + design-contract sync, Codex GO Verdict); **C.1 Stitch screen-iteráció KÉSZ** (9 desktop screen: Table View v2 / Publication Settings / Flatplan / Workflow Designer 7-state / Workflow Library / Create Publication desktop+mobile / Org Settings / Login flow + Login light variáns demo, Codex 3× review CLEAN)
- [[2026-05-07]] — ADR 0009 (membership user-identity denormalizáció), `change_organization_member_role` CF action (8 védelmi réteg)
- [[2026-05-09]] — Meghívási flow ÉLES (2026-05-08–09 kombinált session: 18 commit, 11 CF deploy) + D blokk follow-up: D.0/D.1.1/D.1.3/D.5.4/D.6.1/D.5.2/D.7 implementáció. [[Komponensek/SessionPreflight]] + [[Komponensek/CFTemplate]] új atomic note-ok
- [[2026-05-11]] — Security audit S blokk kick-off: S.0 (baseline + risk register) + S.1 (proxy hardening) + S.2 (CF rate-limit) + R.S.2.15 mitigated. 5 commit push-olva, 1 lemaradva (Karbantartás.md merge konfliktus). [[Komponensek/SecurityBaseline]] + [[Komponensek/SecurityRiskRegister]] + [[Komponensek/ProxyHardening]] + [[Komponensek/CFRateLimiting]] új atomic note-ok
- [[2026-05-12]] — S.2.5 commit + push + PR [Maestro_Plugin#3](https://github.com/SashalmiImre/Maestro_Plugin/pull/3) + S.7.1 cross-tenant code-audit (Codex pre + stop-time + verifying CLEAN). 8 `createDocument` üres-permission fix `withCreator(buildXxxAclPerms(...), callerId)`-rel a defense-in-depth team-membership-race ellen. Új [[Komponensek/TenantIsolation]] atomic note

## Új daily note
1. Másold a [[Templates/daily-note-template]] tartalmát.
2. Új fájl: `YYYY-MM-DD.md`.
3. Adj sort ehhez az indexhez (vagy ha egy hónapnak több bejegyzése lesz, csoportosítsd havonként).
