/**
 * Maestro Shared — Contributor JSON segédfüggvények
 *
 * Parse/serialize a `contributors` (articles) és `defaultContributors`
 * (publications) longtext JSON mezőkhöz.
 *
 * A JSON kulcsok csoport slug-ok (pl. "designers", "writers").
 * Érték: userId string vagy null.
 *
 * Példa: '{"designers":"user_abc","editors":"user_def"}'
 *
 * Pure utility — nincs framework-függés. Plugin, Dashboard és CF egyaránt használja.
 */

/**
 * A contributors JSON stringet objektummá parse-olja.
 *
 * @param {string|null|undefined} contributorsJson - JSON string vagy null
 * @returns {Object.<string, string|null>} slug → userId mapping (üres objektum hiba esetén)
 */
export function parseContributors(contributorsJson) {
    if (!contributorsJson) return {};
    try {
        const parsed = JSON.parse(contributorsJson);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        return parsed;
    } catch {
        return {};
    }
}

/**
 * Kiolvas egy contributor userId-t a JSON stringből.
 *
 * @param {string|null|undefined} contributorsJson - JSON string
 * @param {string} slug - Csoport slug (pl. "designers")
 * @returns {string|null} userId vagy null
 */
export function getContributor(contributorsJson, slug) {
    const parsed = parseContributors(contributorsJson);
    return parsed[slug] || null;
}

/**
 * Beállít egy contributor userId-t és visszaadja az új JSON stringet.
 * Ha a userId null, a slug kulcsot eltávolítja az objektumból.
 *
 * @param {string|null|undefined} contributorsJson - Meglévő JSON string
 * @param {string} slug - Csoport slug
 * @param {string|null} userId - Az új userId (null = eltávolítás)
 * @returns {string} Frissített JSON string
 */
export function setContributor(contributorsJson, slug, userId) {
    const parsed = parseContributors(contributorsJson);
    if (userId) {
        parsed[slug] = userId;
    } else {
        delete parsed[slug];
    }
    return JSON.stringify(parsed);
}

/**
 * Ellenőrzi, hogy a userId bármely contributor-ként szerepel-e.
 *
 * @param {string|null|undefined} contributorsJson - JSON string
 * @param {string} userId - Keresett userId
 * @param {string[]} [slugs] - Opcionálisan szűkítés adott slug-okra.
 *   Ha megadva, csak a felsorolt slug-okat vizsgálja.
 * @returns {boolean}
 */
export function isContributor(contributorsJson, userId, slugs) {
    if (!userId) return false;
    const parsed = parseContributors(contributorsJson);
    const entries = slugs
        ? slugs.map(s => [s, parsed[s]])
        : Object.entries(parsed);
    return entries.some(([, val]) => val === userId);
}
