import React, { useState, useEffect } from "react";

// Components
import { CollapsibleSection } from "../../../common/CollapsibleSection.jsx";
import { ConfirmDialog } from "../../../common/ConfirmDialog.jsx";
import { ValidatedTextField } from "../../../common/ValidatedTextField.jsx";
import { CustomDropdown } from "../../../common/CustomDropdown.jsx";

// Contexts
import { useData } from "../../../../core/contexts/DataContext.jsx";

// Utils
import { WorkflowEngine } from "../../../../core/utils/workflow/workflowEngine.js";
import { WORKFLOW_STATES, WORKFLOW_CONFIG, MARKERS } from "../../../../core/utils/workflow/workflowConstants.js";
import { hasTransitionPermission } from "../../../../core/utils/workflow/workflowPermissions.js";
import { STORAGE_KEYS } from "../../../../core/utils/constants.js";
import { isValidFileName } from "../../../../core/utils/pathUtils.js";

/**
 * GeneralSection Component
 *
 * Displays and manages the general properties of an article within the properties panel.
 * This component handles:
 * - Page number fields (start and end pages) with parity validation
 * - Article name field
 * - Layout selection dropdown (A-F options)
 * - Workflow state visualization and transition controls
 *
 * The workflow section shows the current state with a color-coded status box,
 * and provides backward/forward transition buttons when applicable transitions exist.
 * A „Kimarad" jelölő szürkíti a státuszt és letiltja az állapotátmeneteket.
 *
 * When the start page is changed, the component:
 * 1. Checks if parity (odd/even) changes - shows a stronger warning if so
 * 2. Always asks for confirmation before renumbering
 * 3. Calls onPageNumberChange with the new value and offset
 *
 * @param {Object} props - Component props
 * @param {Object} props.article - The article object containing all article data
 * @param {number} [props.article.startPage] - Starting page number
 * @param {number} [props.article.endPage] - Ending page number
 * @param {string} [props.article.name] - Article name
 * @param {string} [props.article.layout] - Layout identifier (A-F)
 * @param {number} [props.article.state] - Workflow state number
 * @param {number} [props.article.markers] - Bitmask of active markers
 * @param {Function} props.onFieldUpdate - Callback to update article field: (fieldName, value) => void
 * @param {Function} props.onPageNumberChange - Callback to handle start page change with renumbering: (newStartPage, offset) => Promise<void>
 * @param {Function} props.onStateTransition - Callback to handle workflow state transition: (targetState) => void
 * @param {boolean} props.isSyncing - Whether an update is in progress (disables controls)
 * @returns {JSX.Element} The GeneralSection component
 */
