/**
 * Maestro Shared — Workflow Extension kontraktus (ADR 0007 Phase 0).
 *
 * Ez a modul a kanonikus deklaráció a `workflowExtensions` collection-höz
 * kapcsolódó **kliens-oldali kontraktusra**:
 *   1. enum-érték listák (`kind`, `scope`)
 *   2. méret-korlátok (`slug`, `name`)
 *   3. workflow JSON ref-helperek (`ext.<slug>` prefix-feloldás)
 *   4. egységes slug-validátor a Designer save + Plugin runtime + B.3 CF
 *      write-path számára
 *
 * **Hatókör (B.2.1)**: csak deklaratív + tiszta, sync, DOM-mentes helperek.
 * A futtatott `maestroExtension(input)` JSON kimenetének shape-ellenőrzése
 * (`validateValidatorOutput` / `validateCommandOutput`) **NEM ide tartozik**
 * — az a B.4 plugin runtime hatáskör (az első valódi consumer ott jön elő).
 * Ne adjunk hozzá halott "majd egyszer kell" API-t, mielőtt van consumer.
 *
 * **Phase 0 hatókör-szűkítés (B.0.4)**: a per-workflow extension `options`
 * MVP-ben üres / nem továbbított — sem a Designer (`ValidationListField` /
 * `CommandListField`) nem szerkeszti, sem a Plugin runtime nem propagál
 * user-szerkesztett options-t. A JSON I/O szerződés `options?` mezője
 * Phase 1+-ban válik élessé.
 *
 * **Drift-rizikó (manuálisan szinkronban tartandó)**:
 * - `EXTENSION_KIND_VALUES` / `EXTENSION_SCOPE_VALUES` / `EXTENSION_SCOPE_DEFAULT`
 *   inline CJS duplikáció:
 *   SYNC WITH: `packages/maestro-server/functions/invite-to-organization/src/helpers/constants.js`
 * - `EXTENSION_SLUG_MAX_LENGTH` (= 64) és `EXTENSION_NAME_MAX_LENGTH` (= 100)
 *   a `bootstrap_workflow_extension_schema` action attribute-jaiban hardcode-olva:
 *   SYNC WITH: `packages/maestro-server/functions/invite-to-organization/src/actions/schemas.js`
 *   (a `workflowExtensions` collection `name` / `slug` `size` paraméterei)
 * - `EXTENSION_SLUG_REGEX` és `EXTENSION_SLUG_MAX_LENGTH` szándékosan a
 *   server-side `helpers/util.js` `SLUG_REGEX` / `SLUG_MAX_LENGTH` betűre
 *   egyező értékeit tükrözi (groups / workflows / permissionSets slug-jával
 *   azonos szabály):
 *   SYNC WITH: `packages/maestro-server/functions/invite-to-organization/src/helpers/util.js`
 *
 * Phase 2 megoldás: az [[A.7.3]] mintájú `scripts/build-cf-extension-contract.mjs`
 * ESM → CJS generátor (a [scripts/build-cf-validator.mjs](../../scripts/build-cf-validator.mjs)
 * mintájára) — most még csak 3 konstansról + 2 méret-számról van szó,
 * A.7.3 előtt önálló generátort ráhúzni overengineering.
 *
 * @module shared/extensionContract
 */

// ── 1. Globális kontraktus-konstansok ────────────────────────────────────────

/**
 * A user által írt ExtendScript modul **egyetlen kötelező globál függvénye**.
 * A Plugin runtime (B.4) ezt fogja `app.doScript`-tel meghívni, és a JSON
 * eredményt parse-olja. A név hard-koded — minden extension `code`-ja ezt
 * deklarálja.
 *
 *     function maestroExtension(input) { ... return { ... }; }
 */
export const MAESTRO_EXTENSION_GLOBAL_NAME = 'maestroExtension';

/**
 * Workflow JSON `compiled.validations[]` és `compiled.commands[]` listában
 * az extension-hivatkozás prefixe — `ext.<slug>`. A beépített parancsok és
 * validátorok ezt a prefixet **nem** használják (ld.
 * `commandRegistry.js` és `validatorRegistry.js`).
 */
export const EXTENSION_REF_PREFIX = 'ext.';

// ── 2. Enum-érték listák (B.1.1 schema-val egyeznek) ─────────────────────────

/**
 * A `workflowExtensions.kind` enum Phase 0-ban: validátor vagy parancs.
 * Phase 1+ jövő-bővítés (pl. preflight-hook, scheduled-task) NEM jönne ide
 * — új kind-ot a séma `updateEnumAttribute`-tal adunk hozzá.
 */
