/**
 * @fileoverview Naplózási (Logging) segédprogram fejlesztési hibakereséshez.
 * Fájl alapú naplózást biztosít a konzol kimenet mellett.
 * Csak fejlesztői módban ír fájlba.
 * 
 * Minden plugin indításkor ÚJ naplófájlt hoz létre időbélyeggel a fájlnévben,
 * pl. "maestro-2026-01-19_09-59-01.log"
 * 
 * @module utils/logger
 * 
 * @example
 * import { log, logError, logWarn } from './utils/logger.js';
 * 
 * log('[MyComponent] Valami történt:', data);
 * logError('[MyComponent] Hiba történt:', error);
 * logWarn('[MyComponent] Figyelmeztetés:', message);
 */

// Fejlesztői mód kapcsoló - production buildnél false-ra kell állítani
const IS_DEVELOPMENT = true;

// Segédfüggvény helyi ISO dátum string előállításához ('Z' nélkül)
const getLocalIsoString = (date) => {
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, -1);
};

// Munkamenet kezdetének időbélyege - a fájlnévben használjuk (helyi idő)
const SESSION_START = new Date();
const formatLocalDateTime = (date) => {
    return getLocalIsoString(date)
        .split('.')[0] // Ezredmásodpercek eltávolítása
        .replace('T', '_')
        .replace(/:/g, '-');
};
const SESSION_ID = formatLocalDateTime(SESSION_START);

// Naplófájl neve a munkamenet időbélyegével (pl. maestro-2026-01-19_09-59-01.log)
const LOG_FILE_NAME = `maestro-${SESSION_ID}.log`;

// A megőrizendő régi naplófájlok maximális száma
const MAX_LOG_FILES = 10;

let logFileEntry = null;
let isInitialized = false;
let initializationPromise = null;

// Puffer a naplóbejegyzéseknek, amíg a fájl nem áll készen
let logBuffer = [];

/**
 * Időbélyeg formázása helyi idő szerint.
 * @returns {string} Formázott időbélyeg időzóna eltolódással.
 */
const getTimestamp = () => {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    const sign = offset <= 0 ? '+' : '-';
    const absOffset = Math.abs(offset);
    const hours = String(Math.floor(absOffset / 60)).padStart(2, '0');
    const mins = String(absOffset % 60).padStart(2, '0');
    
    return `${getLocalIsoString(now)}${sign}${hours}:${mins}`;
};

/**
 * Napló argumentumok formázása stringgé.
 * @param {any[]} args - Formázandó argumentumok.
 * @returns {string} Formázott string.
 */
const formatArgs = (args) => {
    return args.map(arg => {
        if (arg === null) return 'null';
        if (arg === undefined) return 'undefined';
        if (typeof arg === 'object') {
            try {
                return JSON.stringify(arg, null, 2);
            } catch (e) {
                return String(arg);
            }
        }
        return String(arg);
    }).join(' ');
};

/**
 * Régi naplófájlok takarítása, csak a legfrissebbek megtartása.
 * @param {Object} dataFolder - UXP mappa bejegyzés.
 */
const cleanupOldLogs = async (dataFolder) => {
    try {
        const entries = await dataFolder.getEntries();
        
        // Szűrés csak a maestro log fájlokra
        const logFiles = entries.filter(e => 
            e.isFile && 
            e.name.startsWith('maestro-') && 
            e.name.endsWith('.log')
        );
        
        // Rendezés név szerint (ami tartalmazza az időbélyeget, így az újak vannak hátul)
        logFiles.sort((a, b) => a.name.localeCompare(b.name));
        
        // A legrégebbi fájlok törlése, ha túl sok van
        const filesToDelete = logFiles.slice(0, Math.max(0, logFiles.length - MAX_LOG_FILES));
        
        for (const file of filesToDelete) {
            try {
                await file.delete();
                console.log('[Logger] Régi naplófájl törölve:', file.name);
            } catch (e) {
                // Törlési hiba figyelmen kívül hagyása
            }
        }
    } catch (e) {
        // Takarítási hiba figyelmen kívül hagyása
    }
};

/**
 * ÚJ naplófájl inicializálása ehhez a munkamenethez.
 * @returns {Promise<boolean>} Igaz, ha az inicializálás sikeres volt.
 */
