---
tags: [moc, workflow]
---

# Munkafolyamat & Jogosultságok

## Állapotgép

- [[WORKFLOW_CONFIGURATION|Workflow konfiguráció]] — Állapotok, átmenetek, validációs szabályok (`requiredToEnter`/`requiredToExit`)

## Jogosultságok

- [[WORKFLOW_PERMISSIONS|Jogosultsági rendszer]] — Csapat-alapú állapotátmenet-védelem

### Kétszintű jogosultság

1. **Csapattagság** (`user.teamIds`) — alap jogosultság a munkahelyi pozíció alapján
2. **Label override** (`user.labels`) — plusz jogosultságok adminisztrátori hozzárendeléssel

### Háromszintű védelem

UI gomb `disabled` → handler toast → engine guard.

### UI Elem Jogosultságok

- `ARTICLE_ELEMENT_PERMISSIONS` / `PUBLICATION_ELEMENT_PERMISSIONS` — elemcsoport → csapat tömb
- `checkElementPermission()`, `canUserAccessInState()`, `canEditContributorDropdown()`
- `useElementPermission()` / `useElementPermissions()` hookok

## Validáció

- [[VALIDATION_MECHANISM|Validációs mechanizmus]] — Egységes rendszer + felhasználói validáció

### Validáció típusok

| Típus | Kezelő | Forrás |
|-------|--------|--------|
| Rendszer (Preflight, Overlap) | ValidationContext | Memória, session-önként |
| Felhasználói üzenetek | DataContext | DB, Realtime szinkron |
| Állapotátmenet | StateComplianceValidator | `WORKFLOW_CONFIG` szabályok |
| Mező-szintű | ValidatedTextField | Azonnali, blur-kor |

## Kulcsfogalmak

- **STATE_PERMISSIONS** — Állapot → csapat leképezés (ki mozgathat honnan)
- **TEAM_ARTICLE_FIELD** — Csapat → cikkmező leképezés
- **StateComplianceValidator** — Állapotátmenet-validáció koordinátor
- **WorkflowEngine** — `executeTransition()`, `lockDocument()`, `unlockDocument()`
- **registerTask** minta — aszinkron koordináció documentClosed-nél

## Session preflight

Minden új coding-session **első 5 percében** infra-check kötelező — deploy script-ek, deploy-konfig fájlok, célhost megértése. Részletek + 5 perces parancslista: [[Komponensek/SessionPreflight]]. A 2026-05-09 incident ([[Naplók/2026-05-09]]) okán bevezetett alapelv.

## Codex co-reflection alapelv

Backend / auth / permission / Realtime témákban minden BLOCKER vagy architektúra-szintű döntés ELŐTT és UTÁN konzultálni a Codex-szel (`codex:codex-rescue` subagent). A 2026-05-09 session 11+ Codex stop-time iterációja minden alkalommal valós kockázatot tárt fel — TOCTOU race, customMessage drift, stale session conflict, list pagination regresszió, runtime user-deletion path. A "magamtól írom + push" pattern pontatlanabb 1-2 nagyságrenddel.

**Mikor kötelező**:
- Új CF vagy meglévő CF jelentős átalakítása (lifecycle, race-condition, idempotencia)
- Permission-rendszer (`permissions.js`, slug-bővítés, ACL módosítás)
- Realtime + auth-state interakció (subscribe-flow, debounce, fail-closed)
- Új collection vagy schema-változás
- Session-záráshoz a stop-time review

**Hogyan**: BLOCKER észlelés → pre-review (architecture-szintű kérdés) → implementáció → stop-time review (regresszió-keresés). Mindhárom körre rövid (8-15 mondatos) válasz; NEM mély fix-implementáció.

**Mit ne**: trivial UX-tweak vagy single-line bugfix elé NEM kell Codex.

## Manuális smoke teszt checklist

> Valós InDesign környezetben végigkattintani — a kód review nem helyettesíti. Periodikusan, release előtt vagy nagyobb refaktor után érdemes futtatni.

- **Happy path** — bejelentkezés → kiadvány kiválasztás → cikk felvétel → megnyitás → szerkesztés → mentés → állapotváltás → bezárás
- **Sleep/wake recovery** — laptop fedél le → 2+ perc → fedél fel → UI konzisztens, Realtime él, adatok frissek
- **Dual-proxy failover** — primary leállítás → fallback átkapcsolás → primary visszajön → automatikus visszakapcsolás
- **Offline → online** — WiFi ki → offline overlay → WiFi be → recovery → nincs dupla fetch, nincs UI ugrás
- **Jogosultsági edge case-ek** — vezető csoport bypass, scope váltás közben állapotváltás, workflow hot-reload UI frissülés

Részletek: [[Döntések/0001-dual-proxy-failover]], [[Komponensek/RecoveryManager]], [[Komponensek/EndpointManager]].