export const GeneralSection = ({ article, user, onFieldUpdate, onPageNumberChange, onStateTransition, isSyncing }) => {
    const { layouts } = useData();

    /**
     * Compute workflow state and marker information.
     * This IIFE extracts and validates the article's workflow state and markers,
     * providing defaults for invalid or missing values.
     *
     * @returns {Object} Computed workflow data
     * @returns {number} activeMarkersMask - Bitmask of currently active markers
     * @returns {number} currentState - Current workflow state number
     * @returns {Object} currentConfig - Configuration object for current state (label, color)
     * @returns {Array} availableTransitions - Sorted array of available transition objects
     */
    const { activeMarkersMask, currentState, currentConfig, availableTransitions } = (() => {
        // Validate and default the workflow state
        let rawState = article.state;
        if (rawState === undefined) rawState = article.State;

        if (typeof WorkflowEngine === 'undefined') {
            console.error("[GeneralSection] CRITICAL: WorkflowEngine is undefined!");
            return { activeMarkersMask: 0, currentState: 0, currentConfig: {}, availableTransitions: [] };
        }
        if (typeof WORKFLOW_CONFIG === 'undefined') {
            console.error("[GeneralSection] CRITICAL: WORKFLOW_CONFIG is undefined!");
            return { activeMarkersMask: 0, currentState: 0, currentConfig: {}, availableTransitions: [] };
        }

        const state = typeof rawState === 'number' ? rawState : WORKFLOW_STATES.DESIGNING;
        const config = WORKFLOW_CONFIG[state]?.config || WORKFLOW_CONFIG[WORKFLOW_STATES.DESIGNING]?.config || {};

        // Validate and default the markers value
        const markers = typeof article.markers === 'number' ? article.markers : 0;

        // Get available transitions and sort by target state
        const rawTransitions = WorkflowEngine.getAvailableTransitions(state);
        const transitions = [...rawTransitions].sort((a, b) => a.target - b.target);

        return { activeMarkersMask: markers, currentState: state, currentConfig: config, availableTransitions: transitions };
    })();

    // Jogosultsági ellenőrzés: a felhasználó mozgathatja-e a cikket?
    const canTransition = user ? hasTransitionPermission(article, currentState, user) : false;

    // Local state for Name field to allow "Enter to save" behavior
    const [localName, setLocalName] = useState(article.name || "");

    // Local state for page number fields
    const [localStartPage, setLocalStartPage] = useState(article.startPage || "");
    const [localEndPage, setLocalEndPage] = useState(article.endPage || "");

    // State for page change confirmation (works for both start and end page)
    const [pendingPageChange, setPendingPageChange] = useState(null); // { type: 'start'|'end', newValue, offset }
    const [showRenumberConfirm, setShowRenumberConfirm] = useState(false);
    const [renumberDialogConfig, setRenumberDialogConfig] = useState({ title: "", message: "", isParityMismatch: false });

    // Sync local state when article prop changes
    useEffect(() => {
        setLocalName(article.name || "");
        setLocalStartPage(article.startPage || "");
        setLocalEndPage(article.endPage || "");
    }, [article.name, article.startPage, article.endPage]);



    /**
     * Shows the renumber confirmation dialog for page changes.
     * @param {number} offset - The page offset
     * @param {number} newStartPage - The calculated new start page
     * @param {string} changeType - 'start' or 'end'
     */
    const showRenumberDialog = (offset, newStartPage, changeType) => {
        const currentStartPage = article.startPage;
        const newEndPage = (article.endPage || article.startPage) + offset;

        // Check parity
        const currentParity = currentStartPage % 2; // 0 = even, 1 = odd
        const newParity = newStartPage % 2;
        const isParityMismatch = currentParity !== newParity;

        // Prepare confirmation dialog
        let message;
        if (isParityMismatch) {
            const currentParityText = currentParity === 0 ? "páros" : "páratlan";
            const newParityText = newParity === 0 ? "páros" : "páratlan";
            message = `Figyelem! A kezdő oldal ${currentParityText} számról ${newParityText} számra változik.\n\nEz azt jelenti, hogy a bal és jobb oldalak felcserélődnek, és a tördelés elromolhat!\n\nBiztosan át szeretnéd számozni a cikk oldalait ${currentStartPage}-ról ${newStartPage}-ra?`;
        } else {
            message = `Biztosan át szeretnéd helyezni a cikket a ${currentStartPage}–${article.endPage || currentStartPage}. oldalakról a ${newStartPage}–${newEndPage}. oldalakra?\n\nAz InDesign fájlban minden oldal átszámozásra kerül.`;
        }

        setPendingPageChange({ type: changeType, newStartPage, offset });
        setRenumberDialogConfig({
            title: isParityMismatch ? "⚠️ Paritás változás!" : "Cikk áthelyezése",
            message,
            isParityMismatch
        });
        setShowRenumberConfirm(true);
    };

    /**
     * Handles the start page save action.
     * Validates parity and shows appropriate confirmation dialog.
     * Uses the current value from the event target or local state.
     */
    const handleStartPageSave = (e) => {
        // Try to get value from event target first (most reliable for native events), fall back to local state
        const rawValue = e?.target?.value ?? localStartPage;
        const newValue = parseInt(rawValue, 10);

        if (isNaN(newValue) || newValue < 1) {
            // Reset to original value if invalid
            setLocalStartPage(article.startPage || "");
            return;
        }

        const currentStartPage = article.startPage;

        // If no current start page, just update directly (first time setting)
        if (!currentStartPage) {
            onFieldUpdate("startPage", newValue);
            return;
        }

        // If the value hasn't changed, do nothing
        if (newValue === currentStartPage) {
            return;
        }

        const offset = newValue - currentStartPage;
        showRenumberDialog(offset, newValue, 'start');
    };

    /**
     * Handles the end page save action.
     * Calculates offset based on end page change and shows confirmation dialog.
     */
    const handleEndPageSave = (e) => {
        const rawValue = e?.target?.value ?? localEndPage;
        const newValue = parseInt(rawValue, 10);

        if (isNaN(newValue) || newValue < 1) {
            // Reset to original value if invalid
            setLocalEndPage(article.endPage || "");
            return;
        }

        const currentEndPage = article.endPage;

        // If no current end page, just update directly (first time setting)
        if (!currentEndPage) {
            onFieldUpdate("endPage", newValue);
            return;
        }

        // If the value hasn't changed, do nothing
        if (newValue === currentEndPage) {
            return;
        }

        // Guard against invalid startPage to prevent NaN
        if (!Number.isFinite(article.startPage)) {
            onFieldUpdate("endPage", newValue);
            return;
        }

        const offset = newValue - currentEndPage;
        const newStartPage = article.startPage + offset;
        showRenumberDialog(offset, newStartPage, 'end');
    };

    // Native event listeners handled by ValidatedTextField component



    /**
     * Handles confirmation of the page change.
     * Calculates offset and calls the parent handler.
     * Resets local state to original if the operation fails.
     */
    const handleRenumberConfirm = async () => {
        if (!pendingPageChange) return;

        const { offset, newStartPage, type } = pendingPageChange;
        setShowRenumberConfirm(false);

        // Call the parent handler to perform the renumbering
        if (onPageNumberChange) {
            try {
                const success = await onPageNumberChange(newStartPage, offset);

                // If the operation failed (returned false), reset local state
                if (success === false) {
                    setLocalStartPage(article.startPage || "");
                    setLocalEndPage(article.endPage || "");
                }
            } catch (error) {
                // On error, reset local state to original values
                setLocalStartPage(article.startPage || "");
                setLocalEndPage(article.endPage || "");
            }
        }

        setPendingPageChange(null);
    };

    /**
     * Handles cancellation of the page change.
     */
    const handleRenumberCancel = () => {
        setShowRenumberConfirm(false);
        setPendingPageChange(null);
        // Reset local state to original values
        setLocalStartPage(article.startPage || "");
        setLocalEndPage(article.endPage || "");
    };

    // Check if IGNORE marker is active
    const isIgnored = (activeMarkersMask & MARKERS.IGNORE) !== 0;

    return (
        <>
            <CollapsibleSection
                title="ÁLTALÁNOS"
                showDivider={false}
                storageKey={STORAGE_KEYS.SECTION_GENERAL_COLLAPSED}
            >
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {/* Name and Page Numbers Row - FIRST ROW */}
                    <div style={{ display: "flex" }}>
                        <div style={{ flex: 1, marginRight: "8px" }}>
                            <sp-label>Kezdő</sp-label>
                            <ValidatedTextField
                                id="start-page-field"
                                type="number"
                                value={localStartPage}
                                onInput={(e) => setLocalStartPage(e.target.value)}
                                onValidate={handleStartPageSave}
                                disabled={isIgnored || isSyncing ? true : undefined}
                                style={{ width: "100%" }}
                            />
                        </div>
                        <div style={{ flex: 1, marginRight: "8px" }}>
                            <sp-label>Utolsó</sp-label>
                            <ValidatedTextField
                                id="end-page-field"
                                type="number"
                                value={localEndPage}
                                onInput={(e) => setLocalEndPage(e.target.value)}
                                onValidate={handleEndPageSave}
                                disabled={isIgnored || isSyncing ? true : undefined}
                                style={{ width: "100%" }}
                            />
                        </div>
                        <div style={{ flex: 10, marginRight: "8px" }}>
                            <sp-label>Név</sp-label>
                            <ValidatedTextField
                                id="name-field"
                                type="text"
                                value={localName}
                                onInput={(e) => setLocalName(e.target.value)}
                                onValidate={(e) => onFieldUpdate("name", e?.target?.value ?? localName)}
                                disabled={isIgnored || isSyncing ? true : undefined}
                                invalid={localName.length > 0 && !isValidFileName(localName)}
                                style={{ width: "100%" }}
                            />
                        </div>
                        <div style={{ flex: 9 }}>
                            <sp-label>Elrendezés</sp-label>
                            <CustomDropdown
                                id="layout-dropdown"
                                value={article.layout}
                                onChange={(val) => onFieldUpdate('layout', val)}
                                disabled={isIgnored || isSyncing ? true : undefined}
                                style={{ width: "100%" }}
                            >
                                <sp-menu slot="options" size="m">
                                    {layouts.map(layout => (
                                        <sp-menu-item key={layout.$id} value={layout.$id} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{layout.name}</sp-menu-item>
                                    ))}
                                </sp-menu>
                            </CustomDropdown>
                        </div>
                    </div>

                    {/* Workflow Section */}
                    <div style={{ display: "flex", flexDirection: "column", marginBottom: "4px", marginTop: "12px" }}>

                        {/* Workflow Status Controls Row */}
                        <div style={{ display: "flex" }}>

                            {/* Backward button (25%) */}
                            <div style={{ flex: 1 }}>
                                {(() => {
                                    const backwardTransition = availableTransitions.find(t =>
                                        t.type === 'backward' || (!t.type && t.target < currentState)
                                    );

                                    return backwardTransition ? (
                                        <sp-button
                                            quiet
                                            variant="secondary"
                                            size="m"
                                            style={{ borderRadius: "12px 0 0 12px", width: "100%" }}
                                            onClick={() => onStateTransition(backwardTransition.target)}
                                            disabled={isIgnored || isSyncing || !canTransition ? true : undefined}
                                            title={!canTransition ? "Nincs jogosultságod az állapotváltáshoz" : undefined}
                                        >
                                            ← {backwardTransition.label}
                                        </sp-button>
                                    ) : null;
                                })()}
                            </div>

                            {/* Status box (50%) — szürke ha kimarad */}
                            <div style={{
                                flex: 1,
                                backgroundColor: isIgnored ? "var(--spectrum-global-color-gray-500)" : currentConfig?.color,
                                color: "var(--spectrum-global-color-gray-200)",
                                borderRadius: "0",
                                textAlign: "center",
                                fontWeight: "700",
                                fontSize: "14px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                minHeight: "24px"
                            }}>
                                {isIgnored ? "Kimarad" : currentConfig?.label}
                            </div>

                            {/* Forward button (25%) */}
                            <div style={{ flex: 1 }}>
                                {(() => {
                                    const forwardTransition = availableTransitions.find(t =>
                                        t.type === 'forward' || (!t.type && t.target > currentState)
                                    );

                                    return forwardTransition ? (
                                        <sp-button
                                            quiet
                                            variant="secondary"
                                            size="m"
                                            style={{ borderRadius: "0 12px 12px 0", width: "100%" }}
                                            onClick={() => onStateTransition(forwardTransition.target)}
                                            disabled={isIgnored || isSyncing || !canTransition ? true : undefined}
                                            title={!canTransition ? "Nincs jogosultságod az állapotváltáshoz" : undefined}
                                        >
                                            {forwardTransition.label} →
                                        </sp-button>
                                    ) : null;
                                })()}
                            </div>

                        </div>
                    </div>
                </div>
            </CollapsibleSection>

            {/* Renumber Confirmation Dialog */}
            <ConfirmDialog
                isOpen={showRenumberConfirm}
                title={renumberDialogConfig.title}
                message={renumberDialogConfig.message}
                confirmLabel="Átszámozás"
                onConfirm={handleRenumberConfirm}
                onCancel={handleRenumberCancel}
            />
        </>
    );
};
