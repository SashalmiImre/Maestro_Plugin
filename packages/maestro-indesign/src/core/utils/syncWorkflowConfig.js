/**
 * @file syncWorkflowConfig.js
 * @description Workflow konfiguráció szinkronizálása az Appwrite DB-be.
 *
 * A Cloud Function-ök a `config` collection `workflow_config` dokumentumából
 * olvassák a workflow konstansokat (STATE_PERMISSIONS, VALID_TRANSITIONS stb.),
 * nem hardkódolnak semmit. A plugin felelős a DB-beli config naprakészen tartásáért.
 *
 * Induláskor:
 * 1. Olvassa a DB-beli config dokumentumot (egyetlen getDocument hívás)
 * 2. Összehasonlítja a configVersion-t a helyi CONFIG_VERSION-nel
 * 3. Ha eltér (vagy nem létezik) → upsert-eli a friss értékekkel
 *
 * Normál induláskor: 0 írás, 1 olvasás. Csak plugin frissítés után ír.
 */

import { tables, DATABASE_ID, CONFIG_COLLECTION_ID, ID } from "../config/appwriteConfig.js";
import { CONFIG_VERSION, CONFIG_DOCUMENT_ID } from "maestro-shared/workflowConfig.js";
import { buildWorkflowConfigDocument } from "./workflow/workflowConstants.js";
import { log, logError, logDebug } from "./logger.js";

/**
 * Szinkronizálja a workflow konfigurációt a DB-be, ha szükséges.
 * Háttérben fut, nem blokkolja a UI-t.
 *
 * @returns {Promise<void>}
 */
export async function syncWorkflowConfig() {
    try {
        // 1. Meglévő config olvasása
        let existingDoc = null;
        try {
            existingDoc = await tables.getRow({
                databaseId: DATABASE_ID,
                tableId: CONFIG_COLLECTION_ID,
                rowId: CONFIG_DOCUMENT_ID
            });
        } catch (e) {
            // 404 = nem létezik még → létrehozzuk
            if (e.code !== 404) {
                throw e;
            }
        }

        // 2. Verzió összehasonlítás
        if (existingDoc?.configVersion === CONFIG_VERSION) {
            logDebug(`[syncWorkflowConfig] Config naprakész (v${CONFIG_VERSION})`);
            return;
        }

        // 3. Upsert: friss config dokumentum építése és írása
        const configData = buildWorkflowConfigDocument();

        if (existingDoc) {
            // Frissítés — a dokumentum már létezik, csak a verzió régi
            await tables.updateRow({
                databaseId: DATABASE_ID,
                tableId: CONFIG_COLLECTION_ID,
                rowId: CONFIG_DOCUMENT_ID,
                data: configData
            });
            log(`[syncWorkflowConfig] Config frissítve: v${existingDoc.configVersion} → v${CONFIG_VERSION}`);
        } else {
            // Létrehozás — első futás, a dokumentum még nem létezik
            await tables.createRow({
                databaseId: DATABASE_ID,
                tableId: CONFIG_COLLECTION_ID,
                rowId: CONFIG_DOCUMENT_ID,
                data: configData
            });
            log(`[syncWorkflowConfig] Config létrehozva (v${CONFIG_VERSION})`);
        }
    } catch (error) {
        // Nem blokkoló hiba — a plugin működik nélküle is,
        // de a Cloud Function-ök nem fognak validálni config nélkül
        logError('[syncWorkflowConfig] Config szinkronizálás sikertelen:', error);
    }
}
