/**
 * @fileoverview Workflow extension Plugin runtime regisztry (B.4.1 + B.4.4 — ADR 0007 Phase 0).
 *
 * Feladat:
 *  1. Az aktivált publikáció `compiledExtensionSnapshot` JSON-ját parse-olja
 *     `Map<slug, { name, kind, scope, code }>` formába.
 *  2. `ext.<slug>` hivatkozást felold a regisztryből (validator vagy command kind-ra).
 *  3. ExtendScript-en futtatja a `maestroExtension(input)` globál függvényt JSON I/O-val,
 *     `{ ok, value | error }` envelope-ban.
 *  4. Az eredményt a JSON I/O kontraktusra normálja (validator → `{isValid, errors[],
 *     warnings[]}`; command → `{success, error?, message?}`).
 *
 * **Snapshot-only stratégia (Phase 0)**: a Plugin csak `isActivated === true` publikációt
 * lát, és azon a snapshot kanonikus + immutable (`validate-publication-update` CF §5c-A
 * guardja deaktiválja a snapshot nélkül direktben aktivált pubot). Live `workflowExtensions`
 * cache NINCS — a B.4.3 Realtime channel jövőbeli consumer (Designer plugin tab vagy non-snapshot
 * fallback) számára szól, a runtime registry a snapshotból épül.
 *
 * **Phase 0 invariáns** (Codex harden adversarial High dokumentációs fix): vállalt
 * konzisztencia-ablak a server-oldali `validate-publication-update` post-write revert
 * + Plugin Realtime fetch közötti race-ből fakad — egy aktivált publikáció rövid ideig
 * (~1-2s, dual-proxy failover alatt akár hosszabb) látszhat hiányzó vagy stale
 * `compiledExtensionSnapshot`-tal. Ilyenkor az `ext.<slug>` dispatch fail-closed
 * `unknown_slug` (üres registry) → a state-átmenet `[ext.<slug>] extension nem található
 * a snapshot-ban` hibával bukik. Operationally a felhasználó újrapróbálja a transition-t
 * a következő Realtime ciklus után (a `compiledWorkflowSnapshot` minta — ld. Feladat #38 —
 * azonos paraméterekkel él, és a workflow-runtime cikk-validáció ezt vállalt UX
 * kompromisszumként kezeli). Phase 1+ `workflowExtensions` Realtime fallback ezt a
 * részleges-konzisztencia ablakot lezárhatja.
 *
 * **Phase 0 hatókör-szűkítés (B.0.4)**: a per-workflow `options` üres / nem továbbított
 * — a JSON I/O `options?` mezője Phase 1+-ban válik élessé.
 *
 * **Biztonság**: a snapshot `code` az `acorn` ECMA3 pre-parse + AST top-level
 * `FunctionDeclaration` `id.name === 'maestroExtension'` ellenőrzés után került be a B.3.1/B.3.2
 * CF write-path-ban. Sandbox NINCS — ExtendScript-en belül a globál névtér megosztott;
 * a kontraktus része, hogy a kódot az office admin által kontrollált Designer adja.
 *
 * @module utils/extensions/extensionRegistry
 */

import { executeScript } from "../indesign/indesignUtils.js";
import {
    EXTENSION_KIND_VALUES
} from "maestro-shared/extensionContract.js";
import { log, logError, logWarn, logDebug } from "../logger.js";

/** Üres registry — minden lookup `unknown_slug`-ot ad. */
const EMPTY_REGISTRY = new Map();

// ── 1. Registry build ───────────────────────────────────────────────────────

/**
 * `compiledExtensionSnapshot` JSON-stringből registry Map.
 *
 * **Fail-closed szintek**:
 *  - Top-level JSON parse hiba / nem-objekt struktúra → üres Map + logError (a registry
 *    egészét eldobjuk; az `ext.<slug>` lookup `unknown_slug`-ot ad).
 *  - Per-entry shape hiba (hiányzó/üres `code`, ismeretlen `kind`, nem-objekt entry)
 *    → az adott entry átugorva + logWarn; a többi entry továbbra is betöltődik
 *    (egy korrupt slug ne dobja el a többi extension-t — best-effort).
 *
 * Az aktivált publikáción a snapshot már server-validált (B.3.3 `buildExtensionSnapshot`
 * kind-konzisztencia invariáns), így a per-entry skip a gyakorlatban nem fog tüzelni;
 * a Plugin defense-in-depth shape-checket fut a parse után.
 *
 * @param {string|object|null|undefined} snapshot - a publication.compiledExtensionSnapshot
 *   nyers értéke (string Realtime-ról jön, parse-olt ha már lett)
 * @returns {Map<string, { name: string, kind: string, scope: string, code: string }>}
 */
