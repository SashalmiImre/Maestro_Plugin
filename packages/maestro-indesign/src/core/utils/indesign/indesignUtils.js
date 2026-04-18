/**
 * @fileoverview Segédfüggvények az InDesign dokumentumműveletekhez.
 * Közvetlen API hívásokat és UXP/ExtendScript interakciókat tartalmaz.
 * 
 * @module utils/indesignUtils
 */

import { logWarn, logError, logDebug } from "../logger.js";

// InDesign API Accessor - Lazy Loading
let _indesign = null;

const getIndesign = () => {
    if (!_indesign) {
        try {
            _indesign = require("indesign");
        } catch (e) {
            logError("[indesignUtils] Failed to require 'indesign' module:", e);
            return { app: null, ScriptLanguage: null };
        }
    }
    return _indesign;
};

/**
 * Biztonságosan visszaadja a teljes InDesign modult (lazy loaded).
 * @returns {Object} { app, IdleEvent, ScriptLanguage, ... }
 */
export const getIndesignModule = () => {
    return getIndesign();
};

/**
 * Biztonságosan visszaadja az InDesign app objektumot.
 * @returns {Object|null}
 */
export const getIndesignApp = () => {
    return getIndesign().app;
};

/**
 * Robusztusan megkeresi az aktív dokumentumot vagy egy érvényes jelöltet.
 * Különböző stratégiákat próbál végig, mert az `app.activeDocument` nem mindig megbízható
 * bizonyos események vagy fókuszvesztés esetén.
 * 
 * Stratégiák sorrendje:
 * 1. `app.activeDocument` (ha érvényes)
 * 2. Layout ablak `activeDocument`-je
 * 3. Ha pontosan 1 dokumentum van nyitva
 * 4. Az aktív ablak szülője
 * 
 * @param {Object} [appInstance] - Opcionális InDesign alkalmazás objektum.
 * @returns {Object|null} - InDesign dokumentum objektum vagy null, ha nem található.
 */
export const findActiveDocument = (appInstance) => {
    const app = appInstance || getIndesign().app;
    if (!app) return null;

    // 1. Próbáljuk a szabványos activeDocument-et
    try {
        if (!app.activeDocument) return null;
        let isValid = false;
        // Belső isValid ellenőrzés: kontrollált fail-safe (UXP gyakran dob), néma marad.
        try { isValid = app.activeDocument.isValid; } catch (_e) {}
        if (isValid) return app.activeDocument;
    } catch (e) {
        logDebug("[indesignUtils] findActiveDocument strategy 1 failed:", e?.message);
    }

    // 2. Layout ablak (gyakran érvényes, ha az esemény célpontja furcsa)
    try {
        if (app.layoutWindows && app.layoutWindows.length > 0) {
            const win = app.layoutWindows[0];
            let docCandidate = null;
            try { docCandidate = win.activeDocument; } catch (_e) {}
            if (docCandidate) {
                let isValid = false;
                try { isValid = docCandidate.isValid; } catch (_e) {}
                if (isValid) return docCandidate;
            }
        }
    } catch (e) {
        logDebug("[indesignUtils] findActiveDocument strategy 2 failed:", e?.message);
    }

    // 3. Egyetlen nyitott dokumentum literál
    try {
        if (app.documents && app.documents.length === 1) {
            const doc = app.documents.item(0);
            if (doc && doc.isValid) return doc;
        }
    } catch (e) {
        logDebug("[indesignUtils] findActiveDocument strategy 3 failed:", e?.message);
    }

    // 4. Aktív ablak fa tartalék (fallback)
    try {
        if (app.activeWindow) {
            if (app.activeWindow.parent && app.activeWindow.parent.constructor.name === "Document") {
                return app.activeWindow.parent;
            }
            if (app.activeWindow.activeSpread && app.activeWindow.activeSpread.parent) {
                return app.activeWindow.activeSpread.parent;
            }
        }
    } catch (e) {
        logDebug("[indesignUtils] findActiveDocument strategy 4 failed:", e?.message);
    }

    return null;
};

/**
 * Biztonságosan lekéri a dokumentum teljes útvonalát.
 * Kezeli az UXP Promise alapú tulajdonság elérését, ami néha aszinkron.
 * 
 * @param {Object} doc - InDesign dokumentum objektum.
 * @returns {Promise<string|null>} A dokumentum teljes fájlrendszerbeli útvonala vagy null.
 */
