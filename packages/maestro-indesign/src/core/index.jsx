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
import { account, handleSignOut, RECOVERY_URL } from "./config/appwriteConfig.js";

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
    // Ellenőrizzük, hogy van-e aktív session (React kontextuson kívül vagyunk)
    try {
        await account.get();
    } catch {
        // Nincs aktív session — nem kell kijelentkezni
        return;
    }

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

/** InDesign natív üzenet dialógus (az alert() nem létezik UXP-ben). */
const showMessage = (title, message) => {
    const inDesignApp = require("indesign").app;
    const dlg = inDesignApp.dialogs.add({ name: title, canCancel: false });
    dlg.dialogColumns.add();
    dlg.dialogColumns.item(0).staticTexts.add({ staticLabel: message });
    dlg.show();
    dlg.destroy();
};

/** Jelszó módosítása bejelentkezett felhasználónak (InDesign natív dialog). */
const changePassword = async () => {
    // Ellenőrizzük, hogy van-e aktív session
    try {
        await account.get();
    } catch {
        return; // Nincs aktív session
    }

    const inDesignApp = require("indesign").app;
    const dialog = inDesignApp.dialogs.add({
        name: "Jelszó módosítása",
        canCancel: true,
    });

    dialog.dialogColumns.add();
    const column = dialog.dialogColumns.item(0);

    // Jelenlegi jelszó
    column.staticTexts.add({ staticLabel: "Jelenlegi jelszó:" });
    const currentPasswordField = column.textEditboxes.add({ minWidth: 200 });

    // Új jelszó
    column.staticTexts.add({ staticLabel: "Új jelszó (min. 8 karakter):" });
    const newPasswordField = column.textEditboxes.add({ minWidth: 200 });

    // Új jelszó megerősítés
    column.staticTexts.add({ staticLabel: "Új jelszó megerősítés:" });
    const confirmPasswordField = column.textEditboxes.add({ minWidth: 200 });

    const isConfirmed = dialog.show();

    if (isConfirmed) {
        const currentPassword = currentPasswordField.editContents;
        const newPassword = newPasswordField.editContents;
        const confirmPassword = confirmPasswordField.editContents;

        dialog.destroy();

        if (!currentPassword || !newPassword || !confirmPassword) {
            showMessage("Hiba", "Minden mező kitöltése kötelező!");
            return;
        }

        if (newPassword.length < 8) {
            showMessage("Hiba", "Az új jelszónak legalább 8 karakter hosszúnak kell lennie!");
            return;
        }

        if (newPassword !== confirmPassword) {
            showMessage("Hiba", "Az új jelszavak nem egyeznek!");
            return;
        }

        try {
            await account.updatePassword({ password: newPassword, oldPassword: currentPassword });
            showMessage("Siker", "Jelszó sikeresen módosítva!");
        } catch (error) {
            console.error("[ChangePassword] Hiba:", error);
            showMessage("Hiba", `Jelszó módosítása sikertelen: ${error?.message ?? "Ismeretlen hiba"}`);
        }
    } else {
        dialog.destroy();
    }
};

/** Elfelejtett jelszó — recovery email küldése (InDesign natív dialog). */
const resetPassword = async () => {
    const inDesignApp = require("indesign").app;
    const dialog = inDesignApp.dialogs.add({
        name: "Elfelejtett jelszó",
        canCancel: true,
    });

    dialog.dialogColumns.add();
    const column = dialog.dialogColumns.item(0);

    column.staticTexts.add({ staticLabel: "Add meg az email címedet:" });
    const emailField = column.textEditboxes.add({ minWidth: 200 });

    const isConfirmed = dialog.show();

    if (isConfirmed) {
        const email = emailField.editContents;
        dialog.destroy();

        if (!email) {
            showMessage("Hiba", "Az email cím megadása kötelező!");
            return;
        }

        try {
            await account.createRecovery({ email, url: RECOVERY_URL });
            showMessage("Email elküldve", "Jelszó-visszaállító link elküldve az email címedre!");
        } catch (error) {
            console.error("[ResetPassword] Hiba:", error);
            showMessage("Hiba", `${error?.message ?? "Ismeretlen hiba"}`);
        }
    } else {
        dialog.destroy();
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
            menuItems: [
                { id: "signOut", label: "Kijelentkezés" },
                { id: "changePassword", label: "Jelszó módosítása" },
                { id: "resetPassword", label: "Elfelejtett jelszó" },
            ],
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
                    case "changePassword":
                        await changePassword();
                        break;
                    case "resetPassword":
                        await resetPassword();
                        break;
                    default:
                        console.warn(`Ismeretlen menüpont: ${id}`);
                }
            },
        },
    },
});