export function buildExtensionRegistry(snapshot) {
    if (!snapshot) return EMPTY_REGISTRY;

    let parsed;
    try {
        parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    } catch (err) {
        logError("[extensionRegistry] compiledExtensionSnapshot JSON parse hiba:", err);
        return EMPTY_REGISTRY;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logError("[extensionRegistry] compiledExtensionSnapshot nem objekt-szerkezet:", typeof parsed);
        return EMPTY_REGISTRY;
    }

    const registry = new Map();
    for (const slug of Object.keys(parsed)) {
        const ext = parsed[slug];
        if (!ext || typeof ext !== 'object') {
            logWarn(`[extensionRegistry] Hibás extension entry (${slug}): nem objekt`);
            continue;
        }
        if (typeof ext.code !== 'string' || ext.code.length === 0) {
            logWarn(`[extensionRegistry] Hibás extension entry (${slug}): hiányzó code`);
            continue;
        }
        if (!EXTENSION_KIND_VALUES.includes(ext.kind)) {
            logWarn(`[extensionRegistry] Hibás extension entry (${slug}): ismeretlen kind=${ext.kind}`);
            continue;
        }
        registry.set(slug, {
            name: typeof ext.name === 'string' ? ext.name : slug,
            kind: ext.kind,
            scope: typeof ext.scope === 'string' ? ext.scope : 'article',
            code: ext.code
        });
    }

    logDebug(`[extensionRegistry] Registry built: ${registry.size} extension(s)`);
    return registry;
}

// ── 2. Resolver ─────────────────────────────────────────────────────────────

/**
 * Felold egy slug-ot a registry-ből, opcionális kind-elvárással.
 *
 * @param {Map<string, object>} registry
 * @param {string} slug
 * @param {string} [expectedKind] - 'validator' vagy 'command'; ha jelen, kind-mismatch ellenőrzés
 * @returns {{ ok: true, ext: object } | { ok: false, code: string, slug: string, detail?: string }}
 */
export function resolveExtension(registry, slug, expectedKind) {
    if (!registry || typeof registry.get !== 'function') {
        return { ok: false, code: 'no_registry', slug };
    }
    const ext = registry.get(slug);
    if (!ext) {
        return { ok: false, code: 'unknown_slug', slug };
    }
    if (expectedKind && ext.kind !== expectedKind) {
        return {
            ok: false,
            code: 'kind_mismatch',
            slug,
            detail: `expected=${expectedKind}, actual=${ext.kind}`
        };
    }
    return { ok: true, ext };
}

// ── 3. ExtendScript exec (B.4.4) ────────────────────────────────────────────

/**
 * String → hex (4 hex digit / UTF-16 code unit), szimmetrikus a sablonbeli `fromHex`-szel.
 * Astral plane karakterek a surrogate pár mindkét felével konzisztensen átmennek.
 */
function toHex(str) {
    let hex = '';
    for (let i = 0; i < str.length; i++) {
        hex += str.charCodeAt(i).toString(16).padStart(4, '0');
    }
    return hex;
}

