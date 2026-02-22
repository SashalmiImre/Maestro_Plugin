/**
 * @fileoverview Útvonal kezelő segédfüggvények.
 * Cross-platform (Mac/Windows) útvonal normalizálás, konvertálás, ellenőrzés és fájlnév-validáció.
 *
 * @module utils/pathUtils
 */

import { PC_DRIVE_LETTER } from "./constants.js";
import os from "os";

/**
 * Normalizál egy fájl elérési utat:
 * - Backslash-eket (\) forward slash-re (/) cseréli.
 * - Eltávolítja a záró perjelet, ha van.
 * 
 * @param {string} path - A normalizálandó útvonal.
 * @returns {string} A normalizált útvonal forward slash-ekkel, záró perjel nélkül.
 * 
 * @example
 * normalizePath("C:\\Users\\Documents\\") // Eredmény: "C:/Users/Documents"
 * normalizePath("/Volumes/Story/") // Eredmény: "/Volumes/Story"
 */
export const normalizePath = (path) => {
    if (!path) return "";
    // UXP útvonalak általában szabványosak, de ez biztosítja a konzisztenciát
    return path.replace(/\\/g, "/").replace(/\/$/, "");
};

/**
 * Escapeli a fájl útvonalat az ExtendScript-ben való biztonságos használathoz.
 * Kifejezetten single-quoted string literálokhoz ('...') készíti elő.
 * Kezeli a backslash-eket (Windows) és az aposztrófokat.
 * 
 * @param {string} filePath - A natív fájl útvonal.
 * @returns {string} Az escapelt útvonal, ami biztonságosan beilleszthető ExtendScript kódba.
 * 
 * @example
 * // Windows:
 * escapePathForExtendScript("C:\\Users\\file.indd") // Eredmény: "C:\\\\Users\\\\file.indd"
 * 
 * // Mac (aposztróf kezelése):
 * escapePathForExtendScript("/Users/imre/file's.indd") // Eredmény: "/Users/imre/file\\'s.indd"
 */
export const escapePathForExtendScript = (filePath) => {
    if (!filePath) return "";
    // Először a backslash-eket duplázzuk, majd az aposztrófokat escapeljük
    return filePath.split('\\').join('\\\\').split("'").join("\\'");
};


/**
 * Ellenőrzi, hogy egy fájl útvonal egy adott mappa hierarchián belül van-e.
 * 
 * @param {string} filePath - A vizsgálandó fájl útvonala.
 * @param {string} folderPath - A mappa útvonala.
 * @returns {boolean} Igaz, ha a fájl a mappában (vagy almappájában) van, egyébként hamis.
 * 
 * @example
 * isFileInFolder("/Volumes/Story/Articles/article.indd", "/Volumes/Story") // true
 * isFileInFolder("/Documents/file.txt", "/Volumes/Story") // false
 */
export const isFileInFolder = (filePath, folderPath) => {
    const normalizedFile = normalizePath(filePath);
    const normalizedFolder = normalizePath(folderPath);
    
    // Pontos egyezés vagy mappa prefix ellenőrzés
    // A '/' hozzáfűzése biztosítja, hogy "/Volumes/StoryArchive" ne egyezzen "/Volumes/Story"-val
    if (normalizedFile === normalizedFolder) return true;
    
    const folderPrefix = normalizedFolder.endsWith('/') 
        ? normalizedFolder 
        : `${normalizedFolder}/`;
        
    return normalizedFile.startsWith(folderPrefix);
};

// TODO: PC meghajtó betűjel ellenőrzése felhasználóval. Jelenleg Z:-t feltételezünk.
/** Root útvonal PC hálózati meghajtókhoz (constants.js-ből importálva) */
const PC_ROOT = PC_DRIVE_LETTER;

/**
 * Belső segédfüggvény bármely útvonal normalizálására.
 * - Forward slash-eket használ.
 * - NFC normalizálást végez a karakterkódoláson.
 * - Kezeli az URI-kódolt útvonalakat (decode).
 * 
 * @private
 * @param {string} path - A normalizálandó útvonal.
 * @returns {string} A teljesen normalizált (dekódolt, NFC) útvonal.
 */
