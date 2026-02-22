/**
 * @fileoverview InDesign modul barrel export.
 *
 * Összefogja az InDesign-specifikus scriptgenerátorokat, parsereket és utility-ket.
 *
 * @module utils/indesign
 */

// Dokumentum műveletek és parserek
export {
    generateExtractPageNumbersInBackground,
    generateIsDocumentOpenScript,
    generateRenumberDocumentScript,
    generateSaveDocumentScript,
    generateCloseDocumentScript,
    generateOpenDocumentScript,
    generateExtractPageRangesScript,
    generateGetActiveDocumentPathScript,
    generateGetDocumentIdScript,
    generateRenameFileScript,
    generateRenameOpenDocumentScript,
    generateRollbackRenameScript,
    parsePageRangesResult,
    parseExecutionStatus
} from "./documentScripts.js";

// Preflight
export {
    generatePreflightScript,
    parsePreflightResult
} from "./preflightScripts.js";

// Export & képgyűjtés
export {
    generateExportPdfScript,
    generateCollectImagesScript
} from "./exportScripts.js";

// InDesign UXP utility-k
export {
    getIndesignModule,
    getIndesignApp,
    findActiveDocument,
    getDocPath,
    extractPageNumbers,
    resolveTargetToDoc,
    getOpenDocumentPaths,
    getFileTimestamp,
    executeScript
} from "./indesignUtils.js";

// pathUtils re-export (kompatibilitás)
export { escapePathForExtendScript } from "../pathUtils.js";