export const getDocPath = async (doc) => {
    let isValid = false;
    try { isValid = doc && doc.isValid; } catch (e) {}
    if (!isValid) return null;
    try {
        let fullName = doc.fullName;
        // Promise kezelése (UXP/InDesign aszinkron tulajdonság elérés)
        if (fullName && typeof fullName.then === 'function') {
            fullName = await fullName;
        }
        
        if (!fullName) {
             // Tartalék: próbáljuk a filePath tulajdonságot (néha elérhető UXP-ben)
             try {
                let fp = doc.filePath;
                if (fp && typeof fp.then === 'function') fp = await fp;
                if (fp) return fp.fsName || fp.nativePath || fp.toString();
             } catch (e2) {}
             return null;
        }
        
        return fullName.fsName || fullName.nativePath || fullName.toString();
    } catch (e) {
        return null;
    }
};

/**
 * Feloldja az esemény célpontját (pl. LayoutWindow) a hozzá tartozó dokumentum objektummá.
 * 
 * @param {Object} candidate - Esemény célpont vagy egyéb jelölt objektum.
 * @returns {Object|null} A dokumentum objektum vagy null.
 */
export const resolveTargetToDoc = (candidate) => {
    let isValid = false;
    try { isValid = candidate && candidate.isValid; } catch (e) {}
    if (!isValid) return null;
    
    try {
        // Ha LayoutWindow, akkor a szülő dokumentumát kérjük el
        if (candidate.constructor && candidate.constructor.name === "LayoutWindow") {
            const parent = candidate.parent;
            let parentValid = false;
            try { parentValid = parent && parent.isValid; } catch (e2) {}
            return parentValid ? parent : null;
        }
    } catch (e) {}

    return candidate;
};

/**
 * Lekéri az összes jelenleg nyitott InDesign dokumentum útvonalát egy ExtendScript futtatásával.
 * Ez megbízhatóbb, mint az UXP API iterációja bizonyos esetekben.
 * 
 * @param {Object} [appInstance] - Opcionális InDesign alkalmazás objektum.
 * @returns {Promise<string[]|null>} - Útvonalak listája vagy null hiba esetén.
 */
export const getOpenDocumentPaths = async (appInstance) => {
    const app = appInstance || getIndesign().app;
    const { ScriptLanguage } = getIndesign();
    
    if (!app || !ScriptLanguage) return null;

    try {
        const script = `
            (function() {
                var paths = [];
                try {
                    if (app.documents.length > 0) {
                        for (var i = 0; i < app.documents.length; i++) {
                            try {
                                var path = app.documents[i].fullName.fsName;
                                // Windows útvonal normalizálása
                                paths.push(path.replace(/\\\\/g, "/"));
                            } catch(e) {}
                        }
                    }
                } catch(e) {}
                
                // JSON string escapelés — teljes U+0000..U+001F fedéssel.
                // Kötelező a JSON spec miatt: minden control karakter escape-elve kell legyen.
                // A backslash mindig elsőnek megy, utána a quote, végül charcode-alapú sweep
                // a ritkább control karakterekre.
                function jsonEscape(s) {
                    s = s.split('\\\\').join('\\\\\\\\').split('"').join('\\\\"');
                    var out = '';
                    for (var ci = 0; ci < s.length; ci++) {
                        var cc = s.charCodeAt(ci);
                        if (cc >= 0x20) { out += s.charAt(ci); continue; }
                        if (cc === 0x08) { out += '\\\\b'; }
                        else if (cc === 0x09) { out += '\\\\t'; }
                        else if (cc === 0x0A) { out += '\\\\n'; }
                        else if (cc === 0x0C) { out += '\\\\f'; }
                        else if (cc === 0x0D) { out += '\\\\r'; }
                        else {
                            // Egyéb kontroll karakter: \\uXXXX
                            var hx = cc.toString(16);
                            while (hx.length < 4) hx = '0' + hx;
                            out += '\\\\u' + hx;
                        }
                    }
                    return out;
                }

                var json = '{"paths": [';
                for (var i = 0; i < paths.length; i++) {
                    json += '"' + jsonEscape(paths[i]) + '"';
                    if (i < paths.length - 1) json += ",";
                }
                json += ']}';
                return json;
            })();
        `;

        const result = await app.doScript(script, ScriptLanguage.JAVASCRIPT);
        const parsed = JSON.parse(result);
        return parsed.paths || [];
    } catch (e) {
        logError("[indesignUtils] getOpenDocumentPaths hiba:", e);
        return null;
    }
};

