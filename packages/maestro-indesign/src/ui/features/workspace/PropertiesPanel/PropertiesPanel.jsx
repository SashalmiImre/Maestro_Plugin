import React, { useState, useMemo } from "react";
import { ArticleProperties } from "../../articles/ArticleProperties/ArticleProperties.jsx";
import { MARKERS } from "maestro-shared/constants.js";
import { getStateCommands, canRunCommand, canUserAccessInState } from "maestro-shared/workflowRuntime.js";
import { getCommandLabel } from "maestro-shared/commandRegistry.js";
import { CustomCheckbox } from "../../../common/CustomCheckbox.jsx";
import { WorkflowEngine } from "../../../../core/utils/workflow/workflowEngine.js";
import { useUser } from "../../../../core/contexts/UserContext.jsx";
import { useData } from "../../../../core/contexts/DataContext.jsx";
import { useToast } from "../../../common/Toast/ToastContext.jsx";
import { TOAST_TYPES } from "../../../../core/utils/constants.js";
import { executeCommand } from "../../../../core/commands/index.js";
import { useElementPermissions } from "../../../../data/hooks/useElementPermission.js";
import { isExtensionRef, parseExtensionRef } from "maestro-shared/extensionContract.js";
import { log, logError } from "../../../../core/utils/logger.js";

export const PropertiesPanel = ({ selectedItem, publication, onUpdate, onBack, onOpen, runAndPersistPreflight }) => {
    // Hooks
    const { user } = useUser();
    // `extensionRegistry` a DataContext snapshot-preferáló derived state-je (B.4.2).
    const { layouts, applyArticleUpdate, workflow, extensionRegistry } = useData();
    const { showToast } = useToast();
    const [isSyncing, setIsSyncing] = useState(false);

    // Elem jogosultságok
    const perm = useElementPermissions(['ignoreToggle']);
    const userGroups = user?.groupSlugs || [];
    const stateAccess = useMemo(
        () => canUserAccessInState(workflow, userGroups, selectedItem?.state),
        [workflow, userGroups, selectedItem?.state]
    );

    // Defensive guard
    const item = selectedItem || {};
    const itemName = item.name || "Részletek";
    const canOpen = Boolean(item.filePath);
    const isIgnored = (item.markers & MARKERS.IGNORE) !== 0;

    // Az aktuális állapothoz tartozó parancsok — a workflow compiled commands-ból.
    // Extension command (`ext.<slug>`) esetén a label a registry `name` mezőjéből jön
    // (a `commandRegistry.js` a beépített parancsokat ismeri csak — fallback a slug-ra).
    const commands = useMemo(() => {
        if (!item.state || !workflow) return [];
        return getStateCommands(workflow, item.state).map(cmd => {
            let label = getCommandLabel(cmd.id);
            if (isExtensionRef(cmd.id)) {
                const ref = parseExtensionRef(cmd.id);
                const ext = ref ? extensionRegistry.get(ref.slug) : null;
                if (ext?.name) label = ext.name;
            }
            return { id: cmd.id, label, allowedGroups: cmd.allowedGroups };
        });
    }, [item.state, workflow, extensionRegistry]);

    const handleOpen = async () => {
        if (canOpen && onOpen) {
            try {
                await onOpen(item);
            } catch (error) {
                logError("Failed to open file:", error);
            }
        }
    };

    const handleCommand = async (commandId) => {
        log(`[PropertiesPanel] Command triggered: ${commandId} for ${item.name}`);

        setIsSyncing(true);
        try {
            const context = { item, user, publication, layouts, runAndPersistPreflight, extensions: extensionRegistry };
            const result = await executeCommand(commandId, context);

            // silent: a handler már megjelenítette a visszajelzést (pl. toast a hook-ból)
            if (!result.silent) {
                if (result.success) {
                    showToast(result.message || "Művelet végrehajtva", TOAST_TYPES.SUCCESS);
                } else {
                    showToast("A művelet sikertelen", TOAST_TYPES.ERROR, result.error || "Ismeretlen hiba történt a végrehajtás során.");
                }
            }
        } catch (error) {
            logError("Command execution error:", error);
            showToast("Váratlan hiba", TOAST_TYPES.ERROR, error.message || "Ismeretlen hiba történt a parancs végrehajtása közben.");
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
                if (result.document) {
                    applyArticleUpdate(result.document);
                    if (onUpdate) onUpdate(result.document);
                } else if (!result.silent) {
                    showToast(result.message || "Művelet végrehajtva", TOAST_TYPES.SUCCESS);
                }
            } else {
                const errorMessage = result.error?.message || (typeof result.error === 'string' ? result.error : 'Ismeretlen hiba');
                logError("Marker toggle error:", result.error);
                showToast('A jelölő módosítása sikertelen', TOAST_TYPES.ERROR, errorMessage);
            }
        } catch (error) {
            logError("Marker toggle exception:", error);
            showToast('A jelölő módosítása sikertelen', TOAST_TYPES.ERROR, error.message || 'Váratlan hiba történt.');
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
                        disabled={!canOpen || !stateAccess.allowed || undefined}
                        title={!stateAccess.allowed ? stateAccess.reason : undefined}
                    >
                        Megnyitás
                    </sp-button>
                </div>
            </div>

            {/* Commands Toolbar */}
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
                    {commands.map(cmd => {
                        const cmdPerm = canRunCommand(workflow, item.state, cmd.id, userGroups);
                        return (
                            <sp-button
                                quiet
                                style={{ flexShrink: 0 }}
                                key={cmd.id}
                                variant="secondary"
                                onClick={() => handleCommand(cmd.id)}
                                disabled={isIgnored || isSyncing || !cmdPerm.allowed || undefined}
                                title={!cmdPerm.allowed ? cmdPerm.reason : undefined}
                                size="s"
                            >
                                {cmd.label}
                            </sp-button>
                        );
                    })}
                </div>

                {/* Kimarad checkbox on the right */}
                <CustomCheckbox
                    checked={isIgnored}
                    onChange={handleToggleIgnore}
                    disabled={isSyncing || !perm.ignoreToggle.allowed}
                    title={!perm.ignoreToggle.allowed ? perm.ignoreToggle.reason : undefined}
                    style={{ marginLeft: "8px", flexShrink: 0 }}
                >
                    Kimarad
                </CustomCheckbox>
            </div>

            {/* Properties content */}
            <div style={{ flex: 1, overflow: "auto" }}>
                <ArticleProperties
                    article={item}
                    publication={publication}
                    onUpdate={onUpdate}
                />
            </div>
        </div>
    );
};
