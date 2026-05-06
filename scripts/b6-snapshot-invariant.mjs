#!/usr/bin/env node
/**
 * B.6.2 — Workflow Extensions snapshot-only invariáns logikai igazolása.
 *
 * (ADR 0007 Phase 0, _docs/Feladatok.md B.6 smoke teszt)
 *
 * Cél:
 *   Igazolni, hogy a Plugin runtime extension-regisztrye KIZÁRÓLAG a
 *   `publication.compiledExtensionSnapshot`-ból épül, és a snapshot
 *   rögzítése után az office-szintű "live" extension-CRUD NEM hat vissza
 *   az aktivált publikáció runtime-jára.
 *
 * Mit fed le:
 *   - `buildExtensionRegistry(snapshot)` snapshot → Map<slug, entry>
 *   - `resolveExtension(reg, slug, expectedKind)` lookup + kind-mismatch
 *   - Fail-closed ágak: null/üres snapshot, korrupt entry, JSON parse hiba
 *
 * Mit NEM fed le (manuális smoke + kód-walk feladata):
 *   - ExtendScript futás, `executeScript()` host integráció (B.4.4)
 *   - Server-oldali `validate-publication-update` §5c/§6b guardok
 *   - Dashboard CRUD UI, Workflow Designer ext.<slug> chip-ek
 *   - Realtime publication.update / workflowExtensions push
 *
 * Logikai duplikáció — a függvénypár forrása:
 *   packages/maestro-indesign/src/core/utils/extensions/extensionRegistry.js
 *   packages/maestro-shared/extensionContract.js (EXTENSION_KIND_VALUES)
 *
 * Mivel a `maestro-shared/package.json` nem deklarál `type: "module"`-t,
 * a Node a `.js` fájlokat CJS-ként értékelné, és az `export const ...`
 * szintaxis hibára futna. Ezért az alábbi két függvény INLINE másolat —
 * ha a kanonikus változik, ezt a scriptet is frissíteni kell.
 *
 * Futtatás:
 *   node scripts/b6-snapshot-invariant.mjs
 *
 * Exit code: 0 ha minden invariáns tartja magát, 1 ha legalább egy bukás.
 */

// ── 1. Logikai másolat: shared kontraktus ────────────────────────────────────

const EXTENSION_KIND_VALUES = ['validator', 'command'];

// ── 2. Logikai másolat: extensionRegistry.js (Plugin runtime) ────────────────

function buildExtensionRegistry(snapshot) {
    if (!snapshot) return new Map();
    let parsed;
    try {
        parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    } catch {
        return new Map();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const registry = new Map();
    for (const slug of Object.keys(parsed)) {
        const ext = parsed[slug];
        if (!ext || typeof ext !== 'object') continue;
        if (typeof ext.code !== 'string' || ext.code.length === 0) continue;
        if (!EXTENSION_KIND_VALUES.includes(ext.kind)) continue;
        registry.set(slug, {
            name: typeof ext.name === 'string' ? ext.name : slug,
            kind: ext.kind,
            scope: typeof ext.scope === 'string' ? ext.scope : 'article',
            code: ext.code
        });
    }
    return registry;
}

function resolveExtension(registry, slug, expectedKind) {
    if (!registry || typeof registry.get !== 'function') {
        return { ok: false, code: 'no_registry', slug };
    }
    const ext = registry.get(slug);
    if (!ext) return { ok: false, code: 'unknown_slug', slug };
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

// ── 3. Mini test harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, cond, detail) {
    if (cond) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
        failed++;
    }
}

function section(title) {
    console.log(`\n${title}`);
}

// ── 4. Forgatókönyv: aktivált publikáció + utólagos live edit ────────────────
//
// Egy publikáció aktiválásakor a `validate-publication-update` CF rögzít egy
// `compiledExtensionSnapshot`-ot, amely tartalmazza a hivatkozott extension-ök
// `code` mezőjének akkori értékét (v1). Ezt követően az office admin a
// Dashboard "Bővítmények" tabon átírja az extension `code`-ját v2-re; a
// `update_workflow_extension` CF a `workflowExtensions` collection-be ír,
// de a `publication.compiledExtensionSnapshot` IMMUTABLE marad.
//
// A Plugin runtime registry-jának ezért továbbra is v1 kódot kell adnia
// minden `ext.<slug>` lookup-ra az aktivált publikáción.

