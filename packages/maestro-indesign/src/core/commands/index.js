import { handleExportPdf } from "./handlers/exportPdf.js";
import { handleCollectImages } from "./handlers/collectImages.js";
import { handleArchiving } from "./handlers/archiving.js";
import { handlePrinting } from "./handlers/printing.js";
import { handlePreflightCheck } from "./handlers/preflightCheck.js";

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
 * @param {string} commandId - The ID of the command to execute.
 * @param {object} context - Context data (e.g., current item, user info).
 * @returns {Promise<object>} Result of the command execution.
 */
export const executeCommand = async (commandId, context = {}) => {
    const handler = COMMAND_REGISTRY[commandId];
    
    if (!handler) {
        console.warn(`[CommandExecutor] No handler found for command: ${commandId}`);
        return { success: false, error: `Unknown command: ${commandId}` };
    }

    try {
        console.log(`[CommandExecutor] Executing ${commandId}...`);
        return await handler(context);
    } catch (error) {
        console.error(`[CommandExecutor] Error executing ${commandId}:`, error);
        return { success: false, error: error.message };
    }
};
