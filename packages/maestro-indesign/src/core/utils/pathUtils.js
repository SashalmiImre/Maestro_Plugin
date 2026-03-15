/**
 * @fileoverview Útvonal kezelő segédfüggvények.
 * Cross-platform (Mac/Windows) útvonal normalizálás, konvertálás, ellenőrzés és fájlnév-validáció.
 *
 * @module utils/pathUtils
 */

import { MOUNT_PREFIX } from "./constants.js";
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
const normalizePath = (path) => {
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
 * Visszaadja az aktuális platform mount prefix-ét.
 * @private
 * @returns {string} A platform mount prefix (pl. "/Volumes" vagy "C:/Volumes").
 */
const getMountPrefix = () => {
    let platform = "darwin";
    try {
        if (typeof os !== 'undefined') {
            platform = os.platform();
        }
    } catch(e) {
        console.warn("[PathUtils] OS modul nem elérhető, alapértelmezett 'darwin' használata.");
    }
    return MOUNT_PREFIX[platform] || MOUNT_PREFIX.darwin;
};

// =============================================================================
// Kanonikus útvonal konverzió (natív ↔ DB formátum)
// =============================================================================

/**
 * Natív útvonal → kanonikus formátum (DB-ben tároláshoz).
 * Leválasztja a platform-specifikus mount prefix-et.
 *
 * Mac:  /Volumes/Story/2026/March → /Story/2026/March
 * Win:  C:/Volumes/Story/2026/March → /Story/2026/March
 * Win:  C:\Volumes\Story\2026\March → /Story/2026/March
 *
 * Helyi (nem hálózati) útvonal változatlanul marad.
 *
 * @param {string} nativePath - A natív fájl/mappa útvonal.
 * @returns {string} A kanonikus útvonal (platform-prefix nélkül).
 */
export const toCanonicalPath = (nativePath) => {
    if (!nativePath) return "";

    const processed = normalize(nativePath);
    const prefix = getMountPrefix();

    // Ha a path a mount prefix-szel kezdődik, levágjuk
    if (processed.startsWith(prefix + "/") || processed === prefix) {
        return processed.substring(prefix.length) || "/";
    }

    // Ellenőrizzük mindkét platform prefix-ét (pl. Mac-en kapott Win path)
    for (const pfx of Object.values(MOUNT_PREFIX)) {
        if (pfx !== prefix && (processed.startsWith(pfx + "/") || processed === pfx)) {
            return processed.substring(pfx.length) || "/";
        }
    }

    // Helyi fájl — nem kanonizálható, visszaadjuk normalizáltan
    return processed;
};

/**
 * Kanonikus útvonal → natív (aktuális platform prefix-szel).
 *
 * Mac: /Story/2026/March → /Volumes/Story/2026/March
 * Win: /Story/2026/March → C:/Volumes/Story/2026/March
 *
 * Már natív vagy helyi útvonal változatlanul marad.
 *
 * @param {string} canonicalPath - A kanonikus útvonal (DB-ből).
 * @returns {string} A platform-specifikus natív útvonal.
 */
export const toNativePath = (canonicalPath) => {
    if (!canonicalPath) return "";

    const processed = normalize(canonicalPath);

    // Ha már natív formátumban van (mount prefix-szel kezdődik), nem konvertálunk
    for (const pfx of Object.values(MOUNT_PREFIX)) {
        if (processed.startsWith(pfx + "/") || processed === pfx) {
            // Másik platform prefix-e → konvertálás az aktuális platformra
            const canonical = processed.substring(pfx.length) || "/";
            return getMountPrefix() + canonical;
        }
    }

    // Kanonikus path → prefix hozzáfűzése
    if (processed.startsWith("/")) {
        return getMountPrefix() + processed;
    }

    // Helyi fájl vagy relatív path — visszaadjuk normalizáltan
    return processed;
};

/**
 * Abszolút article útvonal → relatív a kiadvány kanonikus rootPath-jához.
 *
 * Abszolút: /Story/.maestro/article.indd, root: /Story → .maestro/article.indd
 * Natív:    /Volumes/Story/.maestro/article.indd, root: /Story → .maestro/article.indd
 *
 * @param {string} absolutePath - Az abszolút fájl útvonal (natív vagy kanonikus).
 * @param {string} canonicalRoot - A kiadvány kanonikus rootPath-ja.
 * @returns {string} A relatív útvonal a root-hoz képest.
 */
export const toRelativeArticlePath = (absolutePath, canonicalRoot) => {
    if (!absolutePath || !canonicalRoot) return absolutePath || "";

    // Mindkettőt kanonikusra hozzuk
    const canonicalFile = toCanonicalPath(absolutePath);
    const root = normalize(canonicalRoot).replace(/\/$/, "");

    // Ha a fájl a root alatt van, levágjuk a root részt
    if (canonicalFile.startsWith(root + "/")) {
        return canonicalFile.substring(root.length + 1);
    }

    // Ha már relatív, visszaadjuk kanonikus formátumban
    return canonicalFile;
};

/**
 * Relatív article útvonal → abszolút natív.
 *
 * .maestro/article.indd + /Story → /Volumes/Story/.maestro/article.indd (Mac)
 * .maestro/article.indd + /Story → C:/Volumes/Story/.maestro/article.indd (Win)
 *
 * @param {string} relativePath - A relatív fájl útvonal (a pub root-hoz képest).
 * @param {string} canonicalRoot - A kiadvány kanonikus rootPath-ja.
 * @returns {string} Az abszolút natív útvonal.
 */
export const toAbsoluteArticlePath = (relativePath, canonicalRoot) => {
    if (!relativePath || !canonicalRoot) return relativePath || "";

    // Ha már abszolút (natív vagy kanonikus), egyszerűen natívra konvertáljuk
    if (relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) {
        return toNativePath(relativePath);
    }

    // Relatív → kanonikus abszolút → natív
    const root = normalize(canonicalRoot).replace(/\/$/, "");
    const canonical = `${root}/${normalize(relativePath)}`;
    return toNativePath(canonical);
};

/**
 * Visszaadja a cikk teljes kanonikus útvonalát a kiadvány rootPath-ja alapján.
 * Relatív filePath → rootPath + filePath (kanonikus).
 * Abszolút (legacy) filePath → toCanonicalPath().
 *
 * @param {Object} article - A cikk (filePath, publicationId mezőkkel).
 * @param {Array} publications - A kiadványok tömbje (mindegyiknek van $id és rootPath mezője).
 * @returns {string} Kanonikus útvonal (pl. /Story/.maestro/article.indd).
 */
export const getArticleCanonicalPath = (article, publications) => {
    if (!article?.filePath) return "";
    if (isAbsoluteFilePath(article.filePath)) {
        return toCanonicalPath(article.filePath);
    }
    const pub = publications?.find(p => p.$id === article.publicationId);
    if (pub?.rootPath) {
        const root = normalize(pub.rootPath).replace(/\/$/, "");
        return `${root}/${normalize(article.filePath)}`;
    }
    return article.filePath;
};

/**
 * Backward compatibility wrapper — kanonikus vagy natív útvonalat natívra konvertál.
 *
 * @param {string} path - Bármilyen formátumú útvonal (kanonikus, natív, régi formátumú).
 * @returns {string} A platform-specifikus natív útvonal.
 * @deprecated Használd a toNativePath()-t új kódban.
 */
export const resolvePlatformPath = (path) => {
    if (!path) return "";
    return toNativePath(path);
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

// =============================================================================
// Lazy migráció (régi formátumú path-ok felismerése)
// =============================================================================

/**
 * Ellenőrzi, hogy egy rootPath régi (natív) formátumban van-e.
 * Régi formátum: /Volumes/...-mal vagy drive betűvel (pl. Z:/) kezdődik.
 * Kanonikus formátum: /ShareName/... (nem /Volumes/).
 *
 * @param {string} rootPath - A vizsgálandó rootPath.
 * @returns {boolean} true ha régi formátumú, false ha kanonikus vagy üres.
 */
export const isLegacyRootPath = (rootPath) => {
    if (!rootPath) return false;
    const normalized = rootPath.replace(/\\/g, "/");
    // Bármely MOUNT_PREFIX-szel kezdődik → régi formátum
    for (const pfx of Object.values(MOUNT_PREFIX)) {
        if (normalized.startsWith(pfx + "/") || normalized === pfx) return true;
    }
    // Drive letter-rel kezdődik (pl. Z:/) → régi formátum
    if (/^[a-zA-Z]:\//.test(normalized)) return true;
    return false;
};

/**
 * Ellenőrzi, hogy egy article filePath abszolút (régi formátumú) vagy relatív.
 * Abszolút: /...-mal vagy drive betűvel kezdődik.
 * Relatív: pl. .maestro/article.indd
 *
 * @param {string} filePath - A vizsgálandó filePath.
 * @returns {boolean} true ha abszolút (régi), false ha relatív.
 */
export const isAbsoluteFilePath = (filePath) => {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, "/");
    return normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized);
};

/**
 * Ellenőrzi, hogy egy natív fájl/mappa útvonal elérhető-e (a meghajtó csatlakoztatva van-e).
 * ExtendScript `Folder(path).exists`-et használ, ami Mac-en és Windows-on is működik.
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