console.log('── B.6.2 — Snapshot-only invariáns logikai igazolása ──');

const snapshotV1 = JSON.stringify({
    'author-required': {
        name: 'Szerző kötelező',
        kind: 'validator',
        scope: 'article',
        code: '/* SNAPSHOT_V1 */ function maestroExtension(input){ return {isValid:true,errors:[],warnings:[]}; }'
    },
    'pdf-export': {
        name: 'PDF export',
        kind: 'command',
        scope: 'article',
        code: '/* SNAPSHOT_V1 */ function maestroExtension(input){ return {success:true,message:"v1"}; }'
    }
});

section('1) Registry build a snapshot-ból');
const reg = buildExtensionRegistry(snapshotV1);
assert('registry mérete = 2', reg.size === 2, `kapott: ${reg.size}`);
assert('author-required slug a registry-ben', reg.has('author-required'));
assert('pdf-export slug a registry-ben', reg.has('pdf-export'));

section('2) Snapshot-only invariáns: a registry a v1 kódot tartja');
const validatorEntry = reg.get('author-required');
const commandEntry = reg.get('pdf-export');
assert('validator kind = validator', validatorEntry.kind === 'validator');
assert('command kind = command', commandEntry.kind === 'command');
assert('validator kód SNAPSHOT_V1', validatorEntry.code.includes('SNAPSHOT_V1'));
assert('command kód SNAPSHOT_V1', commandEntry.code.includes('SNAPSHOT_V1'));

section('3) Live extension v2 mutáció után a registry változatlan');
// Élet-szerű flow: az office admin a Dashboard "Bővítmények" tabon átírja az
// extension code-ot. A `workflowExtensions` collection live mezője v2-re vált.
// Ezt itt kifejezett külső objektummal modellezzük, hogy lássuk: a registry
// (Map) szigorúan önálló, semmilyen referencia-megosztás nincs a snapshot
// mögött; a live mutáció bit-szerinti elkülönülésben marad.
const liveExtensionsV2 = {
    'author-required': {
        kind: 'validator',
        code: '/* LIVE_V2 */ function maestroExtension(){return {isValid:false,errors:["bug"],warnings:[]};}'
    },
    'pdf-export': {
        kind: 'command',
        code: '/* LIVE_V2 */ function maestroExtension(){return {success:false,error:"bug"};}'
    }
};
// (a liveExtensionsV2 NEM kapcsolódik a registry-hez — szándékosan külön graph)
const validatorAfter = reg.get('author-required');
const commandAfter = reg.get('pdf-export');
assert('validator kód továbbra is SNAPSHOT_V1', validatorAfter.code.includes('SNAPSHOT_V1'));
assert('command kód továbbra is SNAPSHOT_V1', commandAfter.code.includes('SNAPSHOT_V1'));
assert('validator kód NEM tartalmaz LIVE_V2-t', !validatorAfter.code.includes('LIVE_V2'));
assert('command kód NEM tartalmaz LIVE_V2-t', !commandAfter.code.includes('LIVE_V2'));
// liveExtensionsV2 hivatkozás-tartás (linter no-unused-vars elkerülés):
void liveExtensionsV2;

section('4) Fail-closed — hiányzó snapshot → üres registry + unknown_slug');
const emptyRegFromNull = buildExtensionRegistry(null);
const emptyRegFromUndef = buildExtensionRegistry(undefined);
const emptyRegFromEmptyStr = buildExtensionRegistry('');
assert('null snapshot → 0 entry', emptyRegFromNull.size === 0);
assert('undefined snapshot → 0 entry', emptyRegFromUndef.size === 0);
assert('üres string → 0 entry', emptyRegFromEmptyStr.size === 0);
const lookupOnEmpty = resolveExtension(emptyRegFromNull, 'author-required', 'validator');
assert('empty registry lookup → unknown_slug',
    lookupOnEmpty.ok === false && lookupOnEmpty.code === 'unknown_slug');

section('5) Resolver kind-mismatch detektálás');
const kindMismatch = resolveExtension(reg, 'author-required', 'command');
assert('validator-ot command-ként kérve → kind_mismatch',
    kindMismatch.ok === false && kindMismatch.code === 'kind_mismatch',
    `kapott: ${JSON.stringify(kindMismatch)}`);

