---
title: B.6 — Workflow Extensions smoke teszt
status: Active
created: 2026-05-05
related: [[Döntések/0007-workflow-extensions]], [[Feladatok]]
---

# B.6 — Workflow Extensions smoke teszt (ADR 0007 Phase 0)

> A B.6 smoke teszt két részből áll:
> - **B.6.1**: end-to-end (Dashboard → Server → Plugin) — manuális checklist
> - **B.6.2**: snapshot-védelmi invariáns — kódszintű bizonyítás + automatizált logikai script + opcionális live ellenőrzés
>
> Approach: hibrid (Codex 2026-05-05 konzultáció). A teljes end-to-end manuális, mert a Plugin futás InDesign UXP környezetet igényel; a snapshot-only invariáns ettől függetlenül logikai szinten lokálisan igazolható.

## Előfeltételek

- A B.5 KÉSZ — Dashboard "Bővítmények" tab + Workflow Designer `ext.<slug>` chip integráció + Plugin runtime extension registry deploy-olva.
- Élő Appwrite project (Railway primary endpoint), CF-ek deploy-olva — `bootstrap_workflow_extension_schema` action egyszer lefuttatva, a `workflowExtensions` collection `rowSecurity: true` és a globális `read("users")` ACL eltávolítva.
- Test office org owner-rel + min. 1 admin userrel + 1 író userrel (vagy ugyanaz, role-onként megfelelő jogosultsággal).
- Egy aktivált, deadline-okkal teljesen lefedett **és** legalább 1 cikkel bíró publikáció (vagy szabadon létrehozható).
- InDesign elérhető Mac/Windows hoston, Plugin betöltve (`npm run uxp:load`).

## B.6.1 — End-to-end manuális checklist

> Cél: egy újonnan írt extension egészen a Plugin runtime futásáig eljusson, és valódi hatása legyen egy state-átmenet eredményén.

### Lépés 1 — Extension létrehozás (Dashboard)

- [ ] Bejelentkezés a Dashboard-ba mint office admin.
- [ ] Editorial Office Settings → **Bővítmények** tab → "+" gomb (a gomb csak `extension.create` jogú user-nek látszik).
- [ ] Új validator extension:
  - Név: `Smoke validator`
  - Slug: `smoke-validator`
  - Kind: `validator`
  - Kód: `function maestroExtension(input){ return { isValid: false, errors: ['Smoke teszt — szándékosan blokkol'], warnings: [] }; }`
- [ ] Mentés. Várt: a kártya megjelenik a tab listájában, "Aktív" állapotban.
- [ ] Új command extension hasonló módon:
  - Slug: `smoke-command`, Kind: `command`
  - Kód: `function maestroExtension(input){ return { success: true, message: 'Smoke teszt — command lefutott' }; }`

### Lépés 2 — Workflow hivatkozás (Designer)

- [ ] Dashboard → Workflow Designer → válassz egy a smoke teszthez használt workflow-t (vagy duplikálj egy default-ot `smoke-test` névvel).
- [ ] Egy köztes állapot (pl. `editing`) `requiredToExit` listájához add hozzá az `ext.smoke-validator` chipet.
- [ ] Ugyanezen az állapoton a `commands` listához add hozzá `ext.smoke-command`-ot egy contributor csoporttal (pl. `editors`).
- [ ] Mentés. Várt: a Designer save-time validáció átmegy (a `parseExtensionRef` felismeri a slug-okat, a chip-ek `--extension` (dashed border) variánssal renderelnek).

### Lépés 3 — Publikáció aktiválás

- [ ] Editorial Office Settings → ennek a workflow-nak a hozzárendelése egy publikációhoz (`assign_workflow_to_publication`).
- [ ] Publication Settings → Aktiválás (`activate_publication`).
- [ ] Várt:
  - 200 OK
  - Publication payload `compiledExtensionSnapshot` mezője nem üres (Appwrite Console ellenőrizhető) — tartalmazza a 2 extension-t a `code` mezővel együtt.
  - `compiledWorkflowSnapshot` is rögzült.

### Lépés 4 — Plugin futtatás (InDesign)

- [ ] InDesign indítás → Plugin betöltés → bejelentkezés ugyanazzal a userrel.
- [ ] Az aktivált publikáció válassza ki, válts az érintett cikkre (amelyik `editing` state-ben van).
- [ ] **Validator teszt**: kísérelj meg egy state-átmenetet, amelyik az `editing`-ből kifelé visz (`requiredToExit` aktív).
  - Várt: a state-átmenet blokkolódik, a Plugin toast-ja `[ext.smoke-validator] Smoke teszt — szándékosan blokkol` szövegű (a prefix a Plugin runtime adja, ld. `extensionRegistry.js:411`).
- [ ] **Command teszt**: módosítsd a smoke-validator kódját úgy, hogy `isValid: true`-t adjon, deaktiváld + reaktiváld a publikációt (új snapshot rögzül). Próbáld ki a `Smoke command`-ot a contributor csoporton keresztül a Plugin parancslistájából.
  - Várt: toast `Smoke teszt — command lefutott`. A `dispatchExtensionCommand` az ExtendScript IIFE-be csomagolt user kódot az ExtendScript host-on futtatja, JSON I/O envelope-ban (ld. `extensionRegistry.js:193`).

### Lépés 5 — Eredmény rögzítés

- [ ] Sikertelen pontoknál naplózd a fail-okat ide vagy egy `_docs/Naplók/YYYY-MM-DD.md` daily note-ba; a B.6.1 csak akkor pipálható ki a `_docs/Feladatok.md`-ben, ha minden lépés átment.

## B.6.2 — Snapshot-védelmi invariáns