/**
 * ExtendScript sablon a `maestroExtension(input)` futtatásához.
 *
 * Folyamat:
 *  1. hex-decode → JSON-string → JSON.parse → input objekt
 *  2. **Host hygiene boundary** AKTIVÁLÁSA (Codex harden adversarial High fix +
 *     stop-time review fix): a `app.scriptPreferences.userInteractionLevel` snapshot-ja,
 *     majd `NEVER_INTERACT`-ra állítás MIELŐTT a user-kód deklarálódna — különben a
 *     top-level user-kód runtime modális dialógja unguarded fagyasztaná a host-ot.
 *     A B.3.2 server-oldali acorn ECMA3 parse szigorú: csak EGY top-level
 *     `FunctionDeclaration` `maestroExtension`-szel + semmi más top-level runtime statement.
 *     A hygiene boundary defense-in-depth a server-side validation kiegészítéseként.
 *  3. **User-kód deklaráció** a teljes try-blokkban (a hygiene boundary-n belül).
 *     ECMA3 Annex B + JSI a block-level `FunctionDeclaration` hoist-ját function-scope-ra
 *     gyakorlatban támogatja; ha mégsem (spec-strict implementáció), a következő
 *     `typeof maestroExtension !== 'function'` check fail-closed `missing_maestro_extension_function`
 *     hibát ad, NEM rejtett crash.
 *  4. `var raw = maestroExtension(input)` (try/catch)
 *  5. `{ ok: true, value: raw }` VAGY `{ ok: false, error: '<reason>' }` envelope
 *  6. **Restore** finally blokkban (ECMA3 spec: `return` egy try/finally-en belül a
 *     finally-t MÉG MINDIG futtatja) — happy path, exec_error, és bármely
 *     top-level user-kód runtime exception esetén is visszaállítja a userInteractionLevel-t.
 *
 * **Envelope szigorúan host-szintű** (Codex tervi review Critical fix): a user-kód
 * SOSEM látja a wrappert, a sablon kívülről csomagolja. Ez kizárja a `__ext_error`
 * sentinel-collision rizikóját — a user szabadon visszaadhat tetszőleges JSON-objektet
 * (akár `{ok:false, error:...}`-t is, az a `value`-ba kerül, nem az envelope-ba).
 *
 * **Input parse `JSON.parse`-szal** (Codex tervi review High fix), nem `eval`-lal:
 * az `eval`-os parse extra kockázat lenne, és nem hozna semmit (a host JSON.stringify-jal
 * encode-ol, az ExtendScript JSON.parse standard).
 *
 * @param {string} userCode - az extension `code` mezője
 * @param {string} inputHex - JSON.stringify(input) → toHex
 * @returns {string} ExtendScript forrás
 */
