/**
 * Maestro Dashboard — ImportDialog
 *
 * Modal-tartalom a workflow JSON importálásához. A közös `Modal.jsx` wrapper-en
 * keresztül nyílik meg (`useModal().openModal(<ImportDialog ... />, ...)`-ra
 * a WorkflowDesignerPage toolbar). A komponens csak a belső tartalmat
 * rendereli; a portál + animáció + ESC/backdrop/✕ a közös Modal-tól jön.
 *
 * Folyamat: Fájl kiválasztás → validáció → diff megjelenítés → megerősítés.
 */

import React, { useState, useCallback, useRef } from 'react';
import { useModal } from '../../contexts/ModalContext.jsx';
import { parseImportFile, computeImportDiff } from './exportImport.js';
import { normalizeAndValidateImport } from './compiler.js';
import { summarizeValidationErrors } from '@shared/compiledValidator.js';

/**
 * @param {Object} props
 * @param {Object[]} props.currentNodes - Jelenlegi node-ok (diff-hez)
 * @param {Object[]} props.currentEdges - Jelenlegi edge-ek (diff-hez)
 * @param {Object} props.currentMetadata - Jelenlegi metadata (diff-hez)
 * @param {Function} props.onImport - (nodes, edges, metadata, viewport) => void
 */
export default function ImportDialog({ currentNodes, currentEdges, currentMetadata, onImport }) {
    const { closeModal } = useModal();
    const [importData, setImportData] = useState(null);
    const [diff, setDiff] = useState(null);
    const [error, setError] = useState(null);
    // A.1.9 (ADR 0008): pre-import warning, ha az importált compiled
    // megsérti a hard contract-ot. Strict block (iter 4): a button
    // disabled, ha jelen van warning, és a confirm handler is védi.
    const [validationWarning, setValidationWarning] = useState(null);
    const fileInputRef = useRef(null);
    // Out-of-order parse race-guard (iter 5b): minden upload kap egy seq
    // számot, és csak a legutolsó parse eredményét fogadjuk el. Két gyors
    // upload (lassú→gyors completion) különben stale state-et írhatna.
    const parseSeqRef = useRef(0);

    const handleClose = useCallback(() => {
        // Invalidáljuk az in-flight parse-okat: a seq-bump után a meglévő
        // `await parseImportFile` / `await normalizeAndValidateImport`
        // callback-ek a `seq !== parseSeqRef.current` ágon korai return-nel
        // kilépnek, így bezárás után NEM írnak stale state-et.
        parseSeqRef.current++;
        closeModal();
    }, [closeModal]);

    const handleFileChange = useCallback(async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        // Reset minden előző állapotot, és vegyünk egy új seq-számot — a
        // parse után csak akkor commit-olunk, ha közben nem indult újabb
        // upload (out-of-order completion védelme).
        const seq = ++parseSeqRef.current;
        setError(null);
        setDiff(null);
        setValidationWarning(null);
        setImportData(null);

        const { compiled, graph, error: parseError } = await parseImportFile(file);
        if (seq !== parseSeqRef.current) return;
        if (parseError) {
            setError(parseError);
            return;
        }

        const result = normalizeAndValidateImport(compiled, graph);
        if (seq !== parseSeqRef.current) return;
        if (!result.ok) {
            setError(`Az importált fájl szerkezete érvénytelen: ${result.structuralError}`);
            return;
        }
        if (!result.validation.valid) {
            setValidationWarning(summarizeValidationErrors(result.validation));
        }

        setImportData({
            compiled,
            graph,
            normalized: {
                nodes: result.nodes,
                edges: result.edges,
                metadata: result.metadata,
                viewport: result.viewport
            }
        });
        setDiff(computeImportDiff(currentNodes, currentEdges, currentMetadata, compiled));
    }, [currentNodes, currentEdges, currentMetadata]);

    const handleConfirm = useCallback(() => {
        // Defense-in-depth: a button disabled-feltétel mellett a click handler
        // is blokkolja a corrupt importot (DevTools-bypass / programmatikus
        // hívás ellen). A Designer state-jét NEM töltjük fel érvénytelen
        // workflow-val, mert a corrupt nodes/edges renderelés-időben crash-elne.
        if (!importData || validationWarning) return;
        const { nodes, edges, metadata, viewport } = importData.normalized;
        onImport(nodes, edges, metadata, viewport);
        handleClose();
    }, [importData, validationWarning, onImport, handleClose]);

    return (
        <div className="import-dialog-body">
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

            {/* Hard contract blokk — A.1.9: érvénytelen workflow-t NEM
                engedünk betölteni a Designer state-be, mert a corrupt
                nodes/edges/metadata renderelés-időben crash-eli a
                canvast. A felhasználó vagy javítja a JSON-t és újratölti,
                vagy lemond. */}
            {validationWarning && (
                <p className="import-dialog__error">
                    ⚠ Az importált workflow érvénytelen: {validationWarning} Javítsd a JSON-t és tölts fel újat.
                </p>
            )}

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

            {/* Gombok — a közös modal-actions + btn-secondary / btn-primary,
                hogy a többi modal-lal egységes legyen a hierarchia és stílus. */}
            <div className="modal-actions">
                <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleClose}
                >
                    Mégse
                </button>
                <button
                    type="button"
                    className="btn-primary"
                    disabled={!importData || !!validationWarning}
                    onClick={handleConfirm}
                >
                    Importálás
                </button>
            </div>
        </div>
    );
}
