/**
 * @fileoverview Archiválás ExtendScript generátorok.
 *
 * Három script-generátor az archiválási folyamathoz:
 *
 *  1. `generateExtractArticleDataScript` — megnyitja az INDD-t, begyűjti az összes
 *     szövegkeretet (bounds, szöveg, paragrafusok, layer-index, group-ID) és grafikai
 *     elemet (bounds, típus, polygon path-pontok, layer-index), majd JSON-t ad vissza.
 *     A feldolgozás (klaszterezés, osztályozás, XML/TXT generálás) a plugin JS oldalon
 *     fut (`archivingProcessor.js`), nem az InDesign script-motorban.
 *
 *  2. `generateSaveTextFilesScript` — TXT és XML tartalom kiírása fájlba (a tartalmat
 *     a plugin JS adja át paraméterként a script generálásakor).
 *
 *  3. `generateCopyInddScript` — INDD fájl másolása az archívba.
 *
 * A mappakezelő scriptek (`generateListInddFilesScript`, `generateCreateArchiveFoldersScript`)
 * változatlanok.
 *
 * ### Adatkinyerési algoritmus
 *
 *  - Bejárás: `doc.spreads` → spread oldalain (`spread.pages`) rekurzív `collectFrames()`
 *    + grafikai elemek gyűjtése minden layer-ről.
 *  - Minden elemhez: bounding box, layer-index (Z-order), spread-index, group-ID.
 *  - Polygon path-pontok: `poly.paths[0].pathPoints[i].anchor` — a plugin JS ezekből
 *    számítja a tényleges terület alapú átfedést (Shoelace + Sutherland-Hodgman).
 *  - Pasteboard automatikusan kizárt (`page.textFrames` csak az oldalon lévőket adja).
 *
 * @module utils/indesign/archivingScripts
 */

import { escapePathForExtendScript } from "../pathUtils.js";

/**
 * Generál egy scriptet, ami listázza az .indd fájlokat egy adott mappában.
 * A visszatérési érték "|" elválasztóval fűzött fájlútvonalak stringje,
 * "EMPTY" ha nincs fájl, vagy "ERROR:..." hiba esetén.
 *
 * @param {string} folderPath - A keresett mappa útvonala (pl. rootPath/.maestro).
 * @returns {string} ExtendScript kód.
 */
export function generateListInddFilesScript(folderPath) {
    const safePath = escapePathForExtendScript(folderPath);
    return `(function() {
        try {
            var folder = new Folder('${safePath}');
            if (!folder.exists) return 'EMPTY';
            var files = folder.getFiles('*.indd');
            if (!files || files.length === 0) return 'EMPTY';
            var paths = [];
            for (var i = 0; i < files.length; i++) {
                if (files[i] instanceof File) paths.push(files[i].fsName);
            }
            return paths.length > 0 ? paths.join('|') : 'EMPTY';
        } catch(e) {
            return 'ERROR:' + e.message;
        }
    })();`;
}

/**
 * Generál egy scriptet, ami létrehozza az archiváláshoz szükséges
 * könyvtárstruktúrát a publikáció rootPath mappájában:
 *   __ARCHIV/
 *     TXT/    — plain szövegek (.txt)
 *     XML/    — típus-tagged XML szövegek (.xml)
 *     INDD/   — InDesign fájlmásolatok (.indd)
 *
 * @param {string} archivBasePath - Az __ARCHIV mappa teljes útvonala.
 * @returns {string} ExtendScript kód, "SUCCESS" vagy "ERROR:..." eredménnyel.
 */
export function generateCreateArchiveFoldersScript(archivBasePath) {
    const safePath = escapePathForExtendScript(archivBasePath);
    return `(function() {
        try {
            var subFolders = [
                new Folder('${safePath}'),
                new Folder('${safePath}/TXT'),
                new Folder('${safePath}/XML'),
                new Folder('${safePath}/INDD')
            ];
            for (var i = 0; i < subFolders.length; i++) {
                if (!subFolders[i].exists) subFolders[i].create();
            }
            return 'SUCCESS';
        } catch(e) {
            return 'ERROR:' + e.message;
        }
    })();`;
}

