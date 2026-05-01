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

## Manuális smoke teszt checklist

> Valós InDesign környezetben végigkattintani — a kód review nem helyettesíti. Periodikusan, release előtt vagy nagyobb refaktor után érdemes futtatni.

- **Happy path** — bejelentkezés → kiadvány kiválasztás → cikk felvétel → megnyitás → szerkesztés → mentés → állapotváltás → bezárás
- **Sleep/wake recovery** — laptop fedél le → 2+ perc → fedél fel → UI konzisztens, Realtime él, adatok frissek
- **Dual-proxy failover** — primary leállítás → fallback átkapcsolás → primary visszajön → automatikus visszakapcsolás
- **Offline → online** — WiFi ki → offline overlay → WiFi be → recovery → nincs dupla fetch, nincs UI ugrás
- **Jogosultsági edge case-ek** — vezető csoport bypass, scope váltás közben állapotváltás, workflow hot-reload UI frissülés

Részletek: [[Döntések/0001-dual-proxy-failover]], [[Komponensek/RecoveryManager]], [[Komponensek/EndpointManager]].
