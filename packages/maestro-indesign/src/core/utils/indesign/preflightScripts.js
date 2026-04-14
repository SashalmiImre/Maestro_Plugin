/**
 * @fileoverview Preflight ellenőrzés ExtendScript generátora és eredmény feldolgozója.
 *
 * @module utils/indesign/preflightScripts
 */

import { escapePathForExtendScript } from "../pathUtils.js";
import { getBackgroundOpenLogic, getSafeCloseLogic, safeEmbed } from "./scriptHelpers.js";

import { logWarn } from "../logger.js";

/**
 * A preflight `waitForProcess` loop alapértelmezett időkerete (ms).
 * 500 ms-os polling → 20 iteráció default esetén.
 */
const DEFAULT_PREFLIGHT_MAX_WAIT_MS = 10000;
const PREFLIGHT_POLL_INTERVAL_MS = 500;

/**
 * Generál egy scriptet a megadott preflight profillal történő ellenőrzéshez.
 * A script megpróbálja betölteni a profilt név alapján ("Levil"), ha nem találja,
 * akkor a megadott .idpp fájlból importálja azt.
 *
 * Ezután futtatja a preflight ellenőrzést és visszaadja az eredményeket. Ha a
 * háttérben nyitott dokumentumnál a preflight a `maxWaitMs` időkereten belül
 * nem fejezi be (pl. lassú hálózati linkek), a result explicit `TIMEOUT:` prefixet
 * kap — a `parsePreflightResult` ezt felismeri és felhasználói üzenetként jelzi.
 *
 * @param {string} filePath - Az ellenőrizendő INDD fájl útvonala.
 * @param {string} profilePath - A preflight profil (.idpp) fájl útvonala.
 * @param {string} [profileName="Levil"] - A keresett preflight profil neve.
 * @param {number} [maxWaitMs=10000] - A `waitForProcess` loop maximális időkerete ms-ban.
 * @returns {string} ExtendScript kód, ami "PREFLIGHT:..." / "TIMEOUT:..." / "UNMOUNTED_DRIVES:..." / "ERROR:..." stringet ad vissza.
 */
