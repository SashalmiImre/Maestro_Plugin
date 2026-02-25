/**
 * @fileoverview Belső ExtendScript segédfüggvények (Logic Generators).
 * Újrafelhasználható kódrészleteket generálnak, amelyeket a script generátorok használnak.
 *
 * Fontos: Ezek a függvények NEM önálló scriptek, hanem más scriptek építőelemei.
 *
 * @module utils/indesign/scriptHelpers
 */

import { escapePathForExtendScript } from "../pathUtils.js";

/**
 * Generálja a dokumentum megnyitásának logikáját (háttérben vagy előtérben).
 * Kezeli: `app.open`, `UserInteractionLevels`, `checkLinksAtOpen`.
 *
 * @param {string} filePath - A fájl útvonala.
 * @param {string} docVarName - A dokumentum változó neve (pl. "doc").
 * @param {string} openedVarName - A változó neve, ami jelzi ha mi nyitottuk meg (pl. "openedInBackground").
 * @returns {string} ExtendScript kód.
 */
export function getBackgroundOpenLogic(filePath, docVarName, openedVarName) {
    const safePath = escapePathForExtendScript(filePath);
    return `
                // -- START: Background Open Logic --
                var path = "${safePath}";
                var f = File(path);
                if (!f.exists) f = File(encodeURI(path));
                if (!f.exists) return "ERROR:A forrásfájl nem található: " + path;

                // Megnézzük, nyitva van-e már
                var isOpen = false;
                if (app.documents.length > 0) {
                    for (var i = 0; i < app.documents.length; i++) {
                        if (app.documents[i].fullName.fsName === f.fsName) {
                            ${docVarName} = app.documents[i];
                            isOpen = true;
                            break;
                        }
                    }
                }

                if (!isOpen) {
                    // Háttérben nyitjuk meg
                    var oldInteraction = app.scriptPreferences.userInteractionLevel;
                    var oldCheckLinks = app.linkingPreferences.checkLinksAtOpen;

                    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
                    app.linkingPreferences.checkLinksAtOpen = false;

                    try {
                        ${docVarName} = app.open(f, false); // false = láthatatlan
                        ${openedVarName} = true;
                    } catch(e) {
                         // Fallback attempt with decodeURI name check
                         return "ERROR:Sikertelen megnyitás: " + e.message;
                    } finally {
                        app.scriptPreferences.userInteractionLevel = oldInteraction;
                        app.linkingPreferences.checkLinksAtOpen = oldCheckLinks;
                    }
                }

                if (!${docVarName} || !${docVarName}.isValid) return "ERROR:Dokumentum érvénytelen vagy nem sikerült megnyitni.";
                // -- END: Background Open Logic --
    `;
}

/**
 * Generálja a linkek ellenőrzésének logikáját.
 *
 * @param {string} docVarName - A dokumentum változó neve.
 * @param {string} openedVarName - A változó neve, ami jelzi ha mi nyitottuk meg (a korai bezáráshoz hiba esetén).
 * @returns {string} ExtendScript kód.
 */
export function getLinkCheckLogic(docVarName, openedVarName) {
    return `
                // -- START: Link Check Logic --
                var linkErrors = [];
                for (var i = 0; i < ${docVarName}.links.length; i++) {
                    var link = ${docVarName}.links[i];
                    if (link.status === LinkStatus.LINK_MISSING) {
                        linkErrors.push("Hiányzó kép: " + link.name);
                    } else if (link.status === LinkStatus.LINK_OUT_OF_DATE) {
                        linkErrors.push("Nem frissült kép: " + link.name);
                    }
                }

                if (linkErrors.length > 0) {
                    // Ha a háttérben nyitottuk, bezárjuk mentés nélkül
                    if (${openedVarName}) {
                        try { ${docVarName}.close(SaveOptions.NO); } catch(e) {}
                    }
                    return "ERROR:Képproblémák találhatók (" + linkErrors.length + " db): " + linkErrors.join(", ");
                }
                // -- END: Link Check Logic --
    `;
}