### a) Kódszintű bizonyítás

A snapshot-only invariáns négy védelmi pontból áll össze; a futási pályán mindenhol fail-closed:

| # | Védelem | Hely |
|---|---|---|
| 1 | A direkt aktiválás (REST hívás `isActivated:true`-val a server-guard kerülésével) deaktivál + a 4 mező (`isActivated`, `activatedAt`, `compiledWorkflowSnapshot`, `compiledExtensionSnapshot`) null-ra kerül | [packages/maestro-server/functions/validate-publication-update/src/main.js:451](packages/maestro-server/functions/validate-publication-update/src/main.js) §5c-A |
| 2 | Legacy aktivált pub `compiledExtensionSnapshot` null/üres → deaktiválás (`activate_publication` action-en keresztüli újraindítás kötelező) | [packages/maestro-server/functions/validate-publication-update/src/main.js:529](packages/maestro-server/functions/validate-publication-update/src/main.js) §5c-B |
| 3 | A snapshot-mezők kliens-oldali írása (akár `compiledWorkflowSnapshot`, akár `compiledExtensionSnapshot`) → mindkettő null + deaktiválás | [packages/maestro-server/functions/validate-publication-update/src/main.js:629](packages/maestro-server/functions/validate-publication-update/src/main.js) §6b |
| 4 | A Plugin runtime registry KIZÁRÓLAG az aktivált publikáció `compiledExtensionSnapshot`-jából épül (`useMemo` deps `$id` + snapshot-string) — live `workflowExtensions` cache nincs | [packages/maestro-indesign/src/core/contexts/DataContext.jsx:571](packages/maestro-indesign/src/core/contexts/DataContext.jsx) + [packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js:71](packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js) |

A `workflowExtensionsChanged` Realtime event Phase 0-ban consumer nélküli (no-op runtime, [DataContext.jsx:1155](packages/maestro-indesign/src/core/contexts/DataContext.jsx)) — a kapu jövőbeli Designer plugin tab vagy non-snapshot fallback számára nyitva.

### b) Automatizált logikai invariáns

Helyileg, externál függőség nélkül futtatható:

```bash
node scripts/b6-snapshot-invariant.mjs
```

11 szakasz, 31 assert — verifikálja a `buildExtensionRegistry` + `resolveExtension` snapshot-only invariánsát:
- A registry szigorúan a snapshot stringből épül; egy "live" extension v2 mutáció nem szivárog be.
- Fail-closed ágak: null/üres/malformed JSON/tömb-snapshot → 0 entry, lookup `unknown_slug`.
- Per-entry shape skip — hibás entry nem szennyezi a többit.
- `kind_mismatch` detektálás (validatort command-ként kérve).
- `no_registry` ág a hibás regisztry-átadásra (null, undefined, plain object, array — nem Map).

A script **logikai másolata** a kanonikus `extensionRegistry.js`-nek (a `maestro-shared/package.json` nem deklarál `type: "module"`-t, ezért a `.js` ESM fájlok Node-ESM-ben nem importálhatók közvetlenül). Ha a kanonikus változik, a scriptet is frissíteni kell — a fájl-fejléc kommentje pointer-rel jelzi.

### c) Opcionális live ellenőrzés (nagy értékű, de InDesign-igényes)

A kódszintű bizonyítás + a logikai invariáns megerősítését érdemes egyszer élesben is futtatni:

- [ ] B.6.1 1-3. lépésével aktiválj egy publikációt egy `ext.smoke-validator` referenciával (a validator kódja `isValid:true`-t ad, hogy ne blokkoljon).
- [ ] Editorial Office Settings → Bővítmények tab → írd át a `smoke-validator` kódját úgy, hogy `isValid:false` legyen (ez a "live edit").
- [ ] InDesign Plugin → ne csinálj reload-ot, NE deaktiváld a publikációt → próbálj egy state-átmenetet.
- [ ] **Várt**: a state-átmenet sikeres (a snapshot v1 `isValid:true`-ja érvényes), a live v2 nem fut. A Plugin toast vagy dev-console nem mutat `[ext.smoke-validator] ...` errort.
- [ ] Ezután deaktiváld + reaktiváld a publikációt → új snapshot rögzül a v2 kóddal → a következő próbálkozás már blokkolódik.

## Ismert vakfoltok / Phase 0 megegyezések

- **Phase 0 konzisztencia-ablak** ([extensionRegistry.js:21](packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js)): a `validate-publication-update` post-write revert + Plugin Realtime fetch közötti race-ből egy aktivált pub rövid ideig (~1-2s, dual-proxy failover alatt akár több) látszhat hiányzó/stale `compiledExtensionSnapshot`-tal — ilyenkor az `ext.<slug>` dispatch fail-closed `unknown_slug` (üres registry). A felhasználó újrapróbálja a state-átmenetet a következő Realtime ciklus után.
- **ExtendScript host-specifikus eltérések**: a Node-script nem fedi le az ExtendScript runtime-ot (Annex B FunctionDeclaration hoist, JSI kompatibilitás, `app.scriptPreferences.userInteractionLevel` boundary). Ezt a B.4.4 sablon külön kezeli `missing_maestro_extension_function` fail-closed ággal.
- **CF deploy / Appwrite Realtime késleltetés**: nem fedi a `node` script (egyik invariáns sem). A live ellenőrzés mutatja meg.
- **Hex bandwidth amplification**: minden dispatch ~4× méretarányt jelent input-on (UTF-16 → 4 hex digit / char). Phase 0 tipikus `{article}` payload <10 KB, de több ext-validátoros átmenet érzékelhető latency-t adhat. Phase 1+ optimalizálás (shared-state binding) a tervben.
