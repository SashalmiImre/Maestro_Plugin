/**
 * Maestro Dashboard — LayoutsTab
 *
 * A PublicationSettingsModal „Layoutok" füle. A plugin LayoutsSection portja.
 *
 * Funkciók:
 *   - Layout lista: név (blur mentés) + szín swatch (color picker) + törlés
 *   - Új layout hozzáadása auto A/B/C… névvel
 *   - Törlés cikk-átrendeléssel: ha vannak érintett cikkek, kérdez a cél layoutról
 *   - Utolsó layout törlése tiltva
 */

import React, { useState, useMemo } from 'react';
import { useData } from '../../contexts/DataContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';

const DEFAULT_COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0891b2', '#65a30d'];

/** Következő szabad A–Z betű a meglévő nevek alapján. */
function getNextLayoutName(existing) {
    const taken = new Set(existing.map((l) => (l.name || '').toUpperCase()));
    for (let c = 65; c <= 90; c++) {
        const letter = String.fromCharCode(c);
        if (!taken.has(letter)) return letter;
    }
    return `L${existing.length + 1}`;
}

/** A meglévő layoutok számához igazított szín a default palettából. */
function getNextColor(existing) {
    return DEFAULT_COLORS[existing.length % DEFAULT_COLORS.length];
}

export default function LayoutsTab({ publication }) {
    const { articles, layouts, createLayout, updateLayout, deleteLayout } = useData();
    const { showToast } = useToast();
    const confirm = useConfirm();

    // Lokális state az inline név szerkesztéshez
    const [localNames, setLocalNames] = useState({});
    const [isBusy, setIsBusy] = useState(false);

    // Csak az aktív publikációhoz tartozó layoutok
    const pubLayouts = useMemo(
        () => layouts.filter((l) => l.publicationId === publication.$id),
        [layouts, publication.$id]
    );

    function getDisplayName(layout) {
        return localNames[layout.$id] !== undefined ? localNames[layout.$id] : (layout.name || '');
    }

    async function handleNameBlur(layout) {
        const local = localNames[layout.$id];
        if (local === undefined) return;

        const trimmed = local.trim();
        if (!trimmed || trimmed === layout.name) {
            setLocalNames((prev) => {
                const next = { ...prev };
                delete next[layout.$id];
                return next;
            });
            return;
        }

        try {
            await updateLayout(layout.$id, { name: trimmed });
            setLocalNames((prev) => {
                const next = { ...prev };
                delete next[layout.$id];
                return next;
            });
        } catch (err) {
            console.error('[LayoutsTab] Rename failed:', err);
            showToast(`Átnevezés sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
        }
    }

    async function handleColorChange(layout, color) {
        if (color === layout.color) return;
        try {
            await updateLayout(layout.$id, { color });
        } catch (err) {
            console.error('[LayoutsTab] Color change failed:', err);
            showToast(`Szín mentése sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
        }
    }

    async function handleAddLayout() {
        if (isBusy) return;
        setIsBusy(true);
        try {
            await createLayout({
                publicationId: publication.$id,
                name: getNextLayoutName(pubLayouts),
                color: getNextColor(pubLayouts),
                order: pubLayouts.length
            });
            showToast('Új layout létrehozva', 'success');
        } catch (err) {
            console.error('[LayoutsTab] Create failed:', err);
            showToast(`Layout létrehozása sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
        } finally {
            setIsBusy(false);
        }
    }

    async function handleDelete(layout) {
        if (isBusy) return;
        if (pubLayouts.length <= 1) {
            showToast('Minden kiadványnak legalább egy layout-ja kell legyen.', 'warning');
            return;
        }

        const affected = articles.filter((a) => a.layoutId === layout.$id);

        // Cél layout meghatározása az áthelyezéshez: az első másik layout
        const otherLayouts = pubLayouts.filter((l) => l.$id !== layout.$id);
        const defaultTarget = otherLayouts[0];

        let message;
        if (affected.length === 0) {
            message = `Biztosan törlöd a(z) „${layout.name}" layoutot?`;
        } else {
            message = `A(z) „${layout.name}" layouton ${affected.length} cikk van. Törlés esetén ezek átkerülnek a „${defaultTarget?.name}" layoutra.`;
        }

        const ok = await confirm({
            title: 'Layout törlése',
            message,
            confirmLabel: 'Törlés',
            variant: 'danger'
        });
        if (!ok) return;

        setIsBusy(true);
        try {
            await deleteLayout(layout.$id, defaultTarget?.$id || null);
            showToast('Layout törölve', 'success');
        } catch (err) {
            console.error('[LayoutsTab] Delete failed:', err);
            showToast(`Törlés sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
        } finally {
            setIsBusy(false);
        }
    }

    return (
        <div className="publication-form">
            {pubLayouts.length === 0 && (
                <div className="form-empty-state">
                    Ehhez a kiadványhoz még nincs layout létrehozva.
                </div>
            )}

            {pubLayouts.map((layout) => (
                <div key={layout.$id} className="layout-row">
                    <label className="layout-color-swatch" title="Kattints a szín módosításához">
                        <span
                            className="layout-color-circle"
                            style={{ background: layout.color || '#666' }}
                        />
                        <input
                            type="color"
                            value={layout.color || '#2563eb'}
                            onChange={(e) => handleColorChange(layout, e.target.value)}
                            className="color-picker-input"
                        />
                    </label>
                    <input
                        type="text"
                        className="layout-name-input"
                        value={getDisplayName(layout)}
                        onChange={(e) =>
                            setLocalNames((prev) => ({ ...prev, [layout.$id]: e.target.value }))
                        }
                        onBlur={() => handleNameBlur(layout)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                            if (e.key === 'Escape') {
                                setLocalNames((prev) => {
                                    const next = { ...prev };
                                    delete next[layout.$id];
                                    return next;
                                });
                                e.currentTarget.blur();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="btn-danger-icon"
                        onClick={() => handleDelete(layout)}
                        disabled={isBusy || pubLayouts.length <= 1}
                        title={pubLayouts.length <= 1 ? 'Minden kiadványnak legalább egy layout-ja kell legyen.' : 'Layout törlése'}
                        aria-label="Layout törlése"
                    >
                        ✕
                    </button>
                </div>
            ))}

            <button
                type="button"
                className="btn-secondary btn-add-row"
                onClick={handleAddLayout}
                disabled={isBusy}
            >
                + Új layout
            </button>
        </div>
    );
}
