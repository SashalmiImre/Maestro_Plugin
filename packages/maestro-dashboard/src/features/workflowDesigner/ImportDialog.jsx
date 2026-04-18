/**
 * Maestro Dashboard — ImportDialog
 *
 * Modal dialógus a workflow JSON importálásához.
 * Fájl kiválasztás → validáció → diff megjelenítés → megerősítés.
 */

import React, { useState, useCallback, useRef } from 'react';
import { parseImportFile, computeImportDiff, applyImport } from './exportImport.js';

/**
 * @param {Object} props
 * @param {boolean} props.isOpen - Dialógus nyitva van-e
 * @param {Function} props.onClose - Bezárás callback
 * @param {Object[]} props.currentNodes - Jelenlegi node-ok (diff-hez)
 * @param {Object[]} props.currentEdges - Jelenlegi edge-ek (diff-hez)
 * @param {Function} props.onImport - (nodes, edges, metadata, viewport) => void
 */
export default function ImportDialog({ isOpen, onClose, currentNodes, currentEdges, currentMetadata, onImport }) {
    const [importData, setImportData] = useState(null);
    const [diff, setDiff] = useState(null);
    const [error, setError] = useState(null);
    const fileInputRef = useRef(null);

    const reset = useCallback(() => {
        setImportData(null);
        setDiff(null);
        setError(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, []);

    const handleClose = useCallback(() => {
        reset();
        onClose();
    }, [onClose, reset]);

    const handleFileChange = useCallback(async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setError(null);
        setDiff(null);

        const { compiled, graph, error: parseError } = await parseImportFile(file);
        if (parseError) {
            setError(parseError);
            setImportData(null);
            return;
        }

        setImportData({ compiled, graph });
        setDiff(computeImportDiff(currentNodes, currentEdges, currentMetadata, compiled));
    }, [currentNodes, currentEdges, currentMetadata]);

    const handleConfirm = useCallback(() => {
        if (!importData) return;

        const { nodes, edges, metadata, viewport } = applyImport(importData.compiled, importData.graph);
        onImport(nodes, edges, metadata, viewport);
        handleClose();
    }, [importData, onImport, handleClose]);

    if (!isOpen) return null;

    return (
        <div className="import-dialog__overlay" onClick={handleClose}>
            <div className="import-dialog" onClick={e => e.stopPropagation()}>
                <h3 className="import-dialog__title">Workflow importálás</h3>

                {/* Fájl kiválasztás */}
                <div className="import-dialog__file-row">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json"
                        onChange={handleFileChange}
                        className="import-dialog__file-input"
                    />
                </div>

                {/* Hiba */}
                {error && <p className="import-dialog__error">{error}</p>}

                {/* Diff megjelenítés */}
                {diff && (
                    <div className="import-dialog__diff">
                        <p className="import-dialog__diff-title">Változások:</p>
                        <ul className="import-dialog__diff-list">
                            {diff.addedStates.length > 0 && (
                                <li className="import-dialog__diff-item import-dialog__diff-item--add">
                                    + {diff.addedStates.length} új állapot: {diff.addedStates.join(', ')}
                                </li>
                            )}
                            {diff.removedStates.length > 0 && (
                                <li className="import-dialog__diff-item import-dialog__diff-item--remove">
                                    - {diff.removedStates.length} törölt állapot: {diff.removedStates.join(', ')}
                                </li>
                            )}
                            {diff.changedTransitions > 0 && (
                                <li className="import-dialog__diff-item">
                                    ~ {diff.changedTransitions} módosított átmenet
                                </li>
                            )}
                            {diff.metadataChanges?.length > 0 && (
                                <li className="import-dialog__diff-item" style={{ color: 'var(--c-warning, #fb923c)' }}>
                                    ⚠ Jogosultság/konfiguráció változás: {diff.metadataChanges.join(', ')}
                                </li>
                            )}
                            {diff.addedStates.length === 0 && diff.removedStates.length === 0 && diff.changedTransitions === 0 && !diff.metadataChanges?.length && (
                                <li className="import-dialog__diff-item">Nincs változás.</li>
                            )}
                        </ul>
                    </div>
                )}

                {/* Gombok */}
                <div className="import-dialog__actions">
                    <button
                        type="button"
                        className="import-dialog__btn import-dialog__btn--cancel"
                        onClick={handleClose}
                    >
                        Mégse
                    </button>
                    <button
                        type="button"
                        className="import-dialog__btn import-dialog__btn--confirm"
                        disabled={!importData}
                        onClick={handleConfirm}
                    >
                        Importálás
                    </button>
                </div>
            </div>
        </div>
    );
}