function buildExtensionExtendScript(userCode, inputHex) {
    return `
(function(){
    function fromHex(h){
        var s = '';
        for (var i = 0; i < h.length; i += 4) {
            s += String.fromCharCode(parseInt(h.substr(i, 4), 16));
        }
        return s;
    }

    // Kézi JSON-szerializer (ExtendScript-kompatibilis, kontroll-karakter escape).
    // Az "indesignUtils.getOpenDocumentPaths" sablonja ihlette — ugyanaz a U+0000..U+001F
    // sweep + backslash/quote escape.
    function escStr(s) {
        s = String(s).split('\\\\').join('\\\\\\\\').split('"').join('\\\\"');
        var out = '';
        for (var ci = 0; ci < s.length; ci++) {
            var cc = s.charCodeAt(ci);
            if (cc >= 0x20) { out += s.charAt(ci); continue; }
            if (cc === 0x08) { out += '\\\\b'; }
            else if (cc === 0x09) { out += '\\\\t'; }
            else if (cc === 0x0A) { out += '\\\\n'; }
            else if (cc === 0x0C) { out += '\\\\f'; }
            else if (cc === 0x0D) { out += '\\\\r'; }
            else {
                var hx = cc.toString(16);
                while (hx.length < 4) hx = '0' + hx;
                out += '\\\\u' + hx;
            }
        }
        return '"' + out + '"';
    }
    function ser(v) {
        if (v === null || v === undefined) return 'null';
        var t = typeof v;
        if (t === 'boolean') return v ? 'true' : 'false';
        if (t === 'number') return isFinite(v) ? String(v) : 'null';
        if (t === 'string') return escStr(v);
        if (t === 'object') {
            if (v instanceof Array) {
                var parts = [];
                for (var i = 0; i < v.length; i++) parts.push(ser(v[i]));
                return '[' + parts.join(',') + ']';
            }
            // Object.prototype.hasOwnProperty.call(...) — defensive (Codex harden
            // baseline Medium fix): a user-kód visszaadhat \`{ hasOwnProperty: 'x' }\`-et,
            // ami felülírja a saját metódust és \`v.hasOwnProperty(k)\` crash-elne.
            var keys = [];
            for (var k in v) {
                if (Object.prototype.hasOwnProperty.call(v, k)) keys.push(k);
            }
            var props = [];
            for (var ki = 0; ki < keys.length; ki++) {
                props.push(escStr(keys[ki]) + ':' + ser(v[keys[ki]]));
            }
            return '{' + props.join(',') + '}';
        }
        // Function / undefined fallback — nem szabványos JSON, null-ra esik.
        return 'null';
    }
    function envelope(ok, value, error) {
        if (ok) return '{"ok":true,"value":' + ser(value) + '}';
        return '{"ok":false,"error":' + escStr(error) + '}';
    }

    // 1. Input dekódolás
    var inputStr = fromHex("${inputHex}");
    var input;
    try {
        input = JSON.parse(inputStr);
    } catch (e) {
        return envelope(false, null, 'input_parse: ' + e.message);
    }

    // 2. Host hygiene boundary AKTIVÁLÁSA — userInteractionLevel snapshot + restore-helper
    // setup, MIELŐTT a user-kód deklarálódna. Védi a top-level user-kód runtime-ját is
    // (Codex stop-time review fix): a B.3.2 server-oldali acorn ECMA3 parse szigorúan
    // csak EGY top-level FunctionDeclaration-t enged + semmi más statement-et, de
    // defense-in-depth a Plugin runtime is védi a hívás teljes ciklusát.
    var savedLevel = null;
    var levelSaved = false;
    try {
        savedLevel = app.scriptPreferences.userInteractionLevel;
        levelSaved = true;
    } catch (_e) {}

    try {
        try {
            app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
        } catch (_e) {}

        // 3. User-kód a hygiene boundary BELSEJÉBEN. ECMA3 Annex B + JSI a block-level
        // FunctionDeclaration hoist-ját function-scope-ra a gyakorlatban támogatja; ha
        // mégsem (spec-strict implementáció), a köv. typeof check fail-closed hibát ad.
        ${userCode}

        if (typeof maestroExtension !== 'function') {
            return envelope(false, null, 'missing_maestro_extension_function');
        }

        // 4. User függvény hívása + envelope return.
        // A return egy try/finally-en belül a finally blokkot MÉG MINDIG futtatja
        // (ECMA3 spec, ExtendScript-támogatott) — így a userInteractionLevel restore
        // mind a happy path-on, mind az exec_error ágon, mind a top-level user-kód
        // runtime exception-ja esetén megtörténik.
        var raw;
        try {
            raw = maestroExtension(input);
        } catch (e) {
            return envelope(false, null, 'exec_error: ' + e.message);
        }

        return envelope(true, raw, null);
    } finally {
        if (levelSaved) {
            try {
                app.scriptPreferences.userInteractionLevel = savedLevel;
            } catch (_e) {}
        }
    }
})();
`;
}

/**
 * `maestroExtension(input)` futtatása ExtendScript-en, JSON I/O envelope-pal.
 *
 * **Phase 0 vállalt korlátok** (Codex harden adversarial Medium dokumentációs fix):
 *  - **Hex bandwidth amplification**: minden hívás ~4× méretarányt jelent input-on
 *    (UTF-16 → 4 hex digit / char) + új ExtendScript forrás. Egy 100 KB JSON payload
 *    ~400 KB literal-t generál. Phase 0-ban a tipikus `{article}` payload <10 KB,
 *    de több ext validátoros átmenet esetén user-érzékelhető latency lehet. Phase 1+
 *    enyhítheti (pl. shared-state binding).
 *  - **`maestroExtension` névszigetelés**: a sablon `(function(){...})()` IIFE-be zárja
 *    a user-kódot, így a `function maestroExtension` deklaráció a sablon function-scope-jában
 *    él, NEM globálisan (Codex harden verifikáló Low pontosítás). Minden `app.doScript` hívás
 *    saját IIFE scope-ot kap, így a Phase 0 szekvenciális ÉS a Phase 1+ esetleges párhuzamos
 *    dispatch is automatikusan izolált — nincs név-kollízió aggály a sablon szintjén.
 *
 * @param {string} code - extension code (acorn ECMA3 pre-parse szerver-oldalon átment)
 * @param {object} input - JSON-stringify-elhető input (validator: `{ article }`,
 *   command: `{ article, publicationRoot }`)
 * @returns {Promise<{ ok: true, value: any } | { ok: false, error: string }>}
 *   - `ok:true` → a `value` az user-kód visszatérési értéke (parsed JSON)
 *   - `ok:false` → az `error` runtime-bug oka (input_parse, exec_error,
 *     missing_maestro_extension_function, doScript_failed, parse_envelope_failed)
 */