/**
 * Generálja a biztonságos bezárás logikáját.
 *
 * @param {string} docVarName - Dokumentum változó.
 * @param {string} openedVarName - Flag változó.
 * @param {string} [saveOption="SaveOptions.NO"] - Mentési opció.
 * @returns {string} ExtendScript kód.
 */
export function getSafeCloseLogic(docVarName, openedVarName, saveOption = "SaveOptions.NO") {
    return `
                // -- START: Safe Close Logic --
                if (${openedVarName} && ${docVarName} && ${docVarName}.isValid) {
                    try {
                        ${docVarName}.close(${saveOption});
                    } catch(e) {
                        // Ignore close errors
                    }
                }
                // -- END: Safe Close Logic --
    `;
}

/**
 * BELSŐ SEGÉD: Logika az oldaltartományok kinyeréséhez.
 * Kinyeri az oldalszámokat, rendezi őket, és tartományokat (range) képez a folytonos oldalakból.
 * A kimeneti formátum: "minPage:maxPage:[[start,end],[start,end],...]"
 *
 * @returns {string} ExtendScript kódrészlet.
 */
export function getExtractPageRangesLogic() {
    return `
                    // Oldalszámok begyűjtése
                    var pageNumbers = [];
                    for (var i = 0; i < doc.pages.length; i++) {
                        var pageNum = parseInt(doc.pages[i].name, 10);
                        if (!isNaN(pageNum)) {
                            pageNumbers.push(pageNum);
                        }
                    }

                    if (pageNumbers.length === 0) {
                        return "ERROR:Nem találhatók érvényes oldalszámok";
                    }

                    // Numerikus rendezés
                    pageNumbers.sort(function(a, b) { return a - b; });

                    // Tartományok (szekciók) detektálása
                    var ranges = [];
                    var rangeStart = pageNumbers[0];
                    var prevPage = pageNumbers[0];

                    for (var i = 1; i < pageNumbers.length; i++) {
                        if (pageNumbers[i] !== prevPage + 1) {
                            // Hézag található - lezárjuk az aktuális tartományt
                            ranges.push([rangeStart, prevPage]);
                            rangeStart = pageNumbers[i];
                        }
                        prevPage = pageNumbers[i];
                    }
                    // Utolsó tartomány hozzáadása
                    ranges.push([rangeStart, prevPage]);

                    // Min/Max számítás
                    var minPage = pageNumbers[0];
                    var maxPage = pageNumbers[pageNumbers.length - 1];

                    // Formázás stringgé (saját JSON-szerű formátum a beépített JSON hiánya miatt)
                    var rangesStr = "[";
                    for (var i = 0; i < ranges.length; i++) {
                        if (i > 0) rangesStr += ",";
                        rangesStr += "[" + ranges[i][0] + "," + ranges[i][1] + "]";
                    }
                    rangesStr += "]";

                    // Visszatérési formátum: "min:max:rangesJSON"
                    return minPage + ":" + maxPage + ":" + rangesStr;
    `;
}

/**
 * BELSŐ SEGÉD: Előállítja a cél dokumentum feloldásához szükséges logikát.
 * Ha nincs megadva fájl útvonal, az aktív dokumentumot használja.
 *
 * @param {string} varName - A dokumentum objektum változóneve a scriptben (pl. "doc").
 * @param {string|null} filePath - Opcionális fájl útvonal.
 * @returns {string} ExtendScript kódrészlet a dokumentum változó beállításához.
 */
export function getDocumentTargetLogic(varName, filePath) {
    if (!filePath) {
        return `
                if (app.documents.length === 0) return "ERROR:Nincs nyitott dokumentum";
                var ${varName} = app.activeDocument;
        `;
    }
    const safePath = escapePathForExtendScript(filePath);
    return `
                var path = "${safePath}";
                var f = File(path);
                if (!f.exists) f = File(encodeURI(path));
                var ${varName} = null;
                for (var i = 0; i < app.documents.length; i++) {
                    if (app.documents[i].fullName.fsName === f.fsName) {
                        ${varName} = app.documents[i];
                        break;
                    }
                }
                if (!${varName} || !${varName}.isValid) return "ERROR:A dokumentum nem található (nincs nyitva): " + decodeURI(f.name);
    `;
}
