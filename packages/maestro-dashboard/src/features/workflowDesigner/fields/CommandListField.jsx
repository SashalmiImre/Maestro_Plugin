/**
 * Maestro Dashboard — CommandListField
 *
 * Parancs lista szerkesztő: hozzáadás dropdown + allowedGroups per parancs.
 * A `COMMAND_REGISTRY`-ből listázza a beépített parancsokat, plusz a B.5.3 óta
 * az office workflow extension-eket is `ext.<slug>` formában (csak
 * `kind === 'command'` extension-ek; archivált extension a választható
 * dropdown-ból kimarad, de stale ref read-only sorként megjelenik a `value`-ban
 * megőrzött ext.<slug>-re — Codex tervi roast 5-ös pont).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { COMMAND_REGISTRY } from '@shared/commandRegistry.js';
import { isExtensionRef, EXTENSION_REF_PREFIX } from '@shared/extensionContract.js';

const COMMAND_IDS = Object.keys(COMMAND_REGISTRY);

/**
 * @param {Object} props
 * @param {string} props.label - Mező címke
 * @param {Object[]} props.value - [{ id, allowedGroups }]
 * @param {string[]} props.availableGroups - Elérhető csoport slug-ok
 * @param {Function} props.onChange - (Object[]) => void
 * @param {Array<{slug: string, name: string, kind: string, archivedAt: string|null}>} [props.extensions]
 *   - Az office workflow extension-listája (B.5.3). Csak `kind === 'command'`-ra
 *   szűrve. Az archivált extension a "+ Új parancs" dropdown-ból kimarad,
 *   de a value-ban megőrzött stale ref-eket sorként (allowedGroups-ostul)
 *   megmutatjuk olvashatatlan / vasrúd ⚠ jelzéssel.
 * @param {boolean} [props.disabled] - Letiltott módban a vezérlők nem használhatók
 */
