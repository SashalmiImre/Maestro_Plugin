/**
 * @fileoverview Preflight ellenőrzés ExtendScript generátora és eredmény feldolgozója.
 *
 * @module utils/indesign/preflightScripts
 */

import { escapePathForExtendScript } from "../pathUtils.js";
import { getBackgroundOpenLogic, getSafeCloseLogic } from "./scriptHelpers.js";

/**
 * Generál egy scriptet a megadott preflight profillal történő ellenőrzéshez.
 * A script megpróbálja betölteni a profilt név alapján ("Levil"), ha nem találja,
 * akkor a megadott .idpp fájlból importálja azt.
 *
 * Ezután futtatja a preflight ellenőrzést és visszaadja az eredményeket.
 *
 * @param {string} filePath - Az ellenőrizendő INDD fájl útvonala.
 * @param {string} profilePath - A preflight profil (.idpp) fájl útvonala.
 * @returns {string} ExtendScript kód, ami "PREFLIGHT:errorCount:warningCount:[items]" vagy "ERROR:..." stringet ad vissza.
 */
export function generatePreflightScript(filePath, profilePath, profileName = "Levil") {
    const openLogic = getBackgroundOpenLogic(filePath, "doc", "openedInBackground");
    const closeLogic = getSafeCloseLogic("doc", "openedInBackground", "SaveOptions.NO");
    const safeProfilePath = profilePath ? escapePathForExtendScript(profilePath) : "";

    return `
        (function() {
            var doc = null;
            var openedInBackground = false;
            var process = null;
            var profile = null;
            var profileCreatedByScript = false;

            try {
                // 1. DOKUMENTUM MEGNYITÁSA
                ${openLogic}

                // 2. PREFLIGHT PROFIL BETÖLTÉSE
                // Elsősorban a meglévő "Levil" profilt használjuk (gyors, szabályok rendben).
                // Ha nincs telepítve, fallback: .idpp fájlból töltjük be.

                // 2a. Meglévő "Levil" profil keresése
                try {
                    profile = app.preflightProfiles.itemByName("${profileName}");
                    profile.name; // Létezés ellenőrzése (hiba dobódik ha nem létezik)
                } catch(e) {
                    profile = null;
                }

                // 2b. Fallback: .idpp fájlból betöltés ha nincs telepített "Levil" profil
                if (!profile) {
                    var profileFilePath = "${safeProfilePath}";
                    if (profileFilePath.length > 0) {
                        var pf = new File(profileFilePath);
                        if (pf.exists) {
                            try {
                                app.loadPreflightProfile(pf);
                                // A betöltött profil a .idpp-ben tárolt névvel jelenik meg (ami valószínűleg egyezik a profileName-mel)
                                // De biztonságból lekérjük név szerint
                                profile = app.preflightProfiles.itemByName("${profileName}");
                                profile.name; // Létezés ellenőrzése
                                profileCreatedByScript = true;
                            } catch(loadErr) {
                                profile = null;
                            }
                        }
                    }
                }

                if (!profile) {
                    return "ERROR:Nincs elérhető preflight profil (sem telepített, sem .idpp fájl).";
                }

                // 2.5 VOLUME ELLENŐRZÉS — Csatolatlan meghajtók detektálása
                // A linkek fájl útvonalaiból kinyerjük az egyedi volume/meghajtó gyökereket,
                // és ellenőrizzük, hogy léteznek-e. Ha bármelyik hiányzik, a preflight
                // eredménye megbízhatatlan lenne (hamis "missing link" hibák).
                var checkedVolumes = {};
                var unmountedVolumes = [];

                for (var vi = 0; vi < doc.links.length; vi++) {
                    var lp = '';
                    try {
                        // File().fsName konvertálja a link útvonalat natív formátumra
                        // (Mac-en POSIX: /Volumes/..., Windows-on: X:\\...)
                        // Ez szükséges, mert link.filePath HFS formátumot is adhat Mac-en
                        // (pl. "Story:Images:photo.jpg" a "/Volumes/Story/Images/photo.jpg" helyett)
                        var rawPath = doc.links[vi].filePath;
                        if (!rawPath || rawPath.length === 0) continue;
                        lp = File(rawPath).fsName;
                    } catch(ve) { continue; }
                    if (!lp || lp.length === 0) continue;

                    var volume = '';

                    // Mac: /Volumes/VolumeName/...
                    if (lp.indexOf('/Volumes/') === 0) {
                        var slashIdx = lp.indexOf('/', 9); // 9 = "/Volumes/".length
                        volume = slashIdx > 0 ? lp.substring(0, slashIdx) : lp;
                    }
                    // Windows: X:\... vagy X:/...
                    // TODO: A PC-s meghajtójelöléseket (betűjelek, UNC útvonalak) pontosítani kell
                    //       a tényleges hálózati környezet alapján. Jelenleg bármilyen drive letter-t ellenőriz.
                    else if (lp.length >= 2 && lp.charAt(1) === ':') {
                        volume = lp.charAt(0) + ':/';
                    }

                    if (volume.length > 0 && !checkedVolumes[volume]) {
                        checkedVolumes[volume] = true;
                        if (!Folder(volume).exists) {
                            unmountedVolumes.push(volume);
                        }
                    }
                }

                if (unmountedVolumes.length > 0) {
                    // Csatolatlan meghajtó(k) → preflight kihagyása, cleanup
                    if (process) { try { process.remove(); } catch(ex) {} }
                    if (profileCreatedByScript && profile) { try { profile.remove(); } catch(ex) {} }
                    ${closeLogic}
                    return 'UNMOUNTED_DRIVES:' + unmountedVolumes.join('|');
                }

                // 3. LINK-ÁLLAPOTOK ÉS LAYOUT FRISSÍTÉSE (háttérben megnyitott dokumentumnál szükséges)
                if (openedInBackground) {
                    try {
                        // Recompose: kényszeríti a teljes layout feldolgozást,
                        // ami nélkül a preflight motor nem kap pontos állapotot
                        doc.recompose();
                    } catch(rc) {}
                    try {
                        var links = doc.links;
                        for (var li = 0; li < links.length; li++) {
                            links[li].status; // Állapot kiértékelésének kényszerítése
                        }
                    } catch(le) {}
                }

                // 4. PREFLIGHT FUTTATÁSA
                process = app.preflightProcesses.add(doc, profile);
                process.waitForProcess();

                // Háttérben megnyitott dokumentumnál a waitForProcess() korán visszatérhet.
                // Ilyenkor ismételt ellenőrzéssel várjuk meg a tényleges befejezést.
                if (openedInBackground) {
                    var maxAttempts = 20;
                    for (var wi = 0; wi < maxAttempts; wi++) {
                        var pr = '';
                        try { pr = (process.processResults || '').toString().toLowerCase(); } catch(wr) { break; }
                        if (pr.indexOf('still looking') === -1) break;
                        $.sleep(500);
                        process.waitForProcess();
                    }
                }

                // 4. EREDMÉNYEK ÖSSZEGYŰJTÉSE
                var errorCount = 0;
                var items = [];

                // Segédfüggvény: string escape-elés JSON-hoz
                function escapeForJson(str) {
                    return str
                        .split('\\\\').join('\\\\\\\\')
                        .split('"').join('\\\\"')
                        .split('\\n').join('\\\\n')
                        .split('\\r').join('\\\\r')
                        .split('\\t').join('\\\\t');
                }

                // 4a. processResults: megbízható "van-e hiba?" ellenőrzés
                // "None" ha nincs hiba, szöveges összefoglaló ha van
                var resultText = "";
                try { resultText = (process.processResults || "").toString(); } catch(prErr) {}
                var trimmed = resultText.replace(/^\\s+|\\s+$/g, "");
                var hasErrors = (trimmed.length > 0 && trimmed !== "None");

                if (hasErrors) {
                    // 4b. aggregatedResults[2]: strukturált hibalista (ha elérhető)
                    // Struktúra: aggregatedResults[2] = [[kategória, leírás, oldal, objektumInfo], ...]
                    var usedAggregated = false;
                    try {
                        var aggErrors = process.aggregatedResults[2];
                        if (aggErrors && aggErrors.length > 0) {
                            for (var i = 0; i < aggErrors.length; i++) {
                                var err = aggErrors[i];
                                var category   = escapeForJson((err[0] || "").toString());
                                var desc       = escapeForJson((err[1] || "").toString());
                                var page       = escapeForJson((err[2] || "").toString());
                                var objectInfo = escapeForJson((err[3] || "").toString());
                                items.push('["' + category + '","' + desc + '","' + page + '","' + objectInfo + '"]');
                                errorCount++;
                            }
                            usedAggregated = true;
                        }
                    } catch(aggErr) {
                        // aggregatedResults nem elérhető, processResults-ra fallback
                    }

                    // 4c. Fallback: processResults szöveges feldolgozása
                    if (!usedAggregated) {
                        var lines = trimmed.split("\\r");
                        var currentRule = "";
                        for (var k = 0; k < lines.length; k++) {
                            var line = lines[k].split("\\n").join("");
                            if (line.length === 0) continue;
                            var fc = line.charAt(0);
                            if ((fc === " " || fc === "\\t") && currentRule.length > 0) {
                                var detail = line.replace(/^\\s+/, "");
                                items.push('["' + escapeForJson(currentRule) + '","' + escapeForJson(detail) + '","",""]');
                                errorCount++;
                            } else {
                                currentRule = line.replace(/^\\s+/, "");
                            }
                        }
                        if (errorCount === 0 && trimmed.length > 0) {
                            items.push('["Preflight","' + escapeForJson(trimmed) + '","",""]');
                            errorCount = 1;
                        }
                    }
                }

                // Folyamat eltávolítása
                try { process.remove(); } catch(e) {}
                process = null;

                // 5. PROFIL ELTÁVOLÍTÁSA (csak ha .idpp-ből töltöttük be)
                if (profileCreatedByScript) {
                    try { profile.remove(); } catch(e) {}
                }

                // 6. DOKUMENTUM BEZÁRÁSA
                ${closeLogic}

                // 7. VISSZATÉRÉS
                var itemsStr = "[" + items.join(",") + "]";
                return "PREFLIGHT:" + errorCount + ":0:" + itemsStr;

            } catch(e) {
                // Cleanup hiba esetén
                if (process) { try { process.remove(); } catch(ex) {} }
                if (profileCreatedByScript && profile) { try { profile.remove(); } catch(ex) {} }
                ${closeLogic}
                return "ERROR:" + e.message;
            }
        })();
    `;
}

