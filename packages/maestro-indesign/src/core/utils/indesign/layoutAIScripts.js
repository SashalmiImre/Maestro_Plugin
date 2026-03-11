/**
 * @fileoverview Tördelő AI ExtendScript generátorai.
 *
 * Spread JPEG export és mappa JPG listázás az AI layout elemzéshez.
 *
 * @module utils/indesign/layoutAIScripts
 */

import { escapePathForExtendScript } from "../pathUtils.js";
import { getBackgroundOpenLogic, getSafeCloseLogic } from "./scriptHelpers.js";

/**
 * Generál egy scriptet, ami egy dokumentum összes spreadjét JPEG-ként exportálja.
 *
 * Minden spread külön fájlba kerül: `outputFolder/spread_001.jpg`, `spread_002.jpg`, stb.
 * A script visszaadja a létrehozott fájlok listáját JSON-ként.
 *
 * @param {string} docPath - A forrás INDD fájl útvonala.
 * @param {string} outputFolder - A célmappa útvonala.
 * @param {number} [dpi=150] - Az export felbontása.
 * @param {number} [quality=85] - JPEG minőség (0-100).
 * @returns {string} ExtendScript kód.
 */
export function generateExportSpreadsAsJPEG(docPath, outputFolder, dpi = 150, quality = 85) {
    const openLogic = getBackgroundOpenLogic(docPath, "doc", "openedInBackground");
    const closeLogic = getSafeCloseLogic("doc", "openedInBackground", "SaveOptions.NO");
    const escapedOutputFolder = escapePathForExtendScript(outputFolder);

    return `
        (function() {
            var doc = null;
            var openedInBackground = false;

            try {
                // 1. Dokumentum megnyitása
                ${openLogic}

                // 2. Célmappa létrehozása
                var outputFolder = new Folder('${escapedOutputFolder}');
                if (!outputFolder.exists) {
                    outputFolder.create();
                }

                // 3. JPEG export beállítások
                var results = [];
                var spreads = doc.spreads;

                for (var s = 0; s < spreads.length; s++) {
                    var spread = spreads[s];

                    // Oldalszámok kinyerése a spreadből
                    var pageNums = [];
                    for (var p = 0; p < spread.pages.length; p++) {
                        pageNums.push(spread.pages[p].name);
                    }
                    var pageRange = pageNums.join('-');

                    // Fájlnév: spread_001.jpg
                    var idx = ('00' + (s + 1)).slice(-3);
                    var fileName = 'spread_' + idx + '.jpg';
                    var outputFile = new File(outputFolder.fsName + '/' + fileName);

                    try {
                        // JPEG export beállítások
                        app.jpegExportPreferences.jpegQuality = JPEGOptionsQuality.${quality >= 80 ? 'MAXIMUM' : quality >= 60 ? 'HIGH' : 'MEDIUM'};
                        app.jpegExportPreferences.exportResolution = ${dpi};
                        app.jpegExportPreferences.jpegColorSpace = JpegColorSpaceEnum.RGB;
                        app.jpegExportPreferences.antiAlias = true;
                        app.jpegExportPreferences.simulateOverprint = false;
                        app.jpegExportPreferences.useDocumentBleeds = false;

                        // Spread export: csak az aktuális spread oldalait
                        app.jpegExportPreferences.jpegExportRange = ExportRangeOrAllPages.EXPORT_RANGE;
                        app.jpegExportPreferences.pageString = pageRange;

                        doc.exportFile(ExportFormat.JPG, outputFile, false);

                        results.push({
                            spreadIndex: s,
                            pageNumbers: pageRange,
                            fileName: fileName,
                            filePath: outputFile.fsName,
                            success: true
                        });
                    } catch(exportErr) {
                        results.push({
                            spreadIndex: s,
                            pageNumbers: pageRange,
                            fileName: fileName,
                            success: false,
                            error: exportErr.message
                        });
                    }
                }

                // 4. Bezárás
                ${closeLogic}

                return JSON.stringify({
                    success: true,
                    documentName: doc ? doc.name : '',
                    spreadCount: spreads.length,
                    results: results
                });
            } catch(e) {
                // Hiba esetén bezárás
                try { ${closeLogic} } catch(ce) {}
                return JSON.stringify({
                    success: false,
                    error: e.message
                });
            }
        })();
    `;
}

/**
 * Generál egy scriptet, ami egy mappa JPG fájljait listázza.
 *
 * @param {string} folderPath - A mappa útvonala.
 * @returns {string} ExtendScript kód, ami JSON stringet ad vissza a fájlok listájával.
 */
export function generateListJPGsInFolder(folderPath) {
    const escapedPath = escapePathForExtendScript(folderPath);

    return `
        (function() {
            try {
                var folder = new Folder('${escapedPath}');
                if (!folder.exists) {
                    return JSON.stringify({ success: false, error: 'A mappa nem létezik: ${escapedPath}' });
                }

                var files = folder.getFiles(function(f) {
                    if (f instanceof Folder) return false;
                    var name = f.name.toLowerCase();
                    return name.match(/\\.(jpg|jpeg|png)$/i) !== null;
                });

                var result = [];
                for (var i = 0; i < files.length; i++) {
                    var f = files[i];
                    result.push({
                        fileName: f.name,
                        filePath: f.fsName,
                        sizeKB: Math.round(f.length / 1024)
                    });
                }

                // Fájlnév szerinti rendezés
                result.sort(function(a, b) {
                    return a.fileName.localeCompare(b.fileName);
                });

                return JSON.stringify({
                    success: true,
                    folderPath: folder.fsName,
                    fileCount: result.length,
                    files: result
                });
            } catch(e) {
                return JSON.stringify({ success: false, error: e.message });
            }
        })();
    `;
}
