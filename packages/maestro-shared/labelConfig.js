/**
 * Maestro Shared — Capability-based Label Konfiguráció
 *
 * Központi, deklaratív konfiguráció a felhasználói label-ekhez.
 * Minden label egy képességet fejez ki (can + ige + tárgy, camelCase).
 *
 * Két típusú capability:
 * 1. **Csapat-ekvivalens** (grantTeams): A label a megadott csapat(ok) jogait adja.
 * 2. **Exkluzív** (exclusive): Egyedi képesség, amit csapattagsággal nem lehet megkapni.
 *
 * FONTOS: Ha új label-t adsz hozzá, frissítsd a VALID_LABELS listát a
 * validate-labels Cloud Function-ben is: appwrite_functions/validate-labels/src/main.js
 *
 * @module shared/labelConfig
 */

// ─── Capability Label Konfiguráció ─────────────────────────────────────────

/**
 * Az összes érvényes capability label definíciója.
 *
 * @type {Object.<string, { grantTeams?: string[], exclusive?: boolean, description: string }>}
 */
export const CAPABILITY_LABELS = {
    // ─── Csapat-ekvivalens képességek ───────────────────────────
    canUseDesignerFeatures:  { grantTeams: ['designers'],        description: 'Tervezői funkciók használata' },
    canApproveDesigns:       { grantTeams: ['art_directors'],    description: 'Tervek jóváhagyása' },
    canEditContent:          { grantTeams: ['editors'],          description: 'Szerkesztői funkciók' },
    canManageEditorial:      { grantTeams: ['managing_editors'], description: 'Vezetőszerkesztői jogok' },
    canProofread:            { grantTeams: ['proofwriters'],     description: 'Korrektúrázás' },
    canWriteArticles:        { grantTeams: ['writers'],          description: 'Íráshoz való hozzáférés' },
    canEditImages:           { grantTeams: ['image_editors'],    description: 'Képszerkesztői hozzáférés' },

    // ─── Összetett képességek (több csapat jogát adja) ──────────
    canUseEditorFeatures:    { grantTeams: ['editors'],          description: 'Szerkesztői UI jogok (pl. tördelőnek)' },

    // ─── Exkluzív képességek (nincs csapat-ekvivalens) ──────────
    canAddArticlePlan:       { exclusive: true, description: 'Cikk terv hozzáadása InDesign fájl nélkül' },
};

// ─── Validáció ─────────────────────────────────────────────────────────────

/**
 * Érvényes label nevek halmaza — elütésvédelemhez.
 * @type {Set<string>}
 */
export const VALID_LABELS = new Set(Object.keys(CAPABILITY_LABELS));

/**
 * Ellenőrzi, hogy egy label név érvényes-e.
 *
 * @param {string} label - Az ellenőrizendő label név.
 * @returns {boolean}
 */
export function isValidLabel(label) {
    return VALID_LABELS.has(label);
}

// ─── Feloldás ──────────────────────────────────────────────────────────────

/**
 * Feloldja a felhasználó capability label-jeit csapat slug-okra.
 * Visszaad egy Set-et az összes „virtuális" csapat slug-gal,
 * amelyeket a label-ek adnak.
 *
 * @param {string[]} userLabels - A felhasználó Appwrite label-jei.
 * @returns {Set<string>} A label-ek által adott csapat slug-ok.
 */
export function resolveGrantedTeams(userLabels) {
    const granted = new Set();
    for (const label of userLabels) {
        const config = CAPABILITY_LABELS[label];
        if (config?.grantTeams) {
            for (const team of config.grantTeams) {
                granted.add(team);
            }
        }
    }
    return granted;
}

/**
 * Ellenőrzi, hogy a felhasználó rendelkezik-e egy adott capability-vel.
 * Exkluzív és csapat-ekvivalens capability-knél egyaránt működik.
 *
 * @param {string[]} userLabels - A felhasználó Appwrite label-jei.
 * @param {string} capabilityName - A capability neve (pl. 'canAddArticlePlan').
 * @returns {boolean}
 */
export function hasCapability(userLabels, capabilityName) {
    return userLabels.includes(capabilityName);
}