async function executeExtensionScript(code, input) {
    let inputJson;
    try {
        inputJson = JSON.stringify(input);
    } catch (err) {
        return { ok: false, error: `host_input_stringify: ${err.message}` };
    }
    const inputHex = toHex(inputJson);
    const script = buildExtensionExtendScript(code, inputHex);

    let raw;
    try {
        raw = await executeScript(script);
    } catch (err) {
        return { ok: false, error: `doScript_failed: ${err.message}` };
    }

    // Az envelope minden ágon JSON-string. Plugin-oldali parse hibája csak akkor,
    // ha a `app.doScript` extra wrappert dob — ez nem várt, fail-closed propagálás.
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return { ok: false, error: `parse_envelope_failed: ${err.message}` };
    }

    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: 'parse_envelope_invalid_shape' };
    }
    if (parsed.ok === true) return { ok: true, value: parsed.value };
    if (parsed.ok === false) {
        return { ok: false, error: typeof parsed.error === 'string' ? parsed.error : 'unknown_error' };
    }
    return { ok: false, error: 'parse_envelope_missing_ok' };
}

// ── 4. Dispatch — validator ─────────────────────────────────────────────────

/**
 * Validator extension futtatás + output normalizálás.
 *
 * Output kontraktus (`extensionContract.js` 6. blokk):
 *   `{ isValid: boolean, errors: string[], warnings: string[] }`
 *
 * Defense-in-depth: a kontraktus-szegő válasz fail-closed `isValid:false`-t ad,
 * az error-ok prefix-elve `[ext.<slug>] ...` alakra (a UI így megkülönbözteti
 * a built-in validátoroktól).
 *
 * @param {Map<string, object>} registry
 * @param {string} slug
 * @param {object} input - validator input shape `{ article, options? }`
 * @returns {Promise<{ isValid: boolean, errors: string[], warnings: string[] }>}
 */
export async function dispatchExtensionValidator(registry, slug, input) {
    const resolved = resolveExtension(registry, slug, 'validator');
    if (!resolved.ok) {
        return failureValidator(slug, _resolveErrorMessage(resolved));
    }

    log(`[extensionRegistry] validator dispatch: ext.${slug}`);
    const result = await executeExtensionScript(resolved.ext.code, input);
    if (!result.ok) {
        return failureValidator(slug, `runtime_error: ${result.error}`);
    }

    const value = result.value;
    if (!value || typeof value !== 'object') {
        return failureValidator(slug, 'invalid_output_shape: not an object');
    }

    const prefix = `[ext.${slug}] `;

    // Strict shape-check: típuseltérő `errors` / `warnings` / nem-bool `isValid` →
    // fail-closed kontraktus-sértés (Codex follow-up review Medium fix). Anélkül egy
    // `errors: [{code:'X'}]` lista a filter-rel csendben kiürülne, és `isValid:true`
    // mellett a Plugin sikeres validálásként interpretálná.
    const shapeError = _checkValidatorShape(value);
    if (shapeError) {
        return failureValidator(slug, shapeError);
    }

    const errors = Array.isArray(value.errors) ? value.errors : [];
    const warnings = Array.isArray(value.warnings) ? value.warnings : [];
    const isValid = value.isValid === true && errors.length === 0;

    // Defense-in-depth: ha `isValid:false`-t adott `errors[]` nélkül, explicit
    // diagnosztikai üzenetet pótolunk — különben a UI csak generikus toast-ot mutat.
    if (!isValid && errors.length === 0) {
        return {
            isValid: false,
            errors: [`${prefix}invalid_output_shape: isValid not true and errors[] empty`],
            warnings: warnings.map(w => prefix + w)
        };
    }
    return {
        isValid,
        errors: errors.map(e => prefix + e),
        warnings: warnings.map(w => prefix + w)
    };
}

/**
 * Validator output strict shape-check. Visszaad egy hibaüzenetet, ha a kontraktus
 * sérül; null-t ha rendben.
 *
 * Kontraktus (`extensionContract.js` 6. blokk): `{ isValid: boolean, errors: string[], warnings: string[] }`.
 * - `isValid` nem-boolean → invariáns sértés.
 * - `errors` jelen van, de nem array, vagy nem-string elemet tartalmaz → invariáns sértés.
 * - `warnings` ugyanígy.
 */
