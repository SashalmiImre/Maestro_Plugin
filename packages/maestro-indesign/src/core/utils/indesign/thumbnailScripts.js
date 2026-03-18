/**
 * @fileoverview Thumbnail (oldalkép) generálás ExtendScript generátorai.
 * JPEG exportot használ oldalanként, 120 DPI felbontással.
 *
 * @module utils/indesign/thumbnailScripts
 */

import { escapePathForExtendScript } from "../pathUtils.js";
import {
    getBackgroundOpenLogic,
    getLinkCheckLogic,
    getSafeCloseLogic,
    getDocumentTargetLogic,
    getJpegPageExportLogic
} from "./scriptHelpers.js";

/**
 * Generál egy scriptet thumbnail JPEG exportáláshoz háttérben nyitott dokumentumból.
 * Használat: documentClosed hook (a DocumentMonitor már bezárta, újra kell nyitni)
 * és addArticle (háttérben nyitott dokumentum).
 *
 * @param {string} sourcePath - A forrás INDD fájl útvonala.
 * @param {string} outputFolderPath - A kimeneti mappa útvonala (Folder.temp alatti almappa).
 * @returns {string} ExtendScript kód.
 */
export function generateThumbnailExportScript(sourcePath, outputFolderPath) {
    const escapedOutputFolder = escapePathForExtendScript(outputFolderPath);

    const openLogic = getBackgroundOpenLogic(sourcePath, "doc", "openedInBackground");
    const linkCheckLogic = getLinkCheckLogic("doc", "openedInBackground");
    const closeLogic = getSafeCloseLogic("doc", "openedInBackground", "SaveOptions.NO");
    const jpegExportLogic = getJpegPageExportLogic("doc", "tempFolder");

    return `
        (function() {
            var doc = null;
            var openedInBackground = false;

            try {
                // 1. DOKUMENTUM MEGNYITÁSA (háttérben)
                ${openLogic}

                // 2. LINK ELLENŐRZÉS (MISSING + OUT_OF_DATE → kihagyás)
                ${linkCheckLogic}

                // 3. KIMENETI MAPPA
                var tempFolder = new Folder("${escapedOutputFolder}");
                if (!tempFolder.exists) tempFolder.create();

                // 4. JPEG EXPORT (oldalanként)
                ${jpegExportLogic}

                // 5. BEZÁRÁS
                ${closeLogic}

                if (exportedPaths.length === 0) {
                    return "ERROR:Egyetlen oldal sem exportálódott.";
                }

                return "SUCCESS:" + exportedPaths.length + ":" + exportedPaths.join("|");

            } catch(e) {
                ${closeLogic}
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet thumbnail JPEG exportáláshoz már nyitott dokumentumból.
 * Használat: addArticle, amikor a dokumentumot a felhasználó vagy a script nyitotta meg.
 *
 * @param {string} filePath - A nyitott fájl útvonala (azonosításhoz).
 * @param {string} outputFolderPath - A kimeneti mappa útvonala.
 * @returns {string} ExtendScript kód.
 */
export function generateThumbnailExportForOpenDocScript(filePath, outputFolderPath) {
    const escapedOutputFolder = escapePathForExtendScript(outputFolderPath);

    const docTargetLogic = getDocumentTargetLogic("doc", filePath);
    // Nyitott dokumentumnál nincs openedInBackground flag — a link check bezárása nem szükséges,
    // de a "false" literál biztosítja, hogy a getLinkCheckLogic close ágja ne fusson.
    const linkCheckLogic = getLinkCheckLogic("doc", "false");
    const jpegExportLogic = getJpegPageExportLogic("doc", "tempFolder");

    return `
        (function() {
            try {
                // 1. NYITOTT DOKUMENTUM MEGKERESÉSE
                ${docTargetLogic}

                // 2. LINK ELLENŐRZÉS (MISSING + OUT_OF_DATE → kihagyás)
                ${linkCheckLogic}

                // 3. KIMENETI MAPPA
                var tempFolder = new Folder("${escapedOutputFolder}");
                if (!tempFolder.exists) tempFolder.create();

                // 4. JPEG EXPORT (oldalanként)
                ${jpegExportLogic}

                if (exportedPaths.length === 0) {
                    return "ERROR:Egyetlen oldal sem exportálódott.";
                }

                return "SUCCESS:" + exportedPaths.length + ":" + exportedPaths.join("|");

            } catch(e) {
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Parserálja a thumbnail export script eredményét.
 *
 * Bemeneti formátumok:
 * - `"SUCCESS:<count>:<path1>|<path2>|..."`
 * - `"ERROR:Képproblémák..."` (getLinkCheckLogic formátum)
 * - `"ERROR:<msg>"`
 *
 * @param {string} resultStr - A script visszatérési értéke.
 * @returns {{ success: boolean, filePaths: string[], count: number, linkProblems: boolean, error: string|null }}
 */
export function parseThumbnailExportResult(resultStr) {
    if (!resultStr || typeof resultStr !== 'string') {
        return { success: false, filePaths: [], count: 0, linkProblems: false, error: 'Üres eredmény' };
    }

    if (resultStr.startsWith('SUCCESS:')) {
        const parts = resultStr.substring(8).split(':');
        const count = parseInt(parts[0], 10) || 0;
        const filePaths = parts[1] ? parts[1].split('|') : [];
        return { success: true, filePaths, count, linkProblems: false, error: null };
    }

    // A getLinkCheckLogic "ERROR:Képproblémák találhatók" formátumot ad vissza
    if (resultStr.startsWith('ERROR:Képproblémák')) {
        return {
            success: false,
            filePaths: [],
            count: 0,
            linkProblems: true,
            error: resultStr.substring(6)
        };
    }

    if (resultStr.startsWith('ERROR:')) {
        return { success: false, filePaths: [], count: 0, linkProblems: false, error: resultStr.substring(6) };
    }

    return { success: false, filePaths: [], count: 0, linkProblems: false, error: resultStr };
}
