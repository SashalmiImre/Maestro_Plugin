/**
 * Maestro — Workflow Designer közös szín-paletta
 *
 * Az alapértelmezett workflow állapotszínei és a NodePalette által
 * felkínált új állapot színek közös forrása. A `defaultWorkflow.json`
 * `states[].color` mezői ezzel az értékkel egyeznek meg, így a Designer
 * vizuális paletta-felkínálása konzisztens a már létező state-ek színeivel.
 *
 * Hex literálok upper-case-ben — a `nextAvailableColor()` case-insensitive
 * összehasonlítást végez, hogy a defaultWorkflow.json (`#FFEA00`) és egy
 * esetleges régebbi lower-case érték is „használt"-nak számítson.
 */

export const WORKFLOW_STATE_COLORS = [
    '#FFEA00', // sárga — Tervezés
    '#A4E700', // sárga-zöld — Terv ellenőrzés
    '#FF9F1C', // narancs — Elindításra vár
    '#FF3300', // piros-narancs — Szerkesztői ellenőrzés
    '#00E5FF', // cián — Korrektúrázás
    '#4096EE', // kék — Végső ellenőrzés
    '#FF40B0', // rózsaszín — Nyomdakész
    '#B366FF'  // lila — Archiválható
];

/**
 * A még nem használt első paletta szín visszaadása.
 * Ha minden szín foglalt, ciklikusan a `usedColors` hossza alapján vesz egyet.
 *
 * @param {string[]} usedColors - A már használt hex színek listája
 * @returns {string} - Hex szín (upper-case)
 */
export function nextAvailableColor(usedColors = []) {
    const used = new Set(
        (usedColors || [])
            .filter(c => typeof c === 'string')
            .map(c => c.toUpperCase())
    );
    for (const c of WORKFLOW_STATE_COLORS) {
        if (!used.has(c.toUpperCase())) return c;
    }
    return WORKFLOW_STATE_COLORS[
        (usedColors?.length || 0) % WORKFLOW_STATE_COLORS.length
    ];
}
