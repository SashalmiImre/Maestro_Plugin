/**
 * @fileoverview Tördelő AI parancs handlerek.
 *
 * Két üzemmód:
 *  1. InDesign mód: Az aktív dokumentum spreadjeit JPEG-ként exportálja, majd elemzi.
 *  2. Mappa mód: Egy megadott mappa JPG fájljait elemzi.
 *
 * Az elemzés a proxy `/api/analyze-layout` endpoint-on keresztül történik
 * (Claude Vision API + stíluskönyv PDF kontextus).
 *
 * @module commands/handlers/layoutAI
 */

import {
    generateExportSpreadsAsJPEG,
    generateListJPGsInFolder
} from "../../utils/indesign/layoutAIScripts.js";
import { processAndStore, validateAnalysisResult } from "../../utils/layoutAIProcessor.js";
import { executeScript } from "../../utils/indesign/indesignUtils.js";
import { endpointManager } from "../../config/appwriteConfig.js";
import { logError, logWarn, log } from "../../utils/logger.js";
import { LAYOUT_AI_TIMEOUT_MS, LAYOUT_JPEG_DPI, LAYOUT_JPEG_QUALITY } from "../../utils/constants.js";

const uxp = require('uxp');
const fs = uxp.storage.localFileSystem;

/**
 * Handles the 'analyze_layout' command — InDesign mód.
 *
 * Exportálja az aktív dokumentum spreadjeit JPEG-ként, majd egyenként
 * elküldi az AI-nak elemzésre, és az eredményeket Appwrite-ba menti.
 *
 * @param {object} context - Parancs kontextus.
 * @param {object} context.item - A kiválasztott cikk (filePath, name, startPage, endPage).
 * @param {object} context.publication - A kiadvány (rootPath, $id).
 * @returns {Promise<object>} { success, message, processedCount } vagy { success: false, error }.
 */
export const handleAnalyzeLayout = async (context) => {
    const { item, publication } = context;

    if (!item?.filePath) {
        return { success: false, error: "Nincs érvényes cikk kiválasztva." };
    }

    const publicationId = publication?.$id || null;

    log(`[Layout AI] InDesign elemzés indítása: ${item.name}`);

    try {
        // 1. Ideiglenes mappa a JPEG exporthoz
        const tempFolder = await fs.getTemporaryFolder();
        const exportFolder = `${tempFolder.nativePath}/layout_ai_export`;

        // 2. Spreadek exportálása JPEG-ként
        const exportScript = generateExportSpreadsAsJPEG(
            item.filePath, exportFolder, LAYOUT_JPEG_DPI, LAYOUT_JPEG_QUALITY
        );
        const exportResult = await executeScript(exportScript);

        if (!exportResult) {
            return { success: false, error: "JPEG export sikertelen: nincs válasz" };
        }

        let exportData;
        try {
            exportData = JSON.parse(exportResult);
        } catch (parseErr) {
            logError('[Layout AI] Export JSON parse hiba', parseErr);
            return { success: false, error: `JPEG export parse hiba: ${parseErr.message}` };
        }

        if (!exportData.success) {
            return { success: false, error: `JPEG export hiba: ${exportData.error}` };
        }

        log(`[Layout AI] ${exportData.spreadCount} spread exportálva`);

        // 3. Minden exportált JPEG elemzése az AI-val
        const proxyBase = endpointManager.getProxyBase();
        const aiUrl = `${proxyBase}/api/analyze-layout`;
        let processedCount = 0;
        let errorCount = 0;

        for (const spread of exportData.results) {
            if (!spread.success) {
                logWarn(`[Layout AI] Spread kihagyva (export hiba): ${spread.pageNumbers}`);
                errorCount++;
                continue;
            }

            try {
                // JPEG fájl beolvasása
                const jpegFile = await fs.getEntryForPersistentToken(spread.filePath)
                    .catch(() => null);

                let imageBuffer;
                if (jpegFile) {
                    imageBuffer = await jpegFile.read({ format: uxp.storage.formats.binary });
                } else {
                    // Fallback: ExtendScript-tel olvasunk
                    log(`[Layout AI] Közvetlen fájl hozzáférés nem sikerült: ${spread.filePath}`);
                    // Ha nem tudunk közvetlenül olvasni, base64-be konvertáljuk
                    // és a batch endpoint-ot használjuk
                    errorCount++;
                    continue;
                }

                // FormData összeállítása
                const formData = new FormData();
                formData.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), spread.fileName);
                formData.append('publicationId', publicationId || '');
                formData.append('pageNumbers', spread.pageNumbers || '');

                // AI elemzés küldése
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), LAYOUT_AI_TIMEOUT_MS);

                let response;
                try {
                    response = await fetch(aiUrl, {
                        method: 'POST',
                        body: formData,
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.message || `HTTP ${response.status}`);
                }

                const result = await response.json();

                if (!result.success || !result.analysis) {
                    throw new Error(result.error || 'Érvénytelen AI válasz');
                }

                // Appwrite-ba mentés (screenshot + precedens)
                await processAndStore(
                    result.analysis,
                    imageBuffer,
                    spread.fileName,
                    { publicationId, pageNumbers: spread.pageNumbers }
                );

                processedCount++;
                log(`[Layout AI] Spread kész: ${spread.pageNumbers} → ${result.analysis.pageType}`);

            } catch (spreadErr) {
                logError(`[Layout AI] Spread elemzés hiba (${spread.pageNumbers})`, spreadErr);
                errorCount++;
            }
        }

        const message = `Layout elemzés kész: ${processedCount} spread elemezve` +
            (errorCount > 0 ? `, ${errorCount} hiba` : '');

        log(`[Layout AI] ${message}`);
        return { success: true, message, processedCount, errorCount };

    } catch (err) {
        logError('[Layout AI] Kivétel', err);
        return { success: false, error: err.message || "Ismeretlen hiba" };
    }
};