/**
 * Lekéri a fájl utolsó módosítási dátumát (timestamp) ExtendScript segítségével.
 * Ez azért szükséges, mert az UXP fs API néha korlátozott vagy lassú lehet.
 * Hexadecimális kódolást használ az útvonal átadásánál, hogy elkerülje a karakterkódolási hibákat.
 * 
 * @param {string} path - A fájl útvonala.
 * @returns {Promise<number|null>} - Időbélyeg (ms) vagy null.
 */
export const getFileTimestamp = async (path) => {
    const { app, ScriptLanguage } = getIndesign();
    if (!app || !ScriptLanguage) return null;

    try {
        // SEGÉD: String -> Hex konverzió az ExtendScript biztonságos átadásához.
        // UTF-16 code unit alapú iteráció (charCodeAt), szimmetrikusan az ExtendScript
        // `fromHex` + `String.fromCharCode` párjával — astral plane karakterek (pl. emoji,
        // BMP-n kívüli CJK) így is konzisztensen mennek át a surrogate pár mindkét felével.
        const toHex = (str) => {
            let hex = '';
            for (let i = 0; i < str.length; i++) {
                hex += str.charCodeAt(i).toString(16).padStart(4, '0');
            }
            return hex;
        };

        const pathHex = toHex(path);
        
        const script = `
            (function() {
                // Hex dekódolása ExtendScript-en belül (4 hex digit / karakter)
                function fromHex(hex) {
                    var str = '';
                    for (var i = 0; i < hex.length; i += 4) {
                        str += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
                    }
                    return str;
                }

                var safePath = fromHex("${pathHex}");
                
                var result = {
                    path: safePath,
                    exists: false,
                    modified: null,
                    error: null,
                    debug: ""
                };
                
                try {
                    var f = File(safePath);
                    if (f.exists) {
                        result.exists = true;
                        result.modified = f.modified.getTime();
                        result.debug = "Siker (Hex Dekódolva)";
                    } else {
                        result.debug = "Fájl ellenőrzés sikertelen. Útvonal: " + safePath;
                        // Itt lehetne platform-specifikus javítást próbálni, ha szükséges
                    }
                } catch(e) {
                    result.error = e.message;
                }
                
                // Manuális JSON sorosítás (polyfillel)
                // Segédfüggvény string escapeléshez JSON-hoz
                function esc(s) {
                    if (s === null) return "null";
                    if (typeof s === "boolean") return s.toString();
                    if (typeof s === "number") return s.toString();
                    return '"' + s.toString().replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"';
                }

                var json = '{';
                json += '"path": ' + esc(result.path) + ',';
                json += '"exists": ' + esc(result.exists) + ',';
                json += '"modified": ' + esc(result.modified) + ',';
                json += '"error": ' + esc(result.error) + ',';
                json += '"debug": ' + esc(result.debug);
                json += '}';
                
                return json;
            })();
        `;
        
        const jsonResult = await app.doScript(script, ScriptLanguage.JAVASCRIPT);
        
        const data = JSON.parse(jsonResult);

        if (data.error) {
             logWarn(`[indesignUtils] getFileTimestamp Script Hiba: ${data.error}`);
             return null;
        }
        if (!data.exists) {
             logWarn(`[indesignUtils] getFileTimestamp: Fájl nem található. Nyers útvonal: ${path}, Script útvonal: ${data.path}, Debug: ${data.debug}`);
             return null;
        }
        
        return data.modified;
    } catch (e) {
        logError("[indesignUtils] getFileTimestamp hiba:", e);
        return null;
    }
};

/**
 * Végrehajt egy ExtendScript kódot az InDesign-ban.
 * 
 * @param {string} script - A végrehajtandó ExtendScript kód.
 * @returns {Promise<string>} - A script visszatérési értéke stringként.
 */
export const executeScript = async (script) => {
    const { app, ScriptLanguage } = getIndesign();
    if (!app || !ScriptLanguage) throw new Error("InDesign app or ScriptLanguage not available");

    try {
        return await app.doScript(script, ScriptLanguage.JAVASCRIPT);
    } catch (e) {
        logError("[indesignUtils] executeScript hiba:", e);
        throw e;
    }
};