const normalize = (path) => {
    let decodedPath = path;
    try {
        decodedPath = decodeURIComponent(path);
    } catch (e) {
        // Ha hibás az URI kódolás, megtartjuk az eredetit
        if (!(e instanceof URIError)) {
             console.error('[PathUtils] Nem várt hiba a decodeURIComponent hívásakor:', e);
        }
    }
    return decodedPath.replace(/\\/g, "/").normalize('NFC');
};

/**
 * Leképezi (Mappeli) a fájl útvonalat Mac és Windows platformok között.
 * Ha hálózati útvonalat talál, elvégzi a konverziót.
 * 
 * - Windows-on: Mac hálózati útvonalakat (/Volumes/Name/...) konvertál Windows-ra (Z:/Name/...)
 * - Mac-en: Windows hálózati útvonalakat (Z:/...) konvertál Mac-re (/Volumes/...)
 * - Egyéb esetben (helyi fájlok) nem módosít.
 * 
 * @param {string} path - A konvertálandó fájl útvonal.
 * @returns {string} A platform-specifikus útvonal.
 */
export const resolvePlatformPath = (path) => {
    if (!path) return "";
    
    // Platform detektálás (Node/UXP)
    let platform = "darwin"; // Default fallback
    try {
        if (typeof os !== 'undefined') {
            platform = os.platform();
        } else {
             // Fallback teszt környezethez vagy ha az os modul hiányzik
             // A teszt scriptben mockolhatjuk vagy itt kezeljük.
             // Most feltételezzük a Mac-et fejlesztéshez, de az 'os' importnak működnie kell.
        }
    } catch(e) {
        console.warn("OS modul nem elérhető, alapértelemezett 'darwin' használata.");
    }

    let processedPath = normalize(path);

    if (platform === "win32") {
        // PC: /Volumes/VolName/... -> Z:/VolName/... konverzió
        // Csak akkor konvertálunk, ha Mac Volume útvonalról van szó
        const macMatch = processedPath.match(/^\/Volumes\/([^\/]+)(.*)/);
        if (macMatch) {
            // macMatch[1] = Kötet Neve, macMatch[2] = Maradék
            // Pl: /Volumes/Story/File.indd -> Z:/Story/File.indd
            // A Z: betűjelet dinamikusan a konstansból vesszük.
            return `${PC_DRIVE_LETTER}/${macMatch[1]}${macMatch[2]}`; 
        }
    } else if (platform === "darwin") {
        // Mac: Z:/... -> /Volumes/... konverzió (feltételezve, hogy a PC meghajtó a hálózati megosztás)
        // Ellenőrizzük, hogy a path azzal a betűjellel kezdődik-e, amit PC-n hálózatnak használunk
        if (processedPath.toUpperCase().startsWith(PC_DRIVE_LETTER)) {
             // Z:/Folder/File.indd -> /Volumes/Folder/File.indd
             // Levágjuk a "Z:" részt (2 karakter)
             const pathAfterDrive = processedPath.substring(2); 
             return `/Volumes${pathAfterDrive}`;
        }
    }

    return processedPath;
};

/**
 * Generálja az összes lehetséges cross-platform útvonal variánst egy adott útvonalhoz.
 * Hasznos fájlok keresésekor a hálózaton.
 * 
 * Visszatérési értékek (tömb):
 * - Normalizált bemeneti útvonal
 * - Ha hálózati: a másik platformnak megfelelő variáns (Z: <-> /Volumes/)
 * - Windows stílusú útvonal backslash-ekkel
 * 
 * @param {string} path - A fájl útvonal.
 * @returns {string[]} Az összes lehetséges útvonal variáns tömbje.
 */
