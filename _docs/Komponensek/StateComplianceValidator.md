---
tags: [komponens, plugin, validáció]
aliases: [StateComplianceValidator]
---

# StateComplianceValidator

## Cél
Az **állapotátmenet összes validációját koordinálja**: fájl-létezés, oldalszám, fájlnév, preflight, **workflow extension validátorok** (`ext.<slug>`) — a `workflow.validations[state]` `requiredToEnter` / `requiredToExit` konfig alapján.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/utils/validators/StateComplianceValidator.js`

## Felület (API)
- `validate(context)` → `{ isValid, errors[], warnings[], skipped?, unmountedDrives? }`
  - **Context mezők**: `article`, `workflow`, `targetState`, `publicationRootPath`, `extensions` (extension registry Map — `ext.<slug>` validátorok dispatch-éhez, B.4.2)
- `checkFileAccessible(article, pubRootPath)` — fájl-létezés ellenőrzés (a szerkesztőség gyökerén belül)
- Privát: `_checkPageNumbers`, `_checkFileName`, `_checkPreflight` (delegálás a `PreflightValidator`-nak), `_checkExtensionValidator(slug, article, registry, results)` (B.4.2 — `dispatchExtensionValidator` hívás, fail-closed `[ext.<slug>] ...` prefixált errorral)

## Belső
- **Switch ág beépített validátorokra**: `file_accessible`, `page_number_check`, `filename_verification`, `preflight_check`
- **`default` ág (B.4.2, ADR 0007 Phase 0)**: `isExtensionRef(name)` → `parseExtensionRef` → `_checkExtensionValidator`. Ismeretlen, nem-extension validator név → `logWarn` (a server-oldali workflow compile szűr, ez defense-in-depth)

## Kapcsolatok
- **Hívják**: [[WorkflowEngine]] (`validateTransition`, `executeTransition` — `extensionRegistry` paraméteren át), `validationRunner.validate` (szinkron delegáció)
- **Hívja**: `PreflightValidator.validate`, `isValidFileName`, [[CanonicalPath]] (`toAbsoluteArticlePath`), `doScript` (ExtendScript fájl-létezés check), [[ExtensionRegistry]] `dispatchExtensionValidator`, `isExtensionRef` / `parseExtensionRef` (`maestro-shared/extensionContract`)

## Gotchas
- **ExtendScript `var f = new File(...); f.exists`** — InDesign-ben futtatódik, timeout-ok lehetségesek (ha a megosztott meghajtó lassan reagál)
- **`unmountedDrives` flag**: lemount-olt mappáknál az export kihagyva, de az állapotváltás NEM blokkolt — warning toast jelenik meg, és a felhasználó eldöntheti, hogy újramountolja-e
- **Hiányzó `extensions` registry**: ha az `extensions` context mező `null` / hiányzik, az `ext.<slug>` validator fail-closed `[ext.<slug>] ...` errort ad — a state-átmenet bukik

## Kapcsolódó
- [[WorkflowEngine]], [[CanonicalPath]], [[ValidationContext]], [[ExtensionRegistry]]
- [[Munkafolyamat]]
- [[Döntések/0007-workflow-extensions]]