/**
 * Generál egy scriptet, ami kinyeri egy InDesign fájl összes szövegkeret- és
 * grafikai elem-adatát JSON formátumban. A feldolgozás (klaszterezés, osztályozás,
 * XML/TXT generálás) a plugin JS oldalon fut.
 *
 * Visszaadott JSON struktúra:
 * ```
 * {
 *   spreads: [{ idx, pages: [pageIdx, ...] }],
 *   textFrames: [{
 *     id, storyId, text,
 *     bounds: [y1,x1,y2,x2],
 *     spreadIdx, pageIdx, layerIndex,
 *     groupId,      // InDesign Group szülő ID-ja, vagy null
 *     paragraphs: [{ text, fontSize, styleName, charCount }]
 *   }],
 *   graphicElements: [{
 *     bounds: [y1,x1,y2,x2],
 *     spreadIdx, pageIdx, layerIndex,
 *     type,         // 'rect' | 'oval' | 'polygon' | 'image'
 *     pts           // [[x,y], ...] — csak polygon esetén, különben []
 *   }]
 * }
 * ```
 *
 * @param {string} inddSourcePath - A forrás .indd fájl útvonala.
 * @returns {string} ExtendScript kód, JSON string vagy "ERROR:..." eredménnyel.
 */
export function generateExtractArticleDataScript(inddSourcePath) {
    const safeIndd = escapePathForExtendScript(inddSourcePath);

    return `(function() {
        var doc = null;
        var openedHere = false;

        // ES3-kompatibilis trim
        function trim(s) { return s.replace(/^\\s+|\\s+$/g, ''); }

        // JSON-biztonságos string escape — karakter-kódonkénti feldolgozás,
        // hogy a tényleges ASCII kontroll karakterek (pl. CR=13, LF=10) is escape-elve legyenek.
        function jsonStr(s) {
            if (!s) return '""';
            var out = '"';
            for (var i = 0; i < s.length; i++) {
                var c = s.charCodeAt(i);
                if      (c === 34) out += '\\\\"';
                else if (c === 92) out += '\\\\\\\\';
                else if (c === 13 || c === 10) out += '\\\\n';
                else if (c === 9)  out += '\\\\t';
                else if (c < 32)   out += '\\\\u00' + (c < 16 ? '0' : '') + c.toString(16);
                else out += s.charAt(i);
            }
            return out + '"';
        }

        // Egyszerű JSON serializálás (primitívek + tömbök + objektumok)
        function toJson(v) {
            if (v === null || v === undefined) return 'null';
            if (typeof v === 'boolean') return v ? 'true' : 'false';
            if (typeof v === 'number') return isFinite(v) ? '' + v : '0';
            if (typeof v === 'string') return jsonStr(v);
            if (v && typeof v.length === 'number') {
                // Tömb
                var parts = [];
                for (var i = 0; i < v.length; i++) parts.push(toJson(v[i]));
                return '[' + parts.join(',') + ']';
            }
            // Objektum
            var keys = [], kparts = [];
            for (var k in v) { if (v.hasOwnProperty(k)) keys.push(k); }
            for (var i = 0; i < keys.length; i++) {
                kparts.push(jsonStr(keys[i]) + ':' + toJson(v[keys[i]]));
            }
            return '{' + kparts.join(',') + '}';
        }

        // Bekezdésstílus névből típus-hint
        function styleHint(name) {
            var n = (name || '').toUpperCase();
            if (/C[IÍ]M|TITLE|HEAD|FEJL|RUBR/.test(n))  return 'CIM';
            if (/LEAD|BEVEZET|INTRO/.test(n))              return 'LEAD';
            if (/K[EÉ]P|CAPTION|FOTO/.test(n))            return 'KEPALAIRAS';
            if (/KERET|BOX|SIDEBAR/.test(n))               return 'KERETES';
            if (/K[OÖ]ZC[IÍ]M|SUBHEAD|ALC/.test(n))      return 'KOZCIM';
            return null;
        }

        // Szövegkeret bekezdés-adatainak kinyerése
        function extractParagraphs(story) {
            var result = [];
            for (var pi = 0; pi < story.paragraphs.length; pi++) {
                var para = story.paragraphs[pi];
                var pt = para.contents.replace(/\\r/g, '\\n');
                var pn = pt.replace(/[ \\t\\r\\n]/g, '').length;
                if (pn === 0) continue;
                var fs = 12;
                try { var pfs = para.characters[0].pointSize; if (pfs > 0) fs = pfs; } catch(e) {}
                var sn = '';
                try { sn = para.appliedParagraphStyle.name; } catch(e) {}
                result.push({ text: pt, fontSize: fs, styleName: sn, charCount: pn });
            }
            return result;
        }

        // Szövegkeretek rekurzív gyűjtése: container közvetlen keretei + csoportok
        function collectFrames(container, spreadIdx, pageIdx, layerIndexFn, seenIds, out) {
            var tfs;
            try { tfs = container.textFrames; } catch(e) { tfs = null; }
            if (tfs) {
                for (var fi = 0; fi < tfs.length; fi++) {
                    var tf = tfs[fi];

                    // Frame ID deduplication
                    var tfId;
                    try { tfId = '' + tf.id; } catch(e) { tfId = null; }
                    if (tfId !== null) {
                        if (seenIds[tfId]) continue;
                        seenIds[tfId] = true;
                    }

                    var tfStory, tfBounds;
                    try { tfStory = tf.parentStory; } catch(e) { continue; }
                    if (!tfStory || !tfStory.isValid) continue;
                    try { tfBounds = tf.geometricBounds; } catch(e) { continue; }
                    if (tfStory.contents.replace(/[ \\t\\r\\n]/g, '').length === 0) continue;

                    // InDesign Group szülő azonosítása
                    var groupId = null;
                    try {
                        var par = tf.parent;
                        if (par && par.reflect && par.reflect.name === 'Group') groupId = par.id;
                    } catch(e) {}

                    // Layer-index (Z-order): 0 = legfelső layer az InDesign-ban
                    var li = layerIndexFn(tf);

                    out.push({
                        id: tf.id,
                        storyId: tfStory.id,
                        text: tfStory.contents,
                        bounds: tfBounds,
                        spreadIdx: spreadIdx,
                        pageIdx: pageIdx,
                        layerIndex: li,
                        groupId: groupId,
                        paragraphs: extractParagraphs(tfStory)
                    });
                }
            }

            // Rekurzív Group-bejárás
            var grps;
            try { grps = container.groups; } catch(e) { grps = null; }
            if (grps) {
                for (var gi = 0; gi < grps.length; gi++) {
                    collectFrames(grps[gi], spreadIdx, pageIdx, layerIndexFn, seenIds, out);
                }
            }
        }

        // Grafikai elem layer-indexének lekérdezése
        function getLayerIndex(item, doc) {
            try {
                var lyr = item.itemLayer;
                if (lyr) {
                    for (var li = 0; li < doc.layers.length; li++) {
                        if (doc.layers[li].id === lyr.id) return li;
                    }
                }
            } catch(e) {}
            return 0;
        }

        // Grafikai elemek gyűjtése egy oldalról (minden típus, minden látható elem)
        function collectGraphicElements(pg, spreadIdx, pageIdx, doc, out) {

            function layerIdx(item) { return getLayerIndex(item, doc); }

            // Téglalapok (színes háttérelemek)
            try {
                for (var ri = 0; ri < pg.rectangles.length; ri++) {
                    var rect = pg.rectangles[ri];
                    var rb; try { rb = rect.geometricBounds; } catch(e) { continue; }
                    var hasFill = true;
                    try { if (rect.fillColor && rect.fillColor.name === '[None]') hasFill = false; } catch(e) {}
                    try {
                        if (rect.transparencySettings &&
                            rect.transparencySettings.blendingSettings &&
                            rect.transparencySettings.blendingSettings.opacity <= 5) hasFill = false;
                    } catch(e) {}
                    if (!hasFill) continue;
                    out.push({ bounds: rb, spreadIdx: spreadIdx, pageIdx: pageIdx, layerIndex: layerIdx(rect), type: 'rect', pts: [] });
                }
            } catch(e) {}

            // Oválisok / körök
            try {
                for (var oi = 0; oi < pg.ovals.length; oi++) {
                    var oval = pg.ovals[oi];
                    var ob; try { ob = oval.geometricBounds; } catch(e) { continue; }
                    out.push({ bounds: ob, spreadIdx: spreadIdx, pageIdx: pageIdx, layerIndex: layerIdx(oval), type: 'oval', pts: [] });
                }
            } catch(e) {}

            // Sokszögek — path-pontok kinyerése a tényleges terület számításához
            try {
                for (var pli = 0; pli < pg.polygons.length; pli++) {
                    var poly = pg.polygons[pli];
                    var pb; try { pb = poly.geometricBounds; } catch(e) { continue; }
                    var pts = [];
                    try {
                        var pp = poly.paths[0].pathPoints;
                        for (var pi = 0; pi < pp.length; pi++) {
                            var anch = pp[pi].anchor;
                            pts.push([anch[0], anch[1]]);
                        }
                    } catch(e) {}
                    out.push({ bounds: pb, spreadIdx: spreadIdx, pageIdx: pageIdx, layerIndex: layerIdx(poly), type: 'polygon', pts: pts });
                }
            } catch(e) {}

            // Képkeretek (elhelyezett képet tartalmazó keretek)
            try {
                for (var gfi = 0; gfi < pg.graphicFrames.length; gfi++) {
                    var gf = pg.graphicFrames[gfi];
                    var gb; try { gb = gf.geometricBounds; } catch(e) { continue; }
                    var hasGraphic = false;
                    try { if (gf.allGraphics && gf.allGraphics.length > 0) hasGraphic = true; } catch(e) {}
                    if (!hasGraphic) continue;
                    out.push({ bounds: gb, spreadIdx: spreadIdx, pageIdx: pageIdx, layerIndex: layerIdx(gf), type: 'image', pts: [] });
                }
            } catch(e) {}
        }

        try {
            // --- 1. Dokumentum megnyitása ---
            var srcFile = new File('${safeIndd}');
            if (!srcFile.exists) return 'ERROR:Fájl nem található: ' + srcFile.fsName;

            for (var i = 0; i < app.documents.length; i++) {
                try {
                    if (app.documents[i].fullName.fsName === srcFile.fsName) {
                        doc = app.documents[i]; break;
                    }
                } catch(e) {}
            }

            if (!doc) {
                var savedInt = app.scriptPreferences.userInteractionLevel;
                var savedLnk = app.linkingPreferences.checkLinksAtOpen;
                app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
                app.linkingPreferences.checkLinksAtOpen    = false;
                try { doc = app.open(srcFile, false); openedHere = true; }
                finally {
                    app.scriptPreferences.userInteractionLevel = savedInt;
                    app.linkingPreferences.checkLinksAtOpen    = savedLnk;
                }
            }

            if (!doc || !doc.isValid) return 'ERROR:Dokumentum érvénytelen';

            // --- 2. Spread-struktúra + elemek gyűjtése ---
            var spreads     = [];
            var textFrames  = [];
            var graphicElems = [];

            // Oldal → spread leképezés előkészítése
            var pageSpreadIdx = [];
            for (var si = 0; si < doc.spreads.length; si++) {
                var sp = doc.spreads[si];
                var spPages = [];
                for (var pi = 0; pi < sp.pages.length; pi++) {
                    var pg = sp.pages[pi];
                    // doc.pages index meghatározása
                    var docPageIdx = -1;
                    for (var dp = 0; dp < doc.pages.length; dp++) {
                        try { if (doc.pages[dp].id === pg.id) { docPageIdx = dp; break; } } catch(e) {}
                    }
                    if (docPageIdx >= 0) spPages.push(docPageIdx);
                }
                spreads.push({ idx: si, pages: spPages });
            }

            // Elemek gyűjtése spread-enként, oldalonként
            for (var si = 0; si < doc.spreads.length; si++) {
                var sp = doc.spreads[si];
                for (var pi = 0; pi < sp.pages.length; pi++) {
                    var pg = sp.pages[pi];

                    // doc.pages index
                    var docPageIdx = -1;
                    for (var dp = 0; dp < doc.pages.length; dp++) {
                        try { if (doc.pages[dp].id === pg.id) { docPageIdx = dp; break; } } catch(e) {}
                    }
                    if (docPageIdx < 0) continue;

                    // Szövegkeretek (rekurzívan, group-on belüliekkel)
                    var seenIds = {};
                    var layerIdxFn = (function(d) {
                        return function(item) { return getLayerIndex(item, d); };
                    })(doc);
                    collectFrames(pg, si, docPageIdx, layerIdxFn, seenIds, textFrames);

                    // Grafikai elemek
                    collectGraphicElements(pg, si, docPageIdx, doc, graphicElems);
                }
            }

            if (textFrames.length === 0) return 'ERROR:Nem találhatók szövegkeretek az oldalakon';

            // --- 3. JSON összeállítása és visszaadása ---
            return toJson({ spreads: spreads, textFrames: textFrames, graphicElements: graphicElems });

        } catch(e) {
            return 'ERROR:' + e.message;
        } finally {
            if (openedHere && doc && doc.isValid) {
                try { doc.close(SaveOptions.NO); } catch(closeErr) {}
            }
        }
    })();`;
}

