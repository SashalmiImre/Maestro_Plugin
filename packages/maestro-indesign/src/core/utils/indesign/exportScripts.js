/**
 * @fileoverview PDF export és képgyűjtés ExtendScript generátorai.
 *
 * @module utils/indesign/exportScripts
 */

import { escapePathForExtendScript } from "../pathUtils.js";
import {
    getBackgroundOpenLogic,
    getLinkCheckLogic,
    getSafeCloseLogic,
    getDocumentTargetLogic
} from "./scriptHelpers.js";

/**
 * Generál egy scriptet PDF exportáláshoz a megadott beállításokkal.
 * Kezeli a háttérben történő megnyitást, a link ellenőrzést és a PDF exportálást.
 *
 * @param {string} sourcePath - A forrás INDD fájl útvonala.
 * @param {string} outputPath - A cél PDF fájl útvonala.
 * @param {string} [presetName] - Opcionális PDF preset név.
 * @returns {string} ExtendScript kód.
 */
export function generateExportPdfScript(sourcePath, outputPath, presetName) {
    const escapedOutputPath = escapePathForExtendScript(outputPath);
    // Ha van preset név, escape-eljük, ha nincs, üres string.
    const escapedPresetName = presetName ? escapePathForExtendScript(presetName) : "";

    // Logika modulok generálása
    const openLogic = getBackgroundOpenLogic(sourcePath, "doc", "openedInBackground");
    const linkCheckLogic = getLinkCheckLogic("doc", "openedInBackground");
    const closeLogic = getSafeCloseLogic("doc", "openedInBackground", "SaveOptions.NO");

    return `
        (function() {
            var doc = null;
            var openedInBackground = false;

            try {
                // 1. OPEN
                ${openLogic}

                // 2. CHECK LINKS
                ${linkCheckLogic}

                // 3. EXPORT FILE SETUP
                var exportFile = new File('${escapedOutputPath}');
                var parentFolder = exportFile.parent;
                if (!parentFolder.exists) parentFolder.create();

                // 4. CONFIG & EXPORT
                var presetName = "${escapedPresetName}";
                var usedPreset = null;

                if (presetName && presetName !== "") {
                    try {
                        usedPreset = app.pdfExportPresets.item(presetName);
                        // Ellenőrizzük, hogy létezik-e (bár item() mindig visszaad objektumot, a isValid kell)
                        if (!usedPreset.isValid) {
                             usedPreset = null; // Fallback
                        }
                    } catch(e) {
                        usedPreset = null;
                    }
                }

                if (usedPreset) {
                    // HASZNÁLJUK A PRESETET
                    doc.exportFile(ExportFormat.PDF_TYPE, exportFile, false, usedPreset);
                } else {
                    // FALLBACK: KÉZI BEÁLLÍTÁSOK (Ha nincs preset vagy érvénytelen)

                    // Reseteljük a preferenciákat
                    app.pdfExportPreferences.viewPDF = false;

                    // Color Images
                    try { app.pdfExportPreferences.colorBitmapSampling = Sampling.BICUBIC_DOWNSAMPLING; } catch(e) {}
                    app.pdfExportPreferences.colorBitmapSamplingDPI = 150;
                    app.pdfExportPreferences.thresholdToCompressColor = 300;

                    // Gray Images
                    try { app.pdfExportPreferences.grayscaleBitmapSampling = Sampling.BICUBIC_DOWNSAMPLING; } catch(e) {}
                    app.pdfExportPreferences.grayscaleBitmapSamplingDPI = 150;
                    app.pdfExportPreferences.thresholdToCompressGray = 300;

                    // Mono Images
                    try { app.pdfExportPreferences.monochromeBitmapSampling = Sampling.BICUBIC_DOWNSAMPLING; } catch(e) {}
                    app.pdfExportPreferences.monochromeBitmapSamplingDPI = 1200;
                    app.pdfExportPreferences.thresholdToCompressMonochrome = 1800;

                    app.pdfExportPreferences.compressTextAndLineArt = true;
                    app.pdfExportPreferences.cropImagesToFrames = true;
                    app.pdfExportPreferences.includeICCProfiles = true;

                    // Exportálás preset nélkül
                    doc.exportFile(ExportFormat.PDF_TYPE, exportFile, false);
                }

                // 5. CLOSE
                ${closeLogic}

                return "SUCCESS";

            } catch(e) {
                // Hiba esetén is zárás
                ${closeLogic}
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet a képek összegyűjtéséhez.
 *
 * @param {string} targetFolderPath - A mappa útvonala, ahová másolni kell.
 * @param {string} publicationRootPath - A publikáció gyökér útvonala (szűréshez).
 * @param {boolean} onlySelected - Ha true, csak a kijelöltekkel foglalkozik.
 * @param {string|null} [sourceFilePath=null] - Ha meg van adva, háttérben nyitja meg.
 * @returns {string} ExtendScript kód.
 */
export function generateCollectImagesScript(targetFolderPath, publicationRootPath, onlySelected, sourceFilePath = null) {
    const escapedTarget = escapePathForExtendScript(targetFolderPath);
    const escapedPubRoot = escapePathForExtendScript(publicationRootPath);

    // Logic generation
    const openLogic = getBackgroundOpenLogic(sourceFilePath, "doc", "openedInBackground");
    const closeLogic = getSafeCloseLogic("doc", "openedInBackground", "SaveOptions.NO");
    const docTargetLogic = sourceFilePath ? "" : getDocumentTargetLogic("doc", null);

    return `
        (function() {
            var doc = null;
            var openedInBackground = false;

            try {
                // 1. DOKUMENTUM ELÉRÉSE
                ${sourceFilePath ? openLogic : docTargetLogic}

                var targetFolder = new Folder("${escapedTarget}");
                var folderCreated = false;

                function ensureFolder() {
                    if (!folderCreated) {
                        if (!targetFolder.exists) targetFolder.create();
                        folderCreated = true;
                    }
                }

                var pubFolder = new Folder("${escapedPubRoot}");
                var pubPath = pubFolder.fsName;

                var collectedCount = 0;
                var skippedCount = 0;
                var errors = [];

                // Mód meghatározása futásidőben
                // Háttérben nyitottnál mindig False a selection check.
                // Előtérben: Ha onlySelected=true -> True.
                // Ha onlySelected=false -> Smart check (van-e selection?)

                var useSelection = false;
                if (${!sourceFilePath}) {
                    if (${onlySelected}) {
                        useSelection = true;
                    } else {
                        // Smart Mode: Ha van kijelölés, akkor azt használjuk
                        if (app.selection.length > 0) {
                            useSelection = true;
                        }
                    }
                }

                // Segédfüggvény: Link másolása
                function processLink(link) {
                    try {
                        if (link.status === LinkStatus.LINK_MISSING) {
                            errors.push("Hiányzó: " + link.name);
                            return;
                        }

                        var file = new File(link.filePath);
                        if (!file.exists) return;

                        var shouldCopy = true;

                        // Szűrés a publikáció mappára: Csak ha NEM selection módban vagyunk
                        if (!useSelection) {
                            if (file.fsName.indexOf(pubPath) === -1) {
                                shouldCopy = false;
                            }
                        }

                        if (shouldCopy) {
                            ensureFolder();
                            var targetFile = new File(targetFolder.fsName + "/" + file.name);
                            file.copy(targetFile);
                            collectedCount++;
                        } else {
                            skippedCount++;
                        }
                    } catch(e) {
                        errors.push("Hiba (" + link.name + "): " + e.message);
                    }
                }

                // 2. ITERÁCIÓ
                if (useSelection) {
                    // Kijelölés alapú
                    for (var i = 0; i < app.selection.length; i++) {
                        var item = app.selection[i];

                        // Image/Container check
                        if (item.hasOwnProperty("allGraphics")) {
                            var graphics = item.allGraphics;
                            for (var j = 0; j < graphics.length; j++) {
                                if (graphics[j].itemLink && graphics[j].itemLink.isValid) {
                                    processLink(graphics[j].itemLink);
                                }
                            }
                        }
                        else if (item instanceof Image || item instanceof PDF || item instanceof EPS || item instanceof PICT) {
                             if (item.itemLink && item.itemLink.isValid) {
                                processLink(item.itemLink);
                            }
                        }
                    }
                } else {
                    // Teljes dokumentum
                    var updates = doc.links;
                    for (var i = 0; i < updates.length; i++) {
                        processLink(updates[i]);
                    }
                }

                // 3. ZÁRÁS
                ${closeLogic}

                var resultMsg = "Másolva: " + collectedCount;
                if (useSelection) resultMsg += " (Kijelölésből)";
                if (skippedCount > 0) resultMsg += ", Kihagyva: " + skippedCount;
                if (errors.length > 0) resultMsg += ". Hibák: " + errors.join("; ");

                return "SUCCESS:" + resultMsg;

            } catch(e) {
                ${closeLogic}
                return "ERROR:" + e.message;
            }
        })();
    `;
}
