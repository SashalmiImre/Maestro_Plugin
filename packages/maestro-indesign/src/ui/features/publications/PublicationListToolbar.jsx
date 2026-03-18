import React, { useCallback } from "react";
import { logError } from "../../../core/utils/logger.js";

export const PublicationListToolbar = ({ createPublication }) => {

    const handleCreatePublicationClick = useCallback(async () => {
        try {
            const folder = await require("uxp").storage.localFileSystem.getFolder();
            if (!folder) return;

            await createPublication(folder);
        } catch (e) {
            logError("Error creating publication:", e);
        }
    }, [createPublication]);

    return (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
            <sp-heading size="s" style={{ margin: 0 }}>KIADVÁNYOK</sp-heading>
            <sp-body style={{ margin: 0 }}>
                <div
                    onClick={handleCreatePublicationClick}
                    title="Új Kiadvány"
                    style={{ cursor: "pointer", display: "flex", alignItems: "center" }}>
                    <sp-icon-add-circle size="m" style={{ width: "14px", height: "14px", display: "inline-block" }}></sp-icon-add-circle>
                </div>
            </sp-body>
        </div>
    );
};