/**
 * Feldolgozza a `generatePreflightScript` eredmény stringjét.
 * Várt formátum: "PREFLIGHT:errorCount:warningCount:[items]" vagy "ERROR:..."
 *
 * @param {string} resultStr - Az ExtendScript által visszaadott string.
 * @returns {{success: boolean, errorCount: number, warningCount: number, items: Array, error: string|null}}
 */
export function parsePreflightResult(resultStr) {
    if (!resultStr || resultStr.indexOf("ERROR:") === 0) {
        return {
            success: false,
            errorCount: 0,
            warningCount: 0,
            items: [],
            error: resultStr ? resultStr.substring(6) : "Nincs eredmény"
        };
    }

    // Csatolatlan meghajtók detektálása — a preflight nem futott le
    if (resultStr.indexOf("UNMOUNTED_DRIVES:") === 0) {
        const drives = resultStr.substring(17).split('|').filter(Boolean);
        return {
            success: true,
            errorCount: 0,
            warningCount: 0,
            items: [],
            error: null,
            unmountedDrives: drives
        };
    }

    if (resultStr.indexOf("PREFLIGHT:") === 0) {
        const payload = resultStr.substring(10);
        const firstColon = payload.indexOf(":");
        const secondColon = payload.indexOf(":", firstColon + 1);

        if (firstColon > 0 && secondColon > firstColon) {
            const errorCount = parseInt(payload.substring(0, firstColon), 10);
            const warningCount = parseInt(payload.substring(firstColon + 1, secondColon), 10);
            const itemsStr = payload.substring(secondColon + 1);

            let items = [];
            let parseError = null;
            try {
                items = JSON.parse(itemsStr);
            } catch (e) {
                parseError = e.message;
                console.warn("[parsePreflightResult] JSON.parse hiba:", e.message, "itemsStr:", itemsStr.substring(0, 200));
            }

            return {
                success: true,
                errorCount: isNaN(errorCount) ? 0 : errorCount,
                warningCount: isNaN(warningCount) ? 0 : warningCount,
                items: items,
                error: null,
                parseError: parseError
            };
        }
    }

    return {
        success: false,
        errorCount: 0,
        warningCount: 0,
        items: [],
        error: "Ismeretlen preflight eredmény formátum"
    };
}
