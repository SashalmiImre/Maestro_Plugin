/**
 * @fileoverview Az 'archive' parancs kezelője.
 *
 * Hibrid archiválási folyamat:
 *  1. InDesign script kinyeri a nyers adatokat (szövegkeretek, grafikai elemek) JSON-ként
 *  2. AI klaszterezés a proxy szerveren (Claude Haiku) — ha elérhető
 *     Fallback: szabály-alapú klaszterezés + típusosztályozás (`archivingProcessor.js`)
 *  3. TXT + XML generálás a klaszterezés eredményéből
 *  4. InDesign script menti a TXT és XML fájlokat
 *  5. InDesign script másolja az INDD fájlt az archívba
 *
 * A kimeneti fájlnév az "xx xx CikkNeve" konvenciót követi
 * (formatPagedFileName alapján, pl. "005 012 CikkNeve.txt").
 *
 * @module commands/handlers/archiving
 */

import {
    generateCreateArchiveFoldersScript,
    generateExtractArticleDataScript,
    generateSaveTextFilesScript,
    generateCopyInddScript
} from "../../utils/indesign/archivingScripts.js";
import {
    processArticleData,
    prepareStoriesForAI,
    buildOutputFromAIClusters
} from "../../utils/archivingProcessor.js";
import { executeScript } from "../../utils/indesign/indesignUtils.js";
import * as pathUtils from "../../utils/pathUtils.js";
import { formatPagedFileName } from "../../utils/namingUtils.js";
import { logError, logWarn, log } from "../../utils/logger.js";
import { endpointManager } from "../../config/appwriteConfig.js";

/** Az archív gyökérmappa neve a publikáció rootPath-on belül. */
const ARCHIV_FOLDER_NAME = "__ARCHIV";

/**
 * Handles the 'archive' command.
 *
 * Archiválja a kiválasztott cikket: szövegkinyerés (TXT + XML) és INDD másolás.
 *
 * @param {object} context - Parancs kontextus.
 * @param {object} context.item        - A kiválasztott cikk (filePath, name, startPage, endPage).
 * @param {object} context.publication - A kiadvány (rootPath, coverageEnd/pageCount).
 * @returns {Promise<object>} { success, message } vagy { success: false, error }.
 */
