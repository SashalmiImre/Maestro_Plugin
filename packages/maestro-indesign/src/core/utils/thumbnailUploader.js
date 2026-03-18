/**
 * @fileoverview Thumbnail fájlkezelő utility.
 * Felelős a thumbnail JPEG fájlok feltöltéséért az Appwrite Storage-ba,
 * a régi thumbnailek törléséért és az ideiglenes fájlok takarításáért.
 *
 * @module utils/thumbnailUploader
 */

import { storage, ID } from "../config/appwriteConfig.js";
import { BUCKETS } from "maestro-shared/appwriteIds.js";
import { convertNativePathToUrl, escapePathForExtendScript } from "./pathUtils.js";
import { withRetry } from "./promiseUtils.js";
import { log, logError, logWarn } from "./logger.js";
import { SCRIPT_LANGUAGE_JAVASCRIPT } from "./constants.js";
import { getIndesignApp } from "./indesign/indesignUtils.js";

const storage_module = require("uxp").storage;

/**
 * Egyedi temp mappa útvonalat generál a thumbnail JPEG-eknek.
 * Az InDesign ExtendScript `Folder.temp` könyvtárát használja alapként.
 *
 * @returns {string} A temp mappa natív útvonala (pl. `/tmp/maestro_thumbs_1710769200000`).
 */
export function getTempFolderPath() {
    const app = getIndesignApp();
    if (!app) return null;

    const tempNameScript = `(function() { return Folder.temp.fsName; })();`;
    const tempBase = String(app.doScript(tempNameScript, SCRIPT_LANGUAGE_JAVASCRIPT, []));
    return `${tempBase}/maestro_thumbs_${Date.now()}`;
}

/**
 * Feltölti a thumbnail JPEG fájlokat az Appwrite Storage-ba.
 *
 * UXP `fs.getEntryWithUrl()` → bináris olvasás → `storage.createFile()`.
 * Minden feltöltés `withRetry` wrapper-rel van védve.
 *
 * @param {string[]} filePaths - A natív fájlútvonalak listája (ExtendScript-ből).
 * @param {string} articleId - A cikk azonosítója (log célokra).
 * @returns {Promise<Array<{ fileId: string, page: string }>>} A feltöltött fájlok adatai.
 */
export async function uploadThumbnails(filePaths, articleId) {
    const results = [];

    for (const nativePath of filePaths) {
        try {
            // Oldalszám kinyerése a fájlnévből: thumb_23.jpg → "23"
            const fileName = nativePath.replace(/.*[/\\]/, '');
            const pageMatch = fileName.match(/^thumb_(.+)\.jpg$/);
            const page = pageMatch ? pageMatch[1] : 'unknown';

            // UXP fájl olvasás
            const fileUrl = convertNativePathToUrl(nativePath);
            const entry = await storage_module.localFileSystem.getEntryWithUrl(fileUrl);
            const buffer = await entry.read({ format: storage_module.formats.binary });

            // File objektum az Appwrite SDK-hoz
            const blob = new File([buffer], fileName, { type: 'image/jpeg' });
            const fileId = ID.unique();

            // Feltöltés retry-val
            const uploaded = await withRetry(
                () => storage.createFile(BUCKETS.THUMBNAILS, fileId, blob),
                { operationName: `thumbnailUpload(${page})` }
            );

            results.push({ fileId: uploaded.$id, page });
        } catch (e) {
            logError(`[thumbnailUploader] Feltöltés sikertelen (${nativePath}):`, e);
            // Egyedi hiba nem blokkolja a többi oldalt
        }
    }

    log(`[thumbnailUploader] ${results.length}/${filePaths.length} thumbnail feltöltve (article: ${articleId})`);
    return results;
}

/**
 * Törli a régi thumbnail fájlokat az Appwrite Storage-ból.
 *
 * @param {string} thumbnailsJson - A cikk `thumbnails` mezője (JSON string).
 * @returns {Promise<void>}
 */
export async function deleteOldThumbnails(thumbnailsJson) {
    if (!thumbnailsJson) return;

    let thumbnails;
    try {
        thumbnails = JSON.parse(thumbnailsJson);
    } catch (e) {
        logWarn('[thumbnailUploader] Érvénytelen thumbnails JSON:', e);
        return;
    }

    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return;

    const deletePromises = thumbnails.map(({ fileId }) =>
        storage.deleteFile(BUCKETS.THUMBNAILS, fileId).catch(e => {
            logWarn(`[thumbnailUploader] Thumbnail törlés sikertelen (${fileId}):`, e.message);
        })
    );

    await Promise.allSettled(deletePromises);
    log(`[thumbnailUploader] ${thumbnails.length} régi thumbnail törölve`);
}

/**
 * Törli az ideiglenes thumbnail mappát és tartalmát ExtendScript-tel.
 * A Folder.temp alatti almappát célozza meg.
 *
 * @param {string} folderPath - A temp mappa útvonala.
 * @returns {Promise<void>}
 */
export async function cleanupTempFiles(folderPath) {
    try {
        const app = getIndesignApp();
        if (!app) return;

        const escapedPath = escapePathForExtendScript(folderPath);
        const script = `
            (function() {
                var folder = new Folder("${escapedPath}");
                if (folder.exists) {
                    var files = folder.getFiles();
                    for (var i = 0; i < files.length; i++) {
                        try { files[i].remove(); } catch(e) {}
                    }
                    folder.remove();
                }
                return "OK";
            })();
        `;
        app.doScript(script, SCRIPT_LANGUAGE_JAVASCRIPT, []);
    } catch (e) {
        logWarn('[thumbnailUploader] Temp fájlok takarítása sikertelen:', e);
    }
}