export const getCrossPlatformPaths = (path) => {
    if (!path) return [];
    
    // 1. Bemenet normalizálása
    const p1 = normalize(path);
    
    // 2. Variánsok generálása
    const paths = new Set();
    paths.add(p1);

    // Segédfüggvény: PC variáns hozzáadása backslash-sel is
    const addPcVariant = (pathWithForwardSlashes) => {
        paths.add(pathWithForwardSlashes);
        paths.add(pathWithForwardSlashes.replace(/\//g, "\\"));
    };
    
    // A) Bemenet: Mac Volume (/Volumes/Name/...)
    const macMatch = p1.match(/^\/Volumes\/([^\/]+)(.*)/);
    if (macMatch) {
        // Generálunk PC variánst: Z:/Name/...
        const pcPath = `${PC_DRIVE_LETTER}/${macMatch[1]}${macMatch[2]}`;
        addPcVariant(pcPath);
    } 
    // B) Bemenet: PC Drive (Z:/...) ami a hálózati meghajtónk
    else if (p1.toUpperCase().startsWith(PC_DRIVE_LETTER)) {
        addPcVariant(p1); // Self
        
        // Generálunk Mac variánst: /Volumes/...
        // A PC_DRIVE_LETTER-t (pl "Z:") levágjuk:
        const pathAfterDrive = p1.substring(PC_DRIVE_LETTER.length);
        paths.add(`/Volumes${pathAfterDrive}`);
    }
    // C) Egyéb (pl. C:/Local vagy /Users/Local vagy más nem hálózati drive)
    else {
        // Ha nem a megosztott Z: drive, akkor csak sima path normalizálás van.
        // Ha ez egy Windows path (bármilyen betűvel), akkor adjunk backslash verziót is
        if (p1.match(/^[a-zA-Z]:\//)) {
             addPcVariant(p1);
        }
    }
    
    return Array.from(paths);
};

/**
 * Natív fájl elérési utat konvertál helyes file:// URL formátumra.
 * Kezeli a Windows (backslash) és Mac (forward slash) útvonalakat is,
 * valamint a már meglévő file: URL-eket.
 * 
 * @param {string} path - A natív elérési út.
 * @returns {string} A formázott file:// URL.
 */
export const convertNativePathToUrl = (path) => {
    if (!path) return "";
    
    let url = path;
    const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

    if (url.startsWith("file:")) {
        // Már URL, biztosítjuk a kódolást
        const match = url.match(/^(file:\/*)(.*)/);
        if (match) {
            try {
                // Először decode, hogy elkerüljük a dupla kódolást
                const decoded = decodeURI(match[2]);
                url = match[1] + encodePath(decoded);
            } catch (e) {
                // Fallback: nyers szegmens kódolása
                url = match[1] + encodePath(match[2]);
            }
        }
    } else {
        // Natív útvonal konvertálása
        if (url.startsWith("/")) {
            // Mac/Unix: /Users/... -> file:///Users/...
            url = "file://" + encodePath(url);
        } else {
            // Windows: Z:/... -> file:///Z:/...
            let normalizedPath = url.replace(/\\/g, "/");
            // Ha drive letter (pl. C:/...), akkor a kettőspontot nem kódoljuk
            const winDriveMatch = normalizedPath.match(/^([a-zA-Z]:)\/(.*)/);
            if (winDriveMatch) {
                // winDriveMatch[1] = "C:", winDriveMatch[2] = "Users/..."
                url = "file:///" + winDriveMatch[1] + "/" + encodePath(winDriveMatch[2]);
            } else {
                url = "file:///" + encodePath(normalizedPath);
            }
        }
    }
    
    return url;
};

/**
 * Szétbont egy fájl útvonalat komponenseire.
 * Működik Windows (backslash) és Mac/Unix (forward slash) útvonalakkal is.
 * 
 * @param {string} filePath - A szétbontandó útvonal.
 * @returns {Object} Útvonal komponensek:
 * @returns {string} return.parentPath - Szülő könyvtár útvonala.
 * @returns {string} return.fileName - Teljes fájlnév kiterjesztéssel.
 * @returns {string} return.baseName - Fájlnév kiterjesztés nélkül.
 * @returns {string} return.extension - Fájlkiterjesztés (pl. ".indd").
 * 
 * @example
 * parsePath("/Volumes/Story/Articles/Cimlap.indd")
 * // Eredmény: { parentPath: "/Volumes/Story/Articles", fileName: "Cimlap.indd", baseName: "Cimlap", extension: ".indd" }
 */
export const parsePath = (filePath) => {
    if (!filePath) return { parentPath: "", fileName: "", baseName: "", extension: "" };
    
    const pathSeparator = filePath.includes('/') ? '/' : '\\';
    const lastSepIndex = filePath.lastIndexOf(pathSeparator);
    
    const parentPath = lastSepIndex !== -1 ? filePath.substring(0, lastSepIndex) : "";
    const fileName = lastSepIndex !== -1 ? filePath.substring(lastSepIndex + 1) : filePath;
    
    const lastDotIndex = fileName.lastIndexOf('.');
    const baseName = lastDotIndex !== -1 ? fileName.substring(0, lastDotIndex) : fileName;
    const extension = lastDotIndex !== -1 ? fileName.substring(lastDotIndex) : "";
    
    return { parentPath, fileName, baseName, extension };
};

/**
 * Összefűz egy mappa útvonalat és egy fájlnevet.
 * Automatikusan a megfelelő elválasztó karaktert használja a szülő útvonal alapján.
 *
 * @param {string} parentPath - A szülő könyvtár útvonala.
 * @param {string} fileName - A fájlnév.
 * @returns {string} A teljes összefűzött útvonal.
 */
export const joinPath = (parentPath, fileName) => {
    if (!parentPath) return fileName;
    const pathSeparator = parentPath.includes('/') ? '/' : '\\';
    return parentPath + pathSeparator + fileName;
};

/**
 * Tiltott fájlnév-karakterek mindkét operációs rendszeren (Windows + macOS).
 * Windows: \ / : * ? " < > |
 * macOS: / :
 * Összesítve: \ / : * ? " < > |
 */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/;

/**
 * Windows által fenntartott eszköznevek (kis- és nagybetű-érzéketlen).
 * Ezek a nevek önmagukban nem használhatók fájlnévként Windows rendszeren.
 */
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Ellenőrzi, hogy a fájlnév érvényes-e mindkét operációs rendszeren.
 * - Trim utáni üres string → érvénytelen
 * - Windows fenntartott eszköznevek (CON, PRN, AUX, NUL, COM1–COM9, LPT1–LPT9) → érvénytelen
 * - Pontra vagy szóközre végződő nevek → érvénytelen (Windows nem engedi)
 * - Tiltott karaktereket tartalmazó nevek → érvénytelen
 * @param {string} name - A vizsgálandó fájlnév (kiterjesztés nélkül).
 * @returns {boolean} true ha érvényes, false ha érvénytelen.
 */
export const isValidFileName = (name) => {
    const trimmed = (name || "").trim();
    if (trimmed === "") return false;
    if (WINDOWS_RESERVED_NAMES.test(trimmed)) return false;
    if (trimmed.endsWith(".") || trimmed.endsWith(" ")) return false;
    return !INVALID_FILENAME_CHARS.test(trimmed);
};

/**
 * Ellenőrzi, hogy egy natív fájl/mappa útvonal elérhető-e (a meghajtó csatlakoztatva van-e).
 * ExtendScript `Folder(path).exists`-et használ, ami Mac-en és Windows-on is működik.
 *
 * // TODO: A PC-s meghajtójelölések (betűjelek, UNC útvonalak) kezelését pontosítani kell
 * //       a tényleges hálózati környezet alapján.
 *
 * @param {string} nativePath - A vizsgálandó natív útvonal.
 * @returns {Promise<boolean>} Igaz, ha az útvonal elérhető, egyébként hamis.
 */
export const checkPathAccessible = async (nativePath) => {
    if (!nativePath) return false;
    try {
        const { app, ScriptLanguage } = require("indesign");
        const safePath = escapePathForExtendScript(nativePath);
        const result = await app.doScript(
            `Folder('${safePath}').exists`,
            ScriptLanguage.JAVASCRIPT
        );
        return result === true || result === 'true';
    } catch (err) {
        console.debug('[PathUtils] ExtendScript call failed:', err);
        return false;
    }
};
