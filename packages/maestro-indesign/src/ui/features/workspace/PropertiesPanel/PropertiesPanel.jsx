import React, { useState, useMemo } from "react";
import { ArticleProperties } from "../../articles/ArticleProperties/ArticleProperties.jsx";
import { PublicationProperties } from "../../publications/PublicationProperties/PublicationProperties.jsx";
import { WORKFLOW_CONFIG, MARKERS, COMMANDS } from "../../../../core/utils/workflow/workflowConstants.js";
import { CustomCheckbox } from "../../../common/CustomCheckbox.jsx";
import { WorkflowEngine } from "../../../../core/utils/workflow/workflowEngine.js";
import { useUser } from "../../../../core/contexts/UserContext.jsx";
import { useData } from "../../../../core/contexts/DataContext.jsx";
import { useToast } from "../../../common/Toast/ToastContext.jsx";
import { TOAST_TYPES } from "../../../../core/utils/constants.js";
import { executeCommand } from "../../../../core/commands/index.js";
import { useElementPermissions } from "../../../../data/hooks/useElementPermission.js";
import { canUserAccessInState } from "../../../../core/utils/workflow/elementPermissions.js";

export const PropertiesPanel = ({ selectedItem, type, publication, onUpdate, onPublicationUpdate, onBack, onOpen, runAndPersistPreflight }) => {
    // Hooks
    const { user } = useUser();
    const { layouts, applyArticleUpdate } = useData();
    const { showToast } = useToast();
    const [isSyncing, setIsSyncing] = useState(false);
    const [hasDeadlineErrors, setHasDeadlineErrors] = useState(false);

    // Elem jogosultságok
    const perm = useElementPermissions(['ignoreToggle']);
    const stateAccess = useMemo(
        () => type === 'article' ? canUserAccessInState(user, selectedItem?.state) : { allowed: true },
        [type, user?.teamIds, user?.labels, selectedItem?.state]
    );

    // Defensive guard
    const item = selectedItem || {};
    const itemName = item.name || "Részletek";
    const canOpen = type === 'article' && item.filePath;
    const isIgnored = type === 'article' && (item.markers & MARKERS.IGNORE) !== 0;

    console.log("[PropertiesPanel] Rendering item:", item.name, "State:", item.state);

    // Safety check for imported constants
    const safeWorkflowConfig = WORKFLOW_CONFIG || {};
    if (!WORKFLOW_CONFIG) console.warn("[PropertiesPanel] WORKFLOW_CONFIG is undefined!");

    // Az aktuális állapothoz tartozó parancsok feloldva a COMMANDS regiszterből
    const commands = useMemo(() => {
        if (type !== 'article' || item.state === undefined) return [];
        const stateCommandIds = safeWorkflowConfig[item.state]?.commands ?? [];
        return stateCommandIds.filter(id => COMMANDS[id]).map(id => ({ id, ...COMMANDS[id] }));
    }, [type, item.state]);

    // Parancsonkénti jogosultság: user.teamIds vagy user.labels alapján
    const commandPermissions = useMemo(() => {
        const result = {};
        for (const cmd of commands) {
            const allowed =
                !cmd.teams?.length ||
                user?.teamIds?.some(t => cmd.teams.includes(t)) ||
                user?.labels?.some(l => cmd.teams.includes(l));
            result[cmd.id] = { allowed, reason: allowed ? undefined : 'Nincs jogosultságod ehhez a parancshoz' };
        }
        return result;
    }, [commands, user?.teamIds, user?.labels]);

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
            const context = { item, user, publication, layouts, runAndPersistPreflight };
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
            console.error("Command execution error:", error);
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
                console.error("Marker toggle error:", result.error);
                showToast('A jelölő módosítása sikertelen', TOAST_TYPES.ERROR, errorMessage);
            }
        } catch (error) {
            console.error("Marker toggle exception:", error);
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
                        disabled={!canOpen || !stateAccess.allowed || undefined}
                        title={!stateAccess.allowed ? stateAccess.reason : undefined}
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
                        {commands.map(cmd => {
                            const cmdPerm = commandPermissions[cmd.id] ?? { allowed: false };
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
