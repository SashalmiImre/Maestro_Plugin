import React, { useState } from "react";

// Components
import { CollapsibleSection } from "../../../common/CollapsibleSection.jsx";
import { ValidatedTextField } from "../../../common/ValidatedTextField.jsx";
import { ConfirmDialog } from "../../../common/ConfirmDialog.jsx";

// Contexts & Hooks
import { useLayouts } from "../../../../data/hooks/useLayouts.js";
import { useToast } from "../../../common/Toast/ToastContext.jsx";

// Config & Constants
import { STORAGE_KEYS } from "../../../../core/utils/constants.js";

// Utils
import { logError } from "../../../../core/utils/logger.js";
import { isValidFileName } from "../../../../core/utils/pathUtils.js";

/**
 * LayoutsSection Component
 *
 * A kiadvány elrendezéseinek (layoutok) kezelése.
 * Funkciók:
 * - Layout lista megjelenítése (szerkeszthető név + export ID + törlés gomb)
 * - Új layout hozzáadása
 * - Layout átnevezése (Enter/blur mentés)
 * - Layout export ID szerkesztése (Enter/blur mentés, fájlnév-validációval)
 * - Layout törlése (megerősítés szükséges, ha cikkek vannak rajta)
 * - Az utolsó layout nem törölhető
 *
 * @param {Object} props
 * @param {Object} props.publication - A kiadvány objektum
 */