function _checkValidatorShape(value) {
    if (typeof value.isValid !== 'boolean') {
        return `invalid_output_shape: isValid must be boolean (got ${typeof value.isValid})`;
    }
    if (value.errors !== undefined) {
        if (!Array.isArray(value.errors)) {
            return `invalid_output_shape: errors must be array (got ${typeof value.errors})`;
        }
        if (value.errors.some(e => typeof e !== 'string')) {
            return 'invalid_output_shape: errors must contain only strings';
        }
    }
    if (value.warnings !== undefined) {
        if (!Array.isArray(value.warnings)) {
            return `invalid_output_shape: warnings must be array (got ${typeof value.warnings})`;
        }
        if (value.warnings.some(w => typeof w !== 'string')) {
            return 'invalid_output_shape: warnings must contain only strings';
        }
    }
    return null;
}

function failureValidator(slug, reason) {
    return {
        isValid: false,
        errors: [`[ext.${slug}] ${reason}`],
        warnings: []
    };
}

// ── 5. Dispatch — command ───────────────────────────────────────────────────

/**
 * Command extension futtatás + output normalizálás.
 *
 * Output kontraktus (`extensionContract.js` 6. blokk):
 *   `{ success: boolean, error?: string, message?: string }`
 *
 * @param {Map<string, object>} registry
 * @param {string} slug
 * @param {object} input - command input shape `{ article, options?, publicationRoot }`
 * @returns {Promise<{ success: boolean, error?: string, message?: string }>}
 */
export async function dispatchExtensionCommand(registry, slug, input) {
    const resolved = resolveExtension(registry, slug, 'command');
    if (!resolved.ok) {
        return { success: false, error: `[ext.${slug}] ${_resolveErrorMessage(resolved)}` };
    }

    log(`[extensionRegistry] command dispatch: ext.${slug}`);
    const result = await executeExtensionScript(resolved.ext.code, input);
    if (!result.ok) {
        return { success: false, error: `[ext.${slug}] runtime_error: ${result.error}` };
    }

    const value = result.value;
    if (!value || typeof value !== 'object') {
        return { success: false, error: `[ext.${slug}] invalid_output_shape: not an object` };
    }

    // Strict shape-check (Codex follow-up review Medium/Low fix).
    const shapeError = _checkCommandShape(value);
    if (shapeError) {
        return { success: false, error: `[ext.${slug}] ${shapeError}` };
    }

    const success = value.success === true;
    const error = typeof value.error === 'string' ? value.error : undefined;
    const message = typeof value.message === 'string' ? value.message : undefined;
    // Defense-in-depth: kontraktus-szegő `success:false` `error` nélkül → explicit
    // diagnosztikai szöveg, hogy a UI ne generikus "Ismeretlen hiba" fallback-et lásson.
    if (!success && !error) {
        return {
            success: false,
            error: `[ext.${slug}] invalid_output_shape: success not true and error empty`,
            message
        };
    }
    return { success, error, message };
}

/**
 * Command output strict shape-check.
 *
 * Kontraktus: `{ success: boolean, error?: string, message?: string }`.
 * `error?` / `message?`: ha a kulcs jelen van, a típusa string legyen
 * (`extensionContract.js` 6. blokk explicit `null` fail-closed kerülendő szabálya).
 */
function _checkCommandShape(value) {
    if (typeof value.success !== 'boolean') {
        return `invalid_output_shape: success must be boolean (got ${typeof value.success})`;
    }
    if (value.error !== undefined && typeof value.error !== 'string') {
        return `invalid_output_shape: error must be string when present (got ${typeof value.error})`;
    }
    if (value.message !== undefined && typeof value.message !== 'string') {
        return `invalid_output_shape: message must be string when present (got ${typeof value.message})`;
    }
    return null;
}

function _resolveErrorMessage(resolved) {
    if (resolved.code === 'unknown_slug') return 'extension nem található a snapshot-ban';
    if (resolved.code === 'kind_mismatch') return `kind eltérés (${resolved.detail})`;
    if (resolved.code === 'no_registry') return 'extension regisztry nem inicializált';
    return resolved.code;
}
