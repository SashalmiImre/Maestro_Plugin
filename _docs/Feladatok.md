---
aliases: [TODO, Tasks, Teendők]
tags: [feladatok]
---

# Feladatok

> Ide gyűjtsd a fejlesztési ötleteket, bugokat, teendőket. A Claude Code is olvassa — megbeszéljük, majd kipipáljuk.

## Aktív

### Dashboard finomítás (webes felület)

> Workflow: 1 bullet = 1 commit, utána kipipálás. A témakörök sorrendben haladhatók, de C és D függetlenek.

#### A. Breadcrumbs viselkedés

- [x] 23. **„Beállítások" menüpont áthelyezés**: első listaelemként, ikon nélkül, a többi menüponttal azonos stílusban. A beállítás utáni divider marad (vizuális elválasztás a lista többi részétől).
- [x] 24. **Aktív elem eltávolítása a listából**: a breadcrumb dropdown ne tartalmazza a már kiválasztott elemet (a trigger gombon már látszik a neve).
- [x] 25. **„+ Új …" menüpont eltávolítása mindhárom breadcrumb dropdown-ból** (szervezet, szerkesztőség, kiadvány). A létrehozás a megfelelő beállítás panelre költözik (26, 28).

#### B. Szervezet beállítás panel (OrganizationSettingsModal tab-osítás)

- [x] 26. **Általános tab**: szervezet név szerkesztése + „Új szerkesztőség" gomb (modal a létrehozáshoz) + szervezet törlés (DangerZone).
- [x] 27. **Felhasználók tab**: aktuális invite flow + függő meghívók + szervezeti tagok listája ide költöztetve.

#### C. Szerkesztőség beállítás panel (EditorialOfficeSettingsModal tab-osítás)

- [x] 28. **Általános tab**: szerkesztőség név szerkesztése + „Új kiadvány" gomb (a jelenlegi CreatePublicationModal rootPath nélküli változatával, ld. 31) + szerkesztőség törlés.
- [x] 29. **Csoportok tab**: csoport CRUD (létrehozás, átnevezés, törlés) + tag×csoport mátrix + csoportok jogosultság-sablon placeholder (a konkrét jogosultságok modelt később pontosítjuk).
    - Szerver oldal: új CF-ek (`create_group`, `rename_group`, `delete_group`) a meglévő invite-to-organization CF mintájára.
    - Validáció: csoport törlésnél a workflow-k `compiled.elementPermissions` orphan entry-jei tisztítandók vagy visszautasítva (ha a csoport használatban van).
- [x] 30. **Workflow tab**: workflow-k listája, tervező megnyitás, új workflow létrehozása, átnevezés, „más néven mentés" (duplikáció), láthatóság (`visibility` enum 2-way MVP: `organization` / `editorial_office`) + `createdBy` user FK. Schema bootstrap (`bootstrap_workflow_schema` CF action). Delete blocking scan a hivatkozó publikációkra. Plugin 2-way `Query.or` fetch + Realtime `isVisible` szűrés. (`public`/`private` érték halasztva: külön iterációban jöhet, ha felmerül az igény.)

#### D. Kiadvány beállítás panel & Plugin rootPath flow

