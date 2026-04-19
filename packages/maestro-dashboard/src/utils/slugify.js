/**
 * Maestro Dashboard — slugify helper
 *
 * Magyar ékezetes karakterek ASCII-ra fordítása + kebab-case slug képzés.
 * A szerveroldali `slugifyName()` (invite-to-organization CF) szabályait
 * tükrözi, hogy a kliens auto-generált slug és a szerver-validáció soha
 * ne térjen el (közös unit teszttel kötjük össze, ha szükséges lesz).
 *
 * Szabályok:
 *   - kisbetűsítés
 *   - magyar ékezet → ASCII (á → a, ő → o, stb.)
 *   - egyéb diakritikus jelek lekapása (NFD + combining marks eltávolítás)
 *   - nem-alfanumerikus karakterek → '-'
 *   - több egymás utáni '-' egyesítve, kezdő/záró '-' levágva
 *   - max 64 karakter (a SLUG_MAX_LENGTH-tel egyezően)
 *
 * Üres input vagy slug-érvénytelen kimenet → üres string. A modal-oldali
 * validáció kezeli a "név túl rövid / nem generálódik slug" esetet (a
 * felhasználó kapjon érthető hibát, ne random fallback slug-ot).
 */

const SLUG_MAX_LENGTH = 64;
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const HU_ACCENT_MAP = {
    'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ö': 'o', 'ő': 'o',
    'ú': 'u', 'ü': 'u', 'ű': 'u'
};

export function slugify(name) {
    if (typeof name !== 'string') return '';
    let s = name.trim().toLowerCase();
    if (!s) return '';

    s = s.replace(/[áéíóöőúüű]/g, ch => HU_ACCENT_MAP[ch] || ch);
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    const truncated = s.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
    if (!truncated || !SLUG_REGEX.test(truncated)) return '';
    return truncated;
}

export const SLUG_CONSTRAINTS = { SLUG_MAX_LENGTH, SLUG_REGEX };
