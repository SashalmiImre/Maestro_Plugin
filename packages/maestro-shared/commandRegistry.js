/**
 * Maestro Shared — Command Registry
 *
 * Parancs ID → megjelenítési név leképezés.
 * A Dashboard designer UI-ja innen listázza az elérhető parancsokat;
 * az InDesign plugin a command handler-ek regisztrálásánál hivatkozik rá.
 *
 * Új parancs = új bejegyzés itt + új handler a plugin
 * `src/core/commands/handlers/` mappájában.
 *
 * @module shared/commandRegistry
 */

/**
 * Az összes elérhető parancs definíciója.
 *
 * @type {Object.<string, { label: string, description?: string }>}
 */
export const COMMAND_REGISTRY = {
    export_pdf:              { label: 'PDF írás',                 description: 'PDF export az aktuális beállításokkal' },
    export_final_pdf:        { label: 'Végleges PDF írás',        description: 'Nyomdakész PDF generálás' },
    collect_images:          { label: 'Képek összegyűjtése',      description: 'A dokumentum összes képének összegyűjtése' },
    collect_selected_images: { label: 'Kijelölt képek gyűjtése',  description: 'Csak a kijelölt képek összegyűjtése' },
    preflight_check:         { label: 'Preflight',                description: 'Preflight ellenőrzés futtatása' },
    archive:                 { label: 'Archiválás',               description: 'Teljes kiadvány archiválása' },
    print_output:            { label: 'Levilágítás',              description: 'Nyomtatási kimenet generálás' }
};

/**
 * Visszaadja egy parancs megjelenített címkéjét.
 *
 * @param {string} commandId
 * @returns {string}
 */
export function getCommandLabel(commandId) {
    return COMMAND_REGISTRY[commandId]?.label ?? commandId;
}