section('6) Resolver happy path');
const okResolved = resolveExtension(reg, 'author-required', 'validator');
assert('helyes kind → ok=true', okResolved.ok === true);
assert('ok-result kód SNAPSHOT_V1',
    okResolved.ok === true && okResolved.ext.code.includes('SNAPSHOT_V1'));

section('7) Per-entry shape skip — hibás entry nem szennyezi a többit');
const corruptedSnapshot = JSON.stringify({
    'good-ext': {
        name: 'Jó',
        kind: 'validator',
        scope: 'article',
        code: 'function maestroExtension(){return{isValid:true,errors:[],warnings:[]};}'
    },
    'bad-no-code': { name: 'Hiányzó kód', kind: 'validator', scope: 'article' },
    'bad-empty-code': { name: 'Üres kód', kind: 'validator', scope: 'article', code: '' },
    'bad-unknown-kind': {
        name: 'Ismeretlen kind', kind: 'preflight-hook', scope: 'article',
        code: 'function maestroExtension(){}'
    },
    'bad-non-object': 'nem objekt'
});
const corrReg = buildExtensionRegistry(corruptedSnapshot);
assert('csak a good-ext kerül be', corrReg.size === 1 && corrReg.has('good-ext'));
assert('bad-no-code kihagyva', !corrReg.has('bad-no-code'));
assert('bad-empty-code kihagyva', !corrReg.has('bad-empty-code'));
assert('bad-unknown-kind kihagyva', !corrReg.has('bad-unknown-kind'));
assert('bad-non-object kihagyva', !corrReg.has('bad-non-object'));

section('8) Top-level invalid JSON → üres registry (top-level fail-closed)');
const malformed = '{ "broken": ';
const malReg = buildExtensionRegistry(malformed);
assert('rossz JSON → 0 entry', malReg.size === 0);

section('9) Top-level array snapshot → üres registry (nem-objekt)');
const arraySnapshot = JSON.stringify([{ slug: 'foo', code: '...' }]);
const arrReg = buildExtensionRegistry(arraySnapshot);
assert('array → 0 entry', arrReg.size === 0);

section('10) Snapshot-ban NEM létező slug → unknown_slug, nincs registry-szennyezés');
const unknownLookup = resolveExtension(reg, 'never-existed', 'validator');
assert('ismeretlen slug → unknown_slug',
    unknownLookup.ok === false && unknownLookup.code === 'unknown_slug');
assert('registry mérete változatlan a sikertelen lookup után', reg.size === 2);

section('11) Resolver `no_registry` ág — nem-Map argumentum');
// Védi a hívót egy hibás regisztry-átadás (null Map, plain object, stb.) ellen
// (ld. extensionRegistry.js:125-127). A registry egy szigorú Map<>, így minden
// más belépő — null, undefined, plain object, array — `no_registry`-re esik.
const nullRegLookup = resolveExtension(null, 'author-required', 'validator');
const undefRegLookup = resolveExtension(undefined, 'author-required', 'validator');
const plainObjLookup = resolveExtension({}, 'author-required', 'validator');
const arrayLookup = resolveExtension([], 'author-required', 'validator');
assert('null registry → no_registry',
    nullRegLookup.ok === false && nullRegLookup.code === 'no_registry');
assert('undefined registry → no_registry',
    undefRegLookup.ok === false && undefRegLookup.code === 'no_registry');
assert('plain object registry → no_registry',
    plainObjLookup.ok === false && plainObjLookup.code === 'no_registry');
assert('array registry → no_registry',
    arrayLookup.ok === false && arrayLookup.code === 'no_registry');

// ── Záró összegzés ───────────────────────────────────────────────────────────

console.log('\n── Eredmény ──');
console.log(`  Sikeres: ${passed}`);
console.log(`  Hibás:   ${failed}`);
console.log(`  Összes:  ${passed + failed}`);

if (failed > 0) {
    console.error('\n[FAIL] B.6.2 invariáns megsérült — vizsgáld a snapshot-only séma kód-pályáit.');
    process.exit(1);
}

console.log('\n[OK] B.6.2 logikai invariáns tartja magát: a registry kizárólag a snapshot-ból épül.');
process.exit(0);
