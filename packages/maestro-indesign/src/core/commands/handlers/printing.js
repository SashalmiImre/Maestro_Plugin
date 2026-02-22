import { generatePrintPdfScript, generateIsDocumentOpenScript } from "../../utils/indesign/index.js";
import { executeScript } from "../../utils/indesign/indesignUtils.js";
import { WorkflowEngine } from "../../utils/workflow/workflowEngine.js";
import { LOCK_TYPE } from "../../utils/constants.js";
import * as pathUtils from "../../utils/pathUtils.js";
import { validate } from "../../utils/validationRunner.js";

/**
 * Handles the 'print_output' (Levilágítás) command.
 * Oldalanként egyedi PDF/X-1a:2001 fájlokat exportál a __PRINT_PDF__ mappába.
 * Preflight ellenőrzés után fut. Támogatja a zöld oldal-szín alapú szelektív exportot.
 *
 * @param {object} context - Context data including the item (article), publication, layouts.
 * @returns {Promise<object>} Result of the operation.
 */
export const handlePrinting = async (context) => {
    const { item, publication, user, layouts } = context;

    console.log("[Command] Print output (Levilágítás) for:", item?.name);

    if (!item || !item.filePath) {
        return { success: false, error: "Nincs érvényes cikk kiválasztva." };
    }

    const publicationPath = publication.rootPath || publication.path;
    if (!publicationPath) {
        return { success: false, error: "A publikáció útvonala nem található." };
    }

    // 1. Layout név feloldása (fájlnévben használjuk)
    const layout = (layouts || []).find(l => l.$id === item.layout);
    const layoutName = layout?.name ?? "Layout";

    // 2. Preflight futtatás
    const preflightResult = await validate(item, 'preflight_check');
    if (!preflightResult.isValid) {
        return {
            success: false,
            error: "Preflight hiba — nem exportálható:\n" + preflightResult.errors.join("\n")
        };
    }

    // 3. Útvonal feloldás
    const printFolder = pathUtils.joinPath(publicationPath, "__PRINT_PDF__");
    const maxPage = publication.coverageEnd || publication.pageCount;

    // 4. Lock ha zárt dokumentum
    let lockedBySystem = false;
    let lockedItem = null;

    try {
        const checkOpenScript = generateIsDocumentOpenScript(item.filePath);
        const isOpenResult = await executeScript(checkOpenScript);
        const isAlreadyOpen = isOpenResult === "true";

        // sourcePath: null ha nyitott (aktív dokumentumot használjuk), filePath ha zárt
        let sourcePath = null;

        if (!isAlreadyOpen) {
            console.log("[Command] Document is closed. Locking for background processing...");
            const lockResult = await WorkflowEngine.lockDocument(item, LOCK_TYPE.SYSTEM, user);
            if (!lockResult.success) {
                return { success: false, error: `Nem sikerült zárolni a dokumentumot: ${lockResult.error}` };
            }
            lockedBySystem = true;
            lockedItem = lockResult.document;
            sourcePath = item.filePath;
        } else {
            console.log("[Command] Document is already open.");
        }

        // 5. Script futtatás
        const printScript = generatePrintPdfScript(sourcePath, printFolder, layoutName, maxPage);
        const result = await executeScript(printScript);

        // Eredmény értelmezése: "SUCCESS:message" vagy "ERROR:message"
        if (typeof result === 'string' && result.indexOf("SUCCESS:") === 0) {
            const message = result.substring(8);
            return { success: true, message: "Levilágítás kész — " + message };
        }

        if (typeof result === 'string' && result.indexOf("ERROR:") === 0) {
            return { success: false, error: result.substring(6) };
        }

        return { success: false, error: result || "Ismeretlen hiba a levilágítás során." };

    } catch (error) {
        console.error("[Command] Print output error:", error);
        return { success: false, error: error.message };
    } finally {
        if (lockedBySystem) {
            console.log("[Command] Unlocking document...");
            try {
                await WorkflowEngine.unlockDocument(lockedItem || item, user);
            } catch (unlockError) {
                console.error(`[Command] Failed to unlock document after print output. Item: ${(lockedItem || item).$id}`, unlockError);
            }
        }
    }
};
