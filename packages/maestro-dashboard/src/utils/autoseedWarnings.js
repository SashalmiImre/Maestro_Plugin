/**
 * Maestro Dashboard — autoseed warnings helper
 *
 * Az `assign_workflow_to_publication` és `activate_publication` CF action-ök
 * `autoseed.warnings[]` mezőt adhatnak vissza (slug-collision, archivált
 * csoport, schema-fallback). Ezek non-fatal anomáliák — toast-ban
 * figyelmeztetjük a usert + console.warn-on logoljuk.
 *
 * A.4 frontend feladatkörben modal-os warning UI fogja váltani.
 */

/**
 * @param {(message: string, type: string) => void} showToast
 * @param {Array<{ code: string, slug?: string, [k: string]: any }>} warnings
 * @param {string} source - hívóhely azonosítója (`console.warn` prefix)
 */
export function showAutoseedWarnings(showToast, warnings, source) {
    if (!Array.isArray(warnings) || warnings.length === 0) return;
    const summary = warnings
        .map(w => `${w.code}${w.slug ? ` (${w.slug})` : ''}`)
        .join(', ');
    showToast(`Autoseed figyelmeztetések: ${summary}`, 'warning');
    console.warn(`[${source}] autoseed warnings:`, warnings);
}
