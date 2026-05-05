/**
 * Maestro Dashboard — ValidationListField
 *
 * Validátor multi-select chip lista (onEntry, requiredToEnter, requiredToExit).
 * A `VALIDATOR_REGISTRY`-ből listázza a beépített validátorokat, plusz a B.5.3
 * óta az office workflow extension-eket is `ext.<slug>` formában (csak
 * `kind === 'validator'` extension-ek; archivált extension a választható
 * listából kimarad, de stale ref read-only chip-ként megjelenik a `value`-ban
 * megőrzött ext.<slug>-re — Codex tervi roast 5-ös pont).
 */

import React, { useCallback, useMemo } from 'react';
import { VALIDATOR_REGISTRY } from '@shared/validatorRegistry.js';
import { isExtensionRef, EXTENSION_REF_PREFIX } from '@shared/extensionContract.js';

const VALIDATOR_IDS = Object.keys(VALIDATOR_REGISTRY);

/**
 * Validátor ID kinyerése (string vagy { validator, options } objektum).
 */
function getValidatorId(v) {
    return typeof v === 'string' ? v : v?.validator;
}

/**
 * @param {Object} props
 * @param {string} props.label - Mező címke
 * @param {string} [props.helpText] - Magyarázó szöveg a label alatt (#66)
 * @param {Array} props.value - Kiválasztott validátorok (string[] vagy object[])
 * @param {Function} props.onChange - (Array) => void
 * @param {Array<{slug: string, name: string, kind: string, archivedAt: string|null}>} [props.extensions]
 *   - Az office workflow extension-listája (B.5.3). Csak `kind === 'validator'`-ra
 *   szűrve render. Az archivált (`archivedAt !== null`) NEM jelenik meg
 *   választhatónak, de a `value`-ban benne lévő stale ref-eket
 *   read-only chip-ként mutatjuk.
 * @param {boolean} [props.disabled] - Letiltott módban a chip-ek nem kattinthatók
 */
export default function ValidationListField({ label, helpText, value = [], onChange, extensions, disabled = false }) {
    const selectedIds = useMemo(() => new Set(value.map(getValidatorId)), [value]);

    // ── Built-in + extension chip-lista ─────────────────────────────────────
    // Minden chip egységes alakkal: `{ id, label, title, isExtension, isStale }`.
    // - Built-in (registry): isExtension=false, isStale=false.
    // - Active extension (archivedAt=null): isExtension=true, isStale=false.
    // - Stale ref (value-ban van, de NINCS extensions[]-ben vagy archivált):
    //   isExtension=true, isStale=true → chip read-only, X-szel eltávolítható
    //   (különben az archivált hivatkozás csendben eltűnne és a workflow
    //   megérthetősége csorbulna — Codex tervi roast 5-ös pont).
    const chipOptions = useMemo(() => {
        const list = [];

        // Built-in validátorok.
        for (const id of VALIDATOR_IDS) {
            list.push({
                id,
                label: VALIDATOR_REGISTRY[id].label,
                title: VALIDATOR_REGISTRY[id].description,
                isExtension: false,
                isStale: false
            });
        }

        // Aktív extension validátorok (csak `kind === 'validator'`).
        const validatorExtensionsBySlug = new Map();
        for (const ext of (extensions || [])) {
            if (ext?.kind !== 'validator') continue;
            validatorExtensionsBySlug.set(ext.slug, ext);
        }
        for (const ext of validatorExtensionsBySlug.values()) {
            if (ext.archivedAt) continue;
            list.push({
                id: `${EXTENSION_REF_PREFIX}${ext.slug}`,
                label: ext.name || ext.slug,
                title: `Bővítmény: ext.${ext.slug}`,
                isExtension: true,
                isStale: false
            });
        }

        // Stale ref-ek a value-ból: olyan ext.<slug>-ek, amik vagy archiváltak
        // vagy hiányoznak az office aktuális extension-listájából. Ezeket
        // megtartjuk a UI-ban, hogy a workflow átláthatósága ne sérüljön.
        for (const item of value) {
            const id = getValidatorId(item);
            if (typeof id !== 'string') continue;
            if (!isExtensionRef(id)) continue;
            const slug = id.slice(EXTENSION_REF_PREFIX.length);
            const ext = validatorExtensionsBySlug.get(slug);
            const isMissing = !ext;
            const isArchived = ext && !!ext.archivedAt;
            if (!isMissing && !isArchived) continue; // aktív, már fent van.
            list.push({
                id,
                label: ext?.name || slug,
                title: isMissing
                    ? `Hivatkozott bővítmény nem található (${id}). Új workflow-ban inkább távolítsd el.`
                    : `Archivált bővítmény (${id}) — nem futtatható, amíg vissza nem állítod.`,
                isExtension: true,
                isStale: true
            });
        }

        return list;
    }, [extensions, value]);

    const handleToggle = useCallback((validatorId, isStale) => {
        if (selectedIds.has(validatorId)) {
            // Eltávolítás — megtartjuk az eredeti objektumot a többi elemben
            onChange(value.filter(v => getValidatorId(v) !== validatorId));
        } else {
            if (isStale) return; // stale chip-et nem lehet hozzáadni; csak X-szel eltávolítani.
            // Hozzáadás — string formában (options nélkül)
            // Ha a felhasználó korábban options-szel rendelkező validátort
            // kapcsol vissza, az options elvész (ez elfogadható, mert
            // az options szerkesztése még nincs implementálva a UI-ban)
            onChange([...value, validatorId]);
        }
    }, [value, selectedIds, onChange]);

    return (
        <div className="designer-field">
            {label && <label className="designer-field__label">{label}</label>}
            {helpText && <p className="designer-field__help">{helpText}</p>}
            <div className="designer-field__chips">
                {chipOptions.map(opt => {
                    const isActive = selectedIds.has(opt.id);
                    const className = [
                        'designer-chip',
                        isActive ? 'designer-chip--active' : '',
                        opt.isExtension ? 'designer-chip--extension' : '',
                        opt.isStale ? 'designer-chip--stale' : ''
                    ].filter(Boolean).join(' ');
                    return (
                        <button
                            key={opt.id}
                            type="button"
                            className={className}
                            onClick={() => handleToggle(opt.id, opt.isStale)}
                            title={opt.title}
                            disabled={disabled || (opt.isStale && !isActive)}
                        >
                            {opt.isExtension && <span aria-hidden="true">⚙ </span>}
                            {opt.label}
                            {opt.isStale && <span aria-label="archivált / hiányzó" title={opt.title}> ⚠</span>}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
