// React
import { useCallback, useMemo, useRef } from "react";

// Contextusok és Egyedi Hook-ok
import { useConnection } from "../../core/contexts/ConnectionContext.jsx";
import { useData } from "../../core/contexts/DataContext.jsx";
import { useToast } from "../../ui/common/Toast/ToastContext.jsx";

// Segédprogramok (Utils)
import { isNetworkError, isAuthError, getAPIErrorMessage } from "../../core/utils/errorUtils.js";
import {
    generateIsDocumentOpenScript,
    generateOpenDocumentScript,
    generateCloseDocumentScript,
    generateExtractPageRangesScript,
    parsePageRangesResult,
    generateRenameFileScript,
    generateRenameOpenDocumentScript,
    generateRollbackRenameScript,
    generateThumbnailExportForOpenDocScript,
    parseThumbnailExportResult
} from "../../core/utils/indesign/index.js";
import { uploadThumbnails, cleanupTempFiles, getTempFolderPath } from "../../core/utils/thumbnailUploader.js";
import { isFileInFolder, toNativePath, toCanonicalPath, toRelativeArticlePath, toAbsoluteArticlePath, convertNativePathToUrl, parsePath, joinPath } from "../../core/utils/pathUtils.js";
import { log, logError, logWarn } from "../../core/utils/logger.js";
import { SCRIPT_LANGUAGE_JAVASCRIPT, TOAST_TYPES } from "../../core/utils/constants.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../core/config/maestroEvents.js";

/**
 * React Hook a cikkek (Articles) kezelésére.
 * 
 * Ez a hook biztosítja az interfészt a komponensek számára a cikkekkel kapcsolatos műveletekhez:
 * - Cikkek szűrése az adott kiadványhoz
 * - Új cikk hozzáadása (fájlműveletek + adatbázis)
 * - Cikk megnyitása InDesign-ban
 * - Cikk átnevezése (fájlrendszer + adatbázis szinkronban)
 * - Egyedi cikk lekérése
 * 
 * @param {string} publicationId - A kiadvány azonosítója, amihez a cikkek tartoznak.
 * @param {string} publicationRoot - A kiadvány gyökérmappájának abszolút útvonala.
 * @returns {Object} A cikkek listája és a kezelő függvények (addArticle, openArticle, renameArticle, stb.)
 */
