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
/**
 * Generál egy scriptet levilágítás (print-ready) PDF exportáláshoz.
 * Oldalanként egyedi PDF-eket hoz létre PDF/X-1a:2001 beállításokkal.
 * Támogatja a zöld oldal-szín alapú szelektív exportot:
 * ha vannak zöld oldalak, csak azokat exportálja; ha nincs, az összeset.
 *
 * @param {string} sourcePath - A forrás INDD fájl útvonala (null ha nyitott dokumentum).
 * @param {string} outputFolderPath - A __PRINT_PDF__ mappa útvonala.
 * @param {string} layoutExportId - A layout export azonosítója (fájlnévhez).
 * @param {number} maxPage - A publikáció végoldalszáma (padding számításhoz).
 * @returns {string} ExtendScript kód.
 */
export function generatePrintPdfScript(sourcePath, outputFolderPath, layoutExportId, maxPage) {
    const escapedOutputFolder = escapePathForExtendScript(outputFolderPath);
    const escapedLayoutId = escapePathForExtendScript(layoutExportId);
    const paddingLength = (maxPage || 999).toString().length;

    // Logika modulok generálása — háttérben vagy előtérben
    const openLogic = sourcePath ? getBackgroundOpenLogic(sourcePath, "doc", "openedInBackground") : "";
    const docTargetLogic = sourcePath ? "" : getDocumentTargetLogic("doc", null);
    const linkCheckLogic = getLinkCheckLogic("doc", "openedInBackground");
    const closeLogic = getSafeCloseLogic("doc", "openedInBackground", "SaveOptions.NO");

    return `
        (function() {
            var doc = null;
            var openedInBackground = false;

            try {
                // 1. DOKUMENTUM ELÉRÉSE
                ${sourcePath ? openLogic : docTargetLogic}

                // 2. LINK ELLENŐRZÉS
                ${linkCheckLogic}

                // 3. ZÖLD OLDAL DETEKCIÓ
                var pagesToExport = [];
                var hasGreenPages = false;

                for (var i = 0; i < doc.pages.length; i++) {
                    var page = doc.pages[i];
                    if (page.pageColor.toString() === UIColors.GREEN.toString()) {
                        hasGreenPages = true;
                    }
                }

                if (hasGreenPages) {
                    // Csak zöld oldalak
                    for (var i = 0; i < doc.pages.length; i++) {
                        if (doc.pages[i].pageColor.toString() === UIColors.GREEN.toString()) {
                            pagesToExport.push(doc.pages[i]);
                        }
                    }
                } else {
                    // Az összes oldal
                    for (var i = 0; i < doc.pages.length; i++) {
                        pagesToExport.push(doc.pages[i]);
                    }
                }

                if (pagesToExport.length === 0) {
                    ${closeLogic}
                    return "ERROR:Nincsenek exportálandó oldalak.";
                }

                // 4. MAPPA LÉTREHOZÁSA
                var outputFolder = new Folder("${escapedOutputFolder}");
                if (!outputFolder.exists) outputFolder.create();

                // 5. PDF EXPORT BEÁLLÍTÁSOK (Levilágítás — PDF/X-1a:2001)
                var prefs = app.pdfExportPreferences;

                prefs.viewPDF = false;

                // PDF/X-1a:2001 szabvány
                try { prefs.standardsCompliance = PDFXStandards.PDFX1A2001_STANDARD; } catch(e) {}
                try { prefs.acrobatCompatibility = AcrobatCompatibility.ACROBAT_4; } catch(e) {}

                // Szín: CMYK konverzió
                try { prefs.pdfColorSpace = PDFColorSpace.CMYK; } catch(e) {}

                // Color Images: 300 DPI, JPEG, Maximum minőség
                try { prefs.colorBitmapSampling = Sampling.BICUBIC_DOWNSAMPLING; } catch(e) {}
                prefs.colorBitmapSamplingDPI = 300;
                prefs.thresholdToCompressColor = 450;
                try { prefs.colorBitmapCompression = BitmapCompression.JPEG; } catch(e) {}
                try { prefs.colorBitmapQuality = CompressionQuality.MAXIMUM; } catch(e) {}

                // Gray Images: 300 DPI, JPEG, Maximum minőség
                try { prefs.grayscaleBitmapSampling = Sampling.BICUBIC_DOWNSAMPLING; } catch(e) {}
                prefs.grayscaleBitmapSamplingDPI = 300;
                prefs.thresholdToCompressGray = 450;
                try { prefs.grayBitmapCompression = BitmapCompression.JPEG; } catch(e) {}
                try { prefs.grayBitmapQuality = CompressionQuality.MAXIMUM; } catch(e) {}

                // Mono Images: 1200 DPI, CCITT Group 4
                try { prefs.monochromeBitmapSampling = Sampling.BICUBIC_DOWNSAMPLING; } catch(e) {}
                prefs.monochromeBitmapSamplingDPI = 1200;
                prefs.thresholdToCompressMonochrome = 1800;
                try { prefs.monochromeBitmapCompression = MonoBitmapCompression.CCITT4; } catch(e) {}

                // Általános beállítások
                prefs.compressTextAndLineArt = true;
                prefs.cropImagesToFrames = true;
                try { prefs.includeICCProfiles = true; } catch(e) {}
                try { prefs.subsetFontsBelow = 100; } catch(e) {}

                // Bleed: 5mm (14.17323pt) minden oldalon
                try { prefs.useDocumentBleedWithPDF = false; } catch(e) {}
                try {
                    prefs.pageMarksAndBleed.bleedTop = "5mm";
                    prefs.pageMarksAndBleed.bleedBottom = "5mm";
                    prefs.pageMarksAndBleed.bleedInside = "5mm";
                    prefs.pageMarksAndBleed.bleedOutside = "5mm";
                } catch(e) {
                    // Alternatív bleed beállítás
                    try {
                        prefs.bleedTop = "5mm";
                        prefs.bleedBottom = "5mm";
                        prefs.bleedInside = "5mm";
                        prefs.bleedOutside = "5mm";
                    } catch(e2) {}
                }

                // Transparency flattener
                try { prefs.transparencyFlattenerPresetName = "[High Resolution]"; } catch(e) {}

                // 6. OLDALANKÉNTI EXPORT
                var paddingLen = ${paddingLength};
                var layoutId = "${escapedLayoutId}";
                var exportedCount = 0;
                var errors = [];

                for (var p = 0; p < pagesToExport.length; p++) {
                    try {
                        var page = pagesToExport[p];
                        var pageName = page.name;

                        // Oldalszám padding
                        var paddedNum = String(pageName);
                        while (paddedNum.length < paddingLen) {
                            paddedNum = "0" + paddedNum;
                        }

                        // Fájlnév: {paddedPage}_{layoutExportId}_1.pdf
                        var fileName = paddedNum + "_" + layoutId + "_1.pdf";
                        var exportFile = new File(outputFolder.fsName + "/" + fileName);

                        // Oldaltartomány beállítása
                        prefs.pageRange = pageName;

                        // Exportálás
                        doc.exportFile(ExportFormat.PDF_TYPE, exportFile, false);
                        exportedCount++;
                    } catch(pageErr) {
                        errors.push(pageName + ": " + pageErr.message);
                    }
                }

                // 7. ZÖLD JELÖLÉS TÖRLÉSE az exportált oldalakról
                if (hasGreenPages) {
                    for (var g = 0; g < pagesToExport.length; g++) {
                        try {
                            pagesToExport[g].pageColor = PageColorOptions.USE_MASTER_COLOR;
                        } catch(colorErr) {}
                    }
                    // Mentés a szín törlés után
                    try { doc.save(); } catch(saveErr) {}
                }

                // 8. BEZÁRÁS
                ${closeLogic}

                if (exportedCount === 0) {
                    return "ERROR:Egyetlen oldal sem exportálódott." + (errors.length > 0 ? " Hibák: " + errors.join("; ") : "");
                }

                var resultMsg = exportedCount + " oldal exportálva";
                if (hasGreenPages) resultMsg += " (kijelölt oldalak)";
                if (errors.length > 0) resultMsg += ". Hibák: " + errors.join("; ");

                return "SUCCESS:" + resultMsg;

            } catch(e) {
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
