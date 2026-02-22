/**
 * @fileoverview Dokumentum műveletek ExtendScript generátorai és eredmény feldolgozói.
 *
 * Tartalmazza a dokumentum CRUD műveleteket (megnyitás, mentés, bezárás, átnevezés),
 * oldalszám kinyerést és az eredmény parserek közül az általános célúakat.
 *
 * @module utils/indesign/documentScripts
 */

import { escapePathForExtendScript } from "../pathUtils.js";
import {
    getBackgroundOpenLogic,
    getExtractPageRangesLogic,
    getDocumentTargetLogic
} from "./scriptHelpers.js";

// ============================================================================
// Dokumentum Műveletek
// ============================================================================

/**
 * Generál egy scriptet, ami a háttérben megnyit egy dokumentumot és kinyeri az oldaltartományokat.
 * A dokumentumot NYITVA HAGYJA (háttérben), a hívó felelőssége bezárni!
 *
 * @param {string} filePath - A megnyitandó fájl útvonala.
 * @returns {string} ExtendScript kód.
 */
export function generateExtractPageNumbersInBackground(filePath) {
    const extractionLogic = getExtractPageRangesLogic();
    const openLogic = getBackgroundOpenLogic(filePath, "doc", "openedHere");

    return `
        (function() {
            var doc = null;
            var openedHere = false;

            // Konstansok
            var UserInteractionLevels_NEVER_INTERACT = 1699311169;

            try {
                // InDesign Enums fallback (just in case they are missing in strict mode, though usually global)
                if (typeof UserInteractionLevels === 'undefined') {
                    var UserInteractionLevels = { NEVER_INTERACT: 1699311169 };
                }

                ${openLogic}

                // Tartományok kinyerése
                var result = (function() {
                    ${extractionLogic}
                })();

                // Hibakezelés a kinyerésnél
                if (result.indexOf("ERROR:") === 0) {
                     // Ha hiba volt, és mi nyitottuk, zárjuk be
                     if (openedHere) { try { doc.close(SaveOptions.NO); } catch(e){} }
                     return result;
                }

                // SIKER: Visszaadjuk az eredményt, de a doksit nyitva hagyjuk (ha úgy volt kérve, ill. a caller dolga)
                // De várjunk: az eredeti generateExtractPageNumbersInBackground specifikációja szerint:
                // "A dokumentumot NYITVA HAGYJA (háttérben), a hívó felelőssége bezárni!"
                // Így van.

                return result;

            } catch(e) {
                // Nagy try-catch hiba esetén zárás
                if (openedHere && doc && doc.isValid) {
                    try { doc.close(SaveOptions.NO); } catch(err) {}
                }
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet, ami ellenőrzi, hogy a megadott útvonalú fájl nyitva van-e.
 *
 * @param {string} filePath - A keresett fájl útvonala.
 * @returns {string} ExtendScript kód, ami "true" vagy "false" stringet ad vissza.
 */
export function generateIsDocumentOpenScript(filePath) {
    const safePath = escapePathForExtendScript(filePath);
    return `
        (function() {
            try {
                var path = "${safePath}";
                var f = File(path);
                if (!f.exists) f = File(encodeURI(path));

                var targetName = decodeURI(f.name);

                try {
                    var existingDoc = app.documents.item(targetName);
                    if (existingDoc && existingDoc.isValid) {
                        return "true";
                    }
                } catch(e) {}

                return "false";
            } catch(e) {
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet, ami eltolja a dokumentum oldalszámozását.
 *
 * @param {number} offset - Az eltolás mértéke (lehet negatív is).
 * @param {string|null} [filePath=null] - Opcionális fájl útvonal.
 * @returns {string} ExtendScript kód "success" vagy "ERROR:..." eredménnyel.
 */
export function generateRenumberDocumentScript(offset, filePath = null) {
    if (typeof offset !== 'number' || isNaN(offset)) {
        throw new Error('Az offset-nek érvényes számnak kell lennie');
    }
    const docLogic = getDocumentTargetLogic("doc", filePath);
    return `
        (function() {
            try {
                ${docLogic}

                var offset = ${offset};

                for (var i = 0; i < doc.sections.length; i++) {
                    var section = doc.sections[i];
                    if (!section.continueNumbering) {
                        var currentStart = section.pageNumberStart;
                        var newStart = currentStart + offset;
                        if (newStart < 1) newStart = 1;
                        section.pageNumberStart = newStart;
                    }
                }
                return "success";
            } catch(e) {
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet, ami menti a dokumentumot.
 *
 * @param {string|null} [filePath=null] - Opcionális fájl útvonal.
 * @returns {string} ExtendScript kód.
 */
export function generateSaveDocumentScript(filePath = null) {
    const docLogic = getDocumentTargetLogic("doc", filePath);
    return `
        (function() {
            try {
                ${docLogic}
                doc.save();
                return "success";
            } catch(e) {
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet, ami bezárja a dokumentumot.
 *
 * @param {string|null} [filePath=null] - Opcionális fájl útvonal.
 * @param {boolean} [save=false] - Ha true, mentéssel zárja be.
 * @returns {string} ExtendScript kód.
 */
export function generateCloseDocumentScript(filePath = null, save = false) {
    const docLogic = getDocumentTargetLogic("doc", filePath);
    const saveOption = save ? "SaveOptions.YES" : "SaveOptions.NO";

    return `
        (function() {
            try {
                ${docLogic}
                doc.close(${saveOption});
                return "success";
            } catch(e) {
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet dokumentum megnyitásához testreszabható beállításokkal.
 *
 * @param {string} filePath - A fájl útvonala.
 * @param {boolean} [openInBackground=false] - Ha true, megpróbálja ablak nélkül megnyitni.
 * @param {boolean} [showWarnings=false] - Ha true, engedélyezi a felugró ablakokat.
 * @returns {string} ExtendScript kód.
 */
export function generateOpenDocumentScript(filePath, openInBackground = false, showWarnings = false) {
    const safePath = escapePathForExtendScript(filePath);

    return `
        (function() {
            try {
                // Beállítások mentése
                var oldLevel = app.scriptPreferences.userInteractionLevel;
                var oldCheckLinks = app.linkingPreferences.checkLinksAtOpen;
                var showWarnings = ${showWarnings};
                var openInBackground = ${openInBackground};
                var showingWindow = !openInBackground;

                if (!showWarnings) {
                    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
                    app.linkingPreferences.checkLinksAtOpen = false;
                } else {
                    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
                    app.linkingPreferences.checkLinksAtOpen = true;
                }

                var path = "${safePath}";
                var f = File(path);
                if (!f.exists) f = File(encodeURI(path));

                if (f.exists) {
                    app.open(f, showingWindow);

                    // Beállítások visszaállítása
                    app.scriptPreferences.userInteractionLevel = oldLevel;
                    app.linkingPreferences.checkLinksAtOpen = oldCheckLinks;
                    return "success";
                } else {
                    app.scriptPreferences.userInteractionLevel = oldLevel;
                    app.linkingPreferences.checkLinksAtOpen = oldCheckLinks;
                    return "not_found (Hiba: " + f.error + ")";
                }
            } catch(e) {
                // Hiba esetén is visszaállítjuk a beállításokat
                if (typeof oldLevel !== 'undefined') {
                     app.scriptPreferences.userInteractionLevel = oldLevel;
                }
                if (typeof oldCheckLinks !== 'undefined') {
                    app.linkingPreferences.checkLinksAtOpen = oldCheckLinks;
                }
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet, ami kinyeri az oldalszámokat egy (már nyitott) dokumentumból.
 *
 * @param {string|null} [filePath=null]
 * @returns {string} ExtendScript kód.
 */
export function generateExtractPageRangesScript(filePath = null) {
    const extractionLogic = getExtractPageRangesLogic();
    const docLogic = getDocumentTargetLogic("doc", filePath);
    return `
        (function() {
            try {
                ${docLogic}

                var result = (function() {
                    ${extractionLogic}
                })();
                return result;

            } catch(e) {
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet, ami visszaadja az aktív dokumentum teljes fájlútvonalát.
 *
 * @returns {string} ExtendScript kód.
 */
export function generateGetActiveDocumentPathScript() {
    return `
        (function() {
            try {
                if (app.documents.length > 0 && app.activeDocument) {
                    return app.activeDocument.fullName.fsName;
                }
                return "";
            } catch(e) {
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet a dokumentum egyedi belső azonosítójának lekéréséhez.
 *
 * @param {string|null} [filePath=null]
 * @returns {string} ExtendScript kód.
 */
export function generateGetDocumentIdScript(filePath = null) {
    const docLogic = getDocumentTargetLogic("doc", filePath);
    return `
        (function() {
            try {
                ${docLogic}
                return doc.id.toString();
            } catch(e) {
                return "ERROR:" + e.message;
            }
        })();
    `;
}

// ============================================================================
// Fájlrendszer Műveletek
// ============================================================================

/**
 * Generál egy scriptet fájl átnevezéshez.
 *
 * @param {string} oldPath - A jelenlegi fájl útvonala.
 * @param {string} newPath - A kívánt új fájl útvonal.
 * @returns {string} ExtendScript kód.
 */
export function generateRenameFileScript(oldPath, newPath) {
    const escapedOldPath = escapePathForExtendScript(oldPath);
    const escapedNewPath = escapePathForExtendScript(newPath);

    // Csak a fájlnevet nyerjük ki az új útvonalból
    const pathSeparator = newPath.includes('/') ? '/' : '\\';
    const newFileName = newPath.substring(newPath.lastIndexOf(pathSeparator) + 1);
    const escapedNewFileName = escapePathForExtendScript(newFileName);

    return `
        (function() {
            try {
                var oldFile = new File('${escapedOldPath}');
                var newFile = new File('${escapedNewPath}');

                if (!oldFile.exists) {
                    return 'ERROR:A forrásfájl nem létezik: ' + oldFile.fsName;
                }
                if (newFile.exists) {
                    return 'ERROR:Már létezik fájl ezen a néven: ' + newFile.fsName;
                }

                var success = oldFile.rename('${escapedNewFileName}');
                return success ? 'SUCCESS' : 'ERROR:A fájl átnevezése sikertelen';
            } catch(e) {
                return 'ERROR:' + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet az átnevezés visszavonásához (rollback).
 *
 * @param {string} currentPath - A jelenlegi (hibás/átnevezett) útvonal.
 * @param {string} originalName - Az eredeti fájlnév.
 * @returns {string} ExtendScript kód.
 */
export function generateRollbackRenameScript(currentPath, originalName) {
    const escapedCurrentPath = escapePathForExtendScript(currentPath);
    const escapedOriginalName = escapePathForExtendScript(originalName);

    return `
        (function() {
            try {
                var file = new File('${escapedCurrentPath}');
                if (!file.exists) {
                    return 'ERROR:A fájl nem található: ' + file.fsName;
                }
                var success = file.rename('${escapedOriginalName}');
                return success ? 'SUCCESS' : 'ERROR: A fájl visszanevezése sikertelen';
            } catch(e) {
                return 'ERROR:' + e.message;
            }
        })();
    `;
}

/**
 * Generál egy scriptet megnyitott dokumentum átnevezéséhez.
 *
 * Ha a dokumentum nyitva van InDesign-ban, a sima fájl-átnevezés törné az InDesign hivatkozást.
 * Ehelyett: doc.save(newPath) (Save As) frissíti az InDesign belső hivatkozását,
 * majd töröljük a régi fájlt.
 *
 * A hívó felelős a `window.maestroSkipMonitor` flag beállításáért a UXP oldalon,
 * hogy a DocumentMonitor ne reagáljon a programozott mentésre.
 *
 * @param {string} oldPath - Az eredeti fájl útvonal (InDesign-ban nyitva).
 * @param {string} newPath - Az új fájl útvonal.
 * @returns {string} ExtendScript kód.
 */
export function generateRenameOpenDocumentScript(oldPath, newPath) {
    const escapedOldPath = escapePathForExtendScript(oldPath);
    const escapedNewPath = escapePathForExtendScript(newPath);

    return `
        (function() {
            try {
                var newFile = new File('${escapedNewPath}');
                if (newFile.exists) {
                    return 'ERROR:Már létezik fájl ezen a néven: ' + newFile.fsName;
                }

                var oldFile = new File('${escapedOldPath}');
                var targetName = decodeURI(oldFile.name);

                // Megkeressük a nyitott dokumentumot: teljes útvonal alapján (elsődleges),
                // névegyezés alapján (fallback, ha a fullName nem érhető el – pl. nem mentett dok.)
                var doc = null;
                var targetFsName = oldFile.fsName;
                var fallbackDoc = null;
                for (var i = 0; i < app.documents.length; i++) {
                    var candidateDoc = app.documents[i];
                    try {
                        if (candidateDoc.fullName && candidateDoc.fullName.fsName === targetFsName) {
                            doc = candidateDoc;
                            break;
                        }
                    } catch(e) {}
                    if (!fallbackDoc && candidateDoc.name === targetName) {
                        fallbackDoc = candidateDoc;
                    }
                }
                if (!doc) { doc = fallbackDoc; }

                if (!doc || !doc.isValid) {
                    return 'ERROR:A dokumentum nincs megnyitva az InDesign-ban';
                }

                // Save As: frissíti az InDesign belső hivatkozását az új útvonalra
                doc.save(newFile);

                // Régi fájl törlése (a Save As másolatot hozott létre)
                if (oldFile.exists) {
                    var removed = false;
                    try {
                        removed = oldFile.remove();
                    } catch(removeErr) {
                        return 'ERROR:A mentés sikeres volt, de a régi fájl törlése sikertelen: ' + removeErr.message;
                    }
                    if (!removed) {
                        return 'ERROR:A mentés sikeres volt, de a régi fájl törlése sikertelen';
                    }
                }

                return 'SUCCESS';
            } catch(e) {
                return 'ERROR:' + e.message;
            }
        })();
    `;
}

// ============================================================================
// Eredmény Feldolgozók (Parsers)
// ============================================================================

/**
 * Feldolgozza az `extractPageRanges` scriptek eredmény stringjét.
 * Várt formátum: "min:max:[ranges]"
 *
 * @param {string} resultStr - Az ExtendScript által visszaadott string.
 * @returns {{success: boolean, startPage: number|null, endPage: number|null, pageRanges: string|null, error: string|null}}
 */
export function parsePageRangesResult(resultStr) {
    if (resultStr.indexOf("ERROR:") === 0) {
        return {
            success: false,
            startPage: null,
            endPage: null,
            pageRanges: null,
            error: resultStr.substring(6)
        };
    }

    // Formátum bontása: "min:max:rangesJSON"
    const colonIndex = resultStr.indexOf(":");
    const secondColonIndex = resultStr.indexOf(":", colonIndex + 1);

    if (colonIndex > 0 && secondColonIndex > colonIndex) {
        const minStr = resultStr.substring(0, colonIndex);
        const maxStr = resultStr.substring(colonIndex + 1, secondColonIndex);
        const rangesStr = resultStr.substring(secondColonIndex + 1);

        const min = parseInt(minStr, 10);
        const max = parseInt(maxStr, 10);

        if (!isNaN(min) && !isNaN(max)) {
            return {
                success: true,
                startPage: min,
                endPage: max,
                pageRanges: rangesStr,
                error: null
            };
        }
    }

    return {
        success: false,
        startPage: null,
        endPage: null,
        pageRanges: null,
        error: "Érvénytelen formátum"
    };
}

/**
 * Feldolgozza az egyszerű "success" vagy "ERROR:..." eredményeket.
 *
 * @param {string} resultStr - Az ExtendScript eredménye.
 * @returns {{success: boolean, error: string|null}}
 */
export function parseExecutionStatus(resultStr) {
    if (resultStr === "success" || resultStr === "SUCCESS") {
        return { success: true, error: null };
    }
    if (resultStr.indexOf("ERROR:") === 0) {
        return { success: false, error: resultStr.substring(6) };
    }
    return { success: false, error: resultStr };
}
