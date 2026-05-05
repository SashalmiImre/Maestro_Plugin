---
tags: [komponens, plugin, workflow, extensions, runtime]
aliases: [ExtensionRegistry, extensionRegistry, buildExtensionRegistry, dispatchExtensionValidator, dispatchExtensionCommand]
---

# ExtensionRegistry

## Cél
**Workflow extension Plugin-runtime registry** — az aktivált publikáció `compiledExtensionSnapshot` JSON-jából `Map<slug, { name, kind, scope, code }>`-ot épít, `ext.<slug>` hivatkozásokat felold, és ExtendScripten futtatja a `maestroExtension(input)` függvényt JSON I/O-val. Phase 0 / ADR 0007.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js`
- **Shared kontraktus**: `packages/maestro-shared/extensionContract.js` (`isExtensionRef`, `parseExtensionRef`, `EXTENSION_KIND_VALUES`)

## Felület (API)
- `buildExtensionRegistry(snapshot)` → `Map<slug, { name, kind, scope, code }>` — JSON-string vagy parsed objekt bemenetet fogad, fail-closed üres Map-ot ad vissza top-level hibára. Per-entry shape hiba (hiányzó/üres `code`, ismeretlen `kind`, nem-objekt) → `logWarn` + entry skip, többi entry tovább betölt (best-effort).
- `resolveExtension(registry, slug, expectedKind?)` → `{ ok: true, ext }` vagy `{ ok: false, code: 'no_registry' | 'unknown_slug' | 'kind_mismatch', slug, detail? }`
- `dispatchExtensionValidator(registry, slug, input)` → `{ isValid, errors[], warnings[] }` — validator kind dispatch, fail-closed `[ext.<slug>] ...` prefixált errorral hibára. Input: `{ article, options? }`.
- `dispatchExtensionCommand(registry, slug, input)` → `{ success, error?, message? }` — command kind dispatch, ugyanazon prefixed-error mintával. Input: `{ article, options?, publicationRoot }`.

## Belső
- **Snapshot-only stratégia (Phase 0)**: a Plugin csak `isActivated === true` publikációt lát; a snapshot kanonikus + immutable (a server-oldali `validate-publication-update` CF §5c-A guardja deaktiválja a snapshot nélkül direktben aktivált pubot). Live `workflowExtensions` cache NINCS.
- **ExtendScript futtatás (`buildExtensionExtendScript`)**: hex-encoded JSON input → fromHex → JSON.parse → user `maestroExtension(input)` hívás → `{ ok, value | error }` envelope. **Host hygiene boundary**: `app.scriptPreferences.userInteractionLevel = NEVER_INTERACT` snapshot + finally-restore — modális dialóg fagyasztás védelme.
- **Biztonság**: a snapshot `code` mezőjét a server-oldali `acorn` ECMA3 pre-parse + AST top-level `FunctionDeclaration` `id.name === 'maestroExtension'` ellenőrzés engedélyezte (B.3.1/B.3.2). Sandbox NINCS — ExtendScripten belül a globál névtér megosztott; a kontraktus része, hogy a kódot az office admin által kontrollált Designer adja.
- **Phase 0 hatókör-szűkítés (B.0.4)**: a per-workflow `options` ÜRES / nem továbbított — a JSON I/O `options?` mezője Phase 1+-ban válik élessé.
- **Defense-in-depth shape-check** (parse után): ismeretlen `kind`, hiányzó `code`, nem-objekt entry → entry skip + logWarn (a meta-üzenetet a server is szűri B.3.3 `buildExtensionSnapshot`-ban; ez Phase 0 redundáns biztonság).

## Phase 0 invariáns (konzisztencia-ablak)
A server-oldali `validate-publication-update` post-write revert + Plugin Realtime fetch közötti race-ből fakad: egy aktivált publikáció rövid ideig (~1-2s, dual-proxy failover alatt akár hosszabb) látszhat hiányzó vagy stale `compiledExtensionSnapshot`-tal. Ilyenkor az `ext.<slug>` dispatch fail-closed `unknown_slug` (üres registry) → a state-átmenet `[ext.<slug>] extension nem található a snapshot-ban` hibával bukik. Operationally: a felhasználó újrapróbálja a transition-t a következő Realtime ciklus után. Phase 1+ `workflowExtensions` Realtime fallback ezt az ablakot lezárhatja.

## Kapcsolatok
- **Hívják**: [[DataContext]] (`buildExtensionRegistry` a `useMemo` derived state-ben), [[StateComplianceValidator]] (`dispatchExtensionValidator` a `_checkExtensionValidator`-ból), `commands/index.js` `executeCommand` (`dispatchExtensionCommand` az `ext.<slug>` ágon)
- **Hívja**: `executeScript` ([[InDesignUtils]]), `extensionContract.js` (`EXTENSION_KIND_VALUES`, `isExtensionRef`, `parseExtensionRef`), [[Logger]]
- **Eseményei**: nincs direkt dispatch — a [[MaestroEvent#Workflow extension eseményei B.4.3, ADR 0007 Phase 0|`workflowExtensionsChanged` event]]-et a [[DataContext]] Realtime handler dispatcheli (Phase 0-ban consumer NINCS)

## Gotchas
- **Astral plane karakterek**: a `toHex` 4-hex-digit / UTF-16 code unit kódolás a surrogate pár mindkét felével konzisztensen átmegy — egy karakter magasabb code point-ról (pl. emoji) nem törik el az ExtendScript hex-decode-on át.
- **Object.prototype.hasOwnProperty.call**: defensive — a user-kód visszaadhat `{ hasOwnProperty: 'x' }`-et, ami felülírja a saját metódust és `v.hasOwnProperty(k)` crash-elne. Ezért `Object.prototype.hasOwnProperty.call(v, k)` a kézi JSON-szerializerben.
- **Top-level user-kód runtime exception**: a host hygiene boundary `try / finally` blokkja restore-olja a `userInteractionLevel`-t happy path, exec_error és top-level user-kód runtime exception esetén is — fagyasztás védelem.
- **`paramSchema` halasztva Phase 1+-ba**: a Designer `ValidationListField` / `CommandListField` az ismeretlen `options` mezőt eldobja, így Phase 0-ban a `maestroExtension(input)` `options` kulcsa MVP-ben üres / nincs továbbítva.

## Kapcsolódó
- [[DataContext]], [[StateComplianceValidator]], [[WorkflowEngine]], [[MaestroEvent]]
- [[Munkafolyamat]]
- [[Döntések/0007-workflow-extensions]]
