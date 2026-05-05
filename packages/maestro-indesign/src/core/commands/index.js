import { handleExportPdf } from "./handlers/exportPdf.js";
import { handleCollectImages } from "./handlers/collectImages.js";
import { handleArchiving } from "./handlers/archiving.js";
import { handlePrinting } from "./handlers/printing.js";
import { handlePreflightCheck } from "./handlers/preflightCheck.js";
import { isExtensionRef, parseExtensionRef } from "maestro-shared/extensionContract.js";
import { dispatchExtensionCommand } from "../utils/extensions/extensionRegistry.js";
import { log, logWarn, logError } from "../utils/logger.js";

/**
 * Registry mapping command IDs to their handler functions.
 */
const COMMAND_REGISTRY = {
    'export_pdf': (ctx) => handleExportPdf({ ...ctx, commandId: 'export_pdf' }),
    'export_final_pdf': (ctx) => handleExportPdf({ ...ctx, commandId: 'export_final_pdf' }),
    'collect_images': handleCollectImages,
    'collect_selected_images': handleCollectImages,
    'archive': handleArchiving,
    'print_output': handlePrinting,
    'preflight_check': handlePreflightCheck
};

/**
 * Executes a command by ID.
 *
 * @param {string} commandId - The ID of the command to execute. Speciális eset: `ext.<slug>`
 *   alakú workflow extension hivatkozás — a `context.extensions` registry-ből oldódik fel
 *   (B.4.2 / ADR 0007 Phase 0).
 * @param {object} context - Context data (e.g., current item, user info, extensions).
 *   Az extension command ágon kötelező: `extensions` (registry Map) + `item` (article).
 *   Opcionális: `publication` (a `rootPath`-t a `publicationRoot` JSON I/O kulcsra mappeljük).
 * @returns {Promise<object>} Result of the command execution.
 */
export const executeCommand = async (commandId, context = {}) => {
    // Workflow extension hivatkozás (`ext.<slug>`) — Phase 0-ban (B.0.4) az `options`
    // szándékosan nem kerül átadásra; a JSON I/O csak `{ article, publicationRoot }` mezőt kap.
    if (isExtensionRef(commandId)) {
        const ref = parseExtensionRef(commandId);
        log(`[CommandExecutor] Extension command dispatch: ${commandId}`);
        return dispatchExtensionCommand(context.extensions, ref.slug, {
            article: context.item,
            publicationRoot: context.publication?.rootPath ?? null
        });
    }

    const handler = COMMAND_REGISTRY[commandId];
    if (!handler) {
        logWarn(`[CommandExecutor] No handler found for command: ${commandId}`);
        return { success: false, error: `Unknown command: ${commandId}` };
    }

    try {
        log(`[CommandExecutor] Executing ${commandId}...`);
        return await handler(context);
    } catch (error) {
        logError(`[CommandExecutor] Error executing ${commandId}:`, error);
        return { success: false, error: error.message };
    }
};
