import { generateExportPdfScript, generateIsDocumentOpenScript, parseExecutionStatus } from "../../utils/indesign/index.js";
import { executeScript } from "../../utils/indesign/indesignUtils.js";
import { WorkflowEngine } from "../../utils/workflow/workflowEngine.js";
import { LOCK_TYPE } from "../../utils/constants.js";
import * as pathUtils from "../../utils/pathUtils.js";
import { formatPagedFileName } from "../../utils/namingUtils.js";
import { validate } from "../../utils/validationRunner.js";
import { VALIDATOR_TYPES } from "../../utils/validationConstants.js";

/**
 * Handles the 'export_pdf' and 'export_final_pdf' commands.
 * 
 * @param {object} context - Context data including the item (article) and publication.
 * @returns {Promise<object>} Result of the operation.
 */
export const handleExportPdf = async (context) => {
    const { item, publication, user, commandId } = context;

    console.log(`[Command] Exporting PDF (${commandId}) for:`, item?.name);

    if (!item || !item.filePath) {
        return { success: false, error: "Nincs érvényes cikk kiválasztva." };
    }

    const publicationPath = publication.rootPath || publication.path;
    if (!publicationPath) {
        return { success: false, error: "A publikáció útvonala nem található." };
    }

    // 1. Path resolution
    // PDF folder is inside publication folder
    let folderName = "__PDF__";
    if (commandId === "export_final_pdf") {
        folderName = "__FINAL_PDF__";
    }
    const pdfFolder = pathUtils.joinPath(publicationPath, folderName);
    // PDF file name generation
    const maxPage = publication.coverageEnd || publication.pageCount;
    const pdfFileName = formatPagedFileName(item.name, item.startPage, item.endPage, maxPage, ".pdf");
    
    // Normalize paths just in case (replace backslashes if on PC, etc. handled by script generator mostly)
    // But here we construct the path string.
    const outputPath = pathUtils.joinPath(pdfFolder, pdfFileName);

    console.log("[Command] Output path:", outputPath);

    // 2. Preflight ellenőrzés végleges PDF exportálás előtt
    if (commandId === "export_final_pdf") {
        const preflightResult = await validate(item, VALIDATOR_TYPES.PREFLIGHT_CHECK);
        if (!preflightResult.isValid) {
            return {
                success: false,
                error: "Preflight hiba — nem exportálható végleges PDF:\n" + preflightResult.errors.join("\n")
            };
        }
    }

    // 3. Check setup: Lock if needed
    let lockedBySystem = false;
    let lockedItem = null;

    try {
        // Check if document is open
        const checkOpenScript = generateIsDocumentOpenScript(item.filePath);
        const isOpenResult = await executeScript(checkOpenScript);
        const isAlreadyOpen = isOpenResult === "true";

        if (!isAlreadyOpen) {
            console.log("[Command] Document is closed. Locking for background processing...");
            // Lock document in DB
            const lockResult = await WorkflowEngine.lockDocument(item, LOCK_TYPE.SYSTEM, user);
            if (!lockResult.success) {
                 return { success: false, error: `Nem sikerült zárolni a dokumentumot: ${lockResult.error}` };
            }
            lockedBySystem = true;
            lockedItem = lockResult.document;
        } else {
            console.log("[Command] Document is already open.");
        }

        // 3. Execute Export Script
        const exportScript = generateExportPdfScript(item.filePath, outputPath);
        const result = await executeScript(exportScript);
        
        const parsedResult = parseExecutionStatus(result);

        if (!parsedResult.success) {
            return { success: false, error: parsedResult.error };
        }

        return { success: true, message: "PDF sikeresen exportálva: " + pdfFileName };

    } catch (error) {
        console.error("[Command] Export PDF error:", error);
        return { success: false, error: error.message };
    } finally {
        // 4. Cleanup: Unlock if we locked it
        if (lockedBySystem) {
             console.log("[Command] Unlocking document...");
             try {
                 // Use lockedItem which has the correct lockOwnerId field
                 await WorkflowEngine.unlockDocument(lockedItem || item, user);
             } catch (unlockError) {
                 console.error(`[Command] Failed to unlock document after export. Item: ${(lockedItem || item).$id}, SystemLock: ${lockedBySystem}`, unlockError);
             }
        }
    }
};
