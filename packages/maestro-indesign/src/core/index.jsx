/*
Copyright 2023 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

/**
 * Alkalmazás belépési pont.
 * Polyfill-ek, Spectrum komponensek regisztrálása, és a UXP panel életciklus beállítása.
 */

// --- Polyfill-ek (más importok előtt kell betölteni) ---
import "../polyfill.js";

// --- Vendor / Framework ---
import React from "react";
import { entrypoints } from "uxp";
import { Theme } from "@swc-react/theme";
// Spectrum CSS — téma változók
import "@spectrum-web-components/styles/typography.css";
import "@spectrum-web-components/theme/theme-dark.js";
import "@spectrum-web-components/theme/theme-light.js";
import "@spectrum-web-components/styles/spectrum-scale-medium.css";

// SWC UXP Wrappers — sp-theme komponens
import "@swc-uxp-wrappers/utils";

// Központosított SWC komponens importok (dupla regisztráció elkerülése)
import "@swc-uxp-wrappers/dialog/sp-dialog.js";
import "@swc-uxp-wrappers/action-button/sp-action-button.js";
import "@swc-uxp-wrappers/tags/sp-tags.js";
import "@swc-uxp-wrappers/tags/sp-tag.js";
import "@swc-uxp-wrappers/divider/sp-divider.js";
import "@swc-uxp-wrappers/field-label/sp-field-label.js";
import "@swc-uxp-wrappers/button-group/sp-button-group.js";
import "@swc-uxp-wrappers/checkbox/sp-checkbox.js";
import "@swc-uxp-wrappers/popover/sp-popover.js";
import "@swc-uxp-wrappers/picker-button/sp-picker-button.js";

// Központosított Spectrum ikon importok
import "@spectrum-web-components/icons-workflow/icons/sp-icon-chevron-right.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-chevron-down.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-add.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-delete.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-filter.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-arrow-left.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-arrow-right.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-checkmark.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-alert.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-close-circle.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-stopwatch.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-refresh.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-file-pd-f.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-archive.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-print.js";
import "@spectrum-web-components/icons-workflow/icons/sp-icon-images.js";

// --- Contexts & Hooks ---
import { AuthorizationProvider } from "./contexts/UserContext.jsx";
import { ConnectionProvider } from "./contexts/ConnectionContext.jsx";

// --- Config & Constants ---
import { handleSignOut } from "./config/appwriteConfig.js";

// --- Components & Assets ---
import { PanelController } from "./controllers/panelController.jsx";
import { Main } from "./Main.jsx";
import "../index.css";

// UXP Performance API polyfill — React 19 kompatibilitás
if (typeof window !== "undefined" && window.performance) {
    const originalMeasure = window.performance.measure;
    window.performance.measure = function (name, startMark, endMark) {
        try {
            if (originalMeasure) {
                return originalMeasure.apply(this, arguments);
            }
        } catch (error) {
            // UXP-ben nem támogatott, biztonságosan figyelmen kívül hagyjuk
        }
    };

    const originalMark = window.performance.mark;
    window.performance.mark = function (name) {
        try {
            if (originalMark) {
                return originalMark.apply(this, arguments);
            }
        } catch (error) {
            // UXP-ben nem támogatott, biztonságosan figyelmen kívül hagyjuk
        }
    }
}

const mainController = new PanelController(() => (
    <Theme theme="spectrum" scale="medium" color="dark">
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <ConnectionProvider>
                <AuthorizationProvider>
                    <Main />
                </AuthorizationProvider>
            </ConnectionProvider>
        </div>
    </Theme>
), {
    id: "main",
});

/** Kijelentkezés megerősítő dialógussal (InDesign natív dialog, React kontextuson kívül). */
const confirmSignOut = async () => {
    const inDesignApp = require("indesign").app;
    const dialog = inDesignApp.dialogs.add({
        name: "Kijelentkezés megerősítése",
        canCancel: true,
    });

    dialog.dialogColumns.add();
    const column = dialog.dialogColumns.item(0);
    const confirmationLabel = column.staticTexts.add();
    confirmationLabel.staticLabel = "Valóban ki akar jelentkezni?";

    const isConfirmed = dialog.show();
    dialog.destroy();

    if (isConfirmed) {
        try {
            await handleSignOut();
        } catch (error) {
            console.warn("Kijelentkezés sikertelen (session hiányozhat), újratöltés:", error);
        }
        // Panel újratöltése az állapot visszaállításához (React kontextuson kívül vagyunk)
        location.reload();
    }
};

entrypoints.setup({
    plugin: {
        create() { },
        destroy() { },
    },
    panels: {
        main: {
            ...mainController,
            show(rootNode) {
                console.log("[Entrypoints] Panel show() életciklus hook meghívva");
                if (mainController.show) {
                    mainController.show.call(mainController, rootNode);
                }
            },
            hide() {
                console.log("[Entrypoints] Panel hide() életciklus hook meghívva");
                if (mainController.hide) {
                    mainController.hide.call(mainController);
                }
            },
            async invokeMenu(id) {
                switch (id) {
                    case "signOut":
                        await confirmSignOut();
                        break;
                    default:
                        console.warn(`Ismeretlen menüpont: ${id}`);
                }
            },
        },
    },
});
