/**
 * Maestro Dashboard — közös invite-to-organization CF reason → user-friendly üzenet
 *
 * A `callInviteFunction()` `wrapped.code` mezője a CF `reason`-ját hordozza.
 * A különböző CRUD-tab-ok (csoportok / permission set-ek / aktiválás) más-más
 * reason-halmazt látnak, de jelentős az átfedés (`concurrent_modification`,
 * `insufficient_permission`, `schema_missing`, `Failed to fetch` /
 * `NetworkError`, `name_taken`). Ezt a közös réteget egy helyen tartjuk; a
 * domain-specifikus override-ok a `extra` map-ben.
 *
 * Használat:
 * ```
 * const message = mapErrorReason(err.message || err.code, {
 *   group_in_use: 'Ez a csoport használatban van...',
 *   default: (reason) => `Művelet sikertelen: ${reason}`
 * });
 * ```
 */

const COMMON_MAP = Object.freeze({
    missing_fields: 'Tölts ki minden kötelező mezőt.',
    concurrent_modification:
        'Időközben valaki más is szerkesztette ezt a rekordot. Töltsd újra és próbáld meg újra.',
    insufficient_permission: 'Nincs jogosultságod ehhez a művelethez.',
    insufficient_role: 'Nincs jogosultságod ehhez a művelethez.',
    not_a_member: 'Nem vagy tagja ennek a szervezetnek.',
    schema_missing:
        'A séma még nincs bootstrap-elve (futtasd a megfelelő bootstrap_*_schema action-t).',
    // Phase 1.6 (D blokk follow-up): a 2 status-blind CF (set-publication-root-path
    // + update-article) most fail-closed-ozza az `orphaned`/`archived` orgokat.
    org_orphaned_write_blocked:
        'A szervezet jelenleg árva állapotban van — várd meg az új tulajdonos kijelölését, mielőtt módosítanál.'
});

const NETWORK_HINT = 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';

/**
 * Reason → user-friendly üzenet feloldás.
 *
 * @param {string|undefined} reason - A CF reason vagy `Error.message`
 * @param {Object} [overrides] - Domain-specifikus reason → string vagy
 *   reason → (reason) => string mapping. Az itteni belép pre a COMMON_MAP elé.
 * @param {(reason: string) => string} [overrides.default] - opcionális default
 *   handler ha semmi sem matchel (különben a raw reason szöveget adjuk vissza).
 * @returns {string}
 */
export function mapErrorReason(reason, overrides = {}) {
    if (typeof reason !== 'string' || !reason) return 'Ismeretlen hiba történt.';

    // Domain-specifikus include-match (substring) — pl. `permission_set_slug_taken`
    // matchel a `slug_taken` overridebal is, ha a hívó megadja.
    for (const [needle, value] of Object.entries(overrides)) {
        if (needle === 'default') continue;
        if (reason.includes(needle)) {
            return typeof value === 'function' ? value(reason) : value;
        }
    }

    // Közös COMMON_MAP — substring-match (pl. `slug_immutable_violation` is matchel).
    for (const [needle, value] of Object.entries(COMMON_MAP)) {
        if (reason.includes(needle)) return value;
    }

    if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) {
        return NETWORK_HINT;
    }

    if (typeof overrides.default === 'function') return overrides.default(reason);
    return reason;
}
