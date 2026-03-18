/**
 * @file useThumbnails.js
 * @description Thumbnail (oldalkép) generálás és feltöltés hook.
 *
 * Event-driven trigger:
 * - `MaestroEvent.documentClosed` — registerTask mintával (DocumentMonitor megvárja)
 *
 * A hook a documentClosed eseményre feliratkozik, JPEG thumbnaileket generál
 * az InDesign dokumentum oldalaiból, feltölti az Appwrite Storage-ba,
 * és frissíti a cikk `thumbnails` mezőjét az adatbázisban.
 */

import { useEffect, useRef } from "react";

import { MaestroEvent } from "../../core/config/maestroEvents.js";
import { useData } from "../../core/contexts/DataContext.jsx";
import { useToast } from "../../ui/common/Toast/ToastContext.jsx";

import { SCRIPT_LANGUAGE_JAVASCRIPT, TOAST_TYPES } from "../../core/utils/constants.js";
import { log, logWarn, logError } from "../../core/utils/logger.js";
import { getIndesignApp } from "../../core/utils/indesign/indesignUtils.js";
import { generateThumbnailExportScript, parseThumbnailExportResult } from "../../core/utils/indesign/thumbnailScripts.js";
import { uploadThumbnails, deleteOldThumbnails, cleanupTempFiles, getTempFolderPath } from "../../core/utils/thumbnailUploader.js";

/**
 * Thumbnail generálás és feltöltés hook.
 * Feliratkozik a `documentClosed` MaestroEvent-re és registerTask mintával
 * regisztrálja a thumbnail generálás feladatát.
 *
 * @returns {{ generateAndUploadThumbnails: Function }} A függvény közvetlenül is hívható (pl. addArticle).
 */
export const useThumbnails = () => {
    const { updateArticle } = useData();
    const { showToast } = useToast();

    // Konkurencia-védelem: egyszerre egy cikken fut
    const inProgressRef = useRef(new Set());

    // callbacksRef a stabil event handler referenciához (useWorkflowValidation mintája)
    const callbacksRef = useRef({});

    /**
     * Thumbnail generálás, feltöltés és DB frissítés.
     *
     * @param {Object} article - A cikk objektum.
     * @param {string} filePath - A fájl abszolút natív útvonala.
     */
    const generateAndUploadThumbnails = async (article, filePath) => {
        if (!article?.$id || !filePath) return;

        // Konkurencia-védelem
        if (inProgressRef.current.has(article.$id)) {
            log(`[useThumbnails] Már folyamatban: ${article.name}`);
            return;
        }
        inProgressRef.current.add(article.$id);

        let tempFolderPath = null;

        try {
            if (!getIndesignApp()) {
                logWarn('[useThumbnails] InDesign app nem elérhető');
                return;
            }

            // 1. Temp mappa útvonal generálása (ExtendScript Folder.temp alá)
            tempFolderPath = getTempFolderPath();
            if (!tempFolderPath) {
                logWarn('[useThumbnails] Temp mappa útvonal generálás sikertelen');
                return;
            }

            // 2. ExtendScript JPEG export (háttérben nyit, link check, export, bezár)
            const app = getIndesignApp();
            const script = generateThumbnailExportScript(filePath, tempFolderPath);
            const result = String(app.doScript(script, SCRIPT_LANGUAGE_JAVASCRIPT, []));
            const parsed = parseThumbnailExportResult(result);

            if (!parsed.success) {
                if (parsed.linkProblems) {
                    showToast(
                        'Thumbnail kihagyva: képproblémák',
                        TOAST_TYPES.WARNING,
                        parsed.error
                    );
                } else {
                    logWarn(`[useThumbnails] Thumbnail generálás sikertelen (${article.name}):`, parsed.error);
                }
                return;
            }

            // 3. Régi thumbnailek törlése (ha vannak)
            if (article.thumbnails) {
                await deleteOldThumbnails(article.thumbnails);
            }

            // 4. Új thumbnailek feltöltése
            const uploadedThumbnails = await uploadThumbnails(parsed.filePaths, article.$id);

            if (uploadedThumbnails.length === 0) {
                logWarn(`[useThumbnails] Egyetlen thumbnail sem töltődött fel (${article.name})`);
                return;
            }

            // 5. DB frissítés
            const thumbnailsJson = JSON.stringify(uploadedThumbnails);
            await updateArticle(article.$id, { thumbnails: thumbnailsJson });

            log(`[useThumbnails] ${uploadedThumbnails.length} thumbnail feltöltve: ${article.name}`);

        } catch (e) {
            logError(`[useThumbnails] Thumbnail generálás hiba (${article.name}):`, e);
        } finally {
            inProgressRef.current.delete(article.$id);

            // Temp mappa takarítás
            if (tempFolderPath) {
                await cleanupTempFiles(tempFolderPath);
            }
        }
    };

    // Stabil referencia frissítése
    callbacksRef.current.generateAndUploadThumbnails = generateAndUploadThumbnails;

    /**
     * Event feliratkozás — documentClosed
     */
    useEffect(() => {
        const handleDocumentClosed = (event) => {
            const { article, filePath, registerTask } = event.detail;
            registerTask(
                callbacksRef.current.generateAndUploadThumbnails(article, filePath)
            );
        };

        window.addEventListener(MaestroEvent.documentClosed, handleDocumentClosed);

        return () => {
            window.removeEventListener(MaestroEvent.documentClosed, handleDocumentClosed);
        };
    }, []);

    return { generateAndUploadThumbnails };
};
