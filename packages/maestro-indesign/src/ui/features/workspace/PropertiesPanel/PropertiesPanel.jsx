import React, { useState } from "react";
import { ArticleProperties } from "../../articles/ArticleProperties/ArticleProperties.jsx";
import { PublicationProperties } from "../../publications/PublicationProperties/PublicationProperties.jsx";
import { WORKFLOW_CONFIG, MARKERS } from "../../../../core/utils/workflow/workflowConstants.js";
import { CustomCheckbox } from "../../../common/CustomCheckbox.jsx";
import { WorkflowEngine } from "../../../../core/utils/workflow/workflowEngine.js";
import { useUser } from "../../../../core/contexts/UserContext.jsx";
import { useToast } from "../../../common/Toast/ToastContext.jsx";
import { executeCommand } from "../../../../core/commands/index.js";

export const PropertiesPanel = ({ selectedItem, type, publication, onUpdate, onPublicationUpdate, onBack, onOpen, runAndPersistPreflight }) => {
    // Hooks
    const { user } = useUser();
    const { showToast } = useToast();
    const [isSyncing, setIsSyncing] = useState(false);
    const [hasDeadlineErrors, setHasDeadlineErrors] = useState(false);

    // Defensive guard
    const item = selectedItem || {};
    const itemName = item.name || "Részletek";
    const canOpen = type === 'article' && item.filePath;
    const isIgnored = type === 'article' && (item.markers & MARKERS.IGNORE) !== 0;

    console.log("[PropertiesPanel] Rendering item:", item.name, "State:", item.state);

    // Safety check for imported constants
    const safeWorkflowConfig = WORKFLOW_CONFIG || {};
    if (!WORKFLOW_CONFIG) console.warn("[PropertiesPanel] WORKFLOW_CONFIG is undefined!");

    // Get available commands for current state (if article)
    const commands = (type === 'article' && item && item.state !== undefined && safeWorkflowConfig[item.state]?.commands)
        ? safeWorkflowConfig[item.state].commands
        : [];

    const handleOpen = async () => {
        if (canOpen && onOpen) {
            try {
                await onOpen(item);
            } catch (error) {
                console.error("Failed to open file:", error);
            }
        }
    };

    const handleCommand = async (commandId) => {
        console.log(`[PropertiesPanel] Command triggered: ${commandId} for ${item.name}`);

        setIsSyncing(true);
        try {
            const context = { item, user, publication, runAndPersistPreflight };
            const result = await executeCommand(commandId, context);

            // silent: a handler már megjelenítette a visszajelzést (pl. toast a hook-ból)
            if (!result.silent) {
                if (result.success) {
                    showToast(result.message || "Művelet végrehajtva", "success");
                } else {
                    showToast("A művelet sikertelen", "error", result.error || "Ismeretlen hiba történt a végrehajtás során.");
                }
            }
        } catch (error) {
            console.error("Command execution error:", error);
            showToast("Váratlan hiba", "error", error.message || "Ismeretlen hiba történt a parancs végrehajtása közben.");
        } finally {
            setIsSyncing(false);
        }
    };

    const handleToggleIgnore = async () => {
        if (isSyncing || !item.$id) return;

        setIsSyncing(true);
        try {
            const result = await WorkflowEngine.toggleMarker(item, MARKERS.IGNORE, user);
            if (result.success) {
                if (onUpdate && result.document) {
                    onUpdate(result.document);
                }
            } else {
                const errorMessage = result.error?.message || (typeof result.error === 'string' ? result.error : 'Ismeretlen hiba');
                console.error("Marker toggle error:", result.error);
                showToast('A jelölő módosítása sikertelen', 'error', errorMessage);
            }
        } catch (error) {
            console.error("Marker toggle exception:", error);
            showToast('A jelölő módosítása sikertelen', 'error', error.message || 'Váratlan hiba történt.');
        } finally {
            setIsSyncing(false);
        }
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            {/* Header with flexbox layout: 2 units back, 4 units name, 2 units open */}
            <div style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 12px",
                borderBottom: "0.5px solid var(--spectrum-global-color-gray-200)",
                flexShrink: 0
            }}>
                <div style={{ flex: 1 }}>
                    <sp-button
                        variant="primary"
                        onClick={onBack}
                        disabled={hasDeadlineErrors || undefined}
                        title={hasDeadlineErrors ? "Javítsd a határidő hibákat a kilépés előtt" : undefined}
                    >
                        ← Vissza
                    </sp-button>
                </div>

                <sp-heading
                    style={{
                        flex: 3,
                        display: "block",
                        maxWidth: "100%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        textAlign: "center",
                        margin: "0 8px 0 8px"
                    }}
                    title={itemName}
                >
                    {itemName}
                </sp-heading>

                <div style={{ flex: 1 }}>
                    <sp-button
                        variant="accent"
                        onClick={handleOpen}
                        disabled={!canOpen || undefined}
                    >
                        Megnyitás
                    </sp-button>
                </div>
            </div>

            {/* Commands Toolbar (Always visible for articles) */}
            {type === 'article' && (
                <div style={{
                    padding: "8px 12px",
                    borderBottom: "0.5px solid var(--spectrum-global-color-gray-200)",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                }}>
                    {/* Command buttons wrapper */}
                    <div style={{
                        flex: 1,
                        display: "flex",
                        gap: "8px",
                        alignItems: "center",
                        flexWrap: "wrap"
                    }}>
                        {commands.map(cmd => (
                            <sp-button
                                quiet
                                style={{ flexShrink: 0 }}
                                key={cmd.id}
                                variant="secondary"
                                onClick={() => handleCommand(cmd.id)}
                                disabled={isIgnored || isSyncing || undefined}
                                size="s"
                            >
                                {cmd.label}
                            </sp-button>
                        ))}
                    </div>

                    {/* Kimarad checkbox on the right */}
                    <CustomCheckbox
                        checked={isIgnored}
                        onChange={handleToggleIgnore}
                        disabled={isSyncing}
                        style={{ marginLeft: "8px", flexShrink: 0 }}
                    >
                        Kimarad
                    </CustomCheckbox>
                </div>
            )}

            {/* Properties content */}
            <div style={{ flex: 1, overflow: "auto" }}>
                {type === 'article' ? (
                    <ArticleProperties
                        article={item}
                        publication={publication}
                        onUpdate={onUpdate}
                    />
                ) : type === 'publication' ? (
                    <PublicationProperties
                        publication={item}
                        onFieldUpdate={onPublicationUpdate}
                        onValidationChange={setHasDeadlineErrors}
                    />
                ) : (
                    <div style={{ padding: "16px", textAlign: "center" }}>
                        <sp-body>Ismeretlen elemtípus: {type}</sp-body>
                    </div>
                )}
            </div>
        </div>
    );
};
