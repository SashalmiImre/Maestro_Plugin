/**
 * Maestro Server — Workflow compiled JSON validátor (Fázis 1 helper-extract, 2026-05-02;
 * A.7.1 single-source refactor 2026-05-03).
 *
 * Három felelősség:
 *
 * 1. `workflowReferencesSlug` / `contributorJsonReferencesSlug` — referencia-
 *    detektálás a `delete_group` / `archive_group` blocker-scan-jéhez.
 *    A workflow compiled JSON sok mezőjében (statePermissions, transitions,
 *    commands, elementPermissions, leaderGroups, contributorGroups, capabilities,
 *    requiredGroupSlugs) hivatkozhat csoport slug-okra; ez a két helper
 *    kanonikusan végigjárja őket. CF-only logika.
 *
 * 2. `validateCompiledSlugs` — A.2.1 szerinti hard-contract: a workflow
 *    save-time (CF write-path) hibát dob, ha a workflow összes slug-mezőjének
 *    uniója nem subset-je a `requiredGroupSlugs[].slug`-nak. **Single-source**:
 *    a `packages/maestro-shared/compiledValidator.js` (ESM) a kanonikus forrás,
 *    és a `_generated_compiledValidator.js` egy automatikusan generált CJS
 *    pillanatkép. Itt csak re-export. Részletek: A.7.1 / ADR 0008.
 *
 * 3. `buildCompiledValidationFailure` — `validateCompiledSlugs` eredmény
 *    transzformációja CF response-payload-dá.
 */

const { PARSE_ERROR } = require('./constants.js');
const { validateCompiledSlugs } = require('./_generated_compiledValidator.js');

/**
 * Workflow compiled JSON slug-hivatkozás ellenőrzés a `delete_group` action-höz.
 *
 * A compiled JSON több, eltérő alakú helyen hivatkozhat csoport slug-okra
 * (a defaultWorkflow.json schémája szerint):
 *   - `statePermissions[stateId]: string[]`              (ki mozgathatja onnan)
 *   - `leaderGroups: string[]`                           (ACL bypass)
 *   - `transitions[].allowedGroups: string[]`            (átmenet végrehajtás)
 *   - `commands[stateId][].allowedGroups: string[]`      (parancsok futtatása)
 *   - `elementPermissions[kind][field].groups: string[]` (UI elem szerkesztés,
 *     csak ha type === 'groups' — 'anyMember' / egyéb típusokat átugrunk)
 *   - `contributorGroups: [{ slug, label }]`             (contributor szerepkörök;
 *     tömb stringekből is elfogadott legacy/defensiv okból)
 *   - `capabilities[capId]: string[]`                    (pl. canAddArticlePlan)
 *
 * Bármely match → true. Ismeretlen / hiányzó mezőket csendben átugorjuk, hogy
 * verziózott schema bővítés ne crash-eljen.
 *
 * @param {Object} compiled - parsed workflow compiled JSON
 * @param {string} targetSlug - a törlendő csoport slug-ja
 * @returns {boolean} true, ha a slug bárhol szerepel
 */
