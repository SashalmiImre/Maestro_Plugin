import React, { useCallback } from "react";

export const PublicationListToolbar = ({ createPublication }) => {

    const handleCreatePublicationClick = useCallback(async () => {
        try {
            const folder = await require("uxp").storage.localFileSystem.getFolder();
            if (!folder) return;

            await createPublication(folder);
        } catch (e) {
            console.error("Error creating publication:", e);
        }
    }, [createPublication]);

    return (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
            <sp-heading size="s">KIADVÁNYOK</sp-heading>
            <div style={{ display: "flex", alignItems: "center" }}>
                <sp-action-button
                    quiet
                    onClick={handleCreatePublicationClick}
                    title="Új Kiadvány"
                    className="icon-btn"
                    size="s">
                    <sp-icon-add slot="icon" size="s" style={{ width: "14px", height: "14px", display: "inline-block" }}></sp-icon-add>
                </sp-action-button>
            </div>
        </div>
    );
};
