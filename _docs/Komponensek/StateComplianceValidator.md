---
tags: [komponens, plugin, validáció]
aliases: [StateComplianceValidator]
---

# StateComplianceValidator

## Cél
Az **állapotátmenet összes validációját koordinálja**: fájl-létezés, oldalszám, fájlnév, preflight — a `workflow.validations[state]` `requiredToEnter` / `requiredToExit` konfig alapján.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/utils/validators/StateComplianceValidator.js:1–183`

## Felület (API)
- `validate(context)` → `{ isValid, errors[], warnings[], skipped?, unmountedDrives? }`
- `checkFileAccessible(article, pubRootPath)` — fájl-létezés ellenőrzés (a szerkesztőség gyökerén belül)
- Privát: `_checkPageNumbers`, `_checkFileName`, `_checkPreflight` — delegálás a `PreflightValidator`-nak

## Kapcsolatok
- **Hívják**: [[WorkflowEngine]] (`validateTransition`), `validationRunner.validate` (szinkron delegáció)
- **Hívja**: `PreflightValidator.validate`, `isValidFileName`, [[CanonicalPath]] (`toAbsoluteArticlePath`), `doScript` (ExtendScript fájl-létezés check)

## Gotchas
- **ExtendScript `var f = new File(...); f.exists`** — InDesign-ben futtatódik, timeout-ok lehetségesek (ha a megosztott meghajtó lassan reagál)
- **`unmountedDrives` flag**: lemount-olt mappáknál az export kihagyva, de az állapotváltás NEM blokkolt — warning toast jelenik meg, és a felhasználó eldöntheti, hogy újramountolja-e

## Kapcsolódó
- [[WorkflowEngine]], [[CanonicalPath]], [[ValidationContext]]
- [[Munkafolyamat]]