export const handleArchiving = async (context) => {
    const { item, publication } = context;

    if (!item?.filePath) {
        return { success: false, error: "Nincs érvényes cikk kiválasztva." };
    }

    const publicationPath = publication?.rootPath || publication?.path;
    if (!publicationPath) {
        return { success: false, error: "A publikáció rootPath útvonala nem elérhető." };
    }

    const archivPath = pathUtils.joinPath(publicationPath, ARCHIV_FOLDER_NAME);

    log(`[Archive] Indítás — cikk: ${item.name}, archiv: ${archivPath}`);

    // 1. __ARCHIV mappa struktúra létrehozása (TXT, XML, INDD)
    const createResult = await executeScript(generateCreateArchiveFoldersScript(archivPath));
    if (!createResult || createResult.startsWith("ERROR:")) {
        const errMsg = createResult ? createResult.substring(6) : "Ismeretlen hiba";
        logError(`[Archive] Mappa létrehozása sikertelen: ${errMsg}`);
        return { success: false, error: `Archív mappa létrehozása sikertelen: ${errMsg}` };
    }

    // 2. Kimeneti fájlnév generálása az "xx xx CikkNeve" konvencióval
    const maxPage  = publication.coverageEnd || publication.pageCount || 999;
    const pagedTxtName = formatPagedFileName(item.name, item.startPage, item.endPage, maxPage, ".txt");
    const baseName = pagedTxtName.replace(/\.txt$/i, "");

    const txtOutputPath  = pathUtils.joinPath(pathUtils.joinPath(archivPath, "TXT"),  baseName + ".txt");
    const xmlOutputPath  = pathUtils.joinPath(pathUtils.joinPath(archivPath, "XML"),  baseName + ".xml");
    const inddOutputPath = pathUtils.joinPath(pathUtils.joinPath(archivPath, "INDD"), baseName + ".indd");

    log(`[Archive] Kimenet: ${baseName}`);

    try {
        // 3. Nyers adatok kinyerése az InDesign fájlból (JSON)
        const extractScript = generateExtractArticleDataScript(item.filePath);
        const extractResult = await executeScript(extractScript);

        if (!extractResult || extractResult.startsWith("ERROR:")) {
            const errMsg = extractResult ? extractResult.substring(6) : "Ismeretlen hiba";
            logWarn(`[Archive] Adatkinyerés sikertelen: ${baseName} — ${errMsg}`);
            return { success: false, error: errMsg };
        }

        // 4. JSON parse
        let rawData;
        try {
            rawData = JSON.parse(extractResult);
        } catch (parseErr) {
            logError(`[Archive] JSON parse hiba: ${baseName}`, parseErr);
            return { success: false, error: `Adatkinyerés parse hiba: ${parseErr.message}` };
        }

        // 4b. Feldolgozás: AI klaszterezés, fallback szabály-alapú logikára
        const { txtContent, xmlContent } = await _processWithAIFallback(rawData, baseName);

        // 5. TXT és XML fájlok mentése InDesign scripten keresztül
        const saveScript  = generateSaveTextFilesScript(txtOutputPath, xmlOutputPath, txtContent, xmlContent);
        const saveResult  = await executeScript(saveScript);

        if (!saveResult || saveResult.startsWith("ERROR:")) {
            const errMsg = saveResult ? saveResult.substring(6) : "Ismeretlen hiba";
            logWarn(`[Archive] Fájlmentés sikertelen: ${baseName} — ${errMsg}`);
            return { success: false, error: errMsg };
        }

        // 6. INDD fájl másolása az archívba
        const copyScript  = generateCopyInddScript(item.filePath, inddOutputPath);
        const copyResult  = await executeScript(copyScript);

        if (!copyResult || copyResult.startsWith("ERROR:")) {
            const errMsg = copyResult ? copyResult.substring(6) : "Ismeretlen hiba";
            logWarn(`[Archive] INDD másolás sikertelen: ${baseName} — ${errMsg}`);
            return { success: false, error: errMsg };
        }

        log(`[Archive] Sikeres: ${baseName}`);
        return { success: true, message: `Archiválás kész: ${baseName}` };

    } catch (err) {
        logError(`[Archive] Kivétel: ${baseName}`, err);
        return { success: false, error: err.message || "Ismeretlen hiba" };
    }
};

// --- AI klaszterezés + fallback ---

/** AI klaszterezés timeout (ms) */
const AI_TIMEOUT_MS = 15000;

/**
 * Megpróbálja AI-val klaszterezni a szövegkereteket, és ha nem sikerül,
 * visszaesik a szabály-alapú logikára.
 *
 * @param {object} rawData - Az InDesign scriptből kapott nyers JSON adat.
 * @param {string} baseName - A cikk neve (logoláshoz).
 * @returns {Promise<{ txtContent: string, xmlContent: string }>}
 */
async function _processWithAIFallback(rawData, baseName) {
    // AI útvonal megpróbálása
    try {
        const stories = prepareStoriesForAI(rawData);
        const proxyBase = endpointManager.getProxyBase();
        const aiUrl = `${proxyBase}/api/cluster-article`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

        let response;
        try {
            response = await fetch(aiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stories }),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeoutId);
        }

        if (response.ok) {
            const aiResponse = await response.json();

            if (aiResponse.clusters && aiResponse.clusters.length > 0) {
                log(`[Archive] AI klaszterezés: ${stories.length} story → ${aiResponse.clusters.length} klaszter — ${baseName}`);
                return buildOutputFromAIClusters(rawData, aiResponse);
            }

            logWarn(`[Archive] AI üres választ adott, fallback szabály-alapúra — ${baseName}`);
        } else {
            logWarn(`[Archive] AI endpoint HTTP ${response.status}, fallback szabály-alapúra — ${baseName}`);
        }
    } catch (aiErr) {
        const reason = aiErr.name === 'AbortError' ? 'timeout' : aiErr.message;
        logWarn(`[Archive] AI klaszterezés sikertelen (${reason}), fallback szabály-alapúra — ${baseName}`);
    }

    // Fallback: szabály-alapú feldolgozás
    return processArticleData(rawData);
}