const initLogFile = async () => {
    if (isInitialized) return true;
    if (initializationPromise) return initializationPromise;
    
    initializationPromise = (async () => {
        try {
            // Ellenőrizzük, hogy UXP környezetben vagyunk-e
            if (typeof require === 'undefined') {
                throw new Error("Nem UXP környezet");
            }

            let fs;
            try {
                const uxp = require("uxp");
                fs = uxp.storage.localFileSystem;
            } catch (e) {
                throw new Error("UXP modul nem található");
            }

            const dataFolder = await fs.getDataFolder();
            
            // Régi logok takarítása
            await cleanupOldLogs(dataFolder);
            
            // Új log fájl létrehozása
            logFileEntry = await dataFolder.createFile(LOG_FILE_NAME, { overwrite: true });
            
            // Fejléc írása
            const header = [
                '='.repeat(60),
                `Maestro Debug Log - Munkamenet Indult`,
                `Kezdés Ideje: ${SESSION_START.toISOString()}`,
                `Naplófájl: ${LOG_FILE_NAME}`,
                '='.repeat(60),
                ''
            ].join('\n');
            
            await logFileEntry.write(header);
            
            // Pufferelt bejegyzések kiírása
            while (logBuffer.length > 0) {
                const bufferedContent = logBuffer.join('');
                logBuffer = [];
                await logFileEntry.write(bufferedContent, { append: true });
            }

            isInitialized = true;
            
            return true;
        } catch (error) {
            console.error('[Logger] Hiba a naplófájl inicializálásakor:', error);
            isInitialized = false;
            return false;
        }
    })();
    
    return initializationPromise;
};

/**
 * Naplóbejegyzés írása a fájlba.
 * @param {string} level - Napló szint (LOG, ERROR, WARN).
 * @param {string} message - Formázott üzenet.
 */
const writeToFile = async (level, message) => {
    if (!IS_DEVELOPMENT) return;
    
    const timestamp = getTimestamp();
    const logLine = `[${timestamp}] [${level}] ${message}\n`;
    
    // Ha még nincs inicializálva, puffereljük
    if (!isInitialized) {
        logBuffer.push(logLine);
        // Inicializálás indítása
        initLogFile();
        return;
    }
    
    try {
        if (!logFileEntry) return;
        
        // Hozzáfűzés a fájl végéhez
        await logFileEntry.write(logLine, { append: true });
    } catch (error) {
        // Csendes hiba - ne zavarja meg az alkalmazást
        console.error('[Logger] Hiba a fájlba íráskor:', error);
    }
};

/**
 * Üzenet naplózása a konzolra és fájlba (fejlesztői módban).
 * @param {...any} args - Naplózandó argumentumok.
 */
export const log = (...args) => {
    console.log(...args);
    
    if (IS_DEVELOPMENT) {
        const message = formatArgs(args);
        writeToFile('LOG', message);
    }
};

/**
 * Hiba naplózása a konzolra és fájlba (fejlesztői módban).
 * @param {...any} args - Naplózandó argumentumok.
 */
export const logError = (...args) => {
    console.error(...args);
    
    if (IS_DEVELOPMENT) {
        const message = formatArgs(args);
        writeToFile('ERROR', message);
    }
};

/**
 * Figyelmeztetés naplózása a konzolra és fájlba (fejlesztői módban).
 * @param {...any} args - Naplózandó argumentumok.
 */
export const logWarn = (...args) => {
    console.warn(...args);
    
    if (IS_DEVELOPMENT) {
        const message = formatArgs(args);
        writeToFile('WARN', message);
    }
};

/**
 * Visszaadja az aktuális munkamenet naplófájljának útvonalát.
 * @returns {Promise<string|null>} Naplófájl útvonala vagy null.
 */
export const getLogFilePath = async () => {
    if (!IS_DEVELOPMENT) return null;
    
    try {
        if (!isInitialized) {
            await initLogFile();
        }
        
        if (logFileEntry) {
            return logFileEntry.nativePath;
        }
    } catch (error) {
        console.error('[Logger] Hiba a naplófájl útvonalának lekérésekor:', error);
    }
    
    return null;
};

/**
 * Visszaadja az aktuális munkamenet naplófájljának nevét.
 * @returns {string} Naplófájl neve.
 */
export const getLogFileName = () => LOG_FILE_NAME;

// Automatikus inicializálás betöltéskor (fejlesztői módban)
if (IS_DEVELOPMENT) {
    initLogFile().then(success => {
        if (success) {
            log('[Logger] 📝 Fájl naplózás inicializálva a munkamenethez:', SESSION_ID);
        }
    });
}