export const EXTENSION_KIND_VALUES = Object.freeze(['validator', 'command']);

/**
 * A `workflowExtensions.scope` enum Phase 0-ban **CSAK `article`** —
 * fail-closed séma (B.1.1 / Codex adversarial review B.1 2026-05-04 Medium
 * fix). A Phase 1+ `publication` scope egy `updateEnumAttribute`-tal kerül
 * be, így a B.3 CRUD action-nek nem kell explicit `scope: 'publication'`
 * guardot adnia (defense-in-depth a sémából jön).
 */
export const EXTENSION_SCOPE_VALUES = Object.freeze(['article']);

/**
 * A `workflowExtensions.scope` default értéke (B.1.1 schema-val egyezik).
 */
export const EXTENSION_SCOPE_DEFAULT = 'article';

// ── 3. Slug + név méret-korlátok (B.1.1 schema-val egyeznek) ────────────────

/**
 * Slug formátum: kisbetű, szám, kötőjel — a `groups` / `workflows` /
 * `permissionSets` slug-jaival azonos szabály. A `helpers/util.js`
 * `SLUG_REGEX`-szel betűre egyező; itt külön exportáljuk, hogy a kliens
 * (Designer + Plugin runtime) ne kelljen a server-helper-t require-olnia.
 */
export const EXTENSION_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A `workflowExtensions.slug` mező schema-mérete (B.1.1: `string size 64`).
 * A `helpers/util.js` `SLUG_MAX_LENGTH`-szel megegyezik.
 */
export const EXTENSION_SLUG_MAX_LENGTH = 64;

/**
 * A `workflowExtensions.name` mező schema-mérete (B.1.1: `string size 100`).
 *
 * **Tudatosan NEM 128** (a server-side `helpers/util.js` `NAME_MAX_LENGTH`
 * generikus 128-as értékétől eltér). A workflow extension `name` UI-ban
 * látszik (Designer "Bővítmények" tab kártya-fejléc), és a tipikus szöveg
 * 100 char alatt fér el — a 100 a domain-konstans, nem véletlen drift.
 */
export const EXTENSION_NAME_MAX_LENGTH = 100;

// ── 4. Slug validátor ────────────────────────────────────────────────────────

/**
 * Egyetlen extension-slug validálása. Defense-in-depth: a Designer
 * save-time check, a B.3 CF write-path és a Plugin runtime
 * `extensionRegistry` lookup is ezt használja.
 *
 * **Whitespace-érzékeny**: a validátor NEM trim-eli az inputot — a slug a
 * pontos, immutable formáját kapja meg. Ennek oka, hogy az `isExtensionRef`
 * / `parseExtensionRef` ref-helperek a workflow JSON `ext.<slug>` stringjét
 * is karakterre pontosan ellenőrzik (trim nélkül); ha itt eltűrnénk a
 * `" foo "` alakot, a save-path engedne egy slug-ot, amit a Plugin runtime
 * sosem tudna feloldani. A leading/trailing whitespace-t a hívók
 * kötelesek előzetesen kivenni (CF-en a `sanitizeString` helper, kliensen
 * a UI input).
 *
 * **Error-akkumulátor minta**: ha a slug túl hosszú ÉS formailag invalid,
 * két errort kap. Ez tudatos eltérés a [`validatePermissionSetSlugs`]
 * (permissions.js) lista-validátorától, ami egy slug-ra rövidre zár — itt
 * single-slug + minden szabálysértés egyszerre megjelenik a UI-on, hogy a
 * felhasználó egy körben minden korrekciót lásson.
 *
 * Error code-ok:
 * - `invalid_slug_type` — nem string (null, undefined, szám, object) — early return
 * - `empty_slug` — üres / csak whitespace — early return (regex amúgy is bukik)
 * - `slug_too_long` — > `EXTENSION_SLUG_MAX_LENGTH` karakter — folytatjuk a regex-checket
 * - `slug_format_invalid` — nem felel meg `EXTENSION_SLUG_REGEX`-nek
 *
 * @param {string} slug - validálandó extension-slug (whitespace-érzékenyen)
 * @returns {{ valid: boolean, errors: Array<{ code: string, slug: string, message: string }> }}
 */