- [x] 31. **Dashboard — rootPath opcionális**: `CreatePublicationModal` rootPath mezője opcionális. A `publications` collection rootPath mező nullable (schema frissítés + `validate-publication-update` szerver-oldali engedékenység).
- [ ] 32. **Szerver — `set-publication-root-path` CF**: új Appwrite Function, amely kizárólag null-ról nem-null kanonikus formátumra engedi a rootPath írást. Kanonikus validáció + office-scope check + caller jogosultság (min. office admin).
- [ ] 33. **Plugin — DataContext**: a `publications` query nem szűri ki a rootPath nélküli aktív publikációkat. Új UI állapot: „konfiguráció szükséges" kiadvány (letiltott cikk műveletek, figyelmeztető banner).
- [ ] 34. **Plugin — folder picker modal**: UXP `storage.localFileSystem.getFolder()` alapú folder picker, a kiválasztott natív útvonal `toCanonicalPath()`-on átkonvertálva, majd `set-publication-root-path` CF hívás. Cross-platform MOUNT_PREFIX validáció.
- [ ] 35. **Dashboard — rootPath panel (r/o)**: `GeneralTab` mutassa a rootPath-t read-only-ban, jelezze, ha még nincs beállítva („Beállítva a Pluginból …").

#### E. Workflow snapshot aktiváláskor

- [ ] 36. **Publications schema**: új `compiledWorkflowSnapshot` string mező (JSON). Schema migráció.
- [ ] 37. **Aktiválás CF**: `validate-publication-update` (vagy dedikált `activate-publication` CF) aktiváláskor beolvassa a workflow `compiled` mezőjét és a publikációba írja (snapshot). Továbbiakban a mező immutable.
- [ ] 38. **Plugin — snapshot preferálás**: `DataContext` workflow feloldás preferáltan a `compiledWorkflowSnapshot`-ból (ha van), fallback a `workflowId` → `workflows[]` cache-re (legacy publikációk).
- [ ] 39. **Dashboard — designer guard**: ha egy workflow-t már snapshot-oltak legalább egy aktív publikációhoz, a designer figyelmeztet, hogy a változás csak új aktiválásoknál érvényesül.

#### F. User avatar menü bővítés (globális szint)

- [ ] 40. **„Új szervezet…" menüpont** a user avatar dropdown-ban: modal-os create flow (név + slug). Jelenlegi `bootstrap_organization` CF újrahasznosítása.
- [ ] 41. **„Maestro beállítások" menüpont**: modal, benne: saját szervezetek listája (váltás/kilépés), függőben lévő invite-ok (fogadás/elutasítás).

### Manuális smoke test checklist

> Valós InDesign környezetben végigkattintani — a kód review nem helyettesíti.

- [ ] 18. **Happy path** — bejelentkezés → kiadvány kiválasztás → cikk felvétel → megnyitás → szerkesztés → mentés → állapotváltás → bezárás
- [ ] 19. **Sleep/wake recovery** — laptop fedél le → 2+ perc → fedél fel → UI konzisztens, Realtime él, adatok frissek
- [ ] 20. **Dual-proxy failover** — primary leállítás → fallback átkapcsolás → primary visszajön → automatikus visszakapcsolás
- [ ] 21. **Offline → online** — WiFi ki → offline overlay → WiFi be → recovery → nincs dupla fetch, nincs UI ugrás
- [ ] 22. **Jogosultsági edge case-ek** — vezető csoport bypass, scope váltás közben állapotváltás, workflow hot-reload UI frissülés

---

## Kész

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
- [x] 10. **maestro-shared/** — workflowRuntime, constants, urgency, pageGapUtils, contributorHelpers

### Cross-module interakciók (a modul-harden UTÁN)

> A harden modul-határokon belül dolgozik — a kritikus bugok viszont a modulok *között* élnek.

- [x] 11. **Recovery lánc** — RecoveryManager → realtimeClient → DataContext.fetchData → ConnectionContext állapotátmenetek egységben
- [x] 12. **Optimistic update konzisztencia** — applyArticleUpdate ↔ Realtime handler ↔ $updatedAt elavulás-védelem ↔ fetchGenerationRef — az összes írási útvonal együtt
- [x] 13. **Auth + Scope lánc** — UserContext (login/session/groupSlugs) → ScopeContext (auto-pick/stale ID) → DataContext (scope-szűrt fetch) → Realtime scope szűrés
- [x] 14. **Workflow átmenet teljes útvonal** — UI gomb → workflowPermissions → workflowEngine.executeTransition → StateComplianceValidator → callUpdateArticleCF → Realtime visszacsatolás

### Race condition audit

> Async timing problémák célzott keresése — statikus review-val nehezen megfogható hibák.

- [x] 15. **Párhuzamos fetch + recovery** — fetchGenerationRef + isReconnecting guard + debounce végpont együttes viselkedése gyors egymás utáni triggerek esetén (sleep + focus + online egyszerre)
- [x] 16. **Realtime burst** — layoutChanged / publicationCoverageChanged debounce + articlesAdded event payload (React state batching megkerülés) — szimulált burst szcenáriók
- [x] 17. **Lock race** — optimistic SYSTEM lock → DB lockDocument → Realtime update → unlock registerTask — mi történik ha közben publication switch vagy recovery fut