export default function CommandListField({ label, value = [], availableGroups = [], onChange, extensions, disabled = false }) {
    const [addingId, setAddingId] = useState('');
    const usedIds = useMemo(() => new Set(value.map(c => c.id)), [value]);

    // ── Built-in + aktív extension command-lookup ─────────────────────────
    // A `commandLookup` a chip-render label-feloldásához kell: built-in slug
    // → registry.label, ext.<slug> → ext.name; stale ref-nél csak a slug,
    // és egy ⚠ jelzés.
    const { activeOptions, commandLookup } = useMemo(() => {
        const lookup = new Map(); // id → { label, isExtension, isStale }
        for (const id of COMMAND_IDS) {
            lookup.set(id, {
                label: COMMAND_REGISTRY[id].label,
                isExtension: false,
                isStale: false
            });
        }

        const commandExtensionsBySlug = new Map();
        for (const ext of (extensions || [])) {
            if (ext?.kind !== 'command') continue;
            commandExtensionsBySlug.set(ext.slug, ext);
        }
        for (const ext of commandExtensionsBySlug.values()) {
            if (ext.archivedAt) continue;
            lookup.set(`${EXTENSION_REF_PREFIX}${ext.slug}`, {
                label: ext.name || ext.slug,
                isExtension: true,
                isStale: false
            });
        }

        // Stale ref-ek a value-ból a label-feloldáshoz (ne mutassuk üresen).
        for (const cmd of value) {
            const id = cmd.id;
            if (typeof id !== 'string' || !isExtensionRef(id)) continue;
            const slug = id.slice(EXTENSION_REF_PREFIX.length);
            const ext = commandExtensionsBySlug.get(slug);
            const isMissing = !ext;
            const isArchived = ext && !!ext.archivedAt;
            if (!isMissing && !isArchived) continue;
            lookup.set(id, {
                label: ext?.name || slug,
                isExtension: true,
                isStale: true
            });
        }

        // A "+ Új parancs" dropdown-ba CSAK az aktív (built-in + nem-archivált
        // extension), még nem hozzáadott option-öket tesszük.
        const opts = [];
        for (const id of COMMAND_IDS) {
            if (usedIds.has(id)) continue;
            opts.push({ id, label: COMMAND_REGISTRY[id].label, isExtension: false });
        }
        for (const ext of commandExtensionsBySlug.values()) {
            if (ext.archivedAt) continue;
            const id = `${EXTENSION_REF_PREFIX}${ext.slug}`;
            if (usedIds.has(id)) continue;
            opts.push({ id, label: ext.name || ext.slug, isExtension: true });
        }
        return { activeOptions: opts, commandLookup: lookup };
    }, [extensions, value, usedIds]);

    const handleAdd = useCallback(() => {
        if (!addingId || usedIds.has(addingId)) return;
        onChange([...value, { id: addingId, allowedGroups: [] }]);
        setAddingId('');
    }, [addingId, usedIds, value, onChange]);

    const handleRemove = useCallback((commandId) => {
        onChange(value.filter(c => c.id !== commandId));
    }, [value, onChange]);

    const handleGroupsChange = useCallback((commandId, groups) => {
        onChange(value.map(c => c.id === commandId ? { ...c, allowedGroups: groups } : c));
    }, [value, onChange]);

    const isEmpty = value.length === 0;

    return (
        <div className="designer-field">
            {label && <label className="designer-field__label">{label}</label>}

            {/* #71: empty state hint — egyértelműsíti, hogy lent a dropdown-ban
                lehet parancsot hozzáadni (ha nincs hozzáadott parancs még). */}
            {isEmpty && activeOptions.length > 0 && !disabled && (
                <p className="designer-field__empty-hint">
                    Még nincs parancs hozzáadva. Válassz egyet lentről a hozzáadáshoz.
                </p>
            )}

            {/* Meglévő parancsok */}
            {value.map(cmd => {
                const meta = commandLookup.get(cmd.id) || {
                    label: cmd.id,
                    isExtension: isExtensionRef(cmd.id),
                    isStale: isExtensionRef(cmd.id) // ismeretlen ext.<slug> → stale
                };
                const headerClass = [
                    'designer-field__command-name',
                    meta.isExtension ? 'designer-field__command-name--extension' : '',
                    meta.isStale ? 'designer-field__command-name--stale' : ''
                ].filter(Boolean).join(' ');
                return (
                    <div key={cmd.id} className="designer-field__command-item">
                        <div className="designer-field__command-header">
                            <span
                                className={headerClass}
                                title={meta.isStale
                                    ? `Archivált vagy hiányzó bővítmény (${cmd.id}) — nem futtatható, amíg vissza nem állítod.`
                                    : meta.isExtension
                                        ? `Bővítmény: ${cmd.id}`
                                        : undefined}
                            >
                                {meta.isExtension && <span aria-hidden="true">⚙ </span>}
                                {meta.label}
                                {meta.isStale && <span aria-label="archivált / hiányzó"> ⚠</span>}
                            </span>
                            <button
                                type="button"
                                className="designer-field__remove-btn"
                                onClick={() => handleRemove(cmd.id)}
                                title="Parancs eltávolítása"
                                aria-label={`${meta.label} parancs eltávolítása`}
                                disabled={disabled}
                            >
                                <span aria-hidden="true">✕</span>
                            </button>
                        </div>
                        <div className="designer-field__chips">
                            {availableGroups.map(slug => (
                                <button
                                    key={slug}
                                    type="button"
                                    className={`designer-chip designer-chip--small ${
                                        cmd.allowedGroups.includes(slug) ? 'designer-chip--active' : ''
                                    }`}
                                    onClick={() => {
                                        const next = cmd.allowedGroups.includes(slug)
                                            ? cmd.allowedGroups.filter(g => g !== slug)
                                            : [...cmd.allowedGroups, slug];
                                        handleGroupsChange(cmd.id, next);
                                    }}
                                    disabled={disabled}
                                >
                                    {slug}
                                </button>
                            ))}
                        </div>
                    </div>
                );
            })}

            {/* Új parancs hozzáadás */}
            {activeOptions.length > 0 && !disabled && (
                <div className="designer-field__add-row">
                    <select
                        value={addingId}
                        onChange={e => setAddingId(e.target.value)}
                        className="designer-field__select"
                    >
                        <option value="">Parancs kiválasztása...</option>
                        {activeOptions.map(opt => (
                            <option key={opt.id} value={opt.id}>
                                {opt.isExtension ? '⚙ ' : ''}{opt.label}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="designer-field__add-btn"
                        onClick={handleAdd}
                        disabled={!addingId}
                        aria-label="Kiválasztott parancs hozzáadása"
                    >
                        <span aria-hidden="true">+</span>
                    </button>
                </div>
            )}
        </div>
    );
}
