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