/**
 * Generál egy scriptet, ami TXT és XML tartalmakat ír ki fájlba.
 * A tartalom a plugin JS oldalon lett generálva és paraméterként kerül a scriptbe.
 *
 * @param {string} txtOutputPath  - A plain text (.txt) kimenet útvonala.
 * @param {string} xmlOutputPath  - Az XML (.xml) kimenet útvonala.
 * @param {string} txtContent     - A TXT fájl tartalma.
 * @param {string} xmlContent     - Az XML fájl tartalma.
 * @returns {string} ExtendScript kód, "SUCCESS" vagy "ERROR:..." eredménnyel.
 */
export function generateSaveTextFilesScript(txtOutputPath, xmlOutputPath, txtContent, xmlContent) {
    const safeTxt = escapePathForExtendScript(txtOutputPath);
    const safeXml = escapePathForExtendScript(xmlOutputPath);

    // A tartalmat JSON.stringify-val escape-eljük, hogy biztonságos legyen a script stringben.
    // A backtick és ${ escape szükséges, mert a template literal-ban ezek speciális karakterek.
    const escapedTxt = JSON.stringify(txtContent).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    const escapedXml = JSON.stringify(xmlContent).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

    return `(function() {
        function saveFile(fp, content) {
            var f = new File(fp);
            f.encoding = 'UTF-8';
            if (!f.open('w')) return false;
            if (!f.write(content)) {
                f.close();
                return false;
            }
            f.close();
            return true;
        }
        try {
            var txtContent = ${escapedTxt};
            var xmlContent = ${escapedXml};
            if (!saveFile('${safeTxt}', txtContent)) return 'ERROR:TXT fájl mentése sikertelen';
            if (!saveFile('${safeXml}', xmlContent)) return 'ERROR:XML fájl mentése sikertelen';
            return 'SUCCESS';
        } catch(e) {
            return 'ERROR:' + e.message;
        }
    })();`;
}

/**
 * Generál egy scriptet, ami átmásolja az INDD fájlt az archívba.
 *
 * @param {string} inddSourcePath  - A forrás .indd fájl útvonala.
 * @param {string} inddOutputPath  - Az INDD másolat célútvonala.
 * @returns {string} ExtendScript kód, "SUCCESS" vagy "ERROR:..." eredménnyel.
 */
export function generateCopyInddScript(inddSourcePath, inddOutputPath) {
    const safeIndd    = escapePathForExtendScript(inddSourcePath);
    const safeInddOut = escapePathForExtendScript(inddOutputPath);

    return `(function() {
        try {
            var srcFile = new File('${safeIndd}');
            if (!srcFile.exists) return 'ERROR:Forrás fájl nem található';
            if (!srcFile.copy('${safeInddOut}')) return 'ERROR:INDD másolása sikertelen';
            return 'SUCCESS';
        } catch(e) {
            return 'ERROR:' + e.message;
        }
    })();`;
}
