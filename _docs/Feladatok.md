---
aliases: [TODO, Tasks, Teendők]
tags: [feladatok]
---

# Feladatok

> Ide gyűjtsd a fejlesztési ötleteket, bugokat, teendőket. A Claude Code is olvassa — megbeszéljük, majd kipipáljuk.

## Aktív

### Harden — Teljes projekt átvizsgálás (modulonként)

> **Workflow minden pontnál:**
> 1. `/roast` elemzés az adott modulra (kockázatok, overengineering, edge case-ek)
> 2. Kérdések tisztázása
> 3. `/harden` futtatás
> 4. ✅ Kipipálás

- [x] 1. **core/config/** — appwriteConfig, realtimeClient, recoveryManager, maestroEvents
- [x] 2. **core/utils/ (infra)** — logger, errorUtils, pathUtils, promiseUtils, constants, messageConstants
- [x] 3. **core/utils/workflow/** — workflowEngine, workflowPermissions
- [x] 4. **core/utils/validators/** — ValidatorBase, összes validator, validationRunner
- [x] 5. **core/utils/indesign/** — ExtendScript generátorok, scriptHelpers, indesignUtils
- [x] 6. **core/contexts/** — DataContext, UserContext, ValidationContext, ConnectionContext, ScopeContext
- [x] 7. **data/hooks/** — useArticles, useOverlapValidation, useUnifiedValidation, useElementPermission, stb.
- [x] 8. **ui/features/** — articles, publications, workspace komponensek
- [x] 9. **ui/common/** — CollapsibleSection, ConfirmDialog, ValidatedTextField, Table, Toast
- [ ] 10. **maestro-shared/** — workflowRuntime, constants, urgency, pageGapUtils, contributorHelpers

### Cross-module interakciók (a modul-harden UTÁN)

> A harden modul-határokon belül dolgozik — a kritikus bugok viszont a modulok *között* élnek.

- [ ] 11. **Recovery lánc** — RecoveryManager → realtimeClient → DataContext.fetchData → ConnectionContext állapotátmenetek egységben
- [ ] 12. **Optimistic update konzisztencia** — applyArticleUpdate ↔ Realtime handler ↔ $updatedAt elavulás-védelem ↔ fetchGenerationRef — az összes írási útvonal együtt
- [ ] 13. **Auth + Scope lánc** — UserContext (login/session/groupSlugs) → ScopeContext (auto-pick/stale ID) → DataContext (scope-szűrt fetch) → Realtime scope szűrés
- [ ] 14. **Workflow átmenet teljes útvonal** — UI gomb → workflowPermissions → workflowEngine.executeTransition → StateComplianceValidator → callUpdateArticleCF → Realtime visszacsatolás

### Race condition audit

> Async timing problémák célzott keresése — statikus review-val nehezen megfogható hibák.

- [ ] 15. **Párhuzamos fetch + recovery** — fetchGenerationRef + isReconnecting guard + debounce végpont együttes viselkedése gyors egymás utáni triggerek esetén (sleep + focus + online egyszerre)
- [ ] 16. **Realtime burst** — layoutChanged / publicationCoverageChanged debounce + articlesAdded event payload (React state batching megkerülés) — szimulált burst szcenáriók
- [ ] 17. **Lock race** — optimistic SYSTEM lock → DB lockDocument → Realtime update → unlock registerTask — mi történik ha közben publication switch vagy recovery fut

### Manuális smoke test checklist

> Valós InDesign környezetben végigkattintani — a kód review nem helyettesíti.

- [ ] 18. **Happy path** — bejelentkezés → kiadvány kiválasztás → cikk felvétel → megnyitás → szerkesztés → mentés → állapotváltás → bezárás
- [ ] 19. **Sleep/wake recovery** — laptop fedél le → 2+ perc → fedél fel → UI konzisztens, Realtime él, adatok frissek
- [ ] 20. **Dual-proxy failover** — primary leállítás → fallback átkapcsolás → primary visszajön → automatikus visszakapcsolás
- [ ] 21. **Offline → online** — WiFi ki → offline overlay → WiFi be → recovery → nincs dupla fetch, nincs UI ugrás
- [ ] 22. **Jogosultsági edge case-ek** — vezető csoport bypass, scope váltás közben állapotváltás, workflow hot-reload UI frissülés

---

## Kész