export const useArticles = (publicationId, publicationRoot) => {
    // Kapcsolat kezelése (offline/online státusz, újrapróbálkozások)
    const { setOffline, incrementAttempts } = useConnection();
    
    // Globális adatok és write-through API a DataContext-ből
    const { articles: allArticles, layouts, publications, createArticle, updateArticle } = useData();

    // A kiadvány objektum az alapértelmezett munkatársak kiolvasásához
    const publication = useMemo(() => publications.find(p => p.$id === publicationId), [publications, publicationId]);
    const publicationRef = useRef(publication);
    publicationRef.current = publication;

    // Ref a publications tömbhöz — a callback-ek ne függjenek a publications referenciától
    const publicationsRef = useRef(publications);
    publicationsRef.current = publications;
    
    // Értesítések kezelése (Toast üzenetek)
    const { showToast } = useToast();
    
    /**
     * Cikkek szűrése a memóriában.
     * Mivel a DataContext az összes cikket tárolja, itt végezzük el a szűrést
     * az aktuális kiadvány ID-ja alapján. A useMemo miatt ez nagyon gyors.
     */
    const articles = useMemo(() => {
        if (!publicationId) return [];
        return allArticles.filter(a => a.publicationId === publicationId);
    }, [allArticles, publicationId]);

    /**
     * Új cikk hozzáadása a rendszerhez.
     * 
     * Folyamat:
     * 1. Ellenőrzi, hogy a kiválasztott fájl a kiadvány mappájában van-e.
     * 2. Megkeresi vagy létrehozza a `.maestro` mappát a kiadvány gyökerében.
     * 3. Ellenőrzi, hogy a fájl létezik-e már a `.maestro` mappában (duplikáció elkerülése).
     * 4. Bemásolja a fájlt a `.maestro` mappába.
     * 5. InDesign szkriptekkel kinyeri az oldalszámokat (megnyitás -> elemzés -> bezárás).
     * 6. Létrehozza a bejegyzést az adatbázisban.
     * 
     * @param {Object} file - A hozzáadandó fájl objektum (UXP Entry).
     * @returns {Promise<Object>} Az eredmény objektum (status, fileName, reason).
     */
    const addArticle = useCallback(async (file) => {
        const fs = require("uxp").storage.localFileSystem;

        // A publicationRoot kanonikus formátumban van (DB-ből) → natív feloldás
        const nativeRoot = toNativePath(publicationRoot);

        // --- 0. Útvonal validáció ---
        // Csak olyan fájl adható hozzá, ami fizikailag a kiadvány mappájában (vagy almappájában) van.
        if (!isFileInFolder(file.nativePath, nativeRoot)) {
            throw new Error(`A fájl nem található a kiadvány mappájában! (${nativeRoot})`);
        }

        // --- 1. Hozzáférés szerzése a kiadvány mappájához ---
        let rootEntry = null;
        try {
            let rootUrl = convertNativePathToUrl(nativeRoot);
            rootEntry = await fs.getEntryWithUrl(rootUrl);
        } catch (e) {
             logWarn("Közvetlen mappa-hozzáférés sikertelen:", e);
             throw new Error(`Nem sikerült írási jogot szerezni a kiadvány mappájához (${nativeRoot}).`);
        }

        if (!rootEntry) {
            logError("A gyökér mappa entry nem található.", { nativeRoot });
            throw new Error(`Nem sikerült írási jogot szerezni a kiadvány mappájához (${nativeRoot}).`);
        }

        // --- 2. A .maestro mappa előkészítése ---
        // Ide másoljuk be a cikkeket, hogy azok a Maestro rendszer felügyelete alá kerüljenek.
        let maestroFolder;
        try {
            try {
                maestroFolder = await rootEntry.getEntry(".maestro");
            } catch (e) {
                maestroFolder = await rootEntry.createFolder(".maestro");
            }
        } catch (e) {
            throw new Error("Nem sikerült létrehozni a .maestro mappát: " + e.message);
        }

        // --- 3. Fizikai duplikáció ellenőrzése ---
        // Ha a fájl már létezik a .maestro mappában, nem írjuk felül.
        try {
            await maestroFolder.getEntry(file.name);
            return { status: "skipped", reason: "duplicate", fileName: file.name };
        } catch (e) {
            // A fájl nem létezik, folytathatjuk.
        }

        // --- 4. Fájl másolása ---
        let copiedFile;
        try {
            copiedFile = await file.copyTo(maestroFolder, { name: file.name, overwrite: false });
        } catch (e) {
            throw new Error(`Nem sikerült másolni a fájlt (${file.name}): ` + e.message);
        }

        // --- 5. Oldalszámok kinyerése és thumbnail generálás InDesign segítségével ---
        let startPage = null;
        let endPage = null;
        let pageRanges = null;
        let thumbnailExportPaths = [];
        let thumbnailTempFolder = null;

        try {
            const app = require("indesign").app;
            const filePath = copiedFile.nativePath;

            // Ellenőrizzük, hogy nyitva van-e már a dokumentum
            const isOpenResult = app.doScript(generateIsDocumentOpenScript(filePath), SCRIPT_LANGUAGE_JAVASCRIPT, []);
            const wasAlreadyOpen = String(isOpenResult).trim() === "true";

            // Ha nincs nyitva, megnyitjuk háttérben (láthatatlanul)
            if (!wasAlreadyOpen) {
                const openScript = generateOpenDocumentScript(filePath, true, false);
                const openResult = app.doScript(openScript, SCRIPT_LANGUAGE_JAVASCRIPT, []);
                if (String(openResult) !== "success") {
                    logWarn("Nem sikerült megnyitni a dokumentumot az elemzéshez:", openResult);
                }
            }

            // 5a. Oldalszámok lekérdezése szkripttel
            const script = generateExtractPageRangesScript(filePath);
            const resultStr = app.doScript(script, SCRIPT_LANGUAGE_JAVASCRIPT, []);
            const result = parsePageRangesResult(resultStr);

            if (result.success) {
                startPage = result.startPage;
                endPage = result.endPage;
                pageRanges = result.pageRanges;
            } else {
                logWarn("Nem sikerült kinyerni az oldalszámokat:", result.error);
            }

            // 5b. Thumbnail generálás (a dokumentum még nyitva van)
            try {
                thumbnailTempFolder = getTempFolderPath();

                const thumbScript = generateThumbnailExportForOpenDocScript(filePath, thumbnailTempFolder);
                const thumbResult = app.doScript(thumbScript, SCRIPT_LANGUAGE_JAVASCRIPT, []);
                const parsed = parseThumbnailExportResult(String(thumbResult));

                if (parsed.success) {
                    thumbnailExportPaths = parsed.filePaths;
                } else if (parsed.linkProblems) {
                    showToast(
                        'Thumbnail kihagyva: képproblémák',
                        TOAST_TYPES.WARNING,
                        parsed.error
                    );
                } else {
                    logWarn("[useArticles] Thumbnail generálás sikertelen:", parsed.error);
                }
            } catch (thumbErr) {
                logWarn("[useArticles] Thumbnail generálás hiba:", thumbErr);
            }

            // Ha mi nyitottuk meg, be is zárjuk
            if (!wasAlreadyOpen) {
                const closeScript = generateCloseDocumentScript(filePath);
                app.doScript(closeScript, SCRIPT_LANGUAGE_JAVASCRIPT, []);
            }
        } catch (e) {
            logWarn("Hiba történt az InDesign oldalszám-kinyerés közben:", e);
            // Nem állunk meg hibával, a cikk létrejöhet oldalszámok nélkül is
        }

        // --- 5c. Thumbnail feltöltés (bezárás után, hálózati művelet) ---
        let thumbnailsJson = null;
        if (thumbnailExportPaths.length > 0) {
            try {
                const thumbData = await uploadThumbnails(thumbnailExportPaths, file.name);
                if (thumbData.length > 0) {
                    thumbnailsJson = JSON.stringify(thumbData);
                }
            } catch (e) {
                logWarn("[useArticles] Thumbnail feltöltés sikertelen:", e);
            } finally {
                if (thumbnailTempFolder) {
                    try {
                        await cleanupTempFiles(thumbnailTempFolder);
                    } catch (cleanupErr) {
                        logWarn("[useArticles] Temp fájlok törlése sikertelen:", cleanupErr);
                    }
                }
            }
        }

        // --- 6. Adatbázis ellenőrzés ---
        // A filePath-t relatívan tároljuk a kiadvány kanonikus root-jához képest
        const relativeFilePath = toRelativeArticlePath(copiedFile.nativePath, publicationRoot);
        const isDuplicateDB = articles.some(a => a.filePath === relativeFilePath);
        if (isDuplicateDB) {
             return { status: "skipped", reason: "db_duplicate", fileName: file.name };
        }

        // --- 7. Adatbázis rekord létrehozása ---
        try {
            // Alapértelmezett munkatársak a kiadvány beállításaiból
            const pub = publicationRef.current;

            await createArticle({
                name: file.name.replace(/\.[^/.]+$/, ""), // Kiterjesztés levágása a névből
                layout: layouts[0]?.$id ?? null,
                filePath: relativeFilePath,
                publicationId: publicationId,
                state: 0,
                startPage: startPage,
                endPage: endPage,
                pageRanges: pageRanges,
                thumbnails: thumbnailsJson,
                writerId: pub?.defaultWriterId ?? null,
                editorId: pub?.defaultEditorId ?? null,
                imageEditorId: pub?.defaultImageEditorId ?? null,
                designerId: pub?.defaultDesignerId ?? null,
                proofwriterId: pub?.defaultProofwriterId ?? null,
                artDirectorId: pub?.defaultArtDirectorId ?? null,
                managingEditorId: pub?.defaultManagingEditorId ?? null
            });
            return { status: "success", fileName: file.name };
        } catch (error) {
            logError('[useArticles] Cikk hozzáadása sikertelen:', error);
            
            if (isAuthError(error)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
            } else if (isNetworkError(error)) {
                const attempts = incrementAttempts();
                setOffline(error, attempts);
            } else {
                showToast('A cikk hozzáadása sikertelen', TOAST_TYPES.WARNING, getAPIErrorMessage(error, 'Cikk hozzáadása'));
            }
            throw error;
        }

    }, [publicationRoot, articles, layouts, createArticle, incrementAttempts, setOffline, showToast, publicationId]);

    /**
     * Cikk megnyitása InDesign-ban.
     * Ellenőrzi a zárolásokat (lockOwnerId), mielőtt engedné a megnyitást.
     * 
     * @param {Object} article - A megnyitandó cikk objektuma.
     * @param {Object} user - A jelenlegi felhasználó (zárolás ellenőrzéséhez).
     */
    const openArticle = useCallback(async (article, user) => {
        try {
            // Zárolás ellenőrzése: Ha valaki más szerkeszti, nem engedjük megnyitni
            if (article.lockOwnerId && article.lockOwnerId !== user.$id) {
                throw new Error("Ezt a fájlt jelenleg más felhasználó szerkeszti. Kérlek, várj amíg befejezi a munkát.");
            }

            const app = require("indesign").app;
            if (!article.filePath) {
                throw new Error(`Nincs fájl útvonal a cikkhez: ${article.name}`);
            }

            // Relatív filePath → abszolút natív útvonal (a kiadvány rootPath-ja alapján)
            const pub = publicationsRef.current.find(p => p.$id === article.publicationId);
            const mappedPath = pub ? toAbsoluteArticlePath(article.filePath, pub.rootPath) : toNativePath(article.filePath);

            if (mappedPath) {
                try {
                    // Megpróbáljuk a standard UXP megnyitást
                    await app.open(mappedPath);
                } catch (openError) {
                    logWarn("Standard app.open sikertelen, próba ExtendScriptekkel...", openError);

                    // Fallback: ExtendScript alapú megnyitás
                    const script = generateOpenDocumentScript(mappedPath);
                    const result = app.doScript(script, SCRIPT_LANGUAGE_JAVASCRIPT, []);
                    if (result !== "success") {
                        throw new Error("ExtendScript megnyitás is sikertelen: " + result);
                    }
                    // Jelzünk a rendszernek, hogy zárolás-ellenőrzés szükséges
                    dispatchMaestroEvent(MaestroEvent.lockCheckRequested);
                }
            } else {
                throw new Error("Érvénytelen fájl útvonal");
            }
        } catch (e) {
            logError("Cikk megnyitása sikertelen:", e);
            throw e; // Továbbdobjuk a hibát, hogy a UI megjeleníthesse
        }
    }, []);

    /**
     * Cikk átnevezése.
     * Kritikus művelet:
     * 1. Átnevezi a fizikai fájlt a lemezen.
     * 2. Frissíti az adatbázisban a nevet és az útvonalat.
     * 3. Hiba esetén megpróbál visszaállni az eredeti állapotra (Rollback).
     * 
     * @param {Object} article - A módosítandó cikk.
     * @param {string} newName - Az új név (kiterjesztés nélkül).
     */
    const renameArticle = useCallback(async (article, newName) => {
        if (!newName || newName.trim() === "" || newName === article.name) return article;

        log(`[useArticles] Cikk átnevezése: ${article.name} -> ${newName}`);

        const originalName = article.name;
        const originalPath = article.filePath;

        // Relatív filePath → abszolút natív útvonal a fájlműveletekhez
        const pub = publicationsRef.current.find(p => p.$id === article.publicationId);
        const nativeOriginalPath = pub ? toAbsoluteArticlePath(originalPath, pub.rootPath) : toNativePath(originalPath);

        let newNativePath;
        let newRelativePath;
        let originalFileName;

        // --- Fázis 1: Fizikai fájl átnevezése ---
        let wasDocumentOpen = false;
        try {
            const { parentPath, fileName, extension } = parsePath(nativeOriginalPath);
            originalFileName = fileName;
            const newFileName = newName + extension;
            newNativePath = joinPath(parentPath, newFileName);

            if (originalFileName === newFileName) {
                return article; // Nincs változás
            }

            // Az új relatív path a DB frissítéshez
            const { parentPath: relParent, extension: relExt } = parsePath(originalPath);
            newRelativePath = relParent ? joinPath(relParent, newName + relExt) : (newName + relExt);

            log(`[useArticles] Fájl átnevezése: ${nativeOriginalPath} -> ${newNativePath}`);

            const app = require("indesign").app;

            // Ellenőrizzük, hogy a dokumentum nyitva van-e InDesign-ban
            const isOpenResult = app.doScript(generateIsDocumentOpenScript(nativeOriginalPath), SCRIPT_LANGUAGE_JAVASCRIPT, []);
            wasDocumentOpen = String(isOpenResult).trim() === "true";

            let script;
            if (wasDocumentOpen) {
                // Ha nyitva van: Save As az új útvonalra + régi fájl törlése
                log(`[useArticles] Dokumentum nyitva van, Save As használata az átnevezéshez`);
                script = generateRenameOpenDocumentScript(nativeOriginalPath, newNativePath);
            } else {
                // Ha nincs nyitva: egyszerű fájl-átnevezés
                script = generateRenameFileScript(nativeOriginalPath, newNativePath);
            }

            // DocumentMonitor loop megelőzése a programozott mentésnél.
            // A flag-et a DocumentMonitor.handleSave állítja vissza false-ra az elején,
            // mielőtt visszatér (early return), így pontosan egy mentési eseményt ugrik át.
            if (wasDocumentOpen) window.maestroSkipMonitor = true;
            const result = app.doScript(script, SCRIPT_LANGUAGE_JAVASCRIPT, []);

            if (typeof result === 'string' && result.startsWith('ERROR:')) {
                throw new Error(result.substring(6));
            }

        } catch (fileError) {
            logError("[useArticles] Fájl átnevezési hiba:", fileError);
            showToast('A fájl átnevezése sikertelen', TOAST_TYPES.ERROR, fileError.message || 'Ismeretlen hiba történt a fájl átnevezése közben.');
            throw fileError;
        }

        // --- Fázis 2: Adatbázis frissítése ---
        try {
            const updated = await updateArticle(article.$id, {
                name: newName,
                filePath: newRelativePath
            });

            showToast('Cikk sikeresen átnevezve', TOAST_TYPES.SUCCESS);
            return updated;

        } catch (dbError) {
            logError("[useArticles] DB frissítési hiba átnevezés után:", dbError);

            // --- Auth/hálózati hiba kezelése (rollback nélkül) ---
            if (isAuthError(dbError)) {
                dispatchMaestroEvent(MaestroEvent.sessionExpired);
                throw dbError;
            }
            if (isNetworkError(dbError)) {
                const attempts = incrementAttempts();
                setOffline(dbError, attempts);
                throw dbError;
            }

            // --- Fázis 3: Visszavonás (Rollback) ---
            // Ha az adatbázis frissítés sikertelen, vissza kell nevezni a fájlt,
            // különben inkonzisztens állapotba kerül a rendszer.
            try {
                const app = require("indesign").app;
                const rollbackScript = generateRollbackRenameScript(newNativePath, originalFileName);
                const rollbackResult = app.doScript(rollbackScript, SCRIPT_LANGUAGE_JAVASCRIPT, []);
                
                if (rollbackResult === 'SUCCESS') {
                    showToast('Adatbázis hiba történt', TOAST_TYPES.WARNING, 'A fájl átnevezése visszavonásra került, mivel az adatbázis frissítése sikertelen volt.');
                } else {
                    showToast('Súlyos hiba az átnevezés során', TOAST_TYPES.ERROR, 'Az adatbázis frissítése sikertelen, és a fájl eredeti nevének visszaállítása sem sikerült. Kérjük, ellenőrizd a fájlrendszert manuálisan.');
                }
            } catch (revertError) {
                logError("[useArticles] FATAL: Kivétel a visszaállítás közben:", revertError);
                showToast('Súlyos hiba az átnevezés során', TOAST_TYPES.ERROR, 'Az adatbázis frissítése és a fájl visszaállítása is sikertelen. Kérjük, ellenőrizd a fájlrendszert manuálisan.');
            }
            
            throw dbError;
        }

    }, [updateArticle, showToast, incrementAttempts, setOffline]);

    /**
     * Cikk lekérése ID alapján a memóriából.
     * 
     * @param {string} articleId - A keresett cikk azonosítója.
     */
    const getArticle = useCallback(async (articleId) => {
        if (!articleId) return null;
        log(`[useArticles] getArticle (memóriából): ${articleId}`);
        const found = allArticles.find(a => a.$id === articleId);
        return found || null;
    }, [allArticles]);

    return {
        articles,
        addArticle,
        openArticle,
        renameArticle,
        getArticle
    };
};
