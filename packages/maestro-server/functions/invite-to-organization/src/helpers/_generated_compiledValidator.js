/**
 * AUTO-GENERATED FILE — DO NOT EDIT.
 * Source: packages/maestro-shared/compiledValidator.js
 * Regenerate: yarn build:cf-validator
 *
 * A `packages/maestro-shared/compiledValidator.js` (ESM) a kanonikus forrás. Ez a
 * fájl egy CommonJS pillanatkép, hogy az `invite-to-organization` CF deploy-
 * időben elérje (a workspace yarn link nem oldódik fel a CF runtime-on). A
 * generálást a `scripts/build-cf-validator.mjs` végzi (A.7.1, ADR 0008).
 */
/**
 * Maestro Shared — Workflow Compiled JSON validátor (A.1.9 / ADR 0008).
 *
 * Hard contract: a `compiled` JSON minden slug-hivatkozó mezője csak olyan
 * slug-ot tartalmazhat, amely a `requiredGroupSlugs[].slug` halmaz eleme.
 * Shared modul, hogy a Designer save-flow és a szerver-oldali write-path
 * (A.2.1) azonos validátort hívjon.
 *
 * A `leaderGroups[]` és `contributorGroups[]` a compiler által autogenerált
 * (A.1.5), de defense-in-depth okból ellenőrizzük (legacy import / DevTools
 * manipuláció ellen).
 */

/**
 * @typedef {{ valid: boolean, errors: Array<{ code: string, slug?: string, location?: string, message: string }> }} ValidationResult
 */

/**
 * @param {Object} compiled - A workflow compiled JSON-ja.
 * @returns {ValidationResult}
 */
