/**
 * Maestro Dashboard — közös szín-preset paletta
 *
 * Csoport-szín / state-szín / kategória-szín gyors-választó. A `GroupRow`
 * (csoport detail panel) és a `RequiredGroupSlugsField` (workflow designer)
 * használja, és további feature-ek (pl. workflow state node palette) is
 * idekerülhetnek, ha azonos paletta-érzetet akarnak.
 */
export const COLOR_PRESETS = Object.freeze([
    '#A0E0FF', '#B0F0B0', '#FFD580', '#FFB0B0',
    '#D0B0FF', '#FFC0E0', '#80E0E0', '#E0E080'
]);