/**
 * Handles the 'analyze_layout_folder' command — Mappa mód.
 *
 * Egy megadott mappából olvassa be a JPG fájlokat, és egyenként
 * elküldi az AI-nak elemzésre.
 *
 * @param {object} context - Parancs kontextus.
 * @param {string} context.folderPath - A mappa útvonala.
 * @param {object} [context.publication] - A kiadvány (ha van, $id-t használjuk).
 * @returns {Promise<object>} { success, message, processedCount } vagy { success: false, error }.
 */
export const handleAnalyzeFromFolder = async (context) => {
    const { folderPath, publication } = context;

    if (!folderPath) {
        return { success: false, error: "Nincs mappa útvonal megadva." };
    }

    const publicationId = publication?.$id || null;

    log(`[Layout AI] Mappa elemzés indítása: ${folderPath}`);

    try {
        // 1. JPG fájlok listázása ExtendScript-tel
        const listScript = generateListJPGsInFolder(folderPath);
        const listResult = await executeScript(listScript);

        if (!listResult) {
            return { success: false, error: "Mappa listázás sikertelen: nincs válasz" };
        }

        let listData;
        try {
            listData = JSON.parse(listResult);
        } catch (parseErr) {
            return { success: false, error: `Mappa lista parse hiba: ${parseErr.message}` };
        }

        if (!listData.success) {
            return { success: false, error: listData.error || "Mappa listázás sikertelen" };
        }

        if (listData.fileCount === 0) {
            return { success: false, error: "Nem található JPG fájl a mappában." };
        }

        log(`[Layout AI] ${listData.fileCount} JPG fájl a mappában`);

        // 2. Fájlok feldolgozása szekvenciálisan
        const proxyBase = endpointManager.getProxyBase();
        const aiUrl = `${proxyBase}/api/analyze-layout`;
        let processedCount = 0;
        let errorCount = 0;

        for (let i = 0; i < listData.files.length; i++) {
            const fileInfo = listData.files[i];

            try {
                // Fájl beolvasása UXP filesystem-mel
                const entry = await fs.getEntryForPersistentToken(fileInfo.filePath)
                    .catch(() => null);

                let imageBuffer;
                if (entry) {
                    imageBuffer = await entry.read({ format: uxp.storage.formats.binary });
                } else {
                    logWarn(`[Layout AI] Fájl nem elérhető: ${fileInfo.fileName}`);
                    errorCount++;
                    continue;
                }

                // Oldalszám kinyerés a fájlnévből (ha spread_001.jpg formátumú)
                const pageNumMatch = fileInfo.fileName.match(/(\d+)/);
                const pageNumbers = pageNumMatch ? pageNumMatch[1] : null;

                // FormData
                const formData = new FormData();
                formData.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), fileInfo.fileName);
                formData.append('publicationId', publicationId || '');
                if (pageNumbers) formData.append('pageNumbers', pageNumbers);

                // AI elemzés
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), LAYOUT_AI_TIMEOUT_MS);

                let response;
                try {
                    response = await fetch(aiUrl, {
                        method: 'POST',
                        body: formData,
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.message || `HTTP ${response.status}`);
                }

                const result = await response.json();

                if (!result.success || !result.analysis) {
                    throw new Error(result.error || 'Érvénytelen AI válasz');
                }

                // Appwrite-ba mentés
                await processAndStore(
                    result.analysis,
                    imageBuffer,
                    fileInfo.fileName,
                    { publicationId, pageNumbers }
                );

                processedCount++;
                log(
                    `[Layout AI] Fájl kész (${i + 1}/${listData.fileCount}): ` +
                    `${fileInfo.fileName} → ${result.analysis.pageType}`
                );

            } catch (fileErr) {
                logError(`[Layout AI] Fájl elemzés hiba (${fileInfo.fileName})`, fileErr);
                errorCount++;
            }
        }

        const message = `Mappa elemzés kész: ${processedCount}/${listData.fileCount} fájl elemezve` +
            (errorCount > 0 ? `, ${errorCount} hiba` : '');

        log(`[Layout AI] ${message}`);
        return { success: true, message, processedCount, errorCount };

    } catch (err) {
        logError('[Layout AI] Kivétel', err);
        return { success: false, error: err.message || "Ismeretlen hiba" };
    }
};