export function validateExtensionSlug(slug) {
    const errors = [];

    if (typeof slug !== 'string') {
        errors.push({
            code: 'invalid_slug_type',
            slug: String(slug),
            message: `Az extension slug-nak string-nek kell lennie (kapott: ${typeof slug}).`
        });
        return { valid: false, errors };
    }

    if (slug.trim() === '') {
        errors.push({
            code: 'empty_slug',
            slug,
            message: 'Az extension slug nem lehet üres.'
        });
        return { valid: false, errors };
    }

    if (slug.length > EXTENSION_SLUG_MAX_LENGTH) {
        errors.push({
            code: 'slug_too_long',
            slug,
            message: `Az extension slug legfeljebb ${EXTENSION_SLUG_MAX_LENGTH} karakter lehet (kapott: ${slug.length}).`
        });
        // A regex-check is fut — single-slug error-akkumulátor (lásd JSDoc).
    }

    if (!EXTENSION_SLUG_REGEX.test(slug)) {
        errors.push({
            code: 'slug_format_invalid',
            slug,
            message: `Az extension slug csak kisbetűt, számot és kötőjelet tartalmazhat (pl. "author-name-required"). Kapott: ${JSON.stringify(slug)}.`
        });
    }

    return { valid: errors.length === 0, errors };
}

// ── 5. Workflow JSON ref-helperek ───────────────────────────────────────────

/**
 * Egy workflow JSON-ből származó hivatkozás-stringből kinyeri az
 * extension-slug-ot. `null`-t ad, ha a ref nem `ext.<slug>` alakú string,
 * vagy a slug szabálysértő. A kanonikus parser — az `isExtensionRef` ennek
 * boolean projekciója.
 *
 * **Csak string ágon dolgozik.** A `compiled.commands[]` `{ id, allowedGroups }`
 * object-alak feloldása a hívónál történik (`isExtensionRef(cmd.id)`) — itt
 * tudatosan nem támogatjuk az object-alakot, hogy ne lopja be magát egy
 * mini type-system absztrakció.
 *
 * @param {string} ref - workflow JSON-ből származó string-hivatkozás
 * @returns {{ slug: string } | null}
 */
export function parseExtensionRef(ref) {
    if (typeof ref !== 'string') return null;
    if (!ref.startsWith(EXTENSION_REF_PREFIX)) return null;
    const slug = ref.slice(EXTENSION_REF_PREFIX.length);
    if (slug.length > EXTENSION_SLUG_MAX_LENGTH) return null;
    if (!EXTENSION_SLUG_REGEX.test(slug)) return null;
    return { slug };
}

/**
 * Igaz, ha a `ref` érvényes `ext.<slug>` alakú string-hivatkozás.
 * Boolean projekciója a `parseExtensionRef`-nek.
 *
 * @param {string} ref - workflow JSON-ből származó string-hivatkozás
 * @returns {boolean}
 */
export function isExtensionRef(ref) {
    return parseExtensionRef(ref) !== null;
}

// ── 6. JSON I/O szerződés (deklaratív dokumentáció) ─────────────────────────
//
// Az `maestroExtension(input)` ExtendScript globál függvény két kötött
// kontraktust elégít ki — a `kind` mezőtől függően. A Plugin runtime (B.4)
// és a Designer dummy-exec (B.3) implementációja ezeket az alakokat
// validálja a `JSON.parse` után.
//
// A tényleges `validateValidatorOutput` / `validateCommandOutput` shape-check
// helperek **B.4 hatáskörbe** tartoznak (az első valódi consumer ott jön
// elő). Itt csak a séma-leírás él dokumentációként — implementáció nincs.
//
// ┌──────────┬──────────────────────────────────────┬──────────────────────────────────────────────┐
// │ kind     │ input                                │ output                                       │
// ├──────────┼──────────────────────────────────────┼──────────────────────────────────────────────┤
// │ validator│ { article, options? }                │ { isValid: boolean,                          │
// │          │                                      │   errors: string[],                          │
// │          │                                      │   warnings: string[] }                       │
// ├──────────┼──────────────────────────────────────┼──────────────────────────────────────────────┤
// │ command  │ { article, options?, publicationRoot}│ { success: boolean,                          │
// │          │                                      │   error?: string,                            │
// │          │                                      │   message?: string }                         │
// └──────────┴──────────────────────────────────────┴──────────────────────────────────────────────┘
//
// **Phase 0 (B.0.4)**: az `options?` üres / nem továbbított, lásd a fájl-
// fejlécet. Phase 1+: `paramSchema` collection-mező + Designer
// options-szerkesztő + Plugin runtime options-átadás.
//
// **`error?` / `message?` szemantika**: ha a kulcs jelen van, a típusa
// `string` legyen; explicit `null` fail-closed kerülendő (a B.4 shape-
// validator visszautasítja, ne mossa el a hibás runtime-ot).