function validateCompiledSlugs(compiled) {
    const errors = [];

    if (!compiled || typeof compiled !== 'object') {
        errors.push({ code: 'invalid_compiled', message: 'A compiled JSON üres vagy érvénytelen.' });
        return { valid: false, errors };
    }

    // `requiredGroupSlugs` típus-ellenőrzés: ha jelen van, de nem array
    // (pl. malformed import objektummal vagy stringgel), explicit
    // `invalid_field_type` error — ne csendes fallback üres tömbre, mert
    // az hamisan VALID-ná tehetné a workflow-t (üres allowed Set + nincs
    // hivatkozott slug → trivial OK).
    let requiredGroupSlugs = [];
    if (compiled.requiredGroupSlugs != null) {
        if (Array.isArray(compiled.requiredGroupSlugs)) {
            requiredGroupSlugs = compiled.requiredGroupSlugs;
        } else {
            errors.push({
                code: 'invalid_field_type',
                location: 'requiredGroupSlugs',
                message: `A "requiredGroupSlugs" mezőnek tömbnek kell lennie (kapott: ${typeof compiled.requiredGroupSlugs === 'object' ? 'objektum' : typeof compiled.requiredGroupSlugs}).`
            });
        }
    }

    // 1. requiredGroupSlugs minden eleme kell hogy legyen `slug` mezővel,
    //    és nem lehet duplikátum.
    const allowed = new Set();
    const duplicates = new Set();
    for (let i = 0; i < requiredGroupSlugs.length; i++) {
        const entry = requiredGroupSlugs[i];
        if (!entry?.slug || typeof entry.slug !== 'string') {
            errors.push({
                code: 'invalid_required_group_entry',
                location: `requiredGroupSlugs[${i}]`,
                message: `A requiredGroupSlugs[${i}] elemnek hiányzik vagy érvénytelen a slug mezője.`
            });
            continue;
        }
        if (allowed.has(entry.slug)) {
            duplicates.add(entry.slug);
        } else {
            allowed.add(entry.slug);
        }
    }
    for (const slug of duplicates) {
        errors.push({
            code: 'duplicate_required_group_slug',
            slug,
            location: 'requiredGroupSlugs',
            message: `A requiredGroupSlugs többször tartalmazza a "${slug}" slug-ot.`
        });
    }

    // Helper: nem-array bemenetből (`null`, objektum, string) `invalid_field_type`
    // hibát ad. A fallback üres tömb kerüli a `for...of` exception-t és a
    // string-char iterálást — malformed-but-parseable import esetén tiszta
    // validation error a kimenet, nem unhandled exception.
    function asSlugArray(value, location) {
        if (value == null) return [];
        if (Array.isArray(value)) return value;
        errors.push({
            code: 'invalid_field_type',
            location,
            message: `A "${location}" mezőnek tömbnek kell lennie (kapott: ${typeof value === 'object' ? 'objektum' : typeof value}).`
        });
        return [];
    }

    function asObject(value, location) {
        if (value == null) return {};
        if (typeof value === 'object' && !Array.isArray(value)) return value;
        errors.push({
            code: 'invalid_field_type',
            location,
            message: `A "${location}" mezőnek objektumnak kell lennie (kapott: ${Array.isArray(value) ? 'tömb' : typeof value}).`
        });
        return {};
    }

    function pushUnknown(slug, location, message) {
        errors.push({ code: 'unknown_group_slug', slug, location, message });
    }

    // 2. transitions[].allowedGroups
    for (const t of asSlugArray(compiled.transitions, 'transitions')) {
        const loc = `transitions["${t?.from}"->"${t?.to}"].allowedGroups`;
        for (const slug of asSlugArray(t?.allowedGroups, loc)) {
            if (!allowed.has(slug)) {
                pushUnknown(slug, loc, `Az átmenet ("${t?.from}" → "${t?.to}") engedélyezett csoportja nem szerepel a workflow felhasználó-csoport listájában: "${slug}".`);
            }
        }
    }

    // 3. commands[stateId][*].allowedGroups
    for (const [stateId, cmds] of Object.entries(asObject(compiled.commands, 'commands'))) {
        for (const cmd of asSlugArray(cmds, `commands["${stateId}"]`)) {
            const loc = `commands["${stateId}"]["${cmd?.id}"].allowedGroups`;
            for (const slug of asSlugArray(cmd?.allowedGroups, loc)) {
                if (!allowed.has(slug)) {
                    pushUnknown(slug, loc, `A "${stateId}" állapot "${cmd?.id}" parancsának engedélyezett csoportja nem szerepel a workflow felhasználó-csoport listájában: "${slug}".`);
                }
            }
        }
    }

    // 4. elementPermissions[scope][element].groups (csak ha type === 'groups')
    for (const [scope, elems] of Object.entries(asObject(compiled.elementPermissions, 'elementPermissions'))) {
        for (const [elemKey, perm] of Object.entries(asObject(elems, `elementPermissions.${scope}`))) {
            if (perm?.type !== 'groups') continue;
            const loc = `elementPermissions.${scope}.${elemKey}.groups`;
            for (const slug of asSlugArray(perm.groups, loc)) {
                if (!allowed.has(slug)) {
                    pushUnknown(slug, loc, `Az "${scope}.${elemKey}" elem-jogosultság csoportja nem szerepel a workflow felhasználó-csoport listájában: "${slug}".`);
                }
            }
        }
    }

    // 5. leaderGroups[] (autogenerált A.1.5 óta — defense-in-depth)
    for (const slug of asSlugArray(compiled.leaderGroups, 'leaderGroups')) {
        if (!allowed.has(slug)) {
            pushUnknown(slug, 'leaderGroups', `A vezető csoport nem szerepel a workflow felhasználó-csoport listájában: "${slug}".`);
        }
    }

    // 6. statePermissions[stateId][]
    for (const [stateId, slugList] of Object.entries(asObject(compiled.statePermissions, 'statePermissions'))) {
        const loc = `statePermissions["${stateId}"]`;
        for (const slug of asSlugArray(slugList, loc)) {
            if (!allowed.has(slug)) {
                pushUnknown(slug, loc, `A "${stateId}" állapot mozgatás-engedélyezett csoportja nem szerepel a workflow felhasználó-csoport listájában: "${slug}".`);
            }
        }
    }

    // 7. contributorGroups[].slug (autogenerált A.1.5 óta — defense-in-depth)
    for (const cg of asSlugArray(compiled.contributorGroups, 'contributorGroups')) {
        if (cg?.slug && !allowed.has(cg.slug)) {
            pushUnknown(cg.slug, 'contributorGroups', `A contributor csoport nem szerepel a workflow felhasználó-csoport listájában: "${cg.slug}".`);
        }
    }

    // 8. capabilities[name][]
    for (const [name, slugList] of Object.entries(asObject(compiled.capabilities, 'capabilities'))) {
        const loc = `capabilities["${name}"]`;
        for (const slug of asSlugArray(slugList, loc)) {
            if (!allowed.has(slug)) {
                pushUnknown(slug, loc, `A "${name}" képesség csoportja nem szerepel a workflow felhasználó-csoport listájában: "${slug}".`);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Tömör, ember által olvasható összegzés a validáció hibáiból. A Designer
 * mentés-error UI-on / CF response `details` mezőjén egyaránt használható.
 *
 * @param {ValidationResult} result
 * @returns {string}
 */
function summarizeValidationErrors(result) {
    if (!result || result.valid) return '';
    const unknown = result.errors.filter(e => e.code === 'unknown_group_slug');
    const duplicates = result.errors.filter(e => e.code === 'duplicate_required_group_slug');
    const invalid = result.errors.filter(
        e => e.code !== 'unknown_group_slug' && e.code !== 'duplicate_required_group_slug'
    );

    const parts = [];
    if (unknown.length > 0) {
        const slugs = [...new Set(unknown.map(e => e.slug))].join(', ');
        parts.push(`Ismeretlen csoport-slug a workflow-ban: ${slugs}. Vedd fel a workflow felhasználó-csoport listájába (requiredGroupSlugs), vagy töröld a hivatkozó mezőkből.`);
    }
    if (duplicates.length > 0) {
        const slugs = [...new Set(duplicates.map(e => e.slug))].join(', ');
        parts.push(`Duplikált slug a requiredGroupSlugs-ban: ${slugs}.`);
    }
    if (invalid.length > 0) {
        parts.push(invalid.map(e => e.message).join(' '));
    }
    return parts.join(' ');
}

module.exports = {
    validateCompiledSlugs,
    summarizeValidationErrors
};