export const LayoutsSection = ({ publication }) => {
    const { layouts, createLayout, renameLayout, updateExportId, deleteLayout } = useLayouts();
    const { showToast } = useToast();

    // Lokális state a layout nevekhez (Enter/blur mentéshez)
    const [localNames, setLocalNames] = useState({});

    // Lokális state az export ID-khoz (Enter/blur mentéshez)
    const [localExportIds, setLocalExportIds] = useState({});

    // Művelet folyamatban (dupla kattintás elleni védelem)
    const [isBusy, setIsBusy] = useState(false);

    // Törlés megerősítés dialog
    const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, layoutId: null, layoutName: "" });

    // ═══════════════════════════════════════════════════════════════════════════
    // Név kezelés
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Lokális név frissítése egy adott layouthoz.
     */
    const handleNameInput = (layoutId, value) => {
        setLocalNames(prev => ({ ...prev, [layoutId]: value }));
    };

    /**
     * Lokális név lekérése (ha van), egyébként a szerver érték.
     */
    const getDisplayName = (layout) => {
        return localNames[layout.$id] !== undefined ? localNames[layout.$id] : layout.name;
    };

    /**
     * Layout név mentése Enter/blur-kor.
     */
    const handleRenameSave = async (layoutId, originalName) => {
        const newName = localNames[layoutId];
        // Ha nincs lokális módosítás vagy ugyanaz, nem kell menteni
        if (newName === undefined || newName === originalName) return;

        if (!newName.trim()) {
            // Üres név → visszaállítás
            setLocalNames(prev => {
                const next = { ...prev };
                delete next[layoutId];
                return next;
            });
            return;
        }

        try {
            await renameLayout(layoutId, newName.trim());
            showToast('Elrendezés átnevezve', 'success');
            // Lokális state törlése (a szerver érték frissül Realtime-on)
            setLocalNames(prev => {
                const next = { ...prev };
                delete next[layoutId];
                return next;
            });
        } catch (error) {
            logError('[LayoutsSection] Rename failed:', error);
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Export ID kezelés
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Lokális export ID frissítése egy adott layouthoz.
     */
    const handleExportIdInput = (layoutId, value) => {
        setLocalExportIds(prev => ({ ...prev, [layoutId]: value }));
    };

    /**
     * Lokális export ID lekérése (ha van), egyébként a szerver érték.
     * Ha a szerver érték sem létezik, a layout neve az alapérték.
     */
    const getDisplayExportId = (layout) => {
        if (localExportIds[layout.$id] !== undefined) return localExportIds[layout.$id];
        return layout.exportId ?? layout.name;
    };

    /**
     * Export ID mentése Enter/blur-kor.
     */
    const handleExportIdSave = async (layoutId, originalExportId) => {
        const newExportId = localExportIds[layoutId];
        // Ha nincs lokális módosítás vagy ugyanaz, nem kell menteni
        if (newExportId === undefined || newExportId === originalExportId) return;

        const trimmed = (newExportId || "").trim();

        if (!trimmed || !isValidFileName(trimmed)) {
            // Üres vagy érvénytelen → visszaállítás
            setLocalExportIds(prev => {
                const next = { ...prev };
                delete next[layoutId];
                return next;
            });
            return;
        }

        try {
            await updateExportId(layoutId, trimmed);
            showToast('Export ID mentve', 'success');
            // Lokális state törlése (a szerver érték frissül Realtime-on)
            setLocalExportIds(prev => {
                const next = { ...prev };
                delete next[layoutId];
                return next;
            });
        } catch (error) {
            logError('[LayoutsSection] Export ID save failed:', error);
        }
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Layout létrehozás & törlés
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Új layout hozzáadása.
     * Az automatikus név az ábécé következő betűje.
     */
    const handleAddLayout = async () => {
        if (isBusy) return;

        // Következő betű generálása (A, B, C, ...)
        const existingNames = layouts.map(l => l.name);
        let nextName = "A";
        for (let charCode = 65; charCode <= 90; charCode++) {
            const letter = String.fromCharCode(charCode);
            if (!existingNames.includes(letter)) {
                nextName = letter;
                break;
            }
        }

        setIsBusy(true);
        try {
            await createLayout(publication.$id, nextName);
            showToast('Új elrendezés létrehozva', 'success');
        } catch (error) {
            logError('[LayoutsSection] Create failed:', error);
        } finally {
            setIsBusy(false);
        }
    };

    /**
     * Layout törlés indítása (megerősítés kérés).
     */
    const handleDeleteRequest = (layout) => {
        setDeleteConfirm({
            isOpen: true,
            layoutId: layout.$id,
            layoutName: layout.name
        });
    };

    /**
     * Törlés megerősítése.
     */
    const handleDeleteConfirm = async () => {
        if (isBusy) return;

        const { layoutId } = deleteConfirm;
        setDeleteConfirm({ isOpen: false, layoutId: null, layoutName: "" });

        setIsBusy(true);
        try {
            await deleteLayout(layoutId);
            showToast('Elrendezés törölve', 'success');
        } catch (error) {
            logError('[LayoutsSection] Delete failed:', error);
        } finally {
            setIsBusy(false);
        }
    };

    /**
     * Törlés megszakítása.
     */
    const handleDeleteCancel = () => {
        setDeleteConfirm({ isOpen: false, layoutId: null, layoutName: "" });
    };

    const isLastLayout = layouts.length <= 1;

    return (
        <>
            <CollapsibleSection
                title="ELRENDEZÉSEK"
                storageKey={STORAGE_KEYS.SECTION_PUB_LAYOUTS_COLLAPSED}
            >
                <div style={{ display: "flex", flexDirection: "column" }}>
                    {/* Layout lista */}
                    {layouts.map((layout) => (
                        <div
                            key={layout.$id}
                            style={{
                                display: "flex",
                                alignItems: "flex-end",
                                marginBottom: "6px"
                            }}
                        >
                            <div style={{ flex: 1, marginRight: "8px" }}>
                                <sp-label>Név</sp-label>
                                <ValidatedTextField
                                    id={`layout-name-${layout.$id}`}
                                    type="text"
                                    value={getDisplayName(layout)}
                                    onInput={(e) => handleNameInput(layout.$id, e.target.value)}
                                    onValidate={() => handleRenameSave(layout.$id, layout.name)}
                                    style={{ width: "100%" }}
                                />
                            </div>
                            <div style={{ flex: 1, marginRight: "8px" }}>
                                <sp-label>Export ID</sp-label>
                                <ValidatedTextField
                                    id={`layout-export-id-${layout.$id}`}
                                    type="text"
                                    value={getDisplayExportId(layout)}
                                    onInput={(e) => handleExportIdInput(layout.$id, e.target.value)}
                                    onValidate={() => handleExportIdSave(layout.$id, layout.exportId ?? layout.name)}
                                    invalid={getDisplayExportId(layout).length > 0 && !isValidFileName(getDisplayExportId(layout))}
                                    style={{ width: "100%" }}
                                />
                            </div>
                            <sp-button
                                quiet
                                variant="negative"
                                size="s"
                                onClick={() => handleDeleteRequest(layout)}
                                disabled={isLastLayout || undefined}
                                title={isLastLayout ? "Legalább egy elrendezésnek lennie kell" : "Elrendezés törlése"}
                            >
                                ✕
                            </sp-button>
                        </div>
                    ))}

                    {/* Új layout hozzáadása gomb */}
                    <sp-button
                        quiet
                        variant="secondary"
                        size="s"
                        onClick={handleAddLayout}
                        disabled={isBusy || undefined}
                        style={{ marginTop: "4px", alignSelf: "flex-start" }}
                    >
                        + Új elrendezés
                    </sp-button>
                </div>
            </CollapsibleSection>

            {/* Törlés megerősítő dialog */}
            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                title="Elrendezés törlése"
                message={`Biztosan törölni szeretnéd a(z) „${deleteConfirm.layoutName}" elrendezést?\n\nAz ehhez rendelt cikkek az első elérhető elrendezéshez kerülnek át.`}
                confirmLabel="Törlés"
                onConfirm={handleDeleteConfirm}
                onCancel={handleDeleteCancel}
            />
        </>
    );
};