function workflowReferencesSlug(compiled, targetSlug) {
    if (!compiled || typeof compiled !== 'object') return false;

    // A.2.7 — requiredGroupSlugs[].slug (workflow self-defined csoport-lista,
    // A.1.5 óta). Ha a slug a workflow definíciós halmazában van (akkor is, ha
    // semelyik más mezőben nem hivatkozott), `group_in_use` blokk indokolt:
    // a workflow autoseed-elné egy új aktiválásnál, és a törlés ezt elrontaná.
    if (Array.isArray(compiled.requiredGroupSlugs)) {
        for (const entry of compiled.requiredGroupSlugs) {
            if (entry && typeof entry === 'object' && entry.slug === targetSlug) return true;
        }
    }

    // leaderGroups: string[]
    if (Array.isArray(compiled.leaderGroups) && compiled.leaderGroups.includes(targetSlug)) {
        return true;
    }

    // contributorGroups: [{ slug, label }] — legacy string[] is elfogadott
    if (Array.isArray(compiled.contributorGroups)) {
        for (const entry of compiled.contributorGroups) {
            if (typeof entry === 'string' && entry === targetSlug) return true;
            if (entry && typeof entry === 'object' && entry.slug === targetSlug) return true;
        }
    }

    // statePermissions[stateId]: string[]
    if (compiled.statePermissions && typeof compiled.statePermissions === 'object') {
        for (const slugs of Object.values(compiled.statePermissions)) {
            if (Array.isArray(slugs) && slugs.includes(targetSlug)) return true;
        }
    }

    // transitions[].allowedGroups: string[]
    if (Array.isArray(compiled.transitions)) {
        for (const t of compiled.transitions) {
            if (t && Array.isArray(t.allowedGroups) && t.allowedGroups.includes(targetSlug)) {
                return true;
            }
        }
    }

    // commands[stateId][].allowedGroups: string[]
    if (compiled.commands && typeof compiled.commands === 'object') {
        for (const cmdList of Object.values(compiled.commands)) {
            if (!Array.isArray(cmdList)) continue;
            for (const cmd of cmdList) {
                if (cmd && Array.isArray(cmd.allowedGroups) && cmd.allowedGroups.includes(targetSlug)) {
                    return true;
                }
            }
        }
    }

    // elementPermissions[kind][field]: { type, groups? }
    if (compiled.elementPermissions && typeof compiled.elementPermissions === 'object') {
        for (const kind of Object.values(compiled.elementPermissions)) {
            if (!kind || typeof kind !== 'object') continue;
            for (const descriptor of Object.values(kind)) {
                if (!descriptor || typeof descriptor !== 'object') continue;
                if (descriptor.type === 'groups' && Array.isArray(descriptor.groups)
                    && descriptor.groups.includes(targetSlug)) {
                    return true;
                }
            }
        }
    }

    // capabilities[capId]: string[]
    if (compiled.capabilities && typeof compiled.capabilities === 'object') {
        for (const slugs of Object.values(compiled.capabilities)) {
            if (Array.isArray(slugs) && slugs.includes(targetSlug)) return true;
        }
    }

    return false;
}

/**
 * A `contributors` (articles) és `defaultContributors` (publications) JSON
 * longtext mezők kulcs-szinten tárolják a csoport slug-okat (pl.
 * `{"designers": "user_abc", "writers": null}`). Ha a csoportot töröljük és
 * ilyen kulcs még van, a stranded slug kulcs láthatatlanná válik a UI-ban
 * (a dashboard csak a létező csoportokat rendereli), így ezek a rekordok
 * data-loss állapotba kerülnek. Ez a helper vizsgálja, hogy a JSON string
 * bármilyen értékkel tartalmazza-e a target slug-ot kulcsként.
 *
 * hasOwnProperty: a `null` érték is reservation — a törlés-blokk ugyanúgy
 * jogos, mintha aktív userId lenne rendelve.
 *
 * **Fail-closed parse-hibára**: sérült JSON esetén a return `PARSE_ERROR`
 * sentinel — a hívó (delete_group/archive_group) a doc-ot konzervatívan
 * blocker-listába teszi (`parseError: true` flag), különben egy korrupt
 * JSON elnyelhetné a hivatkozást és a csoport törölhetővé válna data-loss
 * veszéllyel.
 *
 * @param {string|null|undefined} contributorsJson - a mező nyers értéke
 * @param {string} targetSlug - a törlendő csoport slug-ja
 * @returns {boolean|typeof PARSE_ERROR} true (slug kulcsként megjelenik),
 *   false (nincs hivatkozás), vagy `PARSE_ERROR` (sérült JSON, hívó blokkol)
 */
function contributorJsonReferencesSlug(contributorsJson, targetSlug) {
    if (!contributorsJson || typeof contributorsJson !== 'string') return false;
    let parsed;
    try {
        parsed = JSON.parse(contributorsJson);
    } catch {
        return PARSE_ERROR;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return Object.prototype.hasOwnProperty.call(parsed, targetSlug);
}

/**
 * `validateCompiledSlugs` eredményéből 4xx CF response-t épít.
 * Az egyedi slug-okat dedupolja, location listát ad a debugoláshoz.
 *
 * @param {{ valid: boolean, errors: Array }} result
 * @returns {{ reason: string, errors: Array, unknownSlugs?: string[] }}
 */
function buildCompiledValidationFailure(result) {
    const unknown = result.errors.filter(e => e.code === 'unknown_group_slug');
    const unknownSlugs = unknown.length > 0
        ? [...new Set(unknown.map(e => e.slug).filter(Boolean))]
        : undefined;
    return {
        reason: unknown.length > 0 ? 'unknown_group_slug' : (result.errors[0]?.code || 'invalid_compiled'),
        errors: result.errors.map(e => ({ code: e.code, slug: e.slug, location: e.location, message: e.message })),
        unknownSlugs
    };
}

module.exports = {
    workflowReferencesSlug,
    contributorJsonReferencesSlug,
    validateCompiledSlugs,
    buildCompiledValidationFailure
};