export function generatePreflightScript(filePath, profilePath, profileName = "Levil", maxWaitMs = DEFAULT_PREFLIGHT_MAX_WAIT_MS) {
    const openLogic = getBackgroundOpenLogic(filePath, "doc", "openedInBackground");
    const closeLogic = getSafeCloseLogic("doc", "openedInBackground", "SaveOptions.NO");
    const safeProfilePath = profilePath ? escapePathForExtendScript(profilePath) : "";
    const safeProfileName = safeEmbed(profileName, 'single');
    // Iteráció-szám a ms-alapú időkeretből
    const safeMaxWait = Math.max(PREFLIGHT_POLL_INTERVAL_MS, Number(maxWaitMs) || DEFAULT_PREFLIGHT_MAX_WAIT_MS);
    const maxAttempts = Math.ceil(safeMaxWait / PREFLIGHT_POLL_INTERVAL_MS);

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
                    profile = app.preflightProfiles.itemByName('${safeProfileName}');
                    profile.name; // Létezés ellenőrzése (hiba dobódik ha nem létezik)
                } catch(e) {
                    profile = null;
                }

                // 2b. Fallback: .idpp fájlból betöltés ha nincs telepített "Levil" profil
                // A betöltött profil neve eltérhet a keresett profileName-től (a .idpp-ben tárolt név dominál).
                // Happy path: itemByName(profileName) találat után nem kell snapshot. Ha viszont a keresett
                // név nem létezik, előtte rögzített snapshot-ból diff-eljük ki az újonnan érkezett profilt —
                // hogy takarítható maradjon.
                // Ha didLoadProfile igaz, de a profilt nem sikerült azonosítani, a végén a sweep
                // takarítja el az összes névben új, árva profilt a preLoadNames snapshot alapján.
                var preLoadNames = null;
                var didLoadProfile = false;

                if (!profile) {
                    var profileFilePath = '${safeProfilePath}';
                    if (profileFilePath.length > 0) {
                        var pf = new File(profileFilePath);
                        if (pf.exists) {
                            // Snapshot: a betöltés előtti névkészlet. A kulcsprefix (':') véd
                            // a prototype-ütközések ellen (pl. "constructor", "toString", "__proto__"
                            // nevű profil hamis találatot adhatna sima objektum-lookup-nál).
                            preLoadNames = {};
                            try {
                                for (var pi = 0; pi < app.preflightProfiles.length; pi++) {
                                    try { preLoadNames[':' + app.preflightProfiles[pi].name] = true; } catch(e) {}
                                }
                            } catch(snapErr) {}

                            try {
                                app.loadPreflightProfile(pf);
                                didLoadProfile = true;
                                // Elsődleges: keresett név alapján
                                try {
                                    var candidate = app.preflightProfiles.itemByName('${safeProfileName}');
                                    candidate.name; // Létezés ellenőrzése
                                    profile = candidate;
                                    profileCreatedByScript = true;
                                } catch(lookupErr) {
                                    // Fallback: diff a snapshot-ból
                                    for (var pj = 0; pj < app.preflightProfiles.length; pj++) {
                                        try {
                                            var pname = app.preflightProfiles[pj].name;
                                            if (!preLoadNames[':' + pname]) {
                                                profile = app.preflightProfiles[pj];
                                                profileCreatedByScript = true;
                                                break;
                                            }
                                        } catch(e) {}
                                    }
                                }
                            } catch(loadErr) {
                                profile = null;
                            }
                        }
                    }
                }

                if (!profile) {
                    // Ha a betöltés sikerült, de nem tudtuk azonosítani, végigsöpörjük a nem-ismert
                    // profilokat — így akkor se marad árva, ha sem név, sem diff nem talált rá.
                    if (didLoadProfile && preLoadNames) {
                        for (var pk = app.preflightProfiles.length - 1; pk >= 0; pk--) {
                            try {
                                if (!preLoadNames[':' + app.preflightProfiles[pk].name]) {
                                    app.preflightProfiles[pk].remove();
                                }
                            } catch(e) {}
                        }
                    }
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
                    // Windows UNC: \\server\share\... vagy //server/share/...
                    // Az fsName backslash-t ad Windows-on, de a forward-slash változatot
                    // is kezeljük a biztonság kedvéért (encodeURI / normalizálás miatt).
                    else if (lp.indexOf('\\\\') === 0 || lp.indexOf('//') === 0) {
                        // Szerver és share szegmensek elkülönítése
                        var sep = lp.charAt(0); // '\\' vagy '/'
                        var afterPrefix = lp.substring(2);
                        var serverEnd = afterPrefix.indexOf(sep);
                        if (serverEnd > 0) {
                            var afterServer = afterPrefix.substring(serverEnd + 1);
                            var shareEnd = afterServer.indexOf(sep);
                            var shareLen = shareEnd > 0 ? shareEnd : afterServer.length;
                            if (shareLen > 0) {
                                // Pl. "\\server\share"
                                volume = sep + sep + afterPrefix.substring(0, serverEnd) + sep + afterServer.substring(0, shareLen);
                            }
                        }
                    }
                    // Windows meghajtóbetű: X:\... vagy X:/...
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
                // Timeout esetén: cleanup + explicit TIMEOUT: prefix, hogy a JS oldal felismerje.
                if (openedInBackground) {
                    var timedOut = false;
                    for (var wi = 0; wi < ${maxAttempts}; wi++) {
                        var pr = '';
                        try { pr = (process.processResults || '').toString().toLowerCase(); } catch(wr) { break; }
                        if (pr.indexOf('still looking') === -1) break;
                        if (wi === ${maxAttempts} - 1) { timedOut = true; break; }
                        $.sleep(${PREFLIGHT_POLL_INTERVAL_MS});
                        process.waitForProcess();
                    }
                    if (timedOut) {
                        if (process) { try { process.remove(); } catch(ex) {} }
                        if (profileCreatedByScript && profile) { try { profile.remove(); } catch(ex) {} }
                        ${closeLogic}
                        return 'TIMEOUT:A preflight nem fejeződött be ${safeMaxWait} ms alatt.';
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

    // Preflight timeout — a waitForProcess loop maxWaitMs alatt nem fejezte be
    if (resultStr.indexOf("TIMEOUT:") === 0) {
        return {
            success: false,
            errorCount: 0,
            warningCount: 0,
            items: [],
            error: resultStr.substring(8) || "A preflight időtúllépéssel leállt."
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
                // Szándékosan nem logoljuk az itemsStr tartalmát — útvonalakat szivárogtathatna.
                logWarn("[parsePreflightResult] JSON.parse hiba:", e.message, `(itemsStr length: ${itemsStr.length})`);
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
